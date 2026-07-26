// @vitest-environment node

// Supply-chain POLICY gates.
//
// The enumeration suite (`supplyChain.test.ts`) proves the SBOM lists what
// ships. This suite proves the three policies over that SBOM actually decide —
// that each gate fails for the reason it names and, just as importantly, admits
// the legitimate maximum. A gate that only rejects proves nothing a
// reject-everything stub would not also pass, so every limit here is pushed from
// BOTH sides.
//
// Names state the property each test pins, not the risk behind it.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildSbom } from '../scripts/supply-chain.mjs';
import {
  evaluateAdvisories,
  evaluateLicensePolicy,
  isExpressionAllowed,
  licenseExpressionsOf,
  normalizeCargoAudit,
  normalizeNpmAudit,
  renderThirdPartyNotices,
  scopeToShippedClosure,
  severityFromCvss,
  severityRank,
} from '../scripts/supply-chain-policy.mjs';
import type {
  Advisory,
  AdvisoryPolicy,
  Sbom,
  SbomComponent,
} from '../scripts/supply-chain-policy.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readLock(): unknown {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'),
  );
}

// --- fixtures -------------------------------------------------------------

/** Mirror of `licenseNode` in supply-chain.mjs: id when bare, else expression. */
function licNode(expression: string | undefined): unknown {
  if (!expression) return undefined;
  return /[\s()/]/.test(expression)
    ? [{ expression }]
    : [{ license: { id: expression } }];
}

function comp(
  name: string,
  expression: string | undefined,
  ecosystem = 'cargo',
): SbomComponent {
  return {
    type: 'library',
    'bom-ref': `pkg:${ecosystem}/${name}@1.0.0`,
    name,
    version: '1.0.0',
    purl: `pkg:${ecosystem}/${name}`,
    licenses: licNode(expression),
    properties: [{ name: 'printfarmer:ecosystem', value: ecosystem }],
  };
}

function sbomWith(
  components: SbomComponent[],
  rootLicense: string | undefined = 'AGPL-3.0-only',
): Sbom {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: 'urn:uuid:00000000-0000-0000-0000-000000000000',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': 'pkg:npm/printfarmer-desktop@0.1.0',
        name: 'printfarmer-desktop',
        version: '0.1.0',
        licenses: licNode(rootLicense),
      },
      properties: [],
    },
    components,
  };
}

const licensePolicy = {
  outbound: 'AGPL-3.0-only',
  allowed: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'Unicode-3.0'],
  componentExceptions: [],
};

// --- licence: SPDX expression evaluation ----------------------------------

describe('the licence gate admits the legitimate maximum and rejects the rest', () => {
  it('accepts a bare allowed id and rejects a bare disallowed one', () => {
    expect(isExpressionAllowed('MIT', licensePolicy.allowed)).toBe(true);
    expect(isExpressionAllowed('GPL-2.0-only', licensePolicy.allowed)).toBe(
      false,
    );
  });

  it('treats OR as satisfied when any operand is allowed', () => {
    // The disallowed operand must not sink an OR — this is the half a
    // reject-everything stub would fail.
    expect(
      isExpressionAllowed('GPL-2.0-only OR MIT', licensePolicy.allowed),
    ).toBe(true);
    expect(
      isExpressionAllowed('MIT OR Apache-2.0', licensePolicy.allowed),
    ).toBe(true);
  });

  it('treats AND as satisfied only when every operand is allowed', () => {
    expect(
      isExpressionAllowed('MIT AND Apache-2.0', licensePolicy.allowed),
    ).toBe(true);
    // If AND collapsed to OR, this would wrongly pass on the MIT operand alone.
    expect(
      isExpressionAllowed('MIT AND GPL-2.0-only', licensePolicy.allowed),
    ).toBe(false);
  });

  it('evaluates a WITH exception by its base licence', () => {
    expect(
      isExpressionAllowed(
        'Apache-2.0 WITH LLVM-exception',
        licensePolicy.allowed,
      ),
    ).toBe(true);
    expect(
      isExpressionAllowed(
        'GPL-2.0-only WITH Classpath-exception-2.0',
        licensePolicy.allowed,
      ),
    ).toBe(false);
  });

  it('reads cargo\u2019s legacy slash as OR', () => {
    expect(isExpressionAllowed('MIT/Apache-2.0', licensePolicy.allowed)).toBe(
      true,
    );
    expect(
      isExpressionAllowed('GPL-2.0-only/LGPL-2.1-only', licensePolicy.allowed),
    ).toBe(false);
  });

  it('respects parenthesised precedence', () => {
    expect(
      isExpressionAllowed(
        '(MIT OR GPL-2.0-only) AND Unicode-3.0',
        licensePolicy.allowed,
      ),
    ).toBe(true);
    expect(
      isExpressionAllowed(
        '(GPL-2.0-only OR LGPL-2.1-only) AND MIT',
        licensePolicy.allowed,
      ),
    ).toBe(false);
  });

  it('fails closed on an unparseable or unknown expression', () => {
    for (const expression of [
      'UNKNOWN',
      'SEE LICENSE IN LICENSE',
      'MIT AND',
      '',
    ]) {
      expect(isExpressionAllowed(expression, licensePolicy.allowed)).toBe(
        false,
      );
    }
  });
});

// --- licence: whole-SBOM policy -------------------------------------------

describe('evaluateLicensePolicy names the offending component and why', () => {
  it('passes a tree of allowed licences with no violations', () => {
    const { violations } = evaluateLicensePolicy(
      sbomWith([
        comp('a', 'MIT'),
        comp('b', 'MIT OR Apache-2.0'),
        comp('c', '(MIT OR Apache-2.0) AND Unicode-3.0'),
      ]),
      licensePolicy,
    );
    expect(violations).toEqual([]);
  });

  it('reports a disallowed licence as "disallowed" against the exact ref', () => {
    const { violations } = evaluateLicensePolicy(
      sbomWith([comp('good', 'MIT'), comp('bad', 'GPL-2.0-only')]),
      licensePolicy,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      ref: 'pkg:cargo/bad@1.0.0',
      name: 'bad',
      reason: 'disallowed',
    });
  });

  it('reports a component with no licence node as "missing"', () => {
    const { violations } = evaluateLicensePolicy(
      sbomWith([comp('nolicence', undefined)]),
      licensePolicy,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      name: 'nolicence',
      reason: 'missing',
    });
  });

  it('distinguishes an unresolvable expression from a merely disallowed one', () => {
    const { violations } = evaluateLicensePolicy(
      sbomWith([comp('weird', 'SEE LICENSE IN LICENSE')]),
      licensePolicy,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      name: 'weird',
      reason: 'unresolved',
    });
  });

  it('fails closed when the licence sits under a singular "license" key', () => {
    // CycloneDX carries `licenses` (plural). A singular `license` — a shape npm
    // metadata produces — must not be silently read as "acceptable"; it reads as
    // no licence and fails.
    const malformed = comp('shape', 'MIT');
    delete (malformed as unknown as Record<string, unknown>).licenses;
    (malformed as unknown as Record<string, unknown>).license = 'MIT';
    const { violations } = evaluateLicensePolicy(
      sbomWith([malformed]),
      licensePolicy,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ name: 'shape', reason: 'missing' });
  });

  it('accepts a reviewed exception, but only when it carries a reason', () => {
    const withReason = evaluateLicensePolicy(
      sbomWith([comp('sqlite3', undefined)]),
      {
        ...licensePolicy,
        componentExceptions: [
          { purl: 'pkg:cargo/sqlite3', reason: 'public domain' },
        ],
      },
    );
    expect(withReason.violations).toEqual([]);

    const withoutReason = evaluateLicensePolicy(
      sbomWith([comp('sqlite3', undefined)]),
      {
        ...licensePolicy,
        componentExceptions: [{ purl: 'pkg:cargo/sqlite3', reason: '' }],
      },
    );
    // A reasonless waiver is not a waiver — the gate cannot be silenced blanket.
    expect(withoutReason.violations).toHaveLength(1);
  });

  it('an exception waives an otherwise-disallowed licence too', () => {
    const { violations } = evaluateLicensePolicy(
      sbomWith([comp('copyleft', 'GPL-2.0-only')]),
      {
        ...licensePolicy,
        componentExceptions: [
          { purl: 'pkg:cargo/copyleft', reason: 'linked exception, reviewed' },
        ],
      },
    );
    expect(violations).toEqual([]);
  });

  it('flags an outbound-licence change on the root component', () => {
    const good = evaluateLicensePolicy(
      sbomWith([comp('a', 'MIT')], 'AGPL-3.0-only'),
      licensePolicy,
    );
    expect(good.violations).toEqual([]);

    const changed = evaluateLicensePolicy(
      sbomWith([comp('a', 'MIT')], 'MIT'),
      licensePolicy,
    );
    expect(changed.violations).toHaveLength(1);
    expect(changed.violations[0]).toMatchObject({ reason: 'outbound' });
  });
});

// --- licence: integration through buildSbom -------------------------------

describe('the licence gate over a real buildSbom document', () => {
  // A cargo metadata document whose crate licences mirror the shapes the real
  // tree carries, plus one disallowed crate. This drives the derivation and the
  // policy across their real boundary rather than a hand-built component array.
  function cargoMetadata(rootLicense: string, crateLicense: string): unknown {
    const pkg = (
      name: string,
      license: string,
      extra: Record<string, unknown> = {},
    ) => ({
      id: `${name} 1.0.0`,
      name,
      version: '1.0.0',
      license,
      source: 'registry+https://github.com/rust-lang/crates.io-index',
      targets: [{ kind: ['lib'], name }],
      ...extra,
    });
    return {
      packages: [
        pkg('root', rootLicense, { id: 'root 1.0.0', source: null }),
        pkg('dual', 'MIT OR Apache-2.0'),
        pkg('slashed', 'MIT/Apache-2.0'),
        pkg('subject', crateLicense),
      ],
      resolve: {
        root: 'root 1.0.0',
        nodes: [
          {
            id: 'root 1.0.0',
            deps: [
              { pkg: 'dual 1.0.0', dep_kinds: [{ kind: null }] },
              { pkg: 'slashed 1.0.0', dep_kinds: [{ kind: null }] },
              { pkg: 'subject 1.0.0', dep_kinds: [{ kind: null }] },
            ],
          },
          { id: 'dual 1.0.0', deps: [] },
          { id: 'slashed 1.0.0', deps: [] },
          { id: 'subject 1.0.0', deps: [] },
        ],
      },
    };
  }

  const policy = {
    outbound: 'AGPL-3.0-only',
    allowed: ['MIT', 'Apache-2.0'],
    componentExceptions: [],
  };

  it('passes when every derived component is permissive', () => {
    const sbom = buildSbom({
      lock: readLock(),
      repoRoot,
      cargoMetadata: cargoMetadata('AGPL-3.0-only', 'MIT'),
      features: [],
    });
    expect(evaluateLicensePolicy(sbom, policy).violations).toEqual([]);
  });

  it('catches a disallowed crate licence carried through the derivation', () => {
    const sbom = buildSbom({
      lock: readLock(),
      repoRoot,
      cargoMetadata: cargoMetadata('AGPL-3.0-only', 'GPL-3.0-only'),
      features: [],
    });
    const { violations } = evaluateLicensePolicy(sbom, policy);
    expect(violations.map((v) => v.name)).toContain('subject');
  });
});

// --- advisories: threshold, waivers, scope --------------------------------

const advisoryPolicy: AdvisoryPolicy = {
  severityThreshold: 'high',
  enforcement: 'report',
  waivers: [],
};

function advisory(
  id: string,
  severity: string,
  overrides: Partial<Advisory> = {},
): Advisory {
  return {
    ecosystem: 'cargo',
    id,
    title: id,
    package: 'shipped-crate',
    severity,
    fixAvailable: true,
    ...overrides,
  };
}

describe('the advisory gate brackets its threshold from both sides', () => {
  it('does not block below the threshold but does at and above it', () => {
    const result = evaluateAdvisories(
      {
        advisories: [
          advisory('A-low', 'low'),
          advisory('A-moderate', 'moderate'),
          advisory('A-high', 'high'),
          advisory('A-critical', 'critical'),
        ],
      },
      advisoryPolicy,
    );
    expect(result.blocking.map((a) => a.id)).toEqual(['A-high', 'A-critical']);
    expect(result.belowThreshold.map((a) => a.id)).toEqual([
      'A-low',
      'A-moderate',
    ]);
  });

  it('moves the moderate advisory across when the threshold is lowered', () => {
    // Proves the threshold is actually consulted, not hard-coded at high.
    const result = evaluateAdvisories(
      { advisories: [advisory('A-moderate', 'moderate')] },
      { ...advisoryPolicy, severityThreshold: 'moderate' },
    );
    expect(result.blocking.map((a) => a.id)).toEqual(['A-moderate']);
  });

  it('counts a no-fix advisory as blocking', () => {
    const result = evaluateAdvisories(
      { advisories: [advisory('A-high', 'high', { fixAvailable: false })] },
      advisoryPolicy,
    );
    expect(result.blocking).toHaveLength(1);
  });

  it('waives by exact id with a reason, and never blanket', () => {
    const waived = evaluateAdvisories(
      { advisories: [advisory('A-high', 'high')] },
      {
        ...advisoryPolicy,
        waivers: [{ id: 'A-high', reason: 'no shipped code path reaches it' }],
      },
    );
    expect(waived.blocking).toEqual([]);
    expect(waived.waived.map((a) => a.id)).toEqual(['A-high']);

    const reasonless = evaluateAdvisories(
      { advisories: [advisory('A-high', 'high')] },
      {
        ...advisoryPolicy,
        waivers: [{ id: 'A-high', reason: '' }],
      },
    );
    expect(reasonless.blocking).toHaveLength(1);

    const wrongId = evaluateAdvisories(
      { advisories: [advisory('A-high', 'high')] },
      {
        ...advisoryPolicy,
        waivers: [{ id: 'A-other', reason: 'unrelated' }],
      },
    );
    expect(wrongId.blocking).toHaveLength(1);
  });

  it('carries could-not-run through untouched (the runner fails loud on it)', () => {
    const result = evaluateAdvisories(
      { advisories: [], couldNotRun: ['npm audit did not return a report'] },
      advisoryPolicy,
    );
    expect(result.couldNotRun).toEqual(['npm audit did not return a report']);
  });

  it('is green on a clean report — the negative control', () => {
    const result = evaluateAdvisories({ advisories: [] }, advisoryPolicy);
    expect(result.blocking).toEqual([]);
    expect(result.waived).toEqual([]);
    expect(result.belowThreshold).toEqual([]);
    expect(result.couldNotRun).toEqual([]);
  });
});

describe('advisories are scoped to the shipped closure by name', () => {
  it('drops an advisory whose package does not ship', () => {
    const scoped = scopeToShippedClosure(
      [
        advisory('A-shipped', 'high', { package: 'quick-xml' }),
        advisory('A-unshipped', 'high', { package: 'lz4_flex' }),
      ],
      ['quick-xml', 'serde'],
    );
    expect(scoped.map((a) => a.package)).toEqual(['quick-xml']);
  });
});

// --- advisories: normalisation and severity -------------------------------

describe('CVSS vectors are bucketed, defaulting conservatively', () => {
  it('scores the real quick-xml v3.1 vector as high', () => {
    expect(
      severityFromCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H'),
    ).toBe('high');
  });

  it('scores a low-impact v3.1 vector as low', () => {
    expect(
      severityFromCvss('CVSS:3.1/AV:N/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N'),
    ).toBe('low');
  });

  it('defaults a v4.0 or unparseable vector to high, not to unknown', () => {
    expect(
      severityFromCvss('CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:N/VA:N'),
    ).toBe('high');
    expect(severityFromCvss('not-a-vector')).toBe('high');
    expect(severityFromCvss(undefined)).toBe('high');
  });

  it('ranks an unknown severity label as high', () => {
    expect(severityRank('nonsense')).toBe(severityRank('high'));
  });
});

describe('audit reports normalise into one shape', () => {
  it('derives cargo severity from the CVSS vector and fix from patched versions', () => {
    const advisories = normalizeCargoAudit({
      vulnerabilities: {
        list: [
          {
            advisory: {
              id: 'RUSTSEC-2026-0194',
              title: 'quick-xml',
              cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
            },
            package: { name: 'quick-xml', version: '0.22.0' },
            versions: { patched: ['>=0.23.0'], unaffected: [] },
          },
        ],
      },
    });
    expect(advisories).toEqual([
      {
        ecosystem: 'cargo',
        id: 'RUSTSEC-2026-0194',
        title: 'quick-xml',
        package: 'quick-xml',
        severity: 'high',
        fixAvailable: true,
      },
    ]);
  });

  it('reads npm advisory id, severity and package from the via list', () => {
    const advisories = normalizeNpmAudit({
      vulnerabilities: {
        lodash: {
          name: 'lodash',
          severity: 'high',
          via: [
            {
              source: 1065,
              name: 'lodash',
              title: 'Prototype Pollution',
              url: 'https://github.com/advisories/GHSA-jf85',
              severity: 'high',
            },
          ],
          fixAvailable: true,
        },
      },
    });
    expect(advisories).toEqual([
      {
        ecosystem: 'npm',
        id: 'GHSA-jf85',
        title: 'Prototype Pollution',
        package: 'lodash',
        severity: 'high',
        fixAvailable: true,
      },
    ]);
  });
});

// --- notices --------------------------------------------------------------

describe('the third-party notice is a deterministic, code-unit-ordered render', () => {
  it('is byte-identical on repeated renders', () => {
    const sbom = sbomWith([comp('b', 'MIT'), comp('a', 'Apache-2.0')]);
    expect(renderThirdPartyNotices(sbom)).toBe(renderThirdPartyNotices(sbom));
  });

  it('orders components by code unit, not by locale collation', () => {
    // 'z' (U+007A) precedes '\u00e9' by code unit, but many locale collations
    // fold 'é' next to 'e' and would place it first. Pinning the exact order is
    // the property #112 established; a localeCompare sort fails this.
    const sbom = sbomWith([
      comp('\u00e9clair', 'MIT', 'npm'),
      comp('zzz', 'MIT', 'npm'),
    ]);
    const body = renderThirdPartyNotices(sbom);
    expect(body.indexOf('zzz')).toBeLessThan(body.indexOf('\u00e9clair'));
  });

  it('changes when the component set changes, so drift is detectable', () => {
    const a = renderThirdPartyNotices(sbomWith([comp('a', 'MIT')]));
    const b = renderThirdPartyNotices(
      sbomWith([comp('a', 'MIT'), comp('b', 'MIT')]),
    );
    expect(a).not.toBe(b);
  });

  it('renders a placeholder for a component with no licence node', () => {
    const body = renderThirdPartyNotices(
      sbomWith([comp('sqlite3', undefined, 'native')]),
    );
    expect(body).toContain('sqlite3');
    expect(body).toMatch(/no SPDX licence recorded/);
  });
});

describe('licenseExpressionsOf reads the CycloneDX licence node', () => {
  it('returns the id, the expression, or an empty list', () => {
    expect(
      licenseExpressionsOf({ licenses: [{ license: { id: 'MIT' } }] }),
    ).toEqual(['MIT']);
    expect(
      licenseExpressionsOf({ licenses: [{ expression: 'MIT OR Apache-2.0' }] }),
    ).toEqual(['MIT OR Apache-2.0']);
    expect(licenseExpressionsOf({})).toEqual([]);
  });
});
