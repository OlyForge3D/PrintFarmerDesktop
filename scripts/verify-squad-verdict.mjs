// Verifies a `squad/pre-pr-verdict` commit status against the workflow run
// that produced it, so the status can never be trusted on its own.
//
// Ported from OlyForge3D/PrintFarmer's scripts/ci/verify-squad-verdict.mjs
// (PR #1187, fixing PrintFarmer issue #1116 -- the identical structural
// problem raised here as issue #187: one GitHub account authenticates every
// squad session, so GitHub 422s self-review and `reviews: []` never
// distinguishes a rigorously reviewed PR from an unreviewed one).
//
// A commit status is a bare tuple of (context, state, description) that
// ANY workflow, or anyone with `statuses: write`, can post. Trusting it at
// face value would let an author post their own approval under this
// context name. What makes the record real is checking it against
// independent, non-forgeable facts about the run that created it:
//   - the status creator must be github-actions[bot], not a human token
//   - its target_url must resolve to an actual completed, successful run
//     of exactly .github/workflows/squad-review-verdict.yml
//   - that run's own metadata (actor, triggering_actor, run_attempt,
//     display_title -- all server-generated, none attacker-writable) must
//     agree with the status content
//   - the run's actor must not be the PR's author
// Any mismatch is INVALID, not APPROVED. A verdict pinned to a SHA that is
// no longer the PR's head is SUPERSEDED, not carried forward silently.
//
// This script is deliberately NOT wired into any check-run-emitting
// workflow: verifying "does this PR have a valid squad verdict" needs a
// specific PR number and (optionally) a specific expected head, neither of
// which a per-PR CI run can supply about itself in a way that would not
// simply be answering whether its own still-running checks have finished.
// It is invoked by hand, or by whatever performs the merge, exactly as
// PrintFarmer's sibling script is. See check:squad-verdict's entry in
// scripts/check-script-reachability.mjs's UNENFORCED_CHECKS for why that is
// a stated, deliberate weakness rather than an oversight.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const verdictContext = 'squad/pre-pr-verdict';
export const verdictWorkflowPath = '.github/workflows/squad-review-verdict.yml';

const trustedStatusCreator = 'github-actions[bot]';
const displayTitlePattern =
  /^Squad verdict (APPROVE|CHANGES_REQUESTED|REJECT) for PR #([1-9]\d*) @ ([0-9a-f]{40}) by ([A-Za-z0-9-]+)$/;

function result(classification, reason, evidence = {}) {
  return { classification, reason, ...evidence };
}

export function bindStatusToHead(status, headSha) {
  if (status.sha && status.sha.toLowerCase() !== headSha.toLowerCase()) {
    throw new Error('Commit status SHA does not match the requested head.');
  }
  return { ...status, sha: headSha };
}

function parseRunTarget(targetUrl, repository) {
  try {
    const url = new URL(targetUrl);
    const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = url.pathname.match(
      new RegExp(`^/${escapedRepository}/actions/runs/([1-9]\\d*)/?$`, 'i'),
    );
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match) {
      return undefined;
    }
    return Number.parseInt(match[1], 10);
  } catch {
    return undefined;
  }
}

function parseDisplayTitle(displayTitle) {
  const match = displayTitlePattern.exec(displayTitle ?? '');
  if (!match) {
    return undefined;
  }
  return {
    verdict: match[1],
    prNumber: Number.parseInt(match[2], 10),
    reviewedHeadSha: match[3],
    actor: match[4],
  };
}

function isStatusCreatedDuringRun(status, run) {
  const createdAt = Date.parse(status.created_at);
  const startedAt = Date.parse(run.run_started_at ?? run.created_at);
  const completedAt = Date.parse(run.updated_at);
  if ([createdAt, startedAt, completedAt].some(Number.isNaN)) {
    return false;
  }
  const toleranceMs = 5_000;
  return (
    createdAt >= startedAt - toleranceMs &&
    createdAt <= completedAt + toleranceMs
  );
}

export function verifySquadVerdict({ pull, status, run }) {
  if (!status) {
    return result(
      'MISSING',
      'No squad verdict status exists on the current head.',
    );
  }
  if (status.context !== verdictContext) {
    return result('INVALID', `Unexpected status context: ${status.context}.`);
  }

  const repository = pull.base?.repo?.full_name;
  const defaultBranch = pull.base?.repo?.default_branch;
  const author = pull.user?.login;
  const currentHeadSha = pull.head?.sha?.toLowerCase();
  const statusSha = status.sha?.toLowerCase();
  if (
    !repository ||
    !defaultBranch ||
    !author ||
    !currentHeadSha ||
    !statusSha
  ) {
    return result('INVALID', 'PR or status metadata is incomplete.');
  }
  if (status.creator?.login !== trustedStatusCreator) {
    return result(
      'INVALID',
      'The verdict status was not created by GitHub Actions.',
    );
  }

  const runId = parseRunTarget(status.target_url, repository);
  if (!runId || run?.id !== runId || run.html_url !== status.target_url) {
    return result(
      'INVALID',
      'The status does not target its verified workflow run.',
    );
  }
  if (
    run.path !== verdictWorkflowPath ||
    run.event !== 'workflow_dispatch' ||
    run.run_attempt !== 1 ||
    run.triggering_actor?.login?.toLowerCase() !==
      run.actor?.login?.toLowerCase() ||
    run.head_branch !== defaultBranch ||
    run.default_branch_contains_run !== true ||
    run.repository?.full_name !== repository ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  ) {
    return result(
      'INVALID',
      'The target is not a successful trusted verdict workflow run.',
    );
  }

  const title = parseDisplayTitle(run.display_title);
  if (
    !title ||
    title.prNumber !== pull.number ||
    title.reviewedHeadSha !== statusSha ||
    title.actor.toLowerCase() !== run.actor?.login?.toLowerCase()
  ) {
    return result(
      'INVALID',
      'The workflow run metadata does not match the status.',
    );
  }
  if (title.actor.toLowerCase() === author.toLowerCase()) {
    return result('INVALID', 'The PR author recorded the verdict.');
  }

  const expectedState = title.verdict === 'APPROVE' ? 'success' : 'failure';
  const expectedDescription = `${title.verdict} @ ${statusSha.slice(0, 12)} by ${title.actor}`;
  if (
    status.state !== expectedState ||
    status.description !== expectedDescription ||
    !isStatusCreatedDuringRun(status, run)
  ) {
    return result(
      'INVALID',
      'The status does not match the trusted workflow verdict.',
    );
  }

  if (statusSha !== currentHeadSha) {
    return result(
      'SUPERSEDED',
      `${title.verdict} applies to ${statusSha}, not current head ${currentHeadSha}.`,
      {
        verdict: title.verdict,
        reviewedHeadSha: statusSha,
        actor: title.actor,
      },
    );
  }

  const classification =
    title.verdict === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
  return result(classification, 'Verified SHA-pinned squad verdict.', {
    verdict: title.verdict,
    reviewedHeadSha: statusSha,
    actor: title.actor,
    workflowRunUrl: run.html_url,
  });
}

export function selectSquadVerdict({
  pull,
  statuses,
  statusHeadSha = pull.head.sha,
  loadRun,
}) {
  const candidates = statuses
    .filter((status) => status.context === verdictContext)
    .map((status) => bindStatusToHead(status, statusHeadSha))
    .sort((left, right) => {
      const timestampOrder =
        Date.parse(right.created_at) - Date.parse(left.created_at);
      return timestampOrder || right.id - left.id;
    });

  for (const status of candidates) {
    const runId = parseRunTarget(status.target_url, pull.base.repo.full_name);
    if (!runId) {
      return result(
        'INVALID',
        'The newest verdict status has no trusted run target.',
      );
    }
    const run = loadRun(runId);
    return verifySquadVerdict({ pull, status, run });
  }
  return result(
    'MISSING',
    'No squad verdict status exists on the current head.',
  );
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === '--repo' ||
      argument === '--pr' ||
      argument === '--expected-head'
    ) {
      args[argument.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--json') {
      args.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(args.repo ?? '')) {
    throw new Error('--repo must be OWNER/REPOSITORY.');
  }
  if (!/^[1-9]\d*$/.test(args.pr ?? '')) {
    throw new Error('--pr must be a positive integer.');
  }
  if (
    args['expected-head'] !== undefined &&
    !/^[0-9a-f]{40}$/.test(args['expected-head'])
  ) {
    throw new Error('--expected-head must be a lowercase 40-character SHA.');
  }
  return { ...args, pr: Number.parseInt(args.pr, 10) };
}

function ghApi(path) {
  const output = execFileSync('gh', ['api', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(output);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pull = ghApi(`/repos/${args.repo}/pulls/${args.pr}`);
  const statusHeadSha = args['expected-head'] ?? pull.head.sha;
  const statuses = ghApi(
    `/repos/${args.repo}/commits/${statusHeadSha}/statuses?per_page=100`,
  );
  const verdict = selectSquadVerdict({
    pull,
    statuses,
    statusHeadSha,
    loadRun: (runId) => {
      const run = ghApi(`/repos/${args.repo}/actions/runs/${runId}`);
      const comparison = ghApi(
        `/repos/${args.repo}/compare/${run.head_sha}...` +
          encodeURIComponent(pull.base.repo.default_branch),
      );
      return {
        ...run,
        default_branch_contains_run:
          comparison.status === 'ahead' || comparison.status === 'identical',
      };
    },
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
  } else {
    process.stdout.write(`${verdict.classification}: ${verdict.reason}\n`);
  }

  if (verdict.classification === 'APPROVED') {
    return;
  }
  // Exit 2 is a current rejection; exit 3 means no usable squad evidence.
  // Execution failures use exit 1 through the catch handler below.
  process.exitCode = verdict.classification === 'CHANGES_REQUESTED' ? 2 : 3;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
