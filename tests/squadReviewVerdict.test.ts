import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  bindStatusToHead,
  selectSquadVerdict,
  verdictContext,
  verdictWorkflowPath,
  verifySquadVerdict,
} from '../scripts/verify-squad-verdict.mjs';

// Ported from OlyForge3D/PrintFarmer's scripts/ci/tests/test-squad-verdict.mjs
// (PR #1187, fixing PrintFarmer issue #1116 -- the same structural problem
// this repository's issue #187 raises). Logic and fixture shapes are ported
// as-is; the harness is vitest to match this repo's existing convention
// (tests/protectionAssumptions.test.ts, tests/reviewHeadCoverage.test.ts)
// rather than PrintFarmer's node:test.

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const reviewedHeadSha = 'a'.repeat(40);
const movedHeadSha = 'b'.repeat(40);

function fixture(verdict = 'APPROVE') {
  const actor = 'trusted-maintainer';
  const state = verdict === 'APPROVE' ? 'success' : 'failure';
  const pull = {
    number: 187,
    user: { login: 'pr-author' },
    head: { sha: reviewedHeadSha },
    base: {
      repo: {
        full_name: 'OlyForge3D/PrintFarmerDesktop',
        default_branch: 'development',
      },
    },
  };
  const status = {
    id: 42,
    context: verdictContext,
    state,
    sha: reviewedHeadSha,
    description: `${verdict} @ ${reviewedHeadSha.slice(0, 12)} by ${actor}`,
    target_url:
      'https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/123456',
    creator: { login: 'github-actions[bot]' },
    created_at: '2026-08-07T03:00:10Z',
  };
  const run = {
    id: 123456,
    html_url: status.target_url,
    path: verdictWorkflowPath,
    event: 'workflow_dispatch',
    run_attempt: 1,
    head_branch: 'development',
    head_sha: 'c'.repeat(40),
    default_branch_contains_run: true,
    repository: { full_name: 'OlyForge3D/PrintFarmerDesktop' },
    actor: { login: actor },
    triggering_actor: { login: actor },
    display_title: `Squad verdict ${verdict} for PR #187 @ ${reviewedHeadSha} by ${actor}`,
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-08-07T03:00:00Z',
    updated_at: '2026-08-07T03:00:20Z',
  };
  return { pull, status, run };
}

describe('a trusted, exact-head verdict', () => {
  it('accepts a trusted approval for the exact current head', () => {
    const evidence = fixture();
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('APPROVED');
    expect(verdict.reviewedHeadSha).toBe(reviewedHeadSha);
  });

  it('binds the list-statuses API shape to the requested head', () => {
    const evidence = fixture();
    const apiStatus = Object.fromEntries(
      Object.entries(evidence.status).filter(([key]) => key !== 'sha'),
    );
    const status = bindStatusToHead(apiStatus, reviewedHeadSha);
    const verdict = verifySquadVerdict({ ...evidence, status });
    expect(verdict.classification).toBe('APPROVED');
  });

  it('rejects a status whose explicit SHA disagrees with the requested head', () => {
    const evidence = fixture();
    expect(() => bindStatusToHead(evidence.status, movedHeadSha)).toThrow(
      /does not match the requested head/,
    );
  });

  it('blocks a trusted changes-requested verdict for the exact current head', () => {
    const evidence = fixture('CHANGES_REQUESTED');
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('CHANGES_REQUESTED');
    expect(verdict.verdict).toBe('CHANGES_REQUESTED');
  });
});

describe('head movement supersedes a recorded verdict, in both directions', () => {
  it('supersedes an approval when rebase or force-push moves the head', () => {
    const evidence = fixture();
    evidence.pull.head.sha = movedHeadSha;
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('SUPERSEDED');
    expect(verdict.verdict).toBe('APPROVE');
  });

  it('supersedes a rejection when rebase or force-push moves the head', () => {
    const evidence = fixture('REJECT');
    evidence.pull.head.sha = movedHeadSha;
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('SUPERSEDED');
    expect(verdict.verdict).toBe('REJECT');
  });

  it.each(['APPROVE', 'REJECT'])(
    'selector supersedes stale %s evidence from an expected head',
    (verdictName) => {
      const evidence = fixture(verdictName);
      evidence.pull.head.sha = movedHeadSha;
      const verdict = selectSquadVerdict({
        pull: evidence.pull,
        statuses: [evidence.status],
        statusHeadSha: reviewedHeadSha,
        loadRun: () => evidence.run,
      });
      expect(verdict.classification).toBe('SUPERSEDED');
      expect(verdict.verdict).toBe(verdictName);
    },
  );
});

describe('forgery and lookalike attempts are rejected, not merely unconvincing', () => {
  it('rejects a status not created by GitHub Actions', () => {
    const evidence = fixture();
    evidence.status.creator.login = 'pr-author';
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });

  it('rejects a workflow run dispatched by the PR author', () => {
    const evidence = fixture();
    evidence.run.actor.login = 'pr-author';
    evidence.run.display_title = `Squad verdict APPROVE for PR #187 @ ${reviewedHeadSha} by pr-author`;
    evidence.status.description = `APPROVE @ ${reviewedHeadSha.slice(0, 12)} by pr-author`;
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });

  it('rejects a lookalike status from an untrusted workflow', () => {
    const evidence = fixture();
    evidence.run.path = '.github/workflows/lookalike.yml';
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });

  it('author-authored lookalike comments cannot satisfy the verifier', () => {
    const evidence = fixture();
    const verdict = verifySquadVerdict({
      pull: evidence.pull,
      comments: [
        {
          user: { login: 'pr-author' },
          body: evidence.run.display_title,
        },
      ],
    });
    expect(verdict.classification).toBe('MISSING');
  });

  it('newest trusted-run evidence fails closed instead of reviving an older approval', () => {
    const older = fixture();
    older.status.id = 41;
    older.status.created_at = '2026-08-07T02:59:10Z';

    const newer = fixture('REJECT');
    newer.status.id = 43;
    newer.status.target_url =
      'https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/123457';
    newer.run.id = 123457;
    newer.run.html_url = newer.status.target_url;
    newer.run.display_title =
      `Squad verdict REJECT for PR #187 @ ${reviewedHeadSha.toUpperCase()} ` +
      'by trusted-maintainer';

    const verdict = selectSquadVerdict({
      pull: newer.pull,
      statuses: [older.status, newer.status],
      loadRun: (runId: number) =>
        runId === newer.run.id ? newer.run : older.run,
    });
    expect(verdict.classification).toBe('INVALID');
  });

  it('rerunning an older approval cannot supersede a newer rejection', () => {
    const rejection = fixture('REJECT');
    rejection.status.id = 44;
    rejection.status.created_at = '2026-08-07T03:01:10Z';
    rejection.status.target_url =
      'https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/123458';
    rejection.run.id = 123458;
    rejection.run.html_url = rejection.status.target_url;

    const replayedApproval = fixture();
    replayedApproval.status.id = 45;
    replayedApproval.status.created_at = '2026-08-07T03:02:10Z';
    replayedApproval.run.run_attempt = 2;
    replayedApproval.run.triggering_actor.login = 'write-collaborator';

    const verdict = selectSquadVerdict({
      pull: replayedApproval.pull,
      statuses: [rejection.status, replayedApproval.status],
      loadRun: (runId: number) =>
        runId === replayedApproval.run.id
          ? replayedApproval.run
          : rejection.run,
    });
    expect(verdict.classification).toBe('INVALID');
  });
});

describe('the workflow file itself keeps the independent-recorder and exact-head controls', () => {
  it('has not lost the checks the verifier assumes are enforced server-side', () => {
    const workflow = readFileSync(
      path.join(
        repositoryRoot,
        '.github',
        'workflows',
        'squad-review-verdict.yml',
      ),
      'utf8',
    ).replaceAll('\r\n', '\n');

    expect(workflow).toContain(
      "run-name: 'Squad verdict ${{ inputs.verdict }} for PR " +
        '#${{ inputs.pr_number }} @ ${{ inputs.reviewed_head_sha }} ' +
        "by ${{ github.actor }}'",
    );
    expect(workflow).toMatch(/^\s+statuses: write$/m);
    expect(workflow).toMatch(/\/\^\[1-9\]\\d\*\$\/\.test\(prNumberInput\)/);
    expect(workflow).toMatch(
      /\/\^\[0-9a-f\]\{40\}\$\/\.test\(reviewedHeadSha\)/,
    );
    expect(workflow).toMatch(
      /pull\.user\.login\.toLowerCase\(\) === actor\.toLowerCase\(\)/,
    );
    expect(workflow).toMatch(
      /pull\.head\.sha\.toLowerCase\(\) !== reviewedHeadSha/,
    );
    expect(workflow).toMatch(/getCollaboratorPermissionLevel/);
    expect(workflow).toMatch(/actorPermission\.permission !== 'admin'/);
    expect(workflow).toMatch(/runAttempt !== '1'/);
    expect(workflow).toMatch(
      /triggeringActor\.toLowerCase\(\) !== actor\.toLowerCase\(\)/,
    );
    expect(workflow).toMatch(/context: 'squad\/pre-pr-verdict'/);
    expect(workflow).not.toMatch(/pull-requests: write/);
  });
});
