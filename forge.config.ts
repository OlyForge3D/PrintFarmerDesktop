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
import { adhocSignMacApps } from './scripts/adhoc-sign-macos-app.mjs';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const iconBasePath = path.join(repoRoot, 'assets', 'icon');
const windowsIconPath = `${iconBasePath}.ico`;

function runBuildScript(scriptName: string, description: string): void {
  const script = path.join(repoRoot, 'scripts', scriptName);
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `${description} failed (exit code ${result.status ?? 'unknown'})`,
    );
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'PrintFarmer Desktop',
    icon: iconBasePath,
    // Ship the compiled sidecar next to the app so the packaged main process
    // resolves it via `resolveSidecarPath()` at `<resources>/sidecar/<binary>`.
    extraResource: [
      './resources/sidecar',
      './resources/target-profiles',
      './assets/icon.png',
      './resources/compliance',
    ],
  },
  rebuildConfig: {},
  hooks: {
    // Validate and stage generated resources before packaging.
    prePackage: () => {
      runBuildScript('verify-target-profiles.mjs', 'verifying target profiles');
      runBuildScript('stage-sidecar.mjs', 'staging the sidecar');
      // The SBOM is generated before staging so the packaged copy is derived
      // from the lockfiles at build time rather than from a committed snapshot.
      runBuildScript('generate-sbom.mjs', 'generating the SBOM');
      // The notice enumerates the SBOM, so it is generated after it and before
      // staging, keeping the packaged copy in step with what ships.
      runBuildScript('generate-notices.mjs', 'generating third-party notices');
      runBuildScript('stage-compliance.mjs', 'staging compliance resources');
      return Promise.resolve();
    },
    postPackage: (_forgeConfig, { platform, outputPaths }) => {
      if (platform === 'darwin' && process.platform === 'darwin') {
        adhocSignMacApps(outputPaths);
      }
      return Promise.resolve();
    },
  },
  makers: [
    new MakerSquirrel({
      setupIcon: windowsIconPath,
      iconUrl:
        'https://raw.githubusercontent.com/OlyForge3D/PrintFarmerDesktop/development/assets/icon.ico',
    }),
    // Portable, no-install Windows build for users who would rather unzip a
    // folder than run the unsigned installer.
    new MakerZIP({}, ['win32', 'darwin']),
    new MakerDMG({ icon: `${iconBasePath}.icns` }, ['darwin']),
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
      // Per-architecture ad-hoc signing would leave `_CodeSignature` in the
      // arm64 build only, so the universal stitch aborts on a file mismatch.
      // The merged app is ad-hoc signed in `postPackage` instead.
      resetAdHocDarwinSignature: false,
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
