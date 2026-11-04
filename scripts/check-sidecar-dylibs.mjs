// Fails when any architecture slice of the macOS sidecar links a dylib outside
// the OS. The sidecar ships alone in Resources/sidecar with the hardened
// runtime, so library validation refuses any non-platform dylib signed by a
// different team (e.g. Homebrew's liblzma, #828), and on machines without that
// dylib it is simply missing. Either way dyld kills the sidecar at launch.
//
// Usage: node scripts/check-sidecar-dylibs.mjs <path-to-model-core>

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ALLOWED_DYLIB_PREFIXES = Object.freeze([
  '/usr/lib/',
  '/System/Library/',
]);

/**
 * Parses `otool -L -arch all` output into one entry per architecture slice.
 * A thin binary yields a single slice whose arch is `null`.
 */
export function parseOtoolDylibs(output) {
  const slices = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      if (!current) {
        throw new Error(
          `otool output has a dependency before any header: ${line}`,
        );
      }
      const dylib = line.trim().replace(/\s+\(compatibility version .*\)$/, '');
      current.dylibs.push(dylib);
      continue;
    }
    if (!line.endsWith(':')) {
      throw new Error(`unrecognised otool header line: ${line}`);
    }
    const arch = /\(architecture ([^)]+)\):$/.exec(line)?.[1] ?? null;
    current = { arch, dylibs: [] };
    slices.push(current);
  }
  return slices;
}

/**
 * Returns human-readable violations. An empty result means every slice links
 * only OS libraries. Output with no slices, or a slice with no dependencies,
 * is itself a violation: libSystem is always linked, so its absence means the
 * output was not what this check believes it is reading.
 */
export function findDisallowedDylibs(slices) {
  if (slices.length === 0) {
    return ['otool reported no architecture slices'];
  }
  const violations = [];
  for (const slice of slices) {
    const label = slice.arch ?? 'binary';
    if (slice.dylibs.length === 0) {
      violations.push(`${label}: otool reported no linked libraries`);
      continue;
    }
    for (const dylib of slice.dylibs) {
      // A prefix match alone would accept /usr/lib/../../opt/homebrew/...,
      // so any relative path component disqualifies the entry outright.
      const hasRelativeComponent = dylib
        .split('/')
        .some((part) => part === '.' || part === '..');
      if (
        hasRelativeComponent ||
        !ALLOWED_DYLIB_PREFIXES.some((prefix) => dylib.startsWith(prefix))
      ) {
        violations.push(`${label}: links non-system dylib ${dylib}`);
      }
    }
  }
  return violations;
}

export function checkSidecarDylibs(binaryPath, { run = spawnSync } = {}) {
  const result = run('otool', ['-L', '-arch', 'all', binaryPath], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) {
    return [`could not run otool: ${result.error.message}`];
  }
  if (result.status !== 0) {
    return [
      `otool exited with status ${result.status}: ${String(result.stderr ?? '').trim()}`,
    ];
  }
  return findDisallowedDylibs(parseOtoolDylibs(String(result.stdout)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const binaryPath = process.argv[2];
  if (!binaryPath) {
    console.error('usage: node scripts/check-sidecar-dylibs.mjs <sidecar>');
    process.exit(2);
  }
  const violations = checkSidecarDylibs(binaryPath);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`[check-sidecar-dylibs] FAILED: ${violation}`);
    }
    process.exit(1);
  }
  console.log(
    `[check-sidecar-dylibs] OK: ${binaryPath} links only system libraries`,
  );
}
