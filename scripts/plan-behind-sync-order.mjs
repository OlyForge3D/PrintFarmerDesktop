// Serializes base-syncs across BEHIND pull requests instead of letting them
// fire at once.
//
// Why this exists (#263). Measured on 2026-08-04: six `CI` runs entered within
// eleven seconds, fanning out to ~40 jobs, and the PR whose jobs happened to
// queue behind that burst took 2x as long wall-clock as one that entered the
// same second but got a clean run — same sum of job time (30.7-32.6 min) in
// both cases, all of the difference is start spread waiting for a runner.
// `.squad/decisions.md` already bans doing this to *merges* ("Merge one PR at
// a time" -- two `gh pr merge` calls seconds apart orphaned a commit). This is
// the same shape one step earlier: a base-sync is a push, a push launches a
// full CI fan-out, and syncing several BEHIND PRs in the same round launches
// several fan-outs into the same contended runner pool at once. Worse, each
// fan-out that is starved takes longer, stays BEHIND longer, and is more
// likely to need ANOTHER sync before the next trunk commit lands -- the
// feedback loop the issue names. #248 base-synced four times in one session
// (09:12, 10:19, 11:21Z) and never merged.
//
// This module does not perform a sync (it does not rebase or push a PR branch
// -- that is still the owning session's own branch to rewrite, per
// `.squad/skills/git-workflow/SKILL.md`'s "never rebase or merge around" rule
// for work you do not own). It answers a narrower, safe question: given the
// set of currently-open pull requests, and which of them are BEHIND their own
// base, what is the single next one, REPO-WIDE, to sync, and how long to wait
// before considering the next?
//
// #263 IS GLOBAL, NOT PER-BASE (Hicks and Vasquez, external review round on
// PR #681, after the local three-way review below had already approved a
// per-base-grouped version). `.github/workflows/ci.yml`'s `pull_request:`
// trigger fans every push out to the SAME shared GitHub-hosted runner pool
// regardless of which branch it targets -- a sync against `development` and a
// sync against `release/1.x` in the same round launch two full CI fan-outs
// into that one contended pool just as surely as two syncs against the same
// base would. An earlier version of this module grouped `planSyncOrder`'s
// output by `baseRefName` and returned one independent `{next, queued}` plan
// per base, on Hicks's pre-PR-review-round-1 reasoning that "syncing #10
// (development) says nothing about whether #11 (release/1.x) is BEHIND" --
// which is true of the ANCESTRY QUESTION `surveyBehindPrs` answers (that stays
// per-base: a PR's BEHIND-ness is only meaningful relative to its own base,
// and `surveyBehindPrs`'s per-base fetch/cache/ancestry logic is unchanged).
// It does not follow for the SCHEDULING QUESTION `planSyncOrder` answers: the
// resource being serialized against is the runner pool, and the runner pool is
// one pool, not one per base branch. Recommending a "next" for `development`
// AND a "next" for `release/1.x` in the same round is exactly the multi-fan-out
// burst #263 measured, just spread across two labelled sections instead of
// one flat list. `planSyncOrder` now returns ONE global `{next, queued}`
// across every base, oldest-`createdAt` first exactly as before, with each
// candidate still carrying its own `baseRefName` for display.
//
// ADVISORY ALONE IS NOT ENOUGH (Vasquez, same external review round): a plan
// that only ever PRINTS a recommendation does not stop two concurrent
// invocations -- two sessions, or two rounds of the same session close
// together -- from both reading the same "sync PR #N next" and both acting on
// it, which reintroduces the exact multi-fan-out burst the plan exists to
// prevent. `claimSyncLease`/`readSyncLease` add a real mutual-exclusion
// primitive: a dedicated ref, `SYNC_LEASE_REF`, that records which PR
// currently "holds the floor" and until when, updated only via
// `git push --force-with-lease`, which GitHub's own ref-update machinery
// enforces atomically server-side -- a losing racer's push is rejected, not
// silently overwritten (verified empirically against a scratch bare
// repository: an empty-string `--force-with-lease` expect value requires the
// ref not yet exist, a stale expect value is rejected with "stale info", and
// the CURRENT tip as the expect value succeeds -- see the commit that added
// this comment for the exact commands run). The lease is a plain commit
// (parented on the well-known empty tree, so it is never expected to carry a
// working tree) whose message is a small JSON object; reading it back needs
// nothing more than `git fetch` + `git log --format=%B`, so no new dependency
// or network protocol is introduced. This still does not perform the sync
// itself, and by default `main` does not claim anything -- claiming is opt-in
// via `--claim`, so a plain read-only invocation (e.g. a human just asking
// "what's next") has zero side effects, same as before.
//
// A PR that cannot be classified — its base could not be refreshed, its head
// moved mid-survey, or its ref could not be fetched — is reported in
// `skipped`, not silently dropped (Hicks, local pre-PR review round 1): an
// earlier draft omitted such PRs from the candidate list entirely, which made
// an INCOMPLETE survey print the identical "nothing to sync" that a genuinely
// clean one would, collapsing "could not tell" into "confirmed clear" — the
// exact shape `.squad/known-lying-commands.md` catalogues.
//
// planSyncOrder is pure and takes already-classified facts, so its ordering
// logic is testable without a live repository. surveyBehindPrs is the one
// function that talks to `gh`/`git`, and it is a thin composition of the
// primitives `check-behind-base.mjs` and `sha-status.mjs` already ship --
// `evaluateBehindBase`, `isAncestor`, `fetchBase`, `fetchPrHead`,
// `resolveCommit` -- reused here rather than re-derived, because
// `check-behind-base.mjs` already hardened those primitives against the traps
// in this family (a missing ref exits 128, not 1; a remote-tracking ref is a
// cache and must be refreshed before its ancestry is trusted).

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  isAncestor,
  fetchBase,
  fetchPrHead,
  resolveCommit,
} from './sha-status.mjs';
import { evaluateBehindBase } from './check-behind-base.mjs';
import { discoverToken } from './check-merge-queue-contexts.mjs';
import { runGh, resolveRepositorySlug } from './check-required-contexts.mjs';

/**
 * @typedef {{number: number, createdAt: string, baseRefName: string, behind: boolean}} BehindCandidate
 */

/**
 * @typedef {{number: number, reason: string}} SkippedPr
 */

/**
 * Pure ordering. Oldest-`createdAt` first among the currently-BEHIND set: an
 * older PR has had more time to accumulate risk of being starved again by the
 * feedback loop the issue names, and finishing it first shrinks the BEHIND set
 * for everyone still waiting rather than picking arbitrarily. PR number is the
 * tie-breaker, for the same reason `.squad/agents/ralph/loop.md`'s queue order
 * (§4.3) uses it: deterministic across identical timestamps, particularly
 * relevant here since `createdAt` truncates to the second and a burst of PRs
 * opened by automation can collide on it.
 *
 * Only ONE entry is returned as "sync now" -- the rest are explicitly `queued`,
 * not "sync all of these". A caller that syncs the whole returned list at once
 * has reintroduced the exact contention this script exists to prevent; the
 * shape of the return value is deliberately not a flat list of things to do.
 *
 * ONE GLOBAL QUEUE, NOT ONE PER BASE (Hicks and Vasquez, external review round
 * on PR #681): the resource this serializes against is the shared CI runner
 * pool `.github/workflows/ci.yml`'s `pull_request:` trigger fans every push
 * into, and that pool is one pool regardless of which base branch a sync
 * targets. An earlier version of this function grouped by `baseRefName` and
 * returned one independent plan per base (on the reasoning, still correct on
 * its own terms, that #10's BEHIND-ness against `development` says nothing
 * about whether #11 is BEHIND `release/1.x`) -- but recommending a "next" for
 * `development` AND a separate "next" for `release/1.x` in the same round
 * launches two full CI fan-outs into the same pool at once, which is exactly
 * the multi-fan-out burst #263 measured. `surveyBehindPrs` still evaluates
 * and caches ancestry per base (that classification question stays per-base);
 * this function flattens the classified results into ONE queue afterwards,
 * because the SCHEDULING question is global.
 *
 * @param {readonly BehindCandidate[]} candidates
 * @returns {{next: BehindCandidate | null, queued: BehindCandidate[]}}
 */
export function planSyncOrder(candidates) {
  const behind = candidates.filter((c) => c.behind);
  const sorted = behind.slice().sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.number - b.number;
  });
  const [next, ...queued] = sorted;
  return { next: next ?? null, queued };
}

/**
 * @param {{next: BehindCandidate | null, queued: BehindCandidate[]}} plan
 * @param {readonly SkippedPr[]} skipped
 * @param {SyncLease | null} [activeLease] an unexpired lease read via
 *   `readSyncLease`, or null/undefined when there is none. Passing an expired
 *   lease is the caller's mistake, not this function's to detect -- it has no
 *   clock of its own and takes the lease as already resolved to "active or
 *   not" by whoever read it (see `main`, which resolves this against a single
 *   `now` shared with the expiry check).
 * @returns {string}
 */
export function formatPlan(plan, skipped, activeLease = null) {
  const lines = [];
  const allBehind = plan.next !== null ? [plan.next, ...plan.queued] : [];

  if (activeLease !== null) {
    // A sync is already in flight for SOME PR -- possibly one that no longer
    // shows up as BEHIND in this very survey (a sync's whole point is to make
    // its PR stop being BEHIND), so this branches before, not alongside, the
    // "next" recommendation: recommending a second "next" while one sync is
    // already running is the same multi-fan-out burst as recommending one
    // per base used to be.
    lines.push(
      `A base-sync is already in flight for PR #${activeLease.prNumber} ` +
        `(claimed ${activeLease.claimedAt}, lease expires ${activeLease.expiresAt}). ` +
        'Do not start another sync until this one concludes or the lease expires -- ' +
        'firing multiple base-syncs at once, even against different base branches, ' +
        'launches multiple CI fan-outs into the same contended runner pool (#263).',
    );
    if (allBehind.length > 0) {
      lines.push(
        '',
        `Still queued behind the in-flight lease, oldest first (do not sync these yet): ${allBehind
          .map((c) => `#${c.number} (${c.baseRefName})`)
          .join(', ')}.`,
      );
    }
  } else if (plan.next !== null) {
    lines.push(
      `Sync PR #${plan.next.number} next (BEHIND ${plan.next.baseRefName}, opened ${plan.next.createdAt}).`,
      'Rebase it onto the latest base, push, and wait for that CI run to reach a',
      'conclusion (or for the PR to merge) before starting the next sync -- firing',
      'multiple base-syncs in the same round is the contention #263 measured, and',
      'that holds ACROSS base branches too: every base-sync launches a full CI',
      'fan-out into the SAME shared runner pool, regardless of which branch it targets.',
    );
    if (plan.queued.length > 0) {
      lines.push(
        `Still queued, oldest first (do not sync these yet): ${plan.queued
          .map((c) => `#${c.number} (${c.baseRefName})`)
          .join(', ')}.`,
      );
    }
  } else if (skipped.length === 0) {
    lines.push('No open pull request is BEHIND its base. Nothing to sync.');
  }

  // Hicks, local pre-PR review round 1: a PR whose base could not be
  // refreshed, or whose head moved mid-survey, was previously dropped
  // silently -- so an incomplete survey printed the same "nothing to sync" as
  // a genuinely clean one. UNDETERMINED is not "no sync needed"; it has to
  // say so, the same distinction check-behind-base.mjs's own exit-2 taxonomy
  // insists on for a single PR.
  if (skipped.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      'Could not determine BEHIND status for the following -- NOT confirmed clear, ' +
        'do not read their absence above as "safe":',
    );
    for (const s of skipped) {
      lines.push(`  #${s.number}: ${s.reason}`);
    }
  }

  return lines.join('\n');
}

/**
 * @typedef {{prNumber: number, claimedAt: string, expiresAt: string}} SyncLease
 */

/**
 * Dedicated ref this module claims a lease on. Not under `refs/heads/` or
 * `refs/tags/`, and not under `refs/pull/` (GitHub-managed) -- a plain custom
 * ref, exactly like `refs/tmp/sha-status/*` (see sha-status.mjs) except this
 * one is pushed to the REMOTE rather than kept local, because the whole point
 * is for every session/round to see the same lease.
 */
export const SYNC_LEASE_REF = 'refs/behind-sync-lease/current';

/** How long a claimed lease is honoured before a new claim may replace it
 * without contest, in case the session that claimed it never releases (a
 * crash, or simply forgetting) -- an un-expiring lease would permanently wedge
 * every future sync behind a session that is no longer running. 30 minutes is
 * a generous upper bound for a single CI fan-out to reach a conclusion; this
 * module's own guidance already says to wait for that conclusion before
 * starting the next sync, so a lease that outlives it by this much is
 * assumed abandoned, not merely slow. */
export const LEASE_TTL_MS = 30 * 60 * 1000;

/** The empty tree's well-known object id -- identical in every git
 * repository, since it is defined purely by the hash of zero tree entries.
 * Used as the lease commit's tree so `git commit-tree` never needs a real
 * working tree or index to produce a valid commit object. */
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * @param {string} message
 * @returns {SyncLease | null}
 */
function parseLeaseMessage(message) {
  try {
    const parsed = JSON.parse(message.trim());
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (/** @type {Record<string, unknown>} */ (parsed).prNumber) ===
        'number' &&
      typeof (/** @type {Record<string, unknown>} */ (parsed).claimedAt) ===
        'string' &&
      typeof (/** @type {Record<string, unknown>} */ (parsed).expiresAt) ===
        'string'
    ) {
      return /** @type {SyncLease} */ (parsed);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {SyncLease} lease
 * @param {number} now epoch ms
 * @returns {boolean}
 */
export function isLeaseExpired(lease, now) {
  const expiry = new Date(lease.expiresAt).getTime();
  return !Number.isFinite(expiry) || expiry <= now;
}

/**
 * Reads whatever lease is currently recorded on `remote`, without claiming
 * anything. Fetches the ref into a private local ref first (mirroring
 * `fetchPrHead`/`fetchBase` in sha-status.mjs) rather than trying to read the
 * remote object directly, because reading a commit's message needs the object
 * present locally, and `git ls-remote` alone only returns the object id.
 *
 * A ref that has never been claimed makes `git fetch` exit non-zero (verified
 * empirically: `fatal: couldn't find remote ref ...`, exit 128) -- that is
 * "no lease", not an error to surface, so it is folded into `{lease: null}`
 * the same way a first-ever claim is expected to find nothing to replace.
 *
 * The commit id (`oid`) is returned alongside the parsed lease, EXPIRED OR
 * NOT, because `claimSyncLease` needs it as the compare-and-swap base even
 * when the lease it names has expired -- an expired lease is still a real ref
 * state on the remote, and a claim that raced ahead of this read must still
 * be detected, not silently overwritten.
 *
 * @param {string} remote
 * @param {typeof spawnSync} run
 * @returns {{lease: SyncLease | null, oid: string | null}}
 */
export function readSyncLease(remote, run) {
  const local = 'refs/tmp/behind-sync-lease/read';
  const fetch = run(
    'git',
    ['fetch', '--quiet', remote, `${SYNC_LEASE_REF}:${local}`],
    { encoding: 'utf8' },
  );
  if (fetch.status !== 0) {
    return { lease: null, oid: null };
  }
  const oidResult = run('git', ['rev-parse', local], { encoding: 'utf8' });
  const oid =
    oidResult.status === 0 ? String(oidResult.stdout ?? '').trim() : null;
  const msgResult = run('git', ['log', '-1', '--format=%B', local], {
    encoding: 'utf8',
  });
  if (msgResult.status !== 0) {
    return { lease: null, oid };
  }
  return { lease: parseLeaseMessage(String(msgResult.stdout ?? '')), oid };
}

/**
 * Attempts to atomically claim the lease for `prNumber`. Refuses up front,
 * without even attempting a push, when a DIFFERENT PR already holds an
 * unexpired lease -- that is the whole serialization guarantee, and it must
 * hold even if this process's own push would otherwise succeed. Re-claiming
 * for the SAME `prNumber` (e.g. refreshing before the TTL runs out) is always
 * allowed.
 *
 * The push itself is the actual mutual-exclusion primitive:
 * `--force-with-lease=<ref>:<expect>` is enforced by the remote atomically, so
 * two processes racing to claim at once can never both succeed -- one push
 * lands, the other is rejected with "stale info" (verified empirically
 * against a scratch bare repository; see the module header comment). An empty
 * `<expect>` requires the ref not yet exist remotely (also verified), which is
 * how the very first claim ever made is expressed.
 *
 * @param {number} prNumber
 * @param {string} remote
 * @param {typeof spawnSync} run
 * @param {{now?: number, ttlMs?: number}} [options]
 * @returns {{claimed: boolean, reason?: string}}
 */
export function claimSyncLease(
  prNumber,
  remote,
  run,
  { now = Date.now(), ttlMs = LEASE_TTL_MS } = {},
) {
  const { lease, oid } = readSyncLease(remote, run);
  if (
    lease !== null &&
    !isLeaseExpired(lease, now) &&
    lease.prNumber !== prNumber
  ) {
    return {
      claimed: false,
      reason: `lease already held by PR #${lease.prNumber} until ${lease.expiresAt}.`,
    };
  }

  const claimedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const message = JSON.stringify({ prNumber, claimedAt, expiresAt });
  const commitResult = run(
    'git',
    ['commit-tree', EMPTY_TREE_OID, '-m', message],
    { encoding: 'utf8' },
  );
  if (commitResult.status !== 0) {
    return {
      claimed: false,
      reason: 'could not create the lease commit object.',
    };
  }
  const newOid = String(commitResult.stdout ?? '').trim();
  const expect = oid ?? '';
  const push = run(
    'git',
    [
      'push',
      remote,
      `${newOid}:${SYNC_LEASE_REF}`,
      `--force-with-lease=${SYNC_LEASE_REF}:${expect}`,
    ],
    { encoding: 'utf8' },
  );
  if (push.status !== 0) {
    return {
      claimed: false,
      reason:
        'lost the race to claim the lease -- another session updated it first.',
    };
  }
  return { claimed: true };
}

/**
 * The one function in this module that touches `gh`/`git`. Surveys every open
 * pull request against its own base and classifies each as BEHIND or not,
 * using the same primitives `check-behind-base.mjs` uses for a single PR.
 *
 * Every PR that cannot be classified is reported in `skipped` with why, rather
 * than silently omitted (Hicks, pre-PR review round 1: an omitted PR and a
 * confirmed-not-BEHIND PR looked identical to `formatPlan`, so an incomplete
 * survey printed the same "nothing to sync" as a genuinely clean one — the
 * exact "absence read as a measured clear" shape `.squad/known-lying-commands.md`
 * exists to catch).
 *
 * @param {{remote?: string}} opts
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {{candidates: BehindCandidate[], skipped: SkippedPr[]} | {error: string}}
 */
export function surveyBehindPrs(opts, env = process.env, run = spawnSync) {
  const remote = opts.remote ?? 'origin';
  const token = discoverToken(env, run);
  if (token === null || token === '') {
    return {
      error:
        'no GitHub credential found, so the open PR set could not be surveyed.',
    };
  }
  const repository = resolveRepositorySlug(env, run);
  if (!repository) {
    return { error: 'could not resolve the repository.' };
  }

  // `gh pr list` returns at most PR_LIST_LIMIT results with no indication of
  // whether more exist -- if the open PR count happens to equal the limit
  // exactly, that looks identical to "these are all of them" (Hicks, pre-PR
  // review round 4: a real open-PR count above this cap would silently
  // survey only part of the set, and the "next to sync" recommendation would
  // be about that partial view, not the true set of open PRs). Detecting
  // that the result is exactly PR_LIST_LIMIT long and erroring rather than
  // proceeding keeps this the same shape as every other undetermined case in
  // this module: report "cannot tell", never guess.
  const PR_LIST_LIMIT = 200;
  const list = runGh(
    run,
    [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--json',
      'number,createdAt,baseRefName,headRefOid',
      '--limit',
      String(PR_LIST_LIMIT),
    ],
    { ...env, GH_TOKEN: token },
  );
  if (!list.spawned || list.status !== 0) {
    return {
      error: `gh pr list failed: ${list.stderr.trim() || 'no output'}.`,
    };
  }
  /** @type {Array<{number: number, createdAt: string, baseRefName: string, headRefOid: string}>} */
  let prs;
  try {
    prs = JSON.parse(list.stdout);
  } catch {
    return { error: 'could not parse gh pr list output.' };
  }
  if (prs.length === PR_LIST_LIMIT) {
    return {
      error:
        `gh pr list returned exactly the --limit ${PR_LIST_LIMIT} cap, so this ` +
        'repository may have more open pull requests than were surveyed. ' +
        'Refusing to recommend a next PR to sync from a possibly-partial view ' +
        'of the open set.',
    };
  }
  if (prs.length === 0) {
    return { candidates: [], skipped: [] };
  }

  // fetchBase always refreshes the *same* shared local ref
  // (refs/tmp/sha-status/base, per scripts/sha-status.mjs) regardless of which
  // base branch it was asked to fetch. Caching only the returned `ref` string
  // per baseRefName is therefore not safe across a loop that fetches more than
  // one distinct base: a later fetch for a different base repoints that same
  // local ref, so a cached entry's `.ref` can silently resolve to the WRONG
  // base's commit by the time it is read again (Hicks, pre-PR review round
  // 2). Resolving the fetched ref to a full commit id immediately, and
  // caching that resolved SHA instead of the transient ref name, makes the
  // cache immune to later fetches overwriting the shared local ref.
  /** @type {Map<string, {sha: string | null, refreshable: boolean, fresh: boolean}>} */
  const baseCache = new Map();
  /** @type {BehindCandidate[]} */
  const candidates = [];
  /** @type {SkippedPr[]} */
  const skipped = [];
  for (const pr of prs) {
    let baseState = baseCache.get(pr.baseRefName);
    if (baseState === undefined) {
      const fetched = fetchBase(`${remote}/${pr.baseRefName}`, remote);
      baseState = {
        sha: fetched.fresh ? resolveCommit(fetched.ref) : null,
        refreshable: fetched.refreshable,
        fresh: fetched.fresh,
      };
      baseCache.set(pr.baseRefName, baseState);
    }
    if (baseState.refreshable && !baseState.fresh) {
      skipped.push({
        number: pr.number,
        reason: `base ${pr.baseRefName} could not be refreshed from ${remote}.`,
      });
      continue;
    }
    if (baseState.sha === null) {
      skipped.push({
        number: pr.number,
        reason: `base ${pr.baseRefName} could not be resolved to a commit.`,
      });
      continue;
    }
    const headRef = fetchPrHead(String(pr.number), remote);
    if (!headRef) {
      skipped.push({
        number: pr.number,
        reason: `could not fetch refs/pull/${pr.number}/head from ${remote}.`,
      });
      continue;
    }
    const fetchedHeadSha = resolveCommit(headRef);
    if (fetchedHeadSha !== null && fetchedHeadSha !== pr.headRefOid) {
      skipped.push({
        number: pr.number,
        reason:
          'moved between gh reporting its head and this fetch resolving it.',
      });
      continue;
    }
    const ancestry = isAncestor(baseState.sha, headRef);
    if (ancestry === null) {
      // Hicks, pre-PR review round 2: this branch previously fell through to
      // evaluateBehindBase, which itself returns 'undetermined' for a null
      // ancestry check -- but the caller here read only `state === 'behind'`,
      // silently treating 'undetermined' the same as 'not behind'. Report it
      // as skipped instead, matching check-behind-base.mjs's own exit-2
      // taxonomy: undetermined is never evidence of "not behind".
      skipped.push({
        number: pr.number,
        reason: `could not determine whether #${pr.number} is behind ${pr.baseRefName} (git merge-base --is-ancestor was inconclusive).`,
      });
      continue;
    }
    const result = evaluateBehindBase({ baseIsAncestorOfHead: ancestry });
    candidates.push({
      number: pr.number,
      createdAt: pr.createdAt,
      baseRefName: pr.baseRefName,
      behind: result.state === 'behind',
    });
  }
  return { candidates, skipped };
}

const USAGE = `usage: node scripts/plan-behind-sync-order.mjs [--remote <name>] [--claim]

Surveys open pull requests, REPO-WIDE (not per base branch -- every base-sync
shares the same contended CI runner pool, see the header comment), and reports
the single next one to base-sync, serialized rather than all at once (#263).

--claim   After reporting, if there is a next PR to sync AND no lease is
          currently active for a different PR, attempt to atomically claim
          the sync lease for it (git push --force-with-lease). A caller that
          is actually about to perform the sync should pass this so a second,
          concurrent invocation sees the lease and reports "already in
          flight" instead of recommending the same PR again. Omitted by
          default: a plain read-only invocation has no side effects.
`;

/**
 * @param {readonly string[]} argv
 * @returns {{remote?: string, help?: boolean, claim?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  /** @type {{remote?: string, help?: boolean, claim?: boolean, error?: string}} */
  const out = { remote: 'origin' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--claim') {
      out.claim = true;
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
      `plan-behind-sync-order failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
    return 2;
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
    return 0;
  }
  if (args.error !== undefined) {
    console.error(args.error);
    console.error(USAGE);
    return 2;
  }

  const survey = surveyBehindPrs({ remote: args.remote }, env, run);
  if ('error' in survey) {
    console.error(`${survey.error} Exit 2, not a pass.`);
    return 2;
  }
  const plan = planSyncOrder(survey.candidates);

  const remote = args.remote ?? 'origin';
  const now = Date.now();
  const { lease } = readSyncLease(remote, run);
  const activeLease =
    lease !== null && !isLeaseExpired(lease, now) ? lease : null;

  console.log(formatPlan(plan, survey.skipped, activeLease));

  // --claim is opt-in: a plain read-only invocation (the default) never
  // pushes anything, matching the "this module does not perform a sync"
  // contract in the header comment. Only a caller that is actually about to
  // act on the recommendation should ask this to also reserve it.
  if (args.claim && activeLease === null && plan.next !== null) {
    const result = claimSyncLease(plan.next.number, remote, run, { now });
    if (result.claimed) {
      console.log(
        `Claimed the sync lease for PR #${plan.next.number}. Release it by ` +
          'letting it expire once the sync CI run concludes -- there is no ' +
          'explicit release call, by design: an explicit release requires the ' +
          'claimer to run again to clean up, and a crashed or abandoned ' +
          'claimer would then wedge the lease forever instead of merely for ' +
          'its TTL.',
      );
    } else {
      console.log(
        `Could not claim the sync lease: ${result.reason ?? 'unknown reason.'}`,
      );
    }
  }

  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
