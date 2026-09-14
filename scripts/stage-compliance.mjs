// Stage exact repository and Electron/Chromium compliance files inside the app
// bundle. Keeping upstream notices under resources/compliance ensures macOS ZIP
// and DMG artifacts retain files that Electron otherwise places beside the app.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const electronRoot = path.join(repoRoot, 'node_modules', 'electron');
const electronDist = path.join(electronRoot, 'dist');
const stageDirectory = path.join(repoRoot, 'resources', 'compliance');
const chromiumLicense = path.join(electronDist, 'LICENSES.chromium.html');

// CI installs dependencies before the packaging target is known, and Electron's
// platform distribution can therefore be absent until Forge starts packaging.
// Compliance resources are copied in prePackage, so materialize the pinned
// Electron distribution explicitly before reading Chromium's notices.
if (!existsSync(chromiumLicense)) {
  rmSync(electronDist, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [path.join(electronRoot, 'install.js')],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(
      `installing Electron compliance sources failed (exit code ${result.status ?? 'unknown'})`,
    );
  }
}

const complianceFiles = [
  {
    destination: 'PFD_LICENSE.txt',
    source: path.join(repoRoot, 'LICENSE'),
  },
  {
    destination: 'THIRD_PARTY_NOTICES.md',
    source: path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'),
  },
  // Generated rather than committed, so it cannot drift from the lockfiles.
  // `scripts/generate-sbom.mjs` writes it; `scripts/verify-sbom.mjs` proves the
  // staged copy matches a fresh generation.
  {
    destination: 'sbom.cdx.json',
    source: path.join(repoRoot, 'build', 'sbom.cdx.json'),
    hint: 'run `npm run sbom` first',
  },
  // Enumerated dependency licences, generated from the SBOM by
  // `scripts/generate-notices.mjs`; `scripts/verify-notices.mjs` proves the
  // staged copy matches a fresh render.
  {
    destination: 'third-party-licenses.md',
    source: path.join(repoRoot, 'build', 'third-party-licenses.md'),
    hint: 'run `npm run notices` first',
  },
  {
    destination: 'ELECTRON_LICENSE.txt',
    source: path.join(electronRoot, 'LICENSE'),
  },
  {
    destination: 'LICENSES.chromium.html',
    source: chromiumLicense,
  },
];

for (const file of complianceFiles) {
  if (!existsSync(file.source)) {
    throw new Error(
      `required compliance source is missing: ${file.source}; ${file.hint ?? 'ensure the Electron distribution can be downloaded'}`,
    );
  }
}

rmSync(stageDirectory, { recursive: true, force: true });
mkdirSync(stageDirectory, { recursive: true });
for (const file of complianceFiles) {
  const destination = path.join(stageDirectory, file.destination);
  copyFileSync(file.source, destination);
  console.log(`[stage-compliance] staged ${file.source} -> ${destination}`);
}
