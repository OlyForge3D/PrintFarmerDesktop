// CI smoke check: assert that `electron-forge package` bundled the Rust sidecar
// binary into the packaged app's resources. Fails with a non-zero exit code if
// no `model-core[.exe]` is found anywhere under `out/`.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outDir = path.join(repoRoot, 'out');
const target = process.platform === 'win32' ? 'model-core.exe' : 'model-core';

function findFile(dir, name) {
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
      const found = findFile(full, name);
      if (found) {
        return found;
      }
    } else if (entry === name) {
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
