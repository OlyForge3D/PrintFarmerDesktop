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
  ghCandidates,
} from '../scripts/check-required-contexts.mjs';
import type { RollupRun } from '../scripts/check-required-contexts.mjs';

const EIGHT = [
  'Closing-reference declaration',
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

function allEight(): RollupRun[] {
  return EIGHT.map((n) => ok(n));
}

describe('evaluateRequiredContexts', () => {
  it('is ready when all eight are present and successful', () => {
    const r = evaluateRequiredContexts(EIGHT, allEight());
    expect(r.exitCode).toBe(EXIT_READY);
    expect(r.green).toHaveLength(8);
    expect(r.absent).toEqual([]);
  });

  it('THE POINT: a count of greens cannot see an absent required context', () => {
    // Ten runs, every one of them green, and one required context missing.
    const runs = allEight()
      .filter((r) => r.name !== 'Dependency advisories')
      .concat([ok('Lint'), ok('Format'), ok('Provenance')]);
    expect(runs.every((r) => r.conclusion === 'SUCCESS')).toBe(true);
    expect(runs).toHaveLength(10);

    const r = evaluateRequiredContexts(EIGHT, runs);
    expect(r.exitCode).toBe(EXIT_ABSENT);
    expect(r.absent).toEqual(['Dependency advisories']);
    expect(r.notGreen).toEqual([]);
  });

  it('reports a red required context as EXIT_NOT_GREEN, distinctly from absent', () => {
    const runs = allEight();
    runs[runs.findIndex((r) => r.name === 'Desktop (windows-latest)')] = ok(
      'Desktop (windows-latest)',
      'FAILURE',
    );
    const r = evaluateRequiredContexts(EIGHT, runs);
    expect(r.exitCode).toBe(EXIT_NOT_GREEN);
    expect(r.notGreen).toEqual([
      { name: 'Desktop (windows-latest)', state: 'FAILURE' },
    ]);
    expect(r.absent).toEqual([]);
  });

  it('lets ABSENT outrank RED when both are present', () => {
    const runs = allEight()
      .filter((r) => r.name !== 'Dependency advisories')
      .map((r) =>
        r.name === 'Sidecar (macos-latest)'
          ? ok('Sidecar (macos-latest)', 'FAILURE')
          : r,
      );
    const r = evaluateRequiredContexts(EIGHT, runs);
    expect(r.exitCode).toBe(EXIT_ABSENT);
    expect(r.absent).toEqual(['Dependency advisories']);
    expect(r.notGreen).toHaveLength(1);
  });

  it('treats an unfinished run as pending, not as green and not as red', () => {
    const runs = allEight();
    runs[runs.findIndex((r) => r.name === 'Sidecar (windows-latest)')] = {
      name: 'Sidecar (windows-latest)',
      status: 'IN_PROGRESS',
      conclusion: '',
      completedAt: null,
      startedAt: '2026-01-01',
    };
    const r = evaluateRequiredContexts(EIGHT, runs);
    expect(r.pending).toEqual(['Sidecar (windows-latest)']);
    expect(r.green).toHaveLength(7);
    expect(r.notGreen).toEqual([]);
    expect(r.exitCode).toBe(EXIT_NOT_GREEN);
  });

  it('does not count non-required runs toward readiness', () => {
    const r = evaluateRequiredContexts(EIGHT, [
      ...allEight(),
      ok('Lint'),
      ok('Format'),
    ]);
    expect(r.green).toHaveLength(8);
    expect(r.extra).toBe(2);
  });

  it('is ABSENT when there are no runs at all rather than vacuously ready', () => {
    const r = evaluateRequiredContexts(EIGHT, []);
    expect(r.exitCode).toBe(EXIT_ABSENT);
    expect(r.absent).toHaveLength(8);
  });

  it('tolerates undefined runs', () => {
    const r = evaluateRequiredContexts(EIGHT, undefined);
    expect(r.exitCode).toBe(EXIT_ABSENT);
  });

  it('treats a SKIPPED required context as not green', () => {
    const runs = allEight();
    runs[runs.findIndex((r) => r.name === 'Desktop (macos-latest)')] = ok(
      'Desktop (macos-latest)',
      'SKIPPED',
    );
    const r = evaluateRequiredContexts(EIGHT, runs);
    expect(r.exitCode).toBe(EXIT_NOT_GREEN);
  });

  it('treats a NEUTRAL required context as not green', () => {
    const runs = allEight();
    runs[runs.findIndex((r) => r.name === 'Desktop (macos-latest)')] = ok(
      'Desktop (macos-latest)',
      'NEUTRAL',
    );
    const r = evaluateRequiredContexts(EIGHT, runs);
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
    const r = evaluateRequiredContexts(EIGHT, [ok('Dependency advisories')]);
    const text = formatResult(1, r, EIGHT);
    expect(text).toContain('ABSENT  Desktop (windows-latest)');
    expect(text).toContain('cannot go red');
  });

  it('separates the non-required population explicitly', () => {
    const r = evaluateRequiredContexts(EIGHT, [...allEight(), ok('Lint')]);
    expect(formatResult(2, r, EIGHT)).toContain(
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
  it('pins BOTH platform candidate lists, on whichever runner executes this', () => {
    expect(ghCandidates('win32')).toEqual(['gh.exe', 'gh', 'gh.cmd']);
    expect(ghCandidates('darwin')).toEqual(['gh']);
    expect(ghCandidates('linux')).toEqual(['gh']);
  });

  it('falls through to the next candidate when one cannot spawn', () => {
    // platform is injected. On a non-Windows runner the real list has ONE
    // entry, so this test's subject does not exist there and it fails for a
    // reason unrelated to the behaviour under test. That is exactly what
    // happened on macos-latest the first time this file ran in CI, while
    // passing locally on Windows.
    const tried: string[] = [];
    const r = runGh(
      (cmd: string) => {
        tried.push(cmd);
        if (tried.length === 1) return { error: new Error('EINVAL') };
        return { status: 0, stdout: 'ok', stderr: '' };
      },
      ['x'],
      {},
      'win32',
    );
    expect(r.spawned).toBe(true);
    expect(r.stdout).toBe('ok');
    expect(tried).toEqual(['gh.exe', 'gh']);
  });

  it('tries exactly one name on a non-Windows platform', () => {
    const tried: string[] = [];
    runGh(
      (cmd: string) => {
        tried.push(cmd);
        return { error: new Error('ENOENT') };
      },
      ['x'],
      {},
      'darwin',
    );
    expect(tried).toEqual(['gh']);
  });

  it('reports not-spawned when every candidate fails', () => {
    const r = runGh(() => ({ error: new Error('ENOENT') }), ['x'], {}, 'win32');
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

  it('returns 0 for a head carrying all eight', () => {
    expect(
      main(
        ['--pr', '1'],
        { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
        () => ({
          status: 0,
          stdout: JSON.stringify({ statusCheckRollup: allEight() }),
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
            statusCheckRollup: allEight()
              .slice(1)
              .concat([ok('Lint')]),
          }),
          stderr: '',
        }),
      ),
    ).toBe(EXIT_ABSENT);
  });

  it('returns 1 for a head with a red required context', () => {
    const runs = allEight();
    runs[runs.findIndex((r) => r.name === 'Sidecar (macos-latest)')] = ok(
      'Sidecar (macos-latest)',
      'FAILURE',
    );
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
