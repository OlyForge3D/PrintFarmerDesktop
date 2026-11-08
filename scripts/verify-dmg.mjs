import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export function verifyMountedDmg(mountPath, volumeName, expectedBackground) {
  if (volumeName !== 'Install PrintFarmer Desktop') {
    throw new Error(`Unexpected DMG volume name: ${volumeName}`);
  }
  const background = path.join(mountPath, '.background', 'background.tiff');
  if (
    !existsSync(background) ||
    !readFileSync(background).equals(expectedBackground)
  ) {
    throw new Error('DMG background does not match the branded Retina artwork');
  }
  if (!existsSync(path.join(mountPath, '.DS_Store'))) {
    throw new Error('DMG Finder layout is missing');
  }
}

export function verifyDmg(dmgPath) {
  if (process.platform !== 'darwin') {
    throw new Error('DMG verification requires macOS');
  }
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'printfarmer-dmg-'));
  const mountPath = path.join(temporary, 'volume');
  const expectedPath = path.join(temporary, 'background.tiff');
  mkdirSync(mountPath);
  let mounted = false;
  try {
    execFileSync('tiffutil', [
      '-cathidpicheck',
      path.join(repoRoot, 'assets', 'dmg', 'background.png'),
      path.join(repoRoot, 'assets', 'dmg', 'background@2x.png'),
      '-out',
      expectedPath,
    ]);
    execFileSync('hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mountPath,
      dmgPath,
    ]);
    mounted = true;
    const info = execFileSync('diskutil', ['info', '-plist', mountPath]);
    const volumeName = execFileSync(
      'plutil',
      ['-extract', 'VolumeName', 'raw', '-o', '-', '-'],
      { input: info, encoding: 'utf8' },
    ).trim();
    verifyMountedDmg(mountPath, volumeName, readFileSync(expectedPath));
    console.log(`Verified branded macOS installer: ${path.basename(dmgPath)}`);
  } finally {
    // Never remove the temporary mountpoint while it still contains a volume.
    if (mounted) execFileSync('hdiutil', ['detach', mountPath]);
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const makeDir = path.join(repoRoot, 'out', 'make');
  const dmgs = readdirSync(makeDir, { recursive: true })
    .filter((entry) => entry.endsWith('.dmg'))
    .map((entry) => path.join(makeDir, entry));
  if (dmgs.length === 0) throw new Error('No built DMG found in out/make');
  for (const dmg of dmgs) verifyDmg(dmg);
}
