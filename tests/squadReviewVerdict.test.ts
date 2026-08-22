import { describe, expect, it } from 'vitest';

import {
  evaluateGate,
  rosterFromLabels,
} from '../scripts/squad-verdict-gate.mjs';
import {
  bindStatusToHead,
  exitCodeFor,
  selectSquadVerdict,
  verdictContext,
  verdictWorkflowPath,
  verifySquadVerdict,
} from '../scripts/verify-squad-verdict.mjs';

// Ported from OlyForge3D/PrintFarmer's scripts/ci/tests/test-squad-verdict.mjs
// (PR #1316, fixing PrintFarmer issue #1310) for this repository's issue #740,
// replacing the earlier port of PrintFarmer PR #1187. Every case is carried
// across; the harness is vitest to match this repo's convention rather than
// PrintFarmer's node:test.

const repository = 'OlyForge3D/PrintFarmerDesktop';
const reviewedHeadSha = 'a'.repeat(40);
const movedHeadSha = 'b'.repeat(40);
const shortSha = reviewedHeadSha.slice(0, 12);

function fixture(verdict = 'APPROVE') {
  const actor = 'jpapiez';
  const state = verdict === 'APPROVE' ? 'success' : 'failure';
  const description =
    verdict === 'APPROVE'
      ? `REVIEWED (self-attested) @ ${shortSha} by bishop+hicks+vasquez`
      : `REQUEST_CHANGES @ ${shortSha} by vasquez`;
  const pull = {
    number: 740,
    user: { login: 'pr-author' },
    head: { sha: reviewedHeadSha },
    base: {
      ref: 'development',
      repo: {
        full_name: repository,
        default_branch: 'development',
      },
    },
  };
  const status = {
    id: 42,
    context: verdictContext,
    state,
    sha: reviewedHeadSha,
    description,
    target_url: `https://github.com/${repository}/actions/runs/123456`,
    creator: { login: 'github-actions[bot]' },
    created_at: '2026-08-07T03:00:10Z',
  };
  const run = {
    id: 123456,
    html_url: status.target_url,
    path: verdictWorkflowPath,
    event: 'issue_comment',
    run_attempt: 1,
    head_branch: 'development',
    head_sha: 'c'.repeat(40),
    default_branch_contains_run: true,
    repository: { full_name: repository },
    actor: { login: actor },
    triggering_actor: { login: actor },
    display_title: 'Squad review record for PR #740',
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-08-07T03:00:00Z',
    updated_at: '2026-08-07T03:00:20Z',
  };
  return { pull, status, run };
}

describe('a trusted, exact-head record', () => {
  it('accepts a trusted review record for the exact current head', () => {
    const evidence = fixture();
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('REVIEWED');
    expect(verdict.reviewedHeadSha).toBe(reviewedHeadSha);
    expect(verdict.actor).toBe('bishop+hicks+vasquez');
    expect(verdict.carriedAcrossSync).toBe(false);
  });

  it('a carried-across-sync description is classified REVIEWED and flagged as such', () => {
    const evidence = fixture();
    evidence.status.description = `REVIEWED (self-attested, carried across sync) @ ${shortSha} by bishop+hicks+vasquez`;
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('REVIEWED');
    expect(verdict.actor).toBe('bishop+hicks+vasquez');
    expect(verdict.carriedAcrossSync).toBe(true);
    expect(verdict.reason).toMatch(/carried forward across a pure base sync/);
  });

  it('a plain reviewed description (no sync suffix) is not flagged as carried', () => {
    const verdict = verifySquadVerdict(fixture());
    expect(verdict.classification).toBe('REVIEWED');
    expect(verdict.carriedAcrossSync).toBe(false);
    expect(verdict.reason).not.toMatch(/carried forward/);
  });

  it('accepts the agent-verdict events the gate actually runs on', () => {
    for (const event of [
      'pull_request_target',
      'issue_comment',
      'pull_request_review',
      'workflow_dispatch',
    ]) {
      const evidence = fixture();
      evidence.run.event = event;
      // pull_request_target and pull_request_review runs report the reviewed
      // PR's own head branch here, never the default branch — this must not
      // affect the outcome.
      if (event === 'pull_request_target' || event === 'pull_request_review') {
        evidence.run.head_branch = 'squad/740-some-feature';
        evidence.run.default_branch_contains_run = false;
      }
      // pull_request_review additionally requires independent proof that the
      // workflow file content matches the default branch, since GitHub does not
      // guarantee its workflow definition is sourced from there.
      if (event === 'pull_request_review') {
        (
          evidence.run as Record<string, unknown>
        ).workflow_definition_matches_default_branch = true;
      }
      expect(verifySquadVerdict(evidence).classification, event).toBe(
        'REVIEWED',
      );
    }
  });

  it('rejects a run triggered from the pull request head ref', () => {
    const evidence = fixture();
    evidence.run.event = 'pull_request';
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });

  it('accepts a verdict recorded by the PR author account', () => {
    // Every squad agent acts through the owner token, so GitHub-account-level
    // author checking is exactly what made the old gate unsatisfiable — this
    // repository has one collaborator, who authors every agent PR. Reviewer
    // separation is enforced at squad-identity level inside the gate itself.
    const evidence = fixture();
    evidence.pull.user.login = 'jpapiez';
    expect(verifySquadVerdict(evidence).classification).toBe('REVIEWED');
  });

  it('binds the list-statuses API shape to the requested head', () => {
    const evidence = fixture();
    const apiStatus: Record<string, unknown> = { ...evidence.status };
    delete apiStatus.sha;
    const status = bindStatusToHead(apiStatus, reviewedHeadSha);
    expect(verifySquadVerdict({ ...evidence, status }).classification).toBe(
      'REVIEWED',
    );
  });

  it('rejects a status whose explicit SHA disagrees with the requested head', () => {
    const evidence = fixture();
    expect(() => bindStatusToHead(evidence.status, movedHeadSha)).toThrow(
      /does not match the requested head/,
    );
  });

  it('blocks a trusted changes-requested verdict for the exact current head', () => {
    const evidence = fixture('REQUEST_CHANGES');
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('CHANGES_REQUESTED');
    expect(verdict.verdict).toBe('REQUEST_CHANGES');
  });
});

describe('head movement supersedes a recorded verdict, in both directions', () => {
  it('supersedes a review record when rebase or force-push moves the head', () => {
    const evidence = fixture();
    evidence.pull.head.sha = movedHeadSha;
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('SUPERSEDED');
    expect(verdict.verdict).toBe('REVIEWED');
  });

  it('supersedes a rejection when rebase or force-push moves the head', () => {
    const evidence = fixture('REQUEST_CHANGES');
    evidence.pull.head.sha = movedHeadSha;
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('SUPERSEDED');
    expect(verdict.verdict).toBe('REQUEST_CHANGES');
  });

  it.each([
    ['APPROVE', 'REVIEWED'],
    ['REQUEST_CHANGES', 'REQUEST_CHANGES'],
  ])(
    'selector supersedes stale %s evidence from an expected head',
    (fixtureKind, expected) => {
      const evidence = fixture(fixtureKind);
      evidence.pull.head.sha = movedHeadSha;
      const verdict = selectSquadVerdict({
        pull: evidence.pull,
        statuses: [evidence.status],
        statusHeadSha: reviewedHeadSha,
        loadRun: () => evidence.run,
      });
      expect(verdict.classification).toBe('SUPERSEDED');
      expect(verdict.verdict).toBe(expected);
    },
  );
});

describe('a self-attested record is never reported as independent approval', () => {
  it('an owner authorisation is classified apart from a self-attested record', () => {
    const evidence = fixture();
    evidence.status.description = `APPROVE (owner) @ ${shortSha} by jpapiez`;
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('APPROVED');
    expect(verdict.actor).toBe('jpapiez');

    const selfAttested = verifySquadVerdict(fixture());
    expect(selfAttested.classification).toBe('REVIEWED');
    expect(selfAttested.reason).toMatch(
      /self-attested.*not independent review/,
    );
  });

  it('a bare APPROVE description is not accepted as an owner authorisation', () => {
    const evidence = fixture();
    evidence.status.description = `APPROVE @ ${shortSha} by bishop+hicks+vasquez`;
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });
});

describe('forgery and lookalike attempts are rejected, not merely unconvincing', () => {
  it('rejects a status not created by GitHub Actions', () => {
    const evidence = fixture();
    evidence.status.creator.login = 'pr-author';
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });

  it('rejects a lookalike status from an untrusted workflow', () => {
    const evidence = fixture();
    evidence.run.path = '.github/workflows/lookalike.yml';
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });

  it('rejects a run whose workflow definition came off a non-default branch', () => {
    const evidence = fixture();
    evidence.run.head_branch = 'squad/740-rewrite-the-gate';
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });

  it('rejects a success status whose description is not a recognised record', () => {
    const evidence = fixture();
    evidence.status.description = 'looks fine to me';
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });

  it('rejects a record description pinned to a different short SHA', () => {
    for (const description of [
      `REVIEWED (self-attested) @ ${movedHeadSha.slice(0, 12)} by bishop`,
      `APPROVE (owner) @ ${movedHeadSha.slice(0, 12)} by jpapiez`,
    ]) {
      const evidence = fixture();
      evidence.status.description = description;
      expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
    }
  });

  it('escapes SHA characters before building a dynamic RegExp', () => {
    // The short SHA is interpolated into a dynamic RegExp. If it were not
    // escaped, characters such as '.' would act as wildcards, and a description
    // naming an unrelated 12-character prefix would incorrectly satisfy it.
    const craftedSha = `a${'.'.repeat(11)}${'b'.repeat(28)}`;
    const craftedShort = craftedSha.slice(0, 12);
    const evidence = fixture();
    evidence.pull.head.sha = craftedSha;
    evidence.status.sha = craftedSha;

    const unrelatedPrefix = `a${'x'.repeat(11)}`;
    evidence.status.description = `REVIEWED (self-attested) @ ${unrelatedPrefix} by bishop+hicks+vasquez`;
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');

    evidence.status.description = `REVIEWED (self-attested) @ ${craftedShort} by bishop+hicks+vasquez`;
    expect(verifySquadVerdict(evidence).classification).toBe('REVIEWED');
  });

  it('author-authored lookalike comments cannot satisfy the verifier', () => {
    const evidence = fixture();
    const verdict = verifySquadVerdict({
      pull: evidence.pull,
      comments: [
        {
          user: { login: 'pr-author' },
          body: `REVIEWED (self-attested) @ ${shortSha} by bishop+hicks+vasquez`,
        },
      ],
    });
    expect(verdict.classification).toBe('MISSING');
  });

  it('newest trusted-run evidence fails closed instead of reviving an older record', () => {
    const older = fixture();
    older.status.id = 41;
    older.status.created_at = '2026-08-07T02:59:10Z';

    const newer = fixture('REQUEST_CHANGES');
    newer.status.id = 43;
    newer.status.target_url = `https://github.com/${repository}/actions/runs/123457`;
    newer.status.description = 'BLOCKED: something else entirely';
    newer.run.id = 123457;
    newer.run.html_url = newer.status.target_url;

    const verdict = selectSquadVerdict({
      pull: newer.pull,
      statuses: [older.status, newer.status],
      loadRun: (runId: number) =>
        runId === newer.run.id ? newer.run : older.run,
    });
    expect(verdict.classification).toBe('INVALID');
  });

  it('rerunning an older record cannot supersede a newer rejection', () => {
    const rejection = fixture('REQUEST_CHANGES');
    rejection.status.id = 44;
    rejection.status.created_at = '2026-08-07T03:01:10Z';
    rejection.status.target_url = `https://github.com/${repository}/actions/runs/123458`;
    rejection.run.id = 123458;
    rejection.run.html_url = rejection.status.target_url;

    const replayed = fixture();
    replayed.status.id = 45;
    replayed.status.created_at = '2026-08-07T03:02:10Z';
    replayed.run.run_attempt = 2;

    const verdict = selectSquadVerdict({
      pull: replayed.pull,
      statuses: [rejection.status, replayed.status],
      loadRun: (runId: number) =>
        runId === replayed.run.id ? replayed.run : rejection.run,
    });
    expect(verdict.classification).toBe('INVALID');
  });
});

// A pull_request_target or pull_request_review run reports the *reviewed PR's*
// own head branch (never the default branch or base ref) in run.head_branch.
// pull_request_target's workflow definition is still sourced from the default
// branch by platform guarantee, so event type alone is sufficient evidence for
// it. pull_request_review carries no such guarantee (its GITHUB_SHA/REF are the
// PR's own merge branch, identical to plain pull_request), so it additionally
// requires proof that the workflow file content at the reviewed commit matches
// the default branch's copy. run.pull_requests is deliberately NOT used as
// evidence: GitHub computes it dynamically from currently-open PRs on the
// matching branch, so it goes empty as soon as the PR merges or its branch is
// deleted — exactly the case this gate must still verify, because Ralph checks
// squad evidence against historical, often now-merged, heads.
describe.each(['pull_request_target', 'pull_request_review'])(
  'a %s run',
  (event) => {
    const contentVerified = event === 'pull_request_review';
    const prepare = (evidence: ReturnType<typeof fixture>) => {
      evidence.run.event = event;
      evidence.run.head_branch = 'squad/740-port-verdict-semantics';
      evidence.run.default_branch_contains_run = false;
      if (contentVerified) {
        (
          evidence.run as Record<string, unknown>
        ).workflow_definition_matches_default_branch = true;
      }
      return evidence;
    };

    it("is accepted when head_branch is the PR's own branch", () => {
      expect(verifySquadVerdict(prepare(fixture())).classification).toBe(
        'REVIEWED',
      );
    });

    it('is accepted even after its PR has merged (pull_requests empty)', () => {
      const evidence = prepare(fixture());
      (evidence.run as Record<string, unknown>).pull_requests = [];
      expect(verifySquadVerdict(evidence).classification).toBe('REVIEWED');
    });

    it('is rejected when its display title names a different PR', () => {
      const evidence = prepare(fixture());
      evidence.run.display_title = 'Squad review record for PR #9999';
      expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
    });
  },
);

describe('a pull_request_review run is not trusted on event type alone', () => {
  // GitHub does not guarantee this event's workflow definition is sourced from
  // the default branch (unlike pull_request_target). A PR author who edits the
  // gate workflow on their own branch and gets a review submitted on that PR
  // must not have the resulting run accepted as trusted evidence.
  it('rejects it when the workflow file does not match the default branch', () => {
    const evidence = fixture();
    evidence.run.event = 'pull_request_review';
    evidence.run.head_branch = 'squad/740-tampered';
    (
      evidence.run as Record<string, unknown>
    ).workflow_definition_matches_default_branch = false;
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });

  it('rejects it when the workflow content match is unproven', () => {
    const evidence = fixture();
    evidence.run.event = 'pull_request_review';
    evidence.run.head_branch = 'squad/740-tampered';
    // workflow_definition_matches_default_branch left undefined: simulates a
    // Contents API lookup failure, which must fail closed, not open.
    expect(verifySquadVerdict(evidence).classification).toBe('INVALID');
  });
});

describe('the gate result reaches the merge decision intact', () => {
  it('a gate block is missing evidence, not a reviewer rejection', () => {
    // Ralph routes CHANGES_REQUESTED back to the author but treats MISSING as
    // "no squad evidence", which permits the administrator fallback. Conflating
    // the two would suppress that fallback for PRs nobody has reviewed yet.
    //
    // This case is produced by the workflow rather than by evaluateGate, so it
    // is asserted literally. Every gate-produced form is covered by the
    // round-trip test below, which derives its strings from evaluateGate itself.
    const evidence = fixture('REQUEST_CHANGES');
    const detail = 'fork PR needs a repository administrator';
    evidence.status.description = `BLOCKED @ ${shortSha}: ${detail}`;
    const verdict = verifySquadVerdict(evidence);
    expect(verdict.classification).toBe('MISSING');
    expect(verdict.blockedReason).toBe(detail);
    expect(verdict.reason).toMatch(/fork PR needs a repository administrator/);
  });

  it('every description evaluateGate can emit round-trips through the verifier', () => {
    // Derived from the gate, never hand-written: a hand-written fixture proves
    // only that the verifier parses the string someone imagined, not the string
    // the gate actually produces. Contract drift between the two would either
    // block every merge or silently downgrade a reason operators act on.
    const roster = rosterFromLabels([
      'squad:bishop',
      'squad:hicks',
      'squad:vasquez',
      'squad:ripley',
      'squad:dallas',
    ]);
    const codePaths = ['src/main/index.ts'];
    const docPaths = ['docs/ARCHITECTURE.md'];
    const record = (
      reviewer: string,
      verdict: string,
      sha = reviewedHeadSha,
      extra: Record<string, unknown> = {},
    ) => ({
      body: [
        '<!-- squad-verdict -->',
        `Squad-Reviewer: ${reviewer}`,
        `Squad-Verdict: ${verdict}`,
        `Squad-Head-SHA: ${sha}`,
      ].join('\n'),
      user: { login: 'jpapiez' },
      author_association: 'OWNER',
      squadWriteAccess: true,
      created_at: '2026-08-08T01:00:00Z',
      updated_at: '2026-08-08T01:00:00Z',
      ...extra,
    });
    const base = {
      headSha: reviewedHeadSha,
      roster,
      authorMembers: new Set(['ripley']),
      authorSource: 'squad: label on linked issue',
      squadLabeled: true,
    };
    const panel = ['bishop', 'hicks', 'vasquez'];

    const scenarios: Array<[string, Record<string, unknown>, string]> = [
      ['no record at all', { changedPaths: codePaths }, 'MISSING'],
      // Out of scope must NOT round-trip to REVIEWED/APPROVED: the status is
      // green, but green here means "no review was required", and treating that
      // as merge evidence would auto-merge every unlabelled PR.
      [
        'no squad label',
        { changedPaths: codePaths, squadLabeled: false },
        'NOT_APPLICABLE',
      ],
      [
        'unauthenticated author',
        {
          changedPaths: codePaths,
          comments: panel.map((member) =>
            record(member, 'APPROVE', reviewedHeadSha, {
              user: { login: 'stranger' },
              author_association: 'NONE',
              squadWriteAccess: false,
            }),
          ),
        },
        'MISSING',
      ],
      [
        'too few reviewers for a code change',
        { changedPaths: codePaths, comments: [record('bishop', 'APPROVE')] },
        'MISSING',
      ],
      [
        'full gate, every record stale',
        {
          changedPaths: codePaths,
          comments: panel.map((member) =>
            record(member, 'APPROVE', movedHeadSha),
          ),
        },
        'MISSING',
      ],
      [
        'docs-only, record stale',
        {
          changedPaths: docPaths,
          comments: [record('dallas', 'APPROVE', movedHeadSha)],
        },
        'MISSING',
      ],
      [
        'reviewer is the PR author',
        { changedPaths: docPaths, comments: [record('ripley', 'APPROVE')] },
        'MISSING',
      ],
      [
        'reviewer requested changes',
        {
          changedPaths: codePaths,
          comments: [record('vasquez', 'REQUEST_CHANGES')],
        },
        'CHANGES_REQUESTED',
      ],
      [
        'full panel recorded a review',
        {
          changedPaths: codePaths,
          comments: panel.map((member) => record(member, 'APPROVE')),
        },
        'REVIEWED',
      ],
      [
        'full panel review carried forward across a base sync',
        {
          changedPaths: codePaths,
          comments: panel.map((member) =>
            record(member, 'APPROVE', movedHeadSha),
          ),
          carriedShas: new Set([movedHeadSha]),
        },
        'REVIEWED',
      ],
      [
        'docs-only, one record',
        { changedPaths: docPaths, comments: [record('dallas', 'APPROVE')] },
        'REVIEWED',
      ],
      [
        'owner override by comment',
        {
          changedPaths: codePaths,
          comments: [
            record('jpapiez', 'APPROVE', reviewedHeadSha, {
              squadAdminOverride: true,
            }),
          ],
        },
        'APPROVED',
      ],
      [
        'owner override by GitHub review',
        {
          changedPaths: codePaths,
          reviews: [
            {
              state: 'APPROVED',
              commitId: reviewedHeadSha,
              login: 'jpapiez',
              isAdmin: true,
            },
          ],
        },
        'APPROVED',
      ],
    ];

    for (const [name, input, expected] of scenarios) {
      const result = evaluateGate({ ...base, ...input });
      const evidence = fixture();
      evidence.status.state = result.state;
      evidence.status.description = result.description;
      const verdict = verifySquadVerdict(evidence);
      expect(verdict.classification, `${name}: ${result.description}`).toBe(
        expected,
      );
      if (result.description.startsWith('BLOCKED')) {
        expect(
          verdict.blockedReason,
          `${name}: blockedReason must be preserved verbatim`,
        ).toBe(result.description.slice(`BLOCKED @ ${shortSha}: `.length));
      }

      // The exit code is what the unattended merger branches on, so check it for
      // every description the gate can emit rather than only for hand-written
      // classifications.
      const merges = expected === 'REVIEWED' || expected === 'APPROVED';
      expect(
        exitCodeFor(verdict.classification),
        `${name}: wrong exit code for ${expected}`,
      ).toBe(
        merges
          ? 0
          : ((
              { CHANGES_REQUESTED: 2, NOT_APPLICABLE: 4 } as Record<
                string,
                number
              >
            )[expected] ?? 3),
      );

      // reviewedHeadSha is the --match-head-commit argument. It must exist for
      // real evidence and must NOT exist otherwise — handing it out on a green
      // NOT_APPLICABLE would supply exactly the argument needed to merge code
      // nothing reviewed.
      if (merges) {
        expect(verdict.reviewedHeadSha, `${name}: missing head SHA`).toBe(
          reviewedHeadSha,
        );
      } else if (expected === 'NOT_APPLICABLE') {
        expect(
          verdict.reviewedHeadSha,
          `${name}: out-of-scope results must not supply a mergeable head SHA`,
        ).toBeUndefined();
      }
    }
  });

  it('exit codes never fail open', () => {
    expect(exitCodeFor('REVIEWED')).toBe(0);
    expect(exitCodeFor('APPROVED')).toBe(0);
    expect(exitCodeFor('CHANGES_REQUESTED')).toBe(2);
    expect(exitCodeFor('MISSING')).toBe(3);
    expect(exitCodeFor('INVALID')).toBe(3);
    expect(exitCodeFor('SUPERSEDED')).toBe(3);
    expect(exitCodeFor('NOT_APPLICABLE')).toBe(4);
    // A classification added later must not silently become "clear to merge".
    expect(exitCodeFor('SOMETHING_NEW')).toBe(3);
    expect(exitCodeFor(undefined)).toBe(3);
  });
});
