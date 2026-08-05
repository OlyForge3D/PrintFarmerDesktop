import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ARM_CONFOUNDED,
  ARM_KILLED,
  ARM_SURVIVED,
  classifyApplication,
  classifyArm,
  classifyBaseline,
  classifyRestore,
  countOccurrences,
  evaluateRun,
  formatRun,
  hashWorkingFile,
  parseTestSummary,
  resolveCommand,
  runArm,
  stripAnsi,
} from '../scripts/mutation-harness.mjs';

// Verbatim shapes from a real vitest run. The Duration line is the one that
// matters: it contains the lowercase word "tests" followed by a number, which
// is what a case-insensitive extractor latches onto.
const PASSING_RUN = [
  ' \u001B[32m✓\u001B[39m tests/example.test.ts (17 tests) 4ms',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  17 passed (17)',
  '   Start at  20:40:17',
  '   Duration  892ms (transform 34ms, setup 43ms, collect 30ms, tests 4ms, environment 253ms, prepare 58ms)',
].join('\n');

const FAILING_RUN = [
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 16 passed (17)',
  '   Duration  839ms (transform 33ms, setup 48ms, collect 28ms, tests 7ms, environment 244ms, prepare 57ms)',
].join('\n');

describe('the result extractor, which is the thing that actually broke', () => {
  // THE REGRESSION. Two sessions independently wrote an extractor that matched
  // vitest's Duration line -- `tests 4ms` -- because Select-String and a
  // case-insensitive regex both find it. It then reported "0 failed" for an
  // arm that had killed a test, and the all-green reading is the one everybody
  // is predisposed to accept.
  it('does not read counts out of the Duration line', () => {
    expect(parseTestSummary(PASSING_RUN)).toEqual({ failed: 0, passed: 17 });
    expect(parseTestSummary(FAILING_RUN)).toEqual({ failed: 1, passed: 16 });
  });

  it('does not mistake the "Failed Tests N" banner for a count of tests', () => {
    // The banner says 4 and the real count is 1. An extractor that matched it
    // would over-report kills, which is the direction nobody checks because it
    // agrees with the hypothesis.
    const parsed = parseTestSummary(FAILING_RUN);
    expect(parsed?.failed).toBe(1);
    expect(parsed?.failed).not.toBe(4);
  });

  it('reads a summary that is wrapped in colour codes', () => {
    const coloured =
      '      \u001B[1mTests\u001B[22m  \u001B[31m2 failed\u001B[39m | 15 passed (17)';
    expect(parseTestSummary(coloured)).toEqual({ failed: 2, passed: 15 });
  });

  it('returns null rather than zero when there is no summary at all', () => {
    // The distinction the whole file rests on: "nothing failed" and "I could
    // not tell" must not be the same value.
    expect(parseTestSummary('command not found')).toBeNull();
    expect(parseTestSummary('')).toBeNull();
  });

  it('strips ansi without disturbing the text', () => {
    expect(stripAnsi('\u001B[31mred\u001B[39m')).toBe('red');
  });
});

describe('launching the test command at all', () => {
  // Found by running the harness against itself: execFileSync cannot launch
  // npx on Windows. The baseline control caught it and exited 2 rather than
  // producing arm results from a command that never ran -- but the message
  // would have been read as "the harness is broken", not "the launcher is".
  it('routes an npm-family shim through cmd.exe on win32', () => {
    const { file, args } = resolveCommand(
      ['npx', 'vitest', 'run', 'tests/a.test.ts'],
      'win32',
    );
    expect(file.toLowerCase()).toContain('cmd');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(args[3]).toBe('npx.cmd vitest run tests/a.test.ts');
  });

  it('refuses a shim argument whose quoting cannot be made correct', () => {
    // cmd.exe expands these even inside double quotes, so there is no correct
    // quoting -- only a guess that would run a different command and then
    // report mutation results from it.
    for (const hostile of ['%PATH%', 'a!b!', 'two words', 'x&&y']) {
      expect(() => resolveCommand(['npx', 'vitest', hostile], 'win32')).toThrow(
        /cannot launch/,
      );
    }
  });

  it('leaves a real executable alone, so quoted arguments never reach cmd.exe', () => {
    // The alternative fix, shell: true, hands every argument to cmd.exe
    // unescaped (DEP0190) and would mangle the node probe used below.
    expect(
      resolveCommand([process.execPath, '-e', 'a b "c"'], 'win32'),
    ).toEqual({ file: process.execPath, args: ['-e', 'a b "c"'] });
  });

  it('changes nothing off win32', () => {
    expect(resolveCommand(['npx', 'vitest', 'a b'], 'linux')).toEqual({
      file: 'npx',
      args: ['vitest', 'a b'],
    });
  });

  it('refuses an empty command instead of launching the undefined one', () => {
    expect(() => resolveCommand([], 'linux')).toThrow(/empty/);
  });
});

describe('the baseline arm, the only control that can catch a broken extractor', () => {
  it('refuses a run whose unmutated pass it cannot read', () => {
    const verdict = classifyBaseline(null);
    expect(verdict.usable).toBe(false);
    expect(verdict.reason).toMatch(/cannot distinguish a killed mutant/);
  });

  it('refuses a run that is already red before any mutation', () => {
    expect(classifyBaseline({ failed: 3, passed: 10 }).usable).toBe(false);
  });

  it('refuses a run that selected no tests', () => {
    // Zero passing and zero failing parses cleanly and means the suite
    // selector matched nothing, so every arm would "survive".
    expect(classifyBaseline({ failed: 0, passed: 0 }).usable).toBe(false);
  });

  it('accepts a genuine green baseline', () => {
    expect(classifyBaseline({ failed: 0, passed: 17 }).usable).toBe(true);
  });
});

describe('proving the mutation reached the disk', () => {
  it('rejects an anchor that matched nothing', () => {
    // Measured: a batch of four mutations emitted two silent no-ops from
    // anchors that did not match, and without this both would have been read
    // as surviving mutants.
    const verdict = classifyApplication({
      anchorsBefore: 0,
      replacementsAfter: 0,
    });
    expect(verdict.applied).toBe(false);
    expect(verdict.reason).toMatch(/no-op/);
  });

  it('rejects an anchor that matched more places than the arm claims', () => {
    expect(
      classifyApplication({ anchorsBefore: 3, replacementsAfter: 3 }).applied,
    ).toBe(false);
  });

  it('rejects a write whose replacement is not on disk afterwards', () => {
    expect(
      classifyApplication({ anchorsBefore: 1, replacementsAfter: 0 }).applied,
    ).toBe(false);
  });

  // NEGATIVE CONTROL: without this, every assertion above is satisfied by a
  // function that returns applied:false unconditionally.
  it('accepts a mutation that did land', () => {
    expect(
      classifyApplication({ anchorsBefore: 1, replacementsAfter: 1 }).applied,
    ).toBe(true);
  });

  it('counts occurrences without overlapping, and refuses an empty needle', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(() => countOccurrences('abc', '')).toThrow(/empty string/);
  });
});

describe('proving the file came back', () => {
  const pinnedHash = 'a'.repeat(40);

  it('catches a file that never returned to its pinned blob', () => {
    expect(
      classifyRestore({
        pinnedHash,
        actualHash: 'b'.repeat(40),
        porcelainBefore: '',
        porcelainAfter: '',
        residueCount: 0,
      }).restored,
    ).toBe(false);
  });

  it('catches mutation residue even when the hash somehow agrees', () => {
    expect(
      classifyRestore({
        pinnedHash,
        actualHash: pinnedHash,
        porcelainBefore: '',
        porcelainAfter: '',
        residueCount: 1,
      }).restored,
    ).toBe(false);
  });

  it('catches a dirty tree that the single-file hash cannot see', () => {
    // The hash reading is per-file, so damage to a neighbouring file is
    // invisible to it. This is why all three readings are required.
    expect(
      classifyRestore({
        pinnedHash,
        actualHash: pinnedHash,
        porcelainBefore: '',
        porcelainAfter: ' M scripts/other.mjs',
        residueCount: 0,
      }).restored,
    ).toBe(false);
  });

  // NEGATIVE CONTROL for the arm above, and a regression: an absolute
  // porcelain reading confounded every arm of a real run because the file
  // under test was untracked and reported `??` before the run started. An arm
  // confounded by a condition that predates it is a false alarm, and the
  // remedy for a false alarm is to stop using the instrument.
  it('does not blame an arm for dirt that was already there', () => {
    const existing = '?? scripts/mutation-harness.mjs\n M src/other.ts';
    expect(
      classifyRestore({
        pinnedHash,
        actualHash: pinnedHash,
        porcelainBefore: existing,
        porcelainAfter: existing,
        residueCount: 0,
      }).restored,
    ).toBe(true);
  });

  it('still catches new dirt introduced alongside pre-existing dirt', () => {
    expect(
      classifyRestore({
        pinnedHash,
        actualHash: pinnedHash,
        porcelainBefore: '?? scripts/mutation-harness.mjs',
        porcelainAfter: '?? scripts/mutation-harness.mjs\n M src/snapshot.snap',
        residueCount: 0,
      }).reason,
    ).toContain('src/snapshot.snap');
  });

  // NEGATIVE CONTROL for the three above.
  it('accepts a genuine restore', () => {
    expect(
      classifyRestore({
        pinnedHash,
        actualHash: pinnedHash,
        porcelainBefore: '',
        porcelainAfter: '',
        residueCount: 0,
      }).restored,
    ).toBe(true);
  });

  it('refuses to verify a restore with nothing pinned to compare against', () => {
    expect(() => classifyRestore({ actualHash: pinnedHash })).toThrow(
      /pinnedHash is required/,
    );
  });
});

describe('a confounded arm is not a surviving arm', () => {
  const applied = { applied: true, reason: 'ok' };
  const restored = { restored: true, reason: 'ok' };

  // THE LAUNDERING TEST. An arm whose mutation never landed but whose suite
  // went red for an unrelated reason must not be reported as killed -- that
  // manufactures an assurance the run did not earn.
  it('does not call an unapplied mutation killed, even when the suite is red', () => {
    const arm = classifyArm({
      application: { applied: false, reason: 'anchor matched 0 times' },
      restore: restored,
      summary: { failed: 4, passed: 10 },
    });
    expect(arm.state).toBe(ARM_CONFOUNDED);
    expect(arm.state).not.toBe(ARM_KILLED);
  });

  it('does not call an unapplied mutation survived when the suite is green', () => {
    const arm = classifyArm({
      application: { applied: false, reason: 'anchor matched 0 times' },
      restore: restored,
      summary: { failed: 0, passed: 17 },
    });
    expect(arm.state).toBe(ARM_CONFOUNDED);
    expect(arm.state).not.toBe(ARM_SURVIVED);
  });

  it('confounds an arm whose restore did not land, however the suite read', () => {
    expect(
      classifyArm({
        application: applied,
        restore: { restored: false, reason: 'residue' },
        summary: { failed: 1, passed: 16 },
      }).state,
    ).toBe(ARM_CONFOUNDED);
  });

  it('confounds an arm whose result could not be extracted', () => {
    expect(
      classifyArm({ application: applied, restore: restored, summary: null })
        .state,
    ).toBe(ARM_CONFOUNDED);
  });

  it('calls a landed mutation with a red suite killed', () => {
    const arm = classifyArm({
      application: applied,
      restore: restored,
      summary: { failed: 2, passed: 15 },
    });
    expect(arm.state).toBe(ARM_KILLED);
    expect(arm.failed).toBe(2);
  });

  it('calls a landed mutation with a green suite survived', () => {
    expect(
      classifyArm({
        application: applied,
        restore: restored,
        summary: { failed: 0, passed: 17 },
      }).state,
    ).toBe(ARM_SURVIVED);
  });
});

describe('the run verdict', () => {
  const killed = { state: ARM_KILLED, reason: 'k' };
  const survived = { state: ARM_SURVIVED, reason: 's' };
  const confounded = { state: ARM_CONFOUNDED, reason: 'c' };

  it('exits 0 only when every arm was killed', () => {
    expect(evaluateRun([killed, killed]).exitCode).toBe(0);
  });

  it('exits 1 for a surviving mutant', () => {
    expect(evaluateRun([killed, survived]).exitCode).toBe(1);
  });

  // Confounded outranks survived. A surviving mutant is a finding, and an
  // unreadable run must never be published as one.
  it('exits 2 when any arm is confounded, even alongside a survivor', () => {
    const result = evaluateRun([killed, survived, confounded]);
    expect(result.exitCode).toBe(2);
    expect(result.verdict).toBe('confounded');
  });

  it('gives the three verdicts three different exit codes', () => {
    const codes = [
      evaluateRun([killed]).exitCode,
      evaluateRun([survived]).exitCode,
      evaluateRun([confounded]).exitCode,
    ];
    expect([...new Set(codes)].sort()).toEqual([0, 1, 2]);
  });

  it('says plainly that a confounded run contains no findings', () => {
    const arms = [survived, confounded];
    expect(formatRun(evaluateRun(arms), arms)).toMatch(
      /A confounded arm is not a surviving arm/,
    );
  });

  it('does not print that warning when nothing is confounded', () => {
    const arms = [killed, survived];
    expect(formatRun(evaluateRun(arms), arms)).not.toMatch(/confounded arm is/);
  });
});

describe('running an arm against a real file in a real repository', () => {
  let dir: string;
  let target: string;
  let original: string;
  let pinnedHash: string;

  const probe = (file: string) => [
    process.execPath,
    '-e',
    `const t=require('fs').readFileSync(${JSON.stringify(file)},'utf8');` +
      `if(t.includes('GUARD')){console.log('      Tests  17 passed (17)');}` +
      `else{console.log('      Tests  1 failed | 16 passed (17)');}`,
  ];

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mutation-harness-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'v@example.com'], {
      cwd: dir,
    });
    execFileSync('git', ['config', 'user.name', 'V'], { cwd: dir });
    // Hermetic against a machine with core.autocrlf=true globally: git would
    // normalise line endings and hash-object would answer for a file that is
    // not the one on disk, which is the exact class of blindness under test.
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
    target = path.join(dir, 'subject.mjs');
    original = 'export const GUARD = true;\n';
    writeFileSync(target, original);
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'subject'], { cwd: dir });
    pinnedHash = hashWorkingFile(target, dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('kills a real mutation and puts the file back', () => {
    const arm = runArm({
      filePath: target,
      original,
      pinnedHash,
      anchor: 'GUARD',
      replacement: 'REMOVED',
      testCommand: probe(target),
      label: 'remove the guard',
      cwd: dir,
    });

    expect(arm.state).toBe(ARM_KILLED);
    // The restore is the half that gets skipped, so it is asserted at the disk
    // rather than inferred from the arm having returned.
    expect(readFileSync(target, 'utf8')).toBe(original);
    expect(hashWorkingFile(target, dir)).toBe(pinnedHash);
  });

  it('reports an anchor that does not occur as confounded, not as survived', () => {
    const arm = runArm({
      filePath: target,
      original,
      pinnedHash,
      anchor: 'NOT-IN-THIS-FILE',
      replacement: 'whatever',
      testCommand: probe(target),
      label: 'a typo in the anchor',
      cwd: dir,
    });

    expect(arm.state).toBe(ARM_CONFOUNDED);
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('restores the file even on the arm that never applied', () => {
    // The failure #371 measured is a restore that only runs on the success
    // path. This asserts the tree is clean after the confounded arm above.
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: dir,
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
  });
});
