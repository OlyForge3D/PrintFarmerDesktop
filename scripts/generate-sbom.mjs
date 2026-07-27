// Generate a CycloneDX SBOM covering BOTH of this app's dependency trees.
//
// Usage: node scripts/generate-sbom.mjs [--out <path>]
//
// Scope is "what ships", not "what is installed". The two trees fail in
// opposite directions if that distinction is dropped, which is why neither is
// filtered by manifest section:
//
//   * npm   — `electron` sits under `devDependencies` and ships as the entire
//             Chromium/Node runtime, while nothing else under
//             `devDependencies` reaches the Rollup bundles.
//   * cargo — `truck-*` and `lib3mf-ffi` are ordinary dependencies that the
//             shipped feature set does not enable, so resolving with
//             `--all-features` would list crates the release binary does not
//             contain.
//
// A third category appears in neither graph: native libraries compiled into the
// binary by `-sys` crates, detected from cargo's own `links` metadata.
//
// The document is deterministic — see `buildSbom` — so CI can regenerate and
// compare it instead of trusting a committed snapshot that ages silently.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSbom, readShippedCargoFeatures } from './supply-chain.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const DEFAULT_OUTPUT = path.join(repoRoot, 'build', 'sbom.cdx.json');
export const NPM_PRODUCTION_TREE_ARGS = Object.freeze([
  'ls',
  '--omit=dev',
  '--all',
  '--json',
]);

function parseArgs(argv) {
  const options = { out: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out requires a path');
      options.out = path.resolve(repoRoot, value);
      index += 1;
    }
  }
  return options;
}

/**
 * The cargo features that reach a release, taken from the two places that build
 * it. They are compared rather than merged: if packaging and release ever build
 * different features, one SBOM cannot honestly describe both artifacts.
 */
export function resolveShippedFeatures(root = repoRoot) {
  const { fromStagingScript, fromReleaseWorkflow } =
    readShippedCargoFeatures(root);
  if (!fromStagingScript || !fromReleaseWorkflow) {
    throw new Error(
      `generate-sbom: could not read the shipped cargo feature set (staging=${String(fromStagingScript)}, release=${String(fromReleaseWorkflow)})`,
    );
  }
  if (fromStagingScript.join(',') !== fromReleaseWorkflow.join(',')) {
    throw new Error(
      `generate-sbom: packaging builds [${fromStagingScript}] but release builds [${fromReleaseWorkflow}]; one SBOM cannot describe both`,
    );
  }
  return fromStagingScript;
}

export function readCargoMetadata(features, root = repoRoot) {
  const args = [
    'metadata',
    '--format-version',
    '1',
    '--manifest-path',
    path.join(root, 'native', 'model-core', 'Cargo.toml'),
    '--locked',
  ];
  if (features.length > 0) args.push('--features', features.join(','));
  return JSON.parse(
    execFileSync('cargo', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

/**
 * Resolve the installed production npm graph with npm's own implementation.
 *
 * npm exits non-zero for an extraneous package or unmet peer while still
 * emitting the complete JSON tree, so parse stdout whenever it exists.
 */
export function readNpmProductionTree(root = repoRoot) {
  const command =
    process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm ls --omit=dev --all --json']
      : NPM_PRODUCTION_TREE_ARGS;
  let stdout;
  let stderr = '';
  try {
    stdout = execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
  }
  if (!stdout.trim()) {
    const detail = stderr.trim().split(/\r?\n/, 1)[0];
    throw new Error(
      `generate-sbom: npm ls produced no JSON output${detail ? `: ${detail}` : ''}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `generate-sbom: npm ls output was not valid JSON: ${error.message}`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const features = resolveShippedFeatures();
  const lock = JSON.parse(
    readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
  );
  const sbom = buildSbom({
    lock,
    repoRoot,
    cargoMetadata: readCargoMetadata(features),
    features,
  });

  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');

  const counts = {};
  for (const component of sbom.components) {
    const ecosystem = component.properties.find(
      (property) => property.name === 'printfarmer:ecosystem',
    ).value;
    counts[ecosystem] = (counts[ecosystem] ?? 0) + 1;
  }
  const summary = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  console.log(
    `[generate-sbom] OK: ${sbom.components.length} components (${summary}) -> ${options.out}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
