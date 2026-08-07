import { describe, expect, it } from 'vitest';

import {
  EXIT_SUCCESS,
  EXIT_UNUSABLE,
  FULL_SHA_PATTERN,
  main,
  queryActionsRunsForInput,
  resolveCommitSha,
} from '../scripts/actions-runs-for-sha.mjs';

const FULL_SHA = `a1b2c3d${'a'.repeat(33)}`;
const NONEXISTENT_SHA = '0123456789abcdef0123456789abcdef01234567';

function stub(
  handler: (
    command: string,
    argv: readonly string[],
  ) => {
    status: number;
    stdout?: string;
    stderr?: string;
  },
) {
  return ((command: string, argv: readonly string[]) => {
    const result = handler(command, argv);
    return {
      ...result,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }) as never;
}

describe('resolveCommitSha', () => {
  it('resolves a valid short prefix to a validated full SHA', () => {
    const result = resolveCommitSha(
      'a1b2c3d',
      'o/r',
      {},
      stub((_command, argv) => {
        expect(argv[1]).toBe('repos/o/r/commits/a1b2c3d');
        return { status: 0, stdout: `${FULL_SHA}\n` };
      }),
    );

    expect(result).toEqual({ ok: true, sha: FULL_SHA });
    expect(FULL_SHA_PATTERN.test(result.ok ? result.sha : '')).toBe(true);
  });

  it('reports a nonexistent 40-hex SHA as unusable', () => {
    const result = resolveCommitSha(
      NONEXISTENT_SHA,
      'o/r',
      {},
      stub(() => ({
        status: 1,
        stderr: 'gh: No commit found for SHA (HTTP 422)',
      })),
    );

    expect(result).toEqual({
      ok: false,
      reason: 'the commit did not resolve (HTTP 422)',
    });
  });

  it('rejects a malformed string without invoking gh', () => {
    let invoked = false;
    const result = resolveCommitSha(
      'notahex',
      'o/r',
      {},
      stub(() => {
        invoked = true;
        return { status: 0, stdout: FULL_SHA };
      }),
    );

    expect(result.ok).toBe(false);
    expect(invoked).toBe(false);
  });

  it('rejects a resolver response that is not a full SHA', () => {
    const result = resolveCommitSha(
      'a1b2c3d',
      'o/r',
      {},
      stub(() => ({ status: 0, stdout: 'a1b2c3d\n' })),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('invalid full SHA');
  });

  it('rejects a hexadecimal ref that resolves outside the requested prefix', () => {
    const result = resolveCommitSha(
      'a1b2c3d',
      'o/r',
      {},
      stub(() => ({ status: 0, stdout: `${'b'.repeat(40)}\n` })),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      'does not match requested SHA prefix',
    );
  });
});

describe('queryActionsRunsForInput', () => {
  it('preserves a true zero after full-SHA validation', () => {
    const calls: string[] = [];
    const result = queryActionsRunsForInput(
      'a1b2c3d',
      'o/r',
      {},
      stub((_command, argv) => {
        calls.push(argv[1] as string);
        return calls.length === 1
          ? { status: 0, stdout: `${FULL_SHA}\n` }
          : { status: 0, stdout: '0\n' };
      }),
    );

    expect(result).toEqual({ ok: true, sha: FULL_SHA, totalCount: 0 });
    expect(calls).toEqual([
      'repos/o/r/commits/a1b2c3d',
      `repos/o/r/actions/runs?head_sha=${FULL_SHA}&per_page=1`,
    ]);
  });

  it('does not coerce an empty response to zero', () => {
    let calls = 0;
    const result = queryActionsRunsForInput(
      'a1b2c3d',
      'o/r',
      {},
      stub(() => {
        calls += 1;
        return calls === 1
          ? { status: 0, stdout: FULL_SHA }
          : { status: 0, stdout: '' };
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.stage).toBe('query');
  });
});

describe('main', () => {
  it('queries Actions only after a short prefix resolves to a full SHA', () => {
    const calls: string[] = [];
    const output: string[] = [];
    const result = main(
      ['--repo', 'o/r', '--sha', 'a1b2c3d'],
      {},
      stub((_command, argv) => {
        calls.push(argv[1] as string);
        return calls.length === 1
          ? { status: 0, stdout: FULL_SHA }
          : { status: 0, stdout: '0' };
      }),
      (text) => output.push(text),
    );

    expect(result).toBe(EXIT_SUCCESS);
    expect(calls).toEqual([
      'repos/o/r/commits/a1b2c3d',
      `repos/o/r/actions/runs?head_sha=${FULL_SHA}&per_page=1`,
    ]);
    expect(output).toEqual([`resolved_sha=${FULL_SHA}\ntotal_count=0`]);
  });

  it.each([
    ['nonexistent full SHA', NONEXISTENT_SHA],
    ['malformed string', 'notahex'],
  ])('never queries Actions for a %s', (_label, input) => {
    const calls: string[] = [];
    const result = main(
      ['--repo', 'o/r', '--sha', input],
      {},
      stub((_command, argv) => {
        calls.push(argv[1] as string);
        return {
          status: 1,
          stderr: 'gh: No commit found for SHA (HTTP 422)',
        };
      }),
      () => undefined,
    );

    expect(result).toBe(EXIT_UNUSABLE);
    expect(calls.some((call) => call.includes('/actions/runs?'))).toBe(false);
    expect(calls).toHaveLength(input === 'notahex' ? 0 : 1);
  });
});
