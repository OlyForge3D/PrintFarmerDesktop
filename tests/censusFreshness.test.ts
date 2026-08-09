// @vitest-environment node

// #336: `check-census-freshness.mjs` asserts that a published citation of a
// past ownership-census run has not aged past the `gc.reflogExpireUnreachable`
// window the census depends on. This suite mirrors
// `tests/datedMeasurement.test.ts`'s structure closely, since the module it
// tests is deliberately modelled on `check-dated-measurement.mjs`.

import { describe, expect, it } from 'vitest';

import {
  EXIT_DUE,
  EXIT_OK,
  EXIT_STALE,
  EXIT_UNVERIFIABLE,
  FABRICATED_ANCIENT_TIMESTAMP,
  RECOMMENDED_REMEASUREMENT_DAYS,
  REFLOG_EXPIRY_DAYS,
  SAMPLE_TIMESTAMP_FOR_CONTROLS,
  VERDICT_DUE,
  VERDICT_FRESH,
  VERDICT_STALE,
  VERDICT_UNVERIFIABLE,
  classifyCensusFreshness,
  evaluateControls,
  formatResult,
  main,
  parseCensusCitations,
  resolveNow,
} from '../scripts/check-census-freshness.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-08-04T00:00:00Z');

describe('resolving "now"', () => {
  it('defaults to the real wall clock when omitted', () => {
    const before = Date.now();
    const resolved = resolveNow(undefined);
    const after = Date.now();
    expect(resolved).toBeGreaterThanOrEqual(before);
    expect(resolved).toBeLessThanOrEqual(after);
  });

  it('accepts a finite epoch-ms number directly', () => {
    expect(resolveNow(T0)).toBe(T0);
  });

  it('rejects a non-finite number', () => {
    expect(resolveNow(Number.NaN)).toBeNull();
    expect(resolveNow(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('parses an ISO string', () => {
    expect(resolveNow('2026-08-04T00:00:00Z')).toBe(T0);
  });

  it('returns null for an unparseable string rather than falling back to Date.now()', () => {
    expect(resolveNow('not-a-timestamp')).toBeNull();
  });
});

describe('classifying census citation freshness', () => {
  it('reports FRESH for a citation measured just now', () => {
    const result = classifyCensusFreshness({ measuredAt: T0, now: T0 });
    expect(result.verdict).toBe(VERDICT_FRESH);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.ageDays).toBe(0);
  });

  it(`reports FRESH exactly at the ${RECOMMENDED_REMEASUREMENT_DAYS}-day boundary`, () => {
    const now = T0 + RECOMMENDED_REMEASUREMENT_DAYS * MS_PER_DAY;
    const result = classifyCensusFreshness({ measuredAt: T0, now });
    expect(result.verdict).toBe(VERDICT_FRESH);
    expect(result.exitCode).toBe(EXIT_OK);
  });

  it(`reports DUE one millisecond past the ${RECOMMENDED_REMEASUREMENT_DAYS}-day boundary`, () => {
    const now = T0 + RECOMMENDED_REMEASUREMENT_DAYS * MS_PER_DAY + 1;
    const result = classifyCensusFreshness({ measuredAt: T0, now });
    expect(result.verdict).toBe(VERDICT_DUE);
    expect(result.exitCode).toBe(EXIT_DUE);
  });

  it(`reports DUE exactly at the ${REFLOG_EXPIRY_DAYS}-day boundary`, () => {
    const now = T0 + REFLOG_EXPIRY_DAYS * MS_PER_DAY;
    const result = classifyCensusFreshness({ measuredAt: T0, now });
    expect(result.verdict).toBe(VERDICT_DUE);
    expect(result.exitCode).toBe(EXIT_DUE);
  });

  it(`reports STALE one millisecond past the ${REFLOG_EXPIRY_DAYS}-day boundary`, () => {
    const now = T0 + REFLOG_EXPIRY_DAYS * MS_PER_DAY + 1;
    const result = classifyCensusFreshness({ measuredAt: T0, now });
    expect(result.verdict).toBe(VERDICT_STALE);
    expect(result.exitCode).toBe(EXIT_STALE);
  });

  it('reports STALE well past the reflog expiry window (e.g. the 5-week follow-up point)', () => {
    const now = T0 + 35 * MS_PER_DAY;
    const result = classifyCensusFreshness({ measuredAt: T0, now });
    expect(result.verdict).toBe(VERDICT_STALE);
    expect(result.exitCode).toBe(EXIT_STALE);
  });

  it('reports UNVERIFIABLE when measured_at cannot be normalized', () => {
    const result = classifyCensusFreshness({ measuredAt: null, now: T0 });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.exitCode).toBe(EXIT_UNVERIFIABLE);
  });

  it('reports UNVERIFIABLE when now cannot be normalized', () => {
    const result = classifyCensusFreshness({
      measuredAt: T0,
      now: 'garbage',
    });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.exitCode).toBe(EXIT_UNVERIFIABLE);
  });

  it('reports UNVERIFIABLE when measured_at is later than now, never FRESH', () => {
    const future = T0 + MS_PER_DAY;
    const result = classifyCensusFreshness({ measuredAt: future, now: T0 });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.exitCode).toBe(EXIT_UNVERIFIABLE);
  });

  it('does not treat two unreadable timestamps as matching each other', () => {
    const result = classifyCensusFreshness({
      measuredAt: null,
      now: 'also-garbage',
    });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.verdict).not.toBe(VERDICT_FRESH);
  });
});

describe('the negative control this file names by construction', () => {
  it('rejects a fabricated, decades-old measured_at as FRESH or DUE', () => {
    const result = classifyCensusFreshness({
      measuredAt: FABRICATED_ANCIENT_TIMESTAMP,
      now: SAMPLE_TIMESTAMP_FOR_CONTROLS,
    });
    expect(result.verdict).not.toBe(VERDICT_FRESH);
    expect(result.verdict).not.toBe(VERDICT_DUE);
    expect(result.verdict).toBe(VERDICT_STALE);
  });
});

describe('evaluateControls — both arms run on every invocation, self-contained', () => {
  it('passes when the comparator correctly matches a citation to "now" and rejects an ancient one', () => {
    const controls = evaluateControls();
    expect(controls.passed).toBe(true);
    expect(controls.failures).toEqual([]);
  });

  it('the sample and fabricated fixtures are themselves a real positive/negative pair', () => {
    const sampleMs = Date.parse(SAMPLE_TIMESTAMP_FOR_CONTROLS);
    const fabricatedMs = Date.parse(FABRICATED_ANCIENT_TIMESTAMP);
    const ageDays = (sampleMs - fabricatedMs) / MS_PER_DAY;
    expect(ageDays).toBeGreaterThan(REFLOG_EXPIRY_DAYS);
  });
});

describe('formatting a result for a report', () => {
  it('labels a fresh result FRESH and omits the re-measure instruction', () => {
    const rendered = formatResult(
      classifyCensusFreshness({ measuredAt: T0, now: T0 }),
      { worktrees: 24, trueCount: 18, falseCount: 6, accused: 0 },
    );
    expect(rendered).toContain('FRESH');
    expect(rendered).toContain('worktrees=24');
    expect(rendered).toContain('true=18');
    expect(rendered).toContain('false=6');
    expect(rendered).toContain('accused=0');
    expect(rendered).not.toContain('Re-run');
  });

  it('labels a due result DUE and includes the re-measure instruction', () => {
    const now = T0 + (RECOMMENDED_REMEASUREMENT_DAYS + 1) * MS_PER_DAY;
    const rendered = formatResult(
      classifyCensusFreshness({ measuredAt: T0, now }),
    );
    expect(rendered).toContain('DUE');
    expect(rendered).toContain('Re-run');
    expect(rendered).toContain('census:ownership-evidence');
  });

  it('labels a stale result STALE and includes the re-measure instruction', () => {
    const now = T0 + (REFLOG_EXPIRY_DAYS + 1) * MS_PER_DAY;
    const rendered = formatResult(
      classifyCensusFreshness({ measuredAt: T0, now }),
    );
    expect(rendered).toContain('STALE');
    expect(rendered).toContain('Re-run');
  });

  it('labels an unverifiable result UNVERIFIABLE', () => {
    const rendered = formatResult(
      classifyCensusFreshness({ measuredAt: null, now: T0 }),
    );
    expect(rendered).toContain('UNVERIFIABLE');
  });
});

describe('parsing ```census-measured citations out of a report', () => {
  it('parses a well-formed citation block', () => {
    const text = [
      'Some report text.',
      '',
      '```census-measured',
      'worktrees: 24',
      'true: 18',
      'false: 6',
      'accused: 0',
      'measured_at: 2026-08-04T00:00:00Z',
      '```',
      '',
      'More text.',
    ].join('\n');
    const citations = parseCensusCitations(text);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      worktrees: 24,
      trueCount: 18,
      falseCount: 6,
      accused: 0,
      measuredAt: '2026-08-04T00:00:00Z',
      incomplete: false,
      missing: [],
    });
  });

  it('parses multiple citation blocks in one document', () => {
    const text = [
      '```census-measured',
      'worktrees: 24',
      'true: 18',
      'false: 6',
      'accused: 0',
      'measured_at: 2026-08-04T00:00:00Z',
      '```',
      'body text between',
      '```census-measured',
      'worktrees: 20',
      'true: 14',
      'false: 6',
      'accused: 0',
      'measured_at: 2026-08-08T00:00:00Z',
      '```',
    ].join('\n');
    const citations = parseCensusCitations(text);
    expect(citations).toHaveLength(2);
    expect(citations[0]?.worktrees).toBe(24);
    expect(citations[1]?.worktrees).toBe(20);
  });

  it('reports a block missing a required field as incomplete rather than dropping it', () => {
    const text = ['```census-measured', 'worktrees: 24', '```'].join('\n');
    const citations = parseCensusCitations(text);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.incomplete).toBe(true);
    expect(citations[0]?.missing).toEqual(
      expect.arrayContaining(['true', 'false', 'accused', 'measured_at']),
    );
  });

  it('returns an empty array when no citation block is present', () => {
    expect(parseCensusCitations('no fenced block here')).toEqual([]);
  });

  it('returns an empty array for non-string input rather than throwing', () => {
    expect(parseCensusCitations(undefined)).toEqual([]);
    expect(parseCensusCitations(null)).toEqual([]);
  });

  it('does not match a fenced block with a different info string', () => {
    const text = ['```measured', 'repo: x/y', 'number: 1', '```'].join('\n');
    expect(parseCensusCitations(text)).toEqual([]);
  });
});

describe('main — end-to-end verdicts driven through the CLI surface', () => {
  it('exits EXIT_OK and prints FRESH for a citation dated "now"', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await main(['--measured-at', new Date().toISOString()], {});
    } finally {
      console.log = originalLog;
    }
    expect(process.exitCode).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('FRESH');
    process.exitCode = 0;
  });

  it('exits EXIT_STALE for a citation older than the reflog expiry window, using --now', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      const now = new Date(
        T0 + (REFLOG_EXPIRY_DAYS + 1) * MS_PER_DAY,
      ).toISOString();
      await main(
        ['--measured-at', new Date(T0).toISOString(), '--now', now],
        {},
      );
    } finally {
      console.error = originalError;
    }
    expect(process.exitCode).toBe(EXIT_STALE);
    expect(errors.join('\n')).toContain('STALE');
    process.exitCode = 0;
  });

  it('exits EXIT_UNVERIFIABLE when neither --file nor --measured-at is given', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await main([], {});
    } finally {
      console.error = originalError;
    }
    expect(process.exitCode).toBe(EXIT_UNVERIFIABLE);
    expect(errors.join('\n')).toContain('usage:');
    process.exitCode = 0;
  });

  it('reads citations from --file and reports FRESH for a "now"-dated one', async () => {
    const measuredAt = new Date().toISOString();
    const text = [
      '```census-measured',
      'worktrees: 24',
      'true: 18',
      'false: 6',
      'accused: 0',
      `measured_at: ${measuredAt}`,
      '```',
    ].join('\n');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await main(['--file', 'fake-report.md'], {
        readFile: () => text,
      });
    } finally {
      console.log = originalLog;
    }
    expect(process.exitCode).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('FRESH');
    process.exitCode = 0;
  });

  it('reports EXIT_UNVERIFIABLE for a --file citation missing required fields', async () => {
    const text = ['```census-measured', 'worktrees: 24', '```'].join('\n');
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await main(['--file', 'fake-report.md'], {
        readFile: () => text,
      });
    } finally {
      console.error = originalError;
    }
    expect(process.exitCode).toBe(EXIT_UNVERIFIABLE);
    expect(errors.join('\n')).toContain('missing required field');
    process.exitCode = 0;
  });

  it('exits EXIT_UNVERIFIABLE when --file names a document with no citation block', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await main(['--file', 'fake-report.md'], {
        readFile: () => 'nothing to see here',
      });
    } finally {
      console.error = originalError;
    }
    expect(process.exitCode).toBe(EXIT_UNVERIFIABLE);
    process.exitCode = 0;
  });
});
