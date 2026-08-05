import { describe, expect, it } from 'vitest';

import {
  EXIT_DEFERRED,
  EXIT_READY,
  EXIT_UNDETERMINED,
  VERDICT_HEAD_MOVED,
  VERDICT_READY,
  VERDICT_WAITING_FOR_CHECKS,
  classifyReviewTarget,
  main,
  parseCheckRunCount,
  parseComparison,
  parsePullSnapshot,
} from '../scripts/prepare-review-target.mjs';
import type { GhSpawn } from '../scripts/check-required-contexts.mjs';

const PR_NUMBER = 515;
const REPOSITORY = 'o/r';
const BASE = '2'.repeat(40);
const FEATURE = '3'.repeat(40);
const MERGE = '4'.repeat(40);
const MOVED = '5'.repeat(40);
const BASE_MOVED = '6'.repeat(40);

type CommandResult = {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

function response(body: unknown, status = 0, stderr = ''): CommandResult {
  return { status, stdout: JSON.stringify(body), stderr };
}

function pull(headSha = FEATURE) {
  return {
    number: PR_NUMBER,
    state: 'open',
    base: { ref: 'development' },
    head: { ref: 'feature', sha: headSha },
  };
}

function branch(sha = BASE) {
  return { name: 'development', commit: { sha } };
}

function comparison(headSha = FEATURE, parents = [BASE], mergeBaseSha = BASE) {
  return {
    merge_base_commit: { sha: mergeBaseSha },
    commits: [
      {
        sha: headSha,
        parents: parents.map((sha) => ({ sha })),
      },
    ],
    files: [{ filename: 'src/feature.ts', status: 'modified' }],
  };
}

function apiStub(routes: Record<string, CommandResult | CommandResult[]>): {
  run: GhSpawn;
  calls: string[];
} {
  const queues = new Map(
    Object.entries(routes).map(([path, result]) => [
      path,
      Array.isArray(result) ? [...result] : [result],
    ]),
  );
  const calls: string[] = [];

  return {
    calls,
    run: (_command, args) => {
      if (args[0] !== 'api' || typeof args[1] !== 'string') {
        throw new Error(`unexpected command: ${args.join(' ')}`);
      }
      const path = args[1];
      calls.push(path);
      const queue = queues.get(path);
      if (!queue || queue.length === 0) {
        throw new Error(`unexpected API path: ${path}`);
      }
      return queue.shift() as CommandResult;
    },
  };
}

function paths(headSha = FEATURE, baseSha = BASE) {
  return {
    pull: `repos/${REPOSITORY}/pulls/${PR_NUMBER}`,
    base: `repos/${REPOSITORY}/branches/development`,
    checks: `repos/${REPOSITORY}/commits/${headSha}/check-runs?per_page=1`,
    compare: `repos/${REPOSITORY}/compare/${baseSha}...${headSha}`,
  };
}

function runMain(routes: Record<string, CommandResult | CommandResult[]>): {
  exitCode: number;
  output: string;
  errors: string;
  calls: string[];
} {
  const { run, calls } = apiStub(routes);
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = main(
    ['--pr', String(PR_NUMBER)],
    { GITHUB_REPOSITORY: REPOSITORY },
    run,
    (line) => output.push(line),
    (line) => errors.push(line),
  );
  return {
    exitCode,
    output: output.join('\n'),
    errors: errors.join('\n'),
    calls,
  };
}

describe('review scope selection', () => {
  it('emits a brief for the normal current pull request head', () => {
    const p = paths();
    const result = runMain({
      [p.pull]: [response(pull()), response(pull())],
      [p.base]: [response(branch()), response(branch())],
      [p.checks]: response({ total_count: 3, check_runs: [{}] }),
      [p.compare]: response(comparison()),
    });

    expect(result.exitCode).toBe(EXIT_READY);
    expect(result.output).toContain('[review-target] READY');
    expect(result.output).toContain(`head sha      ${FEATURE}`);
    expect(result.output).toContain(`base sha      ${BASE}`);
    expect(result.output).toContain(`review range  ${BASE}..${FEATURE}`);
    expect(result.calls.filter((path) => path === p.pull)).toHaveLength(2);
    expect(result.calls.filter((path) => path === p.base)).toHaveLength(2);
  });

  it('uses merge-base..head for a current multi-parent head instead of its misleading first-parent diff', () => {
    // Topology:
    //
    //   ROOT -- FEATURE ---- MERGE   (current PR head)
    //      \-- BASE --------/
    //
    // MERGE's bare first-parent range is FEATURE..MERGE, which contains the
    // trunk sync. The PR contribution is merge-base(BASE, MERGE)..MERGE.
    const parsed = parseComparison(
      comparison(MERGE, [FEATURE, BASE], BASE),
      MERGE,
    );
    expect(parsed.parentCount).toBe(2);
    expect(parsed.files).toEqual(['src/feature.ts']);
    expect(parsed.range).toBe(`${BASE}..${MERGE}`);
    expect(parsed.range).not.toBe(`${FEATURE}..${MERGE}`);

    const p = paths(MERGE);
    const result = runMain({
      [p.pull]: [response(pull(MERGE)), response(pull(MERGE))],
      [p.base]: [response(branch()), response(branch())],
      [p.checks]: response({ total_count: 1, check_runs: [{}] }),
      [p.compare]: response(comparison(MERGE, [FEATURE, BASE], BASE)),
    });

    expect(result.exitCode).toBe(EXIT_READY);
    expect(result.output).toContain(`review range  ${BASE}..${MERGE}`);
    expect(result.output).toContain('head parents  2');
    expect(result.calls).toContain(p.compare);
    expect(result.calls).not.toContain(`repos/${REPOSITORY}/commits/${MERGE}`);
  });
});

describe('transiently unsafe targets', () => {
  it('defers a current head with zero check runs without declaring the head invalid', () => {
    const p = paths();
    const result = runMain({
      [p.pull]: [response(pull()), response(pull())],
      [p.base]: [response(branch()), response(branch())],
      [p.checks]: response({ total_count: 0, check_runs: [] }),
    });

    expect(result.exitCode).toBe(EXIT_DEFERRED);
    expect(result.output).toBe('');
    expect(result.errors).toContain('[review-target] WAIT');
    expect(result.errors).toContain('not evidence that the head is invalid');
    expect(result.calls).not.toContain(p.compare);
  });

  it('POSITIVE CONTROL: the same current head becomes dispatchable when one run appears', () => {
    const p = paths();
    const result = runMain({
      [p.pull]: [response(pull()), response(pull())],
      [p.base]: [response(branch()), response(branch())],
      [p.checks]: response({ total_count: 1, check_runs: [{}] }),
      [p.compare]: response(comparison()),
    });

    expect(result.exitCode).toBe(EXIT_READY);
    expect(result.output).toContain('[review-target] READY');
  });

  it('drops the derived brief when the PR head moves between reads', () => {
    const p = paths();
    const result = runMain({
      [p.pull]: [response(pull()), response(pull(MOVED))],
      [p.base]: [response(branch()), response(branch())],
      [p.checks]: response({ total_count: 1, check_runs: [{}] }),
      [p.compare]: response(comparison()),
    });

    expect(result.exitCode).toBe(EXIT_DEFERRED);
    expect(result.output).toBe('');
    expect(result.errors).toContain('head moved');
    expect(result.errors).not.toContain('review range');
  });

  it('also drops the brief when the live base moves during derivation', () => {
    const p = paths();
    const result = runMain({
      [p.pull]: [response(pull()), response(pull())],
      [p.base]: [response(branch()), response(branch(BASE_MOVED))],
      [p.checks]: response({ total_count: 1, check_runs: [{}] }),
      [p.compare]: response(comparison()),
    });

    expect(result.exitCode).toBe(EXIT_DEFERRED);
    expect(result.output).toBe('');
    expect(result.errors).toContain('base moved');
  });
});

describe('zero is a reading, not an error fallback', () => {
  it('parses a real zero and rejects a missing or string count', () => {
    expect(parseCheckRunCount({ total_count: 0 })).toBe(0);
    expect(() => parseCheckRunCount({})).toThrow(/total_count/);
    expect(() => parseCheckRunCount({ total_count: '0' })).toThrow(
      /total_count/,
    );
  });

  it('a CLI/API failure carrying zero-shaped stdout is indeterminate, never a zero-run deferral', () => {
    const p = paths();
    const result = runMain({
      [p.pull]: response(pull()),
      [p.base]: response(branch()),
      [p.checks]: {
        status: 1,
        stdout: JSON.stringify({ total_count: 0 }),
        stderr: 'gh: service unavailable (HTTP 503)',
      },
    });

    expect(result.exitCode).toBe(EXIT_UNDETERMINED);
    expect(result.exitCode).not.toBe(EXIT_DEFERRED);
    expect(result.output).toBe('');
    expect(result.errors).toContain('HTTP 503');
  });

  it('malformed API data is indeterminate rather than silently defaulting to zero', () => {
    const p = paths();
    const result = runMain({
      [p.pull]: response(pull()),
      [p.base]: response(branch()),
      [p.checks]: response({ message: 'not a check-run response' }),
    });

    expect(result.exitCode).toBe(EXIT_UNDETERMINED);
    expect(result.exitCode).not.toBe(EXIT_DEFERRED);
  });
});

describe('classification controls', () => {
  const initial = parsePullSnapshot(pull(), PR_NUMBER);
  const comparisonResult = parseComparison(comparison(), FEATURE);

  it('returns READY for a stable measured target', () => {
    expect(
      classifyReviewTarget({
        initial,
        final: initial,
        initialBaseSha: BASE,
        finalBaseSha: BASE,
        checkRunCount: 1,
        comparison: comparisonResult,
      }).verdict,
    ).toBe(VERDICT_READY);
  });

  it('NEGATIVE CONTROL: zero runs returns WAITING rather than READY', () => {
    expect(
      classifyReviewTarget({
        initial,
        final: initial,
        initialBaseSha: BASE,
        finalBaseSha: BASE,
        checkRunCount: 0,
        comparison: null,
      }).verdict,
    ).toBe(VERDICT_WAITING_FOR_CHECKS);
  });

  it('NEGATIVE CONTROL: a changed head returns MOVED rather than READY', () => {
    expect(
      classifyReviewTarget({
        initial,
        final: parsePullSnapshot(pull(MOVED), PR_NUMBER),
        initialBaseSha: BASE,
        finalBaseSha: BASE,
        checkRunCount: 1,
        comparison: comparisonResult,
      }).verdict,
    ).toBe(VERDICT_HEAD_MOVED);
  });

  it('keeps ready, deferred, and undetermined exits distinct', () => {
    expect(new Set([EXIT_READY, EXIT_DEFERRED, EXIT_UNDETERMINED]).size).toBe(
      3,
    );
  });

  it('does not accept a caller-supplied SHA as a target override', () => {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCode = main(
      ['--pr', String(PR_NUMBER), '--sha', FEATURE],
      { GITHUB_REPOSITORY: REPOSITORY },
      () => {
        throw new Error('the API must not be called for invalid arguments');
      },
      (line) => output.push(line),
      (line) => errors.push(line),
    );

    expect(exitCode).toBe(EXIT_UNDETERMINED);
    expect(output).toEqual([]);
    expect(errors.join('\n')).toContain('unrecognised argument "--sha"');
  });
});
