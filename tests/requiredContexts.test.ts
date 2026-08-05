import { describe, expect, it } from 'vitest';

import {
  EXIT_READY,
  EXIT_NOT_GREEN,
  EXIT_UNDETERMINED,
  EXIT_ABSENT,
  latestRunNamed,
  evaluateRequiredContexts,
  formatResult,
  parseArgs,
  runGh,
  resolveRepositorySlug,
  main,
} from '../scripts/check-required-contexts.mjs';
import type { RollupRun } from '../scripts/check-required-contexts.mjs';

const SEVEN = [
  'Desktop (windows-latest)',
  'Desktop (macos-latest)',
  'Sidecar (windows-latest)',
  'Sidecar (macos-latest)',
  'Release package (windows-latest)',
  'Release package (macos-latest)',
  'Dependency advisories',
];

function ok(name: string, conclusion: string = 'SUCCESS') {
  return { name, status: 'COMPLETED', conclusion, completedAt: '2026-01-01' };
}

function allSeven(): RollupRun[] {
  return SEVEN.map((n) => ok(n));
}

describe('evaluateRequiredContexts', () => {
  it('is ready when all seven are present and successful', () => {
    const r = evaluateRequiredContexts(SEVEN, allSeven());
    expect(r.exitCode).toBe(EXIT_READY);
    expect(r.green).toHaveLength(7);
    expect(r.absent).toEqual([]);
  });

  it('THE POINT: a count of greens cannot see an absent required context', () => {
    // Nine runs, every one of them green, and one required context missing.
    const runs = allSeven()
      .filter((r) => r.name !== 'Dependency advisories')
      .concat([ok('Lint'), ok('Format'), ok('Provenance')]);
    expect(runs.every((r) => r.conclusion === 'SUCCESS')).toBe(true);
    expect(runs).toHaveLength(9);

    const r = evaluateRequiredContexts(SEVEN, runs);
    expect(r.exitCode).toBe(EXIT_ABSENT);
    expect(r.absent).toEqual(['Dependency advisories']);
    expect(r.notGreen).toEqual([]);
  });

  it('reports a red required context as EXIT_NOT_GREEN, distinctly from absent', () => {
    const runs = allSeven();
    runs[0] = ok('Desktop (windows-latest)', 'FAILURE');
    const r = evaluateRequiredContexts(SEVEN, runs);
    expect(r.exitCode).toBe(EXIT_NOT_GREEN);
    expect(r.notGreen).toEqual([
      { name: 'Desktop (windows-latest)', state: 'FAILURE' },
    ]);
    expect(r.absent).toEqual([]);
  });

  it('lets ABSENT outrank RED when both are present', () => {
    const runs = allSeven()
      .filter((r) => r.name !== 'Dependency advisories')
      .map((r) =>
        r.name === 'Sidecar (macos-latest)'
          ? ok('Sidecar (macos-latest)', 'FAILURE')
          : r,
      );
    const r = evaluateRequiredContexts(SEVEN, runs);
    expect(r.exitCode).toBe(EXIT_ABSENT);
    expect(r.absent).toEqual(['Dependency advisories']);
    expect(r.notGreen).toHaveLength(1);
  });

  it('treats an unfinished run as pending, not as green and not as red', () => {
    const runs = allSeven();
    runs[2] = {
      name: 'Sidecar (windows-latest)',
      status: 'IN_PROGRESS',
      conclusion: '',
      completedAt: null,
      startedAt: '2026-01-01',
    };
    const r = evaluateRequiredContexts(SEVEN, runs);
    expect(r.pending).toEqual(['Sidecar (windows-latest)']);
    expect(r.green).toHaveLength(6);
    expect(r.notGreen).toEqual([]);
    expect(r.exitCode).toBe(EXIT_NOT_GREEN);
  });

  it('does not count non-required runs toward readiness', () => {
    const r = evaluateRequiredContexts(SEVEN, [
      ...allSeven(),
      ok('Lint'),
      ok('Format'),
    ]);
    expect(r.green).toHaveLength(7);
    expect(r.extra).toBe(2);
  });

  it('is ABSENT when there are no runs at all rather than vacuously ready', () => {
    const r = evaluateRequiredContexts(SEVEN, []);
    expect(r.exitCode).toBe(EXIT_ABSENT);
    expect(r.absent).toHaveLength(7);
  });

  it('tolerates undefined runs', () => {
    const r = evaluateRequiredContexts(SEVEN, undefined);
    expect(r.exitCode).toBe(EXIT_ABSENT);
  });

  it('treats a SKIPPED required context as not green', () => {
    const runs = allSeven();
    runs[1] = ok('Desktop (macos-latest)', 'SKIPPED');
    const r = evaluateRequiredContexts(SEVEN, runs);
    expect(r.exitCode).toBe(EXIT_NOT_GREEN);
  });

  it('treats a NEUTRAL required context as not green', () => {
    const runs = allSeven();
    runs[1] = ok('Desktop (macos-latest)', 'NEUTRAL');
    const r = evaluateRequiredContexts(SEVEN, runs);
    expect(r.exitCode).toBe(EXIT_NOT_GREEN);
  });
});

describe('latestRunNamed', () => {
  it('returns null when the name never appears', () => {
    expect(latestRunNamed([ok('a')], 'b')).toBeNull();
  });

  it('prefers the most recently completed re-run', () => {
    const r = latestRunNamed(
      [
        {
          name: 'x',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          completedAt: '2026-01-01',
        },
        {
          name: 'x',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          completedAt: '2026-01-02',
        },
      ],
      'x',
    );
    expect(r?.conclusion).toBe('SUCCESS');
  });

  it('does not let a stale green cover a fresh red', () => {
    const r = latestRunNamed(
      [
        {
          name: 'x',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          completedAt: '2026-01-01',
        },
        {
          name: 'x',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          completedAt: '2026-01-05',
        },
      ],
      'x',
    );
    expect(r?.conclusion).toBe('FAILURE');
  });

  it('decides by timestamp, NOT by array position — newest listed first', () => {
    // The rollup's order is not documented to be chronological. A "take the
    // last entry" implementation passes every chronologically-ordered
    // fixture, so at least one case must put the answer at the front.
    const r = latestRunNamed(
      [
        {
          name: 'x',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          completedAt: '2026-01-09',
        },
        {
          name: 'x',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          completedAt: '2026-01-01',
        },
      ],
      'x',
    );
    expect(r?.conclusion).toBe('FAILURE');
  });

  it('decides by timestamp with the green newest and listed first', () => {
    const r = latestRunNamed(
      [
        {
          name: 'x',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          completedAt: '2026-01-09',
        },
        {
          name: 'x',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          completedAt: '2026-01-01',
        },
      ],
      'x',
    );
    expect(r?.conclusion).toBe('SUCCESS');
  });

  it('falls back to startedAt for a run with no completion', () => {
    const r = latestRunNamed(
      [
        {
          name: 'x',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          completedAt: '2026-01-01',
        },
        {
          name: 'x',
          status: 'IN_PROGRESS',
          conclusion: '',
          completedAt: null,
          startedAt: '2026-01-09',
        },
      ],
      'x',
    );
    expect(r?.status).toBe('IN_PROGRESS');
  });

  it('ignores null entries', () => {
    expect(
      latestRunNamed([null as unknown as RollupRun, ok('x')], 'x')?.name,
    ).toBe('x');
  });
});

describe('formatResult', () => {
  it('names each absent context rather than only counting', () => {
    const r = evaluateRequiredContexts(SEVEN, [ok('Dependency advisories')]);
    const text = formatResult(1, r, SEVEN);
    expect(text).toContain('ABSENT  Desktop (windows-latest)');
    expect(text).toContain('cannot go red');
  });

  it('separates the non-required population explicitly', () => {
    const r = evaluateRequiredContexts(SEVEN, [...allSeven(), ok('Lint')]);
    expect(formatResult(2, r, SEVEN)).toContain(
      '1 non-required check run name(s)',
    );
  });
});

describe('parseArgs', () => {
  it('reads a pr number', () => {
    expect(parseArgs(['--pr', '446']).pr).toBe(446);
  });

  it('rejects a non-numeric pr', () => {
    expect(parseArgs(['--pr', 'abc']).error).toMatch(/needs a number/);
  });

  it('rejects a missing pr value', () => {
    expect(parseArgs(['--pr']).error).toMatch(/needs a number/);
  });

  it('rejects an unknown argument', () => {
    expect(parseArgs(['--wat']).error).toMatch(/unrecognised/);
  });

  it('reads help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('runGh', () => {
  it('falls through to the next candidate when one cannot spawn', () => {
    const tried = [];
    const r = runGh(
      (cmd: string) => {
        tried.push(cmd);
        if (tried.length === 1) return { error: new Error('EINVAL') };
        return { status: 0, stdout: 'ok', stderr: '' };
      },
      ['x'],
      {},
    );
    expect(r.spawned).toBe(true);
    expect(r.stdout).toBe('ok');
    expect(tried.length).toBeGreaterThan(1);
  });

  it('reports not-spawned when every candidate fails', () => {
    const r = runGh(() => ({ error: new Error('ENOENT') }), ['x'], {});
    expect(r.spawned).toBe(false);
  });

  it('does not treat a non-zero exit as a spawn failure', () => {
    const r = runGh(
      () => ({ status: 1, stdout: '', stderr: 'nope' }),
      ['x'],
      {},
    );
    expect(r.spawned).toBe(true);
    expect(r.status).toBe(1);
  });
});

describe('resolveRepositorySlug', () => {
  it('uses GITHUB_REPOSITORY when set', () => {
    expect(
      resolveRepositorySlug({ GITHUB_REPOSITORY: 'o/r' }, () => {
        throw new Error('should not be called');
      }),
    ).toBe('o/r');
  });

  it('does not throw when GITHUB_REPOSITORY is unset', () => {
    expect(() =>
      resolveRepositorySlug({}, () => ({
        status: 0,
        stdout: 'o/r\n',
        stderr: '',
      })),
    ).not.toThrow();
  });

  it('falls back to gh', () => {
    expect(
      resolveRepositorySlug({}, () => ({
        status: 0,
        stdout: 'o/r\n',
        stderr: '',
      })),
    ).toBe('o/r');
  });

  it('returns null rather than a malformed slug', () => {
    expect(
      resolveRepositorySlug({}, () => ({
        status: 0,
        stdout: 'nonsense',
        stderr: '',
      })),
    ).toBeNull();
  });

  it('returns null when gh fails', () => {
    expect(
      resolveRepositorySlug({}, () => ({ status: 1, stdout: '', stderr: 'x' })),
    ).toBeNull();
  });
});

describe('main', () => {
  it('refuses without a pr number, and calls it undetermined not ready', () => {
    expect(main([], {}, () => ({ status: 0 }))).toBe(EXIT_UNDETERMINED);
  });

  it('refuses without a credential', () => {
    expect(
      main(['--pr', '1'], { SKIP_CREDENTIAL_DISCOVERY: '1' }, () => ({
        status: 0,
        stdout: '',
        stderr: '',
      })),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('AN EXCEPTION IS NOT A FINDING: a throw becomes 2, never 1', () => {
    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        () => {
          throw new Error('boom');
        },
      ),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('returns 2 when gh output cannot be parsed', () => {
    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        () => ({
          status: 0,
          stdout: 'not json',
          stderr: '',
        }),
      ),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('returns 0 for a head carrying all seven', () => {
    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        () => ({
          status: 0,
          stdout: JSON.stringify({ statusCheckRollup: allSeven() }),
          stderr: '',
        }),
      ),
    ).toBe(EXIT_READY);
  });

  it('returns 3 for a head missing one, even with everything else green', () => {
    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        () => ({
          status: 0,
          stdout: JSON.stringify({
            statusCheckRollup: allSeven()
              .slice(1)
              .concat([ok('Lint')]),
          }),
          stderr: '',
        }),
      ),
    ).toBe(EXIT_ABSENT);
  });

  it('returns 1 for a head with a red required context', () => {
    const runs = allSeven();
    runs[3] = ok('Sidecar (macos-latest)', 'FAILURE');
    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        () => ({
          status: 0,
          stdout: JSON.stringify({ statusCheckRollup: runs }),
          stderr: '',
        }),
      ),
    ).toBe(EXIT_NOT_GREEN);
  });

  it('the four codes are distinct', () => {
    expect(
      new Set([EXIT_READY, EXIT_NOT_GREEN, EXIT_UNDETERMINED, EXIT_ABSENT])
        .size,
    ).toBe(4);
  });
});
