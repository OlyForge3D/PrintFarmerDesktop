// Refuses to let a BEHIND pull request merge, by gating the merge action itself
// rather than relying on a server-side required check.
//
// Why this exists (#397). `development` has `required_status_checks.strict: true` —
// require branches to be up to date before merging — but `enforce_admins: false`
// exempts every admin from that rule, and the sole collaborator here is an admin.
// So `strict` is configured, correctly reported, and binds nobody
// (`scripts/check-protection-assumptions.mjs` calls this reading "bypassable", not
// "binding"). PR #322 merged BEHIND under exactly that gap and broke trunk for ~3h:
// it changed a function signature, and the incompatible caller lived in a file #322
// never touched, so no diff-based or path-intersection check could have caught it —
// only re-testing the union of both changes would have, which is what `strict` is
// for and what never ran because it never bound.
//
// This does NOT propose flipping `enforce_admins`. That is a live, deliberate
// decision (#111, re-asserted by `check-protection-assumptions.mjs`) that is not
// safe to reverse while the sole collaborator is the sole admin, and it is #388's
// decision to make, not this issue's. Instead this follows the shape of
// `scripts/push-guard.mjs`: a control that binds the only actor there is because it
// gates the privileged action on the client side, rather than asking a server-side
// rule to refuse an admin it is configured to exempt.
//
// What it measures. NOT `mergeable`/`mergeStateStatus` — both are documented
// elsewhere in this repo (`scripts/check-required-contexts.mjs`) as flapping and
// going permanently `UNKNOWN` on merged PRs, so a liveness check keyed on them never
// terminates. Instead: is the PR's base tip an ancestor of the PR's head?
// `git merge-base --is-ancestor <base> <head>` answers that directly and is the
// same primitive `scripts/sha-status.mjs` already hardened against the traps in
// this family (a missing ref exits 128, not 1; a remote-tracking ref is a cache and
// must be refreshed before its ancestry is trusted). Reused here rather than
// re-derived.
//
//   0  up to date — the base has landed nothing the head has not seen
//   1  BEHIND — the base carries commits the head was never tested against
//   2  undetermined — no credential, no network, or the refs could not be fetched;
//      never collapsed into a pass

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  isAncestor,
  fetchBase,
  fetchPrHead,
  resolveCommit,
} from './sha-status.mjs';
import { discoverToken } from './check-merge-queue-contexts.mjs';
import { runGh, resolveRepositorySlug } from './check-required-contexts.mjs';

export const EXIT_UP_TO_DATE = 0;
export const EXIT_BEHIND = 1;
export const EXIT_UNDETERMINED = 2;

/**
 * The judgement. Pure over the one fact that decides it.
 *
 * @param {{baseIsAncestorOfHead: boolean | null}} facts
 * @returns {{state: 'up-to-date' | 'behind' | 'undetermined', exitCode: number}}
 */
export function evaluateBehindBase({ baseIsAncestorOfHead }) {
  if (baseIsAncestorOfHead === null || baseIsAncestorOfHead === undefined) {
    return { state: 'undetermined', exitCode: EXIT_UNDETERMINED };
  }
  if (baseIsAncestorOfHead === true) {
    return { state: 'up-to-date', exitCode: EXIT_UP_TO_DATE };
  }
  return { state: 'behind', exitCode: EXIT_BEHIND };
}

/**
 * @param {number} prNumber
 * @param {string} baseRefName
 * @param {ReturnType<typeof evaluateBehindBase>} result
 * @returns {string}
 */
export function formatResult(prNumber, baseRefName, result) {
  if (result.state === 'up-to-date') {
    return `PR #${prNumber}: up to date with ${baseRefName}. Safe to merge on this ground.`;
  }
  if (result.state === 'behind') {
    return (
      `PR #${prNumber}: BEHIND ${baseRefName} — the base carries commits this PR's ` +
      `head has never been tested against. Do not merge. Sync by rebasing onto the ` +
      `latest ${baseRefName} (not GitHub's "Update branch" button — that creates a ` +
      `merge commit, which required_linear_history forbids on this repo's normal, ` +
      `squash-only merge path) and let CI re-run before merging.`
    );
  }
  return (
    `PR #${prNumber}: could not determine whether it is behind ${baseRefName}. ` +
    `Exit 2, not a pass — this is not evidence the PR is safe to merge.`
  );
}

/**
 * @param {string[]} argv
 * @returns {{pr?: number, base?: string, remote?: string, help?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  /** @type {{pr?: number, base?: string, remote?: string, help?: boolean, error?: string}} */
  const out = { remote: 'origin' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--pr') {
      const v = argv[i + 1];
      i += 1;
      if (v === undefined || !/^[0-9]+$/.test(v)) {
        out.error = '--pr needs a number';
        continue;
      }
      out.pr = Number(v);
      continue;
    }
    if (a === '--remote') {
      const v = argv[i + 1];
      i += 1;
      if (v === undefined) {
        out.error = '--remote needs a value';
        continue;
      }
      out.remote = v;
      continue;
    }
    out.error = `unrecognised argument ${JSON.stringify(a)}`;
  }
  return out;
}

const USAGE = `usage: node scripts/check-behind-base.mjs --pr <number> [--remote <name>]

Refuses to report a pull request safe to merge while its base carries commits
the head has never been tested against — the gap that let #322 merge BEHIND
and break trunk under a strict:true that enforce_admins:false exempted the
sole admin from.

  0 up to date · 1 BEHIND, do not merge · 2 undetermined
`;

/**
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {number}
 */
export function main(argv, env = process.env, run = spawnSync) {
  try {
    return runMain(argv, env, run);
  } catch (err) {
    console.error(
      `check-behind-base failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Exit 2, not a pass and not a finding about the pull request.',
    );
    return EXIT_UNDETERMINED;
  }
}

/**
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {number}
 */
function runMain(argv, env, run) {
  const args = parseArgs([...argv]);
  if (args.help) {
    console.log(USAGE);
    return EXIT_UP_TO_DATE;
  }
  if (args.error !== undefined) {
    console.error(args.error);
    console.error(USAGE);
    return EXIT_UNDETERMINED;
  }
  if (args.pr === undefined) {
    console.error('--pr is required');
    console.error(USAGE);
    return EXIT_UNDETERMINED;
  }

  const token = discoverToken(env, run);
  if (token === null || token === '') {
    console.error(
      'no GitHub credential found, so BEHIND-ness could not be determined. This is exit 2, not a pass.',
    );
    return EXIT_UNDETERMINED;
  }
  const repository = resolveRepositorySlug(env, run);
  if (!repository) {
    console.error('could not resolve the repository. Exit 2, not a pass.');
    return EXIT_UNDETERMINED;
  }

  const view = runGh(
    run,
    [
      'pr',
      'view',
      String(args.pr),
      '--repo',
      repository,
      '--json',
      'baseRefName,headRefOid',
    ],
    { ...env, GH_TOKEN: token },
  );
  if (!view.spawned || view.status !== 0) {
    console.error(
      `gh pr view failed: ${view.stderr.trim() || 'no output'}. Exit 2, not a pass.`,
    );
    return EXIT_UNDETERMINED;
  }
  /** @type {{baseRefName?: string, headRefOid?: string}} */
  let parsed;
  try {
    parsed = JSON.parse(view.stdout);
  } catch {
    console.error('could not parse gh output. Exit 2, not a pass.');
    return EXIT_UNDETERMINED;
  }
  const baseRefName = parsed.baseRefName;
  const headRefOid = parsed.headRefOid;
  if (!baseRefName || !headRefOid) {
    console.error(
      'gh reported no baseRefName/headRefOid for this PR. Exit 2, not a pass.',
    );
    return EXIT_UNDETERMINED;
  }

  const headRef = fetchPrHead(String(args.pr), args.remote);
  if (!headRef) {
    console.error(
      `could not fetch refs/pull/${args.pr}/head from ${args.remote}. Exit 2, not a pass.`,
    );
    return EXIT_UNDETERMINED;
  }
  // gh's report and the ref just fetched are two reads of the same object,
  // seconds apart. If they disagree the PR moved between them, and answering
  // against a fetched SHA that is not the one just reported would be a verdict
  // about a commit the caller did not ask about.
  const fetchedHeadSha = resolveCommit(headRef);
  if (fetchedHeadSha !== null && fetchedHeadSha !== headRefOid) {
    console.error(
      `refs/pull/${args.pr}/head resolved to ${fetchedHeadSha}, but gh reported ` +
        `headRefOid ${headRefOid} moments earlier — the PR moved mid-check. Exit 2, not a pass.`,
    );
    return EXIT_UNDETERMINED;
  }

  const baseState = fetchBase(`${args.remote}/${baseRefName}`, args.remote);
  if (baseState.refreshable && !baseState.fresh) {
    console.error(
      `could not refresh ${args.remote}/${baseRefName} from ${args.remote}; a "not ` +
        'behind" answer below would be about this clone, not about the branch. Exit 2, not a pass.',
    );
    return EXIT_UNDETERMINED;
  }

  const baseIsAncestorOfHead = isAncestor(baseState.ref, headRef);
  const result = evaluateBehindBase({ baseIsAncestorOfHead });
  console.log(formatResult(args.pr, baseRefName, result));
  return result.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
