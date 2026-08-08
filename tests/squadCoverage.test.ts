import { describe, expect, it } from 'vitest';
import {
  classifyIssueCoverage,
  evaluateSquadCoverage,
  formatOffenderLine,
  formatReport,
  main,
  normalizeLabels,
  parseOpenIssues,
  parsePaginatedIssuesResponse,
  runGitHub,
} from '../scripts/check-squad-coverage.mjs';

interface FixtureIssue {
  number: number;
  labels: string[];
  url?: string;
}

function issue(input: FixtureIssue) {
  return {
    number: input.number,
    labels: input.labels,
    url: input.url ?? `https://github.test/issues/${input.number}`,
  };
}

describe('normalizeLabels', () => {
  it('accepts a bare string[] fixture shape', () => {
    expect(normalizeLabels(['squad:ripley', 'tech-debt'], 'x')).toEqual([
      'squad:ripley',
      'tech-debt',
    ]);
  });

  it('accepts the gh issue list {name}[] shape', () => {
    expect(
      normalizeLabels(
        [{ name: 'squad:ripley', id: 'LA_1' }, { name: 'triage' }],
        'x',
      ),
    ).toEqual(['squad:ripley', 'triage']);
  });

  it('rejects a non-array', () => {
    expect(() => normalizeLabels('squad:ripley', 'x')).toThrow(
      /must be an array/,
    );
  });

  it('rejects a label object with no string name', () => {
    expect(() => normalizeLabels([{ id: 'LA_1' }], 'x')).toThrow(
      /has no string "name"/,
    );
  });
});

describe('parseOpenIssues', () => {
  it('parses a gh issue list --json number,labels,url payload', () => {
    const raw = JSON.stringify([
      {
        number: 568,
        labels: [{ name: 'squad:ripley' }, { name: 'tech-debt' }],
        url: 'https://github.test/issues/568',
      },
    ]);
    expect(parseOpenIssues(raw)).toEqual([
      {
        number: 568,
        labels: ['squad:ripley', 'tech-debt'],
        url: 'https://github.test/issues/568',
      },
    ]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseOpenIssues('not json')).toThrow(/not valid JSON/);
  });

  it('rejects a non-array payload', () => {
    expect(() => parseOpenIssues('{}')).toThrow(/must be a JSON array/);
  });

  it('rejects a repeated issue number', () => {
    const raw = JSON.stringify([
      { number: 1, labels: [] },
      { number: 1, labels: [] },
    ]);
    expect(() => parseOpenIssues(raw)).toThrow(/repeats issue #1/);
  });
});

describe('classifyIssueCoverage', () => {
  it('covers an issue with exactly one squad:* label', () => {
    const result = classifyIssueCoverage(
      issue({ number: 1, labels: ['squad:ripley', 'tech-debt'] }),
    );
    expect(result.covered).toBe(true);
  });

  it('covers an issue with a triage label and no squad:* label', () => {
    const result = classifyIssueCoverage(
      issue({ number: 2, labels: ['triage', 'bug'] }),
    );
    expect(result.covered).toBe(true);
  });

  it('does NOT cover an issue with zero squad:* labels and no triage', () => {
    const result = classifyIssueCoverage(
      issue({ number: 3, labels: ['bug', 'priority:p1'] }),
    );
    expect(result.covered).toBe(false);
  });

  it('does NOT cover an issue with two squad:* labels and no triage', () => {
    // "exactly one" is the stated bar -- two is not "at least one".
    const result = classifyIssueCoverage(
      issue({ number: 4, labels: ['squad:ripley', 'squad:hicks'] }),
    );
    expect(result.covered).toBe(false);
  });

  it('covers an issue with two squad:* labels when triage is also present', () => {
    const result = classifyIssueCoverage(
      issue({ number: 5, labels: ['squad:ripley', 'squad:hicks', 'triage'] }),
    );
    expect(result.covered).toBe(true);
  });

  it('does NOT cover an issue with no labels at all', () => {
    const result = classifyIssueCoverage(issue({ number: 6, labels: [] }));
    expect(result.covered).toBe(false);
  });
});

describe('evaluateSquadCoverage', () => {
  it('POSITIVE CONTROL: reports zero offenders when every issue is routed or triaged', () => {
    const result = evaluateSquadCoverage([
      issue({ number: 10, labels: ['squad:dallas'] }),
      issue({ number: 11, labels: ['triage'] }),
      issue({ number: 12, labels: ['squad:bishop', 'tech-debt'] }),
    ]);
    expect(result).toEqual({
      totalOpenIssues: 3,
      coveredCount: 3,
      offenders: [],
    });
  });

  it('NEGATIVE ARM: names every offender, sorted by issue number, alongside covered issues', () => {
    const result = evaluateSquadCoverage([
      issue({ number: 30, labels: ['squad:vasquez'] }),
      issue({ number: 15, labels: ['bug'] }), // unrouted
      issue({ number: 22, labels: [] }), // unrouted, no labels
      issue({ number: 8, labels: ['squad:ripley', 'squad:hicks'] }), // two squad labels, no triage
    ]);
    expect(result.totalOpenIssues).toBe(4);
    expect(result.coveredCount).toBe(1);
    expect(result.offenders).toEqual([
      { number: 8, labels: ['squad:ripley', 'squad:hicks'] },
      { number: 15, labels: ['bug'] },
      { number: 22, labels: [] },
    ]);
  });

  it('rejects a non-array input', () => {
    expect(() => evaluateSquadCoverage('nope' as never)).toThrow(
      /must be an array/,
    );
  });
});

describe('parsePaginatedIssuesResponse', () => {
  it('flattens every page from gh api --paginate --slurp', () => {
    const raw = JSON.stringify([
      [{ number: 1, labels: [{ name: 'squad:ripley' }] }],
      [{ number: 2, labels: [{ name: 'triage' }] }],
    ]);
    expect(parsePaginatedIssuesResponse(raw)).toEqual([
      { number: 1, labels: ['squad:ripley'], url: undefined },
      { number: 2, labels: ['triage'], url: undefined },
    ]);
  });

  it('carries an offender past the boundary a --limit cap would have truncated at', () => {
    // Regression guard for the truncation defect found in adversarial
    // review: a fixed `--limit N` silently drops issue N+1 onward. Modeling
    // the read as pages (not a single flat array with a size cap) means an
    // offender on page 2 is exactly as visible as one on page 1.
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      labels: [{ name: 'squad:dallas' }],
    }));
    const page2 = [{ number: 101, labels: [{ name: 'bug' }] }]; // unrouted
    const raw = JSON.stringify([page1, page2]);
    const issues = parsePaginatedIssuesResponse(raw);
    expect(issues).toHaveLength(101);
    const result = evaluateSquadCoverage(issues);
    expect(result.offenders).toEqual([{ number: 101, labels: ['bug'] }]);
  });

  it('drops pull requests mixed into the /issues endpoint response', () => {
    const raw = JSON.stringify([
      [
        { number: 1, labels: [{ name: 'squad:ripley' }] },
        {
          number: 2,
          labels: [], // an unrouted PR must not be reported as an unrouted issue
          pull_request: { url: 'https://api.github.test/pulls/2' },
        },
      ],
    ]);
    const issues = parsePaginatedIssuesResponse(raw);
    expect(issues).toEqual([
      { number: 1, labels: ['squad:ripley'], url: undefined },
    ]);
  });

  it('rejects a response that is not an array of pages', () => {
    expect(() =>
      parsePaginatedIssuesResponse(JSON.stringify([{ number: 1 }])),
    ).toThrow(/not an array of pages/);
  });

  it('rejects a repeated issue number across pages', () => {
    const raw = JSON.stringify([
      [{ number: 1, labels: [] }],
      [{ number: 1, labels: [] }],
    ]);
    expect(() => parsePaginatedIssuesResponse(raw)).toThrow(/repeats issue #1/);
  });
});

describe('runGitHub', () => {
  it('returns stdout on a clean exit', () => {
    const execute = () => '[]';
    expect(runGitHub(['issue', 'list'], execute)).toBe('[]');
  });

  it('propagates a non-zero exit even when gh wrote stdout first', () => {
    // Regression guard for the defect found in adversarial review: treating
    // "there was some stdout" as "the read succeeded" can turn a genuinely
    // failed/partial `gh` invocation into a false-clean "0 offenders".
    const execute = () => {
      const error = new Error('gh: rate limited') as Error & {
        stdout: string;
        status: number;
      };
      error.stdout = '[["not the full page"';
      error.status = 1;
      throw error;
    };
    expect(() => runGitHub(['issue', 'list'], execute)).toThrow(/rate limited/);
  });
});

describe('formatOffenderLine / formatReport', () => {
  it('names the issue number and its current labels', () => {
    expect(
      formatOffenderLine({ number: 15, labels: ['bug', 'priority:p2'] }),
    ).toBe('  #15: bug, priority:p2');
  });

  it('marks a label-less offender explicitly rather than printing a blank', () => {
    expect(formatOffenderLine({ number: 22, labels: [] })).toBe(
      '  #22: (no labels)',
    );
  });

  it('reports OK with zero offenders', () => {
    const report = formatReport({
      totalOpenIssues: 2,
      coveredCount: 2,
      offenders: [],
    });
    expect(report).toContain('offenders 0');
    expect(report).toContain('OK: every open issue');
  });

  it('reports FAILED and names each offender', () => {
    const report = formatReport({
      totalOpenIssues: 3,
      coveredCount: 2,
      offenders: [{ number: 15, labels: ['bug'] }],
    });
    expect(report).toContain('FAILED: 1 open issue(s)');
    expect(report).toContain('#15: bug');
  });
});

describe('main() — the negative arm required by #410, driven end-to-end', () => {
  it('POSITIVE CONTROL: exits 0 and reports OK when every issue is covered', async () => {
    const output: string[] = [];
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await main([], {
        readLive: () => [
          issue({ number: 100, labels: ['squad:dallas'] }),
          issue({ number: 101, labels: ['triage'] }),
        ],
        output: (line: string) => output.push(line),
      });
      expect(result.offenders).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expect(output.join('\n')).toContain('OK: every open issue');
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('NEGATIVE ARM: with one deliberately unrouted issue present, exits 1 and names it', async () => {
    const output: string[] = [];
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await main([], {
        readLive: () => [
          issue({ number: 100, labels: ['squad:dallas'] }),
          issue({ number: 999, labels: ['bug'] }), // deliberately unrouted
        ],
        output: (line: string) => output.push(line),
      });
      expect(result.offenders).toEqual([{ number: 999, labels: ['bug'] }]);
      expect(process.exitCode).toBe(1);
      expect(output.join('\n')).toContain('FAILED: 1 open issue(s)');
      expect(output.join('\n')).toContain('#999: bug');
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('reads from a --fixture file instead of gh when one is given', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'squad-coverage-fixture-'));
    const fixturePath = path.join(dir, 'issues.json');
    writeFileSync(
      fixturePath,
      JSON.stringify([{ number: 5, labels: ['bug'] }]),
    );
    const output: string[] = [];
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const run = () => {
        throw new Error('run() must not be called when --fixture is given');
      };
      const result = await main(['--fixture', fixturePath], {
        run,
        output: (line: string) => output.push(line),
      });
      expect(result.offenders).toEqual([{ number: 5, labels: ['bug'] }]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects --fixture with no path argument', async () => {
    await expect(main(['--fixture'], {})).rejects.toThrow(
      /--fixture requires a path/,
    );
  });
});
