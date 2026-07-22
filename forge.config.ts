import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/** Build and stage the Rust sidecar into `resources/sidecar/` before packaging. */
function stageSidecar(): void {
  const script = path.join(repoRoot, 'scripts', 'stage-sidecar.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `staging the sidecar failed (exit code ${result.status ?? 'unknown'})`,
    );
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'PrintFarmer Desktop',
    // Ship the compiled sidecar next to the app so the packaged main process
    // resolves it via `resolveSidecarPath()` at `<resources>/sidecar/<binary>`.
    extraResource: ['./resources/sidecar'],
  },
  rebuildConfig: {},
  hooks: {
    // Compile + stage the sidecar before the app is packaged, so the
    // `extraResource` directory above exists and is current.
    prePackage: () => {
      stageSidecar();
      return Promise.resolve();
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({}, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Harden the packaged app: disable dangerous runtime features and enforce
    // ASAR integrity. These fuses are flipped in the final binary.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
