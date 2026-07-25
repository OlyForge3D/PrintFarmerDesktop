// CI smoke check: assert that `electron-forge package` bundled the Rust sidecar,
// runtime icon, and exact compliance resources. Fails with a non-zero exit code
// if any required resource is absent or differs from its repository source.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outDir = path.join(repoRoot, 'out');
const target = process.platform === 'win32' ? 'model-core.exe' : 'model-core';

function findFile(dir, name, accept = () => true) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      const found = findFile(full, name, accept);
      if (found) {
        return found;
      }
    } else if (entry === name && accept(full)) {
      return full;
    }
  }
  return null;
}

const found = findFile(outDir, target);
if (!found) {
  console.error(
    `[verify-packaged-sidecar] FAILED: ${target} not found under ${outDir}`,
  );
  process.exit(1);
}
console.log(`[verify-packaged-sidecar] OK: bundled sidecar at ${found}`);

const icon = findFile(outDir, 'icon.png');
if (!icon || path.basename(path.dirname(icon)).toLowerCase() !== 'resources') {
  console.error(
    `[verify-packaged-sidecar] FAILED: runtime icon.png not found in packaged resources under ${outDir}`,
  );
  process.exit(1);
}
console.log(`[verify-packaged-sidecar] OK: bundled runtime icon at ${icon}`);

const complianceResources = [
  {
    packagedName: 'PFD_LICENSE.txt',
    parent: 'compliance',
    source: path.join(repoRoot, 'LICENSE'),
  },
  {
    packagedName: 'THIRD_PARTY_NOTICES.md',
    parent: 'compliance',
    source: path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'),
  },
  {
    packagedName: 'CORRESPONDING_SOURCE.md',
    parent: 'compliance',
    source: path.join(
      repoRoot,
      'docs',
      'compliance',
      'CORRESPONDING_SOURCE.md',
    ),
  },
  {
    packagedName: 'printer-calibration-provenance.json',
    parent: 'compliance',
    source: path.join(
      repoRoot,
      'compliance',
      'printer-calibration-provenance.json',
    ),
  },
  {
    packagedName: 'printer-calibration-provenance.schema.json',
    parent: 'compliance',
    source: path.join(
      repoRoot,
      'compliance',
      'printer-calibration-provenance.schema.json',
    ),
  },
  {
    packagedName: 'ELECTRON_LICENSE.txt',
    parent: 'compliance',
    source: path.join(repoRoot, 'node_modules', 'electron', 'dist', 'LICENSE'),
  },
  {
    packagedName: 'LICENSES.chromium.html',
    parent: 'compliance',
    source: path.join(
      repoRoot,
      'node_modules',
      'electron',
      'dist',
      'LICENSES.chromium.html',
    ),
  },
];

function isPackagedResource(candidate, expectedParent) {
  const relativeParts = path
    .relative(outDir, candidate)
    .split(path.sep)
    .map((part) => part.toLowerCase());
  if (!relativeParts.includes('resources')) return false;
  return (
    expectedParent === undefined ||
    path.basename(path.dirname(candidate)).toLowerCase() ===
      expectedParent.toLowerCase()
  );
}

for (const resource of complianceResources) {
  const packaged = findFile(outDir, resource.packagedName, (candidate) =>
    isPackagedResource(candidate, resource.parent),
  );
  if (!packaged) {
    console.error(
      `[verify-packaged-sidecar] FAILED: ${resource.packagedName} not found in packaged resources under ${outDir}`,
    );
    process.exit(1);
  }
  if (!readFileSync(packaged).equals(readFileSync(resource.source))) {
    console.error(
      `[verify-packaged-sidecar] FAILED: ${packaged} does not match ${resource.source}`,
    );
    process.exit(1);
  }
  console.log(
    `[verify-packaged-sidecar] OK: bundled compliance resource matches ${packaged}`,
  );
}

if (process.platform === 'darwin') {
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  const appName = packageJson.productName;
  if (typeof appName !== 'string' || appName.length === 0) {
    console.error(
      '[verify-packaged-sidecar] FAILED: package.json productName is missing',
    );
    process.exit(1);
  }
  const expectedPlistSuffix = path.join(
    `${appName}.app`,
    'Contents',
    'Info.plist',
  );
  const infoPlist = findFile(outDir, 'Info.plist', (candidate) =>
    candidate.endsWith(expectedPlistSuffix),
  );
  if (!infoPlist) {
    console.error(
      `[verify-packaged-sidecar] FAILED: main app Info.plist not found under ${outDir}`,
    );
    process.exit(1);
  }
  const plist = readFileSync(infoPlist, 'utf8');
  const iconMatch =
    /<key>\s*CFBundleIconFile\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/.exec(
      plist,
    );
  const iconName = iconMatch?.[1];
  if (!iconName || path.basename(iconName) !== iconName) {
    console.error(
      '[verify-packaged-sidecar] FAILED: CFBundleIconFile is missing or invalid',
    );
    process.exit(1);
  }
  const macIcon = path.join(path.dirname(infoPlist), 'Resources', iconName);
  if (!existsSync(macIcon)) {
    console.error(
      `[verify-packaged-sidecar] FAILED: CFBundleIconFile resource not found at ${macIcon}`,
    );
    process.exit(1);
  }
  const canonicalIcon = path.join(repoRoot, 'assets', 'icon.icns');
  if (!readFileSync(macIcon).equals(readFileSync(canonicalIcon))) {
    console.error(
      `[verify-packaged-sidecar] FAILED: packaged macOS icon does not match ${canonicalIcon}`,
    );
    process.exit(1);
  }
  console.log(
    `[verify-packaged-sidecar] OK: bundled macOS icon matches ${macIcon}`,
  );
}
