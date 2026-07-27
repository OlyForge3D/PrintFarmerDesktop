// CI check: the licence of every shipped component must be permitted under the
// AGPL-3.0-only outbound licence, or covered by a reviewed exception.
//
// This is a DETERMINISTIC gate (docs/security/THREAT_MODEL.md T4.2): it reads
// only the committed SBOM and the committed policy, never the network, so it
// blocks. It runs in the Package job alongside `verify-sbom`, which is where the
// staged SBOM exists. The evaluation itself lives in `supply-chain-policy.mjs`
// and is exercised from both sides in `tests/supplyChainPolicy.test.ts`; this
// runner is only the I/O and the exit code.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateLicensePolicy,
  validateSupplyChainPolicy,
} from './supply-chain-policy.mjs';

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
const policyPath = path.join(repoRoot, 'scripts', 'supply-chain-policy.json');

function fail(message) {
  console.error(`[verify-licenses] FAILED: ${message}`);
  process.exit(1);
}

let sbom;
try {
  sbom = JSON.parse(readFileSync(stagedPath, 'utf8'));
} catch {
  fail(
    `no staged SBOM at ${stagedPath}; run scripts/generate-sbom.mjs and scripts/stage-compliance.mjs first`,
  );
}

let policy;
try {
  policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  validateSupplyChainPolicy(policy);
} catch (error) {
  fail(`policy ${policyPath} is invalid: ${error.message}`);
}

const { violations } = evaluateLicensePolicy(sbom, policy.licenses ?? {});

if (violations.length > 0) {
  // Print every violation, each naming the component and why, so an author sees
  // the full list in one run rather than one-per-CI-round.
  for (const violation of violations) {
    console.error(
      `[verify-licenses]   ${violation.reason.toUpperCase()}: ${violation.name} (${violation.ref}) — ${violation.detail}`,
    );
  }
  fail(
    `${violations.length} component(s) violate the licence policy. ` +
      `Add a compatible dependency, or record a reviewed exception in ` +
      `scripts/supply-chain-policy.json with a written reason.`,
  );
}

const allowed = (policy.licenses?.allowed ?? []).length;
const exceptions = (policy.licenses?.componentExceptions ?? []).length;
console.log(
  `[verify-licenses] OK: ${sbom.components.length} components satisfy the ` +
    `${policy.licenses?.outbound ?? 'outbound'} policy ` +
    `(${allowed} allowed licences, ${exceptions} reviewed exception(s))`,
);
