import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { CLEANUP_FAILURE_ANCHOR } from './npm-ci-strict.mjs';
import {
  CLEANUP_SOURCE_WORKFLOWS,
  CLEANUP_TRACKING_ISSUE,
} from './publish-npm-cleanup-evidence.mjs';
import { resolveRepository } from './check-pr-closure-scope.mjs';

export const MINIMUM_JUSTIFICATION_LENGTH = 20;

/**
 * The only ref this script may run from. Named rather than inlined so the guard
 * and the tests that exercise it cannot disagree about the value while both
 * still passing.
 */
export const DISCHARGE_REF = 'refs/heads/development';

function headers(token, json = false) {
  return {
    authorization: `bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

async function requireOk(response, operation) {
  if (!response.ok) {
    throw new Error(
      `${operation} failed: ${response.status} ${response.statusText}`,
    );
  }
  return response;
}

export function validateDischargeRequest({ runId, headSha, justification }) {
  const parsedRunId = Number(runId);
  if (!Number.isInteger(parsedRunId) || parsedRunId <= 0) {
    throw new Error(`run_id must be a positive integer: ${runId}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) {
    throw new Error('head_sha must be the full 40-character commit SHA');
  }
  const normalizedJustification = String(justification ?? '').trim();
  const nonWhitespaceLength = normalizedJustification.replace(/\s/g, '').length;
  if (nonWhitespaceLength < MINIMUM_JUSTIFICATION_LENGTH) {
    throw new Error(
      `justification must contain at least ${MINIMUM_JUSTIFICATION_LENGTH} non-whitespace characters`,
    );
  }
  return {
    runId: parsedRunId,
    headSha: headSha.toLowerCase(),
    justification: normalizedJustification,
  };
}

function requireMatchingFailedRun(run, request, expectedAttempt) {
  if (run.status !== 'completed' || run.conclusion !== 'failure') {
    throw new Error(
      `workflow run ${request.runId} must be completed with conclusion failure`,
    );
  }
  if (!CLEANUP_SOURCE_WORKFLOWS.includes(run.name)) {
    throw new Error(
      `workflow run ${request.runId} belongs to ineligible workflow ${run.name ?? 'unknown'}`,
    );
  }
  if (String(run.head_sha).toLowerCase() !== request.headSha) {
    throw new Error(
      `workflow run ${request.runId} head ${run.head_sha} does not match requested ${request.headSha}`,
    );
  }
  if (!Number.isInteger(run.run_attempt) || run.run_attempt <= 0) {
    throw new Error(`workflow run ${request.runId} has no valid run_attempt`);
  }
  if (expectedAttempt !== undefined && run.run_attempt !== expectedAttempt) {
    throw new Error(
      `workflow run ${request.runId} advanced from attempt ${expectedAttempt} to ${run.run_attempt}; refusing to rerun an unverified attempt`,
    );
  }
  return run;
}

export function failedJobStepViolations(failedJobs) {
  const violations = [];
  for (const job of failedJobs) {
    if (!Array.isArray(job?.steps)) {
      violations.push(`${job?.name ?? 'unnamed job'} has no readable steps`);
      continue;
    }
    const failedSteps = job.steps.filter(
      (step) => step?.conclusion === 'failure',
    );
    const installStep = job.steps.find(
      (step) => step?.name === 'Install dependencies',
    );
    if (installStep?.conclusion !== 'failure') {
      violations.push(
        `${job.name ?? 'unnamed job'} did not fail at Install dependencies`,
      );
      continue;
    }
    const otherFailures = failedSteps.filter(
      (step) => step?.name !== 'Install dependencies',
    );
    if (otherFailures.length > 0) {
      violations.push(
        `${job.name ?? 'unnamed job'} also failed at ${otherFailures
          .map((step) => step.name ?? 'unnamed step')
          .join(', ')}`,
      );
    }
  }
  return violations;
}

export function formatDischargeComment({
  run,
  failedJobs,
  justification,
  actor,
}) {
  const inlineCode = (value) =>
    `\`${String(value)
      .replaceAll('`', "'")
      .replaceAll(/[\r\n]+/g, ' ')}\``;
  const marker = `<!-- npm-cleanup-discharge run=${run.id} attempt=${run.run_attempt} -->`;
  return [
    marker,
    '### npm cleanup discharge authorized',
    '',
    `- **Run attempt:** [${run.id}/${run.run_attempt}](${run.html_url})`,
    `- **Head:** \`${run.head_sha}\``,
    `- **Authorized by:** @${actor}`,
    `- **Failed jobs:** ${failedJobs
      .map(
        (job) => `[${inlineCode(job.name)}](${job.html_url}) (job ${job.id})`,
      )
      .join(', ')}`,
    `- **Verified anchor:** \`${CLEANUP_FAILURE_ANCHOR}\``,
    `- **Justification:** ${justification}`,
    '',
    'Authorization scope: rerun the failed jobs from this attempt only. Every',
    'install integrity, test, SBOM, licence, notice, and advisory gate remains',
    'enabled. If any failed job lacks the exact anchor, this workflow refuses the',
    'entire discharge rather than retrying a neighbouring policy failure.',
  ].join('\n');
}

export async function dischargeCleanupFailure({
  owner,
  repo,
  token,
  runId,
  headSha,
  justification,
  actor,
  issueNumber = CLEANUP_TRACKING_ISSUE,
  fetchImpl = fetch,
}) {
  const request = validateDischargeRequest({
    runId,
    headSha,
    justification,
  });
  const apiRoot = `https://api.github.com/repos/${owner}/${repo}`;

  const runResponse = await requireOk(
    await fetchImpl(`${apiRoot}/actions/runs/${request.runId}`, {
      headers: headers(token),
    }),
    'reading workflow run',
  );
  const run = requireMatchingFailedRun(await runResponse.json(), request);

  const jobsResponse = await requireOk(
    await fetchImpl(
      `${apiRoot}/actions/runs/${request.runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
      { headers: headers(token) },
    ),
    'reading failed jobs',
  );
  const jobsPayload = await jobsResponse.json();
  if (!Array.isArray(jobsPayload?.jobs)) {
    throw new Error('workflow jobs response has no jobs array');
  }
  if (
    Number.isInteger(jobsPayload.total_count) &&
    jobsPayload.total_count > jobsPayload.jobs.length
  ) {
    throw new Error(
      `workflow run has ${jobsPayload.total_count} jobs but only ${jobsPayload.jobs.length} were returned`,
    );
  }
  const failedJobs = jobsPayload.jobs.filter(
    (job) => job?.conclusion === 'failure',
  );
  if (failedJobs.length === 0) {
    throw new Error('workflow run has no failed jobs to discharge');
  }
  const stepViolations = failedJobStepViolations(failedJobs);
  if (stepViolations.length > 0) {
    throw new Error(
      `refusing discharge because failed jobs did not fail only at Install dependencies: ${stepViolations.join('; ')}`,
    );
  }

  const jobsWithoutAnchor = [];
  for (const job of failedJobs) {
    if (!Number.isInteger(job?.id)) {
      throw new Error(`failed job has no integer id: ${JSON.stringify(job)}`);
    }
    const logResponse = await requireOk(
      await fetchImpl(`${apiRoot}/actions/jobs/${job.id}/logs`, {
        headers: headers(token),
      }),
      `reading log for failed job ${job.id}`,
    );
    const log = await logResponse.text();
    if (!log.includes(CLEANUP_FAILURE_ANCHOR)) {
      jobsWithoutAnchor.push(`${job.name ?? 'unnamed job'} (${job.id})`);
    }
  }
  if (jobsWithoutAnchor.length > 0) {
    throw new Error(
      `refusing discharge because failed jobs lack the exact cleanup anchor: ${jobsWithoutAnchor.join(', ')}`,
    );
  }

  const currentBeforeCommentResponse = await requireOk(
    await fetchImpl(`${apiRoot}/actions/runs/${request.runId}`, {
      headers: headers(token),
    }),
    'revalidating workflow run before recording discharge',
  );
  requireMatchingFailedRun(
    await currentBeforeCommentResponse.json(),
    request,
    run.run_attempt,
  );

  const commentBody = formatDischargeComment({
    run,
    failedJobs,
    justification: request.justification,
    actor,
  });
  const commentResponse = await requireOk(
    await fetchImpl(`${apiRoot}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: headers(token, true),
      body: JSON.stringify({ body: commentBody }),
    }),
    'recording cleanup discharge',
  );
  const comment = await commentResponse.json();
  if (typeof comment?.html_url !== 'string') {
    throw new Error(
      'cleanup discharge was recorded but GitHub returned no comment URL',
    );
  }

  const currentBeforeRerunResponse = await requireOk(
    await fetchImpl(`${apiRoot}/actions/runs/${request.runId}`, {
      headers: headers(token),
    }),
    'revalidating workflow run before rerun',
  );
  requireMatchingFailedRun(
    await currentBeforeRerunResponse.json(),
    request,
    run.run_attempt,
  );

  await requireOk(
    await fetchImpl(
      `${apiRoot}/actions/runs/${request.runId}/rerun-failed-jobs`,
      {
        method: 'POST',
        headers: headers(token),
      },
    ),
    'requesting failed-job rerun',
  );

  return {
    commentUrl: comment.html_url,
    failedJobIds: failedJobs.map((job) => job.id),
  };
}

/**
 * Refuse to run anywhere but `development`.
 *
 * This is the only thing standing between an `actions: write` + `issues: write`
 * token and this script's logic as it exists on an unreviewed branch:
 * `workflow_dispatch` can be aimed at an arbitrary ref.
 *
 * It is exported so it can be tested by CALLING it. The previous protection was
 * an assertion that the source file contained the string
 * `GITHUB_REF !== 'refs/heads/development'`, which goes red if the guard is
 * DELETED and stays green if it is DISABLED — and disabling is the failure mode
 * that actually happens, because deletions get noticed in review. Inserting two
 * tokens (`if (false && …)`) satisfied that assertion and removed the control,
 * with 2001 tests passing.
 *
 * Ordering is part of the contract, not an accident of layout: this must refuse
 * before the token is read, so a wrong ref can never reach a code path that
 * holds a credential. The tests assert that ordering by observing WHICH error a
 * subprocess reports when both conditions are wrong at once.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function assertDischargeRef(env) {
  if (env.GITHUB_REF !== DISCHARGE_REF) {
    throw new Error(
      `discharge must run from ${DISCHARGE_REF} so the write-capable workflow uses reviewed code`,
    );
  }
}

async function main() {
  assertDischargeRef(process.env);
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const { owner, repo } = resolveRepository(process.env);
  const result = await dischargeCleanupFailure({
    owner,
    repo,
    token,
    runId: process.env.INPUT_RUN_ID,
    headSha: process.env.INPUT_HEAD_SHA,
    justification: process.env.INPUT_JUSTIFICATION,
    actor: process.env.GITHUB_ACTOR ?? 'unknown',
  });
  console.log(
    `Recorded ${result.commentUrl}; requested rerun for failed jobs ${result.failedJobIds.join(', ')}.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`discharge-npm-cleanup-failure: ${error.message}`);
    process.exitCode = 1;
  });
}
