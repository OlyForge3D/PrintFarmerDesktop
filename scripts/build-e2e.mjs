// Build the app bundles + package for the Playwright E2E suite without
// recompiling the Rust sidecar (which requires a native toolchain). The
// sidecar must already be built/staged into `resources/sidecar/` — CI does this
// in a dedicated step, and locally `npm run build:sidecar` / `stage:sidecar`
// produces it. Setting PRINTFARMER_SKIP_SIDECAR_BUILD makes Forge's prePackage
// hook stage the existing binary instead of rebuilding it.
//
// A Node wrapper keeps this cross-platform: inline `VAR=1 cmd` env syntax does
// not work in the Windows shell npm uses.

import { spawnSync } from 'node:child_process';

process.env.PRINTFARMER_SKIP_SIDECAR_BUILD = '1';
process.env.PRINTFARMER_BUILD_E2E = '1';

const result = spawnSync('electron-forge', ['package'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 1);
