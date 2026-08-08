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

const violation = (assumption, expected, actual, decision, consequence) => ({
  assumption,
  expected,
  actual,
  decision,
  consequence,
});

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

  // Reads a `{ enabled: <bool> }`-shaped node into a fact that is either
  // "confirmed true", "confirmed false", or "not confirmed either way".
  // A plain `node?.enabled === true` check answers a narrower question --
  // "is this literally true?" -- which would be exactly right for the fields
  // whose safe value is `true` (an absent node correctly reads as not-true,
  // i.e. a violation), but wrong for the fields below whose safe value is
  // `false`: it cannot tell "GitHub confirmed this is off" from "GitHub said
  // nothing about
  // this at all", and a payload that omits the key, or a payload that
  // returns the node but as `{}` or with `enabled` set to something other
  // than a literal boolean (a malformed-but-present shape), all collapse to
  // the same silent "not true" reading. Vasquez's review of this PR (#488)
  // found exactly that hole: `allow_force_pushes: {}` produced no violation.
  // `readEnabledFact` treats every one of those non-boolean shapes the same
  // as a fully missing node, so `guardField` below raises the absent-field
  // violation for all of them, not only for `undefined`/`null`.
  const readEnabledFact = (node) => {
    if (node === undefined || node === null || typeof node !== 'object') {
      return { confirmed: false };
    }
    if (node.enabled === true) return { confirmed: true, value: true };
    if (node.enabled === false) return { confirmed: true, value: false };
    return { confirmed: false };
  };

  // The three fields above whose safe value is `false` share this hazard.
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

  guardField(
    protection.allow_force_pushes,
    'development.allow_force_pushes',
    '#81 / #149',
    'the allow_force_pushes fact is missing or malformed in the response rather than confirmed false -- an absent field, an empty node, or a non-boolean enabled value is not the same as GitHub reporting the trunk still refuses force pushes',
    'the server-side half of the force-push protection is gone, leaving only the client-side guard, which --no-verify bypasses',
  );

  guardField(
    protection.allow_deletions,
    'development.allow_deletions',
    '#81 / #149',
    'the allow_deletions fact is missing or malformed in the response rather than confirmed false -- an absent field, an empty node, or a non-boolean enabled value is not the same as GitHub reporting the trunk cannot be deleted',
    'the trunk can be deleted outright, which no client-side guard sees',
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
          'squash-only history is what makes `--is-ancestor <head>` a known false negative rather than an unknown one',
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
 */
export function statusCheckEnforcement(protection) {
  if (protection?.required_status_checks?.strict !== true) {
    return {
      state: 'absent',
      why: 'strict is not set, so a pull request may merge against a base it was never tested against',
    };
  }
  if (protection?.enforce_admins?.enabled === true) {
    return {
      state: 'binding',
      why: 'strict is set and administrators are not exempt, so up-to-date-ness is enforced for every merger',
    };
  }
  return {
    state: 'bypassable',
    why: 'strict is set but administrators are exempt, and the only account that can merge is an administrator — do not rely on a merged PR having been tested against the trunk it landed on',
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

export async function fetchRepositoryFacts({
  repository,
  branch = 'development',
  token,
  fetchImpl = fetch,
}) {
  const [protection, rulesets, protectedBranches, collaborators] =
    await Promise.all([
      api(fetchImpl, repository, token, `/branches/${branch}/protection`),
      api(fetchImpl, repository, token, '/rulesets'),
      api(fetchImpl, repository, token, '/branches?protected=true'),
      api(fetchImpl, repository, token, '/collaborators'),
    ]);

  return {
    protection,
    rulesets,
    protectedBranches: protectedBranches.map((b) => b.name),
    collaborators: collaborators.map((c) => ({
      login: c.login,
      role: c.role_name,
    })),
  };
}

async function main() {
  const token = discoverToken(process.env);
  const repositoryName = discoverRepository(process.env);

  if (token === null || repositoryName === null) {
    const missing = [];
    if (token === null) missing.push('no GITHUB_TOKEN and no `gh auth token`');
    if (repositoryName === null)
      missing.push('no GITHUB_REPOSITORY and no origin remote');
    // Same degrade as check:merge-queue-contexts and the same reason: hard
    // failing where there is nothing to read teaches people to ignore the exit
    // code. It says plainly that it did not check, because a silent skip that
    // exits 0 is a control reporting success for work it did not do.
    console.log(`Skipped the assumption check: ${missing.join('; ')}.`);
    console.log(
      'Every fact this guards is remote, so this run has NOT checked whether the premises of #111 and #151 still hold.',
    );
    return;
  }

  const repository = resolveRepository(
    repositoryName === ''
      ? process.env
      : { ...process.env, GITHUB_REPOSITORY: repositoryName },
  );

  const facts = await fetchRepositoryFacts({ repository, token });
  const violations = evaluateProtectionAssumptions(facts);

  // Printed on every run, pass or fail. A reader who sees `strict: true` in the
  // settings concludes that a merged PR was tested against the trunk it landed on,
  // and here that is false for half of them.
  const enforcement = statusCheckEnforcement(facts.protection);
  console.log(
    `Up-to-date-with-base enforcement: ${enforcement.state} — ${enforcement.why}`,
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
