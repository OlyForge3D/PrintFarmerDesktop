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
import {
  NPM_AUDIT_ARGS,
  requireCargoSbomCoverage,
  requireNpmSbomCoverage,
} from '../scripts/audit-advisories.mjs';
import {
  cargoMetadataArgs,
  readNpmProductionTree,
} from '../scripts/generate-sbom.mjs';
import { SIDECAR_BUILD_ARGS } from '../scripts/stage-sidecar.mjs';
import {
  buildSbom,
  deriveShippedNpmComponents,
  readImportedNpmComponents,
} from '../scripts/supply-chain.mjs';
import {
  advisoryEnforcement,
  evaluateCargoSbomCoverage,
  evaluateAdvisories,
  evaluateLicensePolicy,
  evaluateNpmSbomCoverage,
  isExpressionAllowed,
  licenseExpressionsOf,
  normalizeCargoAudit,
  normalizeNpmAudit,
  renderThirdPartyNotices,
  scopeToShippedClosure,
  severityFromCvss,
  severityRank,
  validateSupplyChainPolicy,
} from '../scripts/supply-chain-policy.mjs';
import type {
  Advisory,
  AdvisoryPolicy,
  Sbom,
  SbomComponent,
  SupplyChainPolicy,
} from '../scripts/supply-chain-policy.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packageManifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as {
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const shippedPolicy = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'scripts', 'supply-chain-policy.json'),
    'utf8',
  ),
) as SupplyChainPolicy;
const releaseWorkflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);
const ciWorkflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
  'utf8',
);

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  continueOnError?: string;
}

function parseWorkflowSteps(workflow: string, jobName: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let current: WorkflowStep | null = null;
  let inMakeJob = false;
  let inSteps = false;

  for (const line of workflow.split(/\r?\n/)) {
    if (line === `  ${jobName}:`) {
      inMakeJob = true;
      continue;
    }
    if (!inMakeJob) continue;
    if (/^ {2}[A-Za-z0-9_-]+:/.test(line)) break;
    if (line === '    steps:') {
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;

    const start = /^ {6}- (name|uses):\s*(.+)$/.exec(line);
    if (start) {
      const key = start[1];
      const value = start[2];
      if ((key !== 'name' && key !== 'uses') || value === undefined) continue;
      current = {};
      steps.push(current);
      current[key] = value.trim();
      continue;
    }
    if (current === null) continue;

    const property = /^ {8}(name|run|uses|continue-on-error):\s*(.+)$/.exec(
      line,
    );
    if (!property) continue;
    const value = property[2];
    if (value === undefined) continue;
    const key =
      property[1] === 'continue-on-error'
        ? 'continueOnError'
        : (property[1] as 'name' | 'run' | 'uses');
    current[key] = value.trim();
  }

  return steps;
}

function requireLockedWorkspaceCargoCommands(
  workflows: Array<{ contents: string; jobs: string[] }>,
): string[] {
  const commands = workflows.flatMap(({ contents, jobs }) =>
    jobs.flatMap((job) =>
      parseWorkflowSteps(contents, job)
        .map((step) => step.run)
        .filter(
          (run): run is string =>
            typeof run === 'string' &&
            /^cargo (?:build|test|clippy)(?:\s|$)/.test(run),
        ),
    ),
  );
  const unlocked = commands.filter(
    (command) => !/(?:^|\s)--locked(?:\s|$)/.test(command),
  );
  if (unlocked.length > 0) {
    throw new Error(`workspace Cargo command is not locked: ${unlocked[0]}`);
  }
  return commands;
}

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

function linkedNativeCargoMetadata(links: string): unknown {
  const rootId = 'path+file:///repo/native/model-core#0.1.0';
  const crateId =
    'registry+https://github.com/rust-lang/crates.io-index#libsqlite3-sys@0.30.1';
  return {
    packages: [
      {
        id: rootId,
        name: 'model-core',
        version: '0.1.0',
        license: 'AGPL-3.0-only',
        source: null,
        targets: [{ kind: ['lib'], name: 'model_core' }],
      },
      {
        id: crateId,
        name: 'libsqlite3-sys',
        version: '0.30.1',
        license: 'MIT',
        source: 'registry+https://github.com/rust-lang/crates.io-index',
        links,
        targets: [{ kind: ['lib'], name: 'libsqlite3_sys' }],
      },
    ],
    resolve: {
      root: rootId,
      nodes: [
        {
          id: rootId,
          deps: [{ pkg: crateId, dep_kinds: [{ kind: null }] }],
        },
        { id: crateId, deps: [] },
      ],
    },
  };
}

const licensePolicy = {
  outbound: 'AGPL-3.0-only',
  allowed: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'Unicode-3.0'],
  componentExceptions: [],
};

describe('the shipped supply-chain policy is the validated source of truth', () => {
  it('has every required block and key and matches the package outbound licence', () => {
    expect(() => validateSupplyChainPolicy(shippedPolicy)).not.toThrow();
    expect(typeof shippedPolicy.licenses.outbound).toBe('string');
    expect(Array.isArray(shippedPolicy.licenses.allowed)).toBe(true);
    expect(Array.isArray(shippedPolicy.licenses.componentExceptions)).toBe(
      true,
    );
    expect(typeof shippedPolicy.advisories.severityThreshold).toBe('string');
    expect(typeof shippedPolicy.advisories.enforcement).toBe('string');
    expect(Array.isArray(shippedPolicy.advisories.waivers)).toBe(true);
    expect(packageManifest.license).toBe('AGPL-3.0-only');
    expect(shippedPolicy.licenses.outbound).toBe(packageManifest.license);
    expect(advisoryEnforcement(shippedPolicy.advisories)).toBe('report');
    for (const exception of shippedPolicy.licenses.componentExceptions ?? []) {
      expect(exception.reason.trim()).not.toBe('');
    }
  });

  it('matches the native SQLite identity emitted by the production SBOM builder', () => {
    const sbom = buildSbom({
      lock: readLock(),
      repoRoot,
      cargoMetadata: linkedNativeCargoMetadata('sqlite3'),
      features: ['sqlite'],
    });
    const sqlite = sbom.components.find(
      (component) =>
        component.properties.some(
          (property) =>
            property.name === 'printfarmer:ecosystem' &&
            property.value === 'native',
        ) && component.name === 'sqlite3',
    );
    const sqliteException = (
      shippedPolicy.licenses.componentExceptions ?? []
    ).find((exception) => exception.purl === 'pkg:generic/sqlite3');

    expect(sqlite).toMatchObject({
      purl: 'pkg:generic/sqlite3',
      'bom-ref': 'pkg:generic/sqlite3?vendored-by=libsqlite3-sys@0.30.1',
    });
    // Both operands below pass through optional chaining, so
    // `undefined === undefined` would go green if the shipped policy lost
    // its sqlite3 exception entirely. The `toMatchObject` above already
    // pins `sqlite?.purl` to a real string; this pins the other side so the
    // comparison cannot be satisfied by two absences.
    expect(sqliteException).toBeDefined();
    expect(sqliteException?.purl).toBe(sqlite?.purl);
    expect(
      evaluateLicensePolicy(sbom, shippedPolicy.licenses).violations,
    ).toEqual([]);
  });

  it.each([undefined, null, 'warn', 'REPORT'])(
    'rejects malformed runtime advisory enforcement %s',
    (enforcement) => {
      const advisories = {
        ...shippedPolicy.advisories,
        enforcement,
      };
      expect(() => advisoryEnforcement(advisories)).toThrow(
        'advisories.enforcement must be exactly "block" or "report"',
      );
      expect(() =>
        evaluateAdvisories({ advisories: [] }, advisories as AdvisoryPolicy),
      ).toThrow('advisories.enforcement must be exactly "block" or "report"');
      expect(() =>
        validateSupplyChainPolicy({
          ...shippedPolicy,
          advisories,
        }),
      ).toThrow('invalid supply-chain policy');
    },
  );

  it('rejects missing policy blocks and a renamed outbound key', () => {
    expect(() =>
      validateSupplyChainPolicy({ advisories: shippedPolicy.advisories }),
    ).toThrow('licenses must be an object');
    expect(() =>
      validateSupplyChainPolicy({ licenses: shippedPolicy.licenses }),
    ).toThrow('advisories must be an object');

    const withoutOutbound = { ...shippedPolicy.licenses };
    delete withoutOutbound.outbound;
    expect(() =>
      validateSupplyChainPolicy({
        ...shippedPolicy,
        licenses: {
          ...withoutOutbound,
          outboundLicense: packageManifest.license,
        },
      }),
    ).toThrow('licenses.outbound must be a non-empty string');
  });
});

describe('the release workflow enforces compliance before publication', () => {
  const lockGuard =
    'git diff --exit-code -- native/Cargo.lock package-lock.json';

  it('runs compliance before upload, then signs metadata before dependent publication', () => {
    const steps = parseWorkflowSteps(releaseWorkflow, 'make');
    const indexOfRun = (run: string): number =>
      steps.findIndex((step) => step.run === run);
    const indexOfName = (name: string): number =>
      steps.findIndex((step) => step.name === name);

    const make = steps.findIndex((step) =>
      step.run?.startsWith('npm run make'),
    );
    const compliance = [
      indexOfRun('npm run verify:sbom'),
      indexOfRun('npm run verify:licenses'),
      indexOfRun('npm run verify:notices'),
    ];
    const packaged = indexOfRun('node scripts/verify-packaged-sidecar.mjs');
    const immutableLocks = indexOfRun(lockGuard);
    const collect = indexOfName('Collect artifacts');
    const upload = indexOfName('Upload build artifacts');
    const ordered = [
      make,
      ...compliance,
      packaged,
      immutableLocks,
      collect,
      upload,
    ];

    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
    expect(steps[upload]?.uses).toBe('actions/upload-artifact@v4');
    for (const index of [...compliance, packaged, immutableLocks]) {
      expect(steps[index]?.continueOnError).not.toBe('true');
    }

    const publishSteps = parseWorkflowSteps(releaseWorkflow, 'publish');
    const download = publishSteps.findIndex(
      (step) => step.uses === 'actions/download-artifact@v4',
    );
    const metadata = publishSteps.findIndex(
      (step) => step.name === 'Generate signed update metadata',
    );
    const publish = publishSteps.findIndex(
      (step) => step.uses === 'softprops/action-gh-release@v2',
    );
    expect([download, metadata, publish].every((index) => index >= 0)).toBe(
      true,
    );
    expect([download, metadata, publish]).toEqual(
      [download, metadata, publish].toSorted((left, right) => left - right),
    );
    expect(releaseWorkflow).toMatch(
      / {2}publish:\r?\n(?:.*\r?\n)*? {4}needs: make/,
    );

    const commentedNotices = releaseWorkflow.replace(
      '        run: npm run verify:notices',
      '        # run: npm run verify:notices',
    );
    expect(
      parseWorkflowSteps(commentedNotices, 'make').some(
        (step) => step.run === 'npm run verify:notices',
      ),
    ).toBe(false);

    const commentedGuard = releaseWorkflow.replace(
      `        run: ${lockGuard}`,
      `        # run: ${lockGuard}`,
    );
    expect(
      parseWorkflowSteps(commentedGuard, 'make').some(
        (step) => step.run === lockGuard,
      ),
    ).toBe(false);
  });

  it('mirrors the lockfile guard before every packaged release suite in CI', () => {
    const steps = parseWorkflowSteps(ciWorkflow, 'package');
    const indexOfRun = (run: string): number =>
      steps.findIndex((step) => step.run === run);
    const indexOfName = (name: string): number =>
      steps.findIndex((step) => step.name === name);
    const immutableLocks = indexOfRun(lockGuard);
    const releaseSuites = [
      [
        'Packaged Electron end-to-end tests',
        'npx playwright test --grep-invert "@gpu|@a11y"',
      ],
      [
        'Packaged accessibility (material WCAG A/AA)',
        'npx playwright test e2e/release.accessibility.spec.ts',
      ],
      [
        'Packaged WebGL2 (host default capability report)',
        'npx playwright test e2e/release.gpu.spec.ts',
      ],
      [
        'Packaged WebGL2 (SwiftShader fallback)',
        'npx playwright test e2e/release.gpu.spec.ts',
      ],
    ] as const;
    const suiteIndexes = releaseSuites.map(([name, run]) => {
      const index = indexOfName(name);
      expect(steps[index]?.run).toBe(run);
      return index;
    });
    const ordered = [
      indexOfRun('npm run package'),
      indexOfRun('node scripts/verify-packaged-sidecar.mjs'),
      immutableLocks,
      ...suiteIndexes,
    ];

    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
    for (const index of [immutableLocks, ...suiteIndexes]) {
      expect(steps.at(index)?.continueOnError).not.toBe('true');
    }
  });

  it('locks every workspace Cargo command and detects a stripped flag', () => {
    const workflows = [
      { contents: ciWorkflow, jobs: ['sidecar', 'package'] },
      { contents: releaseWorkflow, jobs: ['make'] },
    ];
    // The helper enforces --locked; avoid a fixed count as legitimate commands evolve.
    const cargoCommands = requireLockedWorkspaceCargoCommands(workflows);
    expect(cargoCommands.length).toBeGreaterThan(0);

    const unlockedCi = ciWorkflow.replace(
      'run: cargo test --locked',
      'run: cargo test',
    );
    expect(() =>
      requireLockedWorkspaceCargoCommands([
        { contents: unlockedCi, jobs: ['sidecar', 'package'] },
        { contents: releaseWorkflow, jobs: ['make'] },
      ]),
    ).toThrow('workspace Cargo command is not locked: cargo test');
  });

  it('pins locked Cargo metadata and sidecar staging arguments', () => {
    expect(cargoMetadataArgs(['sqlite'], repoRoot)).toEqual([
      'metadata',
      '--format-version',
      '1',
      '--manifest-path',
      path.join(repoRoot, 'native', 'model-core', 'Cargo.toml'),
      '--locked',
      '--features',
      'sqlite',
    ]);
    expect(SIDECAR_BUILD_ARGS).toEqual([
      'build',
      '--locked',
      '--release',
      '-p',
      'model-core',
      '--features',
      'sqlite',
    ]);
  });
});

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
      '(MIT',
      'MIT)',
      '()',
      'MIT OR OR Apache-2.0',
      'MIT WITH',
      'MIT WITH OR',
      'MIT WITH MIT',
      'MIT WITH GPL-2.0-only',
      'MIT WITH NotAnSpdxException',
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

  it.each([
    ['missing', { allowed: licensePolicy.allowed, componentExceptions: [] }],
    [
      'renamed',
      {
        outboundLicense: 'AGPL-3.0-only',
        allowed: licensePolicy.allowed,
        componentExceptions: [],
      },
    ],
  ])('fails closed when outbound is %s', (_label, policy) => {
    const { violations } = evaluateLicensePolicy(
      sbomWith([comp('a', 'MIT')]),
      policy,
    );
    expect(violations).toContainEqual(
      expect.objectContaining({
        reason: 'policy',
        detail: 'licence policy is missing required non-empty "outbound"',
      }),
    );
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

describe('the advisory gate fails closed when npm SBOM coverage degrades', () => {
  it('requires the exact production and imported package identities, including Electron', () => {
    const sbom = buildSbom({
      lock: readLock(),
      repoRoot,
      cargoMetadata: linkedNativeCargoMetadata('sqlite3'),
      features: ['sqlite'],
    });
    const npmProductionTree = readNpmProductionTree(repoRoot);
    const importedComponents = readImportedNpmComponents(repoRoot);
    const coverage = evaluateNpmSbomCoverage(
      sbom,
      npmProductionTree,
      importedComponents,
    );

    expect(coverage).toMatchObject({
      complete: true,
      expectedCount: 8,
      actualCount: 8,
      missing: [],
      unexpected: [],
      duplicates: [],
      malformed: [],
      diagnostic: null,
    });

    const electron = sbom.components.find(
      (component) =>
        component.name === 'electron' &&
        component.properties.some(
          (property) =>
            property.name === 'printfarmer:ecosystem' &&
            property.value === 'npm',
        ),
    );
    expect(electron).toBeDefined();
    const degraded = {
      ...sbom,
      components: sbom.components.filter((component) => component !== electron),
    };
    const result = evaluateNpmSbomCoverage(
      degraded,
      npmProductionTree,
      importedComponents,
    );

    expect(result).toMatchObject({
      complete: false,
      expectedCount: 8,
      actualCount: 7,
      missing: [`electron@${electron?.version}`],
    });
    expect(() =>
      requireNpmSbomCoverage(degraded, npmProductionTree, importedComponents),
    ).toThrow('missing: electron@');
  });
});

describe('an unreadable npm tree is reported as an unreadable npm tree', () => {
  // #201: `npm ls` reported `parse-color` with no version after a failed
  // Windows install cleanup. The gate threw
  // `npm SBOM completeness check cannot identify npm ls package parse-color`,
  // so a reader's first two moves — inspect the package, inspect the SBOM —
  // were both wrong. Two lines earlier in the same step the SBOM had verified.
  //
  // Both sides are pushed here: an unreadable tree must classify as input, and
  // a real policy violation must NOT, or the flag distinguishes nothing.

  /** The shape npm emits for a package it can see but cannot version. */
  const treeWithVersionlessPackage = {
    name: 'printfarmer-desktop',
    version: '0.1.0-beta.2',
    dependencies: {
      react: { version: '18.3.1' },
      'parse-color': {},
    },
  };

  const readableTree = {
    name: 'printfarmer-desktop',
    version: '0.1.0-beta.2',
    dependencies: { react: { version: '18.3.1' } },
  };

  const sbomCovering = (identities: string[]): Sbom =>
    ({
      components: identities.map((identity) => {
        const at = identity.lastIndexOf('@');
        return {
          name: identity.slice(0, at),
          version: identity.slice(at + 1),
          properties: [
            { name: 'printfarmer:ecosystem', value: 'npm' },
            { name: 'printfarmer:shipped', value: 'true' },
          ],
        };
      }),
    }) as unknown as Sbom;

  const thrownBy = (run: () => unknown): Error => {
    try {
      run();
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected a throw, got none');
  };

  it('classifies a version-less package as unreadable input', () => {
    const error = thrownBy(() =>
      evaluateNpmSbomCoverage(sbomCovering([]), treeWithVersionlessPackage, []),
    );
    expect(error).toMatchObject({ unreadableInput: true });
  });

  it('does NOT classify a real coverage shortfall as unreadable input', () => {
    // The control. Without it, `unreadableInput: true` could be set on every
    // error and every assertion above would still pass.
    const error = thrownBy(() =>
      requireNpmSbomCoverage(sbomCovering([]), readableTree, []),
    );
    expect(error.message).toContain('missing: react@18.3.1');
    expect(error).not.toHaveProperty('unreadableInput');
  });

  it('does not describe an unreadable tree as a completeness check', () => {
    // The specific misattribution #201 was filed for.
    const error = thrownBy(() =>
      evaluateNpmSbomCoverage(sbomCovering([]), treeWithVersionlessPackage, []),
    );
    expect(error.message).not.toContain('completeness check');
  });

  it('still describes a real coverage shortfall as a completeness check', () => {
    // The other side: the wording change must be confined to the input failure.
    // If this also lost the phrase, the previous test would pass for the wrong
    // reason — the phrase having been deleted everywhere.
    const error = thrownBy(() =>
      requireNpmSbomCoverage(sbomCovering([]), readableTree, []),
    );
    expect(error.message).toContain('npm SBOM completeness check');
  });

  it('names the package npm could not describe, and the install as the suspect', () => {
    const error = thrownBy(() =>
      evaluateNpmSbomCoverage(sbomCovering([]), treeWithVersionlessPackage, []),
    );
    // The package name is evidence and stays. What changes is what the reader
    // is told to suspect because of it.
    expect(error.message).toContain('parse-color');
    expect(error.message).toContain('install');
    expect(error.message).toContain('not an SBOM policy violation');
  });

  it('classifies a tree npm produced nothing for', () => {
    const error = thrownBy(() =>
      evaluateNpmSbomCoverage(sbomCovering([]), undefined, []),
    );
    expect(error).toMatchObject({ unreadableInput: true });
    expect(error.message).not.toContain('completeness check');
  });

  it('classifies a dependency entry that is not an object', () => {
    // Note: the walk's own `!isRecord(node)` guard is unreachable — `walk` is
    // only ever called with a value already proven to be a record, by the tree
    // check above it or by the `isRecord(child)` check in the loop. It is left
    // in place as defensive depth; removing it is not this PR's business. A
    // non-record dependency is caught by the child check instead, and still
    // classifies as input rather than policy, which is the property that matters.
    const error = thrownBy(() =>
      evaluateNpmSbomCoverage(
        sbomCovering([]),
        { dependencies: { react: 'not-an-object' } },
        [],
      ),
    );
    expect(error).toMatchObject({ unreadableInput: true });
    expect(error.message).not.toContain('completeness check');
  });

  it('admits the legitimate maximum: a fully readable tree does not throw', () => {
    // A gate that only ever rejects proves nothing a reject-everything stub
    // would not also pass.
    expect(() =>
      evaluateNpmSbomCoverage(sbomCovering(['react@18.3.1']), readableTree, []),
    ).not.toThrow();
  });

  it('reads the real installed tree without classifying it as unreadable', () => {
    // Fixtures prove the walk; they cannot prove it matches what npm emits.
    // This is the only assertion here bound to real `npm ls` output.
    const coverage = evaluateNpmSbomCoverage(
      sbomCovering([]),
      readNpmProductionTree(repoRoot),
      [],
    );
    // Incomplete against a deliberately empty SBOM — but *readable*, which is
    // the distinction this suite exists to hold. A shortfall is returned, not
    // thrown; only unreadable input throws.
    expect(coverage.complete).toBe(false);
    expect(coverage.diagnostic).toContain('npm SBOM completeness check');
  });
});

describe('the advisory gate fails closed when Cargo SBOM coverage degrades', () => {
  const cargoPackages = [
    { name: 'quick-xml', version: '0.36.2' },
    ...Array.from({ length: 80 }, (_, index) => ({
      name: `crate-${String(index).padStart(2, '0')}`,
      version: '1.0.0',
    })),
  ];
  const excludedPackages = [
    { name: 'build-only', version: '1.0.0', kind: 'build' },
    { name: 'dev-only', version: '1.0.0', kind: 'dev' },
  ];
  const packageId = (pkg: { name: string; version: string }): string =>
    `registry+https://github.com/rust-lang/crates.io-index#${pkg.name}@${pkg.version}`;
  const rootId = 'path+file:///repo/native/model-core#0.1.0';
  const metadata = {
    packages: [
      { id: rootId, name: 'model-core', version: '0.1.0' },
      ...[...cargoPackages, ...excludedPackages].map((pkg) => ({
        ...pkg,
        id: packageId(pkg),
      })),
    ],
    resolve: {
      root: rootId,
      nodes: [
        {
          id: rootId,
          deps: [
            ...cargoPackages.map((pkg) => ({
              pkg: packageId(pkg),
              dep_kinds: [{ kind: null }],
            })),
            ...excludedPackages.map((pkg) => ({
              pkg: packageId(pkg),
              dep_kinds: [{ kind: pkg.kind }],
            })),
          ],
        },
        ...[...cargoPackages, ...excludedPackages].map((pkg) => ({
          id: packageId(pkg),
          deps: [],
        })),
      ],
    },
  };
  const fixedComponents = [
    ...Array.from({ length: 8 }, (_, index) =>
      comp(`npm-${index}`, 'MIT', 'npm'),
    ),
    comp('sqlite3', undefined, 'native'),
  ];
  const cargoComponents = cargoPackages.map((pkg) => ({
    ...comp(pkg.name, 'MIT', 'cargo'),
    version: pkg.version,
    'bom-ref': `pkg:cargo/${pkg.name}@${pkg.version}`,
  }));
  const withCargo = (components: SbomComponent[]): Sbom =>
    sbomWith([...fixedComponents, ...components]);

  it('accepts all 90 components when all 81 feature-resolved crates are present', () => {
    const sbom = withCargo([...cargoComponents].reverse());
    expect(sbom.components).toHaveLength(90);
    expect(evaluateCargoSbomCoverage(sbom, metadata)).toEqual({
      complete: true,
      expectedCount: 81,
      actualCount: 81,
      missing: [],
      unexpected: [],
      duplicates: [],
      malformed: [],
      diagnostic: null,
    });
  });

  it('rejects the near-complete 89/90 document and names quick-xml', () => {
    const sbom = withCargo(
      cargoComponents.filter((component) => component.name !== 'quick-xml'),
    );
    expect(sbom.components).toHaveLength(89);

    const result = evaluateCargoSbomCoverage(sbom, metadata);
    expect(result).toMatchObject({
      complete: false,
      expectedCount: 81,
      actualCount: 80,
      missing: ['quick-xml@0.36.2'],
    });
    const diagnostic =
      'cargo SBOM completeness check expected 81 feature-resolved shipped component(s) from cargo metadata but found 80; missing: quick-xml@0.36.2';
    expect(result.diagnostic).toBe(diagnostic);
    expect(() => requireCargoSbomCoverage(sbom, metadata)).toThrowError(
      diagnostic,
    );
  });

  it.each([
    ['one Cargo component', cargoComponents.slice(1, 2), 10, 1, 80],
    ['no Cargo components', [], 9, 0, 81],
  ])(
    'rejects a document with %s',
    (_label, degradedCargo, totalCount, actualCount, missingCount) => {
      const sbom = withCargo(degradedCargo);
      expect(sbom.components).toHaveLength(totalCount);

      const result = evaluateCargoSbomCoverage(sbom, metadata);
      expect(result.complete).toBe(false);
      expect(result.actualCount).toBe(actualCount);
      expect(result.missing).toHaveLength(missingCount);
      expect(result.missing).toContain('quick-xml@0.36.2');
      expect(result.diagnostic).toContain('cargo SBOM completeness check');
    },
  );
});

describe('advisories are scoped conservatively to the shipped closure', () => {
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

  it('keeps only the shipped Cargo version when one advisory affects two locked versions', () => {
    const item = (version: string) => ({
      advisory: {
        id: 'RUSTSEC-2026-0194',
        title: 'quick-xml',
        cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
      },
      package: { name: 'quick-xml', version },
      versions: { patched: ['>=0.37.5'], unaffected: [] },
    });
    const scoped = scopeToShippedClosure(
      normalizeCargoAudit({
        vulnerabilities: {
          list: [item('0.22.0'), item('0.36.2')],
        },
      }),
      ['quick-xml'],
      ['quick-xml@0.36.2'],
    );

    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({
      id: 'RUSTSEC-2026-0194',
      package: 'quick-xml',
      version: '0.36.2',
    });
    expect(
      evaluateAdvisories({ advisories: scoped }, advisoryPolicy).blocking,
    ).toHaveLength(1);
  });

  it('retains an npm advisory without a reliable version by package name', () => {
    const normalized = normalizeNpmAudit({
      vulnerabilities: {
        electron: {
          name: 'electron',
          severity: 'high',
          via: [
            {
              source: 1,
              name: 'electron',
              title: 'Shipped runtime advisory',
              url: 'https://github.com/advisories/GHSA-electron',
              severity: 'high',
            },
          ],
          fixAvailable: true,
        },
      },
    });
    expect(normalized[0]).not.toHaveProperty('version');
    expect(
      scopeToShippedClosure(normalized, ['electron'], ['electron@0.0.0']),
    ).toEqual(normalized);
  });

  it('audits the full npm graph, keeps shipped Electron, and drops dev-only tooling', () => {
    expect(packageManifest.dependencies).not.toHaveProperty('electron');
    expect(packageManifest.devDependencies).toHaveProperty('electron');
    expect(packageManifest.devDependencies).toHaveProperty('vitest');
    expect(NPM_AUDIT_ARGS).toEqual(['audit', '--json']);

    const { components } = deriveShippedNpmComponents(readLock(), repoRoot);
    const shippedNames = new Set(
      [...components.values()].map((component) => component.name),
    );
    expect(shippedNames).toContain('electron');
    expect(shippedNames).not.toContain('vitest');

    const normalized = normalizeNpmAudit({
      vulnerabilities: {
        electron: {
          name: 'electron',
          severity: 'high',
          via: [
            {
              source: 1,
              name: 'electron',
              title: 'Shipped runtime advisory',
              url: 'https://github.com/advisories/GHSA-electron',
              severity: 'high',
            },
          ],
          fixAvailable: true,
        },
        vitest: {
          name: 'vitest',
          severity: 'high',
          via: [
            {
              source: 2,
              name: 'vitest',
              title: 'Unshipped test-tool advisory',
              url: 'https://github.com/advisories/GHSA-vitest',
              severity: 'high',
            },
          ],
          fixAvailable: true,
        },
      },
    });
    const scoped = scopeToShippedClosure(normalized, shippedNames);

    expect(scoped.map((entry) => entry.package)).toEqual(['electron']);
    expect(scoped.map((entry) => entry.id)).toEqual(['GHSA-electron']);
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
        version: '0.22.0',
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
