import { describe, expect, it } from 'vitest';

import {
  EXIT_CLEAN,
  EXIT_FAILED,
  EXIT_UNDETERMINED,
  VERDICT_FAILED,
  VERDICT_PASSED,
  VERDICT_PENDING,
  VERDICT_SUPERSEDED,
  buildVerdicts,
  classifyConclusion,
  fetchCheckRuns,
  formatReport,
  latestCheckRunsByName,
  main,
  resolveRepo,
} from '../scripts/check-run-verdicts.mjs';

function stub(
  handler: (
    command: string,
    argv: readonly string[],
  ) => { status: number; stdout?: string; stderr?: string },
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

function checkRun(overrides: Record<string, unknown>) {
  return {
    id: 1,
    name: 'some check',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-08-06T15:58:29Z',
    ...overrides,
  };
}

describe('classifyConclusion', () => {
  it.each([
    ['success', VERDICT_PASSED],
    ['neutral', VERDICT_PASSED],
    ['skipped', VERDICT_PASSED],
  ])(
    'NEGATIVE CONTROL: %s reports %s, never failed',
    (conclusion, expected) => {
      expect(classifyConclusion(conclusion)).toBe(expected);
    },
  );

  it.each([
    ['failure', VERDICT_FAILED],
    ['timed_out', VERDICT_FAILED],
    ['action_required', VERDICT_FAILED],
    ['startup_failure', VERDICT_FAILED],
  ])('POSITIVE CONTROL: %s reports %s', (conclusion, expected) => {
    expect(classifyConclusion(conclusion)).toBe(expected);
  });

  it.each([
    ['cancelled', VERDICT_SUPERSEDED],
    ['stale', VERDICT_SUPERSEDED],
  ])(
    'THE #562 FIX: %s reports %s, and specifically NOT failed',
    (conclusion, expected) => {
      const observed = classifyConclusion(conclusion);
      expect(observed).toBe(expected);
      expect(observed).not.toBe(VERDICT_FAILED);
    },
  );

  it('an unfinished run (null conclusion) reports pending', () => {
    expect(classifyConclusion(null)).toBe(VERDICT_PENDING);
  });

  it('refuses to guess a verdict for an unrecognized conclusion', () => {
    expect(() => classifyConclusion('some_future_conclusion')).toThrow(
      /unrecognized check-run conclusion/,
    );
  });
});

describe('latestCheckRunsByName', () => {
  it('reproduces the issue witness: "Sequencing hold" latest run is cancelled, not failure', () => {
    // Verbatim from #562's measurement at PR #560 head 0fe7384d...:
    //   2026-08-06T15:58:29Z | conclusion=cancelled
    //   2026-08-06T15:58:30Z | conclusion=cancelled
    //   2026-08-06T15:59:53Z | conclusion=success
    //   2026-08-06T16:00:16Z | conclusion=success
    //   2026-08-06T16:21:37Z | conclusion=cancelled   <- latest
    // There is no `failure` conclusion anywhere in this set. `gh pr checks`
    // still rendered this name as `fail`.
    const checkRuns = [
      checkRun({
        id: 1,
        started_at: '2026-08-06T15:58:29Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 2,
        started_at: '2026-08-06T15:58:30Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 3,
        started_at: '2026-08-06T15:59:53Z',
        conclusion: 'success',
      }),
      checkRun({
        id: 4,
        started_at: '2026-08-06T16:00:16Z',
        conclusion: 'success',
      }),
      checkRun({
        id: 5,
        started_at: '2026-08-06T16:21:37Z',
        conclusion: 'cancelled',
      }),
    ].map((run) => ({ ...run, name: 'Sequencing hold' }));

    const latest = latestCheckRunsByName(checkRuns);
    const run = latest.get('Sequencing hold');
    expect(run?.id).toBe(5);
    expect(run?.conclusion).toBe('cancelled');
    expect(classifyConclusion(run!.conclusion)).toBe(VERDICT_SUPERSEDED);
    expect(classifyConclusion(run!.conclusion)).not.toBe(VERDICT_FAILED);
  });

  it('breaks a started_at tie by the larger id', () => {
    const checkRuns = [
      checkRun({
        id: 10,
        started_at: '2026-08-06T16:00:00Z',
        conclusion: 'cancelled',
      }),
      checkRun({
        id: 11,
        started_at: '2026-08-06T16:00:00Z',
        conclusion: 'success',
      }),
    ];
    const latest = latestCheckRunsByName(checkRuns);
    expect(latest.get('some check')?.id).toBe(11);
    expect(latest.get('some check')?.conclusion).toBe('success');
  });

  it('an in-progress run (status != completed) reports pending regardless of a stray conclusion field', () => {
    const checkRuns = [
      checkRun({ id: 1, status: 'in_progress', conclusion: null }),
    ];
    const latest = latestCheckRunsByName(checkRuns);
    expect(latest.get('some check')?.conclusion).toBeNull();
  });
});

describe('buildVerdicts', () => {
  it('classifies the positive control, negative control, and the cancelled case together', () => {
    const checkRuns = [
      checkRun({ id: 1, name: 'Citation reachability', conclusion: 'failure' }),
      checkRun({ id: 2, name: 'Stacked base', conclusion: 'success' }),
      checkRun({ id: 3, name: 'Sequencing hold', conclusion: 'cancelled' }),
    ];
    const verdicts = buildVerdicts(checkRuns);
    expect(verdicts).toEqual([
      {
        name: 'Citation reachability',
        conclusion: 'failure',
        verdict: VERDICT_FAILED,
      },
      {
        name: 'Sequencing hold',
        conclusion: 'cancelled',
        verdict: VERDICT_SUPERSEDED,
      },
      { name: 'Stacked base', conclusion: 'success', verdict: VERDICT_PASSED },
    ]);
  });

  it('rejects an empty check-run list rather than reporting an empty clean verdict', () => {
    expect(() => buildVerdicts([])).toThrow(/no check runs/);
  });
});

describe('formatReport', () => {
  it('calls out superseded checks as carrying no verdict, distinct from failed', () => {
    const report = formatReport('abc123', [
      {
        name: 'Sequencing hold',
        conclusion: 'cancelled',
        verdict: VERDICT_SUPERSEDED,
      },
    ]);
    expect(report).toContain('superseded');
    expect(report).toContain('not a failure, no verdict');
  });
});

describe('resolveRepo', () => {
  it('falls back to gh repo view when nothing else is set', () => {
    const repo = resolveRepo(
      undefined,
      {},
      stub(() => ({ status: 0, stdout: 'o/r\n' })),
    );
    expect(repo).toBe('o/r');
  });
});

describe('fetchCheckRuns', () => {
  it('parses the check_runs array from gh api', () => {
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub((_command, argv) => {
        expect(argv[1]).toBe(
          'repos/o/r/commits/abc123/check-runs?per_page=100',
        );
        return {
          status: 0,
          stdout: JSON.stringify([checkRun({ id: 1 })]),
        };
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.checkRuns).toHaveLength(1);
  });

  it('reports undetermined when gh api fails', () => {
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({ status: 1, stderr: 'gh: Not Found (HTTP 404)' })),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('HTTP 404');
  });

  it('reports undetermined on an empty check-runs array', () => {
    const result = fetchCheckRuns(
      'o/r',
      'abc123',
      {},
      stub(() => ({ status: 0, stdout: '[]' })),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(
      'no check runs found',
    );
  });
});

describe('main', () => {
  it('exits clean when the only non-passing conclusion is cancelled (the #562 regression)', () => {
    const output: string[] = [];
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: JSON.stringify([
          checkRun({ id: 1, name: 'Sequencing hold', conclusion: 'cancelled' }),
          checkRun({ id: 2, name: 'Stacked base', conclusion: 'success' }),
        ]),
      })),
      (text: string) => output.push(text),
    );

    expect(result).toBe(EXIT_CLEAN);
    expect(output.join('\n')).not.toContain('failed     Sequencing hold');
  });

  it('POSITIVE CONTROL: exits failed when a genuine failure is present', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: JSON.stringify([
          checkRun({
            id: 1,
            name: 'Citation reachability',
            conclusion: 'failure',
          }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_FAILED);
  });

  it('NEGATIVE CONTROL: exits clean when everything is success', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({
        status: 0,
        stdout: JSON.stringify([
          checkRun({ id: 1, name: 'Stacked base', conclusion: 'success' }),
        ]),
      })),
      () => undefined,
    );
    expect(result).toBe(EXIT_CLEAN);
  });

  it('exits undetermined when the check-runs query cannot be executed', () => {
    const result = main(
      ['--repo', 'o/r', '--sha', 'abc123'],
      {},
      stub(() => ({ status: 1, stderr: 'gh: Not Found (HTTP 404)' })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });

  it('exits undetermined when --sha is missing', () => {
    const result = main(
      ['--repo', 'o/r'],
      {},
      stub(() => ({ status: 0, stdout: '[]' })),
      () => undefined,
    );
    expect(result).toBe(EXIT_UNDETERMINED);
  });
});
