import { describe, expect, it } from 'vitest';

import {
  ARMS,
  EXIT_CHANGED,
  EXIT_HOLDS,
  EXIT_UNDETERMINED,
  ROLE_DEFECT,
  ROLE_SUBSTITUTE,
  STATUS_CHANGED,
  STATUS_HOLDS,
  STATUS_UNDETERMINED,
  USAGE,
  formatReport,
  judgeArm,
  main,
  overallVerdict,
  readArm,
  readPrecondition,
  readSuccessfulOutput,
} from '../scripts/probe-array-wrapper.mjs';
import {
  VERDICT_BLIND,
  VERDICT_SOUND,
  VERDICT_UNUSABLE,
  VERDICT_VACUOUS,
  classifyDiscrimination,
} from '../scripts/instrument-probe.mjs';

/** Throws rather than returning undefined: a silent undefined here would be
 *  #367's own defect committed inside #367's test file. */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`no element at ${index} of ${values.length}`);
  }
  return value;
}

const armOf = (id: string) => {
  const found = ARMS.find((a) => a.id === id);
  if (!found) throw new Error(`no arm ${id}`);
  return found;
};

const classification = (verdict: string) => ({
  verdict,
  findings: [],
  readings: [],
});

const satisfiedPrecondition = {
  id: 'P1-interpreter-answers',
  satisfied: true,
  detail: '',
};

describe('the arm table', () => {
  it('is not vacuous: it carries both roles, because a table of one role cannot fail in both directions', () => {
    const defects = ARMS.filter((a) => a.role === ROLE_DEFECT);
    const substitutes = ARMS.filter((a) => a.role === ROLE_SUBSTITUTE);
    expect(defects.length).toBeGreaterThan(0);
    expect(substitutes.length).toBeGreaterThan(0);
  });

  it('gives every defect an expectation of BLIND and every substitute an expectation of SOUND', () => {
    for (const arm of ARMS) {
      expect(arm.expect).toBe(
        arm.role === ROLE_DEFECT ? VERDICT_BLIND : VERDICT_SOUND,
      );
    }
  });

  it('cites #367 instance 4 or its remedy, so a failure names the sentence to edit', () => {
    for (const arm of ARMS) {
      expect(arm.cites).toMatch(/#367/);
      expect(arm.claim.length).toBeGreaterThan(0);
      expect(arm.expression.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids, because readArm dispatches on the expression it carries', () => {
    expect(new Set(ARMS.map((a) => a.id)).size).toBe(ARMS.length);
  });
});

describe('judgeArm', () => {
  it('reports HOLDS when the observed verdict is the one #367 asserts', () => {
    const judged = judgeArm(
      armOf('array-wrap-null-count'),
      classification(VERDICT_BLIND),
    );
    expect(judged.status).toBe(STATUS_HOLDS);
    expect(judged.direction).toBe('');
  });

  it('A DEFECT THAT TURNS SOUND IS STILL A FAILURE, because the issue now overstates it', () => {
    const judged = judgeArm(
      armOf('array-wrap-null-count'),
      classification(VERDICT_SOUND),
    );
    expect(judged.status).toBe(STATUS_CHANGED);
    expect(judged.direction).toContain('historical');
  });

  it('A SUBSTITUTE THAT TURNS BLIND IS THE DANGEROUS DIRECTION, and says so in different words', () => {
    const judged = judgeArm(
      armOf('measure-object-count'),
      classification(VERDICT_BLIND),
    );
    expect(judged.status).toBe(STATUS_CHANGED);
    expect(judged.direction).toContain('unguarded');
  });

  it('THE TWO DIRECTIONS DEMAND OPPOSITE EDITS, so they must not render identically', () => {
    const defect = judgeArm(
      armOf('array-wrap-null-count'),
      classification(VERDICT_SOUND),
    );
    const substitute = judgeArm(
      armOf('measure-object-count'),
      classification(VERDICT_BLIND),
    );
    expect(defect.status).toBe(substitute.status);
    expect(defect.direction).not.toBe(substitute.direction);
  });

  it('does NOT report UNUSABLE as a change, because it says nothing about PowerShell', () => {
    const judged = judgeArm(
      armOf('array-wrap-null-count'),
      classification(VERDICT_UNUSABLE),
    );
    expect(judged.status).toBe(STATUS_UNDETERMINED);
    expect(judged.status).not.toBe(STATUS_CHANGED);
  });

  it('does NOT report VACUOUS as a change: the case pair failed, not the claim', () => {
    const judged = judgeArm(
      armOf('measure-object-count'),
      classification(VERDICT_VACUOUS),
    );
    expect(judged.status).toBe(STATUS_UNDETERMINED);
  });

  it('VACUOUS OUTRANKS BLIND when both cases return the same non-answer', () => {
    const judged = judgeArm(armOf('array-wrap-null-count'), {
      ...classification(VERDICT_BLIND),
      vacuous: true,
    });
    expect(judged.status).toBe(STATUS_UNDETERMINED);
    expect(judged.status).not.toBe(STATUS_HOLDS);
    expect(judged.direction).toContain('vacuous');
  });

  it('carries the readings through, so the report can show the numbers rather than assert them', () => {
    const judged = judgeArm(armOf('array-wrap-null-count'), {
      verdict: VERDICT_BLIND,
      findings: ['BLIND: every case returned "1"'],
      readings: [
        { label: '$value is $null (absent)', reading: '1' },
        { label: '$value holds one item (present)', reading: '1' },
      ],
    });
    expect(at(judged.readings, 0).reading).toBe('1');
    expect(at(judged.findings, 0)).toContain('BLIND');
  });

  it('refuses to judge without an arm or a classification, rather than inventing a status', () => {
    expect(() => judgeArm(undefined, classification(VERDICT_SOUND))).toThrow(
      /requires an arm/,
    );
    expect(() => judgeArm(armOf('array-wrap-null-count'), undefined)).toThrow(
      /requires a classification/,
    );
  });
});

describe('readSuccessfulOutput', () => {
  it('refuses stdout from a failed pwsh invocation instead of treating emptiness as evidence', () => {
    expect(
      readSuccessfulOutput({ status: 1, stdout: '', stderr: 'boom' }),
    ).toEqual({
      reading: null,
      error: 'pwsh exited 1: boom',
    });
  });

  it('reads output only after pwsh succeeds', () => {
    const result = { status: 0, stdout: '1\n', stderr: '' };
    expect(readSuccessfulOutput(result)).toEqual({ reading: '1' });
  });
});

describe('overallVerdict', () => {
  it('A FAILED PRECONDITION OUTRANKS A FULL SET OF HOLDING ARMS', () => {
    const verdict = overallVerdict(
      { id: 'P1-interpreter-answers', satisfied: false, detail: 'no pwsh' },
      [{ status: STATUS_HOLDS }, { status: STATUS_HOLDS }],
    );
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
    expect(verdict.summary).toContain('the experiment did not run');
    expect(verdict.summary).toContain('no pwsh');
  });

  it('REJECTS a malformed precondition record before judging arms', () => {
    expect(
      overallVerdict(undefined as never, [{ status: STATUS_HOLDS }]).exitCode,
    ).toBe(EXIT_UNDETERMINED);
    expect(
      overallVerdict({ satisfied: 'yes' }, [{ status: STATUS_HOLDS }]).exitCode,
    ).toBe(EXIT_UNDETERMINED);
  });

  it('treats an empty arm list as undetermined, never as agreement', () => {
    const verdict = overallVerdict(satisfiedPrecondition, []);
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
    expect(verdict.exitCode).not.toBe(EXIT_HOLDS);
  });

  it('reports 2 when any arm produced no reading, even though the rest hold', () => {
    const verdict = overallVerdict(satisfiedPrecondition, [
      { status: STATUS_HOLDS },
      { status: STATUS_HOLDS },
      { status: STATUS_UNDETERMINED },
    ]);
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
  });

  it('DISCRIMINATES: a satisfied precondition does not turn a changed arm into a pass', () => {
    const verdict = overallVerdict(satisfiedPrecondition, [
      { status: STATUS_HOLDS },
      { status: STATUS_HOLDS },
      { status: STATUS_CHANGED },
    ]);
    expect(verdict.exitCode).toBe(EXIT_CHANGED);
    expect(verdict.summary).toContain('1 of 3');
  });

  it('reports 0 only when every arm holds', () => {
    const verdict = overallVerdict(satisfiedPrecondition, [
      { status: STATUS_HOLDS },
      { status: STATUS_HOLDS },
      { status: STATUS_HOLDS },
    ]);
    expect(verdict.exitCode).toBe(EXIT_HOLDS);
    expect(verdict.summary).toContain('fabricates a datum from $null');
  });

  it('ranks undetermined above changed, so a half-run experiment is never published as a finding', () => {
    const verdict = overallVerdict(satisfiedPrecondition, [
      { status: STATUS_CHANGED },
      { status: STATUS_UNDETERMINED },
    ]);
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
  });
});

describe('formatReport', () => {
  it('marks a failed precondition and prints it above the arms', () => {
    const text = formatReport(
      { id: 'P1-interpreter-answers', satisfied: false, detail: 'why' },
      [],
      { exitCode: EXIT_UNDETERMINED, summary: 'nope' },
    );
    expect(text).toContain('FAIL P1-interpreter-answers');
    expect(text.indexOf('PRECONDITION')).toBeLessThan(text.indexOf('ARMS'));
  });

  it('prints the readings, so a reader can re-derive the verdict instead of trusting it', () => {
    const judged = judgeArm(armOf('array-wrap-null-count'), {
      verdict: VERDICT_BLIND,
      findings: [],
      readings: [
        { label: '$value is $null (absent)', reading: '1' },
        { label: '$value holds one item (present)', reading: '1' },
      ],
    });
    const text = formatReport(satisfiedPrecondition, [judged], {
      exitCode: EXIT_HOLDS,
      summary: 'ok',
    });
    expect(text).toContain('$value is $null (absent): "1"');
    expect(text).toContain('$value holds one item (present): "1"');
  });

  it('prints the direction for a changed arm', () => {
    const judged = judgeArm(
      armOf('measure-object-count'),
      classification(VERDICT_BLIND),
    );
    const text = formatReport(satisfiedPrecondition, [judged], {
      exitCode: EXIT_CHANGED,
      summary: 'changed',
    });
    expect(text).toContain('=> the substitute no longer discriminates');
  });

  it('ends with the exit code, because that is what a caller acts on', () => {
    const text = formatReport(satisfiedPrecondition, [], {
      exitCode: EXIT_CHANGED,
      summary: 'changed',
    });
    expect(text.trimEnd().endsWith('exit 1: changed')).toBe(true);
  });
});

describe('#367 instance 4: the array-wrapper idiom fabricates a datum, against real pwsh', () => {
  it('the precondition passes on this machine', () => {
    const precondition = readPrecondition();
    expect(precondition.satisfied).toBe(true);
  });

  it('DEFECT: `@($value).Count` reads the same for absence and for one item', () => {
    const cases = readArm('@($value).Count');
    expect(at(cases, 0).reading).toBe('1');
    expect(at(cases, 1).reading).toBe('1');
    const classified = classifyDiscrimination(cases, 'stdout');
    expect(classified.verdict).toBe(VERDICT_BLIND);
  });

  it('POSITIVE CONTROL: `($value | Measure-Object).Count` separates the same two cases', () => {
    const cases = readArm('($value | Measure-Object).Count');
    expect(at(cases, 0).reading).toBe('0');
    expect(at(cases, 1).reading).toBe('1');
    const classified = classifyDiscrimination(cases, 'stdout');
    expect(classified.verdict).toBe(VERDICT_SOUND);
  });

  it('POSITIVE CONTROL: filtering the null before wrapping also separates the two cases', () => {
    const cases = readArm('@($value | Where-Object { $null -ne $_ }).Count');
    expect(at(cases, 0).reading).toBe('0');
    expect(at(cases, 1).reading).toBe('1');
    const classified = classifyDiscrimination(cases, 'stdout');
    expect(classified.verdict).toBe(VERDICT_SOUND);
  });

  it('the naive fix — `@().Count` on a literal empty array — is 0, and is a different case entirely from `@($null)`', () => {
    const cases = readArm('@().Count');
    // Both invocations discard `$value` and evaluate a literal empty array,
    // so absence and presence read identically here too -- but at 0, not 1.
    // This is #367's point made concrete: the wrapper is sound for a
    // genuinely empty COLLECTION and unsound for a NULL SCALAR, and nothing
    // about the syntax distinguishes which one a caller is holding.
    expect(at(cases, 0).reading).toBe('0');
    expect(at(cases, 1).reading).toBe('0');
  });
});

describe('the probe end to end', () => {
  it('EXITS 0 AGAINST THIS MACHINE`S PWSH: the defect and every substitute still hold', () => {
    expect(main()).toBe(EXIT_HOLDS);
  });

  it('documents all three exit codes in its usage, since a caller branches on them', () => {
    for (const code of ['0', '1', '2']) {
      expect(USAGE).toContain(`  ${code}  `);
    }
  });

  it('returns exit 2 when the precondition cannot be read, never exit 1 as if a claim changed', () => {
    expect(
      main({
        readPrecondition: () => {
          throw new Error('simulated precondition failure');
        },
      }),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('INJECTED UNSATISFIED PRECONDITION: returns exit 2 without running any arm', () => {
    let armCalls = 0;
    expect(
      main({
        readPrecondition: () => ({
          id: 'P1-interpreter-answers',
          satisfied: false,
          detail: 'pwsh not found',
        }),
        readArm: () => {
          armCalls += 1;
          return [];
        },
      }),
    ).toBe(EXIT_UNDETERMINED);
    expect(armCalls).toBe(0);
  });

  it('returns exit 2 and reports a malformed precondition record', () => {
    expect(
      main({
        readPrecondition: () => ({ not: 'a precondition' }) as never,
      }),
    ).toBe(EXIT_UNDETERMINED);
  });

  it('THE EXACT FABRICATED REPORT: an arm that never ran must not be counted among the arms that changed', () => {
    // If readArm throws for every arm, every arm becomes UNDETERMINED, not
    // CHANGED — a broken harness must never be reported as a finding.
    const verdict = main({
      readPrecondition: () => satisfiedPrecondition,
      readArm: () => {
        throw new Error('simulated arm failure');
      },
    });
    expect(verdict).toBe(EXIT_UNDETERMINED);
    expect(verdict).not.toBe(EXIT_CHANGED);
  });
});
