import { describe, expect, it } from 'vitest';

import {
  EXIT_OK,
  EXIT_SILENT,
  EXIT_UNVERIFIABLE,
  VERDICT_DISPATCHED,
  VERDICT_SILENT,
  VERDICT_UNVERIFIABLE,
  classifyDispatch,
  evaluateControls,
  formatResult,
  normalizeSha,
  parseArgs,
} from '../scripts/check-closed-head-dispatch.mjs';

const SHA = '3e8d1c30c9c0669d1c286f5009681dc106ef00ae';

describe('normalizing a sha', () => {
  it('accepts a 40-hex lowercase string', () => {
    expect(normalizeSha(SHA)).toBe(SHA);
  });

  it('lowercases a differently-cased sha', () => {
    expect(normalizeSha(SHA.toUpperCase())).toBe(SHA);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeSha(`  ${SHA}\n`)).toBe(SHA);
  });

  it('rejects an abbreviated sha', () => {
    expect(normalizeSha(SHA.slice(0, 8))).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(normalizeSha(undefined)).toBeNull();
    expect(normalizeSha(null)).toBeNull();
    expect(normalizeSha(12345)).toBeNull();
  });
});

describe('classifying dispatch — this IS #380', () => {
  // The exact #281 finding: a closed head with total_count: 0.
  it('reports SILENT when total_count is zero', () => {
    const result = classifyDispatch({
      headSha: SHA,
      totalCount: 0,
      prNumber: 281,
    });
    expect(result.verdict).toBe(VERDICT_SILENT);
    expect(result.exitCode).toBe(EXIT_SILENT);
    expect(result.reason).toContain('#281');
    expect(result.reason).toContain(SHA.slice(0, 8));
    expect(result.reason).toContain('#380');
  });

  it('reports DISPATCHED when total_count is positive', () => {
    const result = classifyDispatch({ headSha: SHA, totalCount: 5 });
    expect(result.verdict).toBe(VERDICT_DISPATCHED);
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.reason).toContain('5 workflow run');
  });

  it('reports UNVERIFIABLE when the head sha cannot be normalized', () => {
    const result = classifyDispatch({ headSha: 'not-a-sha', totalCount: 0 });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
    expect(result.exitCode).toBe(EXIT_UNVERIFIABLE);
  });

  it('reports UNVERIFIABLE when the head sha is missing', () => {
    const result = classifyDispatch({ headSha: null, totalCount: 0 });
    expect(result.verdict).toBe(VERDICT_UNVERIFIABLE);
  });

  // The property the header comment insists on: a broken/failed query must
  // never be coerced into a real zero and read as SILENT.
  it('reports UNVERIFIABLE rather than SILENT when total_count is not a usable integer', () => {
    expect(
      classifyDispatch({ headSha: SHA, totalCount: Number.NaN }).verdict,
    ).toBe(VERDICT_UNVERIFIABLE);
    expect(classifyDispatch({ headSha: SHA, totalCount: -1 }).verdict).toBe(
      VERDICT_UNVERIFIABLE,
    );
    expect(classifyDispatch({ headSha: SHA, totalCount: '0' }).verdict).toBe(
      VERDICT_UNVERIFIABLE,
    );
    expect(
      classifyDispatch({ headSha: SHA, totalCount: undefined }).verdict,
    ).toBe(VERDICT_UNVERIFIABLE);
  });

  it('omits the pull request number when none is given', () => {
    const result = classifyDispatch({ headSha: SHA, totalCount: 0 });
    expect(result.reason).not.toContain('#undefined');
    expect(result.reason.startsWith('closed at')).toBe(true);
  });
});

describe('evaluateControls — both arms run on every invocation', () => {
  it('passes for the real comparator', () => {
    const controls = evaluateControls();
    expect(controls.passed).toBe(true);
    expect(controls.failures).toEqual([]);
  });
});

describe('formatting a result for a report', () => {
  it('labels a silent result SILENT', () => {
    const rendered = formatResult(
      classifyDispatch({ headSha: SHA, totalCount: 0, prNumber: 281 }),
    );
    expect(rendered).toContain('SILENT');
    expect(rendered).toContain('#281');
  });

  it('labels a dispatched result DISPATCHED', () => {
    const rendered = formatResult(
      classifyDispatch({ headSha: SHA, totalCount: 3 }),
    );
    expect(rendered).toContain('DISPATCHED');
  });

  it('labels an unverifiable result UNVERIFIABLE', () => {
    const rendered = formatResult(
      classifyDispatch({ headSha: null, totalCount: 0 }),
    );
    expect(rendered).toContain('UNVERIFIABLE');
  });
});

describe('parseArgs', () => {
  it('parses --pr, --sha and --repo', () => {
    expect(parseArgs(['--pr', '281', '--sha', SHA, '--repo', 'o/r'])).toEqual({
      pr: 281,
      sha: SHA,
      repo: 'o/r',
    });
  });

  it('rejects an unknown argument', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});
