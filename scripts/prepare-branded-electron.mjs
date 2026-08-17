import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const require = createRequire(import.meta.url);

function runChecked(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed (exit code ${result.status ?? 'unknown'})`,
    );
  }
}

export function prepareBrandedElectron({
  platform = process.platform,
  productName = 'PrintFarmer Desktop',
  sourceExecutable = require('electron'),
  cacheRoot = path.join(
    repoRoot,
    'node_modules',
    '.cache',
    'printfarmer-branded-electron',
  ),
  runCommand = runChecked,
  copyApp = (source, target) => {
    const result = spawnSync('cp', ['-cR', source, target], {
      stdio: 'inherit',
      shell: false,
    });
    if (result.status !== 0) {
      cpSync(source, target, { recursive: true });
    }
  },
} = {}) {
  if (platform !== 'darwin') return null;

  const sourceApp = path.resolve(path.dirname(sourceExecutable), '..', '..');
  const sourceDist = path.dirname(sourceApp);
  const electronPackage = JSON.parse(
    readFileSync(path.join(sourceDist, '..', 'package.json'), 'utf8'),
  );
  const cacheKey = `${electronPackage.version}-${process.arch}`;
  const targetDist = path.join(cacheRoot, cacheKey);
  const targetApp = path.join(targetDist, `${productName}.app`);
  const targetExecutable = path.join(
    targetApp,
    'Contents',
    'MacOS',
    'Electron',
  );
  const brandedExecutable = path.join(
    targetApp,
    'Contents',
    'MacOS',
    productName,
  );
  const markerPath = path.join(targetDist, 'brand.json');
  const marker = JSON.stringify({
    schemaVersion: 3,
    electronVersion: electronPackage.version,
    productName,
  });

  if (
    existsSync(brandedExecutable) &&
    existsSync(markerPath) &&
    readFileSync(markerPath, 'utf8') === marker
  ) {
    return targetDist;
  }

  rmSync(targetDist, { recursive: true, force: true });
  mkdirSync(targetDist, { recursive: true });
  copyApp(sourceApp, targetApp);

  renameSync(targetExecutable, brandedExecutable);

  const plistPath = path.join(targetApp, 'Contents', 'Info.plist');
  runCommand('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleExecutable ${productName}`,
    plistPath,
  ]);
  runCommand('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleName ${productName}`,
    plistPath,
  ]);
  runCommand('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleDisplayName ${productName}`,
    plistPath,
  ]);
  runCommand('codesign', ['--force', '--deep', '--sign', '-', targetApp]);
  writeFileSync(markerPath, marker);

  return targetDist;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const targetDist = prepareBrandedElectron();
  if (targetDist) console.log(targetDist);
}
