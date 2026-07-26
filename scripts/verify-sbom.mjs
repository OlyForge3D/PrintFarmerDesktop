// CI check: regenerate the SBOM from the committed lockfiles and prove the
// staged copy matches it, that it covers both dependency trees, and that no
// component category has silently emptied.
//
// This runs in the Package smoke job because that is the only job with BOTH
// toolchains installed and the only one that resolves cargo at the feature set
// a release actually builds. It is therefore the one place the derivation runs
// against real `cargo metadata` rather than a fixture — `tests/supplyChain.test.ts`
// drives the same functions through cases this tree does not contain, and a
// fixture-only suite could not notice the real resolver breaking.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSbom } from './supply-chain.mjs';
import { readCargoMetadata, resolveShippedFeatures } from './generate-sbom.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const stagedPath = path.join(
  repoRoot,
  'resources',
  'compliance',
  'sbom.cdx.json',
);

function fail(message) {
  console.error(`[verify-sbom] FAILED: ${message}`);
  process.exit(1);
}

let staged;
try {
  staged = readFileSync(stagedPath, 'utf8');
} catch {
  fail(
    `no staged SBOM at ${stagedPath}; run scripts/generate-sbom.mjs and scripts/stage-compliance.mjs first`,
  );
}

const features = resolveShippedFeatures(repoRoot);
let lock;
try {
  lock = JSON.parse(
    readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
  );
} catch (error) {
  fail(`package-lock.json could not be read as JSON: ${error.message}`);
}
const regenerated = `${JSON.stringify(
  buildSbom({
    lock,
    repoRoot,
    cargoMetadata: readCargoMetadata(features, repoRoot),
    features,
  }),
  null,
  2,
)}\n`;

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
    `the staged SBOM does not match one regenerated from the committed lockfiles. ` +
      `A dependency changed without the SBOM being regenerated, or the staged file was edited by hand. ${detail}`,
  );
}
console.log(
  `[verify-sbom] OK: staged SBOM is byte-identical to a fresh generation from the lockfiles`,
);

const sbom = JSON.parse(staged);

// Both trees must be represented. A single-ecosystem SBOM is the failure this
// check exists for: it presents as complete while describing half the product.
const byEcosystem = new Map();
for (const component of sbom.components) {
  const ecosystem = component.properties.find(
    (property) => property.name === 'printfarmer:ecosystem',
  )?.value;
  byEcosystem.set(ecosystem, (byEcosystem.get(ecosystem) ?? 0) + 1);
}
for (const ecosystem of ['npm', 'cargo']) {
  if (!byEcosystem.get(ecosystem)) {
    fail(
      `the SBOM contains no ${ecosystem} components; it describes at most half of what ships`,
    );
  }
}

// Every crate that links a native library must appear as its own component.
// Those libraries are compiled into the binary but are packages in neither
// ecosystem, so nothing else in the pipeline would notice their absence.
const metadata = readCargoMetadata(features, repoRoot);
const linkedCrates = metadata.packages.filter((pkg) => pkg.links);
const nativeNames = new Set(
  sbom.components
    .filter(
      (component) =>
        component.properties.find(
          (property) => property.name === 'printfarmer:ecosystem',
        )?.value === 'native',
    )
    .map((component) => component.name),
);
const cargoNames = new Set(
  sbom.components
    .filter(
      (component) =>
        component.properties.find(
          (property) => property.name === 'printfarmer:ecosystem',
        )?.value === 'cargo',
    )
    .map((component) => component.name),
);
for (const crate of linkedCrates) {
  if (!cargoNames.has(crate.name)) continue; // not in the shipped closure
  if (!nativeNames.has(crate.links)) {
    fail(
      `crate ${crate.name}@${crate.version} links native library "${crate.links}" but the SBOM has no native component for it`,
    );
  }
}

const declaredFeatures = sbom.metadata.properties.find(
  (property) => property.name === 'printfarmer:cargo-features',
)?.value;
if (declaredFeatures !== [...features].sort().join(',')) {
  fail(
    `the SBOM declares cargo features "${declaredFeatures}" but the shipped build uses "${features.join(',')}"`,
  );
}

// The legitimate-maximum half, run against the real resolver rather than a
// fixture. Proving only that unshipped crates are absent cannot distinguish a
// feature-bound closure from one that drops optional crates unconditionally —
// both look identical from the exclusion side. Resolving the same manifest with
// no features and requiring the shipped closure to be a strict superset makes
// the feature set the varied axis. No network is needed: every crate involved
// is already in the committed lockfile.
const bare = new Set(
  readCargoMetadata([], repoRoot).resolve.nodes.map((node) => node.id),
);
const shipped = new Set(metadata.resolve.nodes.map((node) => node.id));
const enabled = [...shipped].filter((id) => !bare.has(id));
const dropped = [...bare].filter((id) => !shipped.has(id));

if (dropped.length > 0) {
  fail(
    `enabling features [${features.join(',')}] removed crates from the graph, which cargo cannot do: ${dropped.join(', ')}`,
  );
}
if (enabled.length === 0) {
  fail(
    `resolving with no features produced the same crate graph as [${features.join(',')}]. ` +
      `Either the feature set no longer reaches any dependency, or the closure is not bound to features at all.`,
  );
}
if (!enabled.some((id) => id.includes('rusqlite'))) {
  fail(
    `the "sqlite" feature is expected to pull in rusqlite, but it is not among the crates that features added: ${enabled.join(', ')}`,
  );
}
console.log(
  `[verify-sbom] OK: features [${features.join(',')}] add ${enabled.length} crate(s) over a featureless resolve and remove none`,
);

const summary = [...byEcosystem.entries()]
  .sort(([a], [b]) => String(a).localeCompare(String(b)))
  .map(([key, value]) => `${key}=${value}`)
  .join(', ');
console.log(
  `[verify-sbom] OK: ${sbom.components.length} components (${summary}); ${nativeNames.size} native library/libraries acknowledged; cargo features "${declaredFeatures}"`,
);
