// Removes a hold label at the one moment the hold is permanently false.
//
// No shebang: this module is imported by tests/liftSequencingHold.test.ts, and
// vite's transform does not strip one the way node does. The same lesson is
// recorded at the top of check-pr-closure-scope.mjs, check-sequencing-hold.mjs
// and check-merge-queue-contexts.mjs; this is the fourth file to inherit it.
//
// `.squad/holds.md` already mandates this removal and already predicted that
// nobody would perform it: "This is the one lift that is housekeeping, and it
// is the one nobody does." Measured on this repository, the prediction is
// stronger than the document claims, because a deliberate sweep is not enough:
//
//   07:47:07Z-07:47:15Z  hold:sequenced removed from #154 #169 #172 #174
//                        — a manual sweep, eight seconds, four PRs, correct
//   13:21:27Z            #175 merged, still carrying the label
//
// The sweep was CORRECT when it ran. #175 was open at 07:47 and was rightly
// left alone; it then merged five and a half hours later and became stale in
// the same instant. So the defect is not that someone forgot — it is that the
// correct action has a shorter shelf life than the interval between sweeps, and
// re-sweeping is a rule you have to remember. A rule you have to remember is not
// a control.
//
// MERGED ONLY, AND THIS IS A CORRECTION TO holds.md, WHICH SAYS "merges or
// closes". Those two are not equivalent and only one of them is terminal:
//
//   merged      GitHub refuses to reopen a merged pull request. The assertion
//               "do not merge this yet" is false and can never become true
//               again, so removing the label destroys nothing.
//   closed      Reopenable. Lifting here would strip a live hold from a pull
//               request that can come back, which is the failure this whole
//               mechanism exists to prevent — arriving through the automation
//               meant to fix it.
//
// So this refuses to act on a close that is not a merge, and says so.

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  resolvePullRequestNumber,
  resolveRepository,
} from './check-pr-closure-scope.mjs';
import { HOLD_LABEL_PREFIX } from './check-sequencing-hold.mjs';

export { resolvePullRequestNumber, resolveRepository, HOLD_LABEL_PREFIX };

/**
 * Which hold labels may be removed, and why — or why not.
 *
 * Pure: reads no environment and performs no I/O, so the rule is testable
 * without a network or a repository.
 *
 * Takes `merged` rather than a state string because the distinction that
 * matters is not open/closed. A closed pull request and a merged one are both
 * `state: "closed"`, and treating them alike is precisely the bug this function
 * refuses to have.
 */
export function evaluateHoldsToLift({ labels, merged }) {
  if (!Array.isArray(labels)) {
    throw new TypeError(
      'labels must be an array; refusing to report "nothing to lift" from a value that cannot hold a label',
    );
  }
  if (typeof merged !== 'boolean') {
    throw new TypeError(
      `merged must be a boolean, received ${typeof merged}; a missing merge flag must not be read as "not merged", ` +
        'because that silently converts an unreadable payload into a decision not to act',
    );
  }

  const held = [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name;
    if (typeof name !== 'string') {
      throw new TypeError(`label entry has no name: ${JSON.stringify(label)}`);
    }
    if (name.toLowerCase().startsWith(HOLD_LABEL_PREFIX)) held.push(name);
  }

  if (held.length === 0) {
    return { lift: [], held: [], reason: 'no hold label is present' };
  }
  if (!merged) {
    return {
      lift: [],
      held,
      reason:
        'closed without merging, which is reopenable — the hold may still be live, so it is left alone',
    };
  }
  return {
    lift: held,
    held,
    reason:
      'merged, which cannot be reopened — the hold is permanently false and removing it destroys no live assertion',
  };
}

/**
 * What the job prints. The text is the product; the exit code only summarises.
 *
 * States where the record went, because removing a label erases it from the
 * label field and from label search — measured — leaving the events timeline as
 * the only place it survives. A reader who is not told that will conclude the
 * hold never existed.
 */
export function formatLift({ lift, held, reason }, prNumber, repository) {
  if (lift.length === 0) {
    return [
      `Pull request #${prNumber}: nothing lifted — ${reason}.`,
      ...(held.length > 0
        ? [
            '',
            `Still carrying: ${held.join(', ')}`,
            'If this pull request is not going to be reopened, remove the label by hand.',
          ]
        : []),
    ].join('\n');
  }

  const { owner, repo } = repository;
  return [
    `Pull request #${prNumber}: removed ${lift.join(', ')} — ${reason}.`,
    '',
    'This is housekeeping, not a decision. The hold asserted "do not merge this',
    'yet"; the pull request is merged, so the assertion is false permanently and',
    'nothing downstream will revisit it. .squad/holds.md authorises any reader to',
    'remove a hold label from a merged pull request without asking.',
    '',
    'The removal is not lost. A label is a current-state field, so it leaves no',
    'trace in the label list or in label search once removed — the record lives',
    'in the events timeline:',
    '',
    `  gh api repos/${owner}/${repo}/issues/${prNumber}/events \\`,
    `    --jq '.[]|select(.label.name|startswith("${HOLD_LABEL_PREFIX}"))|"\\(.created_at) \\(.event) \\(.label.name)"'`,
  ].join('\n');
}

export async function fetchPullRequest({
  owner,
  repo,
  prNumber,
  token,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub REST returned ${response.status} ${response.statusText}`,
    );
  }
  const payload = await response.json();
  if (!Array.isArray(payload?.labels)) {
    throw new Error(
      'pull request payload has no labels array; refusing to treat an unreadable response as "nothing to lift"',
    );
  }
  if (typeof payload.merged !== 'boolean') {
    throw new Error(
      'pull request payload has no boolean `merged` field; refusing to guess, because guessing "false" ' +
        'leaves a stale label and guessing "true" strips a live hold',
    );
  }
  return {
    labels: payload.labels.map((label) => label.name),
    merged: payload.merged,
  };
}

export async function removeLabel({
  owner,
  repo,
  prNumber,
  label,
  token,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
    {
      method: 'DELETE',
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
      },
    },
  );
  // 404 means the label is already gone, which is the desired end state. A
  // re-run that races another remover must not fail the job for succeeding.
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `removing ${label} returned ${response.status} ${response.statusText}`,
    );
  }
  return response.status !== 404;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set');
  }

  const repository = resolveRepository(process.env);
  const { owner, repo } = repository;
  const prNumber = resolvePullRequestNumber(process.env);
  const { labels, merged } = await fetchPullRequest({
    owner,
    repo,
    prNumber,
    token,
  });

  const decision = evaluateHoldsToLift({ labels, merged });
  for (const label of decision.lift) {
    await removeLabel({ owner, repo, prNumber, label, token });
  }
  console.log(formatLift(decision, prNumber, repository));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Failing the job on an unreadable pull request is deliberate. A run that
  // could not read the labels must not report the same result as a run that
  // read them and found nothing to lift — that equivalence is #182's defect,
  // and it is the one this repository keeps re-finding.
  main().catch((error) => {
    console.error(`Unable to lift the sequencing hold: ${error.message}`);
    process.exitCode = 1;
  });
}
