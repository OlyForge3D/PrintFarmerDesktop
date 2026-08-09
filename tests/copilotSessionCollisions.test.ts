import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_SESSION_HOURS,
  findFormednessFindings,
  findSessionLifetimeViolations,
  formatReport,
  main,
  parseSessionTrailerValues,
  readNonMergeCommits,
} from '../scripts/check-copilot-session-collisions.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const VALID_V4 = 'a361e68b-8ced-488c-8d6c-9f43d2b3207a';
const VALID_V7 = '01890f4e-7cc2-7d00-93e0-3d70a36a33d5';

function commit(sha: string, isoDate: string, message: string) {
  return { sha, authorDate: new Date(isoDate), message };
}

describe('parseSessionTrailerValues', () => {
  it('delegates trailer-position recognition to git, same as check-copilot-session-trailers.mjs', () => {
    expect(
      parseSessionTrailerValues(`subject\n\nCopilot-Session: ${VALID_V4}`),
    ).toEqual([VALID_V4]);
  });

  it('reports only the last paragraph as the trailer block -- the squash-flattening property', () => {
    // Mirrors what a GitHub squash commit's concatenated body looks like when
    // `squash_merge_commit_message: COMMIT_MESSAGES` is configured (measured
    // via `gh api repos/{owner}/{repo}` on this repository): every squashed
    // commit's full message, one after another. Only the FINAL trailer block
    // survives `git interpret-trailers`, which is why this check does not
    // need a separate "was this squash-flattened" test -- interpret-trailers
    // already performs that flattening for every commit uniformly.
    const squashed = `commit one\n\nCopilot-Session: ${VALID_V4}\n\ncommit two\n\nSome body prose.\n\nCopilot-Session: ${VALID_V7}`;
    expect(parseSessionTrailerValues(squashed)).toEqual([VALID_V7]);
  });
});

describe('findFormednessFindings', () => {
  it('flags a commit with zero trailers as missing, not malformed', () => {
    const commits = [commit(SHA_A, '2026-01-01T00:00:00Z', 'no trailer here')];
    expect(findFormednessFindings(commits)).toEqual({
      missing: [{ sha: SHA_A }],
      malformed: [],
    });
  });

  it('flags a truncated or prose-appended value as malformed, not missing', () => {
    const commits = [
      commit(
        SHA_A,
        '2026-01-01T00:00:00Z',
        `subject\n\nCopilot-Session: a361e68b-...`,
      ),
    ];
    expect(findFormednessFindings(commits)).toEqual({
      missing: [],
      malformed: [{ sha: SHA_A, value: 'a361e68b-...' }],
    });
  });

  it('reports nothing for a well-formed commit', () => {
    const commits = [
      commit(
        SHA_A,
        '2026-01-01T00:00:00Z',
        `subject\n\nCopilot-Session: ${VALID_V4}`,
      ),
    ];
    expect(findFormednessFindings(commits)).toEqual({
      missing: [],
      malformed: [],
    });
  });
});

describe('findSessionLifetimeViolations', () => {
  it('does not flag a value confined to a short, plausible session window', () => {
    const commits = [
      commit(SHA_A, '2026-01-01T00:00:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
      commit(SHA_B, '2026-01-01T02:00:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
    ];
    expect(findSessionLifetimeViolations(commits, 24)).toEqual([]);
  });

  it('flags a value spanning past the bound -- the measured 74-commit/39h33m shape', () => {
    const commits = [
      commit(SHA_A, '2026-07-21T21:06:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
      commit(SHA_B, '2026-07-22T10:00:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
      commit(SHA_C, '2026-07-23T10:54:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
    ];
    const violations = findSessionLifetimeViolations(commits, 24);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      value: VALID_V4,
      count: 3,
      firstSha: SHA_A,
      lastSha: SHA_C,
    });
    expect(violations[0]?.spanHours).toBeCloseTo(37.8, 1);
  });

  it('ignores malformed values -- that is findFormednessFindings\u2019s finding, not this one\u2019s', () => {
    const commits = [
      commit(SHA_A, '2026-01-01T00:00:00Z', 's\n\nCopilot-Session: not-a-uuid'),
      commit(SHA_B, '2026-02-01T00:00:00Z', 's\n\nCopilot-Session: not-a-uuid'),
    ];
    expect(findSessionLifetimeViolations(commits, 24)).toEqual([]);
  });

  it('groups distinct values independently', () => {
    const commits = [
      commit(SHA_A, '2026-01-01T00:00:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
      commit(SHA_B, '2026-01-01T01:00:00Z', `s\n\nCopilot-Session: ${VALID_V7}`),
      commit(SHA_C, '2026-01-01T02:00:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
    ];
    expect(findSessionLifetimeViolations(commits, 24)).toEqual([]);
  });

  it('rejects a non-positive bound', () => {
    expect(() => findSessionLifetimeViolations([], 0)).toThrow(/positive/);
    expect(() => findSessionLifetimeViolations([], Number.NaN)).toThrow(
      /positive/,
    );
  });
});

describe('formatReport', () => {
  it('includes every finding category when all three are present', () => {
    const report = formatReport({
      missing: [{ sha: SHA_A }],
      malformed: [{ sha: SHA_B, value: 'bad' }],
      violations: [
        {
          value: VALID_V4,
          count: 74,
          spanHours: 39.55,
          firstSha: SHA_A,
          lastSha: SHA_C,
        },
      ],
      maxSessionHours: DEFAULT_MAX_SESSION_HOURS,
    });

    expect(report).toContain(SHA_A.slice(0, 12));
    expect(report).toContain('bad');
    expect(report).toContain(VALID_V4);
    expect(report).toContain('74 commit(s)');
  });
});

describe('main', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('fails when a commit has no trailer', () => {
    const error = vi.fn();
    const result = main([], {
      readCommits: () => [commit(SHA_A, '2026-01-01T00:00:00Z', 'no trailer')],
      error,
      log: vi.fn(),
    });

    expect(result.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(SHA_A.slice(0, 12)));
  });

  it('fails when a value collides across a span past the bound', () => {
    const error = vi.fn();
    const result = main(['--max-hours', '24'], {
      readCommits: () => [
        commit(SHA_A, '2026-07-21T21:06:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
        commit(SHA_B, '2026-07-23T10:54:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
      ],
      error,
      log: vi.fn(),
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it('passes when every commit is well-formed and no value collides', () => {
    const log = vi.fn();
    const result = main([], {
      readCommits: () => [
        commit(SHA_A, '2026-01-01T00:00:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
        commit(SHA_B, '2026-01-01T02:00:00Z', `s\n\nCopilot-Session: ${VALID_V4}`),
      ],
      log,
      error: vi.fn(),
    });

    expect(result).toEqual({
      ok: true,
      commits: 2,
      missing: [],
      malformed: [],
      violations: [],
    });
    expect(process.exitCode).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('commits=2'));
  });

  it('rejects an unknown CLI argument', () => {
    expect(() =>
      main(['--bogus'], { readCommits: () => [], log: vi.fn(), error: vi.fn() }),
    ).toThrow(/unknown argument/);
  });
});

describe('readNonMergeCommits', () => {
  it('parses git log output at the field/record boundary used for the format string', () => {
    const git = vi.fn(
      () =>
        `${SHA_A}\x1f2026-01-01T00:00:00+00:00\x1fsubject one\n\nCopilot-Session: ${VALID_V4}\x1e\n${SHA_B}\x1f2026-01-02T00:00:00+00:00\x1fsubject two\x1e\n`,
    );

    const commits = readNonMergeCommits('origin/development', git);

    expect(commits).toEqual([
      {
        sha: SHA_A,
        authorDate: new Date('2026-01-01T00:00:00+00:00'),
        message: `subject one\n\nCopilot-Session: ${VALID_V4}`,
      },
      {
        sha: SHA_B,
        authorDate: new Date('2026-01-02T00:00:00+00:00'),
        message: 'subject two',
      },
    ]);
    expect(git).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['log', '--no-merges', 'origin/development']),
    );
  });

  it('forwards --since when provided', () => {
    const git = vi.fn(() => '');
    readNonMergeCommits('origin/development', git, '30 days ago');

    expect(git).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['--since=30 days ago']),
    );
  });

  it('throws on an unparseable author date rather than silently dropping the commit', () => {
    const git = vi.fn(() => `${SHA_A}\x1fnot-a-date\x1fsubject\x1e\n`);
    expect(() => readNonMergeCommits('origin/development', git)).toThrow(
      /unparseable author date/,
    );
  });
});
