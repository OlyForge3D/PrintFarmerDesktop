import { describe, expect, it, vi } from 'vitest';

import {
  DIRECT_PUSH_TRACKING_ISSUE,
  findBareCommits,
  formatBareCommitEvidence,
  alreadyRecorded,
  countAssociatedPullRequests,
  fetchTrackingIssueComments,
  postTrackingIssueComment,
  readCommitRange,
} from '../scripts/check-direct-push-artifact.mjs';

const commit = (sha: string, subject = 'a commit') => ({
  sha,
  author: 'jpapiez',
  authoredDate: '2026-08-04T21:36:39-07:00',
  subject,
});

describe('findBareCommits', () => {
  it('keeps only commits with zero associated pull requests', () => {
    const commits = [
      commit('177dd2d'.padEnd(40, '0')),
      commit('8031631'.padEnd(40, '0')),
    ];
    const counts = new Map([
      [commits[0]!.sha, 0],
      [commits[1]!.sha, 0],
    ]);
    expect(findBareCommits(commits, counts)).toEqual(commits);
  });

  it('drops a commit that has at least one associated pull request', () => {
    const withPr = commit('a'.repeat(40));
    const bare = commit('b'.repeat(40));
    const counts = new Map([
      [withPr.sha, 1],
      [bare.sha, 0],
    ]);
    expect(findBareCommits([withPr, bare], counts)).toEqual([bare]);
  });

  it('refuses to guess about a commit nobody looked up', () => {
    const uncounted = commit('c'.repeat(40));
    expect(() => findBareCommits([uncounted], new Map())).toThrow(
      /refusing to guess/,
    );
  });

  it('rejects a non-array commit list and a non-Map count table', () => {
    expect(() => findBareCommits(null as never, new Map())).toThrow(TypeError);
    expect(() => findBareCommits([], {} as never)).toThrow(TypeError);
  });
});

describe('formatBareCommitEvidence', () => {
  it('names the sha, author, date and subject, and cites #388 remedy 3', () => {
    const sha = '177dd2d'.padEnd(40, '9');
    const body = formatBareCommitEvidence(
      commit(sha, 'docs(squad): enforce adversarial PR lifecycle'),
    );
    expect(body).toContain(sha);
    expect(body).toContain('jpapiez');
    expect(body).toContain('2026-08-04T21:36:39-07:00');
    expect(body).toContain('docs(squad): enforce adversarial PR lifecycle');
    expect(body).toContain('#388 remedy 3');
    expect(body).toContain('Pull requests found:** 0');
  });

  it('refuses a commit with no full sha', () => {
    expect(() => formatBareCommitEvidence({ sha: 'short' } as never)).toThrow(
      TypeError,
    );
  });

  it('bounds an oversized subject rather than embedding it whole', () => {
    const sha = 'd'.repeat(40);
    const huge = 'x'.repeat(10_000);
    const body = formatBareCommitEvidence(commit(sha, huge));
    expect(body.length).toBeLessThan(huge.length + 2_000);
  });
});

describe('alreadyRecorded', () => {
  it('finds a prior comment naming the sha', () => {
    const sha = 'e'.repeat(40);
    expect(alreadyRecorded([{ body: `saw ${sha} already` }], sha)).toBe(true);
  });

  it('is false when no comment mentions the sha', () => {
    const sha = 'f'.repeat(40);
    expect(alreadyRecorded([{ body: 'unrelated' }], sha)).toBe(false);
  });

  it('tolerates an empty or malformed comment list', () => {
    const sha = '1'.repeat(40);
    expect(alreadyRecorded([], sha)).toBe(false);
    expect(alreadyRecorded(undefined as never, sha)).toBe(false);
    expect(alreadyRecorded([{}], sha)).toBe(false);
  });
});

describe('DIRECT_PUSH_TRACKING_ISSUE', () => {
  it('is pinned to #388, the issue remedy 3 belongs to', () => {
    expect(DIRECT_PUSH_TRACKING_ISSUE).toBe(388);
  });
});

// Same shape as tests/prClosureScope.test.ts's `respondJson`: a stub whose
// declared type is `typeof fetch`, so no call site needs `as unknown` to use it.
const respondJson =
  (payload: unknown, ok = true, status = 200): typeof fetch =>
  () =>
    Promise.resolve({
      ok,
      status,
      statusText: 'Test',
      json: () => Promise.resolve(payload),
    } as unknown as Response);

describe('countAssociatedPullRequests', () => {
  it('reads the length of the commits/{sha}/pulls array', async () => {
    const count = await countAssociatedPullRequests({
      owner: 'OlyForge3D',
      repo: 'PrintFarmerDesktop',
      sha: 'a'.repeat(40),
      token: 'tok',
      fetchImpl: respondJson([{ number: 461 }]),
    });
    expect(count).toBe(1);
  });

  it('is zero for a bare commit', async () => {
    const count = await countAssociatedPullRequests({
      owner: 'o',
      repo: 'r',
      sha: 'b'.repeat(40),
      token: 'tok',
      fetchImpl: respondJson([]),
    });
    expect(count).toBe(0);
  });

  it('throws rather than silently reading zero on a non-array response', async () => {
    await expect(
      countAssociatedPullRequests({
        owner: 'o',
        repo: 'r',
        sha: 'c'.repeat(40),
        token: 'tok',
        fetchImpl: respondJson({ not: 'an array' }),
      }),
    ).rejects.toThrow(/unexpected response shape/);
  });

  it('throws on a non-ok response rather than returning a count', async () => {
    await expect(
      countAssociatedPullRequests({
        owner: 'o',
        repo: 'r',
        sha: 'd'.repeat(40),
        token: 'tok',
        fetchImpl: respondJson({}, false, 404),
      }),
    ).rejects.toThrow(/404/);
  });
});

describe('fetchTrackingIssueComments and postTrackingIssueComment', () => {
  it('reads existing comments from the tracking issue', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      respondJson([{ body: 'earlier evidence' }]),
    );
    const comments = await fetchTrackingIssueComments({
      owner: 'o',
      repo: 'r',
      issueNumber: DIRECT_PUSH_TRACKING_ISSUE,
      token: 'tok',
      fetchImpl,
    });
    expect(comments).toEqual([{ body: 'earlier evidence' }]);
    const [, options] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(
      String((options.headers as Record<string, string>).authorization),
    ).toContain('tok');
  });

  it('posts a comment and returns its URL', async () => {
    const url = await postTrackingIssueComment({
      owner: 'o',
      repo: 'r',
      issueNumber: DIRECT_PUSH_TRACKING_ISSUE,
      body: 'evidence',
      token: 'tok',
      fetchImpl: respondJson(
        { html_url: 'https://example.invalid/comment/1' },
        true,
        201,
      ),
    });
    expect(url).toBe('https://example.invalid/comment/1');
  });

  it('throws if GitHub accepts the post but returns no url', async () => {
    await expect(
      postTrackingIssueComment({
        owner: 'o',
        repo: 'r',
        issueNumber: DIRECT_PUSH_TRACKING_ISSUE,
        body: 'evidence',
        token: 'tok',
        fetchImpl: respondJson({}, true, 201),
      }),
    ).rejects.toThrow(/no URL/);
  });
});

describe('readCommitRange', () => {
  it('parses the delimited git log output, oldest first', () => {
    const RS = '\x1e';
    const FS = '\x1f';
    const stdout = [
      `aaa${FS}Jeff${FS}2026-08-04T21:36:39-07:00${FS}second`,
      `bbb${FS}Jeff${FS}2026-08-04T21:36:00-07:00${FS}first`,
    ]
      .map((r) => r + RS)
      .join('');
    const exec = vi.fn(() => stdout);
    const commits = readCommitRange('base', 'development', exec);
    expect(commits).toEqual([
      {
        sha: 'bbb',
        author: 'Jeff',
        authoredDate: '2026-08-04T21:36:00-07:00',
        subject: 'first',
      },
      {
        sha: 'aaa',
        author: 'Jeff',
        authoredDate: '2026-08-04T21:36:39-07:00',
        subject: 'second',
      },
    ]);
    expect(exec).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['log', 'base..development']),
      expect.any(Object),
    );
  });

  it('returns an empty array for an empty range', () => {
    const exec = vi.fn(() => '');
    expect(
      readCommitRange('development', 'development', exec as never),
    ).toEqual([]);
  });
});
