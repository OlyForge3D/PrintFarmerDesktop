import { describe, expect, it } from 'vitest';

import {
  ARMS,
  EXIT_CHANGED,
  EXIT_REPRODUCES,
  EXIT_UNDETERMINED,
  FABRICATED_SHA,
  SHA_PATTERN,
  apiPath,
  countExpression,
  formatReport,
  judgeArm,
  main,
  overallVerdict,
  parseArgs,
  presentSha,
  readArm,
  readCount,
  resolveRepo,
  resolveSubject,
} from '../scripts/probe-sha-query.mjs';
import {
  VERDICT_BLIND,
  VERDICT_SOUND,
  VERDICT_UNUSABLE,
} from '../scripts/instrument-probe.mjs';

/**
 * This file is about one inversion. Everywhere else in this repository a BLIND
 * instrument is a defect; here arm 2 is EXPECTED to be blind, because that is
 * the finding being re-run. So the assertions below are about whether the
 * recorded behaviour still holds, and the load-bearing ones are the arms that
 * must NOT be reported as a reproduction: a failed control, and a missing
 * reading. Both are exit 2, and both have to be reachable from a plain object,
 * or the control is decoration.
 */

const REAL = 'a'.repeat(40);

function stub(
  map: Record<string, { status: number; stdout?: string; stderr?: string }>,
) {
  return ((command: string, argv: readonly string[]) => {
    const key = `${command} ${argv.join(' ')}`;
    const hit = Object.entries(map).find(([pattern]) => key.includes(pattern));
    return hit
      ? { ...hit[1], stdout: hit[1].stdout ?? '', stderr: hit[1].stderr ?? '' }
      : { status: 1, stdout: '', stderr: '' };
  }) as never;
}

describe('the shape of the two urls is the finding', () => {
  it('puts the sha in a query parameter for the filter endpoint', () => {
    expect(apiPath({ endpoint: 'filter' }, 'o/r', 'abc')).toContain(
      'head_sha=abc',
    );
  });

  it('puts the sha in a path segment for the dereference endpoint', () => {
    expect(apiPath({ endpoint: 'deref' }, 'o/r', 'abc')).toContain(
      '/commits/abc/check-runs',
    );
  });

  it('READS THE SAME FIELD FROM BOTH, which is why they are confusable', () => {
    // Both report total_count. If the two answers had different shapes nobody
    // would ever have substituted one for the other.
    expect(countExpression()).toBe('.total_count');
  });
});

describe('presentSha', () => {
  it('truncates to seven, the length that reads well and matches nothing', () => {
    expect(presentSha(REAL, true)).toHaveLength(7);
  });

  it('leaves a full sha alone', () => {
    expect(presentSha(REAL, false)).toBe(REAL);
  });
});

describe('the fabricated sha', () => {
  it('is well formed, because a malformed one is a different input class', () => {
    // A malformed SHA draws a 422 from BOTH endpoints, which is what made an
    // earlier reading record the filter endpoint as self-reporting. The pair
    // the endpoints actually disagree about is well-formed-but-unmatched.
    expect(SHA_PATTERN.test(FABRICATED_SHA)).toBe(true);
  });
});

describe('readCount', () => {
  const env = {};

  it('returns the count on success', () => {
    expect(
      readCount(stub({ 'gh api': { status: 0, stdout: '5\n' } }), 'p', env),
    ).toBe('5');
  });

  it('A NON-ZERO EXIT IS A READING: the 422 is the remedy, not an error', () => {
    // Discarding this as a failure would erase the difference the whole file
    // measures — it is precisely how the dereference endpoint says "I cannot
    // resolve this".
    expect(
      readCount(
        stub({
          'gh api': {
            status: 1,
            stderr: 'gh: No commit found for SHA (HTTP 422)',
          },
        }),
        'p',
        env,
      ),
    ).toBe('error:422');
  });

  it('falls back to the exit code when no HTTP status is quoted', () => {
    expect(
      readCount(stub({ 'gh api': { status: 4, stderr: 'boom' } }), 'p', env),
    ).toBe('error:4');
  });

  it('returns null when the command could not run at all', () => {
    expect(
      readCount((() => ({ error: new Error('ENOENT') })) as never, 'p', env),
    ).toBeNull();
  });

  it('returns null for empty output rather than calling it an answer', () => {
    // "" is not 0. Conflating them is #214's instance 4 in a new place.
    expect(
      readCount(stub({ 'gh api': { status: 0, stdout: '  \n' } }), 'p', env),
    ).toBeNull();
  });
});

describe('readArm', () => {
  it('asks about the real commit and the fabricated one, in that order', () => {
    const seen: string[] = [];
    const run = ((_c: string, argv: readonly string[]) => {
      seen.push(argv[1] as string);
      return { status: 0, stdout: '1', stderr: '' };
    }) as never;

    readArm(
      { endpoint: 'filter', truncate: true },
      {
        repo: 'o/r',
        realSha: REAL,
        run,
        env: {},
      },
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain(REAL.slice(0, 7));
    expect(seen[1]).toContain(FABRICATED_SHA.slice(0, 7));
  });
});

describe('judgeArm', () => {
  const arm = { id: 'x', expect: VERDICT_BLIND, control: false, describe: 'd' };

  it('matches when both readings are identical and blindness was expected', () => {
    const judged = judgeArm(arm, [
      { label: 'a', reading: '0' },
      { label: 'b', reading: '0' },
    ]);
    expect(judged.observed).toBe(VERDICT_BLIND);
    expect(judged.matches).toBe(true);
  });

  it('does NOT match when the endpoint started discriminating', () => {
    // This is the case that means the guidance is stale, and it is the only
    // reason this file is worth running more than once.
    const judged = judgeArm(arm, [
      { label: 'a', reading: '5' },
      { label: 'b', reading: '0' },
    ]);
    expect(judged.observed).toBe(VERDICT_SOUND);
    expect(judged.matches).toBe(false);
  });

  it('reports UNUSABLE when a reading is missing', () => {
    const judged = judgeArm(arm, [
      { label: 'a', reading: null },
      { label: 'b', reading: '0' },
    ]);
    expect(judged.observed).toBe(VERDICT_UNUSABLE);
  });
});

describe('overallVerdict — the ordering is the control', () => {
  const ok = (id: string, control = false) => ({
    id,
    control,
    expected: VERDICT_SOUND,
    observed: VERDICT_SOUND,
    matches: true,
  });

  it('reports a reproduction when every arm behaves as recorded', () => {
    expect(overallVerdict([ok('c', true), ok('a'), ok('b')]).exitCode).toBe(
      EXIT_REPRODUCES,
    );
  });

  it('A FAILED CONTROL OUTRANKS A FULL SET OF MATCHING ARMS', () => {
    // The arm that matters. Three identical failures — an expired token, a
    // rate limit, an offline machine — look like one BLIND arm and two
    // unusable ones, and any rule that read the non-control arms first would
    // publish "the finding reproduces" from an experiment that never reached
    // the API. That is the defect #379 is about, committed by its own probe.
    const verdict = overallVerdict([
      {
        id: 'c',
        control: true,
        expected: VERDICT_SOUND,
        observed: VERDICT_BLIND,
        matches: false,
      },
      ok('a'),
      ok('b'),
    ]);
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
    expect(verdict.summary).toContain('control arm c');
  });

  it('refuses to conclude when there is no control arm at all', () => {
    expect(overallVerdict([ok('a'), ok('b')]).exitCode).toBe(EXIT_UNDETERMINED);
  });

  it('refuses to conclude when no arms ran', () => {
    expect(overallVerdict([]).exitCode).toBe(EXIT_UNDETERMINED);
  });

  it('treats an unmeasured arm as undetermined, not as a change', () => {
    const verdict = overallVerdict([
      ok('c', true),
      {
        id: 'a',
        control: false,
        expected: VERDICT_BLIND,
        observed: VERDICT_UNUSABLE,
        matches: false,
      },
    ]);
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
  });

  it('reports CHANGED only once the control passed and the arm was measured', () => {
    const verdict = overallVerdict([
      ok('c', true),
      {
        id: 'a',
        control: false,
        expected: VERDICT_BLIND,
        observed: VERDICT_SOUND,
        matches: false,
      },
    ]);
    expect(verdict.exitCode).toBe(EXIT_CHANGED);
    expect(verdict.summary).toContain('must be re-derived');
  });

  it('DISCRIMINATES: a passing control does not turn a changed arm into a pass', () => {
    // The inverse of the arm above. Both orderings have to be pinned or the
    // precedence rule is satisfied by a function that always returns 2.
    expect(
      overallVerdict([
        ok('c', true),
        {
          id: 'a',
          control: false,
          expected: VERDICT_BLIND,
          observed: VERDICT_SOUND,
          matches: false,
        },
      ]).exitCode,
    ).not.toBe(EXIT_UNDETERMINED);
  });
});

describe('resolveSubject refuses rather than expands', () => {
  it('REFUSES A PREFIX, because expanding one is the defect being measured', () => {
    const out = resolveSubject('3a634fa', stub({}));
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toContain(
      'will not expand a prefix',
    );
  });

  it('accepts a full sha and lowercases it', () => {
    const out = resolveSubject('A'.repeat(40), stub({}));
    expect(out.ok === true && out.sha).toBe('a'.repeat(40));
  });

  it('falls back to HEAD when none was requested', () => {
    const out = resolveSubject(
      undefined,
      stub({ 'git rev-parse HEAD': { status: 0, stdout: `${REAL}\n` } }),
    );
    expect(out.ok === true && out.sha).toBe(REAL);
  });

  it('fails rather than guessing when HEAD does not resolve', () => {
    expect(
      resolveSubject(undefined, stub({ 'git rev-parse': { status: 1 } })).ok,
    ).toBe(false);
  });
});

describe('resolveRepo', () => {
  it('prefers the explicit flag', () => {
    expect(resolveRepo('a/b', { GITHUB_REPOSITORY: 'c/d' }, stub({}))).toBe(
      'a/b',
    );
  });

  it('then the environment', () => {
    expect(resolveRepo(undefined, { GITHUB_REPOSITORY: 'c/d' }, stub({}))).toBe(
      'c/d',
    );
  });

  it('then gh, and rejects output that is not a slug', () => {
    expect(
      resolveRepo(
        undefined,
        {},
        stub({ 'repo view': { status: 0, stdout: 'not a slug\n' } }),
      ),
    ).toBeNull();
  });

  it('returns null when gh fails', () => {
    expect(
      resolveRepo(undefined, {}, stub({ 'repo view': { status: 1 } })),
    ).toBeNull();
  });
});

describe('parseArgs', () => {
  it('reads both flags', () => {
    expect(parseArgs(['--repo', 'a/b', '--sha', REAL])).toEqual({
      repo: 'a/b',
      sha: REAL,
    });
  });

  it('reads help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('formatReport', () => {
  it('names the control arm so a reader cannot miss which one invalidates the rest', () => {
    const text = formatReport(
      [
        {
          id: 'filter-full',
          control: true,
          describe: 'd',
          expected: VERDICT_SOUND,
          observed: VERDICT_SOUND,
          matches: true,
          readings: [{ label: 'real', reading: '5' }],
        },
      ],
      { exitCode: EXIT_REPRODUCES, summary: 's' },
    );
    expect(text).toContain('[CONTROL]');
    expect(text).toContain('expected SOUND, observed SOUND');
  });

  it('marks a changed arm distinctly from one that held', () => {
    const text = formatReport(
      [
        {
          id: 'x',
          control: false,
          describe: 'd',
          expected: VERDICT_BLIND,
          observed: VERDICT_SOUND,
          matches: false,
          readings: [{ label: 'real', reading: null }],
        },
      ],
      { exitCode: EXIT_CHANGED, summary: 's' },
    );
    expect(text).toContain('CHANGED');
    expect(text).toContain('(no reading)');
  });
});

describe('the arm table', () => {
  it('has exactly one control, since two would make precedence ambiguous', () => {
    expect(ARMS.filter((a) => a.control)).toHaveLength(1);
  });

  it('probes the filter endpoint both ways round, which is what isolates truncation', () => {
    // Without the full-SHA arm, a blind prefix arm is equally explained by
    // "the endpoint is broken" and by "truncation breaks it".
    const filter = ARMS.filter((a) => a.endpoint === 'filter');
    expect(filter.map((a) => a.truncate).sort()).toEqual([false, true]);
  });

  it('expects the prefix arm to be BLIND — the inversion this file is built on', () => {
    expect(ARMS.find((a) => a.id === 'filter-short')?.expect).toBe(
      VERDICT_BLIND,
    );
  });

  it('expects the dereference remedy to stay sound on a prefix', () => {
    expect(ARMS.find((a) => a.id === 'deref-short')?.expect).toBe(
      VERDICT_SOUND,
    );
  });
});

describe('main', () => {
  const lines: string[] = [];
  const write = (t: string) => {
    lines.push(t);
  };

  it('prints usage and succeeds for --help', () => {
    expect(main(['--help'], {}, stub({}), write)).toBe(EXIT_REPRODUCES);
  });

  it('is undetermined when the repository cannot be resolved', () => {
    expect(main([], {}, stub({ 'repo view': { status: 1 } }), write)).toBe(
      EXIT_UNDETERMINED,
    );
  });

  it('is undetermined when a prefix was passed', () => {
    expect(
      main(['--repo', 'o/r', '--sha', '3a634fa'], {}, stub({}), write),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('AN EXCEPTION IS NOT EVIDENCE ABOUT #379 IN EITHER DIRECTION', () => {
    expect(
      main(
        ['--repo', 'o/r', '--sha', REAL],
        {},
        () => {
          throw new Error('boom');
        },
        write,
      ),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('POSITIVE CONTROL for the arm above: the same call path returns a verdict when nothing throws', () => {
    // Without this, the exception test passes for a main() that returns 2
    // unconditionally, which is a control that cannot fail.
    const result = main(
      ['--repo', 'o/r', '--sha', REAL],
      {},
      stub({ 'gh api': { status: 0, stdout: '0\n' } }),
      write,
    );
    expect(result).not.toBe(EXIT_REPRODUCES);
    expect(lines.at(-1)).toContain('#379 re-run');
  });
});
