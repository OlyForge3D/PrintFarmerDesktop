import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareBrandedElectron } from './prepare-branded-electron.mjs';

const PRODUCT_NAME = 'PrintFarmer Desktop';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const forgeStart = path.join(
  repoRoot,
  'node_modules',
  '@electron-forge',
  'cli',
  'dist',
  'electron-forge-start.js',
);
const brandedElectronDist = prepareBrandedElectron();
if (brandedElectronDist) {
  const require = createRequire(import.meta.url);
  const electronModule = require.resolve('electron');
  require(electronModule);
  require.cache[electronModule].exports = path.join(
    brandedElectronDist,
    `${PRODUCT_NAME}.app`,
    'Contents',
    'MacOS',
    PRODUCT_NAME,
  );
}

await import(pathToFileURL(forgeStart).href);
