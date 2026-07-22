// Build the Rust `model-core` sidecar in release mode and stage the resulting
// binary where Electron Forge's `extraResource` picks it up, so packaged builds
// ship a real sidecar. The staged location mirrors `resolveSidecarPath()` in
// `src/main/sidecar.ts` (`<resources>/sidecar/<binary>`).
//
// Usage:
//   node scripts/stage-sidecar.mjs            # cargo build --release, then stage
//   node scripts/stage-sidecar.mjs --no-build # stage an existing release binary
//
// Set PRINTFARMER_SKIP_SIDECAR_BUILD=1 to skip the cargo build (equivalent to
// --no-build); CI builds the sidecar in a dedicated step and only stages here.
//
// The build uses only the sidecar's default (pure-Rust) features, so no C
// toolchain is required beyond the platform linker already present on CI
// runners and developer machines.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const nativeDir = path.join(repoRoot, 'native');

const binaryName =
  process.platform === 'win32' ? 'model-core.exe' : 'model-core';
const builtBinary = path.join(nativeDir, 'target', 'release', binaryName);
const stageDir = path.join(repoRoot, 'resources', 'sidecar');
const stagedBinary = path.join(stageDir, binaryName);

function buildSidecar() {
  console.log('[stage-sidecar] building model-core (release)…');
  const result = spawnSync(
    'cargo',
    ['build', '--release', '-p', 'model-core'],
    {
      cwd: nativeDir,
      stdio: 'inherit',
      shell: false,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `cargo build failed with exit code ${result.status ?? 'unknown'}`,
    );
  }
}

function stage() {
  if (!existsSync(builtBinary)) {
    throw new Error(
      `sidecar binary not found at ${builtBinary}; run without --no-build`,
    );
  }
  // Replace any previously staged binary so stale builds never ship.
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  copyFileSync(builtBinary, stagedBinary);
  console.log(`[stage-sidecar] staged ${binaryName} -> ${stagedBinary}`);
}

const skipBuild =
  process.argv.includes('--no-build') ||
  process.env.PRINTFARMER_SKIP_SIDECAR_BUILD === '1';
if (!skipBuild) {
  buildSidecar();
}
stage();
