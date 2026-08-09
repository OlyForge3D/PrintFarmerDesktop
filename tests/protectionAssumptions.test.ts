import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_COLLABORATORS,
  EXIT_SKIPPED_WITHOUT_CREDENTIALS_IN_CI,
  PRIVILEGED_ONLY_ASSUMPTIONS,
  REQUIRED_CONTEXT_NAMES,
  adminExemptibleSettingEnforcement,
  evaluatePublicProtectionAssumptions,
  evaluateProtectionAssumptions,
  fetchPrivilegedRepositoryFacts,
  fetchPublicRepositoryFacts,
  formatViolations,
  rulesetCoversFeatureBranches,
  statusCheckEnforcement,
} from '../scripts/check-protection-assumptions.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

// The baseline is the repository as measured on 2026-08-04T17:23 local, at the
// API rather than from #151's transcription -- which had already decayed:
// `rulesets` read `[]` in the issue and `1` on the wire one day later.
const baseline = () => ({
  protection: {
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_linear_history: { enabled: true },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: { required_approving_review_count: 0 },
    required_status_checks: {
      strict: true,
      contexts: [...REQUIRED_CONTEXT_NAMES],
    },
  },
  // The live ruleset: disabled, development-only, grants feature branches
  // nothing. Present in the baseline precisely so a passing run proves the
  // check tolerates it rather than never having seen one.
  rulesets: [
    {
      id: 20361532,
      name: 'development merge queue',
      target: 'branch',
      enforcement: 'disabled',
      conditions: { ref_name: { include: ['refs/heads/development'] } },
    },
  ],
  protectedBranches: ['development'],
  collaborators: [{ login: 'jpapiez', role: 'admin' }],
});

const assumptionsOf = (facts: ReturnType<typeof baseline>) =>
  evaluateProtectionAssumptions(facts).map((v) => v.assumption);

describe('the premises of #111 and #151 are checked, not promised', () => {
  it('passes against the repository as actually measured', () => {
    // If this ever fails, the baseline is stale, which is the whole point:
    // it fails loudly instead of the issue quietly ceasing to describe reality.
    expect(evaluateProtectionAssumptions(baseline())).toEqual([]);
  });

  it('refuses to report that assumptions hold when protection itself is null', () => {
    // A control that treats absent input as a pass is the failure this whole
    // file exists to catch. This covers only `protection: null` -- the
    // absent-individual-field cases below are a distinct seam and have their
    // own tests, because passing here proved nothing about them (#488).
    expect(() =>
      evaluateProtectionAssumptions({
        protection: null as unknown as Record<string, unknown>,
      }),
    ).toThrow(/refusing to report that assumptions hold/);
  });

  it('fires when allow_force_pushes is deleted, not just when it is true', () => {
    // #488: `node?.enabled === true` reads an absent node the same as
    // `{ enabled: false }` -- both are "not true". A deleted key must not
    // silently read as the safe, confirmed-false state.
    const facts = baseline();
    delete (facts.protection as Record<string, unknown>).allow_force_pushes;

    expect(assumptionsOf(facts)).toEqual(['development.allow_force_pushes']);
  });

  it('fires when allow_deletions is deleted, not just when it is true', () => {
    const facts = baseline();
    delete (facts.protection as Record<string, unknown>).allow_deletions;

    expect(assumptionsOf(facts)).toEqual(['development.allow_deletions']);
  });

  it('fires when required_linear_history is deleted', () => {
    // Per the issue's mutation table this one already detected deletion
    // correctly before the fix; pinned here so it stays true.
    const facts = baseline();
    delete (facts.protection as Record<string, unknown>)
      .required_linear_history;

    expect(assumptionsOf(facts)).toEqual([
      'development.required_linear_history',
    ]);
  });

  it('fires when enforce_admins is deleted, not just when it is true', () => {
    const facts = baseline();
    delete (facts.protection as Record<string, unknown>).enforce_admins;

    expect(assumptionsOf(facts)).toEqual(['development.enforce_admins']);
  });

  it('fires when required_pull_request_reviews is deleted, not just when the count is non-zero', () => {
    const facts = baseline();
    delete (facts.protection as Record<string, unknown>)
      .required_pull_request_reviews;

    expect(assumptionsOf(facts)).toEqual([
      'development.required_approving_review_count',
    ]);
  });

  it.each([
    ['allow_force_pushes', { enabled: true }],
    ['allow_deletions', { enabled: true }],
    ['required_linear_history', { enabled: false }],
    ['enforce_admins', { enabled: true }],
  ] as const)(
    'words an absent %s violation differently from its present-unsafe-value violation',
    (field, unsafeValue) => {
      // The acceptance test requires the two to be distinguishable, not merely
      // both non-empty, for every one of the five named fields (#488).
      const deletedFacts = baseline();
      delete (deletedFacts.protection as Record<string, unknown>)[field];
      const [deletedViolation] = evaluateProtectionAssumptions(deletedFacts);

      const unsafeFacts = baseline();
      (unsafeFacts.protection as Record<string, unknown>)[field] = unsafeValue;
      const [unsafeViolation] = evaluateProtectionAssumptions(unsafeFacts);

      expect(deletedViolation?.actual).not.toBe(unsafeViolation?.actual);
      expect(deletedViolation?.consequence).not.toBe(
        unsafeViolation?.consequence,
      );
    },
  );

  it('words an absent required_pull_request_reviews violation differently from its present-unsafe-value violation', () => {
    const deletedFacts = baseline();
    delete (deletedFacts.protection as Record<string, unknown>)
      .required_pull_request_reviews;
    const [deletedViolation] = evaluateProtectionAssumptions(deletedFacts);

    const unsafeFacts = baseline();
    unsafeFacts.protection.required_pull_request_reviews.required_approving_review_count = 1;
    const [unsafeViolation] = evaluateProtectionAssumptions(unsafeFacts);

    expect(deletedViolation?.actual).not.toBe(unsafeViolation?.actual);
    expect(deletedViolation?.consequence).not.toBe(
      unsafeViolation?.consequence,
    );
  });

  // #488, caught in review: a present-but-empty node (`{}`, missing the
  // `enabled` key entirely rather than the node itself being deleted or
  // `enabled: false`) is a different shape from both cases the tests above
  // cover, and it fell through the earlier fix silently -- the guard only
  // treated `undefined`/`null` nodes as unconfirmed, so `{}` read as "not
  // literally true" and produced no violation, exactly like a legitimate
  // `{ enabled: false }`. This is the same silent-false-safe hole #488 opened
  // with, one level deeper: it is not enough to check the node exists, the
  // node has to actually confirm `enabled` as a literal boolean.
  it.each([
    'allow_force_pushes',
    'allow_deletions',
    'required_linear_history',
    'enforce_admins',
  ] as const)(
    'fires when %s is present but malformed (an empty node, not absent or false)',
    (field) => {
      const facts = baseline();
      (facts.protection as Record<string, unknown>)[field] = {};

      expect(assumptionsOf(facts)).toEqual([`development.${field}`]);
    },
  );

  it('fires when required_pull_request_reviews is present but malformed (no required_approving_review_count)', () => {
    const facts = baseline();
    (
      facts.protection as unknown as Record<string, unknown>
    ).required_pull_request_reviews = {};

    expect(assumptionsOf(facts)).toEqual([
      'development.required_approving_review_count',
    ]);
  });

  it.each([
    'allow_force_pushes',
    'allow_deletions',
    'required_linear_history',
    'enforce_admins',
  ] as const)(
    'fires when %s has a non-boolean enabled value, not just true/false',
    (field) => {
      const facts = baseline();
      (facts.protection as Record<string, unknown>)[field] = {
        enabled: 'yes',
      };

      expect(assumptionsOf(facts)).toEqual([`development.${field}`]);
    },
  );

  it('fires when the trunk stops refusing force pushes', () => {
    const facts = baseline();
    facts.protection.allow_force_pushes = { enabled: true };

    expect(assumptionsOf(facts)).toEqual(['development.allow_force_pushes']);
  });

  it('fires when the trunk becomes deletable', () => {
    const facts = baseline();
    facts.protection.allow_deletions = { enabled: true };

    expect(assumptionsOf(facts)).toEqual(['development.allow_deletions']);
  });

  it('fires when linear history is no longer required', () => {
    const facts = baseline();
    facts.protection.required_linear_history = { enabled: false };

    expect(assumptionsOf(facts)).toEqual([
      'development.required_linear_history',
    ]);
  });

  it('fires when strict status checks are turned off', () => {
    const facts = baseline();
    facts.protection.required_status_checks.strict = false;

    expect(assumptionsOf(facts)).toEqual([
      'development.required_status_checks.strict',
    ]);
  });

  it('fires when a required context is swapped, not only when the count moves', () => {
    // Three sessions in one evening reported this set as seven, eight and nine
    // by counting rows in a check-run rollup. A count assertion cannot see a
    // one-for-one swap, and a swap is what silently drops a platform.
    const facts = baseline();
    facts.protection.required_status_checks.contexts = [
      ...REQUIRED_CONTEXT_NAMES.slice(1),
      'Desktop (ubuntu-latest)',
    ];

    expect(facts.protection.required_status_checks.contexts).toHaveLength(
      REQUIRED_CONTEXT_NAMES.length,
    );
    expect(assumptionsOf(facts)).toEqual([
      'development.required_status_checks.contexts',
    ]);
  });

  it('does not care what order the contexts arrive in', () => {
    const facts = baseline();
    facts.protection.required_status_checks.contexts = [
      ...REQUIRED_CONTEXT_NAMES,
    ].reverse();

    expect(evaluateProtectionAssumptions(facts)).toEqual([]);
  });
});

describe('the two decisions #111 took deliberately, and the trigger to revisit them', () => {
  it('flags enforce_admins turning on as a premise change, not as a misconfiguration', () => {
    const facts = baseline();
    facts.protection.enforce_admins = { enabled: true };

    const violations = evaluateProtectionAssumptions(facts);
    // Pinning the count too: reading [0] of a longer list would let an
    // unrelated second drift pass unnoticed.
    expect(violations).toHaveLength(1);
    const found = violations[0];
    expect(found?.assumption).toBe('development.enforce_admins');
    expect(found?.decision).toBe('#111');
    expect(found?.consequence).toMatch(/re-read together/);
  });

  it('flags a required approving review, which #111 declined as impossible', () => {
    const facts = baseline();
    facts.protection.required_pull_request_reviews.required_approving_review_count = 1;

    const violations = evaluateProtectionAssumptions(facts);
    // Pinning the count too: reading [0] of a longer list would let an
    // unrelated second drift pass unnoticed.
    expect(violations).toHaveLength(1);
    const found = violations[0];
    expect(found?.assumption).toBe(
      'development.required_approving_review_count',
    );
    expect(found?.consequence).toMatch(/self-approval/);
  });

  it('fires on a second collaborator, which is the trigger both issues name', () => {
    const facts = baseline();
    facts.collaborators = [
      { login: 'jpapiez', role: 'admin' },
      { login: 'ci-bot', role: 'write' },
    ];

    const violations = evaluateProtectionAssumptions(facts);
    // Pinning the count too: reading [0] of a longer list would let an
    // unrelated second drift pass unnoticed.
    expect(violations).toHaveLength(1);
    const found = violations[0];
    expect(found?.assumption).toBe('collaborators');
    expect(found?.consequence).toMatch(/REVISIT TRIGGER/);
  });

  it('fires when the sole collaborator stops being an admin', () => {
    // Same person, different role. A login-only comparison would miss this, and
    // the role is what makes enforce_admins: false the whole story.
    const facts = baseline();
    facts.collaborators = [{ login: 'jpapiez', role: 'write' }];

    expect(assumptionsOf(facts)).toEqual(['collaborators']);
  });

  it('fires when a branch other than development gains protection', () => {
    const facts = baseline();
    facts.protectedBranches = ['development', 'release/1.0'];

    expect(assumptionsOf(facts)).toEqual(['protected branches']);
  });
});

describe('strict status checks are present and bind nobody', () => {
  // Measured over the thirty most recently merged pull requests, by recency:
  //   up to date at merge  15 / 30
  //   merged behind base   15 / 30    worst #366, seventy commits behind
  // `strict: true` is live throughout. The assumption check above asserts it and
  // passes, and the consequence it names -- merging against an untested trunk --
  // happens in half of all merges regardless.
  it('reads the live pair as bypassable, not as protection', () => {
    const reading = statusCheckEnforcement(baseline().protection);
    expect(reading.state).toBe('bypassable');
    expect(reading.why).toMatch(/do not rely on/);
  });

  it('reads as binding only when administrators are not exempt', () => {
    const facts = baseline();
    facts.protection.enforce_admins = { enabled: true };
    expect(statusCheckEnforcement(facts.protection).state).toBe('binding');
  });

  it('separates "exempt from it" from "does not exist"', () => {
    // Both leave a PR able to merge against an untested base, and they have
    // different remedies -- one is a setting to turn on, the other is a person to
    // stop being an admin. Collapsing them would hide which.
    const facts = baseline();
    facts.protection.required_status_checks.strict = false;
    expect(statusCheckEnforcement(facts.protection).state).toBe('absent');
    expect(statusCheckEnforcement(undefined).state).toBe('absent');
  });

  it('is not satisfied by the assumption check, which passes on the same facts', () => {
    // The binding fact: these two disagree about the same repository. If someone
    // later decides `strict: true` is sufficient and deletes the reading above,
    // this fails rather than the suite silently agreeing with them.
    const facts = baseline();
    expect(evaluateProtectionAssumptions(facts)).toEqual([]);
    expect(statusCheckEnforcement(facts.protection).state).not.toBe('binding');
  });
});

describe('#489: the admin-exemption reading generalises beyond strict', () => {
  // `enforce_admins: false` exempts administrators from allow_force_pushes,
  // allow_deletions and required_linear_history exactly as it exempts them
  // from strict. #390 applied that insight to strict alone and asserted the
  // other three as if they bound the sole admin collaborator.
  it('reads allow_force_pushes as bypassable under the live facts, binding once enforce_admins is on', () => {
    const facts = baseline();
    expect(
      adminExemptibleSettingEnforcement(facts.protection).allow_force_pushes
        .state,
    ).toBe('bypassable');

    facts.protection.enforce_admins = { enabled: true };
    expect(
      adminExemptibleSettingEnforcement(facts.protection).allow_force_pushes
        .state,
    ).toBe('binding');
  });

  it('reads allow_deletions as bypassable under the live facts, binding once enforce_admins is on', () => {
    const facts = baseline();
    expect(
      adminExemptibleSettingEnforcement(facts.protection).allow_deletions.state,
    ).toBe('bypassable');

    facts.protection.enforce_admins = { enabled: true };
    expect(
      adminExemptibleSettingEnforcement(facts.protection).allow_deletions.state,
    ).toBe('binding');
  });

  it('reads required_linear_history as bypassable under the live facts, binding once enforce_admins is on', () => {
    const facts = baseline();
    expect(
      adminExemptibleSettingEnforcement(facts.protection)
        .required_linear_history.state,
    ).toBe('bypassable');

    facts.protection.enforce_admins = { enabled: true };
    expect(
      adminExemptibleSettingEnforcement(facts.protection)
        .required_linear_history.state,
    ).toBe('binding');
  });

  it('reads a setting as absent when it is not configured the protective way at all, regardless of enforce_admins', () => {
    const facts = baseline();
    facts.protection.allow_force_pushes = { enabled: true };
    facts.protection.allow_deletions = { enabled: true };
    facts.protection.required_linear_history = { enabled: false };

    const readings = adminExemptibleSettingEnforcement(facts.protection);
    expect(readings.allow_force_pushes.state).toBe('absent');
    expect(readings.allow_deletions.state).toBe('absent');
    expect(readings.required_linear_history.state).toBe('absent');
  });

  it('agrees with statusCheckEnforcement on strict, since the generalised reading wraps it rather than duplicating it', () => {
    const facts = baseline();
    expect(adminExemptibleSettingEnforcement(facts.protection).strict).toEqual(
      statusCheckEnforcement(facts.protection),
    );
  });

  // The defect #489 reports: the violation text for these three settings
  // described them as currently binding the sole admin, when the same
  // enforce_admins:false exemption that #390 named for strict applies to them
  // too. A violation fires only once the setting has drifted further than the
  // baseline, but its wording must not claim the pre-drift configuration was
  // a binding protection for the admin who is the only account able to push.
  it('never describes an admin-exemptible setting as currently binding in its violation text', () => {
    const bindingClaimPattern =
      /\bis (currently )?binding\b|\bcurrently binds\b|\bcurrently enforced for (every|the) admin/i;

    const forcePushFacts = baseline();
    forcePushFacts.protection.allow_force_pushes = { enabled: true };
    const forcePushViolation = evaluateProtectionAssumptions(
      forcePushFacts,
    ).find((v) => v.assumption === 'development.allow_force_pushes');
    expect(forcePushViolation?.consequence).toBeDefined();
    expect(forcePushViolation?.consequence).toMatch(/already exempt/);
    expect(forcePushViolation?.consequence).not.toMatch(bindingClaimPattern);

    const deletionFacts = baseline();
    deletionFacts.protection.allow_deletions = { enabled: true };
    const deletionViolation = evaluateProtectionAssumptions(deletionFacts).find(
      (v) => v.assumption === 'development.allow_deletions',
    );
    expect(deletionViolation?.consequence).toBeDefined();
    expect(deletionViolation?.consequence).toMatch(/already exempt/);
    expect(deletionViolation?.consequence).not.toMatch(bindingClaimPattern);

    const linearHistoryFacts = baseline();
    linearHistoryFacts.protection.required_linear_history = {
      enabled: false,
    };
    const linearHistoryViolation = evaluateProtectionAssumptions(
      linearHistoryFacts,
    ).find((v) => v.assumption === 'development.required_linear_history');
    expect(linearHistoryViolation?.consequence).toBeDefined();
    expect(linearHistoryViolation?.consequence).toMatch(/already exempt/);
    expect(linearHistoryViolation?.consequence).not.toMatch(
      bindingClaimPattern,
    );
  });

  // A regression test for a defect the fresh reviewer caught in this PR's
  // first pass: `adminExemptibleSettingEnforcement` narrated a missing or
  // malformed `{ enabled }` node as though GitHub had confirmed the explicit
  // unsafe value, rather than saying the field could not be confirmed at
  // all -- exactly the absent-vs-explicit-unsafe conflation #488 fixed for
  // the violation checks, reappearing in the enforcement-reporting path.
  it('reads a missing or malformed enabled node as unconfirmed, not as a confirmed unsafe value', () => {
    const missingFieldPattern = /missing or malformed/;
    const confirmedUnsafePattern = /is (confirmed )?enabled\b/;

    const missingEverything = adminExemptibleSettingEnforcement({
      enforce_admins: { enabled: false },
    });
    expect(missingEverything.allow_force_pushes.state).toBe('absent');
    expect(missingEverything.allow_force_pushes.why).toMatch(
      missingFieldPattern,
    );
    expect(missingEverything.allow_force_pushes.why).not.toMatch(
      confirmedUnsafePattern,
    );

    expect(missingEverything.allow_deletions.state).toBe('absent');
    expect(missingEverything.allow_deletions.why).toMatch(missingFieldPattern);
    expect(missingEverything.allow_deletions.why).not.toMatch(
      confirmedUnsafePattern,
    );

    expect(missingEverything.required_linear_history.state).toBe('absent');
    expect(missingEverything.required_linear_history.why).toMatch(
      missingFieldPattern,
    );

    // A malformed-but-present node (empty object, no `enabled` key) must read
    // the same as a fully absent one.
    const malformed = adminExemptibleSettingEnforcement({
      enforce_admins: { enabled: false },
      allow_force_pushes: {},
    });
    expect(malformed.allow_force_pushes.state).toBe('absent');
    expect(malformed.allow_force_pushes.why).toMatch(missingFieldPattern);

    // An explicitly confirmed unsafe value must still read distinctly from
    // the missing-field case, and its wording must say so is confirmed.
    const explicitlyUnsafe = adminExemptibleSettingEnforcement({
      enforce_admins: { enabled: false },
      allow_force_pushes: { enabled: true },
    });
    expect(explicitlyUnsafe.allow_force_pushes.state).toBe('absent');
    expect(explicitlyUnsafe.allow_force_pushes.why).toMatch(
      confirmedUnsafePattern,
    );
    expect(explicitlyUnsafe.allow_force_pushes.why).not.toMatch(
      missingFieldPattern,
    );
  });
});

describe('a ruleset matters only when it is enabled and reaches a feature branch', () => {
  it('ignores the live disabled development-only merge queue ruleset', () => {
    expect(rulesetCoversFeatureBranches(baseline().rulesets[0])).toBe(false);
  });

  it('ignores an active ruleset scoped to development alone', () => {
    expect(
      rulesetCoversFeatureBranches({
        enforcement: 'active',
        target: 'branch',
        conditions: { ref_name: { include: ['refs/heads/development'] } },
      }),
    ).toBe(false);
  });

  it('ignores a ruleset that is only evaluating, because dry-run grants nothing', () => {
    expect(
      rulesetCoversFeatureBranches({
        enforcement: 'evaluate',
        target: 'branch',
        conditions: { ref_name: { include: ['~ALL'] } },
      }),
    ).toBe(false);
  });

  it('reports an active ruleset that reaches feature branches as news', () => {
    const facts = baseline();
    facts.rulesets.push({
      id: 2,
      name: 'no force push anywhere',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~ALL'] } },
    });

    const violations = evaluateProtectionAssumptions(facts);
    // Pinning the count too: reading [0] of a longer list would let an
    // unrelated second drift pass unnoticed.
    expect(violations).toHaveLength(1);
    const found = violations[0];
    expect(found?.assumption).toBe('rulesets covering feature branches');
    // Phrased as something to confirm rather than to undo: it is what #151 asks
    // for, and the hazard is that it also blocks the legitimate repair that
    // `npm run push:force` exists to make safe.
    expect(found?.consequence).toMatch(/npm run push:force/);
  });

  it('survives a ruleset with no conditions at all', () => {
    expect(
      rulesetCoversFeatureBranches({
        enforcement: 'active',
        target: 'branch',
      }),
    ).toBe(false);
    expect(rulesetCoversFeatureBranches(null)).toBe(false);
  });
});

describe('the report names the decision, not just the drift', () => {
  it('prints expected, actual, the decision, and why it matters', () => {
    const facts = baseline();
    facts.protection.allow_force_pushes = { enabled: true };

    const rendered = formatViolations(evaluateProtectionAssumptions(facts));
    expect(rendered).toContain('development.allow_force_pushes');
    expect(rendered).toContain('expected: false');
    expect(rendered).toContain('actual:   true');
    expect(rendered).toContain('rests on: #81 / #149');
    expect(rendered).toContain('--no-verify');
  });

  it('reports every moved premise, not only the first', () => {
    const facts = baseline();
    facts.protection.allow_force_pushes = { enabled: true };
    facts.collaborators = [];

    expect(assumptionsOf(facts)).toEqual([
      'development.allow_force_pushes',
      'collaborators',
    ]);
  });

  it('pins the expected collaborator set so it cannot be widened silently', () => {
    expect(EXPECTED_COLLABORATORS).toEqual([
      { login: 'jpapiez', role: 'admin' },
    ]);
  });
});

// #491: two of the nine assumptions -- protected branches, and rulesets
// covering feature branches -- depend only on the two GitHub endpoints that
// return 200 to an unauthenticated request against this repository
// (`/rulesets`, `/branches?protected=true`; measured). The broader claim in
// scripts/check-script-reachability.mjs's old UNENFORCED_CHECKS entry --
// "every one of those endpoints needs admin scope" -- foreclosed running
// these two without ever needing a `protection` object at all.
// `evaluatePublicProtectionAssumptions` proves that by construction: it takes
// no `protection` parameter and cannot throw for lacking one.
describe('#491: the public tier needs no protection object at all', () => {
  const publicBaseline = () => ({
    rulesets: [
      {
        id: 20361532,
        name: 'development merge queue',
        target: 'branch',
        enforcement: 'disabled',
        conditions: { ref_name: { include: ['refs/heads/development'] } },
      },
    ],
    protectedBranches: ['development'],
  });

  it('passes against the public-tier baseline with no protection argument', () => {
    expect(evaluatePublicProtectionAssumptions(publicBaseline())).toEqual([]);
  });

  it('reports a moved protected-branches premise', () => {
    const facts = publicBaseline();
    facts.protectedBranches = ['development', 'feature/x'];

    const violations = evaluatePublicProtectionAssumptions(facts);
    expect(violations.map((v) => v.assumption)).toEqual(['protected branches']);
  });

  it('reports an enabled ruleset that now reaches a feature branch', () => {
    const facts = publicBaseline();
    facts.rulesets = [
      {
        id: 1,
        name: 'reaches everything',
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['refs/heads/feature/x'] } },
      },
    ];

    const violations = evaluatePublicProtectionAssumptions(facts);
    expect(violations.map((v) => v.assumption)).toEqual([
      'rulesets covering feature branches',
    ]);
  });

  it('defaults rulesets and protectedBranches to empty and still reports (nothing protected)', () => {
    const violations = evaluatePublicProtectionAssumptions({});
    expect(violations.map((v) => v.assumption)).toEqual(['protected branches']);
  });

  // Every assumption `evaluateProtectionAssumptions` checks that is NOT one of
  // the two public ones must be named in PRIVILEGED_ONLY_ASSUMPTIONS, so
  // main()'s no-token path never silently omits one from its
  // not-checked-no-scope report.
  it('names every non-public assumption the full evaluator checks', () => {
    const facts = baseline();
    facts.protection.allow_force_pushes = { enabled: true };
    facts.protection.allow_deletions = { enabled: true };
    facts.protection.required_linear_history = { enabled: false };
    facts.protection.enforce_admins = { enabled: true };
    facts.protection.required_pull_request_reviews.required_approving_review_count = 1;
    facts.protection.required_status_checks.strict = false;
    facts.protection.required_status_checks.contexts = [];
    facts.collaborators = [];

    const fullAssumptions = new Set(assumptionsOf(facts));
    for (const assumption of PRIVILEGED_ONLY_ASSUMPTIONS) {
      expect(
        fullAssumptions.has(assumption),
        `${assumption} is listed as privileged-only but the full evaluator never raises it`,
      ).toBe(true);
    }
    // And the inverse: no assumption the full evaluator raised here (other
    // than the two public ones, untouched by this fixture) is missing from
    // the privileged list.
    for (const assumption of fullAssumptions) {
      expect(
        PRIVILEGED_ONLY_ASSUMPTIONS.includes(assumption),
        `${assumption} was raised by the full evaluator but is not in PRIVILEGED_ONLY_ASSUMPTIONS`,
      ).toBe(true);
    }
  });
});

// #491: `fetchPublicRepositoryFacts` must reproduce the "unauthenticated"
// half of the measurement -- no authorization header at all, not merely no
// token variable in scope -- and `fetchPrivilegedRepositoryFacts` must
// forward whatever token it is given. Both proven with an injected stub
// rather than a live network call.
describe('#491: fetchPublicRepositoryFacts sends no credential', () => {
  it('requests only the two public endpoints and no authorization header', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const body = url.includes('/rulesets') ? [] : [{ name: 'development' }];
      return { ok: true, json: async () => body } as Response;
    };

    const facts = await fetchPublicRepositoryFacts({
      repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
      fetchImpl,
    });

    expect(facts).toEqual({ rulesets: [], protectedBranches: ['development'] });
    expect(calls).toHaveLength(2);
    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.endsWith('/rulesets'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/branches?protected=true'))).toBe(true);
    for (const call of calls) {
      expect(
        Object.keys(call.headers).some((h) => h.toLowerCase() === 'authorization'),
        'a public-tier request must carry no authorization header at all',
      ).toBe(false);
    }
  });

  it('surfaces a non-ok response as a thrown error', async () => {
    const fetchImpl = async () =>
      ({ ok: false, status: 404, statusText: 'Not Found' }) as Response;

    await expect(
      fetchPublicRepositoryFacts({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        fetchImpl,
      }),
    ).rejects.toThrow(/404/);
  });
});

describe('#491: fetchPrivilegedRepositoryFacts requires and forwards a token', () => {
  it('requests the two privileged endpoints with the given token', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const body = url.includes('/collaborators')
        ? [{ login: 'jpapiez', role_name: 'admin' }]
        : { enforce_admins: { enabled: false } };
      return { ok: true, json: async () => body } as Response;
    };

    const facts = await fetchPrivilegedRepositoryFacts({
      repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
      token: 'a-token',
      fetchImpl,
    });

    expect(facts.collaborators).toEqual([{ login: 'jpapiez', role: 'admin' }]);
    expect(facts.protection).toEqual({ enforce_admins: { enabled: false } });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const authHeader = Object.entries(call.headers).find(
        ([key]) => key.toLowerCase() === 'authorization',
      );
      expect(authHeader, 'a privileged-tier request must carry the given token').toBeTruthy();
      expect(authHeader?.[1]).toContain('a-token');
    }
  });
});

/**
 * #492: a credential-less run degrades to a skip, which is correct for a
 * human at a keyboard reading the printed explanation and wrong for CI, whose
 * only channel is the exit code. Running the script as a subprocess is the
 * only way to reach `main()` under both env shapes without also reaching the
 * network -- both cases below return on the skip path before any fetch.
 *
 * `SKIP_CREDENTIAL_DISCOVERY` forces the absence explicit rather than ambient,
 * the same reasoning tests/mergeQueueReadiness.test.ts records for the
 * sibling script: on a machine where `gh` is already logged in, merely
 * clearing the four GITHUB/GH token and repository variables would not stop
 * `discoverToken`
 * from finding a real credential and taking the other branch entirely.
 */
describe('a credential-less run cannot report green inside CI (#492)', () => {
  const runOffline = (env: Record<string, string>) =>
    execFileSync(
      process.execPath,
      [
        path.join(
          repositoryRoot,
          'scripts',
          'check-protection-assumptions.mjs',
        ),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_TOKEN: '',
          GH_TOKEN: '',
          GITHUB_REPOSITORY: '',
          GITHUB_REPOSITORY_OWNER: '',
          SKIP_CREDENTIAL_DISCOVERY: '1',
          CI: '',
          ...env,
        },
      },
    );

  it('exits 0 for an interactive local run with no CI env var', () => {
    const output = runOffline({});
    expect(output).toContain('Skipped the assumption check');
  });

  it('exits non-zero, on the reserved code, when CI is set', () => {
    let status: number | null = null;
    try {
      runOffline({ CI: 'true' });
    } catch (error) {
      status = (error as { status: number | null }).status;
    }
    expect(status).toBe(EXIT_SKIPPED_WITHOUT_CREDENTIALS_IN_CI);
  });

  it('prints the identical diagnostic text whether or not CI is set', () => {
    const local = runOffline({});
    let inCi = '';
    try {
      runOffline({ CI: 'true' });
    } catch (error) {
      inCi = (error as { stdout: string }).stdout;
    }
    expect(inCi).toBe(local);
    expect(inCi).not.toBe('');
  });
});
