import { describe, expect, it } from 'vitest';

import {
  VERDICT_BASE_LANDED,
  VERDICT_BASE_LIVE,
  VERDICT_BASE_UNKNOWN,
  VERDICT_NOT_STACKED,
  classifyStackedBase,
  fetchBranchPullRequest,
  fetchPullRequest,
  formatVerdict,
} from '../scripts/check-stacked-base.mjs';

const DEFAULT_BRANCH = 'development';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe('a pull request based on a branch that has already landed', () => {
  // The measured incident, reproduced as a fixture rather than described in a
  // comment. #384 merged at 00:51:15Z; #386, stacked on its head branch,
  // merged at 00:51:22Z. Both reported success and #386's file was absent
  // from development afterwards.
  it('refuses the exact shape that lost #386', () => {
    const result = classifyStackedBase({
      baseRef: 'jpapiez-vasquez-merge-queue-credential',
      defaultBranch: DEFAULT_BRANCH,
      basePullRequest: {
        number: 384,
        state: 'merged',
        mergedAt: '2026-08-05T00:51:15Z',
      },
    });

    expect(result.verdict).toBe(VERDICT_BASE_LANDED);
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('#384');
    expect(result.reason).toContain('already merged');
  });

  it('refuses a base whose pull request was closed without merging', () => {
    // Closed-unmerged is as spent as merged: nothing will carry the base
    // forward either way. Treating only `merged` as hazardous would let the
    // more obviously broken case through.
    const result = classifyStackedBase({
      baseRef: 'someone-elses-branch',
      defaultBranch: DEFAULT_BRANCH,
      basePullRequest: { number: 99, state: 'closed', mergedAt: null },
    });

    expect(result.verdict).toBe(VERDICT_BASE_LANDED);
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('closed without merging');
  });

  // NEGATIVE CONTROL. Without this, "refuses a landed base" is satisfied by an
  // implementation that refuses every stacked pull request, which would make
  // the check unusable and would be indistinguishable from working.
  it('permits a stack whose base is still open', () => {
    const result = classifyStackedBase({
      baseRef: 'jpapiez-vasquez-merge-queue-credential',
      defaultBranch: DEFAULT_BRANCH,
      basePullRequest: { number: 384, state: 'open', mergedAt: null },
    });

    expect(result.verdict).toBe(VERDICT_BASE_LIVE);
    expect(result.exitCode).toBe(0);
  });

  // SECOND NEGATIVE CONTROL, one level up: the ordinary pull request. If this
  // regressed, every pull request in the repository would fail the check, so
  // it is the arm that decides whether the check is deployable at all.
  it('permits a pull request based on the default branch', () => {
    const result = classifyStackedBase({
      baseRef: DEFAULT_BRANCH,
      defaultBranch: DEFAULT_BRANCH,
      basePullRequest: null,
    });

    expect(result.verdict).toBe(VERDICT_NOT_STACKED);
    expect(result.exitCode).toBe(0);
  });
});

describe('a base that cannot be read is not a base that is fine', () => {
  it('reports a non-default base with no pull request as indeterminate, not as safe', () => {
    const result = classifyStackedBase({
      baseRef: 'orphan-branch',
      defaultBranch: DEFAULT_BRANCH,
      basePullRequest: null,
    });

    expect(result.verdict).toBe(VERDICT_BASE_UNKNOWN);
    expect(result.exitCode).toBe(2);
  });

  it('reports an unrecognised base state as indeterminate rather than guessing', () => {
    const result = classifyStackedBase({
      baseRef: 'orphan-branch',
      defaultBranch: DEFAULT_BRANCH,
      basePullRequest: { number: 7, state: 'draft-ish', mergedAt: null },
    });

    expect(result.verdict).toBe(VERDICT_BASE_UNKNOWN);
    expect(result.exitCode).toBe(2);
  });

  // The distinction is the point of the third state. If indeterminate shared
  // an exit code with either neighbour it would be a relabelling rather than a
  // state: 0 would restore the fail-open that let #386 merge, and 1 would make
  // an unreadable API look identical to a real finding.
  it('gives indeterminate an exit code shared with neither neighbour', () => {
    const codes = new Set(
      [
        classifyStackedBase({
          baseRef: DEFAULT_BRANCH,
          defaultBranch: DEFAULT_BRANCH,
        }),
        classifyStackedBase({
          baseRef: 'b',
          defaultBranch: DEFAULT_BRANCH,
          basePullRequest: { number: 1, state: 'merged', mergedAt: 'x' },
        }),
        classifyStackedBase({
          baseRef: 'b',
          defaultBranch: DEFAULT_BRANCH,
          basePullRequest: null,
        }),
      ].map((result) => result.exitCode),
    );

    expect([...codes].sort()).toEqual([0, 1, 2]);
  });

  it('refuses to classify without the two facts it decides from', () => {
    expect(() =>
      classifyStackedBase({ defaultBranch: DEFAULT_BRANCH }),
    ).toThrow(/baseRef is required/);
    expect(() => classifyStackedBase({ baseRef: 'b' })).toThrow(
      /defaultBranch is required/,
    );
  });
});

describe('the readings the verdict is computed from', () => {
  it('treats a merged pull request as merged even though the API calls it closed', () => {
    // GitHub reports merged pull requests with state "closed" and a non-null
    // merged_at. Reading state alone would collapse the two, which happens to
    // land on the same verdict here but for the wrong reason, and the printed
    // explanation would name the wrong event.
    const fetchImpl = (() =>
      jsonResponse([
        { number: 384, state: 'closed', merged_at: '2026-08-05T00:51:15Z' },
      ])) as unknown as typeof fetch;

    return fetchBranchPullRequest({
      owner: 'o',
      repo: 'r',
      branch: 'b',
      token: 't',
      fetchImpl,
    }).then((base) => {
      expect(base).toEqual({
        number: 384,
        state: 'merged',
        mergedAt: '2026-08-05T00:51:15Z',
      });
    });
  });

  it('returns null when a branch genuinely has no pull request', async () => {
    const fetchImpl = (() => jsonResponse([])) as unknown as typeof fetch;

    await expect(
      fetchBranchPullRequest({
        owner: 'o',
        repo: 'r',
        branch: 'b',
        token: 't',
        fetchImpl,
      }),
    ).resolves.toBeNull();
  });

  it('throws rather than reporting "no pull request" when the listing is unreadable', async () => {
    // An unreadable listing and an empty listing are the same value shape away
    // from each other, and one of them is the all-clear. This is the boundary
    // where a silent guard is produced.
    const fetchImpl = (() =>
      jsonResponse({ message: 'Bad credentials' })) as unknown as typeof fetch;

    await expect(
      fetchBranchPullRequest({
        owner: 'o',
        repo: 'r',
        branch: 'b',
        token: 't',
        fetchImpl,
      }),
    ).rejects.toThrow(/refusing to treat an unreadable response/);
  });

  it('throws when the pull request payload carries no base', async () => {
    const fetchImpl = (() =>
      jsonResponse({ base: {} })) as unknown as typeof fetch;

    await expect(
      fetchPullRequest({
        owner: 'o',
        repo: 'r',
        prNumber: 386,
        token: 't',
        fetchImpl,
      }),
    ).rejects.toThrow(/refusing to guess/);
  });

  it('reads the base branch and the default branch from one request', async () => {
    const fetchImpl = (() =>
      jsonResponse({
        base: {
          ref: 'jpapiez-vasquez-merge-queue-credential',
          repo: { default_branch: DEFAULT_BRANCH },
        },
      })) as unknown as typeof fetch;

    await expect(
      fetchPullRequest({
        owner: 'o',
        repo: 'r',
        prNumber: 386,
        token: 't',
        fetchImpl,
      }),
    ).resolves.toEqual({
      baseRef: 'jpapiez-vasquez-merge-queue-credential',
      defaultBranch: DEFAULT_BRANCH,
    });
  });

  it('surfaces an HTTP failure instead of continuing without the reading', async () => {
    const fetchImpl = (() =>
      jsonResponse({}, false, 403)) as unknown as typeof fetch;

    await expect(
      fetchPullRequest({
        owner: 'o',
        repo: 'r',
        prNumber: 386,
        token: 't',
        fetchImpl,
      }),
    ).rejects.toThrow(/GitHub returned 403/);
  });
});

describe('what the check tells the person reading the log', () => {
  it('names the remedy on a refusal', () => {
    const rendered = formatVerdict(
      classifyStackedBase({
        baseRef: 'base',
        defaultBranch: DEFAULT_BRANCH,
        basePullRequest: { number: 384, state: 'merged', mergedAt: 'then' },
      }),
      { prNumber: 386, baseRef: 'base' },
    );

    expect(rendered).toContain('REFUSED');
    expect(rendered).toContain('#386');
    expect(rendered).toContain('Retarget this pull request');
  });

  it('does not tell an ordinary pull request to retarget itself', () => {
    const rendered = formatVerdict(
      classifyStackedBase({
        baseRef: DEFAULT_BRANCH,
        defaultBranch: DEFAULT_BRANCH,
      }),
      { prNumber: 400, baseRef: DEFAULT_BRANCH },
    );

    expect(rendered).toContain('ok');
    expect(rendered).not.toContain('Retarget');
  });

  it('labels an indeterminate result as neither ok nor refused', () => {
    const rendered = formatVerdict(
      classifyStackedBase({
        baseRef: 'orphan',
        defaultBranch: DEFAULT_BRANCH,
        basePullRequest: null,
      }),
      { prNumber: 401, baseRef: 'orphan' },
    );

    expect(rendered).toContain('INDETERMINATE');
    expect(rendered).not.toContain('REFUSED');
  });
});
