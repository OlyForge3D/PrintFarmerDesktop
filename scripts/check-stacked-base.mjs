#!/usr/bin/env node
// Refuse a pull request whose base branch has already landed.
//
// THE INCIDENT THIS EXISTS FOR, measured rather than imagined:
//
//   #384  merged into development                    2026-08-05 00:51:15Z
//   #386  merged into jpapiez-vasquez-merge-queue-credential
//                                                    2026-08-05 00:51:22Z
//
// Seven seconds. #384 is the pull request whose head branch #386 was stacked
// on. GitHub squash-merged #384 onto development and left its branch behind;
// seven seconds later #386 merged onto that branch. Both operations reported
// success. #386 shows MERGED to this day. Its file,
// scripts/check-protection-assumptions.mjs, was absent from development for
// hours, and was noticed only because a human went looking for it.
//
// WHY EVERY EXISTING CHECK IS SILENT HERE:
//
//   - scripts/push-guard.mjs adjudicates force-pushes. No force-push occurred;
//     allow_force_pushes is false repo-wide.
//   - scripts/merge-survival.mjs asks "did the merge introduce the change the
//     branch introduced". Run against #386 it answers INTACT, exit 0 — and it
//     is CORRECT. The merge of #386 faithfully carried the change onto its
//     base. The loss is not in that merge; it is that the base itself was
//     already spent. Every individual merge in the chain was honest.
//   - --is-ancestor, blob comparison, log -S and reverse-apply were all tried
//     against this question and all fail. Reverse-apply was measured against
//     30 merged pull requests and detected 0 of them; it is not in this file
//     for that reason.
//
// So the loss is not detectable by comparing content at all. It is STRUCTURAL,
// and the structure is cheap to read: a pull request based on a branch whose
// own pull request has already been merged or closed is writing into a branch
// that nothing will carry forward.
//
// DOMAIN, stated plainly so nobody reads more into a pass than is there:
//
// This check runs on `pull_request`. It observes the base branch's state when
// it runs, not at the instant of merge. The #386 window was seven seconds, and
// no pull_request-triggered check can see inside a window that small — the run
// that mattered had already finished. What this check does catch is the
// durable form, where the base landed minutes or hours before, which is the
// shape every such stack spends almost all of its life in. It narrows the
// hazard to a race; it does not eliminate it. Claiming otherwise would make
// this a reassurance rather than a control.
//
// Exit codes: 0 the base is live, 1 the base has landed, 2 the base cannot be
// read. An unreadable base must never exit 0 — fail-open is precisely how #386
// merged green.

import { pathToFileURL } from 'node:url';

import {
  resolvePullRequestNumber,
  resolveRepository,
} from './check-pr-closure-scope.mjs';

const API_ROOT = 'https://api.github.com';

export const VERDICT_NOT_STACKED = 'not-stacked';
export const VERDICT_BASE_LIVE = 'base-live';
export const VERDICT_BASE_LANDED = 'base-landed';
export const VERDICT_BASE_UNKNOWN = 'base-unknown';

// Pure, and pure on purpose. Every arm below is reachable from a plain object,
// so a test can drive all four without a network, a clone, or a fixture repo.
// A judgement arm that only a live API can provoke is an arm no test binds —
// tests/mergeSurvival.test.ts shipped with exactly that defect and it took a
// deliberate mutation to notice, because deleting the arm broke nothing.
export function classifyStackedBase({
  baseRef,
  defaultBranch,
  basePullRequest,
} = {}) {
  if (typeof baseRef !== 'string' || baseRef === '') {
    throw new Error('baseRef is required');
  }
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    throw new Error('defaultBranch is required');
  }

  if (baseRef === defaultBranch) {
    return {
      verdict: VERDICT_NOT_STACKED,
      exitCode: 0,
      reason: `base is the default branch (${defaultBranch})`,
    };
  }

  // No pull request for the base branch. This is NOT evidence that the base is
  // fine; it is the absence of evidence either way, and the whole failure mode
  // here is an absence being read as an all-clear.
  if (!basePullRequest) {
    return {
      verdict: VERDICT_BASE_UNKNOWN,
      exitCode: 2,
      reason:
        `base branch ${baseRef} is not the default branch and has no pull request of its own, ` +
        'so there is nothing that will carry this work to the default branch and no way to tell whether anything will',
    };
  }

  const state = String(basePullRequest.state ?? '').toLowerCase();

  if (state === 'open') {
    return {
      verdict: VERDICT_BASE_LIVE,
      exitCode: 0,
      reason: `base branch ${baseRef} belongs to open pull request #${basePullRequest.number}`,
    };
  }

  if (state === 'closed' || state === 'merged') {
    const landed = basePullRequest.mergedAt
      ? 'merged'
      : 'closed without merging';
    return {
      verdict: VERDICT_BASE_LANDED,
      exitCode: 1,
      reason:
        `base branch ${baseRef} belongs to pull request #${basePullRequest.number}, which was already ${landed}` +
        (basePullRequest.mergedAt ? ` at ${basePullRequest.mergedAt}` : '') +
        '. Work merged here lands on a branch nothing will carry forward, and the merge will still report success',
    };
  }

  return {
    verdict: VERDICT_BASE_UNKNOWN,
    exitCode: 2,
    reason: `base branch ${baseRef} belongs to pull request #${basePullRequest.number} whose state "${basePullRequest.state}" was not recognised`,
  };
}

export function formatVerdict(result, { prNumber, baseRef } = {}) {
  const label =
    result.exitCode === 0
      ? 'ok'
      : result.exitCode === 1
        ? 'REFUSED'
        : 'INDETERMINATE';
  const lines = [
    `[stacked-base] ${label} (${result.verdict}): ${result.reason}`,
  ];
  if (prNumber !== undefined) {
    lines.push(`  pull request  #${prNumber}`);
  }
  if (baseRef !== undefined) {
    lines.push(`  base branch   ${baseRef}`);
  }
  if (result.exitCode === 1) {
    lines.push(
      '  Retarget this pull request at the default branch before merging it.',
    );
  }
  return lines.join('\n');
}

async function requestJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${url}`);
  }
  return response.json();
}

export async function fetchPullRequest({
  owner,
  repo,
  prNumber,
  token,
  fetchImpl = fetch,
}) {
  const payload = await requestJson(
    `${API_ROOT}/repos/${owner}/${repo}/pulls/${prNumber}`,
    token,
    fetchImpl,
  );
  const baseRef = payload?.base?.ref;
  const defaultBranch = payload?.base?.repo?.default_branch;
  if (typeof baseRef !== 'string' || typeof defaultBranch !== 'string') {
    throw new Error(
      `pull request #${prNumber} response carried no base.ref/base.repo.default_branch; refusing to guess`,
    );
  }
  return { baseRef, defaultBranch };
}

export async function fetchBranchPullRequest({
  owner,
  repo,
  branch,
  token,
  fetchImpl = fetch,
}) {
  // state=all, because a base branch whose pull request is CLOSED is exactly
  // as spent as one that was merged. Querying state=open would return nothing
  // for the hazardous case and nothing for the safe-but-unopened case alike.
  const payload = await requestJson(
    `${API_ROOT}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=100`,
    token,
    fetchImpl,
  );
  if (!Array.isArray(payload)) {
    throw new Error(
      `pull request listing for ${branch} was not an array; refusing to treat an unreadable response as "no pull request"`,
    );
  }
  if (payload.length === 0) {
    return null;
  }
  // Newest first: GitHub returns these in descending number order for this
  // query, but sorting explicitly means the choice does not depend on that.
  const newest = [...payload].sort(
    (a, b) => Number(b.number) - Number(a.number),
  )[0];
  return {
    number: newest.number,
    state: newest.merged_at ? 'merged' : newest.state,
    mergedAt: newest.merged_at ?? null,
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set');
  }

  const { owner, repo } = resolveRepository(process.env);
  const prNumber = resolvePullRequestNumber(process.env);

  const { baseRef, defaultBranch } = await fetchPullRequest({
    owner,
    repo,
    prNumber,
    token,
  });

  const basePullRequest =
    baseRef === defaultBranch
      ? null
      : await fetchBranchPullRequest({ owner, repo, branch: baseRef, token });

  const result = classifyStackedBase({
    baseRef,
    defaultBranch,
    basePullRequest,
  });

  const rendered = formatVerdict(result, { prNumber, baseRef });
  if (result.exitCode === 0) {
    console.log(rendered);
  } else {
    console.error(rendered);
  }
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // An inability to run this check exits 2, not 1 and not 0. It is a distinct
  // outcome from "the base has landed" because the remedy is different, and it
  // must never be 0 because that is the reading that let #386 through.
  main().catch((error) => {
    console.error(`Unable to verify the base branch: ${error.message}`);
    process.exitCode = 2;
  });
}
