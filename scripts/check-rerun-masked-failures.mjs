// Reports required contexts that failed on a superseded workflow attempt.
//
// This is deliberately a manual advisory, not a required status context. It
// must not become required until its workflow is demonstrated to emit at every
// position it would gate, including merge_group. Advisory does not mean
// success-shaped: findings exit 1, while an unreadable or moving scan exits 2.

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  discoverToken,
  fetchRequiredContexts,
} from './check-merge-queue-contexts.mjs';
import { resolveRepositorySlug } from './check-required-contexts.mjs';
import { normalizeSha } from './check-review-head-coverage.mjs';

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_UNDETERMINED = 2;

const API_ROOT = 'https://api.github.com';
const PAGE_SIZE = 100;
const FILTERED_RUN_LIMIT = 1000;
const TERMINAL_CONCLUSIONS = new Set([
  'action_required',
  'cancelled',
  'failure',
  'neutral',
  'skipped',
  'stale',
  'startup_failure',
  'success',
  'timed_out',
]);
const NON_FAILURE_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

function apiHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
}

async function requestJson(url, token, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: apiHeaders(token) });
  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText} (${url})`,
    );
  }
  return response.json();
}

function requireCountedPage(payload, field, subject) {
  const totalCount = payload?.total_count;
  const rows = payload?.[field];
  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    throw new Error(
      `${subject} response carried no non-negative integer total_count`,
    );
  }
  if (!Array.isArray(rows)) {
    throw new Error(`${subject} response carried no ${field} array`);
  }
  return { totalCount, rows };
}

async function fetchCountedPages({
  firstUrl,
  pageUrl,
  field,
  subject,
  token,
  fetchImpl,
  refuseTotalAtOrAbove,
}) {
  const rows = [];
  let expectedTotal;
  for (let page = 1; ; page += 1) {
    const payload = await requestJson(
      page === 1 ? firstUrl : pageUrl(page),
      token,
      fetchImpl,
    );
    const parsed = requireCountedPage(payload, field, subject);
    if (
      refuseTotalAtOrAbove !== undefined &&
      parsed.totalCount >= refuseTotalAtOrAbove
    ) {
      throw new Error(
        `${subject} reached GitHub's ${refuseTotalAtOrAbove}-result filtered-search ceiling; the response may be truncated`,
      );
    }
    expectedTotal ??= parsed.totalCount;
    if (parsed.totalCount !== expectedTotal) {
      throw new Error(
        `${subject} changed from ${expectedTotal} to ${parsed.totalCount} rows while it was paged`,
      );
    }
    rows.push(...parsed.rows);
    if (rows.length >= expectedTotal) break;
    if (parsed.rows.length === 0) {
      throw new Error(
        `${subject} ended after ${rows.length} of ${expectedTotal} rows`,
      );
    }
  }
  if (rows.length !== expectedTotal) {
    throw new Error(
      `${subject} returned ${rows.length} rows for total_count ${expectedTotal}`,
    );
  }
  return rows;
}

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (argument === '--pr') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || !/^[1-9]\d*$/.test(value)) {
        parsed.error = '--pr requires a positive pull request number';
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

export function parsePullSnapshot(payload, expectedNumber) {
  const number = payload?.number;
  const headSha = normalizeSha(payload?.head?.sha);
  const baseRef = payload?.base?.ref;
  if (number !== expectedNumber) {
    throw new Error(
      `requested pull request #${expectedNumber}, but GitHub returned ${JSON.stringify(number)}`,
    );
  }
  if (headSha === null || typeof baseRef !== 'string' || baseRef === '') {
    throw new Error(
      `pull request #${expectedNumber} has no full head SHA or base branch`,
    );
  }
  return { number, headSha, baseRef };
}

export async function fetchPullSnapshot({
  repository,
  prNumber,
  token,
  fetchImpl = fetch,
}) {
  const payload = await requestJson(
    `${API_ROOT}/repos/${repository.owner}/${repository.repo}/pulls/${prNumber}`,
    token,
    fetchImpl,
  );
  return parsePullSnapshot(payload, prNumber);
}

export async function listWorkflowRuns({
  repository,
  headSha,
  token,
  fetchImpl = fetch,
}) {
  const sha = normalizeSha(headSha);
  if (sha === null) {
    throw new Error(
      'head SHA must be the full value returned by the pull request API',
    );
  }
  const prefix =
    `${API_ROOT}/repos/${repository.owner}/${repository.repo}/actions/runs` +
    `?head_sha=${sha}&per_page=${PAGE_SIZE}`;
  return fetchCountedPages({
    firstUrl: prefix,
    pageUrl: (page) => `${prefix}&page=${page}`,
    field: 'workflow_runs',
    subject: `workflow runs for ${sha}`,
    token,
    fetchImpl,
    refuseTotalAtOrAbove: FILTERED_RUN_LIMIT,
  });
}

export async function listAttemptJobs({
  repository,
  runId,
  attempt,
  token,
  fetchImpl = fetch,
}) {
  const prefix =
    `${API_ROOT}/repos/${repository.owner}/${repository.repo}/actions/runs/` +
    `${runId}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}`;
  return fetchCountedPages({
    firstUrl: prefix,
    pageUrl: (page) => `${prefix}&page=${page}`,
    field: 'jobs',
    subject: `jobs for run ${runId} attempt ${attempt}`,
    token,
    fetchImpl,
  });
}

function validateRequiredContexts(requiredContexts) {
  const required = [...requiredContexts];
  if (
    required.length === 0 ||
    required.some((context) => typeof context !== 'string' || context === '')
  ) {
    throw new Error(
      'required contexts must be a non-empty set read from live branch protection',
    );
  }
  return required;
}

export function maskedRequiredFailures(jobs, requiredContexts) {
  const required = new Set(validateRequiredContexts(requiredContexts));
  return jobs
    .map((job, index) => {
      if (
        typeof job?.name !== 'string' ||
        job.name === '' ||
        typeof job.conclusion !== 'string' ||
        !TERMINAL_CONCLUSIONS.has(job.conclusion)
      ) {
        throw new Error(
          `attempt job ${index + 1} has no non-empty name or recognized terminal conclusion`,
        );
      }
      return job;
    })
    .filter(
      (job) =>
        required.has(job.name) && !NON_FAILURE_CONCLUSIONS.has(job.conclusion),
    );
}

function parseRun(run) {
  if (
    !Number.isSafeInteger(run?.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run?.run_attempt) ||
    run.run_attempt <= 0 ||
    typeof run?.created_at !== 'string' ||
    Number.isNaN(Date.parse(run.created_at))
  ) {
    throw new Error('workflow run has no valid id, run_attempt, or created_at');
  }
  return run;
}

function runSignature(runs) {
  return runs
    .map((run) => {
      const parsed = parseRun(run);
      return `${parsed.id}:${parsed.run_attempt}`;
    })
    .sort();
}

function sameStrings(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export async function scanHead({
  headSha,
  requiredContexts,
  listRuns,
  listJobs,
}) {
  const sha = normalizeSha(headSha);
  if (sha === null) {
    throw new Error(
      'head SHA must be the full value returned by the pull request API',
    );
  }
  const required = validateRequiredContexts(requiredContexts);
  const runs = (await listRuns(sha)).map(parseRun);
  if (runs.length === 0) {
    throw new Error(
      `GitHub returned zero workflow runs for current pull request head ${sha}; wait for checks to attach and retry`,
    );
  }

  const findings = [];
  const attemptsExamined = [];
  for (const run of runs.filter((candidate) => candidate.run_attempt > 1)) {
    const superseded = [];
    for (let attempt = 1; attempt < run.run_attempt; attempt += 1) {
      superseded.push(attempt);
      const jobs = await listJobs(run.id, attempt);
      if (jobs.length === 0) {
        throw new Error(
          `run ${run.id} attempt ${attempt} returned zero jobs; the superseded attempt was not observable`,
        );
      }
      for (const job of maskedRequiredFailures(jobs, required)) {
        findings.push({
          runId: run.id,
          runName: run.name,
          attempt,
          currentAttempt: run.run_attempt,
          context: job.name,
          conclusion: job.conclusion,
        });
      }
    }
    attemptsExamined.push({
      runId: run.id,
      runName: run.name,
      currentAttempt: run.run_attempt,
      superseded,
    });
  }

  const timestamps = runs.map((run) => run.created_at).sort();
  return {
    findings,
    scope: {
      headSha: sha,
      requiredContexts: required,
      runsReturned: runs.length,
      runWindow: {
        earliest: timestamps.at(0),
        latest: timestamps.at(-1),
      },
      rerunRuns: attemptsExamined.length,
      attemptsExamined,
      runSignature: runSignature(runs),
    },
  };
}

export async function scanPullRequest({
  repository,
  prNumber,
  token,
  fetchImpl = fetch,
}) {
  const initialPull = await fetchPullSnapshot({
    repository,
    prNumber,
    token,
    fetchImpl,
  });
  const initialProtection = await fetchRequiredContexts({
    repository,
    branch: initialPull.baseRef,
    token,
    fetchImpl,
  });
  const result = await scanHead({
    headSha: initialPull.headSha,
    requiredContexts: initialProtection.contexts,
    listRuns: (headSha) =>
      listWorkflowRuns({ repository, headSha, token, fetchImpl }),
    listJobs: (runId, attempt) =>
      listAttemptJobs({ repository, runId, attempt, token, fetchImpl }),
  });

  const [finalPull, finalRuns, finalProtection] = await Promise.all([
    fetchPullSnapshot({ repository, prNumber, token, fetchImpl }),
    listWorkflowRuns({
      repository,
      headSha: initialPull.headSha,
      token,
      fetchImpl,
    }),
    fetchRequiredContexts({
      repository,
      branch: initialPull.baseRef,
      token,
      fetchImpl,
    }),
  ]);
  if (
    finalPull.headSha !== initialPull.headSha ||
    finalPull.baseRef !== initialPull.baseRef
  ) {
    throw new Error(
      'pull request head or base moved during the scan; discard the result and retry',
    );
  }
  if (
    !sameStrings(result.scope.runSignature, runSignature(finalRuns)) ||
    !sameStrings(initialProtection.contexts, finalProtection.contexts)
  ) {
    throw new Error(
      'workflow attempts or required contexts changed during the scan; discard the result and retry',
    );
  }
  return { ...result, pull: initialPull };
}

export function formatReport({ findings, scope, pull }) {
  const lines = [
    `PR #${pull.number} head ${scope.headSha}`,
    `  workflow runs returned             : ${scope.runsReturned}`,
    `  workflow run creation window       : ${scope.runWindow.earliest} .. ${scope.runWindow.latest}`,
    `  runs with attempt > 1              : ${scope.rerunRuns}`,
    `  required contexts from ${pull.baseRef.padEnd(11)} : ${scope.requiredContexts.length}`,
  ];
  if (scope.attemptsExamined.length === 0) {
    lines.push(
      '  superseded attempts examined       : none (no run was re-run)',
    );
  } else {
    lines.push('  superseded attempts examined       :');
    for (const run of scope.attemptsExamined) {
      lines.push(
        `    run ${run.runId} (${run.runName ?? 'unnamed'}) attempt ${run.currentAttempt} is current; examined ${run.superseded.join(', ')}`,
      );
    }
  }
  lines.push('');
  if (findings.length === 0) {
    lines.push(
      'No required context failed on a superseded attempt within the scope above.',
    );
  } else {
    lines.push(
      `${findings.length} masked required-context failure(s) found:`,
      '',
    );
    for (const finding of findings) {
      lines.push(
        `  ${finding.context} -> ${finding.conclusion} on attempt ${finding.attempt} of run ${finding.runId} (now attempt ${finding.currentAttempt})`,
      );
    }
  }
  lines.push(
    '',
    'ADVISORY: this command emits no status context and is not part of branch protection.',
  );
  return lines.join('\n');
}

const USAGE = `usage: npm run report:rerun-masked-failures -- --pr <number> [--repo owner/name]

Reads the pull request head directly from GitHub, walks every superseded
workflow attempt, and reports failures whose job names are required contexts.

Exit 0 clean · 1 masked required failure found · 2 undetermined`;

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
    if (args.error !== undefined || args.pr === undefined) {
      console.error(args.error ?? '--pr is required');
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
    const result = await scanPullRequest({
      repository: { owner, repo },
      prNumber: args.pr,
      token,
      fetchImpl,
    });
    console.log(formatReport(result));
    return result.findings.length > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
  } catch (error) {
    console.error(
      `rerun-masked-failure scan undetermined: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EXIT_UNDETERMINED;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
