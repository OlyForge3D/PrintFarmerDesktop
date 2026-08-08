import { describe, expect, it } from 'vitest';
import {
  EXPECTED_COLLABORATORS,
  REQUIRED_CONTEXT_NAMES,
  evaluateProtectionAssumptions,
  formatViolations,
  rulesetCoversFeatureBranches,
  statusCheckEnforcement,
} from '../scripts/check-protection-assumptions.mjs';

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

  it('words an absent-field violation differently from an unsafe-value violation', () => {
    // The acceptance test requires the two to be distinguishable, not merely
    // both non-empty.
    const deletedFacts = baseline();
    delete (deletedFacts.protection as Record<string, unknown>)
      .allow_force_pushes;
    const [deletedViolation] = evaluateProtectionAssumptions(deletedFacts);

    const unsafeFacts = baseline();
    unsafeFacts.protection.allow_force_pushes = { enabled: true };
    const [unsafeViolation] = evaluateProtectionAssumptions(unsafeFacts);

    expect(deletedViolation?.actual).not.toBe(unsafeViolation?.actual);
    expect(deletedViolation?.consequence).not.toBe(
      unsafeViolation?.consequence,
    );
  });

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
