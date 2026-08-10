// Fails when the repository facts that #111 and #151 were decided against change.
//
// #111 declined to require an approving review and declined `enforce_admins`,
// and both refusals are correct -- but only because `jpapiez` is the sole
// collaborator and an admin. GitHub forbids self-approval, so requiring a review
// would make every merge impossible. #151 concluded that no useful server-side
// force-push rule is available on feature branches, for the same reason: the only
// bypass actor available is the only actor.
//
// Every one of those conclusions is sound, and every one of them is contingent on
// a fact about the repository rather than on a principle. #151 says so, and then
// does what issues do about it:
//
//     "The moment a second collaborator or any non-admin automation account
//      exists ... Written here so the next person does not rediscover it."
//
// That is a commitment, not a control. Nothing re-reads it, and the condition it
// waits for is a change nobody is watching for.
//
// This is the control. It re-reads the facts and fails when one has moved, naming
// the decision that rested on it.
//
// The need is not hypothetical. #151 transcribed a table on 2026-08-03 with an
// explicit warning that "their rightness expires silently", and by the next day
// `rulesets` had gone from `[]` to one entry. Nothing announced it. The issue
// predicted its own decay and had no way to detect it.
//
// Note on what is asserted: PROPERTIES, not transcriptions. `rulesets.length === 0`
// would already be failing, and failing for no reason that matters -- the ruleset
// that appeared is `development merge queue`, disabled, scoped to
// refs/heads/development, and grants nothing to feature branches. The assertion
// that carries #151's finding is that no ENABLED ruleset gives a feature branch
// force-push protection. A control that fires on cosmetic drift is one people
// learn to silence.

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  discoverToken,
  discoverRepository,
} from './check-merge-queue-contexts.mjs';
import { resolveRepository } from './check-pr-closure-scope.mjs';

// The eight required contexts, by name. Three sessions in one evening reported
// this number as seven, eight and nine, each by counting rows in a check-run
// rollup -- which is a superset in the same units, so the wrong number looks
// exactly like the right one. Pinning the names rather than the count means a
// swap of one context for another cannot pass as unchanged.
export const REQUIRED_CONTEXT_NAMES = Object.freeze([
  'Closing-reference declaration',
  'Dependency advisories',
  'Desktop (macos-latest)',
  'Desktop (windows-latest)',
  'Release package (macos-latest)',
  'Release package (windows-latest)',
  'Sidecar (macos-latest)',
  'Sidecar (windows-latest)',
]);

export const EXPECTED_COLLABORATORS = Object.freeze([
  Object.freeze({ login: 'jpapiez', role: 'admin' }),
]);

// A local, interactive run with no credential correctly exits 0: there is
// nobody to fail, only a person at a keyboard who can read the printed
// explanation. #492 is the case that reasoning does not cover -- CI reads the
// exit code and nothing else, so a run that skipped the check because a secret
// was rotated, expired, or never renewed is, on that one channel, identical to
// a run that checked every fact and found nothing moved. Reserved rather than
// reusing 1 (the "a premise moved" code) so the two failure classes -- "this
// script did not run the check" and "the check ran and found drift" -- are
// distinguishable by exit code alone, without reading the log.
export const EXIT_SKIPPED_WITHOUT_CREDENTIALS_IN_CI = 3;

const violation = (assumption, expected, actual, decision, consequence) => ({
  assumption,
  expected,
  actual,
  decision,
  consequence,
});

// Reads a `{ enabled: <bool> }`-shaped node into a fact that is either
// "confirmed true", "confirmed false", or "not confirmed either way". A
// plain `node?.enabled === true` check answers a narrower question -- "is
// this literally true?" -- which would be exactly right for fields whose
// safe value is `true` (an absent node correctly reads as not-true, i.e. a
// violation), but wrong for fields whose safe value is `false`: it cannot
// tell "GitHub confirmed this is off" from "GitHub said nothing about this
// at all", and a payload that omits the key, or a payload that returns the
// node but as `{}` or with `enabled` set to something other than a literal
// boolean (a malformed-but-present shape), all collapse to the same silent
// "not true" reading. Vasquez's review of #489's first pass (#488, and its
// own re-application below) found exactly that hole in two places:
// `allow_force_pushes: {}` produced no violation, and separately
// `adminExemptibleSettingEnforcement` narrated a missing field as if it were
// a confirmed, explicit unsafe value. `readEnabledFact` treats every
// non-boolean shape the same as a fully missing node, at module scope, so
// every reader of it -- `guardField` below and
// `adminExemptibleSettingEnforcement` further down -- shares one place that
// can go wrong instead of two.
function readEnabledFact(node) {
  if (node === undefined || node === null || typeof node !== 'object') {
    return { confirmed: false };
  }
  if (node.enabled === true) return { confirmed: true, value: true };
  if (node.enabled === false) return { confirmed: true, value: false };
  return { confirmed: false };
}

// Same distinction as `readEnabledFact`, specialised to `enforce_admins`:
// `{ confirmed: false }` means GitHub's response cannot confirm whether
// administrators are exempt at all (absent node, malformed node, or a
// non-boolean `enabled`), and must not be treated as a confirmed exemption
// -- see `adminExemptionReading`'s docblock for the finding this fixes.
function readAdminsExempt(protection) {
  const fact = readEnabledFact(protection?.enforce_admins);
  if (!fact.confirmed) return { confirmed: false };
  return { confirmed: true, exempt: fact.value === false };
}

/**
 * Pure. Takes the four reads and returns what has moved.
 *
 * Each violation names the decision that rested on the fact, because a drift
 * report that only says "this changed" leaves the reader to rediscover why it
 * was written down -- which is the rediscovery #151 was trying to prevent.
 */
export function evaluateProtectionAssumptions({
  protection,
  rulesets = [],
  protectedBranches = [],
  collaborators = [],
}) {
  if (!protection || typeof protection !== 'object') {
    throw new TypeError(
      'protection is required; refusing to report that assumptions hold from a value that cannot show they do',
    );
  }

  const violations = [];

  // The three fields below whose safe value is `false` share this hazard.
  // `guardField` raises a distinctly-worded violation when the fact is not
  // confirmed at all (missing node, or a present node that does not confirm
  // `enabled` as a literal boolean), and the existing present-unsafe-value
  // violation only when the fact is confirmed `true`.
  const guardField = (
    node,
    assumption,
    decision,
    absentConsequence,
    enabledConsequence,
  ) => {
    const fact = readEnabledFact(node);
    if (!fact.confirmed) {
      violations.push(
        violation(
          assumption,
          'false (present and confirmed)',
          '(field absent or does not confirm a boolean enabled value)',
          decision,
          absentConsequence,
        ),
      );
      return;
    }
    if (fact.value === true) {
      violations.push(
        violation(assumption, 'false', 'true', decision, enabledConsequence),
      );
    }
  };

  // #489: `enforce_admins: false` exempts administrators from every one of
  // the three settings guarded below, not only from `strict`. The sole
  // collaborator here is an administrator, so each of these consequence
  // texts names that the admin was already exempt from the rule before the
  // drift below -- the drift removes the barrier for everyone else too, it
  // does not take away a protection that was previously binding on them.
  guardField(
    protection.allow_force_pushes,
    'development.allow_force_pushes',
    '#81 / #149',
    'the allow_force_pushes fact is missing or malformed in the response rather than confirmed false -- an absent field, an empty node, or a non-boolean enabled value is not the same as GitHub reporting the trunk still refuses force pushes',
    'force pushes are now allowed for every account, not only the sole admin whom enforce_admins:false already exempted from this rule; there was never a server-side barrier for that admin either, only the client-side guard, which --no-verify bypasses',
  );

  guardField(
    protection.allow_deletions,
    'development.allow_deletions',
    '#81 / #149',
    'the allow_deletions fact is missing or malformed in the response rather than confirmed false -- an absent field, an empty node, or a non-boolean enabled value is not the same as GitHub reporting the trunk cannot be deleted',
    'the trunk can now be deleted by every account, not only the sole admin whom enforce_admins:false already exempted from this rule; no client-side guard sees a deletion',
  );

  // Unlike the three false-safe fields, this one's safe value is `true`, so
  // an unconfirmed fact (absent node, empty node, non-boolean enabled value)
  // must be reported as unsafe here too -- but with wording distinct from an
  // explicit `{ enabled: false }` node, per #488's acceptance criterion.
  {
    const fact = readEnabledFact(protection.required_linear_history);
    if (!fact.confirmed) {
      violations.push(
        violation(
          'development.required_linear_history',
          'true (present and confirmed)',
          '(field absent or does not confirm a boolean enabled value)',
          '#149',
          'the required_linear_history fact is missing or malformed in the response rather than confirmed false -- an absent field, an empty node, or a non-boolean enabled value is not the same as GitHub reporting linear history is no longer required',
        ),
      );
    } else if (fact.value !== true) {
      violations.push(
        violation(
          'development.required_linear_history',
          'true',
          'false',
          '#149',
          'merge commits are now allowed for every account, not only the sole admin whom enforce_admins:false already exempted from this rule; squash-only history was already not something to rely on for `--is-ancestor <head>`',
        ),
      );
    }
  }

  if (protection.required_status_checks?.strict !== true) {
    violations.push(
      violation(
        'development.required_status_checks.strict',
        'true',
        String(protection.required_status_checks?.strict),
        '#122',
        'a PR can merge against a trunk it was never tested against',
      ),
    );
  }

  const contexts = [
    ...(protection.required_status_checks?.contexts ?? []),
  ].sort((a, b) => a.localeCompare(b));
  const expectedContexts = [...REQUIRED_CONTEXT_NAMES];
  if (contexts.join('\n') !== expectedContexts.join('\n')) {
    violations.push(
      violation(
        'development.required_status_checks.contexts',
        expectedContexts.join(', '),
        contexts.length === 0 ? '(none)' : contexts.join(', '),
        '#122 / #384',
        'a required context that no workflow emits under merge_group never reports and deadlocks the queue rather than failing it',
      ),
    );
  }

  // #111 decided both of these deliberately and they are NOT wrong. The
  // violation is not "this is misconfigured" -- it is "the premise moved, go
  // re-read #111", which is why the consequence is phrased as a re-examination.
  guardField(
    protection.enforce_admins,
    'development.enforce_admins',
    '#111',
    'enforce_admins is missing or malformed in the response rather than confirmed false -- an absent field, an empty node, or a non-boolean enabled value is not the same as GitHub reporting the #111 exemption still holds, and this check cannot tell whether it was overtaken',
    'enforce_admins was declined because the sole admin would be unable to merge; if it is now on, that reasoning has been overtaken and #111 and #151 should be re-read together',
  );

  // `required_pull_request_reviews` carries its fact as a count, not an
  // `enabled` boolean, so it needs its own version of the same distinction:
  // an absent node, or a present node whose count is not itself a confirmed
  // number, must not silently read as "confirmed 0".
  {
    const reviewsNode = protection.required_pull_request_reviews;
    const reviewCount =
      reviewsNode !== undefined && reviewsNode !== null
        ? reviewsNode.required_approving_review_count
        : undefined;
    if (
      reviewsNode === undefined ||
      reviewsNode === null ||
      typeof reviewsNode !== 'object' ||
      reviewCount === undefined
    ) {
      violations.push(
        violation(
          'development.required_approving_review_count',
          '0 (decided in #111, present and confirmed)',
          '(field absent or does not confirm a review count in the API response)',
          '#111',
          'required_pull_request_reviews is missing or malformed in the response rather than confirmed at 0 -- an absent field or a node with no required_approving_review_count is not the same as GitHub reporting the #111 self-approval reasoning still holds',
        ),
      );
    } else if (reviewCount !== 0) {
      violations.push(
        violation(
          'development.required_approving_review_count',
          '0 (decided in #111)',
          String(reviewCount),
          '#111',
          'requiring a review was declined because GitHub forbids self-approval and jpapiez is the sole collaborator; a non-zero value means that constraint has changed',
        ),
      );
    }
  }

  // The stated revisit trigger for both #111 and #151, and the only one of these
  // facts that is about people rather than settings.
  const actualCollaborators = [...collaborators]
    .map((c) => `${c.login}(${c.role})`)
    .sort((a, b) => a.localeCompare(b));
  const expectedCollaborators = EXPECTED_COLLABORATORS.map(
    (c) => `${c.login}(${c.role})`,
  ).sort((a, b) => a.localeCompare(b));
  if (actualCollaborators.join(',') !== expectedCollaborators.join(',')) {
    violations.push(
      violation(
        'collaborators',
        expectedCollaborators.join(', '),
        actualCollaborators.length === 0
          ? '(none)'
          : actualCollaborators.join(', '),
        '#111 / #151',
        'THIS IS THE REVISIT TRIGGER both issues name. A second collaborator or a non-admin automation account makes self-approval possible and makes the remote rules bind for real; #111 declined items and #151 ruleset question must be re-examined together',
      ),
    );
  }

  violations.push(
    ...evaluatePublicProtectionAssumptions({
      rulesets,
      protectedBranches,
    }),
  );

  return violations;
}

// #491: `protected branches` and `rulesets covering feature branches` are the
// only two of these nine assumptions that depend SOLELY on the two GitHub
// endpoints that need no credential at all -- `/branches?protected=true` and
// `/rulesets` both return 200 to an unauthenticated request against this
// public repository (measured; only `/branches/{branch}/protection` and
// `/collaborators` return 401 without a token). The UNENFORCED_CHECKS entry
// this check used to justify itself with claimed "every one of those
// endpoints needs admin scope" -- true of the other seven assumptions, false
// of these two, and the false half is exactly what foreclosed running them in
// CI. Split out so the public tier can be evaluated, and run for real, without
// ever constructing a `protection` object the caller does not have.
export function evaluatePublicProtectionAssumptions({
  rulesets = [],
  protectedBranches = [],
}) {
  const violations = [];

  const protectedNames = [...protectedBranches].sort((a, b) =>
    a.localeCompare(b),
  );
  if (protectedNames.join(',') !== 'development') {
    violations.push(
      violation(
        'protected branches',
        'development',
        protectedNames.length === 0 ? '(none)' : protectedNames.join(', '),
        '#151',
        'the set of branches carrying protection has changed, so #151 finding that feature branches have no server-side control may no longer describe the repository',
      ),
    );
  }

  const coveringFeatureBranches = rulesets.filter((ruleset) =>
    rulesetCoversFeatureBranches(ruleset),
  );
  if (coveringFeatureBranches.length > 0) {
    violations.push(
      violation(
        'rulesets covering feature branches',
        'none',
        coveringFeatureBranches.map((r) => r.name ?? '(unnamed)').join(', '),
        '#151',
        'a server-side rule now reaches feature branches, which is the thing #151 asks for -- confirm it does not block the legitimate force-push repair that `npm run push:force` exists to make safe',
      ),
    );
  }

  return violations;
}

// The seven assumptions that DO need the privileged tier
// (`/branches/{branch}/protection`, `/collaborators`), named here once so
// `main()`'s no-token path can report each one explicitly as
// not-checked-no-scope rather than silently omitting it from the printed
// output. Order matches the sequence `evaluateProtectionAssumptions` checks
// them in, above.
export const PRIVILEGED_ONLY_ASSUMPTIONS = Object.freeze([
  'development.allow_force_pushes',
  'development.allow_deletions',
  'development.required_linear_history',
  'development.required_status_checks.strict',
  'development.required_status_checks.contexts',
  'development.enforce_admins',
  'development.required_approving_review_count',
  'collaborators',
]);

/**
 * Shared shape behind every admin-exemptible reading below: a setting is
 * `absent` when it isn't even configured the protective way, `bypassable` when
 * it is configured correctly but `enforce_admins: false` exempts admins from
 * it, and `binding` only when it is configured correctly AND admins are not
 * exempt.
 *
 * The `present` argument must already distinguish "confirmed not configured
 * the protective way" from "cannot be confirmed at all" -- collapsing those
 * two into one boolean is exactly the hole #488 fixed for the violation
 * checks above, and callers below split it back out via `readEnabledFact`
 * rather than a plain `?.enabled === x` comparison.
 *
 * `adminsExempt` must make the same distinction for `enforce_admins` itself:
 * Hicks reproduced, in review of #490/#676 (head a92efda4), that both
 * readers below computed it as `protection?.enforce_admins?.enabled !==
 * true`, which silently treated a missing/malformed `enforce_admins` node
 * the same as a confirmed `{ enabled: false }` -- narrating an unconfirmed
 * field as though GitHub had confirmed administrators are exempt. Callers
 * now pass a tri-state `{ confirmed, exempt }` (from `readEnabledFact`)
 * instead of a plain boolean, and an unconfirmed `enforce_admins` produces
 * its own `'unconfirmed'` state rather than defaulting into `'bypassable'`.
 */
function adminExemptionReading({
  present,
  adminsExempt,
  absentWhy,
  unconfirmedAdminsExemptWhy,
  bypassableWhy,
  bindingWhy,
}) {
  if (!present) {
    return { state: 'absent', why: absentWhy };
  }
  if (!adminsExempt.confirmed) {
    return { state: 'unconfirmed', why: unconfirmedAdminsExemptWhy };
  }
  if (!adminsExempt.exempt) {
    return { state: 'binding', why: bindingWhy };
  }
  return { state: 'bypassable', why: bypassableWhy };
}

/**
 * What `required_status_checks.strict` actually guarantees here, which is not what
 * its presence suggests.
 *
 * `strict` requires a pull request to be up to date with its base before it may
 * merge. `enforce_admins: false` exempts administrators from every branch
 * protection rule, `strict` included — and in this repository the sole
 * collaborator is an administrator, so the exemption covers every merge anyone can
 * perform. The setting is present, correct, and binds nobody.
 *
 * The assumption check above asserts `strict === true` and names the consequence of
 * its absence as "a PR can merge against a trunk it was never tested against."
 * That consequence occurs anyway, because `enforce_admins: false` exempts the
 * only account that can merge from the check `strict` performs. So the
 * assertion passes while the harm it names remains possible on every merge.
 * That is not an argument for turning `enforce_admins` on — #111 declined it
 * correctly, because the only admin is the only merger and enforcing it would
 * deadlock the repository. It is an argument for saying out loud which of these
 * settings is load-bearing, so that no other control is written on the assumption
 * that a merged PR was tested against the trunk it landed on.
 *
 * #490: two earlier versions of this comment transcribed how often that harm
 * actually occurs -- first as "15/30, worst #366 seventy commits behind", then
 * (in review of the first fix) as "28/2" -- as prose inside this file, with
 * nothing that re-derives the figure. Both were unfalsifiable the same way:
 * the test suite below exercises this function against a hand-written fixture
 * and never reads a pull request, so neither number had a falsifier, and each
 * was independently found to already be wrong when someone bothered to
 * recompute it. `measureMergedAgainstBase`, below, is the fix: it queries the
 * API for the N most recently merged pull requests against `base` and, for
 * each one, compares the merge commit's first parent (the trunk tip immediately
 * before that merge) against the PR's own head commit, so "up to date" and
 * "commits behind" are counted the same way every run rather than remembered
 * from one. `main()` calls it and prints the result on every run, so the
 * figure is always current and this file never again states a number about
 * the past that nothing recomputes.
 *
 * This is reported rather than failed. The state below is the permanent and correct
 * one, and a check that fails on the correct state teaches its reader to ignore it.
 * What binds it is the test suite: if the `strict` / `enforce_admins` pair ever
 * changes, this reading changes with it, so the qualitative claim above cannot
 * quietly outlive the facts it rests on. The merged-behind-base rate is bound
 * the same way `measureMergedAgainstBase` is bound: by unit tests against a
 * fake API response, not by a number transcribed into this comment.
 *
 * `strict` was the only setting read this way until #489: `enforce_admins: false`
 * exempts administrators from `allow_force_pushes`, `allow_deletions` and
 * `required_linear_history` exactly as it exempts them from `strict`, and the
 * assumption check above was asserting those three as if they bound the sole
 * admin. `adminExemptibleSettingEnforcement`, below, reads all four the same way.
 */
export function statusCheckEnforcement(protection) {
  return adminExemptionReading({
    present: protection?.required_status_checks?.strict === true,
    adminsExempt: readAdminsExempt(protection),
    absentWhy:
      'strict is not set, so a pull request may merge against a base it was never tested against',
    unconfirmedAdminsExemptWhy:
      'strict is set, but enforce_admins is missing or malformed in the response rather than confirmed either way, so whether administrators are exempt from it cannot be read from this field',
    bindingWhy:
      'strict is set and administrators are not exempt, so up-to-date-ness is enforced for every merger',
    bypassableWhy:
      'strict is set but administrators are exempt, and the only account that can merge is an administrator — do not rely on a merged PR having been tested against the trunk it landed on',
  });
}

/**
 * Every admin-exemptible setting read the same way `statusCheckEnforcement`
 * reads `strict`: `enforce_admins: false` exempts administrators from ALL of
 * these rules, not only `strict`, so a setting that is present and correct can
 * still bind nobody when the only account that can push or merge is an admin.
 * Returns one `{ state, why }` reading per setting, in the same
 * `binding` / `bypassable` / `absent` vocabulary as `statusCheckEnforcement`.
 *
 * The three `{ enabled: <bool> }`-shaped settings below are read through
 * `readEnabledFact` rather than a plain `?.enabled === x` comparison, so a
 * missing or malformed node reads as `absent` with wording that says the
 * field could not be confirmed, distinct from a node that GitHub confirmed
 * as the explicit unsafe value. Collapsing those two into one `why` narration
 * -- reporting an unconfirmed field as though it were a confirmed unsafe
 * setting -- is the same hole #488 fixed for the violation checks above, and
 * reappearing here in the enforcement-reporting path was exactly what
 * Vasquez's own review of this generalisation caught.
 */
export function adminExemptibleSettingEnforcement(protection) {
  const adminsExempt = readAdminsExempt(protection);

  const enabledNodeReading = ({
    node,
    protectiveValue,
    missingWhy,
    explicitUnsafeWhy,
    unconfirmedAdminsExemptWhy,
    bypassableWhy,
    bindingWhy,
  }) => {
    const fact = readEnabledFact(node);
    if (!fact.confirmed) {
      return { state: 'absent', why: missingWhy };
    }
    return adminExemptionReading({
      present: fact.value === protectiveValue,
      adminsExempt,
      absentWhy: explicitUnsafeWhy,
      unconfirmedAdminsExemptWhy,
      bypassableWhy,
      bindingWhy,
    });
  };

  return {
    strict: statusCheckEnforcement(protection),
    allow_force_pushes: enabledNodeReading({
      node: protection?.allow_force_pushes,
      protectiveValue: false,
      missingWhy:
        'allow_force_pushes is missing or malformed in the response rather than confirmed either way, so whether force pushes are restricted cannot be read from this field',
      explicitUnsafeWhy:
        'allow_force_pushes is confirmed enabled, so force pushes are not restricted for anyone, administrator or not',
      unconfirmedAdminsExemptWhy:
        'allow_force_pushes is confirmed disallowed, but enforce_admins is missing or malformed in the response rather than confirmed either way, so whether administrators are exempt from it cannot be read from this field',
      bindingWhy:
        'force pushes are disallowed by configuration and administrators are not exempt, so the restriction binds every pusher',
      bypassableWhy:
        'force pushes are disallowed by configuration but administrators are exempt, and the only account that can push is an administrator — do not rely on the server-side force-push guard; the client-side hook, which --no-verify bypasses, is what actually holds',
    }),
    allow_deletions: enabledNodeReading({
      node: protection?.allow_deletions,
      protectiveValue: false,
      missingWhy:
        'allow_deletions is missing or malformed in the response rather than confirmed either way, so whether deletion is restricted cannot be read from this field',
      explicitUnsafeWhy:
        'allow_deletions is confirmed enabled, so the branch can be deleted by anyone, administrator or not',
      unconfirmedAdminsExemptWhy:
        'allow_deletions is confirmed disallowed, but enforce_admins is missing or malformed in the response rather than confirmed either way, so whether administrators are exempt from it cannot be read from this field',
      bindingWhy:
        'deletion is disallowed by configuration and administrators are not exempt, so the restriction binds every account',
      bypassableWhy:
        'deletion is disallowed by configuration but administrators are exempt, and the only account with push access is an administrator — do not rely on the server-side deletion guard',
    }),
    required_linear_history: enabledNodeReading({
      node: protection?.required_linear_history,
      protectiveValue: true,
      missingWhy:
        'required_linear_history is missing or malformed in the response rather than confirmed either way, so whether linear history is required cannot be read from this field',
      explicitUnsafeWhy:
        'required_linear_history is confirmed not enabled, so merge commits are not restricted for anyone, administrator or not',
      unconfirmedAdminsExemptWhy:
        'required_linear_history is confirmed required, but enforce_admins is missing or malformed in the response rather than confirmed either way, so whether administrators are exempt from it cannot be read from this field',
      bindingWhy:
        'linear history is required by configuration and administrators are not exempt, so it binds every merger',
      bypassableWhy:
        'linear history is required by configuration but administrators are exempt, and the only account that can merge is an administrator — do not rely on trunk history actually being linear',
    }),
  };
}

/**
 * A ruleset matters here only if it is ENABLED and reaches something other than
 * `development`. `enforcement: 'disabled'` and `evaluate` (dry-run) grant nothing.
 */
const KNOWN_RULESET_ENFORCEMENTS = new Set(['active', 'evaluate', 'disabled']);
const KNOWN_RULESET_TARGETS = new Set(['branch', 'tag', 'push']);

export function rulesetCoversFeatureBranches(ruleset) {
  if (ruleset === null) return false;
  // A ruleset entry that is present but not an object (e.g. `0`, `false`,
  // `''`, a string, a number) is malformed external data, not the
  // deliberate "no ruleset" signal that `null` represents. Bishop
  // reproduced this in review of #490/#676 (head f4435a12):
  // `if (!ruleset) return false;` conflated `null` with any other falsy
  // value, so a malformed `/rulesets` entry like `0` was silently treated
  // as "does not cover feature branches" instead of failing loud.
  if (typeof ruleset !== 'object') {
    throw new Error(
      `Ruleset entry is not an object (got ${JSON.stringify(ruleset)}); refusing to treat malformed data as "covers no feature branches".`,
    );
  }
  // A non-null ruleset object without a recognized `enforcement` value is
  // malformed/truncated data, not a confirmed-inactive ruleset. Bishop
  // reproduced this in review of #490 (head 670905f4): `!== 'active'`
  // silently treated a missing/garbled `enforcement` field the same as an
  // explicit `'disabled'`, producing a falsely-clean "does not cover
  // feature branches" result for a ruleset whose actual enforcement state
  // GitHub never confirmed. `'active'`/`'evaluate'`/`'disabled'` are the
  // only enforcement values GitHub's API defines; anything else (absent,
  // null, a typo, a future/unknown value) throws instead of defaulting to
  // "not active".
  if (!KNOWN_RULESET_ENFORCEMENTS.has(ruleset.enforcement)) {
    throw new Error(
      `Ruleset ${JSON.stringify(ruleset.name ?? ruleset.id ?? '(unnamed)')} has an unrecognized enforcement value (got ${JSON.stringify(ruleset.enforcement)}); refusing to treat unconfirmed enforcement state as "not active".`,
    );
  }
  if (ruleset.enforcement !== 'active') return false;
  // An active ruleset without a recognized `target` value is malformed/
  // truncated data, not a confirmed non-branch ruleset. Hicks reproduced
  // this in review of #490 (head 7a822636): `ruleset.target &&
  // ruleset.target !== 'branch'` silently treated a missing/falsy `target`
  // the same as confirmed `target: 'branch'` semantics -- which happens to
  // be safe only by coincidence, since the same code would also silently
  // accept e.g. `target: 0` or `target: ''` and fall through as if it were
  // branch-targeted. GitHub's ruleset target values are `'branch'`,
  // `'tag'`, and `'push'`; anything else (absent, null, unrecognized)
  // throws instead of guessing which semantics apply.
  if (!KNOWN_RULESET_TARGETS.has(ruleset.target)) {
    throw new Error(
      `Active ruleset ${JSON.stringify(ruleset.name ?? ruleset.id ?? '(unnamed)')} has an unrecognized target value (got ${JSON.stringify(ruleset.target)}); refusing to guess whether it targets branches.`,
    );
  }
  if (ruleset.target !== 'branch') return false;
  // An active, branch-targeted ruleset without a resolvable
  // conditions.ref_name.include array is not a ruleset that "covers no
  // feature branches" -- it is malformed or truncated data. `?? []`
  // silently defaulted the missing targeting data to an empty array and
  // returned `false`, the same "silently accept malformed external data"
  // failure already fixed 14 times over in this file for other fields: a
  // ruleset that is genuinely active could, for all this function knows,
  // actually reach every branch, and reporting it as covering none because
  // the field GitHub uses to say so is absent is exactly the falsely-clean
  // result this file's other fixes exist to prevent. Hicks reproduced this
  // in review of #490 (head 31e0d8e). So a missing/non-array `include`
  // throws instead of defaulting, while an explicit empty array (a
  // well-formed ruleset that legitimately targets no refs) is unaffected.
  const include = ruleset.conditions?.ref_name?.include;
  if (!Array.isArray(include)) {
    throw new Error(
      `Active ruleset ${JSON.stringify(ruleset.name ?? ruleset.id ?? '(unnamed)')} has no conditions.ref_name.include array (got ${JSON.stringify(include)}); refusing to treat missing targeting data as "covers no feature branches".`,
    );
  }
  return include.some(
    (ref) => ref !== 'refs/heads/development' && ref !== '~DEFAULT_BRANCH',
  );
}

export function formatViolations(violations) {
  return violations
    .map(
      (v) =>
        `- ${v.assumption}\n    expected: ${v.expected}\n    actual:   ${v.actual}\n    rests on: ${v.decision}\n    why it matters: ${v.consequence}`,
    )
    .join('\n');
}

// `head.sha`/`merge_commit_sha` (and the first-parent sha resolved from a
// merge commit) must be non-empty strings to be used in a URL path. A truthy
// non-string -- an object like `{ bogus: true }`, a number, a boolean --
// would otherwise get coerced into the request path via template-literal
// stringification and could still receive *a* response, which this function
// would then trust, producing a falsely-clean reading instead of failing
// loud. This deliberately does not require a specific SHA shape (e.g. 40 hex
// characters): GitHub's own abbreviated-SHA support and this file's tests
// both use shorter opaque identifiers, and the actual failure mode being
// guarded against is "not a string at all", not "a string that doesn't look
// like a real SHA".
const isShaLike = (value) => typeof value === 'string' && value.length > 0;

const api = async (fetchImpl, repository, token, endpoint) => {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository.owner}/${repository.repo}${endpoint}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `${endpoint} request failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
};

// #491: unauthenticated `publicApi` is deliberately a separate function from
// `api` above rather than `api` called with an empty token. `api` always
// attaches an `authorization` header, and GitHub answers a MALFORMED
// authorization header (e.g. `Bearer undefined`, or `Bearer `) with 401 even
// on endpoints that accept no credential at all -- so reusing `api` with a
// missing token would not reproduce "unauthenticated", it would reproduce
// "authenticated badly", and could silently turn a real public 200 into a
// false 401 that this file would misreport as "needs admin scope after all".
const publicApi = async (fetchImpl, repository, endpoint) => {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository.owner}/${repository.repo}${endpoint}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `${endpoint} request failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
};

// #491: the two reads GitHub answers with no credential at all, measured
// against this public repository -- `/rulesets` and
// `/branches?protected=true` both return 200 unauthenticated; only
// `/branches/{branch}/protection` and `/collaborators` require an
// admin-scoped token (401 without one). These back exactly the two
// assumptions `evaluatePublicProtectionAssumptions` checks.
export async function fetchPublicRepositoryFacts({
  repository,
  fetchImpl = fetch,
}) {
  const [rulesets, protectedBranches] = await Promise.all([
    publicApi(fetchImpl, repository, '/rulesets'),
    publicApi(fetchImpl, repository, '/branches?protected=true'),
  ]);

  return {
    rulesets,
    protectedBranches: protectedBranches.map((b) => b.name),
  };
}

// #491: the two reads that need an admin-scoped token -- branch protection
// detail and the collaborator list. Both 401 without one (measured). Backs
// the seven assumptions in `PRIVILEGED_ONLY_ASSUMPTIONS`.
export async function fetchPrivilegedRepositoryFacts({
  repository,
  branch = 'development',
  token,
  fetchImpl = fetch,
}) {
  const [protection, collaborators] = await Promise.all([
    api(fetchImpl, repository, token, `/branches/${branch}/protection`),
    api(fetchImpl, repository, token, '/collaborators'),
  ]);

  return {
    protection,
    collaborators: collaborators.map((c) => ({
      login: c.login,
      role: c.role_name,
    })),
  };
}

export async function fetchRepositoryFacts({
  repository,
  branch = 'development',
  token,
  fetchImpl = fetch,
}) {
  const [publicFacts, privilegedFacts] = await Promise.all([
    fetchPublicRepositoryFacts({ repository, fetchImpl }),
    fetchPrivilegedRepositoryFacts({ repository, branch, token, fetchImpl }),
  ]);

  return {
    protection: privilegedFacts.protection,
    rulesets: publicFacts.rulesets,
    protectedBranches: publicFacts.protectedBranches,
    collaborators: privilegedFacts.collaborators,
  };
}

/**
 * The N most recently merged pull requests targeting `base`, by `merged_at`
 * -- not by list order, because `/pulls?sort=updated` and merge order are not
 * the same thing, and silently trusting page order here would reintroduce
 * exactly the kind of unverified-by-construction reading #490 is about.
 *
 * GitHub does not offer "list merged PRs sorted by merged_at" directly, and
 * `sort=updated` is not a proxy for it: an old merged PR can receive a new
 * comment and jump to the front of that ordering while a more recently
 * merged PR with no further activity sits behind it. That makes any
 * count-based early stop -- "stop once N*2 merged PRs have been seen" --
 * unsound: a later page can still hold a more recently merged PR than an
 * earlier one, so stopping before the true last page can return the wrong
 * sample and therefore the wrong split. This was exactly Hicks' finding
 * against the first version of this function in review of #490.
 *
 * So this pages through every closed PR (both merged and unmerged closes)
 * until the API itself reports there is nothing left to page -- a batch
 * shorter than `perPage` -- and only then sorts the merged ones by
 * `merged_at` and truncates to `sampleSize`. `maxPages` is a safety bound
 * against paging forever, and it must never become a second, silent
 * correctness mechanism: reaching it before a genuinely partial page has
 * been seen means an unknown number of closed PRs -- possibly including
 * more recently merged, more-behind ones -- were never looked at. Returning
 * whatever was gathered so far in that case would print a plausible-looking
 * split while silently excluding the very PRs that could change it: an "all
 * clear" that is not actually all clear. This was Vasquez's finding against
 * the second version of this function in review of #490 (reviewing the
 * pagination fix that itself answered Hicks' first pagination finding) --
 * so hitting `maxPages` without a genuine last page throws instead of
 * returning a truncated-but-silent sample; the caller already surfaces that
 * as an honest "could not be measured" rather than a wrong number.
 */
async function fetchRecentlyMergedPullRequests({
  repository,
  token,
  fetchImpl,
  base,
  sampleSize,
  perPage = 100,
  maxPages = 50,
}) {
  const merged = [];
  let sawGenuineLastPage = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await api(
      fetchImpl,
      repository,
      token,
      `/pulls?state=closed&base=${encodeURIComponent(base)}&per_page=${perPage}&page=${page}&sort=updated&direction=desc`,
    );
    // The rest of this loop assumes `batch` is an array of pull request
    // objects to iterate, count, and slice by page-size. A malformed
    // response -- e.g. a JSON string instead of an array -- is still
    // iterable in JS (strings are iterable, yielding one-character
    // "PRs"), so without this check the loop would silently walk
    // characters instead of pull requests: every "pr" would have no
    // merged_at and be skipped, and a short "batch" (a string shorter
    // than perPage) would look like the genuine last page, producing an
    // empty, plausible-looking sample instead of an error. Hicks
    // reproduced this in review of #490 (head 28051c3) with a 200 OK
    // response body of the bare string "oops". Fail loudly on any
    // response shape other than an array.
    if (!Array.isArray(batch)) {
      throw new Error(
        `Expected an array of pull requests from /pulls (page ${page}), got ${JSON.stringify(batch)}; refusing to treat a malformed response as an empty or partial page.`,
      );
    }
    for (const pr of batch) {
      // A well-formed GitHub API response includes `merged_at` as a key on
      // every closed PR -- either `null` (not merged) or a timestamp string
      // (merged). A PR entry missing the key entirely is not a legitimate
      // "not merged" signal, it's a sign the response is malformed or
      // truncated (e.g. a partial JSON body, or a shape change that dropped
      // fields) -- and JS's `pr.merged_at === undefined` cannot tell "key
      // present with value undefined" apart from "key absent altogether",
      // silently treating both the same as the null case. Bishop reproduced
      // this in review of #490 (head 327996a) with `{ number: 123 }` and no
      // `merged_at` property at all. So the key's presence is checked
      // first and an absent key throws, before the null-vs-other-falsy
      // check below (which only ever sees a key that is actually present).
      if (!('merged_at' in pr)) {
        throw new Error(
          `Pull request #${JSON.stringify(pr.number)} has no merged_at key at all (expected null for not merged, or a timestamp string); refusing to treat a missing key the same as a legitimate "not merged" signal.`,
        );
      }
      // Closed-but-unmerged PRs report `merged_at: null` -- that's a
      // legitimate, well-formed signal to skip and is not an error. But
      // other falsy values (e.g. an empty string) are not what the API
      // uses to mean "not merged"; treating them the same way via a bare
      // `!pr.merged_at` check silently drops a PR that claimed to have
      // *some* merged_at value instead of surfacing that the data is
      // malformed. Hicks reproduced this in review of #490 (head e5d6248)
      // with `merged_at: ''`, which the sample silently excluded rather
      // than throwing on. Only `null`/`undefined` mean "not merged";
      // anything else falsy is malformed and must throw.
      if (pr.merged_at === null || pr.merged_at === undefined) continue;
      if (typeof pr.merged_at !== 'string' || pr.merged_at === '') {
        throw new Error(
          `Pull request #${pr.number} has a malformed merged_at (${JSON.stringify(pr.merged_at)}); expected null (not merged) or a non-empty timestamp string.`,
        );
      }
      // `merged_at` drives the sort below that determines which PRs count as
      // the "most recently merged" sample. A truthy but unparseable value
      // (e.g. a malformed timestamp) would silently produce NaN, which
      // `Array.prototype.sort` treats as neither greater nor less than any
      // other value -- collapsing the sort to whatever order the API
      // happened to return, which is exactly the unsound-ordering defect
      // this function already had to fix once. Fail loudly instead of
      // trusting a value that can't actually be compared.
      const mergedAtMs = Date.parse(pr.merged_at);
      if (!Number.isFinite(mergedAtMs)) {
        throw new Error(
          `Pull request #${pr.number} has an unparseable merged_at (${JSON.stringify(pr.merged_at)}); refusing to sort by an invalid timestamp.`,
        );
      }
      merged.push(pr);
    }
    // A batch shorter than the requested page size is the API's own signal
    // that this was the last page -- the only condition under which stopping
    // is sound, because every closed PR has now been seen and merged_at can
    // be trusted to sort the true top `sampleSize`.
    if (batch.length < perPage) {
      sawGenuineLastPage = true;
      break;
    }
  }
  if (!sawGenuineLastPage) {
    // Reaching `maxPages` full pages without ever seeing a short page means
    // pagination was cut off, not completed -- there could be more closed
    // PRs, merged more recently than any seen so far, still unread. Silently
    // truncating here is exactly the defect being fixed: it can return a
    // clean-looking sample while the true most-recent, most-behind PRs sit
    // on a page this call never reached. Fail loudly instead.
    throw new Error(
      `Reached maxPages (${maxPages}) at perPage ${perPage} without finding the true last page of closed pull requests targeting "${base}"; the sample would be truncated and unsound, not just incomplete, so refusing to return it.`,
    );
  }
  return merged
    .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))
    .slice(0, sampleSize);
}

/**
 * Measures, at run time, whether merged pull requests were up to date with
 * `base` at the moment they merged -- the reading #490 found transcribed as a
 * fixed number in this file's own docblock, twice, each already wrong by the
 * time anyone re-checked it.
 *
 * For each merged PR: `merge_commit_sha`'s first parent is the tip `base` had
 * immediately before that merge landed (true whether the merge used a merge
 * commit, squash, or rebase, because in every case GitHub records exactly one
 * commit as the first parent of what it merged into `base`). Comparing that
 * parent against the PR's own `head.sha` -- which GitHub retains even after
 * the source branch is deleted -- with `GET /compare/{head}...{parent}`
 * yields `ahead_by`: the number of commits reachable from that base tip but
 * not from the PR head, i.e. exactly the commits the PR was missing when it
 * merged. Zero means the PR was up to date at merge; more than zero is the
 * number of commits it was behind.
 *
 * Pull requests without a `merge_commit_sha` or a `head.sha` (both required
 * fields for a merged PR, but defend against a malformed response rather than
 * throwing mid-sample), or whose merge commit has no resolvable first
 * parent, cannot be measured and are excluded from `upToDate`/`behind`. That
 * exclusion is safe only if it is visible: silently shrinking the sample and
 * reporting the reduced subset as though it were the whole "last N merged
 * pull requests" turns a real gap in the data into an artificially clean-
 * looking result -- the same failure mode as the maxPages and `ahead_by`
 * bugs already fixed here, just one step further down the same function.
 * Hicks reproduced this in review of #490 (head 417a712): 30 sampled PRs, 3
 * silently unmeasurable, printed as "27 / 27 clean" with no surfaced
 * unknowns. So this tracks `unmeasured` separately from `sampled` (which now
 * means "measured", not "attempted"), and `formatMergedAgainstBaseReading`
 * always names both the requested count and any unmeasured count -- a
 * reader can never see a clean split without also being told how many PRs,
 * if any, were excluded from it.
 */
export async function measureMergedAgainstBase({
  repository,
  token,
  fetchImpl = fetch,
  base = 'development',
  sampleSize = 30,
  perPage = 100,
  maxPages = 50,
}) {
  const pullRequests = await fetchRecentlyMergedPullRequests({
    repository,
    token,
    fetchImpl,
    base,
    sampleSize,
    perPage,
    maxPages,
  });

  let upToDate = 0;
  let behind = 0;
  let unmeasured = 0;
  let worst = null;

  for (const pr of pullRequests) {
    // `pr.number` is used verbatim in error messages and as the identifier
    // in the `worst` offender report -- if it's missing or not a real PR
    // number, both would silently produce a nonsensical identifier like
    // `#undefined` or `#NaN` instead of failing loud, the same class of bug
    // already fixed for `ahead_by` and `merged_at` on this same field's
    // neighbors. Vasquez found this in review of #490 (head e0487ac).
    if (
      typeof pr.number !== 'number' ||
      !Number.isInteger(pr.number) ||
      pr.number <= 0
    ) {
      throw new Error(
        `Pull request entry has an invalid number (positive integer expected, got ${JSON.stringify(pr.number)}); refusing to report a "worst offender" under a fabricated identifier.`,
      );
    }

    const headSha = pr.head?.sha;
    const mergeCommitSha = pr.merge_commit_sha;
    // Absent fields (null/undefined) are a legitimate reason a PR can't be
    // measured -- see the docblock above. But a *truthy* value that is not a
    // real SHA string (e.g. `{ bogus: true }`, a number, or an empty string)
    // is not "missing", it's malformed: silently passing it through to the
    // `/commits/{sha}` and `/compare/{head}...{parent}` URLs below would
    // stringify it into a broken request path and could still receive a
    // response that this function then trusted, producing a falsely-clean
    // reading instead of failing loud -- the same "silently accept malformed
    // external data" class of bug already fixed for `pr.number`, `ahead_by`,
    // and `merged_at` on this same function. Vasquez/Hicks reproduced this on
    // head 327996a with a malformed `head.sha`.
    if (headSha != null && !isShaLike(headSha)) {
      throw new Error(
        `Pull request #${pr.number} has a malformed head.sha (expected a non-empty string, got ${JSON.stringify(headSha)}); refusing to build a compare request from it.`,
      );
    }
    if (mergeCommitSha != null && !isShaLike(mergeCommitSha)) {
      throw new Error(
        `Pull request #${pr.number} has a malformed merge_commit_sha (expected a non-empty string, got ${JSON.stringify(mergeCommitSha)}); refusing to build a commit-lookup request from it.`,
      );
    }
    if (!mergeCommitSha || !headSha) {
      unmeasured += 1;
      continue;
    }

    const mergeCommit = await api(
      fetchImpl,
      repository,
      token,
      `/commits/${mergeCommitSha}`,
    );
    const baseTipAtMerge = mergeCommit.parents?.[0]?.sha;
    // Same reasoning as headSha/mergeCommitSha above, one API call further
    // down the chain: a missing first parent is a legitimate "can't measure
    // this PR" case, but a truthy, non-SHA value here would build an equally
    // broken `/compare` request while looking like a resolved parent.
    if (baseTipAtMerge != null && !isShaLike(baseTipAtMerge)) {
      throw new Error(
        `Pull request #${pr.number}'s merge commit (${mergeCommitSha}) has a malformed first-parent sha (expected a non-empty string, got ${JSON.stringify(baseTipAtMerge)}); refusing to build a compare request from it.`,
      );
    }
    if (!baseTipAtMerge) {
      unmeasured += 1;
      continue;
    }

    const comparison = await api(
      fetchImpl,
      repository,
      token,
      `/compare/${headSha}...${baseTipAtMerge}`,
    );
    // `?? 0` here would silently count PR #pr.number as up to date whenever
    // the compare response is missing, malformed, or `ahead_by` is absent --
    // rate limiting, a transient API shape change, or anything else that
    // makes the response not what was expected. That is a silently wrong
    // result standing in for a failure, not a degrade: a PR that may well be
    // behind base gets counted as up to date with no error and no warning.
    // Hicks reproduced this concretely in review of #490 (head 85d5148) with
    // a merged PR, a valid parent, and an empty `{}` compare response. So
    // this validates `ahead_by` is actually a number before trusting it, and
    // throws otherwise -- the same "loud failure over silent wrong answer"
    // fix already applied to the maxPages truncation in this same function's
    // caller, for the same reason.
    //
    // `typeof === 'number'` alone is not enough: it accepts -1, NaN, and
    // Infinity, all of which are numbers in JS but none of which is a
    // sensible count of commits behind. `-1` would flip the up-to-date/
    // behind classification below (a negative value fails `=== 0` and so
    // is treated as "behind" -- worse, "worst by -1 commits" makes no
    // sense as an offender); `NaN` fails every ordering comparison
    // silently, so it could never become `worst` even while being counted
    // in `behind`; `Infinity` would always win `worst` regardless of any
    // genuinely worse finite offender. Both Hicks and Vasquez independently
    // reproduced this identically in review of #490 (head 9ef8526), so
    // `ahead_by` must be a finite, non-negative number, not merely typeof
    // 'number', before it is trusted. It also must be an integer: `ahead_by`
    // is a count of commits, and a fractional value such as `0.5` is just as
    // malformed a compare response as a negative or non-finite one --
    // Vasquez reproduced this on head 2f65da1 (`{ ahead_by: 0.5 }` silently
    // reported as "0.5 commits behind" and eligible to become `worst`).
    if (
      typeof comparison.ahead_by !== 'number' ||
      !Number.isInteger(comparison.ahead_by) ||
      comparison.ahead_by < 0
    ) {
      throw new Error(
        `Compare response for #${pr.number} (${headSha}...${baseTipAtMerge}) did not include a valid ahead_by (non-negative integer expected, got ${JSON.stringify(comparison.ahead_by)}); refusing to guess whether it was up to date at merge.`,
      );
    }
    const commitsBehind = comparison.ahead_by;

    if (commitsBehind === 0) {
      upToDate += 1;
    } else {
      behind += 1;
      if (!worst || commitsBehind > worst.commits) {
        worst = { number: pr.number, commits: commitsBehind };
      }
    }
  }

  return {
    requested: pullRequests.length,
    sampled: upToDate + behind,
    upToDate,
    behind,
    unmeasured,
    worst,
  };
}

export function formatMergedAgainstBaseReading(reading) {
  if (reading.requested === 0) {
    return 'Merged-behind-base reading: no measurable merged pull requests were found in the sampled window.';
  }
  const worstText = reading.worst
    ? ` (worst: #${reading.worst.number}, ${reading.worst.commits} commit${reading.worst.commits === 1 ? '' : 's'} behind)`
    : '';
  // Whenever any PR was excluded from measurement, that must appear in the
  // same sentence as the split, not merely be inferable from `sampled` being
  // smaller than `requested` -- a reader skimming for "clean" must not be
  // able to miss it. This is what closes Hicks' "27 / 27 clean" finding: the
  // denominator here is always the measured count, and an unmeasured clause
  // is present whenever that count is not the full requested sample.
  const unmeasuredText =
    reading.unmeasured > 0
      ? `; ${reading.unmeasured} of ${reading.requested} could not be measured (missing merge data)`
      : '';
  if (reading.sampled === 0) {
    return `Merged-behind-base reading: none of the ${reading.requested} sampled merged pull requests could be measured (missing merge data).`;
  }
  return (
    `Merged-behind-base reading (live, last ${reading.requested} merged pull requests): ` +
    `up to date at merge ${reading.upToDate} / ${reading.sampled} measured, ` +
    `merged behind base ${reading.behind} / ${reading.sampled} measured${worstText}${unmeasuredText}`
  );
}

async function main() {
  const token = discoverToken(process.env);
  const repositoryName = discoverRepository(process.env);

  // #491: only the ABSENCE OF A REPOSITORY TO ASK ABOUT is a full skip now.
  // A missing token used to be treated identically -- but two of the four
  // reads this file needs (`/rulesets`, `/branches?protected=true`) return
  // 200 to an unauthenticated request against this repository (measured),
  // and #151's ruleset/protected-branches questions depend only on those
  // two. Folding "no token" into the same full skip as "no repository" is
  // exactly the "every one of those endpoints needs admin scope" claim #491
  // found too broad, reproduced here as code rather than only as prose.
  if (repositoryName === null) {
    // Same degrade as check:merge-queue-contexts and the same reason: hard
    // failing where there is nothing to read teaches people to ignore the exit
    // code. It says plainly that it did not check, because a silent skip that
    // exits 0 is a control reporting success for work it did not do.
    console.log(
      'Skipped the assumption check: no GITHUB_REPOSITORY and no origin remote.',
    );
    console.log(
      'Every fact this guards is remote, so this run has NOT checked whether the premises of #111 and #151 still hold.',
    );
    // #492: the printed text above is correct and unchanged for both branches
    // below -- what differs is the only channel CI actually reads. Outside CI
    // this stays exit 0, because failing a run with nothing to read teaches
    // people to ignore the exit code, and that reasoning is unchanged. Inside
    // CI, a skip must not be able to report green: it would make a rotated,
    // expired, or unrenewed secret indistinguishable from a passing check.
    if ((process.env.CI ?? '') !== '') {
      process.exitCode = EXIT_SKIPPED_WITHOUT_CREDENTIALS_IN_CI;
    }
    return;
  }

  const repository = resolveRepository(
    repositoryName === ''
      ? process.env
      : { ...process.env, GITHUB_REPOSITORY: repositoryName },
  );

  if (token === null) {
    // #491's public tier: real work, not a skip. Only the two assumptions
    // that need no credential are checked; the other seven are reported
    // below by name as not-checked-no-scope, never silently omitted.
    const publicFacts = await fetchPublicRepositoryFacts({ repository });
    const violations = evaluatePublicProtectionAssumptions(publicFacts);

    console.log(
      `No admin-scoped credential found, so only the public tier ran: ` +
        `${2 - violations.length}/2 public assumption(s) held, ` +
        `${PRIVILEGED_ONLY_ASSUMPTIONS.length} assumption(s) not-checked-no-scope.`,
    );
    for (const assumption of PRIVILEGED_ONLY_ASSUMPTIONS) {
      console.log(`  not-checked-no-scope: ${assumption}`);
    }

    if (violations.length === 0) {
      console.log(
        'The public-tier facts (protected branches, rulesets reaching feature branches) still hold.',
      );
      return;
    }

    console.error(
      'A premise moved in the public tier. These decisions were correct against facts that have changed:\n',
    );
    console.error(formatViolations(violations));
    console.error(
      '\nThis is not automatically a misconfiguration. Re-read the named decisions before changing anything.',
    );
    process.exitCode = 1;
    return;
  }

  const facts = await fetchRepositoryFacts({ repository, token });
  const violations = evaluateProtectionAssumptions(facts);

  // Printed on every run, pass or fail. A reader who sees `strict: true`, or any
  // of the other three settings below, in the raw settings concludes that the
  // setting binds every merger or pusher. `enforce_admins: false` exempts
  // administrators from every one of them, and the sole collaborator here is an
  // administrator, so all four can be present and correct while binding nobody.
  const enforcement = adminExemptibleSettingEnforcement(facts.protection);
  console.log(
    `Up-to-date-with-base enforcement: ${enforcement.strict.state} — ${enforcement.strict.why}`,
  );
  console.log(
    `Force-push protection enforcement: ${enforcement.allow_force_pushes.state} — ${enforcement.allow_force_pushes.why}`,
  );
  console.log(
    `Deletion protection enforcement: ${enforcement.allow_deletions.state} — ${enforcement.allow_deletions.why}`,
  );
  console.log(
    `Linear-history enforcement: ${enforcement.required_linear_history.state} — ${enforcement.required_linear_history.why}`,
  );

  // #490: derived fresh every run rather than transcribed once and left to go
  // stale. A failure here does not fail the whole check -- the qualitative
  // enforcement reading above does not depend on this number -- but it must
  // not be silently skipped either, so a failure says so.
  try {
    const behindReading = await measureMergedAgainstBase({
      repository,
      token,
    });
    console.log(formatMergedAgainstBaseReading(behindReading));
  } catch (error) {
    console.log(
      `Merged-behind-base reading: could not be measured this run (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  if (violations.length === 0) {
    console.log(
      `The repository facts that #111 and #151 were decided against still hold (${REQUIRED_CONTEXT_NAMES.length} required contexts, ${facts.collaborators.length} collaborator(s), no enabled ruleset reaching feature branches).`,
    );
    return;
  }

  console.error(
    'A premise moved. These decisions were correct against facts that have changed:\n',
  );
  console.error(formatViolations(violations));
  console.error(
    '\nThis is not automatically a misconfiguration. Re-read the named decisions before changing anything.',
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
