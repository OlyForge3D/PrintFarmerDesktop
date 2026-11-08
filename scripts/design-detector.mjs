#!/usr/bin/env node
// Deterministic design gate: runs the vendored impeccable detector over the UI
// files a change touches and fails on any non-advisory finding.
//
//   node scripts/design-detector.mjs --base <sha> --head <sha>   CI (diff)
//   node scripts/design-detector.mjs --files a.tsx b.css         explicit
//   node scripts/design-detector.mjs --all                       whole renderer
//   ... --tool-root <dir>   run the detector + manifest from <dir> (CI: base)
//
// Suppressions use the detector's own mechanisms, both reviewable in the diff:
// `.impeccable/config.json` (`detector.ignoreRules` / `ignoreFiles` /
// `ignoreValues`) and inline `impeccable-disable` comments.
//
// The detector's exit code is not trusted on its own: it prints a warning and
// carries on for a path it cannot read, and exits 0. So targets are checked for
// existence here, and the verdict comes from parsing its JSON.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { designSurfacePaths, normalizeRepoPath } from './design-surface.mjs';

export const DETECTOR_DIR = 'tools/impeccable-detector';
export const MANIFEST_FILE = 'manifest.json';
const MANIFEST_EXEMPT = new Set([MANIFEST_FILE]);
const CHUNK_SIZE = 100;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function listFiles(dir, root = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else if (entry.isFile())
      out.push(relative(root, full).split(sep).join('/'));
  }
  return out.sort();
}

export function computeDetectorHashes(detectorDir) {
  const hashes = {};
  for (const file of listFiles(detectorDir)) {
    if (MANIFEST_EXEMPT.has(file)) continue;
    // Normalise line endings so a Windows checkout with autocrlf hashes the same
    // bytes as CI's LF checkout.
    const text = readFileSync(join(detectorDir, file))
      .toString('utf8')
      .replace(/\r\n/g, '\n');
    hashes[file] = sha256(Buffer.from(text, 'utf8'));
  }
  return hashes;
}

// Returns a list of human-readable problems; empty means the vendored copy
// matches its manifest exactly (no edits, no additions, no deletions).
export function verifyDetectorManifest(manifest, actualHashes) {
  const problems = [];
  const expected = manifest?.files;
  if (!expected || typeof expected !== 'object') {
    return ['manifest has no "files" map'];
  }
  for (const [file, hash] of Object.entries(expected)) {
    if (!(file in actualHashes)) problems.push(`missing: ${file}`);
    else if (actualHashes[file] !== hash) problems.push(`modified: ${file}`);
  }
  for (const file of Object.keys(actualHashes)) {
    if (!(file in expected)) problems.push(`unlisted: ${file}`);
  }
  return problems;
}

export function partitionFindings(findings) {
  const blocking = [];
  const advisory = [];
  for (const finding of findings) {
    (finding && finding.advisory === true ? advisory : blocking).push(finding);
  }
  return { blocking, advisory };
}

export function parseDetectorOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed))
    throw new Error('detector JSON output is not an array');
  return parsed;
}

function escapeAnnotation(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function escapeAnnotationProperty(value) {
  return escapeAnnotation(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function formatFinding(finding, root) {
  const file = finding.file
    ? normalizeRepoPath(relative(root, finding.file))
    : '(unknown file)';
  const line =
    Number.isInteger(finding.line) && finding.line > 0
      ? `:${finding.line}`
      : '';
  const snippet = finding.snippet ? ` [${finding.snippet}]` : '';
  return `${file}${line}  ${finding.antipattern}: ${finding.description ?? finding.name ?? ''}${snippet}`;
}

export function formatAnnotation(finding, root) {
  const file = finding.file
    ? normalizeRepoPath(relative(root, finding.file))
    : '';
  const props = [
    `title=${escapeAnnotationProperty(`impeccable: ${finding.antipattern}`)}`,
  ];
  if (file) props.unshift(`file=${escapeAnnotationProperty(file)}`);
  if (Number.isInteger(finding.line) && finding.line > 0)
    props.splice(1, 0, `line=${finding.line}`);
  return `::error ${props.join(',')}::${escapeAnnotation(finding.description ?? finding.name ?? '')}`;
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

export function changedPathsBetween(root, base, head) {
  // Three-dot: what the change introduces relative to where it forked, not
  // whatever else landed on the base meanwhile. --diff-filter=d drops deletions,
  // which have nothing left to scan.
  const out = git(root, [
    'diff',
    '--name-only',
    '--diff-filter=d',
    '-z',
    `${base}...${head}`,
  ]);
  return out.split('\0').filter(Boolean);
}

function allRendererPaths(root) {
  const out = git(root, ['ls-files', '-z', '--', 'src/renderer', 'index.html']);
  return out.split('\0').filter(Boolean);
}

export function runDetector(root, files, toolRoot = root) {
  const detect = join(toolRoot, DETECTOR_DIR, 'detect.mjs');
  const findings = [];
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    const chunk = files.slice(i, i + CHUNK_SIZE);
    // cwd = repo root: the detector reads .impeccable/config.json from cwd.
    const result = spawnSync(process.execPath, [detect, '--json', ...chunk], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 2) {
      throw new Error(
        `detector exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`,
      );
    }
    if (result.stderr && /cannot access/i.test(result.stderr)) {
      throw new Error(
        `detector could not read a target: ${result.stderr.trim()}`,
      );
    }
    findings.push(...parseDetectorOutput(result.stdout));
  }
  return findings;
}

export function parseArgs(argv) {
  const options = {
    files: [],
    base: null,
    head: null,
    all: false,
    writeManifest: false,
    toolRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') options.base = argv[++i] ?? null;
    else if (arg === '--head') options.head = argv[++i] ?? null;
    else if (arg === '--all') options.all = true;
    else if (arg === '--write-manifest') options.writeManifest = true;
    else if (arg === '--tool-root') {
      options.toolRoot = argv[++i] ?? null;
      if (!options.toolRoot) throw new Error('--tool-root needs a directory');
    } else if (arg === '--files') {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--'))
        options.files.push(argv[++i]);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  const modes = [
    options.all,
    options.files.length > 0,
    options.base !== null || options.head !== null,
  ].filter(Boolean).length;
  if (!options.writeManifest && modes !== 1) {
    throw new Error('specify exactly one of --base/--head, --files, or --all');
  }
  if ((options.base === null) !== (options.head === null)) {
    throw new Error('--base and --head must be given together');
  }
  return options;
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const options = parseArgs(argv);
  // CI passes --tool-root pointing at a checkout of the base commit, so the
  // detector and its manifest come from already-reviewed code while `root`
  // (the change under test) supplies only the files and suppression config.
  // Without it, a change could swap in a no-op detector and regenerate the
  // manifest to match.
  const toolRoot = options.toolRoot ? resolve(root, options.toolRoot) : root;
  const detectorDir = join(toolRoot, DETECTOR_DIR);
  const manifestPath = join(detectorDir, MANIFEST_FILE);

  if (options.writeManifest) {
    const previous = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, 'utf8'))
      : {};
    const manifest = { ...previous, files: computeDetectorHashes(detectorDir) };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${normalizeRepoPath(relative(root, manifestPath))}`);
    return 0;
  }

  const problems = verifyDetectorManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')),
    computeDetectorHashes(detectorDir),
  );
  if (problems.length > 0) {
    console.error(
      `Vendored detector does not match ${DETECTOR_DIR}/${MANIFEST_FILE}:`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      'Re-vendor from upstream and run `node scripts/design-detector.mjs --write-manifest`.',
    );
    return 1;
  }

  let candidates;
  if (options.all) candidates = allRendererPaths(root);
  else if (options.files.length > 0) candidates = options.files;
  else candidates = changedPathsBetween(root, options.base, options.head);

  const targets = designSurfacePaths(candidates);
  const missing = targets.filter((file) => {
    const full = resolve(root, file);
    return !existsSync(full) || !statSync(full).isFile();
  });
  if (missing.length > 0) {
    console.error(`Design surface files not found: ${missing.join(', ')}`);
    return 1;
  }
  if (targets.length === 0) {
    console.log('No design-surface files changed; nothing to scan.');
    return 0;
  }

  const { blocking, advisory } = partitionFindings(
    runDetector(root, targets, toolRoot),
  );
  console.log(
    `Scanned ${targets.length} design-surface file(s) with the impeccable detector.`,
  );
  for (const finding of advisory)
    console.log(`  advisory: ${formatFinding(finding, root)}`);
  if (blocking.length === 0) {
    console.log('No blocking design findings.');
    return 0;
  }
  console.error(`${blocking.length} blocking design finding(s):`);
  for (const finding of blocking) {
    console.error(`  ${formatFinding(finding, root)}`);
    if (process.env.GITHUB_ACTIONS === 'true')
      console.log(formatAnnotation(finding, root));
  }
  console.error(
    'Fix the design, or suppress deliberately via .impeccable/config.json or an inline ' +
      '`impeccable-disable` comment (both visible to the design reviewer).',
  );
  return 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`design-detector: ${error.message}`);
    process.exitCode = 1;
  }
}
