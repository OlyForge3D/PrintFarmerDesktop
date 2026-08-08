import { describe, expect, it } from 'vitest';

import {
  EXIT_OK,
  EXIT_STALE,
  EXIT_UNVERIFIABLE,
  FABRICATED_LATER_TIMESTAMP,
  SAMPLE_TIMESTAMP_FOR_CONTROLS,
  VERDICT_FRESH,
  VERDICT_STALE,
  VERDICT_UNVERIFIABLE,
  classifyMeasurementFreshness,
  evaluateControls,
  fetchLiveUpdatedAt,
  formatResult,
  main,
  normalizeTimestamp,
  parseMeasurementCitations,
} from '../scripts/check-dated-measurement.mjs';

const T1 = '2026-08-05T07:13:31Z';
const T2 = '2026-08-05T07:14:16Z'; // 45s after T1 -- #462 incident 2

describe('normalizing a timestamp', () => {
  it('accepts a Z-suffixed ISO-8601 string', () => {
    expect(normalizeTimestamp(T1)).toBe(Date.parse(T1));
  });

  it('treats a Z suffix and an equivalent +00:00 offset as the SAME instant (#462 route 5: comparison frame)', () => {
    expect(normalizeTimestamp('2026-08-05T07:13:31Z')).toBe(
      normalizeTimestamp('2026-08-05T07:13:31.000+00:00'),
    );
  });

  it('rejects a non-string', () => {
    expect(normalizeTimestamp(undefined)).toBeNull();
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp(12345)).toBeNull();
  });

  it('rejects an empty or unparseable string', () => {
    expect(normalizeTimestamp('')).toBeNull();
    expect(normalizeTimestamp('   ')).toBeNull();
    expect(normalizeTimestamp('not-a-timestamp')).toBeNull();
  });
});

describe('classifying measurement freshness — this IS #462', () => {
  it('reports FRESH when the cited updated_at matches the live one', () => {
    const result = classifyMeasurementFreshness({
      citedUpdatedAt: T1,
      liveUpdatedAt: T1,
    });
    expect(result.verdict).toBe(VERDICT_FRESH);
    expect(result.exitCode).toBe(EXIT_OK);
  });

  // The exact incident-2 shape: labels fixed at T1, claim sent at T2 citing
  // (had it been dated at all) T1 as current. A live read now returning T2
  // must be reported STALE, never FRESH.
  it('reports STALE when the live updated_at is later than the cited one', () => {
    const result = classifyMeasurementFreshness({
      citedUpdatedAt: T1,
      liveUpdatedAt: T2,
    });
    expect(result.verdict).toBe(VERDICT_STALE);
    expect(result.exitCode).toBe(EXIT_STALE);
    expect(result.reason).toContain(new Date(T2).toISOString());
    expect(result.reason).toContain(new Date(T1).toISOString());
  });

  it('reports UNVERIFIABLE when the cited updated_at is later than the live one', () => {
    const result = classifyMeasurementFreshness({
      citedUpdatedAt: T2,
      liveUpdatedAt: T1,
    });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.exitCode).toBe(EXIT_UNVERIFIABLE);
  });

  it('reports UNVERIFIABLE when the cited updated_at cannot be normalized', () => {
    const result = classifyMeasurementFreshness({
      citedUpdatedAt: null,
      liveUpdatedAt: T1,
    });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.exitCode).toBe(EXIT_UNVERIFIABLE);
  });

  it('reports UNVERIFIABLE when the live updated_at cannot be normalized', () => {
    const result = classifyMeasurementFreshness({
      citedUpdatedAt: T1,
      liveUpdatedAt: 'garbage',
    });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.exitCode).toBe(EXIT_UNVERIFIABLE);
  });

  // Two unusable timestamps must not silently compare equal to each other by
  // both being coerced to the same falsy value.
  it('does not treat two unreadable timestamps as matching each other', () => {
    const result = classifyMeasurementFreshness({
      citedUpdatedAt: null,
      liveUpdatedAt: undefined,
    });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.verdict).not.toBe(VERDICT_FRESH);
  });
});

describe('the negative control #462 asks for by name (repair 8)', () => {
  it('rejects a fabricated, known-later live timestamp as FRESH', () => {
    const result = classifyMeasurementFreshness({
      citedUpdatedAt: T1,
      liveUpdatedAt: FABRICATED_LATER_TIMESTAMP,
    });
    expect(result.verdict).not.toBe(VERDICT_FRESH);
    expect(result.verdict).toBe(VERDICT_STALE);
  });
});

describe('evaluateControls — both arms run on every invocation, self-contained', () => {
  it('passes when the comparator correctly matches a citation to itself and rejects a fabricated later one', () => {
    const controls = evaluateControls();
    expect(controls.passed).toBe(true);
    expect(controls.failures).toEqual([]);
  });

  it('the sample and fabricated fixtures are themselves a real positive/negative pair', () => {
    const sampleMs = normalizeTimestamp(SAMPLE_TIMESTAMP_FOR_CONTROLS);
    const fabricatedMs = normalizeTimestamp(FABRICATED_LATER_TIMESTAMP);
    expect(sampleMs).not.toBeNull();
    expect(fabricatedMs).not.toBeNull();
    expect(fabricatedMs as number).toBeGreaterThan(sampleMs as number);
  });
});

describe('formatting a result for a report', () => {
  it('labels a fresh result FRESH and omits the re-read instruction', () => {
    const rendered = formatResult(
      classifyMeasurementFreshness({ citedUpdatedAt: T1, liveUpdatedAt: T1 }),
      { repo: 'OlyForge3D/PrintFarmerDesktop', number: 462 },
    );
    expect(rendered).toContain('FRESH');
    expect(rendered).not.toContain('Re-read');
  });

  it('labels a stale result STALE and includes the re-read instruction naming the object', () => {
    const rendered = formatResult(
      classifyMeasurementFreshness({ citedUpdatedAt: T1, liveUpdatedAt: T2 }),
      { repo: 'OlyForge3D/PrintFarmerDesktop', number: 459 },
    );
    expect(rendered).toContain('STALE');
    expect(rendered).toContain('#459');
    expect(rendered).toContain('updated_at');
  });

  it('labels an unverifiable result UNVERIFIABLE', () => {
    const rendered = formatResult(
      classifyMeasurementFreshness({ citedUpdatedAt: null, liveUpdatedAt: T1 }),
      { repo: 'OlyForge3D/PrintFarmerDesktop', number: 462 },
    );
    expect(rendered).toContain('UNVERIFIABLE');
  });
});

describe('parsing ```measured citations out of a report', () => {
  it('parses a well-formed citation block', () => {
    const text = [
      'Some report text.',
      '',
      '```measured',
      'repo: OlyForge3D/PrintFarmerDesktop',
      'number: 462',
      `updated_at: ${T1}`,
      '```',
      '',
      'More text.',
    ].join('\n');
    const citations = parseMeasurementCitations(text);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      repo: 'OlyForge3D/PrintFarmerDesktop',
      number: 462,
      updatedAt: T1,
      incomplete: false,
      missing: [],
    });
  });

  it('parses multiple citation blocks in one document', () => {
    const text = [
      '```measured',
      'repo: OlyForge3D/PrintFarmerDesktop',
      'number: 459',
      `updated_at: ${T1}`,
      '```',
      'body text between',
      '```measured',
      'repo: OlyForge3D/PrintFarmerDesktop',
      'number: 462',
      `updated_at: ${T2}`,
      '```',
    ].join('\n');
    const citations = parseMeasurementCitations(text);
    expect(citations).toHaveLength(2);
    expect(citations[0]?.number).toBe(459);
    expect(citations[1]?.number).toBe(462);
  });

  it('reports a block missing a required field as incomplete rather than dropping it', () => {
    const text = ['```measured', 'repo: OlyForge3D/PrintFarmerDesktop', '```'].join(
      '\n',
    );
    const citations = parseMeasurementCitations(text);
    expect(citations).toHaveLength(1);
    expect(citations[0]?.incomplete).toBe(true);
    expect(citations[0]?.missing).toEqual(
      expect.arrayContaining(['number', 'updated_at']),
    );
  });

  it('returns an empty array when no citation block is present', () => {
    expect(parseMeasurementCitations('no fenced block here')).toEqual([]);
  });

  it('returns an empty array for non-string input rather than throwing', () => {
    expect(parseMeasurementCitations(undefined)).toEqual([]);
    expect(parseMeasurementCitations(null)).toEqual([]);
  });

  it('does not match a fenced block with a different info string', () => {
    const text = ['```closes', '#464', '```'].join('\n');
    expect(parseMeasurementCitations(text)).toEqual([]);
  });
});

describe('fetchLiveUpdatedAt — computed where the data lives (#462 repair 2)', () => {
  it('invokes gh api against the issues endpoint with a server-side --jq filter', () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      return `${T1}\n`;
    };
    const result = fetchLiveUpdatedAt({
      repo: 'OlyForge3D/PrintFarmerDesktop',
      number: 462,
      run,
    });
    expect(result).toBe(T1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'api',
      'repos/OlyForge3D/PrintFarmerDesktop/issues/462',
      '--jq',
      '.updated_at',
    ]);
  });
});

describe('main — end-to-end verdicts driven through the CLI surface', () => {
  it('exits EXIT_OK and prints FRESH for a matching direct citation', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await main(
        [
          '--repo',
          'OlyForge3D/PrintFarmerDesktop',
          '--number',
          '462',
          '--cited-updated-at',
          T1,
        ],
        { fetchLive: () => Promise.resolve(T1) },
      );
    } finally {
      console.log = originalLog;
    }
    expect(process.exitCode).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('FRESH');
    process.exitCode = 0;
  });

  it('exits EXIT_STALE for a stale direct citation (positive control on the tool itself)', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await main(
        [
          '--repo',
          'OlyForge3D/PrintFarmerDesktop',
          '--number',
          '459',
          '--cited-updated-at',
          T1,
        ],
        { fetchLive: () => Promise.resolve(T2) },
      );
    } finally {
      console.error = originalError;
    }
    expect(process.exitCode).toBe(EXIT_STALE);
    expect(errors.join('\n')).toContain('STALE');
    process.exitCode = 0;
  });

  it('exits EXIT_UNVERIFIABLE when neither --file nor a full direct citation is given', async () => {
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

  it('reads citations from --file and reports a mix of verdicts', async () => {
    const text = [
      '```measured',
      'repo: OlyForge3D/PrintFarmerDesktop',
      'number: 459',
      `updated_at: ${T1}`,
      '```',
    ].join('\n');
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      await main(['--file', 'fake-report.md'], {
        readFile: () => text,
        fetchLive: () => Promise.resolve(T1),
      });
    } finally {
      console.log = originalLog;
    }
    expect(process.exitCode).toBe(EXIT_OK);
    expect(logs.join('\n')).toContain('FRESH');
    process.exitCode = 0;
  });
});
