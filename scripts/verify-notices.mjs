// CI check: the staged third-party notice must match one regenerated from the
// staged SBOM. It runs in the Package job next to `verify-sbom`, so the SBOM it
// re-renders from is the same file that job has already proven byte-identical to
// the lockfiles. A drift here means the notice was edited by hand or a
// dependency changed without the notice being regenerated.
//
// Like `verify-sbom`, this regenerate-and-compare runs within a single job and
// so cannot by itself catch a divergence that only appears on another platform.
// It is sound for the same reason: the render is code-unit ordered (never
// locale-dependent — see #112) and takes no platform-specific input, so the SBOM
// that is byte-identical across runners yields a notice that is byte-identical
// across runners too.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderThirdPartyNotices } from './supply-chain-policy.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const stageDirectory = path.join(repoRoot, 'resources', 'compliance');
const stagedSbomPath = path.join(stageDirectory, 'sbom.cdx.json');
const stagedNoticesPath = path.join(stageDirectory, 'third-party-licenses.md');

function fail(message) {
  console.error(`[verify-notices] FAILED: ${message}`);
  process.exit(1);
}

let sbom;
try {
  sbom = JSON.parse(readFileSync(stagedSbomPath, 'utf8'));
} catch {
  fail(
    `no staged SBOM at ${stagedSbomPath}; run scripts/generate-sbom.mjs and scripts/stage-compliance.mjs first`,
  );
}

let staged;
try {
  staged = readFileSync(stagedNoticesPath, 'utf8');
} catch {
  fail(
    `no staged notice at ${stagedNoticesPath}; run scripts/generate-notices.mjs and scripts/stage-compliance.mjs first`,
  );
}

const regenerated = renderThirdPartyNotices(sbom);

if (regenerated !== staged) {
  const regeneratedLines = regenerated.split('\n');
  const stagedLines = staged.split('\n');
  const at = stagedLines.findIndex(
    (line, index) => line !== regeneratedLines[index],
  );
  const detail =
    at === -1
      ? `the two agree line-for-line but differ in length (staged ${stagedLines.length}, regenerated ${regeneratedLines.length})`
      : `first difference at line ${at + 1}: staged ${JSON.stringify(
          stagedLines[at],
        )} vs regenerated ${JSON.stringify(regeneratedLines[at])}`;
  fail(
    `the staged third-party notice does not match one regenerated from the staged SBOM. ` +
      `A dependency changed without the notice being regenerated, or the file was edited by hand. ${detail}`,
  );
}

console.log(
  `[verify-notices] OK: staged notice is byte-identical to a fresh render of the ${sbom.components.length}-component SBOM`,
);
