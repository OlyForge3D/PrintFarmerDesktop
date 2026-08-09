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

  violations.push(...evaluatePublicProtectionAssumptions({
    rulesets,
    protectedBranches,
  }));

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
 */
function adminExemptionReading({
  present,
  adminsExempt,
  absentWhy,
  bypassableWhy,
  bindingWhy,
}) {
  if (!present) {
    return { state: 'absent', why: absentWhy };
  }
  if (!adminsExempt) {
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
 * Measured over the thirty most recently merged pull requests, that consequence
 * occurs anyway:
 *
 *   up to date at merge   15 / 30
 *   merged behind base    15 / 30      worst: #366, seventy commits behind
 *
 * So the assertion passes while the harm it names happens in half of all merges.
 * That is not an argument for turning `enforce_admins` on — #111 declined it
 * correctly, because the only admin is the only merger and enforcing it would
 * deadlock the repository. It is an argument for saying out loud which of these
 * settings is load-bearing, so that no other control is written on the assumption
 * that a merged PR was tested against the trunk it landed on.
 *
 * This is reported rather than failed. The state below is the permanent and correct
 * one, and a check that fails on the correct state teaches its reader to ignore it.
 * What binds it is the test suite: if the pair ever changes, this reading changes
 * with it, so the claim cannot quietly outlive the facts it rests on.
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
    adminsExempt: protection?.enforce_admins?.enabled !== true,
    absentWhy:
      'strict is not set, so a pull request may merge against a base it was never tested against',
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
  const adminsExempt = protection?.enforce_admins?.enabled !== true;

  const enabledNodeReading = ({
    node,
    protectiveValue,
    missingWhy,
    explicitUnsafeWhy,
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
export function rulesetCoversFeatureBranches(ruleset) {
  if (!ruleset || ruleset.enforcement !== 'active') return false;
  if (ruleset.target && ruleset.target !== 'branch') return false;
  const include = ruleset.conditions?.ref_name?.include ?? [];
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
