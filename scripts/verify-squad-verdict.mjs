// Verifies the provenance of the `squad/pre-pr-verdict` commit status.
//
// ⚠️ "Verified" here means the status really was written by the trusted
// workflow for the exact commit it names. It does NOT mean an independent party
// approved the change. A `REVIEWED` classification is a SELF-ATTESTED record
// that reviewer agents examined the commit: every squad agent runs under the
// repository owner's authority, so there is no separation of duties. Only
// `APPROVED` reflects a repository administrator authorising directly. See
// `.squad/skills/agent-collaboration/SKILL.md` § "The merge gate".
//
// Ported from OlyForge3D/PrintFarmer's scripts/ci/verify-squad-verdict.mjs
// (PR #1316, fixing PrintFarmer issue #1310) for this repository's issue #740,
// replacing the earlier port of PrintFarmer PR #1187. The mechanism it verifies
// changed shape entirely: the previous version read a `workflow_dispatch`-only
// run whose `display_title` carried the verdict, dispatched by a non-author
// administrator. This repository has exactly one collaborator, who authors every
// agent PR, so that run never happened once — `gh run list --workflow
// squad-review-verdict.yml` returned zero runs for its entire lifetime.
//
// No shebang: this module is imported by tests/squadReviewVerdict.test.ts, and
// vite's transform does not strip one the way node does.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const verdictContext = 'squad/pre-pr-verdict';
export const verdictWorkflowPath = '.github/workflows/squad-review-verdict.yml';

const trustedStatusCreator = 'github-actions[bot]';
const displayTitlePattern = /^Squad review record for PR #([1-9]\d*)$/;

// The gate runs only from these four event types. A pull_request (head-ref)
// trigger would let a PR rewrite the logic that judges it, so it is
// deliberately excluded.
const trustedEvents = new Set([
  'pull_request_target',
  'issue_comment',
  'pull_request_review',
  'workflow_dispatch',
]);

// These three buckets require materially different evidence, because GitHub
// does NOT source the workflow *definition* the same way for all four
// trusted events — see
// https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows
// ("Each workflow run will use the version of the workflow that is present
// in the associated commit SHA or Git ref of the event") and the per-event
// GITHUB_SHA/GITHUB_REF table at
// https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
//
// - issue_comment / workflow_dispatch: GITHUB_SHA/REF are genuinely "last
//   commit on default branch" / "default branch", so run.head_branch can be
//   checked directly against it (default_branch_contains_run compares
//   run.head_sha to the default branch).
// - pull_request_target: GITHUB_SHA/REF are documented as "last commit on
//   default branch" / "default branch" too — this is the specific platform
//   guarantee that makes it the standard safe pattern for processing fork
//   PRs (see GitHub Security Lab, "Preventing pwn requests"). Its
//   run.head_branch/run.head_sha instead report the *reviewed PR's* own
//   branch/commit, never the workflow's source, so trust here rests on the
//   event type alone, plus the repository/run-attempt/actor checks below and
//   the display_title PR-number match performed further down.
// - pull_request_review: GITHUB_SHA/REF are documented as "last merge commit
//   on the GITHUB_REF branch" / "PR merge branch refs/pull/N/merge" — the
//   *same* values as plain pull_request. There is no platform guarantee that
//   its workflow definition comes from the default branch: a PR could modify
//   this workflow file on its own branch and have that version execute when
//   a review is submitted on it. Event type alone is therefore NOT
//   sufficient evidence for this event (unlike pull_request_target) — it
//   additionally requires proof that the workflow file's content at the
//   reviewed commit is byte-identical to the default branch's copy
//   (run.workflow_definition_matches_default_branch, computed in main() via
//   the Contents API). A PR that tampered with the workflow file fails this
//   check regardless of what it did with the rest of its branch.
//
// run.pull_requests cannot substitute for any of this: GitHub computes it
// dynamically from currently-open PRs on the matching branch, so it goes
// empty as soon as the PR merges or its branch is deleted — exactly the case
// this gate must still verify (Ralph checks squad evidence against
// historical, often now-merged, heads).
const defaultBranchAnchoredEvents = new Set([
  'issue_comment',
  'workflow_dispatch',
]);
const platformAnchoredEvents = new Set(['pull_request_target']);
const contentVerifiedEvents = new Set(['pull_request_review']);

function result(classification, reason, evidence = {}) {
  return { classification, reason, ...evidence };
}

export function bindStatusToHead(status, headSha) {
  if (status.sha && status.sha.toLowerCase() !== headSha.toLowerCase()) {
    throw new Error('Commit status SHA does not match the requested head.');
  }
  return { ...status, sha: headSha };
}

// Escapes regex metacharacters in a string so it can be safely interpolated
// into a `new RegExp(...)` pattern as a literal match, rather than as regex
// syntax. Required for any value built from a command-line argument or other
// external input before it is used to construct a dynamic RegExp.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRunTarget(targetUrl, repository) {
  try {
    const url = new URL(targetUrl);
    const escapedRepository = escapeRegExp(repository);
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
  return { prNumber: Number.parseInt(match[1], 10) };
}

// The record encodes its outcome in the status state and description:
//   success  `REVIEWED (self-attested) @ <sha12> by <agents>`             -> agents reviewed
//   success  `REVIEWED (self-attested, carried across sync) @ <sha12> by <agents>`
//            -> agents reviewed an earlier head, and the PR's own diff against
//               its base branch is proven byte-for-byte unchanged since then
//               (a pure base-branch sync merge), so the record was carried
//               forward rather than re-earned
//   success  `APPROVE (owner) @ <sha12> by <login>`           -> owner authorised
//   success  `NOT_APPLICABLE @ <sha12>: <reason>`             -> out of gate scope
//   failure  `REQUEST_CHANGES @ <sha12> by <reviewer>`        -> findings raised
//   failure  `BLOCKED @ <sha12>: <reason>`                    -> nothing recorded
//
// REVIEWED and APPROVE are kept distinct on purpose. Only the owner path is a
// real authorisation by a distinct principal; REVIEWED is a self-attested record
// that reviewer agents examined the commit, and must never be reported as though
// an independent party approved it. The "carried across sync" qualifier is
// likewise never dropped: it is the one thing that distinguishes "reviewed this
// exact diff" from "reviewed an earlier diff that a base sync provably did not
// change", and collapsing the two would let a sync silently read as a fresh
// review of new content.
//
// NOT_APPLICABLE is a `success` state so an out-of-scope PR is not decorated
// with a red status nobody can clear, but it is emphatically NOT merge evidence:
// it means no review was required because the PR is out of scope, which is
// precisely why such a PR must not be merged unattended.
function parseStatusDescription(status, statusSha) {
  const description = status.description ?? '';
  // `statusSha` may originate from the `--expected-head` command-line argument,
  // so it must be escaped before use in a dynamic RegExp even though it is
  // separately validated as a 40-character hex SHA.
  const shortSha = escapeRegExp(statusSha.slice(0, 12));
  if (status.state === 'success') {
    const reviewed = new RegExp(
      `^REVIEWED \\(self-attested(?<carried>, carried across sync)?\\) @ ${shortSha} by (\\S.*)$`,
    ).exec(description);
    if (reviewed) {
      return {
        verdict: 'REVIEWED',
        reviewers: reviewed[2],
        carriedAcrossSync: Boolean(reviewed.groups?.carried),
      };
    }
    const notApplicable = new RegExp(
      `^NOT_APPLICABLE @ ${shortSha}: (\\S.*)$`,
    ).exec(description);
    if (notApplicable) {
      return {
        verdict: 'NOT_APPLICABLE',
        reviewers: '',
        detail: notApplicable[1],
      };
    }
    const owner = new RegExp(
      `^APPROVE \\(owner\\) @ ${shortSha} by (\\S.*)$`,
    ).exec(description);
    return owner ? { verdict: 'APPROVE', reviewers: owner[1] } : undefined;
  }
  if (status.state === 'failure') {
    const rejected = new RegExp(
      `^REQUEST_CHANGES @ ${shortSha} by (\\S.*)$`,
    ).exec(description);
    if (rejected) {
      return { verdict: 'REQUEST_CHANGES', reviewers: rejected[1] };
    }
    const blocked = new RegExp(`^BLOCKED @ ${shortSha}: (\\S.*)$`).exec(
      description,
    );
    if (blocked) {
      return { verdict: 'BLOCKED', reviewers: '', detail: blocked[1] };
    }
  }
  return undefined;
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

/**
 * Process exit code for a verdict classification.
 *
 * Exported so the mapping is executable in tests rather than asserted by
 * reading the source: this is the single point where "did squad evidence permit
 * this merge?" becomes a number the unattended merger branches on, so a silent
 * regression here is a merge-safety regression.
 *
 *   0  REVIEWED / APPROVED    — usable merge evidence
 *   2  CHANGES_REQUESTED      — a current rejection; route back to the author
 *   3  MISSING / INVALID / SUPERSEDED — no usable evidence; admin approval only
 *   4  NOT_APPLICABLE         — out of scope; a human owns the merge
 *
 * NOT_APPLICABLE deliberately does NOT map to 0. Its commit status is green,
 * but green there means "no review was required", not "reviewed"; collapsing it
 * to 0 would turn every unlabelled PR into an unattended merge, which is the
 * exact failure the scoping exists to prevent. Anything unrecognised falls to 3
 * (no evidence) rather than 0, so a future classification cannot fail open.
 */
export function exitCodeFor(classification) {
  switch (classification) {
    case 'APPROVED':
    case 'REVIEWED':
      return 0;
    case 'CHANGES_REQUESTED':
      return 2;
    case 'NOT_APPLICABLE':
      return 4;
    default:
      return 3;
  }
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
  const currentHeadSha = pull.head?.sha?.toLowerCase();
  const statusSha = status.sha?.toLowerCase();
  if (!repository || !defaultBranch || !currentHeadSha || !statusSha) {
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

  // Proves the workflow definition genuinely ran from the default branch,
  // using whichever evidence is meaningful for this event type — see the
  // comments above defaultBranchAnchoredEvents / platformAnchoredEvents /
  // contentVerifiedEvents. The PR-number binding comes from the display_title
  // check further down, not from any field checked here.
  const runSourceIsTrusted = defaultBranchAnchoredEvents.has(run.event)
    ? run.head_branch === defaultBranch &&
      run.default_branch_contains_run === true
    : platformAnchoredEvents.has(run.event)
      ? true
      : contentVerifiedEvents.has(run.event) &&
        run.workflow_definition_matches_default_branch === true;

  if (
    run.path !== verdictWorkflowPath ||
    !trustedEvents.has(run.event) ||
    run.run_attempt !== 1 ||
    run.triggering_actor?.login?.toLowerCase() !==
      run.actor?.login?.toLowerCase() ||
    !runSourceIsTrusted ||
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
  if (!title || title.prNumber !== pull.number) {
    return result(
      'INVALID',
      'The workflow run metadata does not match the status.',
    );
  }

  const outcome = parseStatusDescription(status, statusSha);
  if (!outcome || !isStatusCreatedDuringRun(status, run)) {
    return result(
      'INVALID',
      'The status does not match the trusted workflow verdict.',
    );
  }

  // A block means no usable review record was accepted. The gate's own reason is
  // preserved verbatim because the subcases are materially different — an
  // unauthenticated author or a fork PR is not the same as nobody reviewing —
  // and collapsing them would tell the caller the opposite of what happened.
  if (outcome.verdict === 'BLOCKED') {
    return result(
      'MISSING',
      `The gate blocked ${statusSha}: ${outcome.detail}`,
      {
        reviewedHeadSha: statusSha,
        blockedReason: outcome.detail,
      },
    );
  }

  // Out of scope is not merge evidence. It reports success so the PR carries no
  // unclearable red status, but it means no review was required — so it must
  // never satisfy the unattended merger. Returned before the superseded check
  // because scope is a property of the PR, not of a particular commit.
  //
  // `reviewedHeadSha` is deliberately left unset. The merge step is
  // `gh pr merge --match-head-commit <reviewedHeadSha>`, so populating it here
  // would hand an autonomous merger the exact argument it needs to merge code
  // nothing reviewed — on a result whose commit status is green. Withholding it
  // makes the merge command fail to construct rather than relying on the caller
  // to honour the exit code.
  if (outcome.verdict === 'NOT_APPLICABLE') {
    return result(
      'NOT_APPLICABLE',
      `The squad review gate does not apply to ${statusSha}: ${outcome.detail}`,
      { blockedReason: outcome.detail },
    );
  }

  if (statusSha !== currentHeadSha) {
    return result(
      'SUPERSEDED',
      `${outcome.verdict} applies to ${statusSha}, not current head ${currentHeadSha}.`,
      {
        verdict: outcome.verdict,
        reviewedHeadSha: statusSha,
        actor: outcome.reviewers,
      },
    );
  }

  // REVIEWED is a self-attested agent record; APPROVED is an owner
  // authorisation. Both permit merge under this repository's single-maintainer
  // policy, but they are reported separately so nothing downstream can present
  // a self-attested record as independent approval.
  const classification =
    outcome.verdict === 'REVIEWED'
      ? 'REVIEWED'
      : outcome.verdict === 'APPROVE'
        ? 'APPROVED'
        : 'CHANGES_REQUESTED';
  // The carried-across-sync qualifier is preserved through to the reason text
  // rather than folded away: it is the fact that distinguishes "this exact
  // diff was reviewed" from "an earlier diff was reviewed and a base sync
  // provably introduced no author content since", and both the status and
  // this verifier must keep saying so explicitly.
  const carriedAcrossSync =
    classification === 'REVIEWED' && outcome.carriedAcrossSync === true;
  const reason =
    classification === 'REVIEWED'
      ? carriedAcrossSync
        ? 'Verified SHA-pinned self-attested squad review record, carried ' +
          'forward across a pure base sync (not independent review).'
        : 'Verified SHA-pinned self-attested squad review record (not independent review).'
      : 'Verified SHA-pinned squad record.';
  return result(classification, reason, {
    verdict: outcome.verdict,
    reviewedHeadSha: statusSha,
    actor: outcome.reviewers,
    workflowRunUrl: run.html_url,
    ...(classification === 'REVIEWED' ? { carriedAcrossSync } : {}),
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
    // Deliberately fail closed on the newest candidate only: an older approval
    // must never be resurrected by a newer status being unusable.
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

// Returns the git blob SHA of the gate workflow file at `ref`, or undefined
// if it cannot be read there (e.g. deleted on that branch, or the ref itself
// is gone). A missing file must never be treated as a match.
function fetchWorkflowBlobSha(repository, ref) {
  try {
    const content = ghApi(
      `/repos/${repository}/contents/${verdictWorkflowPath}?ref=${encodeURIComponent(ref)}`,
    );
    return content.sha;
  } catch {
    return undefined;
  }
}

// Independent proof for pull_request_review runs (see contentVerifiedEvents
// above): GitHub does not guarantee this event's workflow definition comes
// from the default branch, so this compares the actual file content at the
// reviewed commit against the default branch's copy. A PR that tampered with
// the workflow file on its own branch fails this regardless of run.event.
function workflowDefinitionMatchesDefaultBranch(
  repository,
  headSha,
  defaultBranch,
) {
  const headBlobSha = fetchWorkflowBlobSha(repository, headSha);
  const defaultBlobSha = fetchWorkflowBlobSha(repository, defaultBranch);
  return Boolean(headBlobSha) && headBlobSha === defaultBlobSha;
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
        workflow_definition_matches_default_branch:
          run.event === 'pull_request_review'
            ? workflowDefinitionMatchesDefaultBranch(
                args.repo,
                run.head_sha,
                pull.base.repo.default_branch,
              )
            : undefined,
      };
    },
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
  } else {
    process.stdout.write(`${verdict.classification}: ${verdict.reason}\n`);
  }

  process.exitCode = exitCodeFor(verdict.classification);
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
