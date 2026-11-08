#!/usr/bin/env node
// Trusted tools and policy scan immutable Git blobs, never PR tooling.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeDetectorHashes,
  runDetector,
  verifyDetectorManifest,
} from './design-detector.mjs';
import { designSurfacePaths, normalizeRepoPath } from './design-surface.mjs';
import {
  parseInlineIgnores,
  isInlineIgnored,
} from '../tools/impeccable-detector/detector/shared/inline-ignores.mjs';
import {
  readDetectionConfig,
  shouldIgnoreDetectionFile,
} from '../tools/impeccable-detector/lib/impeccable-config.mjs';
import { loadDesignSystemForTarget } from '../tools/impeccable-detector/detector/design-system.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};
const findingSet = (findings) =>
  findings.map((finding) => JSON.stringify(canonical(finding))).sort(compare);
const noPolicy = (entry) =>
  entry &&
  entry.parsed === false &&
  entry.allowlists &&
  ['fonts', 'colors', 'radii', 'fontSizes'].every(
    (key) => entry.allowlists[key] === false,
  );

function git(repo, args, encoding = 'utf8') {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '' },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${result.error || result.stderr}`,
    );
  return result.stdout;
}

function commit(repo, value) {
  if (!/^[a-f0-9]{40,64}$/.test(value))
    throw new Error('Expected immutable full commit SHA');
  const actual = git(repo, [
    'rev-parse',
    '--verify',
    `${value}^{commit}`,
  ]).trim();
  if (actual !== value)
    throw new Error('Commit SHA does not identify a commit');
  return actual;
}

function tree(repo, ref) {
  const entries = git(repo, ['ls-tree', '-r', '-z', '--full-tree', ref])
    .split('\0')
    .filter(Boolean);
  const files = new Map();
  for (const entry of entries) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Malformed Git tree entry');
    files.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
  }
  return files;
}

function blob(repo, entries, file) {
  const entry = entries.get(file);
  if (
    !entry ||
    entry.type !== 'blob' ||
    !['100644', '100755'].includes(entry.mode)
  )
    throw new Error(`Missing or unsafe regular file: ${file}`);
  return git(repo, ['cat-file', 'blob', entry.oid], null);
}

function text(data, file) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new Error(`Invalid UTF-8: ${file}`);
  }
}

function policyPath(file) {
  return (
    /(^|\/)(?:DESIGN\.md|Design\.md|design\.md|DESIGN\.json|package\.json)$/.test(
      file,
    ) || /(^|\/)\.impeccable\/(?:config\.json|design\.json)$/.test(file)
  );
}

function put(root, file, data) {
  if (
    file.startsWith('/') ||
    file.includes('\\') ||
    file.split('/').some((part) => part === '..' || part === '.')
  )
    throw new Error(`Unsafe path: ${file}`);
  const destination = resolve(root, file);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, data);
}

export function compareCounts(allowance, findings) {
  if (
    !Number.isSafeInteger(allowance) ||
    allowance < 0 ||
    !Array.isArray(findings)
  )
    throw new Error('Invalid allowance or findings');
  const advisory = findings.filter((f) => f.advisory === true).length;
  const blocking = findings.length - advisory;
  return {
    allowed: allowance,
    total: findings.length,
    blocking,
    advisory,
    passed: findings.length <= allowance,
  };
}

export function scanRatchet(repo, base, head, toolRoot) {
  repo = resolve(repo);
  toolRoot = resolve(toolRoot);
  base = commit(repo, base);
  head = commit(repo, head);
  const baseTree = tree(repo, base);
  const headTree = tree(repo, head);
  let baseline;
  try {
    baseline = JSON.parse(
      text(blob(repo, baseTree, 'reports/design-baseline.json'), 'baseline'),
    );
  } catch (error) {
    throw new Error(`Invalid trusted baseline: ${error.message}`);
  }
  if (
    baseline?.schemaVersion !== 1 ||
    !Array.isArray(baseline.findings) ||
    !Array.isArray(baseline.scope?.selected) ||
    !Array.isArray(baseline.scope?.scanned) ||
    !Array.isArray(baseline.scope?.ignoredByConfig) ||
    !baseline.provenance?.inputSha256 ||
    !Array.isArray(baseline.policy)
  )
    throw new Error('Invalid or incompatible trusted baseline schema');
  const counts = compareCounts(baseline.findings.length, baseline.findings);
  if (
    baseline.counts?.blocking !== counts.blocking ||
    baseline.counts?.advisory !== counts.advisory ||
    baseline.counts?.selected !== baseline.scope.selected.length ||
    baseline.counts?.scanned !== baseline.scope.scanned.length ||
    baseline.counts?.ignored !== baseline.scope.ignoredByConfig.length
  )
    throw new Error('Invalid baseline counts');
  if (
    baseline.findings.some(
      (f) =>
        !f ||
        typeof f.file !== 'string' ||
        typeof f.antipattern !== 'string' ||
        (f.advisory !== undefined && typeof f.advisory !== 'boolean') ||
        f.classification !== (f.advisory === true ? 'advisory' : 'blocking'),
    )
  )
    throw new Error('Invalid baseline findings');
  const observedCommit = commit(repo, baseline.inspectedCommit);
  if (
    spawnSync('git', ['merge-base', '--is-ancestor', observedCommit, base], {
      cwd: repo,
    }).status !== 0
  )
    throw new Error(
      'Baseline inspected commit is not an ancestor of trusted base',
    );
  const observedTree = tree(repo, observedCommit);
  const observedTargets = designSurfacePaths([...observedTree.keys()]).sort(
    compare,
  );
  if (
    JSON.stringify(observedTargets) !== JSON.stringify(baseline.scope.selected)
  )
    throw new Error('Baseline scope does not match inspected commit');
  const hashes = baseline.provenance.inputSha256;
  if (
    !Array.isArray(baseline.provenance.trackedInputsChangedFromCommit) ||
    !Array.isArray(baseline.provenance.untrackedInputs)
  )
    throw new Error('Invalid baseline working-tree provenance');
  const changedInputs = [];
  const untrackedInputs = [];
  for (const [file, hash] of Object.entries(hashes)) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error(`Invalid baseline input hash: ${file}`);
    if (!observedTree.has(file)) untrackedInputs.push(file);
    else if (sha256(blob(repo, observedTree, file)) !== hash)
      changedInputs.push(file);
  }
  if (
    JSON.stringify(changedInputs.sort(compare)) !==
      JSON.stringify(
        [...baseline.provenance.trackedInputsChangedFromCommit].sort(compare),
      ) ||
    JSON.stringify(untrackedInputs.sort(compare)) !==
      JSON.stringify([...baseline.provenance.untrackedInputs].sort(compare))
  )
    throw new Error(
      'Baseline working-tree provenance does not match inspected commit',
    );
  const expectedScanned = baseline.scope.scanned;
  const expectedIgnored = baseline.scope.ignoredByConfig;
  const partition = [...expectedScanned, ...expectedIgnored].sort(compare);
  if (
    JSON.stringify(partition) !== JSON.stringify(observedTargets) ||
    baseline.policy.length !== expectedScanned.length ||
    JSON.stringify(baseline.policy.map((item) => item.file).sort(compare)) !==
      JSON.stringify([...expectedScanned].sort(compare)) ||
    baseline.findings.some((item) => !expectedScanned.includes(item.file))
  )
    throw new Error('Invalid baseline scope or policy partition');
  for (const file of observedTargets) {
    if (sha256(blob(repo, observedTree, file)) !== hashes[file])
      throw new Error(`Baseline source provenance mismatch: ${file}`);
  }
  for (const file of ['DESIGN.md', '.impeccable/config.json']) {
    if (
      typeof hashes[file] !== 'string' ||
      sha256(blob(repo, observedTree, file)) !== hashes[file] ||
      sha256(blob(repo, baseTree, file)) !== hashes[file]
    )
      throw new Error(`Baseline policy provenance mismatch: ${file}`);
  }
  for (const file of [
    'scripts/design-baseline.mjs',
    'scripts/design-ratchet.mjs',
    'scripts/design-detector.mjs',
    'scripts/design-surface.mjs',
    'tools/impeccable-detector/manifest.json',
  ]) {
    const bytes = readFileSync(resolve(toolRoot, file));
    if (
      sha256(bytes) !== hashes[file] ||
      sha256(blob(repo, baseTree, file)) !== hashes[file]
    )
      throw new Error(`Baseline tool provenance mismatch: ${file}`);
  }
  const manifest = JSON.parse(
    readFileSync(
      resolve(toolRoot, 'tools/impeccable-detector/manifest.json'),
      'utf8',
    ),
  );
  const problems = verifyDetectorManifest(
    manifest,
    computeDetectorHashes(resolve(toolRoot, 'tools/impeccable-detector')),
  );
  if (
    problems.length ||
    JSON.stringify(manifest.files) !==
      JSON.stringify(baseline.provenance.detector?.files)
  )
    throw new Error('Detector manifest mismatch with baseline');
  if (
    baseline.provenance.htmlEngine !== 'regex-fallback' ||
    baseline.policy.some((p) => !noPolicy(p))
  )
    throw new Error('Baseline capabilities are incompatible with ratchet');
  if (baseline.provenance.node !== process.version)
    throw new Error(
      `Node version mismatch: baseline ${baseline.provenance.node}, running ${process.version}`,
    );
  const targets = designSurfacePaths([...headTree.keys()]).sort(compare);
  if (!targets.includes('index.html'))
    throw new Error('Missing root index.html');
  const temp = realpathSync(mkdtempSync(resolve(tmpdir(), 'design-ratchet-')));
  try {
    for (const [file] of baseTree) {
      if (policyPath(file)) put(temp, file, blob(repo, baseTree, file));
    }
    for (const file of targets) {
      const source = blob(repo, headTree, file);
      text(source, file);
      put(temp, file, source);
    }
    // Baseline-owned tooling must not resolve optional parser dependencies.
    const probe = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "for(const n of ['htmlparser2','css-select','css-tree','domutils']) await import(n)",
      ],
      {
        cwd: resolve(
          toolRoot,
          'tools/impeccable-detector/detector/engines/static-html',
        ),
        encoding: 'utf8',
      },
    );
    if (
      probe.error ||
      probe.status === 0 ||
      !probe.stderr.includes('ERR_MODULE_NOT_FOUND')
    )
      throw new Error(
        'Unexpected HTML engine capability; refresh reviewed baseline',
      );
    if (
      JSON.stringify(readDetectionConfig(temp)) !==
      JSON.stringify(baseline.provenance.effectiveConfig)
    )
      throw new Error('Effective configuration changed since baseline');
    const config = readDetectionConfig(temp);
    const actualIgnored = observedTargets.filter((file) =>
      shouldIgnoreDetectionFile(resolve(temp, file), temp, config),
    );
    if (
      JSON.stringify(actualIgnored) !==
      JSON.stringify([...expectedIgnored].sort(compare))
    )
      throw new Error(
        'Baseline ignored-file scope does not match configuration',
      );
    for (const file of targets) {
      const system = loadDesignSystemForTarget(resolve(temp, file), {
        cwd: temp,
      });
      if (system) throw new Error(`Unexpected parsed design policy: ${file}`);
    }
    const raw = runDetector(temp, targets, toolRoot, {
      strict: true,
      noInlineIgnores: true,
    });
    const findings = raw.filter((finding) => {
      const file = normalizeRepoPath(
        finding.file.startsWith(temp)
          ? finding.file.slice(temp.length + 1)
          : finding.file,
      );
      if (!targets.includes(file))
        throw new Error(`Finding outside target scope: ${file}`);
      if (!baseTree.has(file)) return true;
      const original = text(blob(repo, baseTree, file), file);
      const directives = parseInlineIgnores(original);
      if (!isInlineIgnored(finding, directives)) return true;
      if (
        directives.file.has('*') ||
        directives.file.has(finding.antipattern.toLowerCase())
      )
        return false;
      const line = Number(finding.line);
      const before = original.split('\n');
      const after = text(blob(repo, headTree, file), file).split('\n');
      return !(
        line > 0 &&
        before[line - 1] === after[line - 1] &&
        before[line - 2] === after[line - 2]
      );
    });
    const candidateEntry = headTree.get('reports/design-baseline.json');
    const baseEntry = baseTree.get('reports/design-baseline.json');
    if (!candidateEntry) throw new Error('Candidate removes trusted baseline');
    if (candidateEntry.oid !== baseEntry.oid) {
      let candidate;
      try {
        candidate = JSON.parse(
          text(
            blob(repo, headTree, 'reports/design-baseline.json'),
            'candidate baseline',
          ),
        );
      } catch (error) {
        throw new Error(`Invalid candidate baseline: ${error.message}`);
      }
      if (
        candidate?.schemaVersion !== 1 ||
        !Array.isArray(candidate.findings) ||
        !Array.isArray(candidate.scope?.selected) ||
        !candidate.provenance?.inputSha256 ||
        !candidate.counts ||
        !Array.isArray(candidate.policy)
      )
        throw new Error('Invalid candidate baseline schema');
      const candidateCounts = compareCounts(
        baseline.findings.length,
        candidate.findings,
      );
      const currentCounts = compareCounts(baseline.findings.length, findings);
      if (
        !candidateCounts.passed ||
        candidateCounts.total !== currentCounts.total ||
        candidateCounts.blocking !== currentCounts.blocking ||
        candidateCounts.advisory !== currentCounts.advisory ||
        candidate.counts.blocking !== candidateCounts.blocking ||
        candidate.counts.advisory !== candidateCounts.advisory
      )
        throw new Error(
          'Candidate baseline must match the current scan and cannot increase the allowance',
        );
      if (JSON.stringify(candidate.scope.selected) !== JSON.stringify(targets))
        throw new Error('Candidate baseline scope differs from target commit');
      const currentIgnored = targets.filter((file) =>
        shouldIgnoreDetectionFile(resolve(temp, file), temp, config),
      );
      const currentScanned = targets.filter(
        (file) => !currentIgnored.includes(file),
      );
      if (
        JSON.stringify(candidate.scope.ignoredByConfig) !==
          JSON.stringify(currentIgnored) ||
        JSON.stringify(candidate.scope.scanned) !==
          JSON.stringify(currentScanned) ||
        candidate.counts.selected !== targets.length ||
        candidate.counts.scanned !== currentScanned.length ||
        candidate.counts.ignored !== currentIgnored.length ||
        candidate.policy.length !== currentScanned.length ||
        JSON.stringify(
          candidate.policy.map((item) => item.file).sort(compare),
        ) !== JSON.stringify(currentScanned) ||
        candidate.policy.some((item) => !noPolicy(item)) ||
        candidate.findings.some(
          (item) =>
            !item ||
            !currentScanned.includes(item.file) ||
            typeof item.antipattern !== 'string' ||
            (item.advisory !== undefined &&
              typeof item.advisory !== 'boolean') ||
            item.classification !==
              (item.advisory === true ? 'advisory' : 'blocking'),
        )
      )
        throw new Error(
          'Invalid candidate baseline findings, scope, or policy',
        );
      const currentFindings = findings.map((finding) => ({
        ...finding,
        file: normalizeRepoPath(
          finding.file.startsWith(temp)
            ? finding.file.slice(temp.length + 1)
            : finding.file,
        ),
        classification: finding.advisory === true ? 'advisory' : 'blocking',
      }));
      if (
        JSON.stringify(findingSet(candidate.findings)) !==
        JSON.stringify(findingSet(currentFindings))
      )
        throw new Error('Candidate baseline findings differ from current scan');
      for (const file of targets) {
        if (
          sha256(blob(repo, headTree, file)) !==
          candidate.provenance.inputSha256[file]
        )
          throw new Error(`Candidate source provenance mismatch: ${file}`);
      }
      if (
        candidate.provenance.node !== baseline.provenance.node ||
        candidate.provenance.htmlEngine !== baseline.provenance.htmlEngine ||
        JSON.stringify(candidate.provenance.effectiveConfig) !==
          JSON.stringify(baseline.provenance.effectiveConfig) ||
        JSON.stringify(candidate.provenance.detector?.files) !==
          JSON.stringify(baseline.provenance.detector?.files)
      )
        throw new Error(
          'Candidate baseline capabilities or config differ from trusted baseline',
        );
      for (const file of [
        'DESIGN.md',
        '.impeccable/config.json',
        'scripts/design-baseline.mjs',
        'scripts/design-ratchet.mjs',
        'scripts/design-detector.mjs',
        'scripts/design-surface.mjs',
        'tools/impeccable-detector/manifest.json',
      ]) {
        if (candidate.provenance.inputSha256[file] !== hashes[file])
          throw new Error(`Candidate baseline provenance mismatch: ${file}`);
      }
      const candidateCommit = commit(repo, candidate.inspectedCommit);
      if (
        spawnSync(
          'git',
          ['merge-base', '--is-ancestor', candidateCommit, head],
          { cwd: repo },
        ).status !== 0
      )
        throw new Error(
          'Candidate inspected commit is not an ancestor of target',
        );
      const candidateTree = tree(repo, candidateCommit);
      for (const file of targets) {
        if (
          sha256(blob(repo, candidateTree, file)) !==
          candidate.provenance.inputSha256[file]
        )
          throw new Error(
            `Candidate inspected-commit provenance mismatch: ${file}`,
          );
      }
      if (
        !Array.isArray(candidate.provenance.trackedInputsChangedFromCommit) ||
        !Array.isArray(candidate.provenance.untrackedInputs) ||
        candidate.provenance.trackedInputsChangedFromCommit.length ||
        candidate.provenance.untrackedInputs.length
      )
        throw new Error(
          'Candidate baseline must be generated from clean tracked inputs',
        );
    }
    return {
      ...compareCounts(baseline.findings.length, findings),
      base,
      head,
      inspectedCommit: observedCommit,
      selected: targets.length,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4)
    throw new Error(
      'Usage: design-ratchet.mjs <repo> <base-sha> <head-sha> <trusted-tool-root>',
    );
  const result = scanRatchet(...argv);
  console.log(
    `Design full-scan: ${result.total}/${result.allowed} total (${result.blocking} blocking, ${result.advisory} advisory), ${result.selected} selected.`,
  );
  return result.passed ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`design-ratchet: ${error.message}`);
    process.exitCode = 1;
  }
}
