#!/usr/bin/env node
// Observational inventory, deliberately separate from the changed-file gate.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  allRendererPaths,
  computeDetectorHashes,
  DETECTOR_DIR,
  runDetector,
  verifyDetectorManifest,
} from './design-detector.mjs';
import { designSurfacePaths, normalizeRepoPath } from './design-surface.mjs';
import {
  findDesignRoot,
  loadDesignSystemForTarget,
} from '../tools/impeccable-detector/detector/design-system.mjs';
import {
  readDetectionConfig,
  shouldIgnoreDetectionFile,
} from '../tools/impeccable-detector/lib/impeccable-config.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const repoPath = (root, path) => normalizeRepoPath(relative(root, path));

function readInput(path) {
  if (!statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
  const bytes = readFileSync(path);
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return bytes;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${result.error || result.stderr}`,
    );
  return result.stdout.trim();
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateConfig(config, path) {
  if (!object(config)) throw new Error(`Invalid config object: ${path}`);
  for (const section of ['hook', 'detector']) {
    const value = config[section];
    if (value === undefined) continue;
    if (!object(value)) throw new Error(`Invalid ${section} in ${path}`);
    for (const key of ['ignoreRules', 'ignoreFiles']) {
      if (
        value[key] !== undefined &&
        (!Array.isArray(value[key]) ||
          value[key].some((item) => typeof item !== 'string' || !item.trim()))
      )
        throw new Error(`Invalid ${section}.${key} in ${path}`);
    }
    if (
      value.ignoreValues !== undefined &&
      (!Array.isArray(value.ignoreValues) ||
        value.ignoreValues.some(
          (entry) =>
            !object(entry) ||
            typeof entry.rule !== 'string' ||
            !entry.rule.trim() ||
            typeof entry.value !== 'string' ||
            !entry.value.trim() ||
            (entry.file !== undefined && typeof entry.file !== 'string') ||
            (entry.files !== undefined &&
              (!Array.isArray(entry.files) ||
                entry.files.some(
                  (file) => typeof file !== 'string' || !file.trim(),
                ))),
        ))
    )
      throw new Error(`Invalid ${section}.ignoreValues in ${path}`);
    if (
      value.designSystem !== undefined &&
      (!object(value.designSystem) ||
        (value.designSystem.enabled !== undefined &&
          typeof value.designSystem.enabled !== 'boolean'))
    )
      throw new Error(`Invalid ${section}.designSystem in ${path}`);
    if (
      value.advisoryRules !== undefined &&
      !['include', 'exclude'].includes(value.advisoryRules)
    )
      throw new Error(`Invalid ${section}.advisoryRules in ${path}`);
    if (section === 'detector') {
      const allowed = new Set([
        'ignoreRules',
        'ignoreFiles',
        'ignoreValues',
        'designSystem',
        'advisoryRules',
      ]);
      for (const key of Object.keys(value))
        if (!allowed.has(key))
          throw new Error(`Unknown detector option ${key} in ${path}`);
    }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readInput(path).toString('utf8'));
  } catch (error) {
    throw new Error(`Cannot read valid JSON from ${path}: ${error.message}`);
  }
}

export function buildBaseline(root = process.cwd()) {
  root = realpathSync(resolve(root));
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const rendererPaths = allRendererPaths(root);
  const targets = designSurfacePaths(rendererPaths).sort(compare);
  if (!targets.length || !targets.includes('index.html'))
    throw new Error(
      'Tracked design surface is empty or missing root index.html',
    );

  const hashes = {};
  const capture = (path) => {
    const full = resolve(root, path);
    const name = repoPath(root, full);
    if (name.startsWith('../') || isAbsolute(name))
      throw new Error(`Input outside repository: ${full}`);
    hashes[name] = digest(readInput(full));
  };
  for (const file of targets) capture(file);
  for (const file of [
    'scripts/design-baseline.mjs',
    'scripts/design-detector.mjs',
    'scripts/design-surface.mjs',
    `${DETECTOR_DIR}/manifest.json`,
  ])
    capture(file);
  if (existsSync(resolve(root, 'scripts/design-ratchet.mjs')))
    capture('scripts/design-ratchet.mjs');
  if (existsSync(resolve(root, 'package-lock.json')))
    capture('package-lock.json');

  // The vendored HTML engine silently falls back to regex-only mode.
  const parserProbe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `for (const name of ['htmlparser2', 'css-select', 'css-tree', 'domutils']) await import(name);`,
    ],
    {
      cwd: resolve(root, DETECTOR_DIR, 'detector/engines/static-html'),
      encoding: 'utf8',
    },
  );
  if (
    parserProbe.error ||
    (parserProbe.status !== 0 &&
      !parserProbe.stderr.includes('ERR_MODULE_NOT_FOUND'))
  )
    throw new Error(
      `Static HTML parser unavailable: ${parserProbe.error || parserProbe.stderr}`,
    );
  const htmlEngine =
    parserProbe.status === 0 ? 'static-html' : 'regex-fallback';
  if (htmlEngine === 'static-html') {
    const require = createRequire(resolve(root, DETECTOR_DIR, 'detect.mjs'));
    const { parseDocument } = require('htmlparser2');
    for (const file of targets.filter((target) => /\.html$/i.test(target))) {
      const rootNode = parseDocument(
        readInput(resolve(root, file)).toString('utf8'),
      );
      const visit = (node) => {
        if (node.name?.toLowerCase() === 'link') {
          const { rel = '', href = '' } = node.attribs || {};
          if (
            /\bstylesheet\b/i.test(rel) &&
            href &&
            !/^(https?:)?\/\//i.test(href)
          )
            capture(resolve(root, dirname(file), href));
        }
        for (const child of node.children || []) visit(child);
      };
      visit(rootNode);
    }
  }

  const manifest = readJson(resolve(root, DETECTOR_DIR, 'manifest.json'));
  const problems = verifyDetectorManifest(
    manifest,
    computeDetectorHashes(resolve(root, DETECTOR_DIR)),
  );
  if (problems.length)
    throw new Error(`Detector manifest mismatch: ${problems.join(', ')}`);
  const configPath = resolve(root, '.impeccable/config.json');
  const localConfig = resolve(root, '.impeccable/config.local.json');
  if (existsSync(localConfig))
    throw new Error(
      'Remove or temporarily relocate .impeccable/config.local.json before producing a reproducible baseline',
    );
  if (existsSync(configPath)) {
    validateConfig(readJson(configPath), configPath);
    capture(configPath);
  }
  const config = readDetectionConfig(root);
  const ignored = targets.filter((file) =>
    shouldIgnoreDetectionFile(resolve(root, file), root, config),
  );
  const scanned = targets.filter((file) => !ignored.includes(file));
  if (!scanned.length) throw new Error('Configuration excludes every target');

  const policy = [];
  for (const file of scanned) {
    const found = findDesignRoot(dirname(resolve(root, file)));
    let hasFrontmatter = false;
    let discoveredMd = null;
    let discoveredSidecar = null;
    if (found && !repoPath(root, found.dir).startsWith('..')) {
      const names = ['DESIGN.md', 'Design.md', 'design.md'];
      let md;
      for (const dir of ['', '.agents/context', 'docs']) {
        md = names
          .map((name) => resolve(found.dir, dir, name))
          .find(existsSync);
        if (md) break;
      }
      if (md) {
        discoveredMd = md;
        const text = readInput(md).toString('utf8');
        capture(md);
        hasFrontmatter = text.split(/\r?\n/)[0]?.trim() === '---';
        if (hasFrontmatter) {
          const lines = text.split(/\r?\n/);
          const end = lines.findIndex(
            (line, index) => index > 0 && line.trim() === '---',
          );
          if (end < 0)
            throw new Error(`Unterminated design frontmatter: ${md}`);
          const require = createRequire(
            resolve(root, 'scripts/design-baseline.mjs'),
          );
          let parsed;
          try {
            parsed = require('js-yaml').load(lines.slice(1, end).join('\n'));
          } catch (error) {
            throw new Error(
              `Invalid design frontmatter in ${md}: ${error.message}`,
            );
          }
          if (!object(parsed))
            throw new Error(`Design frontmatter must be a mapping: ${md}`);
        }
        const sidecar = [
          resolve(found.dir, '.impeccable/design.json'),
          resolve(found.dir, 'DESIGN.json'),
          resolve(dirname(md), 'DESIGN.json'),
        ].find(existsSync);
        if (sidecar) {
          discoveredSidecar = sidecar;
          if (!object(readJson(sidecar)))
            throw new Error(`Invalid design sidecar: ${sidecar}`);
          capture(sidecar);
        }
      }
    }
    const system =
      config.designSystem?.enabled === false
        ? null
        : loadDesignSystemForTarget(resolve(root, file), { cwd: root });
    if (hasFrontmatter && config.designSystem?.enabled !== false && !system)
      throw new Error(`Could not parse design policy for ${file}`);
    policy.push({
      file,
      source: discoveredMd ? repoPath(root, discoveredMd) : null,
      sidecar: discoveredSidecar ? repoPath(root, discoveredSidecar) : null,
      parsed: Boolean(system),
      status:
        config.designSystem?.enabled === false
          ? 'disabled by config'
          : system
            ? 'parsed'
            : discoveredMd
              ? 'no frontmatter; no policy parsed'
              : 'no design policy found',
      allowlists: {
        fonts: system?.hasFonts === true,
        colors: system?.hasColors === true,
        radii: system?.hasRadii === true,
        fontSizes: system?.hasFontSizes === true,
      },
    });
  }

  const findings = runDetector(root, scanned, root, { strict: true })
    .map((finding) => {
      const file = repoPath(root, resolve(root, finding.file));
      if (!targets.includes(file))
        throw new Error(
          `Detector returned finding outside enumerated scope: ${file}`,
        );
      return {
        ...finding,
        file,
        classification: finding.advisory === true ? 'advisory' : 'blocking',
      };
    })
    .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const legacyCss = 'src/renderer/calibration/CalibrationConflictDialog.css';
  const classificationNotes = [];
  if (targets.includes(legacyCss)) {
    const references = [];
    for (const file of rendererPaths.filter(
      (name) =>
        name !== legacyCss &&
        /\.(?:tsx?|jsx?|css|scss|sass|less|html)$/i.test(name),
    )) {
      capture(file);
      if (
        readInput(resolve(root, file))
          .toString('utf8')
          .includes('CalibrationConflictDialog.css')
      )
        references.push(file);
    }
    classificationNotes.push({
      file: legacyCss,
      literalReferences: references.sort(compare),
      status: references.length
        ? 'Literal references found; runtime reachability not established.'
        : 'No literal reference found in tracked renderer code; runtime reachability not established.',
    });
  }
  for (const [file, hash] of Object.entries(hashes))
    if (digest(readInput(resolve(root, file))) !== hash)
      throw new Error(`Input changed during scan: ${file}`);

  const changed = git(root, [
    'diff',
    '--name-only',
    '-z',
    'HEAD',
    '--',
    ...Object.keys(hashes),
  ])
    .split('\0')
    .filter(Boolean)
    .sort(compare);
  const untracked = git(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...Object.keys(hashes),
  ])
    .split('\0')
    .filter(Boolean)
    .sort(compare);
  const blocking = findings.filter(
    (finding) => finding.classification === 'blocking',
  ).length;
  return {
    schemaVersion: 1,
    purpose:
      'Observed source findings, not approval, certification, or a regression gate.',
    inspectedCommit: head,
    provenance: {
      node: process.version,
      detector: {
        version: manifest.version,
        upstream: manifest.upstream,
        provenanceLimit: manifest.provenanceLimit,
        localModifications: manifest.localModifications ?? null,
        files: manifest.files,
      },
      inputSha256: Object.fromEntries(
        Object.entries(hashes).sort(([a], [b]) => compare(a, b)),
      ),
      trackedInputsChangedFromCommit: changed,
      untrackedInputs: untracked,
      localConfig: 'absent',
      effectiveConfig: config,
      htmlEngine,
    },
    scope: {
      selected: targets,
      scanned,
      ignoredByConfig: ignored,
      classificationNotes,
      excluded: [
        'Renderer plain TypeScript, assets and unsupported file extensions are not detector targets; plain TypeScript may be read solely for literal stylesheet-reference classification.',
        'Main and preload source, including UI state and native menu construction.',
        'OS/native dialogs and menus, installer and other native UI.',
        'Runtime states, rendered DOM, interactions, accessibility tree, pixels, zoom and DPI.',
        'Untracked files and any files ignored by detector configuration; inline suppressions remain active.',
        ...(htmlEngine === 'regex-fallback'
          ? [
              'HTML static DOM and linked-stylesheet analysis: optional parser dependencies unavailable.',
            ]
          : [
              'Remote linked stylesheets are not read by the static HTML engine.',
            ]),
      ],
    },
    policy,
    counts: {
      selected: targets.length,
      scanned: scanned.length,
      ignored: ignored.length,
      blocking,
      advisory: findings.length - blocking,
    },
    findings,
  };
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  if (
    argv.length &&
    (argv.length !== 2 ||
      argv[0] !== '--output' ||
      !argv[1] ||
      argv[1].startsWith('--'))
  )
    throw new Error(
      'Usage: node scripts/design-baseline.mjs [--output <file>]',
    );
  const output = resolve(root, argv[1] || 'reports/design-baseline.json');
  const report = buildBaseline(root);
  if (Object.hasOwn(report.provenance.inputSha256, repoPath(root, output)))
    throw new Error('Output must not overwrite an input');
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
    });
    renameSync(temporary, output);
  } catch (error) {
    // Do not leave an apparently complete report on failure.
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  console.log(
    `Wrote ${output}: ${report.counts.scanned} scanned, ${report.counts.blocking} blocking, ${report.counts.advisory} advisory.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`design-baseline: ${error.message}`);
    process.exitCode = 1;
  }
}
