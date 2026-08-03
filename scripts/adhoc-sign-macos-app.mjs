import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const MAC_APP_BUNDLE_NAME = 'PrintFarmer Desktop.app';

export function adhocSignArgs(appPath) {
  return [
    '--sign',
    '-',
    '--force',
    '--preserve-metadata=entitlements,requirements,flags,runtime',
    '--deep',
    appPath,
  ];
}

export function macAppPaths(outputPaths) {
  return outputPaths.map((outputPath) =>
    path.join(outputPath, MAC_APP_BUNDLE_NAME),
  );
}

// Packaging never uses release credentials, so the packaged app carries only an
// ad-hoc signature. Apple Silicon refuses to execute unsigned arm64 code, and
// the universal build cannot be ad-hoc signed per architecture without breaking
// the universal merge, so the merged bundle is signed here instead. Tagged
// releases replace this signature with the Developer ID one.
export function adhocSignMacApps(outputPaths) {
  for (const appPath of macAppPaths(outputPaths)) {
    if (!existsSync(appPath)) {
      throw new Error(`packaged macOS app not found at ${appPath}`);
    }
    const result = spawnSync('codesign', adhocSignArgs(appPath), {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(
        `ad-hoc signing ${appPath} failed with exit code ${result.status ?? 'unknown'}`,
      );
    }
  }
}
