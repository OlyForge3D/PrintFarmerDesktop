import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
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
  formatMergedAgainstBaseReading,
  formatViolations,
  measureMergedAgainstBase,
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
    // These stubs are only ever invoked with a string URL by the code under
    // test, never a URL or Request object, so the cast (rather than a
    // default `String(input)` toString call, flagged by no-base-to-string)
    // is safe here.
    const fetchImpl: typeof fetch = (input, init) => {
      const url = input as string;
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const body = url.includes('/rulesets') ? [] : [{ name: 'development' }];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
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
        Object.keys(call.headers).some(
          (h) => h.toLowerCase() === 'authorization',
        ),
        'a public-tier request must carry no authorization header at all',
      ).toBe(false);
    }
  });

  it('surfaces a non-ok response as a thrown error', async () => {
    const fetchImpl = () =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

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
    // Same rationale as the public-tier stub above: only ever called with a
    // string URL here, so a direct cast avoids no-base-to-string.
    const fetchImpl: typeof fetch = (input, init) => {
      const url = input as string;
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const body = url.includes('/collaborators')
        ? [{ login: 'jpapiez', role_name: 'admin' }]
        : { enforce_admins: { enabled: false } };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
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
      expect(
        authHeader,
        'a privileged-tier request must carry the given token',
      ).toBeTruthy();
      expect(authHeader?.[1]).toContain('a-token');
    }
  });
});

// #491's acceptance test names four HTTP codes explicitly and requires that
// "the four HTTP codes above are reproduced by a test so the scope claim
// cannot drift again." Every test above proves the code's *logic* is right
// given some facts; none of them proves GitHub's API still answers the way
// the exemption's rewritten justification assumes. A stubbed fetchImpl can
// only ever agree with itself. This suite makes a real, unauthenticated
// request to each of the four endpoints against this repository and pins
// the status GitHub actually returns, so a change on GitHub's side (the
// repository going private, a public endpoint starting to require auth,
// etc.) fails this suite instead of silently invalidating the public tier.
describe('#491: the four unauthenticated endpoint codes this exemption depends on', () => {
  const REPOSITORY_PATH = 'repos/OlyForge3D/PrintFarmerDesktop';

  const ENDPOINT_EXPECTATIONS = [
    {
      path: `/${REPOSITORY_PATH}/branches/development/protection`,
      expectedStatus: 401,
    },
    { path: `/${REPOSITORY_PATH}/rulesets`, expectedStatus: 200 },
    {
      path: `/${REPOSITORY_PATH}/branches?protected=true`,
      expectedStatus: 200,
    },
    { path: `/${REPOSITORY_PATH}/collaborators`, expectedStatus: 401 },
  ] as const;

  it.for(ENDPOINT_EXPECTATIONS)(
    'reads $path unauthenticated as HTTP $expectedStatus',
    { timeout: 15_000 },
    async ({ path, expectedStatus }, ctx) => {
      const url = `https://api.github.com${path}`;
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('timed out after 10000ms')), 10_000);
      });
      let response: Response;
      try {
        response = await Promise.race([
          fetch(url, { headers: { accept: 'application/vnd.github+json' } }),
          timeout,
        ]);
      } catch (error) {
        // A network failure here is evidence about this environment (no
        // egress, DNS unavailable, offline sandbox), not evidence that
        // #491's scope claim has drifted -- there is nothing to assert
        // against. Use ctx.skip() (not a bare `return`) so Vitest reports
        // this as SKIPPED rather than a silent pass -- CI must never look
        // green without ever having exercised the assertion below.
        console.warn(
          `#491: could not reach ${url} to pin its unauthenticated status (${String(error)})`,
        );
        ctx.skip();
        return;
      }

      if (
        response.status === 403 &&
        response.headers.get('x-ratelimit-remaining') === '0'
      ) {
        // An unauthenticated caller shares GitHub's per-IP rate limit with
        // everything else on that IP. Exhausting it is a property of the
        // runner, not of #491's claim, so it is reported as SKIPPED rather
        // than asserted against or silently passed.
        console.warn(
          `#491: unauthenticated rate limit exhausted while checking ${url}`,
        );
        ctx.skip();
        return;
      }

      expect(
        response.status,
        `${url} returned HTTP ${response.status}, not the ${expectedStatus} #491's public/privileged split depends on`,
      ).toBe(expectedStatus);
    },
  );
});

describe('measureMergedAgainstBase (#490: derived, not transcribed)', () => {
  const repository = { owner: 'o', repo: 'r' };

  // Builds a fetchImpl that answers exactly the endpoints
  // fetchRecentlyMergedPullRequests / measureMergedAgainstBase issue:
  //   GET /pulls?state=closed&base=...&per_page=...&page=N&...  (PR pages)
  //   GET /commits/{sha}                                        (merge commit parents)
  //   GET /compare/{head}...{parent}                             (ahead_by)
  function fakeApi({
    pages, // array of PR-list pages; [] after the last one
    parents, // { [mergeCommitSha]: [parentSha, ...] }
    aheadBy, // { [`${head}...${parent}`]: number }
  }: {
    pages: Array<Array<Record<string, unknown>>>;
    parents: Record<string, string[]>;
    aheadBy: Record<string, number>;
  }) {
    return vi.fn((url: string) => {
      const u = new URL(url);
      const path = u.pathname;
      let body: unknown;

      if (path.endsWith('/pulls')) {
        const page = Number(u.searchParams.get('page') ?? '1');
        body = pages[page - 1] ?? [];
      } else if (path.includes('/commits/')) {
        const sha = path.split('/commits/')[1] ?? '';
        body = { parents: (parents[sha] ?? []).map((p) => ({ sha: p })) };
      } else if (path.includes('/compare/')) {
        const key = path.split('/compare/')[1] ?? '';
        body = { ahead_by: aheadBy[key] ?? 0 };
      } else {
        throw new Error(`fakeApi: unexpected endpoint ${path}`);
      }

      return { ok: true, json: () => body };
    }) as unknown as typeof fetch;
  }

  it('counts a PR as up to date when the merge-commit parent is already reachable from its head', async () => {
    const fetchImpl = fakeApi({
      pages: [
        [
          {
            number: 701,
            merged_at: '2026-08-09T10:00:00Z',
            merge_commit_sha: 'merge701',
            head: { sha: 'head701' },
          },
        ],
        [],
      ],
      parents: { merge701: ['parent701'] },
      aheadBy: { 'head701...parent701': 0 },
    });

    const reading = await measureMergedAgainstBase({
      repository,
      token: 't',
      fetchImpl,
      sampleSize: 30,
    });

    expect(reading).toEqual({
      requested: 1,
      sampled: 1,
      upToDate: 1,
      behind: 0,
      unmeasured: 0,
      worst: null,
    });
  });

  it('counts a PR as behind by exactly ahead_by commits, and tracks the worst one', async () => {
    const fetchImpl = fakeApi({
      pages: [
        [
          {
            number: 669,
            merged_at: '2026-08-09T09:00:00Z',
            merge_commit_sha: 'merge669',
            head: { sha: 'head669' },
          },
          {
            number: 667,
            merged_at: '2026-08-09T08:00:00Z',
            merge_commit_sha: 'merge667',
            head: { sha: 'head667' },
          },
          {
            number: 664,
            merged_at: '2026-08-09T07:00:00Z',
            merge_commit_sha: 'merge664',
            head: { sha: 'head664' },
          },
        ],
        [],
      ],
      parents: {
        merge669: ['parent669'],
        merge667: ['parent667'],
        merge664: ['parent664'],
      },
      aheadBy: {
        'head669...parent669': 3,
        'head667...parent667': 2,
        'head664...parent664': 1,
      },
    });

    const reading = await measureMergedAgainstBase({
      repository,
      token: 't',
      fetchImpl,
      sampleSize: 30,
    });

    expect(reading).toEqual({
      requested: 3,
      sampled: 3,
      upToDate: 0,
      behind: 3,
      unmeasured: 0,
      worst: { number: 669, commits: 3 },
    });
  });

  it('sorts by merged_at rather than trusting list order, and truncates to sampleSize', async () => {
    // Deliberately out of order: the API's own `sort=updated` is not the same
    // axis as merge recency, so trusting arrival order here would silently
    // reintroduce an unverified reading.
    const fetchImpl = fakeApi({
      pages: [
        [
          {
            number: 1,
            merged_at: '2026-08-01T00:00:00Z',
            merge_commit_sha: 'm1',
            head: { sha: 'h1' },
          },
          {
            number: 3,
            merged_at: '2026-08-03T00:00:00Z',
            merge_commit_sha: 'm3',
            head: { sha: 'h3' },
          },
          {
            number: 2,
            merged_at: '2026-08-02T00:00:00Z',
            merge_commit_sha: 'm2',
            head: { sha: 'h2' },
          },
        ],
        [],
      ],
      parents: { m1: ['p1'], m2: ['p2'], m3: ['p3'] },
      aheadBy: {
        'h1...p1': 0,
        'h2...p2': 0,
        'h3...p3': 0,
      },
    });

    const reading = await measureMergedAgainstBase({
      repository,
      token: 't',
      fetchImpl,
      sampleSize: 2,
    });

    // Only the two most recently merged (#3, #2) should be sampled -- #1 is
    // excluded by sampleSize despite appearing first in the page.
    expect(reading.sampled).toBe(2);
    expect(reading.upToDate).toBe(2);
  });

  it('excludes a merged PR with no merge_commit_sha or head sha from the split, and counts it as unmeasured rather than dropping it silently', async () => {
    const fetchImpl = fakeApi({
      pages: [
        [
          {
            number: 9,
            merged_at: '2026-08-09T00:00:00Z',
            merge_commit_sha: null,
            head: { sha: 'h9' },
          },
        ],
        [],
      ],
      parents: {},
      aheadBy: {},
    });

    const reading = await measureMergedAgainstBase({
      repository,
      token: 't',
      fetchImpl,
      sampleSize: 30,
    });

    expect(reading).toEqual({
      requested: 1,
      sampled: 0,
      upToDate: 0,
      behind: 0,
      unmeasured: 1,
      worst: null,
    });
  });

  // Hicks' finding on review of #490 (head 417a712): a PR that could not be
  // measured (missing merge data, or an unresolvable merge-commit parent)
  // was silently excluded from `sampled`, and formatMergedAgainstBaseReading
  // then reported the shrunk subset as though it were the whole requested
  // sample -- e.g. 30 requested, 3 silently unmeasurable, printed as
  // "27 / 27 clean" with no surfaced unknowns. That is the same "real gap
  // becomes an artificially clean result" failure as the maxPages and
  // ahead_by bugs, one function further down. Here two of three sampled PRs
  // are unmeasurable for different reasons (no merge_commit_sha; a merge
  // commit with no resolvable parent) and the third is genuinely up to
  // date -- asserting the reading names all three counts distinctly, and
  // that the formatted text always surfaces the unmeasured count rather
  // than letting a reader see a clean split without it.
  it('surfaces unmeasurable PRs as a distinct count rather than silently shrinking the sample (Hicks repro)', async () => {
    const fetchImpl = fakeApi({
      pages: [
        [
          // No merge_commit_sha at all.
          {
            number: 501,
            merged_at: '2026-08-03T00:00:00Z',
            merge_commit_sha: null,
            head: { sha: 'h501' },
          },
          // Merge commit resolves but has no parents.
          {
            number: 502,
            merged_at: '2026-08-02T00:00:00Z',
            merge_commit_sha: 'm502',
            head: { sha: 'h502' },
          },
          // Genuinely measurable and up to date.
          {
            number: 503,
            merged_at: '2026-08-01T00:00:00Z',
            merge_commit_sha: 'm503',
            head: { sha: 'h503' },
          },
        ],
        [],
      ],
      parents: { m502: [], m503: ['p503'] },
      aheadBy: { 'h503...p503': 0 },
    });

    const reading = await measureMergedAgainstBase({
      repository,
      token: 't',
      fetchImpl,
      sampleSize: 30,
    });

    expect(reading).toEqual({
      requested: 3,
      sampled: 1,
      upToDate: 1,
      behind: 0,
      unmeasured: 2,
      worst: null,
    });

    const text = formatMergedAgainstBaseReading(reading);
    expect(text).toContain('2 of 3 could not be measured');
    expect(text).toContain('1 / 1 measured');
  });

  // Hicks' finding on review of #490 (head 85d5148): `comparison.ahead_by ?? 0`
  // silently treated a missing or malformed `ahead_by` as "0 behind" -- up to
  // date -- rather than as a failure to measure. Hicks reproduced this with a
  // merged PR, a valid parent, and an empty `{}` compare response, which
  // previously produced `{"sampled":1,"upToDate":1,"behind":0,"worst":null}`
  // instead of failing. This constructs that exact response directly (rather
  // than through fakeApi's aheadBy map, which always supplies the field) and
  // asserts the measurement throws instead of silently reporting the PR as
  // up to date.
  it('throws rather than silently treating a compare response with no ahead_by as up to date (Hicks repro)', async () => {
    const fetchImpl = vi.fn((url: string) => {
      const path = new URL(url).pathname;
      let body: unknown;
      if (path.endsWith('/pulls')) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        body =
          page === 1
            ? [
                {
                  number: 400,
                  merged_at: '2026-08-01T00:00:00Z',
                  merge_commit_sha: 'm400',
                  head: { sha: 'h400' },
                },
              ]
            : [];
      } else if (path.includes('/commits/')) {
        body = { parents: [{ sha: 'p400' }] };
      } else if (path.includes('/compare/')) {
        // No `ahead_by` at all -- the exact shape Hicks reproduced.
        body = {};
      } else {
        throw new Error(`unexpected endpoint ${path}`);
      }
      return { ok: true, json: () => body };
    }) as unknown as typeof fetch;

    await expect(
      measureMergedAgainstBase({
        repository,
        token: 't',
        fetchImpl,
        sampleSize: 1,
      }),
    ).rejects.toThrow(/ahead_by/i);
  });

  // Both Hicks and Vasquez independently reproduced this in review of #490
  // (head 9ef8526): the `ahead_by` validation checked `typeof === 'number'`
  // only, which accepts -1, NaN, and Infinity -- all numbers in JS, none of
  // them a sensible count of commits. -1 would still count as "behind"
  // (fails the `=== 0` up-to-date check) and could become `worst` with a
  // nonsensical negative commit count; NaN fails every `>` comparison
  // silently, so it is counted as behind yet can never become `worst` no
  // matter how many other PRs are compared against it; Infinity would
  // always win `worst` regardless of any genuinely worse finite offender.
  // Vasquez separately reproduced this again on head 2f65da1 for a
  // fractional value (`0.5`): finite and non-negative, but not a sensible
  // count of commits either -- `ahead_by` must be an integer.
  // Each must throw exactly like a missing/non-numeric ahead_by does.
  it.each([
    ['a negative number', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a fractional number', 0.5],
  ])(
    'throws rather than silently accepting %s as ahead_by (Hicks/Vasquez repro)',
    async (_label, aheadBy) => {
      const fetchImpl = vi.fn((url: string) => {
        const path = new URL(url).pathname;
        let body: unknown;
        if (path.endsWith('/pulls')) {
          const page = Number(new URL(url).searchParams.get('page') ?? '1');
          body =
            page === 1
              ? [
                  {
                    number: 401,
                    merged_at: '2026-08-01T00:00:00Z',
                    merge_commit_sha: 'm401',
                    head: { sha: 'h401' },
                  },
                ]
              : [];
        } else if (path.includes('/commits/')) {
          body = { parents: [{ sha: 'p401' }] };
        } else if (path.includes('/compare/')) {
          body = { ahead_by: aheadBy };
        } else {
          throw new Error(`unexpected endpoint ${path}`);
        }
        return { ok: true, json: () => body };
      }) as unknown as typeof fetch;

      await expect(
        measureMergedAgainstBase({
          repository,
          token: 't',
          fetchImpl,
          sampleSize: 1,
        }),
      ).rejects.toThrow(/ahead_by/i);
    },
  );

  // Vasquez's finding on review of #490 (head 2f65da1): sorting used
  // `Date.parse(pr.merged_at)` directly. A truthy but unparseable
  // `merged_at` parses to NaN, and `Array.prototype.sort`'s comparator
  // treats NaN as neither greater nor less than anything -- silently
  // collapsing the sort to whatever order the API happened to return
  // instead of true merge-time order, which is the same unsound-ordering
  // defect already fixed once for `sort=updated` trust. Must throw instead.
  it('throws rather than silently sorting by an unparseable merged_at (Vasquez repro)', async () => {
    const fetchImpl = vi.fn((url: string) => {
      const path = new URL(url).pathname;
      let body: unknown;
      if (path.endsWith('/pulls')) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        body =
          page === 1
            ? [
                {
                  number: 501,
                  merged_at: 'not-a-date',
                  merge_commit_sha: 'm501',
                  head: { sha: 'h501' },
                },
              ]
            : [];
      } else {
        throw new Error(`unexpected endpoint ${path}`);
      }
      return { ok: true, json: () => body };
    }) as unknown as typeof fetch;

    await expect(
      measureMergedAgainstBase({
        repository,
        token: 't',
        fetchImpl,
        sampleSize: 1,
      }),
    ).rejects.toThrow(/merged_at/i);
  });

  // Hicks' finding on review of #490 (head e5d6248): `merged_at: null` is
  // the API's well-formed signal for "not merged" and is legitimate to skip
  // silently, but a bare `if (!pr.merged_at) continue;` treated *any* falsy
  // value the same way -- including an empty string, which is not what the
  // API uses to mean "not merged". Hicks reproduced this concretely: a
  // merged PR entry with `merged_at: ''` was silently excluded from the
  // sample (measureMergedAgainstBase returned `requested: 0`) instead of
  // throwing on malformed data. Only null/undefined may mean "not merged";
  // any other falsy merged_at must throw.
  it('throws rather than silently dropping a PR with merged_at: "" from the sample (Hicks repro)', async () => {
    const fetchImpl = vi.fn((url: string) => {
      const path = new URL(url).pathname;
      let body: unknown;
      if (path.endsWith('/pulls')) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        body =
          page === 1
            ? [
                {
                  number: 701,
                  merged_at: '',
                  merge_commit_sha: 'm701',
                  head: { sha: 'h701' },
                },
              ]
            : [];
      } else {
        throw new Error(`unexpected endpoint ${path}`);
      }
      return { ok: true, json: () => body };
    }) as unknown as typeof fetch;

    await expect(
      measureMergedAgainstBase({
        repository,
        token: 't',
        fetchImpl,
        sampleSize: 1,
      }),
    ).rejects.toThrow(/merged_at/i);
  });

  // Hicks' finding on review of #490 (head 28051c3): fetchRecentlyMergedPullRequests
  // never validated the shape of the /pulls response before iterating it.
  // A malformed 200 OK body that is a string rather than an array is still
  // iterable in JS (strings are iterable), so each "pr" would be a single
  // character with no merged_at -- silently skipped -- and a "batch"
  // shorter than perPage would look like the genuine last page, producing
  // an empty, plausible-looking sample (requested: 0) instead of an error.
  // Hicks reproduced this concretely with a /pulls response body of "oops".
  it('throws rather than silently treating a non-array /pulls response as an empty page (Hicks repro)', async () => {
    const fetchImpl = vi.fn((url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/pulls')) {
        return { ok: true, json: () => 'oops' };
      }
      throw new Error(`unexpected endpoint ${path}`);
    }) as unknown as typeof fetch;

    await expect(
      measureMergedAgainstBase({
        repository,
        token: 't',
        fetchImpl,
        sampleSize: 1,
      }),
    ).rejects.toThrow(/array/i);
  });

  // Vasquez's finding on review of #490 (head e0487ac): `pr.number` was
  // used verbatim as the "worst offender" identifier and in error messages
  // without ever being validated. Malformed API data (missing or
  // non-numeric `number`) would silently produce a nonsensical identifier
  // like `#undefined` or `#NaN` instead of failing loud -- the same bug
  // class already fixed for `ahead_by` and `merged_at`, just on a different
  // field.
  it.each([
    ['missing', undefined],
    ['a string', 'oops'],
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
  ])(
    'throws rather than silently trusting %s as a pull request number (Vasquez repro)',
    async (_label, prNumber) => {
      const fetchImpl = vi.fn((url: string) => {
        const path = new URL(url).pathname;
        let body: unknown;
        if (path.endsWith('/pulls')) {
          const page = Number(new URL(url).searchParams.get('page') ?? '1');
          body =
            page === 1
              ? [
                  {
                    number: prNumber,
                    merged_at: '2026-08-01T00:00:00Z',
                    merge_commit_sha: 'm601',
                    head: { sha: 'h601' },
                  },
                ]
              : [];
        } else {
          throw new Error(`unexpected endpoint ${path}`);
        }
        return { ok: true, json: () => body };
      }) as unknown as typeof fetch;

      await expect(
        measureMergedAgainstBase({
          repository,
          token: 't',
          fetchImpl,
          sampleSize: 1,
        }),
      ).rejects.toThrow(/number/i);
    },
  );

  it('paginates across closed-PR pages until sampleSize merged PRs are found', async () => {
    const fetchImpl = fakeApi({
      pages: [
        // Page 1 (perPage: 1, so this one-item page is a FULL page and must
        // not be mistaken for the last one): one closed-but-unmerged PR,
        // contributes nothing to the merged sample.
        [{ number: 10, merged_at: null }],
        // Page 2 (also full at perPage: 1): the one merged PR.
        [
          {
            number: 11,
            merged_at: '2026-08-09T00:00:00Z',
            merge_commit_sha: 'm11',
            head: { sha: 'h11' },
          },
        ],
        // Page 3: empty -- the genuine last page, which is what must stop
        // pagination, not having already found `sampleSize` merged PRs.
        [],
      ],
      parents: { m11: ['p11'] },
      aheadBy: { 'h11...p11': 0 },
    });

    const reading = await measureMergedAgainstBase({
      repository,
      token: 't',
      fetchImpl,
      sampleSize: 1,
      perPage: 1,
    });

    expect(reading.sampled).toBe(1);
    expect(reading.upToDate).toBe(1);
  });

  // Hicks' finding on review of #490 (head 157f884): the earlier version of
  // this function stopped paging as soon as it had collected
  // `sampleSize * 2` merged PRs, trusting `/pulls?sort=updated` order. That
  // order is not `merged_at` order -- an older merged PR bumped by a recent
  // comment sorts ahead of a more recently merged PR with no further
  // activity -- so an early stop can return entirely the wrong sample. Here,
  // page 1 is a FULL page (`perPage` items) of older, up-to-date merges that
  // an updated-sort could easily surface first; page 2 is a SHORT page (the
  // true last page) of more recently merged PRs that were behind base. The
  // old count-based stop would have been satisfied by page 1 alone and
  // reported "2 / 2 up to date"; the fix must keep paging past a full page
  // regardless of how many merged PRs it has already seen, and report the
  // true most-recently-merged sample instead.
  it('does not stop at a full page of older merges when a shorter, more recent page follows (Hicks repro)', async () => {
    const fetchImpl = fakeApi({
      pages: [
        [
          {
            number: 100,
            merged_at: '2026-08-01T00:00:00Z',
            merge_commit_sha: 'm100',
            head: { sha: 'h100' },
          },
          {
            number: 101,
            merged_at: '2026-08-02T00:00:00Z',
            merge_commit_sha: 'm101',
            head: { sha: 'h101' },
          },
        ],
        [
          {
            number: 200,
            merged_at: '2026-08-10T00:00:00Z',
            merge_commit_sha: 'm200',
            head: { sha: 'h200' },
          },
        ],
        [],
      ],
      parents: { m100: ['p100'], m101: ['p101'], m200: ['p200'] },
      aheadBy: {
        // Page 1 (older): up to date at merge.
        'h100...p100': 0,
        'h101...p101': 0,
        // Page 2 (newer, the true top of the sample): behind at merge.
        'h200...p200': 5,
      },
    });

    const reading = await measureMergedAgainstBase({
      repository,
      token: 't',
      fetchImpl,
      sampleSize: 1,
      perPage: 2,
    });

    // The correct most-recently-merged sample of size 1 is PR #200 (merged
    // 2026-08-10), which was behind by 5 -- not either of the older,
    // up-to-date PRs from the full first page.
    expect(reading).toEqual({
      requested: 1,
      sampled: 1,
      upToDate: 0,
      behind: 1,
      unmeasured: 0,
      worst: { number: 200, commits: 5 },
    });
  });

  // Vasquez's finding on review of #490 (head 74bd775): the previous fix for
  // Hicks' pagination finding kept paging until a genuinely short page was
  // seen, but if `maxPages` full pages were exhausted first, it silently
  // returned whatever had been gathered so far. That is the same defect in a
  // different shape -- an unknown number of closed PRs, possibly including a
  // more recently merged, more-behind one, were never read, yet the function
  // returned a clean-looking sample as if nothing were missing. Here,
  // `maxPages: 1` at `perPage: 1` means exactly one full page is fetched --
  // an up-to-date merge -- and a second, more recently merged, behind-base PR
  // sits on the page that is never reached because the cap was hit first.
  // The old silently-truncating behaviour would report "1 / 1 up to date";
  // the fix must refuse to report anything rather than report that.
  it('throws rather than silently truncating when maxPages is exhausted before the true last page (Vasquez repro)', async () => {
    const fetchImpl = fakeApi({
      pages: [
        [
          {
            number: 300,
            merged_at: '2026-08-01T00:00:00Z',
            merge_commit_sha: 'm300',
            head: { sha: 'h300' },
          },
        ],
        // Never reached: maxPages is exhausted after page 1. If it were
        // reached, this behind-base, more-recently-merged PR would flip the
        // reading entirely -- which is exactly why silently stopping short
        // of the true last page must not be allowed to look like success.
        [
          {
            number: 301,
            merged_at: '2026-08-10T00:00:00Z',
            merge_commit_sha: 'm301',
            head: { sha: 'h301' },
          },
        ],
      ],
      parents: { m300: ['p300'], m301: ['p301'] },
      aheadBy: { 'h300...p300': 0, 'h301...p301': 9 },
    });

    await expect(
      measureMergedAgainstBase({
        repository,
        token: 't',
        fetchImpl,
        sampleSize: 1,
        perPage: 1,
        maxPages: 1,
      }),
    ).rejects.toThrow(/maxPages/i);
  });
});

describe('formatMergedAgainstBaseReading', () => {
  it('reports the split and the worst offender', () => {
    const text = formatMergedAgainstBaseReading({
      requested: 30,
      sampled: 30,
      upToDate: 27,
      behind: 3,
      unmeasured: 0,
      worst: { number: 669, commits: 3 },
    });
    expect(text).toContain('up to date at merge 27 / 30');
    expect(text).toContain('merged behind base 3 / 30');
    expect(text).toContain('worst: #669, 3 commits behind');
    expect(text).not.toContain('could not be measured');
  });

  it('singularises "1 commit" and omits the worst clause when nothing is behind', () => {
    const oneCommit = formatMergedAgainstBaseReading({
      requested: 5,
      sampled: 5,
      upToDate: 4,
      behind: 1,
      unmeasured: 0,
      worst: { number: 1, commits: 1 },
    });
    expect(oneCommit).toContain('1 commit behind)');
    expect(oneCommit).not.toContain('1 commits behind)');

    const allUpToDate = formatMergedAgainstBaseReading({
      requested: 5,
      sampled: 5,
      upToDate: 5,
      behind: 0,
      unmeasured: 0,
      worst: null,
    });
    expect(allUpToDate).not.toContain('worst');
  });

  it('says plainly when nothing could be sampled, rather than a division-shaped 0 / 0', () => {
    const text = formatMergedAgainstBaseReading({
      requested: 0,
      sampled: 0,
      upToDate: 0,
      behind: 0,
      unmeasured: 0,
      worst: null,
    });
    expect(text).toContain('no measurable merged pull requests');
    expect(text).not.toContain('0 / 0');
  });

  // Hicks' finding on review of #490 (head 417a712): a reader must never be
  // able to see a clean split without also being told how many PRs, if any,
  // were excluded from it. These pin both shapes of that guarantee: some
  // PRs measured plus some unmeasured, and every single sampled PR
  // unmeasured (so there is no split to report at all, only the caveat).
  it('always names the unmeasured count in the same sentence as the split, never leaving it only inferable', () => {
    const text = formatMergedAgainstBaseReading({
      requested: 30,
      sampled: 27,
      upToDate: 27,
      behind: 0,
      unmeasured: 3,
      worst: null,
    });
    expect(text).toContain('up to date at merge 27 / 27 measured');
    expect(text).toContain('3 of 30 could not be measured');
  });

  it('says plainly that nothing could be measured when every sampled PR was unmeasurable, rather than reporting an empty split as clean', () => {
    const text = formatMergedAgainstBaseReading({
      requested: 4,
      sampled: 0,
      upToDate: 0,
      behind: 0,
      unmeasured: 4,
      worst: null,
    });
    expect(text).toContain(
      'none of the 4 sampled merged pull requests could be measured',
    );
    expect(text).not.toContain('0 / 0');
    expect(text).not.toContain('up to date');
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
