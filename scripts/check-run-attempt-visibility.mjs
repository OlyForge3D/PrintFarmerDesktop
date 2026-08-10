#!/usr/bin/env node
// Surfaces the true max run_attempt for a commit head, because check-runs
// cannot.
//
// THE DEFECT (#340). `gh pr checks`, the PR UI, and branch protection all read
// `GET /commits/{sha}/check-runs`. That object has no `run_attempt` key -- it
// is not hidden, it simply is not represented -- and a re-run REPLACES the
// check runs on the head rather than appending to them. A commit that failed
// twice and passed on a third attempt reads back as a clean first-time pass:
//
//     PR #185   head 4e1510dd
//       attempt 1 -> failure
//       attempt 2 -> failure
//       attempt 3 -> success
//     GET /commits/4e1510dd/check-runs  ->  7 success, 0 failure
//
// `run_attempt` lives only on `GET /actions/runs?head_sha=...`, which nothing
// in the review path calls. This script calls it, so a reviewer can ask
// "was this green on the first attempt?" before trusting a green check-runs
// result -- see the "Before trusting a green result" note in
// .squad/skills/agent-collaboration/SKILL.md.
//
// THIS IS A REPORT, NOT A GATE. It is deliberately not wired to a workflow or
// required context: #340 explicitly scopes out any workflow-trigger change,
// and a re-run is not evidence of anything improper on its own (some are
// infrastructure flakes). It exists so the number is one command away
// instead of institutional knowledge nobody is prompted to apply.
//
// FALSIFIER (from #340 itself), reproduced in
// tests/checkRunAttemptVisibility.test.ts and reconfirmed live against the
// GitHub API before this file was written:
//
//     --sha 4e1510dde84e01e3921eb66abb31cb7f7080f9aa (#185) -> max attempt 3
//     --sha 30f69f549659c115eec60c9e2c746418e5f9c258 (#333) -> max attempt 1
//
// A checker that reports 1 for both is inert -- worse than none, per #340's
// own words, because it converts an unknown into a false assurance.

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { discoverToken } from './check-merge-queue-contexts.mjs';
import { resolveRepositorySlug } from './check-required-contexts.mjs';
import { normalizeSha } from './check-review-head-coverage.mjs';
import {
  fetchPullSnapshot,
  listWorkflowRuns,
} from './check-rerun-masked-failures.mjs';

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_UNDETERMINED = 2;

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (argument === '--sha') {
      const value = argv[index + 1];
      index += 1;
      if (normalizeSha(value) === null) {
        parsed.error = '--sha requires a full 40-hex commit SHA';
      } else if (parsed.pr !== undefined) {
        parsed.error = '--sha and --pr are mutually exclusive';
      } else {
        parsed.sha = normalizeSha(value);
      }
      continue;
    }
    if (argument === '--pr') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || !/^[1-9]\d*$/.test(value)) {
        parsed.error = '--pr requires a positive pull request number';
      } else if (parsed.sha !== undefined) {
        parsed.error = '--sha and --pr are mutually exclusive';
      } else {
        parsed.pr = Number(value);
      }
      continue;
    }
    if (argument === '--repo') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
        parsed.error = '--repo requires owner/name';
      } else {
        parsed.repo = value;
      }
      continue;
    }
    parsed.error ??= `unrecognised argument ${JSON.stringify(argument)}`;
  }
  return parsed;
}

/**
 * The one number this file exists to compute: the highest run_attempt among
 * every workflow run GitHub has ever recorded for a head SHA. `runs` is
 * expected to already be de-duplicated and paged in full by listWorkflowRuns
 * -- this function does not page, so a caller who hands it a partial page
 * would silently under-report, exactly the near-miss #340 disclosed against
 * itself (a 300-run window that never reached its own target reported zero).
 */
export function maxRunAttempt(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('no workflow runs were returned for this head SHA');
  }
  let max = 0;
  for (const [index, run] of runs.entries()) {
    if (!Number.isSafeInteger(run?.run_attempt) || run.run_attempt <= 0) {
      throw new Error(
        `workflow run ${index + 1} has no positive integer run_attempt`,
      );
    }
    if (run.run_attempt > max) max = run.run_attempt;
  }
  return max;
}

export async function resolveHeadSha({
  args,
  repository,
  token,
  fetchImpl = fetch,
}) {
  if (args.sha !== undefined) {
    return { headSha: args.sha, source: `--sha ${args.sha}` };
  }
  const pull = await fetchPullSnapshot({
    repository,
    prNumber: args.pr,
    token,
    fetchImpl,
  });
  return { headSha: pull.headSha, source: `PR #${args.pr}` };
}

/**
 * Guards against reporting a superseded PR head as current. --pr resolves
 * the head once, then the (potentially slow, paged) workflow-run scan runs
 * against that SHA; a push during the scan would otherwise leave the report
 * labelling a now-stale SHA as "PR #<n>" -- the exact false assurance #340
 * exists to eliminate. --sha has no PR to move against, so it is a no-op
 * there. Mirrors the final re-fetch-and-compare in
 * check-rerun-masked-failures.mjs's scanPullRequest.
 */
export async function verifyHeadStillCurrent({
  args,
  repository,
  token,
  fetchImpl = fetch,
  headSha,
}) {
  if (args.pr === undefined) return;
  const recheck = await fetchPullSnapshot({
    repository,
    prNumber: args.pr,
    token,
    fetchImpl,
  });
  if (recheck.headSha !== headSha) {
    throw new Error(
      `PR #${args.pr} head moved from ${headSha} to ${recheck.headSha} while workflow runs were being scanned; discard this result and retry`,
    );
  }
}

export function formatReport({ headSha, source, runs, maxAttempt }) {
  const lines = [
    `head ${headSha} (${source})`,
    `  workflow runs observed             : ${runs.length}`,
    `  max run_attempt                    : ${maxAttempt}`,
    '',
  ];
  if (maxAttempt > 1) {
    lines.push(
      `This head was re-run: at least one workflow reached attempt ${maxAttempt}.`,
      'check-runs (gh pr checks, the PR UI, branch protection) shows only the ' +
        "current attempt's outcome and cannot tell you this on its own -- a green " +
        'result here may be a green-on-some-attempt, not a first-try pass.',
    );
  } else {
    lines.push(
      'Every workflow run observed for this head is at attempt 1: no re-run occurred.',
    );
  }
  lines.push(
    '',
    'REPORT ONLY: this command emits no status context and is not part of branch protection (#340).',
  );
  return lines.join('\n');
}

const USAGE = `usage: npm run report:run-attempt-visibility -- --sha <40-hex> [--repo owner/name]
   or: npm run report:run-attempt-visibility -- --pr <number> [--repo owner/name]

Reads GET /actions/runs?head_sha=<sha> directly and reports the highest
run_attempt observed, so a reviewer can tell whether a green check-runs
result was a first-attempt pass or a later-attempt pass that check-runs
cannot represent (#340).

Exit 0 attempt 1 (no re-run) · 1 attempt > 1 (re-run occurred) · 2 undetermined`;

export async function main(
  argv,
  env = process.env,
  run = spawnSync,
  fetchImpl = fetch,
) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(USAGE);
      return EXIT_CLEAN;
    }
    if (
      args.error !== undefined ||
      (args.sha === undefined && args.pr === undefined)
    ) {
      console.error(args.error ?? '--sha or --pr is required');
      console.error(USAGE);
      return EXIT_UNDETERMINED;
    }
    const token = discoverToken(env, run);
    if (!token) {
      throw new Error('no GitHub credential found');
    }
    const slug = args.repo ?? resolveRepositorySlug(env, run);
    if (!slug) {
      throw new Error('could not resolve the repository');
    }
    const [owner, repo] = slug.split('/');
    const repository = { owner, repo };
    const { headSha, source } = await resolveHeadSha({
      args,
      repository,
      token,
      fetchImpl,
    });
    const runs = await listWorkflowRuns({
      repository,
      headSha,
      token,
      fetchImpl,
    });
    await verifyHeadStillCurrent({
      args,
      repository,
      token,
      fetchImpl,
      headSha,
    });
    const maxAttempt = maxRunAttempt(runs);
    console.log(formatReport({ headSha, source, runs, maxAttempt }));
    return maxAttempt > 1 ? EXIT_FINDINGS : EXIT_CLEAN;
  } catch (error) {
    console.error(
      `run-attempt visibility check undetermined: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EXIT_UNDETERMINED;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
