import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findMalformedCopilotSessionTrailers,
  formatMalformedTrailers,
  main,
  parseCopilotSessionTrailerValues,
  parsePullRequestCommits,
} from '../scripts/check-copilot-session-trailers.mjs';

const SHA = 'a'.repeat(40);
const VALID_V4 = 'a361e68b-8ced-488c-8d6c-9f43d2b3207a';
const VALID_V7 = '01890f4e-7cc2-7d00-93e0-3d70a36a33d5';

describe('Copilot-Session trailer parsing', () => {
  it('delegates trailer-position recognition to git', () => {
    expect(
      parseCopilotSessionTrailerValues(
        `subject

Copilot-Session: ${VALID_V4}`,
      ),
    ).toEqual([VALID_V4]);

    expect(
      parseCopilotSessionTrailerValues(
        `subject

Copilot-Session: ${VALID_V4}

This paragraph means the line above is not in the final trailer block.`,
      ),
    ).toEqual([]);
  });

  it('accepts canonical UUID values, including multiple parsed trailers', () => {
    expect(
      findMalformedCopilotSessionTrailers([
        {
          sha: SHA,
          message: `subject

Copilot-Session: ${VALID_V4}
Copilot-Session: ${VALID_V7}`,
        },
      ]),
    ).toEqual([]);
  });

  it.each([
    ['the measured truncated specimen', 'a361e68b-...'],
    [
      'prose appended to a valid UUID',
      `${VALID_V4} while discussing a session`,
    ],
    ['a missing value', ''],
    ['a UUID with no version bits', 'a361e68b-8ced-088c-8d6c-9f43d2b3207a'],
    ['a UUID with no variant bits', 'a361e68b-8ced-488c-7d6c-9f43d2b3207a'],
  ])('rejects %s', (_name, value) => {
    expect(
      findMalformedCopilotSessionTrailers([
        {
          sha: SHA,
          message: `subject

Copilot-Session: ${value}`,
        },
      ]),
    ).toEqual([{ sha: SHA, value }]);
  });
});

describe('pull request commit boundary', () => {
  it('reads every page and keeps the full SHA beside the message', () => {
    expect(
      parsePullRequestCommits(
        JSON.stringify([
          [{ sha: SHA, commit: { message: 'one' } }],
          [{ sha: 'b'.repeat(40), commit: { message: 'two' } }],
        ]),
      ),
    ).toEqual([
      { sha: SHA, message: 'one' },
      { sha: 'b'.repeat(40), message: 'two' },
    ]);
  });

  it.each([
    ['invalid JSON', '{'],
    ['a non-paginated response', '{}'],
    ['a missing SHA', JSON.stringify([[{ commit: { message: 'one' } }]])],
    ['a missing message', JSON.stringify([[{ sha: SHA, commit: {} }]])],
  ])('fails closed on %s', (_name, response) => {
    expect(() => parsePullRequestCommits(response)).toThrow();
  });
});

describe('main', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('fails and identifies the commit carrying the truncated specimen', () => {
    const error = vi.fn();
    const result = main(['419'], {
      invokeGh: () =>
        JSON.stringify([
          [
            {
              sha: SHA,
              commit: {
                message: `subject

Copilot-Session: a361e68b-...`,
              },
            },
          ],
        ]),
      error,
      log: vi.fn(),
    });

    expect(result).toMatchObject({ ok: false, commits: 1 });
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('a361e68b-...'));
    expect(formatMalformedTrailers(result.malformed)).toContain(
      SHA.slice(0, 12),
    );
  });

  it('passes a commit with a valid cloud Copilot-session UUID', () => {
    const log = vi.fn();
    const result = main(['419'], {
      invokeGh: () =>
        JSON.stringify([
          [
            {
              sha: SHA,
              commit: {
                message: `subject

Copilot-Session: ${VALID_V4}`,
              },
            },
          ],
        ]),
      error: vi.fn(),
      log,
    });

    expect(result).toEqual({ ok: true, commits: 1, malformed: [] });
    expect(process.exitCode).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('malformed=0'));
  });
});
