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

const SPDX_ATOM = /^[A-Za-z0-9.\-+]+$/;

/**
 * Is a single SPDX expression satisfied by the allowlist?
 *
 * Supports the operators that appear in real npm and cargo metadata: `OR`
 * (satisfied if any operand is), `AND` (only if all are), `WITH` (an exception
 * only loosens, so the base id governs), parentheses, and cargo's legacy `/`
 * dual-licence spelling (equivalent to `OR`). An atom that is not a well-formed
 * SPDX token — `UNKNOWN`, or the words of `SEE LICENSE IN LICENSE` — is simply
 * not in the allowlist, so the expression fails closed.
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
 * tell an unparseable input — `SEE LICENSE IN LICENSE`, which tokenises into
 * bare words the grammar cannot connect — apart from a merely disallowed one.
 */
function parseSpdx(expression, allowed) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  const tokens = tokenizeSpdx(expression);
  if (tokens === null) return { wellFormed: false, value: false };
  let position = 0;

  const peek = () => tokens[position];
  const next = () => tokens[position++];

  // expr := term (OR term)*
  function parseExpr() {
    let value = parseTerm();
    while (peek() === 'OR') {
      next();
      const right = parseTerm();
      value = value || right;
    }
    return value;
  }
  // term := factor (AND factor)*
  function parseTerm() {
    let value = parseFactor();
    while (peek() === 'AND') {
      next();
      const right = parseFactor();
      value = value && right;
    }
    return value;
  }
  // factor := '(' expr ')' | atom ('WITH' atom)?
  function parseFactor() {
    if (peek() === '(') {
      next();
      const value = parseExpr();
      if (peek() === ')') next();
      return value;
    }
    const atom = next();
    if (atom === undefined) return false;
    const value = allowedSet.has(atom);
    if (peek() === 'WITH') {
      next();
      next(); // consume the exception id; a WITH exception only loosens the base
    }
    return value;
  }

  const value = parseExpr();
  return { wellFormed: position === tokens.length, value };
}

/**
 * Split an SPDX expression into a token stream, or `null` if a character
 * outside the SPDX grammar appears. `/` is normalised to `OR` first.
 */
function tokenizeSpdx(expression) {
  if (typeof expression !== 'string') return null;
  const normalized = expression.replace(/\//g, ' OR ');
  const tokens = [];
  for (const piece of normalized.split(/\s+/)) {
    if (piece === '') continue;
    let rest = piece;
    // Parentheses can hug an atom (`(MIT`); peel them off as their own tokens.
    while (rest.startsWith('(')) {
      tokens.push('(');
      rest = rest.slice(1);
    }
    const trailing = [];
    while (rest.endsWith(')')) {
      trailing.push(')');
      rest = rest.slice(0, -1);
    }
    if (rest !== '') {
      if (rest === 'OR' || rest === 'AND' || rest === 'WITH') {
        tokens.push(rest);
      } else if (SPDX_ATOM.test(rest)) {
        tokens.push(rest);
      } else {
        return null;
      }
    }
    tokens.push(...trailing);
  }
  return tokens;
}

/** Does an SBOM component match a policy exception (by bom-ref or purl)? */
function exceptionFor(component, exceptions) {
  return (exceptions ?? []).find(
    (exception) =>
      (exception.bomRef && exception.bomRef === component['bom-ref']) ||
      (exception.purl && exception.purl === component.purl),
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

  for (const component of sbom?.components ?? []) {
    const expressions = licenseExpressionsOf(component);
    const exception = exceptionFor(component, exceptions);

    if (expressions.length === 0) {
      // No licence recorded. Fail closed unless a reviewed exception explains it
      // (the native SQLite library carries no SPDX id in cargo metadata).
      if (!exception || !exception.reason) {
        violations.push({
          ref: component['bom-ref'],
          name: component.name,
          reason: 'missing',
          detail: 'no licence recorded and no reviewed exception',
        });
      }
      continue;
    }

    if (exception && exception.reason) continue; // reviewed and accepted

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

  // The outbound licence is the premise of the whole allowlist; if it changes,
  // the allowlist was chosen for a different obligation and must be revisited.
  const outbound = policy?.outbound;
  if (outbound) {
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

  const actualCounts = new Map();
  const malformed = [];
  for (const component of sbom?.components ?? []) {
    const ecosystem = component?.properties?.find(
      (property) => property.name === 'printfarmer:ecosystem',
    )?.value;
    if (ecosystem !== 'cargo') continue;
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
  if (expected.size === 0) {
    details.push('feature-resolved cargo metadata contains no shipped crates');
  }
  if (missing.length > 0) details.push(`missing: ${missing.join(', ')}`);
  if (unexpected.length > 0) {
    details.push(`unexpected: ${unexpected.join(', ')}`);
  }
  if (duplicates.length > 0) {
    details.push(`duplicated: ${duplicates.join(', ')}`);
  }
  if (malformed.length > 0) {
    details.push(`malformed cargo components: ${malformed.join(', ')}`);
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
      : `cargo SBOM completeness check expected ${expected.size} feature-resolved shipped component(s) from cargo metadata but found ${actualCount}; ${details.join('; ')}`,
  };
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
    advisories.push({
      ecosystem: 'cargo',
      id: item?.advisory?.id,
      title: item?.advisory?.title,
      package: item?.package?.name,
      severity: severityFromCvss(item?.advisory?.cvss),
      fixAvailable: Array.isArray(patched) && patched.length > 0,
    });
  }
  return advisories;
}

/**
 * Keep only advisories whose package ships. The shipped set is matched by NAME,
 * not by SBOM order: `verify-sbom` already proves the closure, and #112 records
 * that its ordering is locale-dependent, so a gate keyed off order would inherit
 * that. `cargo audit` reads the whole `Cargo.lock`, so without this an advisory
 * on an unshipped crate (a `truck-*` or `lib3mf` dependency) would gate a
 * release that does not contain it.
 */
export function scopeToShippedClosure(advisories, shippedPackageNames) {
  const shipped = new Set(shippedPackageNames);
  return advisories.filter((advisory) => shipped.has(advisory.package));
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
  const threshold = severityRank(policy?.severityThreshold ?? 'high');
  const waivers = new Map(
    (policy?.waivers ?? [])
      .filter((waiver) => waiver && waiver.id && waiver.reason)
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
