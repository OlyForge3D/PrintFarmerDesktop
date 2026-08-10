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
// This module does not perform a sync (it does not rebase or push -- that is
// still the owning session's own branch to rewrite, per
// `.squad/skills/git-workflow/SKILL.md`'s "never rebase or merge around" rule
// for work you do not own). It answers a narrower, safe question: given the
// set of currently-open pull requests against a base, and which of them are
// BEHIND, what is the single next one to sync, and how long to wait before
// considering the next? Driving that queue one entry at a time, waiting for
// its CI to conclude before starting the next sync, is what keeps the fan-outs
// from overlapping.
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
 * @typedef {{number: number, createdAt: string, behind: boolean}} BehindCandidate
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
 * @param {readonly BehindCandidate[]} candidates
 * @returns {{next: BehindCandidate | null, queued: BehindCandidate[]}}
 */
export function planSyncOrder(candidates) {
  const behind = candidates
    .filter((c) => c.behind)
    .slice()
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? -1 : 1;
      }
      return a.number - b.number;
    });
  if (behind.length === 0) {
    return { next: null, queued: [] };
  }
  const [next, ...queued] = behind;
  return { next, queued };
}

/**
 * @param {{next: BehindCandidate | null, queued: BehindCandidate[]}} plan
 * @param {string} baseRefName
 * @returns {string}
 */
export function formatPlan(plan, baseRefName) {
  if (plan.next === null) {
    return `No open pull request is BEHIND ${baseRefName}. Nothing to sync.`;
  }
  const lines = [
    `Sync PR #${plan.next.number} next (BEHIND ${baseRefName}, opened ${plan.next.createdAt}).`,
    'Rebase it onto the latest base, push, and wait for that CI run to reach a',
    'conclusion (or for the PR to merge) before starting the next sync -- firing',
    'multiple base-syncs in the same round is the contention #263 measured.',
  ];
  if (plan.queued.length > 0) {
    lines.push('');
    lines.push(
      `Still queued behind it, oldest first (do not sync these yet): ${plan.queued
        .map((c) => `#${c.number}`)
        .join(', ')}.`,
    );
  }
  return lines.join('\n');
}

/**
 * The one function in this module that touches `gh`/`git`. Surveys every open
 * pull request against `baseRefName` and classifies each as BEHIND or not,
 * using the same primitives `check-behind-base.mjs` uses for a single PR.
 *
 * @param {{remote?: string}} opts
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {{candidates: BehindCandidate[], baseRefName: string} | {error: string}}
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
      '200',
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
  if (prs.length === 0) {
    return { candidates: [], baseRefName: 'development' };
  }

  /** @type {Map<string, {ref: string, refreshable: boolean, fresh: boolean}>} */
  const baseCache = new Map();
  /** @type {BehindCandidate[]} */
  const candidates = [];
  for (const pr of prs) {
    let baseState = baseCache.get(pr.baseRefName);
    if (baseState === undefined) {
      baseState = fetchBase(`${remote}/${pr.baseRefName}`, remote);
      baseCache.set(pr.baseRefName, baseState);
    }
    if (baseState.refreshable && !baseState.fresh) {
      // This PR's base could not be refreshed; do not guess at its state.
      continue;
    }
    const headRef = fetchPrHead(String(pr.number), remote);
    if (!headRef) continue;
    const fetchedHeadSha = resolveCommit(headRef);
    if (fetchedHeadSha !== null && fetchedHeadSha !== pr.headRefOid) {
      // Moved mid-survey; skip rather than answer about a stale head.
      continue;
    }
    const result = evaluateBehindBase({
      baseIsAncestorOfHead: isAncestor(baseState.ref, headRef),
    });
    candidates.push({
      number: pr.number,
      createdAt: pr.createdAt,
      behind: result.state === 'behind',
    });
  }
  const baseRefName = prs[0]?.baseRefName ?? 'development';
  return { candidates, baseRefName };
}

const USAGE = `usage: node scripts/plan-behind-sync-order.mjs [--remote <name>]

Surveys open pull requests and reports the single next one to base-sync,
serialized rather than all at once -- see the header comment for why (#263).
`;

/**
 * @param {readonly string[]} argv
 * @returns {{remote?: string, help?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  /** @type {{remote?: string, help?: boolean, error?: string}} */
  const out = { remote: 'origin' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
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
  console.log(formatPlan(plan, survey.baseRefName));
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
