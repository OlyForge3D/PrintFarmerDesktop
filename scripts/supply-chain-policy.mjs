// Supply-chain POLICY over the enumerated SBOM.
//
// `supply-chain.mjs` answers "what ships"; this module answers "is what ships
// acceptable". It is kept separate and side-effect-free so every decision can be
// driven from a fixture in `tests/supplyChainPolicy.test.ts` without a network,
// a toolchain, or a staged SBOM. The thin runners (`verify-licenses.mjs`,
// `audit-advisories.mjs`, `generate-notices.mjs`, `verify-notices.mjs`) do the
// I/O and hand a parsed document to the functions here.
//
// Two design rules come straight from docs/security/THREAT_MODEL.md:
//
//   * T4.1 — the product is AGPL-3.0-only. `allowedLicenses` therefore encodes
//     "inbound licences compatible with AGPL-3.0-only outbound". A GPL-2.0-only
//     dependency is not on it, so it fails; that is the case the gate exists for.
//   * T4.2 — advisory databases are fetched live, so an advisory gate can fail a
//     pull request that changed nothing. Deterministic checks (licences) block;
//     the advisory gate runs in "report" mode and never silently passes on an
//     inability to run. The severity/waiver logic is still a real gate — proven
//     by `enforcement: "block"` and unit-tested both sides of the threshold — it
//     is only the CI wiring that is non-required.

import { compareByCodeUnit } from './supply-chain.mjs';
import parseSpdxExpression from 'spdx-expression-parse';

const ADVISORY_ENFORCEMENT = new Set(['block', 'report']);
const ADVISORY_SEVERITIES = new Set([
  'info',
  'low',
  'moderate',
  'high',
  'critical',
]);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Read the required advisory enforcement mode without silently defaulting. */
export function advisoryEnforcement(policy) {
  const enforcement = policy?.enforcement;
  if (!ADVISORY_ENFORCEMENT.has(enforcement)) {
    throw new Error(
      'advisories.enforcement must be exactly "block" or "report"',
    );
  }
  return enforcement;
}

/**
 * Validate the committed policy source of truth before any runner consumes it.
 *
 * Required blocks and arrays are explicit so a renamed or deleted key cannot
 * degrade into an empty allowlist, an unscoped exception, or a default mode.
 */
export function validateSupplyChainPolicy(policy) {
  const errors = [];
  if (!isRecord(policy)) {
    throw new Error('invalid supply-chain policy: root must be an object');
  }

  const licenses = policy.licenses;
  if (!isRecord(licenses)) {
    errors.push('licenses must be an object');
  } else {
    if (!isNonEmptyString(licenses.outbound)) {
      errors.push('licenses.outbound must be a non-empty string');
    }
    if (
      !Array.isArray(licenses.allowed) ||
      licenses.allowed.length === 0 ||
      licenses.allowed.some((entry) => !isNonEmptyString(entry))
    ) {
      errors.push(
        'licenses.allowed must be a non-empty array of non-empty strings',
      );
    }
    if (!Array.isArray(licenses.componentExceptions)) {
      errors.push('licenses.componentExceptions must be an array');
    } else {
      for (const [index, exception] of licenses.componentExceptions.entries()) {
        if (!isRecord(exception)) {
          errors.push(
            `licenses.componentExceptions[${index}] must be an object`,
          );
          continue;
        }
        if (
          !isNonEmptyString(exception.purl) &&
          !isNonEmptyString(exception.bomRef)
        ) {
          errors.push(
            `licenses.componentExceptions[${index}] must have a non-empty purl or bomRef`,
          );
        }
        if (!isNonEmptyString(exception.reason)) {
          errors.push(
            `licenses.componentExceptions[${index}].reason must be non-empty`,
          );
        }
      }
    }
  }

  const advisories = policy.advisories;
  if (!isRecord(advisories)) {
    errors.push('advisories must be an object');
  } else {
    if (!ADVISORY_SEVERITIES.has(advisories.severityThreshold)) {
      errors.push(
        'advisories.severityThreshold must be one of info, low, moderate, high, or critical',
      );
    }
    try {
      advisoryEnforcement(advisories);
    } catch (error) {
      errors.push(error.message);
    }
    if (!Array.isArray(advisories.waivers)) {
      errors.push('advisories.waivers must be an array');
    } else {
      for (const [index, waiver] of advisories.waivers.entries()) {
        if (
          !isRecord(waiver) ||
          !isNonEmptyString(waiver.id) ||
          !isNonEmptyString(waiver.reason)
        ) {
          errors.push(
            `advisories.waivers[${index}] must have non-empty id and reason strings`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`invalid supply-chain policy: ${errors.join('; ')}`);
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Licence policy
// ---------------------------------------------------------------------------

/**
 * The raw licence expressions carried by a CycloneDX component's `licenses`
 * node. `buildSbom` emits at most one entry, either `{ license: { id } }` for a
 * bare SPDX id or `{ expression }` for anything with an operator; a missing node
 * yields `[]`, which the caller treats as "no licence recorded". The array form
 * is handled generally so a hand-authored multi-licence node cannot slip past.
 */
export function licenseExpressionsOf(component) {
  const node = component?.licenses;
  if (!Array.isArray(node)) return [];
  const expressions = [];
  for (const entry of node) {
    if (typeof entry?.expression === 'string') {
      expressions.push(entry.expression);
    } else if (typeof entry?.license?.id === 'string') {
      expressions.push(entry.license.id);
    } else if (typeof entry?.license?.name === 'string') {
      // A `name` rather than an `id` is, by CycloneDX convention, a licence that
      // is not a recognised SPDX id. Keep it so it is evaluated and rejected
      // rather than dropped (dropping would read as "no licence", a softer fail).
      expressions.push(entry.license.name);
    }
  }
  return expressions;
}

/**
 * Is a single SPDX expression satisfied by the allowlist?
 *
 * Supports the operators that appear in real npm and cargo metadata: `OR`
 * (satisfied if any operand is), `AND` (only if all are), `WITH` (an exception
 * only loosens, so the base id governs), parentheses, and cargo's legacy `/`
 * dual-licence spelling (equivalent to `OR`). Unknown licence or exception ids,
 * and text such as `SEE LICENSE IN LICENSE`, are rejected by the SPDX parser so
 * the expression fails closed.
 */
export function isExpressionAllowed(expression, allowed) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  const { wellFormed, value } = parseSpdx(expression, allowedSet);
  return wellFormed && value;
}

/**
 * Parse an SPDX expression against an allowlist.
 *
 * Returns `wellFormed` (the token stream is a complete, valid SPDX expression)
 * separately from `value` (it evaluates to an allowed licence), so a caller can
 * tell an unparseable input — `SEE LICENSE IN LICENSE`, which is not an SPDX
 * expression — apart from a merely disallowed one.
 */
function parseSpdx(expression, allowed) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  if (typeof expression !== 'string' || expression.trim() === '') {
    return { wellFormed: false, value: false };
  }

  let parsed;
  try {
    parsed = parseSpdxExpression(expression.replace(/\//g, ' OR '));
  } catch {
    return { wellFormed: false, value: false };
  }

  const evaluate = (node) => {
    if (node.conjunction === 'or') {
      return evaluate(node.left) || evaluate(node.right);
    }
    if (node.conjunction === 'and') {
      return evaluate(node.left) && evaluate(node.right);
    }
    return allowedSet.has(node.license);
  };

  return { wellFormed: true, value: evaluate(parsed) };
}

/** Does an SBOM component match a policy exception (by bom-ref or purl)? */
function exceptionFor(component, exceptions) {
  return (exceptions ?? []).find(
    (exception) =>
      (isNonEmptyString(exception?.bomRef) &&
        exception.bomRef === component['bom-ref']) ||
      (isNonEmptyString(exception?.purl) && exception.purl === component.purl),
  );
}

/**
 * Evaluate every third-party component against the licence policy.
 *
 * Returns the violations rather than throwing so the runner can print all of
 * them at once and the tests can assert the exact set. A violation names the
 * component and *why* — `disallowed`, `unresolved` (unparseable/`UNKNOWN`), or
 * `missing` (no licence node and no exception) — because "some component failed"
 * cannot tell an author which dependency to look at.
 *
 * The application's own component (`metadata.component`) is checked against the
 * declared outbound licence, not the inbound allowlist: AGPL-3.0-only is the
 * project's licence, and it is deliberately absent from a list of permissive
 * inbound licences.
 */
export function evaluateLicensePolicy(sbom, policy) {
  const allowed = new Set(policy?.allowed ?? []);
  const exceptions = policy?.componentExceptions ?? [];
  const violations = [];
  const components = sbom?.components ?? [];

  for (const component of components) {
    const expressions = licenseExpressionsOf(component);
    const exception = exceptionFor(component, exceptions);

    if (expressions.length === 0) {
      // No licence recorded. Fail closed unless a reviewed exception explains it
      // (the native SQLite library carries no SPDX id in cargo metadata).
      if (!exception || !isNonEmptyString(exception.reason)) {
        violations.push({
          ref: component['bom-ref'],
          name: component.name,
          reason: 'missing',
          detail: 'no licence recorded and no reviewed exception',
        });
      }
      continue;
    }

    if (exception && isNonEmptyString(exception.reason)) continue;

    for (const expression of expressions) {
      if (isExpressionAllowed(expression, allowed)) continue;
      const parseable = parseSpdx(expression, allowed).wellFormed;
      violations.push({
        ref: component['bom-ref'],
        name: component.name,
        reason: parseable ? 'disallowed' : 'unresolved',
        detail: parseable
          ? `licence "${expression}" is not permitted under ${policy?.outbound ?? 'the outbound licence'}`
          : `licence "${expression}" is not a resolvable SPDX expression`,
      });
    }
  }

  // A stale exception is itself a policy defect: it may be a typo that was
  // intended to waive a real component. Verification over the staged SBOM must
  // prove every reviewed identity resolves to what actually ships.
  for (const exception of exceptions) {
    if (!isRecord(exception) || !isNonEmptyString(exception.reason)) continue;
    if (components.some((component) => exceptionFor(component, [exception]))) {
      continue;
    }
    const identity =
      (isNonEmptyString(exception.purl) && exception.purl) ||
      (isNonEmptyString(exception.bomRef) && exception.bomRef) ||
      '(missing identity)';
    violations.push({
      ref: '(policy)',
      name: identity,
      reason: 'policy',
      detail: `reviewed component exception "${identity}" does not match any SBOM component`,
    });
  }

  // The outbound licence is the premise of the whole allowlist; if it changes,
  // the allowlist was chosen for a different obligation and must be revisited.
  const outbound = policy?.outbound;
  if (!isNonEmptyString(outbound)) {
    violations.push({
      ref: sbom?.metadata?.component?.['bom-ref'] ?? '(root)',
      name: sbom?.metadata?.component?.name ?? '(root)',
      reason: 'policy',
      detail: 'licence policy is missing required non-empty "outbound"',
    });
  } else {
    const declared = licenseExpressionsOf(sbom?.metadata?.component);
    if (declared.length === 0 || !declared.includes(outbound)) {
      violations.push({
        ref: sbom?.metadata?.component?.['bom-ref'] ?? '(root)',
        name: sbom?.metadata?.component?.name ?? '(root)',
        reason: 'outbound',
        detail: `outbound licence is ${
          declared.length ? `"${declared.join(', ')}"` : 'unset'
        }, policy expects "${outbound}"`,
      });
    }
  }

  return { violations };
}

// ---------------------------------------------------------------------------
// Advisory policy
// ---------------------------------------------------------------------------

function evaluateSbomIdentityCoverage(
  sbom,
  ecosystem,
  expected,
  expectedSource,
  emptyDetail,
) {
  const actualCounts = new Map();
  const malformed = [];
  for (const component of sbom?.components ?? []) {
    const componentEcosystem = component?.properties?.find(
      (property) => property.name === 'printfarmer:ecosystem',
    )?.value;
    if (componentEcosystem !== ecosystem) continue;
    if (
      typeof component.name !== 'string' ||
      typeof component.version !== 'string'
    ) {
      malformed.push(String(component?.['bom-ref'] ?? '<missing bom-ref>'));
      continue;
    }
    const identity = `${component.name}@${component.version}`;
    actualCounts.set(identity, (actualCounts.get(identity) ?? 0) + 1);
  }

  const actual = new Set(actualCounts.keys());
  const missing = [...expected]
    .filter((identity) => !actual.has(identity))
    .sort(compareByCodeUnit);
  const unexpected = [...actual]
    .filter((identity) => !expected.has(identity))
    .sort(compareByCodeUnit);
  const duplicates = [...actualCounts]
    .filter(([, count]) => count > 1)
    .map(([identity]) => identity)
    .sort(compareByCodeUnit);
  malformed.sort(compareByCodeUnit);

  const actualCount = [...actualCounts.values()].reduce(
    (total, count) => total + count,
    0,
  );
  const complete =
    expected.size > 0 &&
    missing.length === 0 &&
    unexpected.length === 0 &&
    duplicates.length === 0 &&
    malformed.length === 0;
  const details = [];
  if (expected.size === 0) details.push(emptyDetail);
  if (missing.length > 0) details.push(`missing: ${missing.join(', ')}`);
  if (unexpected.length > 0) {
    details.push(`unexpected: ${unexpected.join(', ')}`);
  }
  if (duplicates.length > 0) {
    details.push(`duplicated: ${duplicates.join(', ')}`);
  }
  if (malformed.length > 0) {
    details.push(`malformed ${ecosystem} components: ${malformed.join(', ')}`);
  }

  return {
    complete,
    expectedCount: expected.size,
    actualCount,
    missing,
    unexpected,
    duplicates,
    malformed,
    diagnostic: complete
      ? null
      : `${ecosystem} SBOM completeness check expected ${expected.size} ${expectedSource} but found ${actualCount}; ${details.join('; ')}`,
  };
}

/**
 * Raised when `npm ls` output cannot be read, as distinct from the SBOM failing
 * to cover it.
 *
 * These are different findings with different owners and different repairs, and
 * before #201 they were reported identically. An unreadable tree is an *input*
 * failure — most often a partial install — and saying "completeness check" about
 * it sends the reader to the SBOM and the named package, both of which are fine.
 *
 * Carried as a distinct type rather than a string so callers can classify it
 * without matching on wording that is itself the thing being fixed.
 */
export class NpmProductionTreeUnreadableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NpmProductionTreeUnreadableError';
    this.unreadableInput = true;
  }
}

/** Shared tail: what to do about an unreadable tree, wherever it surfaces. */
export const UNREADABLE_TREE_REMEDY =
  'This is an unreadable dependency tree, not an SBOM policy violation: ' +
  'the install did not leave node_modules in a state npm can describe. ' +
  'Suspect the install step, not the SBOM and not the named package.';

/**
 * Compare npm SBOM identities with two mechanisms independent of generation:
 * npm's installed production tree and the packages imported by shipped source.
 */
export function evaluateNpmSbomCoverage(
  sbom,
  npmProductionTree,
  importedComponents,
) {
  if (!isRecord(npmProductionTree)) {
    throw new NpmProductionTreeUnreadableError(
      `npm ls produced no production tree to read. ${UNREADABLE_TREE_REMEDY}`,
    );
  }

  const expected = new Set();
  const walk = (node) => {
    if (!isRecord(node)) {
      throw new NpmProductionTreeUnreadableError(
        `npm ls returned a dependency node that is not an object. ${UNREADABLE_TREE_REMEDY}`,
      );
    }
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      if (!isRecord(child) || !isNonEmptyString(child.version)) {
        throw new NpmProductionTreeUnreadableError(
          `npm ls could not describe the installed package ${name}: it reported the ` +
            `package with no version. ${UNREADABLE_TREE_REMEDY}`,
        );
      }
      expected.add(`${name}@${child.version}`);
      walk(child);
    }
  };
  walk(npmProductionTree);

  for (const entry of importedComponents ?? []) {
    const [name, version] = entry;
    if (!isNonEmptyString(name) || !isNonEmptyString(version)) {
      throw new Error(
        'npm SBOM completeness check found an imported package without a name/version identity',
      );
    }
    expected.add(`${name}@${version}`);
  }

  return evaluateSbomIdentityCoverage(
    sbom,
    'npm',
    expected,
    'shipped component(s) from npm ls plus shipped source imports',
    'npm ls and shipped source imports contain no shipped packages',
  );
}

/**
 * Compare the SBOM's Cargo identities with an independent walk of raw,
 * feature-resolved `cargo metadata`.
 *
 * This deliberately does not call `deriveShippedCargoComponents`: that function
 * feeds the SBOM generator, so reusing it here would let the generator and its
 * completeness check agree on the same under-enumeration. Both walks follow
 * normal edges and exclude the root, but this one only produces an unordered
 * identity set for the advisory gate to compare.
 */
export function evaluateCargoSbomCoverage(sbom, metadata) {
  if (
    !Array.isArray(metadata?.packages) ||
    !Array.isArray(metadata?.resolve?.nodes) ||
    typeof metadata.resolve.root !== 'string'
  ) {
    throw new Error(
      'cargo SBOM completeness check requires feature-resolved cargo metadata with packages, resolve.nodes, and resolve.root',
    );
  }

  const packagesById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodesById = new Map(
    metadata.resolve.nodes.map((node) => [node.id, node]),
  );
  const reached = new Set();
  const queue = [metadata.resolve.root];

  while (queue.length > 0) {
    const id = queue.shift();
    if (reached.has(id)) continue;
    const node = nodesById.get(id);
    if (!node) {
      throw new Error(
        `cargo SBOM completeness check cannot find resolve node ${id}`,
      );
    }
    reached.add(id);
    for (const dependency of node.deps ?? []) {
      const isNormal = (dependency.dep_kinds ?? []).some(
        (entry) => (entry.kind ?? 'normal') === 'normal',
      );
      if (isNormal && !reached.has(dependency.pkg)) {
        queue.push(dependency.pkg);
      }
    }
  }
  reached.delete(metadata.resolve.root);

  const expected = new Set();
  for (const id of reached) {
    const pkg = packagesById.get(id);
    if (typeof pkg?.name !== 'string' || typeof pkg?.version !== 'string') {
      throw new Error(
        `cargo SBOM completeness check cannot identify resolved package ${id}`,
      );
    }
    expected.add(`${pkg.name}@${pkg.version}`);
  }

  return evaluateSbomIdentityCoverage(
    sbom,
    'cargo',
    expected,
    'feature-resolved shipped component(s) from cargo metadata',
    'feature-resolved cargo metadata contains no shipped crates',
  );
}

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/** Numeric rank for a severity label; unknown labels rank as `high` (3). */
export function severityRank(severity) {
  const key = String(severity).toLowerCase();
  return key in SEVERITY_RANK ? SEVERITY_RANK[key] : SEVERITY_RANK.high;
}

/**
 * Severity label from a CVSS vector string.
 *
 * cargo-audit leaves the advisory `severity` field empty and carries a CVSS
 * vector instead. v3.0/v3.1 base scores are computed from the documented
 * formula and bucketed with the standard bands. A v4.0 vector (whose scoring is
 * substantially more involved) or any unparseable vector returns `high` rather
 * than `unknown`: under-rating an advisory is the failure mode that matters, so
 * the default is conservative.
 */
export function severityFromCvss(vector) {
  const score = cvss3BaseScore(vector);
  if (score === null) return 'high';
  if (score === 0) return 'info';
  if (score < 4) return 'low';
  if (score < 7) return 'moderate';
  if (score < 9) return 'high';
  return 'critical';
}

function cvss3BaseScore(vector) {
  if (typeof vector !== 'string' || !/^CVSS:3\.[01]\//.test(vector))
    return null;
  const metrics = {};
  for (const part of vector.split('/').slice(1)) {
    const [key, value] = part.split(':');
    metrics[key] = value;
  }
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[metrics.AV];
  const AC = { L: 0.77, H: 0.44 }[metrics.AC];
  const UI = { N: 0.85, R: 0.62 }[metrics.UI];
  const scopeChanged = metrics.S === 'C';
  const PR = (
    scopeChanged ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 }
  )[metrics.PR];
  const impactMetric = { N: 0, L: 0.22, H: 0.56 };
  const C = impactMetric[metrics.C];
  const I = impactMetric[metrics.I];
  const A = impactMetric[metrics.A];
  if ([AV, AC, UI, PR, C, I, A].some((value) => value === undefined)) {
    return null;
  }
  const iss = 1 - (1 - C) * (1 - I) * (1 - A);
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * AV * AC * PR * UI;
  const raw = scopeChanged
    ? 1.08 * (impact + exploitability)
    : impact + exploitability;
  return roundUp(Math.min(raw, 10));
}

/** CVSS "Roundup": the smallest one-decimal number not less than the input. */
function roundUp(value) {
  return Math.ceil(value * 10) / 10;
}

/** Normalise an `npm audit --json` document into the common advisory shape. */
export function normalizeNpmAudit(report) {
  const advisories = [];
  const vulnerabilities = report?.vulnerabilities ?? {};
  for (const entry of Object.values(vulnerabilities)) {
    for (const via of entry?.via ?? []) {
      if (typeof via !== 'object') continue; // a string `via` is an indirect edge
      advisories.push({
        ecosystem: 'npm',
        id: via.url ? via.url.split('/').pop() : (via.source ?? via.title),
        title: via.title,
        package: via.name ?? entry.name,
        severity: String(
          via.severity ?? entry.severity ?? 'high',
        ).toLowerCase(),
        fixAvailable: Boolean(entry.fixAvailable),
      });
    }
  }
  return advisories;
}

/** Normalise a `cargo audit --json` document into the common advisory shape. */
export function normalizeCargoAudit(report) {
  const advisories = [];
  for (const item of report?.vulnerabilities?.list ?? []) {
    const patched = item?.versions?.patched ?? [];
    const version = item?.package?.version;
    advisories.push({
      ecosystem: 'cargo',
      id: item?.advisory?.id,
      title: item?.advisory?.title,
      package: item?.package?.name,
      version: isNonEmptyString(version) ? version : undefined,
      severity: severityFromCvss(item?.advisory?.cvss),
      fixAvailable: Array.isArray(patched) && patched.length > 0,
    });
  }
  return advisories;
}

/**
 * Keep only advisories whose package ships. Versioned records (cargo-audit)
 * match exact `name@version` identities; records without a reliable installed
 * version (npm audit) conservatively fall back to package name so a shipped
 * finding can never be dropped. Matching is independent of SBOM order.
 */
export function scopeToShippedClosure(
  advisories,
  shippedPackageNames,
  shippedPackageIdentities = [],
) {
  const shippedNames = new Set(shippedPackageNames);
  const shippedIdentities = new Set(shippedPackageIdentities);
  return advisories.filter((advisory) => {
    if (!shippedNames.has(advisory.package)) return false;
    if (!isNonEmptyString(advisory.version) || shippedIdentities.size === 0) {
      return true;
    }
    return shippedIdentities.has(`${advisory.package}@${advisory.version}`);
  });
}

/**
 * Partition in-scope advisories against the policy.
 *
 * `blocking` is the set at or above the severity threshold that no waiver
 * covers; `waived` is those a per-id waiver accepts (a waiver MUST name an id
 * and give a reason — there is no wildcard, so the gate cannot be silenced by a
 * blanket ignore); `belowThreshold` is the rest. `couldNotRun` is passed
 * through untouched: an inability to audit is never an empty-and-clean result.
 */
export function evaluateAdvisories(input, policy) {
  advisoryEnforcement(policy);
  const threshold = severityRank(policy?.severityThreshold ?? 'high');
  const waivers = new Map(
    (policy?.waivers ?? [])
      .filter(
        (waiver) =>
          isNonEmptyString(waiver?.id) && isNonEmptyString(waiver?.reason),
      )
      .map((waiver) => [waiver.id, waiver]),
  );
  const blocking = [];
  const waived = [];
  const belowThreshold = [];

  for (const advisory of input?.advisories ?? []) {
    if (severityRank(advisory.severity) < threshold) {
      belowThreshold.push(advisory);
    } else if (waivers.has(advisory.id)) {
      waived.push({ ...advisory, waiver: waivers.get(advisory.id) });
    } else {
      blocking.push(advisory);
    }
  }

  return {
    blocking,
    waived,
    belowThreshold,
    couldNotRun: input?.couldNotRun ?? [],
  };
}

// ---------------------------------------------------------------------------
// Third-party notices
// ---------------------------------------------------------------------------

const ECOSYSTEM_HEADINGS = [
  ['npm', 'npm packages'],
  ['cargo', 'Cargo crates'],
  ['native', 'Statically linked native libraries'],
];

/**
 * Render the enumerated dependency-licence notice from the SBOM.
 *
 * Deterministic by the same construction as the SBOM: components are ordered by
 * `bom-ref` with `compareByCodeUnit` (never `localeCompare` — see #112), there
 * is no timestamp, and the text is a pure function of the component set. So a
 * fresh render is byte-identical across runners, which is what lets
 * `verify-notices` regenerate and compare. That single-job regenerate-compare
 * shares the SBOM's limitation — it cannot catch a divergence that only appears
 * on another platform — and is sound here for the same reason the SBOM's is:
 * the ordering is locale-independent and nothing platform-specific is an input.
 */
export function renderThirdPartyNotices(sbom) {
  const ecosystemOf = (component) =>
    component.properties?.find((p) => p.name === 'printfarmer:ecosystem')
      ?.value;

  const lines = [];
  lines.push('# Third-Party Dependency Licences');
  lines.push('');
  lines.push(
    'Generated from the CycloneDX SBOM by `scripts/generate-notices.mjs`; do not',
  );
  lines.push(
    'edit by hand. `npm run verify:notices` fails CI if it drifts from a fresh',
  );
  lines.push('regeneration of the committed lockfiles.');
  lines.push('');

  const root = sbom?.metadata?.component;
  if (root) {
    const outbound = licenseExpressionsOf(root).join(', ') || 'see LICENSE';
    lines.push(
      `Outbound licence: **${root.name} ${root.version}** — ${outbound}.`,
    );
    lines.push('');
  }

  const components = [...(sbom?.components ?? [])].sort((a, b) =>
    compareByCodeUnit(a['bom-ref'], b['bom-ref']),
  );

  for (const [ecosystem, heading] of ECOSYSTEM_HEADINGS) {
    const inGroup = components.filter((c) => ecosystemOf(c) === ecosystem);
    if (inGroup.length === 0) continue;
    lines.push(`## ${heading}`);
    lines.push('');
    for (const component of inGroup) {
      const licence =
        licenseExpressionsOf(component).join(', ') ||
        'no SPDX licence recorded (see supply-chain-policy.json exception)';
      lines.push(`- **${component.name}** ${component.version} — ${licence}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
