// Stage exact repository and Electron/Chromium compliance files inside the app
// bundle. Keeping upstream notices under resources/compliance ensures macOS ZIP
// and DMG artifacts retain files that Electron otherwise places beside the app.

import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const electronDist = path.join(repoRoot, 'node_modules', 'electron', 'dist');
const stageDirectory = path.join(repoRoot, 'resources', 'compliance');

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
    source: path.join(electronDist, 'LICENSE'),
  },
  {
    destination: 'LICENSES.chromium.html',
    source: path.join(electronDist, 'LICENSES.chromium.html'),
  },
];

for (const file of complianceFiles) {
  if (!existsSync(file.source)) {
    throw new Error(
      `required compliance source is missing: ${file.source}; ${file.hint ?? "run npm ci without disabling Electron's install script"}`,
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
