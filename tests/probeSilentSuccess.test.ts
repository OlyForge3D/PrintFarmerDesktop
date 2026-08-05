import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  ARMS,
  ABSENT_PATH,
  ABSENT_REF,
  COMMITTED_BYTES,
  EXIT_CHANGED,
  EXIT_HOLDS,
  EXIT_UNDETERMINED,
  FABRICATED_OBJECT,
  FIXTURE_BRANCH,
  MUTATED_BYTES,
  MUTATED_FILE,
  ROLE_DEFECT,
  ROLE_SUBSTITUTE,
  STABLE_FILE,
  STATUS_CHANGED,
  STATUS_HOLDS,
  STATUS_UNDETERMINED,
  USAGE,
  buildFixture,
  formatReport,
  judgeArm,
  judgeFixture,
  judgeMutationReached,
  main,
  overallVerdict,
  readArm,
  readPreconditions,
  setWorkingTree,
} from '../scripts/probe-silent-success.mjs';
import {
  VERDICT_BLIND,
  VERDICT_SOUND,
  VERDICT_UNUSABLE,
  VERDICT_VACUOUS,
} from '../scripts/instrument-probe.mjs';

/** Throws rather than returning undefined: a silent undefined here would be the
 *  #367 defect committed inside #367's own test file. */
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

const holding = (n: number) =>
  Array.from({ length: n }, () => ({ status: STATUS_HOLDS }));

const satisfied = [
  { id: 'P1-fixture-is-a-repository', satisfied: true, detail: '' },
  { id: 'P2-mutation-reaches-the-disk', satisfied: true, detail: '' },
];

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

  it('cites the sentence in #367 each arm pins, so a failure names the text to edit', () => {
    for (const arm of ARMS) {
      expect(arm.cites).toMatch(/#367/);
      expect(arm.claim.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids, because readArm dispatches on them', () => {
    expect(new Set(ARMS.map((a) => a.id)).size).toBe(ARMS.length);
  });

  it('covers every instance the probe claims to cover', () => {
    const cited = ARMS.map((a) => a.cites).join(' ');
    for (const sentence of ['instance 1', 'instance 2', 'instance 8']) {
      expect(cited).toContain(sentence);
    }
  });
});

describe('judgeArm', () => {
  it('reports HOLDS when the observed verdict is the one #367 asserts', () => {
    const judged = judgeArm(
      armOf('ls-remote-bare'),
      classification(VERDICT_BLIND),
    );
    expect(judged.status).toBe(STATUS_HOLDS);
    expect(judged.direction).toBe('');
  });

  it('A DEFECT THAT TURNS SOUND IS STILL A FAILURE, because the issue now overstates it', () => {
    const judged = judgeArm(
      armOf('diff-pathspec'),
      classification(VERDICT_SOUND),
    );
    expect(judged.status).toBe(STATUS_CHANGED);
    expect(judged.direction).toContain('historical');
  });

  it('A SUBSTITUTE THAT TURNS BLIND IS THE DANGEROUS DIRECTION, and says so in different words', () => {
    const judged = judgeArm(
      armOf('hash-object-working-tree'),
      classification(VERDICT_BLIND),
    );
    expect(judged.status).toBe(STATUS_CHANGED);
    expect(judged.direction).toContain('unguarded');
  });

  it('THE TWO DIRECTIONS DEMAND OPPOSITE EDITS, so they must not render identically', () => {
    const defect = judgeArm(
      armOf('diff-pathspec'),
      classification(VERDICT_SOUND),
    );
    const substitute = judgeArm(
      armOf('hash-object-working-tree'),
      classification(VERDICT_BLIND),
    );
    expect(defect.status).toBe(substitute.status);
    expect(defect.direction).not.toBe(substitute.direction);
  });

  it('does NOT report UNUSABLE as a change, because it says nothing about git', () => {
    const judged = judgeArm(
      armOf('ls-remote-bare'),
      classification(VERDICT_UNUSABLE),
    );
    expect(judged.status).toBe(STATUS_UNDETERMINED);
    expect(judged.status).not.toBe(STATUS_CHANGED);
  });

  it('does NOT report VACUOUS as a change: the case pair failed, not the claim', () => {
    const judged = judgeArm(
      armOf('ls-remote-exit-code'),
      classification(VERDICT_VACUOUS),
    );
    expect(judged.status).toBe(STATUS_UNDETERMINED);
  });

  it('carries the readings through, so the report can show the numbers rather than assert them', () => {
    const judged = judgeArm(armOf('ls-remote-bare'), {
      verdict: VERDICT_BLIND,
      findings: ['BLIND: every case returned "0"'],
      readings: [
        { label: 'present ref', reading: '0' },
        { label: 'absent ref', reading: '0' },
      ],
    });
    expect(at(judged.readings, 1).reading).toBe('0');
    expect(at(judged.findings, 0)).toContain('BLIND');
  });

  it('refuses to judge without an arm or a classification, rather than inventing a status', () => {
    expect(() => judgeArm(undefined, classification(VERDICT_SOUND))).toThrow(
      /requires an arm/,
    );
    expect(() => judgeArm(armOf('ls-remote-bare'), undefined)).toThrow(
      /requires a classification/,
    );
  });
});

describe('overallVerdict', () => {
  it('A FAILED PRECONDITION OUTRANKS A FULL SET OF HOLDING ARMS', () => {
    const verdict = overallVerdict(
      [
        { id: 'P1-fixture-is-a-repository', satisfied: false, detail: '' },
        { id: 'P2-mutation-reaches-the-disk', satisfied: true, detail: '' },
      ],
      holding(7),
    );
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
    expect(verdict.summary).toContain('the experiment did not run');
  });

  it('THE EXACT FABRICATED REPORT: a broken fixture makes every defect arm BLIND, which is what they expect', () => {
    // Three defects HOLD and three substitutes CHANGE — a detailed, plausible,
    // entirely invented result. It must not reach exit 1.
    const judged = [
      { status: STATUS_HOLDS },
      { status: STATUS_HOLDS },
      { status: STATUS_HOLDS },
      { status: STATUS_CHANGED },
      { status: STATUS_CHANGED },
      { status: STATUS_CHANGED },
    ];
    const verdict = overallVerdict(
      [{ id: 'P2-mutation-reaches-the-disk', satisfied: false, detail: '' }],
      judged,
    );
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
    expect(verdict.exitCode).not.toBe(EXIT_CHANGED);
  });

  it('names which precondition failed, so the reader is not sent to look at the arms', () => {
    const verdict = overallVerdict(
      [{ id: 'P2-mutation-reaches-the-disk', satisfied: false, detail: '' }],
      holding(7),
    );
    expect(verdict.summary).toContain('P2-mutation-reaches-the-disk');
  });

  it('treats an empty arm list as undetermined, never as agreement', () => {
    expect(overallVerdict(satisfied, []).exitCode).toBe(EXIT_UNDETERMINED);
    expect(overallVerdict(satisfied, []).exitCode).not.toBe(EXIT_HOLDS);
  });

  it('reports 2 when any arm produced no reading, even though the rest hold', () => {
    const verdict = overallVerdict(satisfied, [
      ...holding(6),
      { status: STATUS_UNDETERMINED },
    ]);
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
  });

  it('DISCRIMINATES: satisfied preconditions do not turn a changed arm into a pass', () => {
    const verdict = overallVerdict(satisfied, [
      ...holding(6),
      { status: STATUS_CHANGED },
    ]);
    expect(verdict.exitCode).toBe(EXIT_CHANGED);
    expect(verdict.summary).toContain('1 of 7');
  });

  it('reports 0 only when every arm holds', () => {
    const verdict = overallVerdict(satisfied, holding(7));
    expect(verdict.exitCode).toBe(EXIT_HOLDS);
    expect(verdict.summary).toContain('still reproduces');
  });

  it('ranks undetermined above changed, so a half-run experiment is never published as a finding', () => {
    const verdict = overallVerdict(satisfied, [
      { status: STATUS_CHANGED },
      { status: STATUS_UNDETERMINED },
    ]);
    expect(verdict.exitCode).toBe(EXIT_UNDETERMINED);
  });
});

describe('formatReport', () => {
  it('marks a failed precondition and prints it above the arms', () => {
    const text = formatReport(
      [{ id: 'P1-fixture-is-a-repository', satisfied: false, detail: 'why' }],
      [],
      { exitCode: EXIT_UNDETERMINED, summary: 'nope' },
    );
    expect(text).toContain('FAIL P1-fixture-is-a-repository');
    expect(text.indexOf('PRECONDITIONS')).toBeLessThan(text.indexOf('ARMS'));
  });

  it('prints the readings, so a reader can re-derive the verdict instead of trusting it', () => {
    const judged = judgeArm(armOf('ls-remote-bare'), {
      verdict: VERDICT_BLIND,
      findings: [],
      readings: [
        { label: 'present ref', reading: '0' },
        { label: 'absent ref', reading: '0' },
      ],
    });
    const text = formatReport(satisfied, [judged], {
      exitCode: EXIT_HOLDS,
      summary: 'ok',
    });
    expect(text).toContain('present ref: "0"');
    expect(text).toContain('absent ref: "0"');
  });

  it('prints the direction for a changed arm', () => {
    const judged = judgeArm(
      armOf('hash-object-working-tree'),
      classification(VERDICT_BLIND),
    );
    const text = formatReport(satisfied, [judged], {
      exitCode: EXIT_CHANGED,
      summary: 'changed',
    });
    expect(text).toContain('=> the substitute no longer discriminates');
  });

  it('ends with the exit code, because that is what a caller acts on', () => {
    const text = formatReport(satisfied, [], {
      exitCode: EXIT_CHANGED,
      summary: 'changed',
    });
    expect(text.trimEnd().endsWith('exit 1: changed')).toBe(true);
  });
});

describe('the precondition judgements, drivable from data', () => {
  it('P1 IS FALSE WHEN THE FABRICATED OBJECT RESOLVES — the clause no filesystem can exercise', () => {
    expect(
      judgeFixture({ realStatus: 0, realType: 'commit', fabricatedStatus: 0 }),
    ).toBe(false);
  });

  it('P1 holds only when the real object is found AND the fabricated one is refused', () => {
    expect(
      judgeFixture({
        realStatus: 0,
        realType: 'commit',
        fabricatedStatus: 128,
      }),
    ).toBe(true);
  });

  it('P1 is false when HEAD is missing, and false when it is not a commit', () => {
    expect(
      judgeFixture({
        realStatus: 128,
        realType: '',
        fabricatedStatus: 128,
      }),
    ).toBe(false);
    expect(
      judgeFixture({ realStatus: 0, realType: 'tree', fabricatedStatus: 128 }),
    ).toBe(false);
  });

  it('P2 REQUIRES BOTH DIRECTIONS: a directory whose writes never land fails it', () => {
    // Neither write took effect, so both reads return the original bytes.
    expect(
      judgeMutationReached({
        onDisk: COMMITTED_BYTES,
        restored: COMMITTED_BYTES,
      }),
    ).toBe(false);
  });

  it('P2 is false when the restore did not take, which would contaminate every later arm', () => {
    expect(
      judgeMutationReached({ onDisk: MUTATED_BYTES, restored: MUTATED_BYTES }),
    ).toBe(false);
  });

  it('P2 holds only for the mutate-then-restore pair', () => {
    expect(
      judgeMutationReached({
        onDisk: MUTATED_BYTES,
        restored: COMMITTED_BYTES,
      }),
    ).toBe(true);
  });
});

describe('the fixture, against real git', () => {
  const dirs: string[] = [];
  const fresh = () => {
    const { dir } = buildFixture();
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('builds a repository whose preconditions both hold', () => {
    const preconditions = readPreconditions(fresh());
    expect(preconditions.every((p) => p.satisfied)).toBe(true);
  });

  it('NEGATIVE CONTROL: P1 fails on a directory that is not a repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-silent-neg-'));
    dirs.push(dir);
    const preconditions = readPreconditions(dir);
    expect(at(preconditions, 0).satisfied).toBe(false);
  });

  it('P2 IS READ WITH fs, NOT git: it still answers in a directory git rejects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-silent-fs-'));
    dirs.push(dir);
    const preconditions = readPreconditions(dir);
    expect(at(preconditions, 1).satisfied).toBe(true);
  });

  it('P1 requires the fabricated object to be REFUSED, not merely the real one found', () => {
    const preconditions = readPreconditions(fresh());
    expect(at(preconditions, 0).satisfied).toBe(true);
    expect(FABRICATED_OBJECT).toMatch(/^[0-9a-f]{40}$/);
  });

  it('setWorkingTree round-trips the bytes it claims to', () => {
    const dir = fresh();
    setWorkingTree(dir, true);
    expect(readFileSync(join(dir, MUTATED_FILE), 'utf8')).toBe(MUTATED_BYTES);
    setWorkingTree(dir, false);
    expect(readFileSync(join(dir, MUTATED_FILE), 'utf8')).toBe(COMMITTED_BYTES);
  });

  it('leaves the working tree clean after every arm, so arms cannot contaminate each other', () => {
    const dir = fresh();
    for (const arm of ARMS) {
      readArm(dir, arm.id);
      expect(readFileSync(join(dir, MUTATED_FILE), 'utf8')).toBe(
        COMMITTED_BYTES,
      );
    }
  });

  it('refuses an unknown arm rather than returning an empty case list', () => {
    expect(() => readArm(fresh(), 'zzq-no-such-arm')).toThrow(/unknown arm/);
  });

  it('returns exactly two cases per arm, because discrimination is undefined for one', () => {
    const dir = fresh();
    for (const arm of ARMS) {
      expect(readArm(dir, arm.id)).toHaveLength(2);
    }
  });
});

describe('#367 instance 1: `git ls-remote` reports absence by succeeding', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const fresh = () => {
    const { dir } = buildFixture();
    dirs.push(dir);
    return dir;
  };

  it('gives the same exit code for a present and an absent ref', () => {
    const cases = readArm(fresh(), 'ls-remote-bare');
    expect(at(cases, 0).reading).toBe('0');
    expect(at(cases, 1).reading).toBe('0');
  });

  it('POSITIVE CONTROL: --exit-code separates the same two refs, so the pair is real', () => {
    const cases = readArm(fresh(), 'ls-remote-exit-code');
    expect(at(cases, 0).reading).toBe('0');
    expect(at(cases, 1).reading).toBe('2');
  });

  it('names a ref that genuinely cannot exist in the fixture', () => {
    expect(ABSENT_REF).not.toContain(FIXTURE_BRANCH);
  });
});

describe('#367 instance 2: a typo`d pathspec renders as clean', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const fresh = () => {
    const { dir } = buildFixture();
    dirs.push(dir);
    return dir;
  };

  it('produces zero bytes for a path that matches AND for a path that does not exist', () => {
    const cases = readArm(fresh(), 'diff-pathspec');
    expect(at(cases, 0).reading).toBe('0');
    expect(at(cases, 1).reading).toBe('0');
  });

  it('POSITIVE CONTROL: --error-unmatch separates the same two paths', () => {
    const cases = readArm(fresh(), 'ls-files-error-unmatch');
    expect(at(cases, 0).reading).toBe('0');
    expect(at(cases, 1).reading).not.toBe('0');
  });

  it('uses a real tracked file as the present case, or the pair would prove nothing', () => {
    const dir = fresh();
    expect(readFileSync(join(dir, STABLE_FILE), 'utf8')).toBe(COMMITTED_BYTES);
    expect(ABSENT_PATH).not.toBe(STABLE_FILE);
  });
});

describe('#367 instance 8: the revert check that cannot see the working tree', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const fresh = () => {
    const { dir } = buildFixture();
    dirs.push(dir);
    return dir;
  };

  it('rev-parse returns the identical hash for a clean and a damaged working tree', () => {
    const cases = readArm(fresh(), 'rev-parse-commit-relative');
    expect(at(cases, 0).reading).toBe(at(cases, 1).reading);
  });

  it('POSITIVE CONTROL: hash-object separates them, and agrees with rev-parse when clean', () => {
    const dir = fresh();
    const commitRelative = readArm(dir, 'rev-parse-commit-relative');
    const working = readArm(dir, 'hash-object-working-tree');
    expect(at(working, 0).reading).not.toBe(at(working, 1).reading);
    // Agreement on the clean case is what made the blind instrument look sound.
    expect(at(working, 0).reading).toBe(at(commitRelative, 0).reading);
  });

  it('POSITIVE CONTROL: status --porcelain is empty when clean and non-empty when damaged', () => {
    const cases = readArm(fresh(), 'status-porcelain');
    expect(at(cases, 0).reading).toBe('');
    expect(at(cases, 1).reading).toContain(MUTATED_FILE);
  });

  it('mutates a file that is actually tracked, or status would report it untracked instead', () => {
    const dir = fresh();
    const cases = readArm(dir, 'status-porcelain');
    expect(at(cases, 1).reading).toMatch(/^M\s/);
    expect(at(cases, 1).reading).not.toMatch(/\?\?/);
  });
});

describe('the probe end to end', () => {
  it('EXITS 0 AGAINST THIS MACHINE`S GIT: every claim in #367 still holds', () => {
    expect(main()).toBe(EXIT_HOLDS);
  });

  it('documents all three exit codes in its usage, since a caller branches on them', () => {
    for (const code of ['0', '1', '2']) {
      expect(USAGE).toContain(`  ${code}  `);
    }
  });

  it('cleans up its fixture, so repeated runs cannot accumulate temp repositories', () => {
    const before = mkdtempSync(join(tmpdir(), 'probe-silent-count-'));
    writeFileSync(join(before, 'marker'), 'x');
    expect(main()).toBe(EXIT_HOLDS);
    // The marker survives; only the probe's own directory is removed.
    expect(readFileSync(join(before, 'marker'), 'utf8')).toBe('x');
    rmSync(before, { recursive: true, force: true });
  });
});
