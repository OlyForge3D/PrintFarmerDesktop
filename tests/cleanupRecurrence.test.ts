// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  EXIT_CLEAN,
  EXIT_RECURRENCE,
  EXIT_UNDETERMINED,
  HISTORY_COMMENT_LIMIT,
  RECURRENCE_THRESHOLD,
  classifyRecurrence,
  fetchCleanupHistory,
  formatRecurrenceReport,
  main,
  parseArgs,
  parseCleanupComment,
} from '../scripts/check-cleanup-recurrence.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHA_A = 'a3edb245687cc85f1cacdaf9b09e72e38fd67d70';
const SHA_B = 'c6c1737deadbeefdeadbeefdeadbeefdeadbeef1';
const SHA_C = 'ef9209e000000000000000000000000000000001';
const SHA_D = 'd216f9daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';

function makeCleanupCommentBody({
  runId = '30898288869',
  attempt = '1',
  job = 'desktop',
  sha = SHA_A,
}: {
  runId?: string;
  attempt?: string;
  job?: string;
  sha?: string;
} = {}): string {
  return [
    `<!-- npm-cleanup-failure run=${runId} attempt=${attempt} job=${job} -->`,
    '### npm cleanup failure recorded',
    '',
    `- **Run attempt:** [${runId}/${attempt}](https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/${runId}/attempts/${attempt})`,
    `- **Head:** \`${sha}\``,
    `- **Job:** \`${job}\``,
    `- **Runner:** \`Windows / RUNNER-01\``,
    `- **Directories npm named:** \`parse-color\``,
    '- **Automatic recovery:** `retry failed: EPERM still locked`',
    '',
    'Exact failure anchor:',
    '',
    '```text',
    'npm-ci-strict: `npm ci` exited 0 but reported it could not finish removing node_modules.',
    '```',
  ].join('\n');
}

function comment(body: string): { body: string } {
  return { body };
}

function response(
  payload: unknown,
  {
    ok = true,
    status = 200,
    statusText = 'OK',
  }: { ok?: boolean; status?: number; statusText?: string } = {},
): Response {
  return {
    ok,
    status,
    statusText,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  } as unknown as Response;
}

/**
 * Wraps a synchronous URL→Response function as a proper `typeof fetch`.
 * Avoids the `async` + `no-await` lint error and the `as unknown as typeof fetch`
 * cast in every test.
 */
function asFetch(fn: (url: string) => Response): typeof fetch {
  return (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return Promise.resolve(fn(url));
  };
}

// ---------------------------------------------------------------------------
// parseCleanupComment
// ---------------------------------------------------------------------------

describe('parseCleanupComment', () => {
  it('returns null for a non-cleanup comment', () => {
    expect(
      parseCleanupComment('Just a normal comment, no marker here.'),
    ).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseCleanupComment('')).toBeNull();
  });

  it('parses a well-formed cleanup comment body', () => {
    const body = makeCleanupCommentBody({
      runId: '12345',
      attempt: '1',
      sha: SHA_A,
      job: 'desktop',
    });
    const entry = parseCleanupComment(body);
    expect(entry).toEqual({
      runId: '12345',
      runAttempt: '1',
      job: 'desktop',
      headSha: SHA_A,
    });
  });

  it('lowercases the head SHA', () => {
    const body = makeCleanupCommentBody({ sha: SHA_A.toUpperCase() });
    const entry = parseCleanupComment(body);
    expect(entry?.headSha).toBe(SHA_A.toLowerCase());
  });

  it('throws for a comment with the marker but no head SHA line', () => {
    const body = `<!-- npm-cleanup-failure run=999 attempt=1 job=desktop -->\n### npm cleanup failure recorded\n\n(no head line)`;
    expect(() => parseCleanupComment(body)).toThrow(
      /cleanup comment for run 999 attempt 1 has the cleanup-failure marker but no parseable 40-char head SHA/,
    );
  });

  it('throws if body is not a string', () => {
    // @ts-expect-error intentional wrong type for coverage
    expect(() => parseCleanupComment(42)).toThrow(
      /comment body must be a string/,
    );
  });

  it('parses attempt=2 rerun marker correctly', () => {
    const body = makeCleanupCommentBody({ attempt: '2', sha: SHA_B });
    const entry = parseCleanupComment(body);
    expect(entry?.runAttempt).toBe('2');
    expect(entry?.headSha).toBe(SHA_B);
  });
});

// ---------------------------------------------------------------------------
// classifyRecurrence
// ---------------------------------------------------------------------------

describe('classifyRecurrence', () => {
  // Acceptance criterion: repeated cleanup signature across different SHAs.
  it('reports recurring when two distinct SHAs carry the cleanup signature on attempt=1', () => {
    const comments = [
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '1' })),
      comment(makeCleanupCommentBody({ runId: '2', sha: SHA_B, attempt: '1' })),
    ];
    const result = classifyRecurrence(comments);
    expect(result.recurring).toBe(true);
    expect(result.distinctShas).toHaveLength(2);
    expect(result.distinctShas).toContain(SHA_A);
    expect(result.distinctShas).toContain(SHA_B);
  });

  // Acceptance criterion: one isolated occurrence is NOT recurrence.
  it('does not report recurring for a single distinct SHA', () => {
    const comments = [
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '1' })),
    ];
    const result = classifyRecurrence(comments);
    expect(result.recurring).toBe(false);
    expect(result.distinctShas).toHaveLength(1);
  });

  it('reports recurring for four distinct SHAs matching the #450 measurement', () => {
    const comments = [
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '1' })),
      comment(makeCleanupCommentBody({ runId: '2', sha: SHA_B, attempt: '1' })),
      comment(makeCleanupCommentBody({ runId: '3', sha: SHA_C, attempt: '1' })),
      comment(makeCleanupCommentBody({ runId: '4', sha: SHA_D, attempt: '1' })),
    ];
    const result = classifyRecurrence(comments);
    expect(result.recurring).toBe(true);
    expect(result.distinctShas).toHaveLength(4);
  });

  // Acceptance criterion: later green runs do not erase earlier reds.
  // Since the tracking issue records failures permanently and green runs
  // do NOT post comments, any comments that ARE present are historical
  // true positives regardless of what ran afterwards.
  it('counts all evidence comments regardless of subsequent run outcomes (permanence)', () => {
    // Simulate: SHA_A failed (comment posted), SHA_B succeeded (no comment),
    // SHA_C failed (comment posted). The green SHA_B does not erase SHA_A.
    const comments = [
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '1' })),
      // SHA_B has a green run — no comment is posted, so it is simply absent
      comment(makeCleanupCommentBody({ runId: '3', sha: SHA_C, attempt: '1' })),
    ];
    const result = classifyRecurrence(comments);
    expect(result.recurring).toBe(true);
    expect(result.distinctShas).toContain(SHA_A);
    expect(result.distinctShas).toContain(SHA_C);
    expect(result.distinctShas).not.toContain(SHA_B);
  });

  // Acceptance criterion: reruns of one run must not double-count or
  // conflate with separate first-attempt runs on later commits.
  it('does not count attempt=2 reruns of a SHA toward the distinct-SHA total', () => {
    // One SHA with two comments: original attempt=1 and a rerun attempt=2.
    // This is a rerun of the SAME run — should count as only one SHA.
    const comments = [
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '1' })),
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '2' })),
    ];
    const result = classifyRecurrence(comments);
    expect(result.recurring).toBe(false);
    expect(result.distinctShas).toHaveLength(1);
    expect(result.firstAttemptEntries).toHaveLength(1);
  });

  it('does not count any rerun-only SHA toward recurrence', () => {
    // SHA_A only has attempt=2 (no first attempt ever recorded).
    // SHA_B has attempt=1. This should NOT meet threshold.
    const comments = [
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '2' })),
      comment(makeCleanupCommentBody({ runId: '2', sha: SHA_B, attempt: '1' })),
    ];
    const result = classifyRecurrence(comments);
    expect(result.recurring).toBe(false);
    expect(result.distinctShas).toHaveLength(1); // Only SHA_B qualifies
    expect(result.distinctShas).toContain(SHA_B);
    expect(result.distinctShas).not.toContain(SHA_A);
  });

  it('does not count multiple reruns of different SHAs as cross-commit recurrence', () => {
    // Both SHAs only appear on attempt>=2 (pure reruns, no first attempts).
    const comments = [
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '2' })),
      comment(makeCleanupCommentBody({ runId: '2', sha: SHA_B, attempt: '2' })),
    ];
    const result = classifyRecurrence(comments);
    expect(result.recurring).toBe(false);
    expect(result.distinctShas).toHaveLength(0);
  });

  // Acceptance criterion: unrelated failures excluded.
  it('ignores comments that do not carry the cleanup-failure marker', () => {
    const comments = [
      comment('A plain issue comment with no marker.'),
      comment('Another triage note from a human maintainer.'),
      comment('<!-- some-other-workflow run=99 --> unrelated'),
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '1' })),
    ];
    const result = classifyRecurrence(comments);
    expect(result.parsed).toHaveLength(1);
    expect(result.recurring).toBe(false);
  });

  // Acceptance criterion: empty responses handled.
  it('returns no-recurrence for an empty comment list', () => {
    const result = classifyRecurrence([]);
    expect(result.recurring).toBe(false);
    expect(result.parsed).toHaveLength(0);
    expect(result.distinctShas).toHaveLength(0);
  });

  it('deduplicates the same SHA across multiple first-attempt entries (multiple jobs)', () => {
    // Same SHA, two different jobs (e.g. windows and another windows runner).
    // Both are on attempt=1 — this is the same commit failing twice, not two commits.
    const comments = [
      comment(
        makeCleanupCommentBody({
          runId: '1',
          sha: SHA_A,
          attempt: '1',
          job: 'desktop-win',
        }),
      ),
      comment(
        makeCleanupCommentBody({
          runId: '2',
          sha: SHA_A,
          attempt: '1',
          job: 'release-win',
        }),
      ),
    ];
    const result = classifyRecurrence(comments);
    expect(result.distinctShas).toHaveLength(1);
    expect(result.recurring).toBe(false);
    // Both runs for the SHA are tracked
    expect(result.firstAttemptBySha.get(SHA_A)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// fetchCleanupHistory
// ---------------------------------------------------------------------------

describe('fetchCleanupHistory', () => {
  // Acceptance criterion: pagination handled within the bound.
  it('paginates across multiple pages and exhausts the issue before the limit', async () => {
    // limit=101 > 100 items on page 1, so we must request page 2 to know if the
    // issue is exhausted. Page 2 returns empty, confirming exhaustion: bounded=false.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: makeCleanupCommentBody({ runId: String(i + 1), sha: SHA_A }),
    }));
    const calls: string[] = [];
    let callCount = 0;
    const fetchImpl = asFetch((url) => {
      calls.push(url);
      callCount += 1;
      return callCount === 1 ? response(page1) : response([]);
    });
    const result = await fetchCleanupHistory({
      owner: 'OlyForge3D',
      repo: 'PrintFarmerDesktop',
      issueNumber: 274,
      limit: 101, // larger than the total, so we exhaust the issue
      token: 'tok',
      fetchImpl,
    });
    expect(result.comments).toHaveLength(100);
    expect(result.bounded).toBe(false); // Issue exhausted before limit
    expect(calls).toHaveLength(2); // two pages requested
  });

  it('sets bounded=true when limit reached before page exhausted', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: 'plain comment',
    }));
    const fetchImpl = asFetch(() => response(page1));
    const result = await fetchCleanupHistory({
      owner: 'OlyForge3D',
      repo: 'PrintFarmerDesktop',
      issueNumber: 274,
      limit: 100,
      token: 'tok',
      fetchImpl,
    });
    expect(result.bounded).toBe(true);
    expect(result.comments).toHaveLength(100);
  });

  // Acceptance criterion: empty responses.
  it('returns empty array for a tracking issue with no comments', async () => {
    const fetchImpl = asFetch(() => response([]));
    const result = await fetchCleanupHistory({
      owner: 'OlyForge3D',
      repo: 'PrintFarmerDesktop',
      issueNumber: 274,
      limit: 100,
      token: 'tok',
      fetchImpl,
    });
    expect(result.comments).toHaveLength(0);
    expect(result.bounded).toBe(false);
  });

  // Acceptance criterion: partial responses (non-array body).
  it('throws for a non-array response body (partial/malformed)', async () => {
    const fetchImpl = asFetch(() =>
      response({ message: 'Not Found', total_count: 0 }),
    );
    await expect(
      fetchCleanupHistory({
        owner: 'OlyForge3D',
        repo: 'PrintFarmerDesktop',
        issueNumber: 274,
        limit: 100,
        token: 'tok',
        fetchImpl,
      }),
    ).rejects.toThrow(/non-array response/);
  });

  // Acceptance criterion: rate-limited responses fail closed (undetermined).
  it('throws for a rate-limited 429 response', async () => {
    const fetchImpl = asFetch(() =>
      response(null, {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      }),
    );
    await expect(
      fetchCleanupHistory({
        owner: 'OlyForge3D',
        repo: 'PrintFarmerDesktop',
        issueNumber: 274,
        limit: 100,
        token: 'tok',
        fetchImpl,
      }),
    ).rejects.toThrow(/rate-limited or forbidden/);
  });

  it('throws for a 403 forbidden response', async () => {
    const fetchImpl = asFetch(() =>
      response(null, { ok: false, status: 403, statusText: 'Forbidden' }),
    );
    await expect(
      fetchCleanupHistory({
        owner: 'OlyForge3D',
        repo: 'PrintFarmerDesktop',
        issueNumber: 274,
        limit: 100,
        token: 'tok',
        fetchImpl,
      }),
    ).rejects.toThrow(/rate-limited or forbidden/);
  });

  it('throws for a generic 500 error response', async () => {
    const fetchImpl = asFetch(() =>
      response(null, {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );
    await expect(
      fetchCleanupHistory({
        owner: 'OlyForge3D',
        repo: 'PrintFarmerDesktop',
        issueNumber: 274,
        limit: 100,
        token: 'tok',
        fetchImpl,
      }),
    ).rejects.toThrow(/GitHub API request failed/);
  });

  it('throws for a comment with no string body', async () => {
    const fetchImpl = asFetch(() => response([{ id: 1, body: null }]));
    await expect(
      fetchCleanupHistory({
        owner: 'OlyForge3D',
        repo: 'PrintFarmerDesktop',
        issueNumber: 274,
        limit: 100,
        token: 'tok',
        fetchImpl,
      }),
    ).rejects.toThrow(/no string body/);
  });
});

// ---------------------------------------------------------------------------
// formatRecurrenceReport
// ---------------------------------------------------------------------------

describe('formatRecurrenceReport', () => {
  const scope = {
    commentsExamined: 10,
    bounded: false,
    issueNumber: 274,
    owner: 'OlyForge3D',
    repo: 'PrintFarmerDesktop',
  };

  it('includes the advisory disclaimer', () => {
    const classification = classifyRecurrence([]);
    const report = formatRecurrenceReport({ classification, scope });
    expect(report).toContain('ADVISORY:');
    expect(report).toContain('not part of branch protection');
  });

  it('names recurrence confirmed when threshold met', () => {
    const comments = [
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '1' })),
      comment(makeCleanupCommentBody({ runId: '2', sha: SHA_B, attempt: '1' })),
    ];
    const classification = classifyRecurrence(comments);
    const report = formatRecurrenceReport({
      classification,
      scope: { ...scope, commentsExamined: 2 },
    });
    expect(report).toContain('RECURRENCE CONFIRMED');
    expect(report).toContain(SHA_A);
    expect(report).toContain(SHA_B);
  });

  it('names isolated when below threshold', () => {
    const comments = [
      comment(makeCleanupCommentBody({ runId: '1', sha: SHA_A, attempt: '1' })),
    ];
    const classification = classifyRecurrence(comments);
    const report = formatRecurrenceReport({
      classification,
      scope: { ...scope, commentsExamined: 1 },
    });
    expect(report).toContain('isolated');
    expect(report).not.toContain('RECURRENCE CONFIRMED');
  });

  it('states absence of evidence when no cleanup comments found', () => {
    const classification = classifyRecurrence([]);
    const report = formatRecurrenceReport({ classification, scope });
    expect(report).toContain('No cleanup-evidence comments found');
    expect(report).toContain('absence of evidence');
  });

  it('notes the bounded scan warning when limit was reached', () => {
    const classification = classifyRecurrence([]);
    const report = formatRecurrenceReport({
      classification,
      scope: { ...scope, bounded: true },
    });
    expect(report).toContain('bounded at');
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --repo', () => {
    expect(parseArgs(['--repo', 'owner/name'])).toMatchObject({
      repo: 'owner/name',
    });
  });

  it('parses --issue', () => {
    expect(parseArgs(['--issue', '999'])).toMatchObject({ issueNumber: 999 });
  });

  it('parses --limit', () => {
    expect(parseArgs(['--limit', '50'])).toMatchObject({ limit: 50 });
  });

  it('sets help for --help', () => {
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
  });

  it('sets error for unknown argument', () => {
    expect(parseArgs(['--unknown'])).toHaveProperty('error');
  });

  it('sets error for --repo missing value', () => {
    expect(parseArgs(['--repo'])).toHaveProperty('error');
  });

  it('sets error for --issue non-integer', () => {
    expect(parseArgs(['--issue', 'notanumber'])).toHaveProperty('error');
  });

  it(`sets error for --limit exceeding HISTORY_COMMENT_LIMIT`, () => {
    expect(
      parseArgs(['--limit', String(HISTORY_COMMENT_LIMIT + 1)]),
    ).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// main (live-control inputs)
// ---------------------------------------------------------------------------

describe('main', () => {
  const makeEnv = (token = 'test-token'): NodeJS.ProcessEnv => ({
    GITHUB_TOKEN: token,
    GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop',
  });

  // Acceptance criterion: live-control inputs.
  it('exits UNDETERMINED when GITHUB_TOKEN is missing', async () => {
    const exit = await main(
      [],
      {}, // no token
    );
    expect(exit).toBe(EXIT_UNDETERMINED);
  });

  it('exits CLEAN when no cleanup evidence comments exist', async () => {
    const exit = await main(
      [],
      makeEnv(),
      asFetch(() => response([])),
    );
    expect(exit).toBe(EXIT_CLEAN);
  });

  it('exits RECURRENCE when two distinct SHAs have first-attempt cleanup entries', async () => {
    const fetchImpl = asFetch(() =>
      response([
        {
          id: 1,
          body: makeCleanupCommentBody({
            runId: '1',
            sha: SHA_A,
            attempt: '1',
          }),
        },
        {
          id: 2,
          body: makeCleanupCommentBody({
            runId: '2',
            sha: SHA_B,
            attempt: '1',
          }),
        },
      ]),
    );
    const exit = await main([], makeEnv(), fetchImpl);
    expect(exit).toBe(EXIT_RECURRENCE);
  });

  it('exits UNDETERMINED when the API returns a non-200 response', async () => {
    const fetchImpl = asFetch(() =>
      response(null, {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );
    const exit = await main([], makeEnv(), fetchImpl);
    expect(exit).toBe(EXIT_UNDETERMINED);
  });

  it('exits UNDETERMINED when the API returns a rate-limit error', async () => {
    const fetchImpl = asFetch(() =>
      response(null, {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      }),
    );
    const exit = await main([], makeEnv(), fetchImpl);
    expect(exit).toBe(EXIT_UNDETERMINED);
  });

  it('exits UNDETERMINED for a malformed (non-array) response', async () => {
    const fetchImpl = asFetch(() => response({ error: 'bad' }));
    const exit = await main([], makeEnv(), fetchImpl);
    expect(exit).toBe(EXIT_UNDETERMINED);
  });

  it('exits UNDETERMINED for unrecognised CLI argument', async () => {
    const exit = await main(['--bad-arg'], makeEnv());
    expect(exit).toBe(EXIT_UNDETERMINED);
  });

  it('exits CLEAN for --help without making network calls', async () => {
    let calls = 0;
    const fetchImpl = asFetch(() => {
      calls += 1;
      return response([]);
    });
    const exit = await main(['--help'], makeEnv(), fetchImpl);
    expect(exit).toBe(EXIT_CLEAN);
    expect(calls).toBe(0);
  });

  // Acceptance criterion: pagination handled within the bound.
  it('requests page 2 when page 1 is full and there are more results', async () => {
    const calls: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: 'plain comment', // not cleanup evidence
    }));
    let callCount = 0;
    const fetchImpl = asFetch((url) => {
      calls.push(url);
      callCount += 1;
      return callCount === 1 ? response(page1) : response([]);
    });
    await main(['--limit', '101'], makeEnv(), fetchImpl);
    expect(calls.some((u) => u.includes('page=2'))).toBe(true);
  });

  // Acceptance criterion: rerun attempts not double-counted.
  it('exits CLEAN when all cleanup entries are reruns (attempt≠1) of a single SHA', async () => {
    const fetchImpl = asFetch(() =>
      response([
        {
          id: 1,
          body: makeCleanupCommentBody({
            runId: '1',
            sha: SHA_A,
            attempt: '1',
          }),
        },
        {
          id: 2,
          body: makeCleanupCommentBody({
            runId: '1',
            sha: SHA_A,
            attempt: '2',
          }),
        },
      ]),
    );
    const exit = await main([], makeEnv(), fetchImpl);
    expect(exit).toBe(EXIT_CLEAN);
  });

  // Acceptance criterion: unrelated failures excluded.
  it('ignores non-cleanup comments and stays clean', async () => {
    const fetchImpl = asFetch(() =>
      response([
        {
          id: 1,
          body: 'This run failed due to bedClearConflictClassification TS2554',
        },
        { id: 2, body: 'Release-package failure, unrelated to npm ci cleanup' },
        { id: 3, body: '<!-- other-tool run=42 --> some unrelated annotation' },
      ]),
    );
    const exit = await main([], makeEnv(), fetchImpl);
    expect(exit).toBe(EXIT_CLEAN);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('RECURRENCE_THRESHOLD is exactly 2', () => {
    expect(RECURRENCE_THRESHOLD).toBe(2);
  });

  it('HISTORY_COMMENT_LIMIT is a positive integer', () => {
    expect(Number.isInteger(HISTORY_COMMENT_LIMIT)).toBe(true);
    expect(HISTORY_COMMENT_LIMIT).toBeGreaterThan(0);
  });

  it('exit codes are the expected integers', () => {
    expect(EXIT_CLEAN).toBe(0);
    expect(EXIT_RECURRENCE).toBe(1);
    expect(EXIT_UNDETERMINED).toBe(2);
  });
});
