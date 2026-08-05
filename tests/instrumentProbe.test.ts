import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import {
  VERDICT_SOUND,
  VERDICT_BLIND,
  VERDICT_VACUOUS,
  VERDICT_MISREPORTS,
  VERDICT_UNUSABLE,
  EXIT_SOUND,
  EXIT_DEFECTIVE,
  EXIT_UNDETERMINED,
  VERDICT_RANK,
  NON_ANSWER_EXIT_CODES,
  PROBE_PLACEHOLDER,
  PLACEHOLDER,
  REDUCERS,
  pathIsInterpolable,
  worstVerdict,
  exitCodeFor,
  isNonAnswerExit,
  classifyDiscrimination,
  applyReduce,
  validateSpec,
  buildArgv,
  readingFrom,
  executeSpec,
  formatOutcome,
  parseArgs,
} from '../scripts/instrument-probe.mjs';

const SCRIPT = path.resolve(
  import.meta.dirname,
  '..',
  'scripts',
  'instrument-probe.mjs',
);

/** @param {Record<string, unknown>} over */
function spec(over = {}) {
  return {
    instrument: 'subject',
    shell: 'none',
    command: ['node', PROBE_PLACEHOLDER],
    reading: 'exitCode',
    cases: [
      { label: 'a', probe: { exit: 1 } },
      { label: 'b', probe: { exit: 0 } },
    ],
    ...over,
  };
}

/** Fails loudly rather than passing `false` into executeSpec as a subject. */
function mustValidate(r: ReturnType<typeof validateSpec>) {
  if (!r.ok) throw new Error(`spec unexpectedly invalid: ${r.reason}`);
  return r.spec;
}
describe('classifyDiscrimination', () => {
  it('calls an instrument SOUND when the two readings differ', () => {
    const out = classifyDiscrimination([
      { label: 'a', reading: '3' },
      { label: 'b', reading: '0' },
    ]);
    expect(out.verdict).toBe(VERDICT_SOUND);
    expect(out.blind).toBe(false);
    expect(out.findings).toEqual([]);
  });

  it('calls an instrument BLIND when every reading is identical', () => {
    const out = classifyDiscrimination([
      { label: 'failed', reading: '77' },
      { label: 'succeeded', reading: '77' },
    ]);
    expect(out.verdict).toBe(VERDICT_BLIND);
    expect(out.blind).toBe(true);
    expect(out.findings[0]).toContain('BLIND');
    expect(out.findings[0]).toContain('"77"');
  });

  it('is BLIND even when the identical reading is the expected one for a case', () => {
    // The dangerous shape: half the matrix agrees, so a spot check passes.
    const out = classifyDiscrimination([
      { label: 'failed', reading: '0', expect: '3' },
      { label: 'succeeded', reading: '0', expect: '0' },
    ]);
    expect(out.verdict).toBe(VERDICT_BLIND);
  });

  it('calls it MISREPORTS when readings differ but one is not what was expected', () => {
    const out = classifyDiscrimination([
      { label: 'a', reading: '9', expect: '3' },
      { label: 'b', reading: '0', expect: '0' },
    ]);
    expect(out.verdict).toBe(VERDICT_MISREPORTS);
    expect(out.blind).toBe(false);
    expect(out.findings[0]).toContain('expected "3"');
    expect(out.findings[0]).toContain('said "9"');
  });

  it('detects an inverted instrument as MISREPORTS, not SOUND', () => {
    // NEGATIVE CONTROL for the SOUND arm: differing readings are necessary but
    // not sufficient. An instrument that separates the cases backwards is
    // still wrong, and "the readings differed" would have passed it.
    const out = classifyDiscrimination([
      { label: 'failed', reading: '0', expect: '3' },
      { label: 'succeeded', reading: '3', expect: '0' },
    ]);
    expect(out.verdict).toBe(VERDICT_MISREPORTS);
  });

  it('calls it UNUSABLE when a reading is missing', () => {
    const out = classifyDiscrimination([
      { label: 'a', reading: null, error: 'ENOENT' },
      { label: 'b', reading: '0' },
    ]);
    expect(out.verdict).toBe(VERDICT_UNUSABLE);
    expect(out.findings[0]).toContain('ENOENT');
  });

  it('ranks a proven MISREPORT above an arm that did not run', () => {
    // See the ranking note in the script header. A demonstrated lie in case A
    // is not weakened by case B failing to run; ranking the other way would
    // let one dead arm mask a finding.
    const out = classifyDiscrimination([
      { label: 'a', reading: '9', expect: '3' },
      { label: 'b', reading: null, error: 'boom' },
    ]);
    expect(out.verdict).toBe(VERDICT_MISREPORTS);
  });

  it('cannot report BLIND when a reading is missing', () => {
    // Two things cannot be shown identical when one of them is absent.
    const out = classifyDiscrimination([
      { label: 'a', reading: null },
      { label: 'b', reading: null },
    ]);
    expect(out.blind).toBe(false);
    expect(out.verdict).toBe(VERDICT_UNUSABLE);
  });

  it('treats an empty-string reading as an answer, not as a missing one', () => {
    // #214 instance 4: an unfinished check's conclusion is "". Collapsing ""
    // into "no reading" is that defect.
    const out = classifyDiscrimination([
      { label: 'a', reading: '' },
      { label: 'b', reading: '' },
    ]);
    expect(out.verdict).toBe(VERDICT_BLIND);
  });

  it('calls an instrument SOUND when one of its two answers is empty', () => {
    // FOUND BY A SURVIVING MUTATION. The all-empty case above passes even when
    // "" is misclassified as missing, because the blindness arm overrides the
    // per-case verdict — so it did not bind the thing it was written for.
    // Empty is a routine correct answer here: `git ls-remote` prints nothing
    // for an absent branch, and the `empty`/`lineCount` reducers exist to read
    // exactly that. Reporting a working instrument UNUSABLE would push the
    // reader back to the instrument they came to check.
    const out = classifyDiscrimination([
      { label: 'branch absent', reading: '' },
      { label: 'branch present', reading: 'refs/heads/development' },
    ]);
    expect(out.verdict).toBe(VERDICT_SOUND);
    expect(out.findings).toEqual([]);
  });

  it('still expects an empty answer when one is expected', () => {
    const out = classifyDiscrimination([
      { label: 'absent', reading: '', expect: '' },
      { label: 'present', reading: 'x', expect: 'x' },
    ]);
    expect(out.verdict).toBe(VERDICT_SOUND);
  });

  it('refuses to judge a single case', () => {
    const out = classifyDiscrimination([{ label: 'only', reading: '0' }]);
    expect(out.verdict).toBe(VERDICT_UNUSABLE);
    expect(out.findings[0]).toContain('fewer than two cases');
  });

  it('refuses to judge no cases at all', () => {
    expect(classifyDiscrimination([]).verdict).toBe(VERDICT_UNUSABLE);
  });

  it('reports every reading so the verdict can be checked by hand', () => {
    const out = classifyDiscrimination([
      { label: 'a', reading: '3' },
      { label: 'b', reading: '0' },
    ]);
    expect(out.readings).toEqual([
      { label: 'a', reading: '3' },
      { label: 'b', reading: '0' },
    ]);
  });

  it('detects blindness across three cases, not just two', () => {
    const out = classifyDiscrimination([
      { label: 'a', reading: 'x' },
      { label: 'b', reading: 'x' },
      { label: 'c', reading: 'x' },
    ]);
    expect(out.verdict).toBe(VERDICT_BLIND);
  });

  it('is not blind when only some of three cases agree', () => {
    const out = classifyDiscrimination([
      { label: 'a', reading: 'x' },
      { label: 'b', reading: 'x' },
      { label: 'c', reading: 'y' },
    ]);
    expect(out.verdict).toBe(VERDICT_SOUND);
  });
});

describe('vacuity: a pair can separate for a reason that is not the predicate', () => {
  it('refuses to certify when the negative arm returned a non-answer code', () => {
    const out = classifyDiscrimination(
      [
        { label: 'on trunk', reading: '0' },
        { label: 'fabricated sha', reading: '128' },
      ],
      'exitCode',
    );
    expect(out.verdict).toBe(VERDICT_VACUOUS);
    expect(out.vacuous).toBe(true);
    expect(out.findings[0]).toMatch(/did not answer/);
  });

  it('is SOUND for the same instrument once the negative arm can be reached', () => {
    const out = classifyDiscrimination(
      [
        { label: 'on trunk', reading: '0' },
        { label: 'real commit, not on trunk', reading: '1' },
      ],
      'exitCode',
    );
    expect(out.verdict).toBe(VERDICT_SOUND);
    expect(out.vacuous).toBe(false);
  });

  it('is vacuous when BOTH arms declined, even though the codes differ', () => {
    const out = classifyDiscrimination(
      [
        { label: 'a', reading: '128' },
        { label: 'b', reading: '129' },
      ],
      'exitCode',
    );
    expect(out.verdict).toBe(VERDICT_VACUOUS);
  });

  it('does not fire when no arm returned a non-answer code', () => {
    const out = classifyDiscrimination(
      [
        { label: 'a', reading: '0' },
        { label: 'b', reading: '3' },
      ],
      'exitCode',
    );
    expect(out.verdict).toBe(VERDICT_SOUND);
    expect(out.vacuous).toBe(false);
  });

  it('does not fire on stdout readings, where 128 is just text', () => {
    const out = classifyDiscrimination(
      [
        { label: 'a', reading: '128' },
        { label: 'b', reading: '4' },
      ],
      'stdout',
    );
    expect(out.verdict).toBe(VERDICT_SOUND);
    expect(out.vacuous).toBe(false);
  });

  it('does not fire when the reading kind was not supplied', () => {
    const out = classifyDiscrimination([
      { label: 'a', reading: '0' },
      { label: 'b', reading: '128' },
    ]);
    expect(out.verdict).toBe(VERDICT_SOUND);
  });

  it('does not fire when two arms gave real answers and a third declined', () => {
    const out = classifyDiscrimination(
      [
        { label: 'on trunk', reading: '0' },
        { label: 'real commit, not on trunk', reading: '1' },
        { label: 'fabricated sha', reading: '128' },
      ],
      'exitCode',
    );
    expect(out.vacuous).toBe(false);
    expect(out.verdict).toBe(VERDICT_SOUND);
  });

  it('reports BLIND over VACUOUS: proven blindness is the worse finding', () => {
    const out = classifyDiscrimination(
      [
        { label: 'a', reading: '128' },
        { label: 'b', reading: '128' },
      ],
      'exitCode',
    );
    expect(out.verdict).toBe(VERDICT_BLIND);
  });

  it('reports VACUOUS over a MISREPORTS on the other arm', () => {
    const out = classifyDiscrimination(
      [
        { label: 'a', reading: '0', expect: '5' },
        { label: 'b', reading: '128' },
      ],
      'exitCode',
    );
    expect(out.verdict).toBe(VERDICT_VACUOUS);
  });

  it('cannot be vacuous when an arm produced no reading at all', () => {
    const out = classifyDiscrimination(
      [
        { label: 'a', reading: null, error: 'spawn failed' },
        { label: 'b', reading: '128' },
      ],
      'exitCode',
    );
    expect(out.vacuous).toBe(false);
    expect(out.verdict).toBe(VERDICT_UNUSABLE);
  });

  it('exits 2, not 1: vacuity is a finding against the case pair, not the instrument', () => {
    expect(exitCodeFor(VERDICT_VACUOUS)).toBe(EXIT_UNDETERMINED);
  });

  it('ranks VACUOUS below BLIND and above MISREPORTS', () => {
    expect(VERDICT_RANK.indexOf(VERDICT_BLIND)).toBeLessThan(
      VERDICT_RANK.indexOf(VERDICT_VACUOUS),
    );
    expect(VERDICT_RANK.indexOf(VERDICT_VACUOUS)).toBeLessThan(
      VERDICT_RANK.indexOf(VERDICT_MISREPORTS),
    );
  });
});

describe('isNonAnswerExit', () => {
  for (const code of NON_ANSWER_EXIT_CODES) {
    it(`treats ${code} as a non-answer`, () => {
      expect(isNonAnswerExit(String(code))).toBe(true);
    });
  }

  for (const code of ['0', '1', '2', '3', '77', '125', '130']) {
    it(`treats ${code} as a real answer`, () => {
      expect(isNonAnswerExit(code)).toBe(false);
    });
  }

  it('is false for a non-numeric reading', () => {
    expect(isNonAnswerExit('128 files')).toBe(false);
  });

  it('is false for an absent reading', () => {
    expect(isNonAnswerExit(null)).toBe(false);
    expect(isNonAnswerExit(undefined)).toBe(false);
  });

  it('is false for the empty string, which is an answer', () => {
    expect(isNonAnswerExit('')).toBe(false);
  });
});

describe('verdict ranking', () => {
  it('orders worst-first: BLIND, VACUOUS, MISREPORTS, UNUSABLE, SOUND', () => {
    expect(VERDICT_RANK).toEqual([
      VERDICT_BLIND,
      VERDICT_VACUOUS,
      VERDICT_MISREPORTS,
      VERDICT_UNUSABLE,
      VERDICT_SOUND,
    ]);
  });

  it('picks the worst present verdict', () => {
    expect(worstVerdict([VERDICT_SOUND, VERDICT_UNUSABLE])).toBe(
      VERDICT_UNUSABLE,
    );
    expect(worstVerdict([VERDICT_UNUSABLE, VERDICT_MISREPORTS])).toBe(
      VERDICT_MISREPORTS,
    );
    expect(worstVerdict([VERDICT_MISREPORTS, VERDICT_BLIND])).toBe(
      VERDICT_BLIND,
    );
    expect(worstVerdict([VERDICT_SOUND])).toBe(VERDICT_SOUND);
    expect(worstVerdict([])).toBe(VERDICT_SOUND);
  });

  it('maps verdicts to three distinct exit codes', () => {
    expect(exitCodeFor(VERDICT_SOUND)).toBe(EXIT_SOUND);
    expect(exitCodeFor(VERDICT_UNUSABLE)).toBe(EXIT_UNDETERMINED);
    expect(exitCodeFor(VERDICT_BLIND)).toBe(EXIT_DEFECTIVE);
    expect(exitCodeFor(VERDICT_MISREPORTS)).toBe(EXIT_DEFECTIVE);
  });

  it('never collapses "could not determine" into "defective"', () => {
    // #315: `if (!ok)` merges these, and their remedies differ.
    expect(EXIT_UNDETERMINED).not.toBe(EXIT_DEFECTIVE);
    expect(EXIT_UNDETERMINED).not.toBe(EXIT_SOUND);
  });
});

describe('applyReduce', () => {
  it('returns raw output unchanged', () => {
    expect(applyReduce('raw', 'a\nb\n')).toEqual({ ok: true, value: 'a\nb\n' });
  });

  it('trims', () => {
    expect(applyReduce('trim', '  x \n')).toEqual({ ok: true, value: 'x' });
  });

  it('reports emptiness as a boolean', () => {
    expect(applyReduce('empty', '   \n')).toEqual({ ok: true, value: 'true' });
    expect(applyReduce('empty', 'x')).toEqual({ ok: true, value: 'false' });
  });

  it('counts non-blank lines', () => {
    // The ls-remote case: exit code constant across present and absent, only
    // the line count moves.
    expect(applyReduce('lineCount', 'a\nb\n')).toEqual({
      ok: true,
      value: '2',
    });
    expect(applyReduce('lineCount', '')).toEqual({ ok: true, value: '0' });
    expect(applyReduce('lineCount', '\n\n')).toEqual({ ok: true, value: '0' });
  });

  it('reports containment as a boolean', () => {
    expect(applyReduce('contains:dev', 'a dev b')).toEqual({
      ok: true,
      value: 'true',
    });
    expect(applyReduce('contains:dev', 'a b')).toEqual({
      ok: true,
      value: 'false',
    });
  });

  it('refuses an empty needle', () => {
    const r = applyReduce('contains:', 'anything');
    expect(r.ok).toBe(false);
  });

  it('refuses an unknown reducer', () => {
    const r = applyReduce('vibes', 'x');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('vibes');
  });

  it('reduces the two outputs of #214 instance 5 to the same answer', () => {
    // THE DEFECT THIS FUNCTION EXISTS FOR. `git branch -a --contains` prints
    // different text for a tip and for an ancestor, so comparing raw output
    // certifies it. The answer anyone actually consumes is identical.
    const tip =
      '  remotes/origin/HEAD -> origin/development\n  remotes/origin/development\n';
    const ancestor = '  a\n  b\n  remotes/origin/development\n  c\n';
    expect(applyReduce('raw', tip).ok && applyReduce('raw', tip)).not.toEqual(
      applyReduce('raw', ancestor),
    );
    expect(applyReduce('contains:remotes/origin/development', tip)).toEqual(
      applyReduce('contains:remotes/origin/development', ancestor),
    );
  });

  it('lists its reducers for the error message to use', () => {
    expect(REDUCERS).toContain('lineCount');
    expect(REDUCERS).toContain('contains:<text>');
  });
});

describe('validateSpec', () => {
  it('accepts a minimal well-formed spec and fills defaults', () => {
    const r = validateSpec(spec());
    expect(r.ok).toBe(true);
    expect(r.ok && r.spec.shell).toBe('none');
    expect(r.ok && r.spec.reading).toBe('exitCode');
    expect(r.ok && r.spec.reduce).toBe('raw');
  });

  it('rejects a non-object', () => {
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec('x').ok).toBe(false);
  });

  it('requires a named instrument', () => {
    expect(validateSpec(spec({ instrument: '' })).ok).toBe(false);
  });

  it('rejects an unsupported shell', () => {
    const r = validateSpec(spec({ shell: 'fish' }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('fish');
  });

  it('requires at least one placeholder, so the command varies with the case', () => {
    // A spec whose subject never changes is GUARANTEED to come back BLIND.
    // That verdict would indict the instrument for the spec author's mistake,
    // which is worse than no verdict.
    const r = validateSpec(spec({ command: ['node', '--version'] }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('vary with the case');
  });

  it('requires a placeholder in shell scripts too', () => {
    const r = validateSpec(
      spec({ shell: 'sh', script: 'echo hi', command: undefined }),
    );
    expect(r.ok).toBe(false);
  });

  it('accepts a script whose only placeholder is a var', () => {
    const r = validateSpec(
      spec({
        shell: 'sh',
        command: undefined,
        script: 'git rev-parse {{SHA}}',
        reading: 'stdout',
        reduce: 'trim',
        cases: [
          { label: 'a', vars: { SHA: 'aaa' } },
          { label: 'b', vars: { SHA: 'bbb' } },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('requires reduce when reading stdout', () => {
    const r = validateSpec(spec({ reading: 'stdout' }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('reduce is required');
  });

  it('rejects reduce alongside an exit-code reading', () => {
    const r = validateSpec(spec({ reading: 'exitCode', reduce: 'trim' }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('already the answer');
  });

  it('rejects an unsupported reducer before anything runs', () => {
    const r = validateSpec(spec({ reading: 'stdout', reduce: 'contains:' }));
    expect(r.ok).toBe(false);
  });

  it('requires at least two cases', () => {
    const r = validateSpec(
      spec({ cases: [{ label: 'a', probe: { exit: 0 } }] }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('two cases');
  });

  it('requires each case to carry a subject', () => {
    const r = validateSpec(spec({ cases: [{ label: 'a' }, { label: 'b' }] }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('probe');
  });

  it('requires an integer probe exit', () => {
    const r = validateSpec(
      spec({
        cases: [
          { label: 'a', probe: { exit: 'x' } },
          { label: 'b', probe: { exit: 0 } },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('requires string var values', () => {
    const r = validateSpec(
      spec({
        cases: [
          { label: 'a', vars: { A: 1 } },
          { label: 'b', vars: { A: '2' } },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('vars.A');
  });

  it('requires a label on every case', () => {
    const r = validateSpec(
      spec({
        cases: [{ probe: { exit: 0 } }, { label: 'b', probe: { exit: 1 } }],
      }),
    );
    expect(r.ok).toBe(false);
  });
});

describe('pathIsInterpolable', () => {
  it('accepts ordinary Windows and POSIX paths', () => {
    expect(pathIsInterpolable('C:\\Program Files\\nodejs\\node.exe')).toBe(
      true,
    );
    expect(pathIsInterpolable('/usr/bin/node')).toBe(true);
  });

  it('refuses anything a shell may expand', () => {
    // cmd.exe expands %VAR% and !VAR! inside double quotes; sh expands $ and
    // backticks. There is no quoting that makes these safe, so refuse.
    for (const bad of [
      'a%PATH%b',
      'a!x!b',
      'a$b',
      'a`b',
      "a'b",
      'a"b',
      'a;b',
      'a&b',
    ]) {
      expect(pathIsInterpolable(bad)).toBe(false);
    }
  });

  it('refuses an empty or non-string path', () => {
    expect(pathIsInterpolable('')).toBe(false);
    expect(pathIsInterpolable(undefined)).toBe(false);
  });
});

describe('buildArgv', () => {
  it('expands the probe placeholder into two argv elements when shell is none', () => {
    const r = buildArgv(
      { shell: 'none', command: ['x', PROBE_PLACEHOLDER, 'y'] },
      'NODE',
      'PROBE',
    );
    expect(r.ok && r.argv).toEqual(['x', 'NODE', 'PROBE', 'y']);
  });

  it('substitutes vars into argv elements', () => {
    const r = buildArgv(
      { shell: 'none', command: ['git', 'rev-parse', '{{SHA}}'] },
      'NODE',
      'PROBE',
      { SHA: 'abc' },
    );
    expect(r.ok && r.argv).toEqual(['git', 'rev-parse', 'abc']);
  });

  it('allows shell-unsafe var values when there is no shell to expand them', () => {
    // NEGATIVE CONTROL for the refusal below: the refusal must be caused by
    // the shell, not by the character.
    const r = buildArgv(
      { shell: 'none', command: ['echo', '{{A}}'] },
      'NODE',
      'PROBE',
      {
        A: '%PATH%',
      },
    );
    expect(r.ok && r.argv).toEqual(['echo', '%PATH%']);
  });

  it('refuses to interpolate a shell-unsafe var into a shell script', () => {
    const r = buildArgv(
      { shell: 'sh', script: 'echo {{A}}' },
      'NODE',
      'PROBE',
      { A: '$(rm)' },
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('vars.A');
  });

  it('builds a pwsh command line with the call operator', () => {
    const r = buildArgv(
      { shell: 'pwsh', script: `${PROBE_PLACEHOLDER} | x` },
      'N',
      'P',
    );
    expect(r.ok && r.argv[0]).toBe('pwsh');
    expect(r.ok && r.argv[1]).toBe('-NoProfile');
    expect(r.ok && r.argv[3]).toBe("& 'N' 'P' | x");
  });

  it('builds an sh command line without the call operator', () => {
    const r = buildArgv(
      { shell: 'sh', script: `${PROBE_PLACEHOLDER} | x` },
      'N',
      'P',
    );
    expect(r.ok && r.argv[0]).toBe('sh');
    expect(r.ok && r.argv[2]).toBe("'N' 'P' | x");
  });

  it('refuses a shell spec when the node path itself is unsafe', () => {
    const r = buildArgv({ shell: 'sh', script: PROBE_PLACEHOLDER }, 'N$X', 'P');
    expect(r.ok).toBe(false);
  });

  it('substitutes every occurrence, not just the first', () => {
    const r = buildArgv({ shell: 'sh', script: '{{A}} {{A}}' }, 'N', 'P', {
      A: 'z',
    });
    expect(r.ok && r.argv[2]).toBe('z z');
  });

  it('matches a placeholder token', () => {
    expect(PLACEHOLDER.test('{{PROBE}}')).toBe(true);
    expect(PLACEHOLDER.test('{{SHA_1}}')).toBe(true);
    expect(PLACEHOLDER.test('no tokens here')).toBe(false);
    expect(PLACEHOLDER.test('{{ }}')).toBe(false);
  });
});

describe('readingFrom', () => {
  it('reads an exit code as a string', () => {
    expect(readingFrom('exitCode', { status: 3, stdout: '' })).toEqual({
      reading: '3',
    });
  });

  it('reports a spawn error as no reading, never as a value', () => {
    const r = readingFrom('exitCode', {
      status: null,
      stdout: '',
      error: 'ENOENT',
    });
    expect(r.reading).toBeNull();
    expect(r.error).toBe('ENOENT');
  });

  it('reports a null status as no reading', () => {
    const r = readingFrom('exitCode', { status: null, stdout: '' });
    expect(r.reading).toBeNull();
  });

  it('applies the reducer to stdout', () => {
    expect(
      readingFrom('stdout', { status: 0, stdout: ' a \n' }, 'trim'),
    ).toEqual({ reading: 'a' });
    expect(
      readingFrom('stdout', { status: 0, stdout: 'a\nb\n' }, 'lineCount'),
    ).toEqual({
      reading: '2',
    });
  });

  it('reports a bad reducer as no reading rather than guessing', () => {
    const r = readingFrom('stdout', { status: 0, stdout: 'x' }, 'nope');
    expect(r.reading).toBeNull();
  });
});

describe('executeSpec', () => {
  it('runs one arm per case and passes the probe parameters as environment', () => {
    const seen: { argv: string[]; env: Record<string, string> }[] = [];
    const run = (argv: string[], env: Record<string, string>) => {
      seen.push({ argv, env });
      return { status: Number(env.PROBE_EXIT), stdout: '' };
    };
    const valid = validateSpec(spec());
    const cases = executeSpec(mustValidate(valid), run, 'NODE', 'PROBE');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.env.PROBE_EXIT).toBe('1');
    expect(seen[1]?.env.PROBE_EXIT).toBe('0');
    expect(cases.map((c) => c.reading)).toEqual(['1', '0']);
  });

  it('exports case vars to the environment as well as substituting them', () => {
    const envs: Record<string, string>[] = [];
    const run = (_a: string[], env: Record<string, string>) => {
      envs.push(env);
      return { status: 0, stdout: '' };
    };
    const valid = validateSpec(
      spec({
        command: ['git', '{{SHA}}'],
        cases: [
          { label: 'a', vars: { SHA: 'aa' } },
          { label: 'b', vars: { SHA: 'bb' } },
        ],
      }),
    );
    executeSpec(mustValidate(valid), run, 'NODE', 'PROBE');
    expect(envs[0]?.SHA).toBe('aa');
    expect(envs[1]?.SHA).toBe('bb');
  });

  it('turns a build refusal into a per-case missing reading, not a throw', () => {
    const valid = validateSpec(
      spec({
        shell: 'sh',
        command: undefined,
        script: 'echo {{A}}',
        cases: [
          { label: 'a', vars: { A: '$(x)' } },
          { label: 'b', vars: { A: 'ok' } },
        ],
      }),
    );
    const cases = executeSpec(
      mustValidate(valid),
      () => ({ status: 0, stdout: '' }),
      'NODE',
      'PROBE',
    );
    expect(cases[0]?.reading).toBeNull();
    expect(cases[1]?.reading).toBe('0');
  });
});

describe('formatOutcome', () => {
  it('prints every reading beside its label', () => {
    const text = formatOutcome(
      'subject',
      classifyDiscrimination([
        { label: 'failed', reading: '77' },
        { label: 'ok', reading: '77' },
      ]),
    );
    expect(text).toContain('subject');
    expect(text).toContain('BLIND');
    expect(text).toContain('<- failed');
    expect(text).toContain('<- ok');
  });

  it('states the domain limit on a sound verdict', () => {
    const text = formatOutcome(
      'subject',
      classifyDiscrimination([
        { label: 'a', reading: '1' },
        { label: 'b', reading: '0' },
      ]),
    );
    expect(text).toContain('only for the cases you named');
  });

  it('shows a missing reading as missing rather than as an empty value', () => {
    const text = formatOutcome(
      'subject',
      classifyDiscrimination([
        { label: 'a', reading: null },
        { label: 'b', reading: '0' },
      ]),
    );
    expect(text).toContain('(no reading)');
  });
});

describe('parseArgs', () => {
  it('reads --spec', () => {
    expect(parseArgs(['--spec', 'x.json']).spec).toBe('x.json');
  });

  it('reads --help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('returns nothing for an empty argv', () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe('end to end, running the real entry point', () => {
  let dir: string | undefined;

  function runProbe(s: unknown): { status: number; stdout: string } {
    dir ??= mkdtempSync(join(tmpdir(), 'instrument-probe-test-'));
    const file = join(dir, `spec-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(s), 'utf8');
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, '--spec', file], {
        encoding: 'utf8',
      });
      return { status: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        status: e.status ?? -1,
        stdout: (e.stdout ?? '') + (e.stderr ?? ''),
      };
    } finally {
      rmSync(file, { force: true });
    }
  }

  it('certifies a wrapper that passes the exit code through', () => {
    const r = runProbe(
      spec({
        instrument: 'running the command directly',
        command: [PROBE_PLACEHOLDER],
        cases: [
          { label: 'exits 3', probe: { exit: 3, lines: 25 }, expect: '3' },
          { label: 'exits 0', probe: { exit: 0, lines: 25 }, expect: '0' },
        ],
      }),
    );
    expect(r.status).toBe(EXIT_SOUND);
    expect(r.stdout).toContain('SOUND');
  });

  it('convicts a wrapper that discards the exit code', () => {
    // The whole subject, run for real: a wrapper that never consults its
    // child returns the same reading for a failure and for a success.
    const r = runProbe(
      spec({
        instrument: 'a wrapper that always exits 0',
        command: ['node', '-e', 'process.exit(0)', PROBE_PLACEHOLDER],
        cases: [
          { label: 'exits 3', probe: { exit: 3, lines: 25 }, expect: '3' },
          { label: 'exits 0', probe: { exit: 0, lines: 25 }, expect: '0' },
        ],
      }),
    );
    expect(r.status).toBe(EXIT_DEFECTIVE);
    expect(r.stdout).toContain('BLIND');
    expect(r.stdout).toContain('"0"');
  });

  it('reports MISREPORTS, not BLIND, for a wrapper that shifts the code', () => {
    const r = runProbe(
      spec({
        instrument: 'a wrapper that adds one to the exit code',
        command: [
          'node',
          '-e',
          'process.exit(Number(process.env.PROBE_EXIT) + 1)',
          PROBE_PLACEHOLDER,
        ],
        cases: [
          { label: 'exits 3', probe: { exit: 3 }, expect: '3' },
          { label: 'exits 0', probe: { exit: 0 }, expect: '0' },
        ],
      }),
    );
    expect(r.status).toBe(EXIT_DEFECTIVE);
    expect(r.stdout).toContain('MISREPORTS');
    expect(r.stdout).not.toContain('BLIND');
  });

  it('detects blindness with no expectations supplied at all', () => {
    // The case that matters for an unfamiliar instrument: you do not know what
    // it should say, only that the two subjects differ.
    const r = runProbe(
      spec({
        instrument:
          'a wrapper that always exits 0, judged without expectations',
        command: ['node', '-e', 'process.exit(0)', PROBE_PLACEHOLDER],
        cases: [
          { label: 'exits 3', probe: { exit: 3 } },
          { label: 'exits 0', probe: { exit: 0 } },
        ],
      }),
    );
    expect(r.status).toBe(EXIT_DEFECTIVE);
    expect(r.stdout).toContain('BLIND');
  });

  it('discriminates on a reduced stdout reading', () => {
    const r = runProbe(
      spec({
        instrument: 'line count of the probe output',
        reading: 'stdout',
        reduce: 'lineCount',
        command: [PROBE_PLACEHOLDER],
        cases: [
          { label: 'two lines', probe: { exit: 0, lines: 2 }, expect: '2' },
          { label: 'no lines', probe: { exit: 0, lines: 0 }, expect: '0' },
        ],
      }),
    );
    expect(r.status).toBe(EXIT_SOUND);
  });

  it('exits 2, not 1, on a spec it cannot use', () => {
    const r = runProbe(
      spec({ cases: [{ label: 'only', probe: { exit: 0 } }] }),
    );
    expect(r.status).toBe(EXIT_UNDETERMINED);
    expect(r.stdout).toContain('invalid spec');
  });

  it('exits 2 when the command cannot be launched at all', () => {
    const r = runProbe(
      spec({
        instrument: 'a command that does not exist',
        command: ['definitely-not-a-real-command-vasquez', '{{SHA}}'],
        cases: [
          { label: 'a', vars: { SHA: 'x' } },
          { label: 'b', vars: { SHA: 'y' } },
        ],
      }),
    );
    expect(r.status).toBe(EXIT_UNDETERMINED);
    expect(r.stdout).toContain('UNUSABLE');
  });

  it('prints usage and exits 2 when no spec is given', () => {
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      status = e.status ?? -1;
      stdout = e.stdout ?? '';
    }
    expect(status).toBe(EXIT_UNDETERMINED);
    expect(stdout).toContain('usage:');
  });

  it('exits 2 when the spec file cannot be read', () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, '--spec', 'no-such-spec.json'], {
        encoding: 'utf8',
      });
    } catch (err) {
      status = (err as { status?: number }).status ?? -1;
    }
    expect(status).toBe(EXIT_UNDETERMINED);
  });
});
