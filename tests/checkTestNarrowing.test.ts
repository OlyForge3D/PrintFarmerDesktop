// @vitest-environment node
//
// vite's `loadConfigFromFile` (used by HOME 3 below) shells out to esbuild,
// which requires a real `TextEncoder`. Under this project's default `jsdom`
// environment that invariant does not hold and esbuild refuses to run
// ("Invariant violation: ... TextEncoder ... is incorrectly false"); node
// does not have that problem, and this file has no DOM dependency of its
// own, so it opts out of the default the same way
// tests/retargetSweepRealContention.test.ts does for the same reason.
//
// #537. A gate that only reads one home for a committed test narrowing is
// indistinguishable, on a clean tree, from a gate that reads every home --
// both report "no narrowing found". This file is built around that
// observation: every home checked by scripts/check-test-narrowing.mjs gets
// its own positive-control arm that COMMITS a narrowing (in a fixture, never
// against the live repo tree -- the repo's own population of committed
// narrowings is zero, which is exactly why a clean-tree pass proves nothing
// on its own) and asserts the gate refuses it. Without a per-home control, a
// fourth home added later could silently go unchecked and nothing would ever
// turn red -- see the header comment in check-test-narrowing.mjs for why this
// is three separate instruments rather than one enumeration reused three
// times.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkAllHomes,
  checkPackageJsonScripts,
  checkVitestConfig,
  checkWorkflowText,
  detectNarrowingFlag,
  detectWrappedNarrowing,
  extractRunBlocks,
  formatReport,
  isDirectVitestInvocation,
  joinLineContinuations,
  readWorkflowFiles,
  resolveVitestConfigNarrowing,
  tokenizeCommand,
} from '../scripts/check-test-narrowing.mjs';
import type { LoadConfigFromFile } from '../scripts/check-test-narrowing.d.mts';

const FIXTURE_DIR = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'testNarrowing',
);

describe('tokenizeCommand', () => {
  it('splits on whitespace', () => {
    expect(tokenizeCommand('vitest run -t foo')).toEqual([
      'vitest',
      'run',
      '-t',
      'foo',
    ]);
  });

  it('keeps a quoted value with spaces as one token', () => {
    expect(tokenizeCommand('vitest run -t "only this arm"')).toEqual([
      'vitest',
      'run',
      '-t',
      'only this arm',
    ]);
  });

  it('handles single quotes too', () => {
    expect(tokenizeCommand("vitest run -t 'only this arm'")).toEqual([
      'vitest',
      'run',
      '-t',
      'only this arm',
    ]);
  });

  it('returns an empty array for a non-string input', () => {
    expect(tokenizeCommand(undefined)).toEqual([]);
  });
});

describe('detectNarrowingFlag', () => {
  it('CONTROL: finds nothing in an unnarrowed command', () => {
    expect(detectNarrowingFlag(tokenizeCommand('vitest run'))).toBeNull();
  });

  it('catches the bare `-t` form', () => {
    expect(detectNarrowingFlag(tokenizeCommand('vitest run -t foo'))).toEqual({
      flag: '-t',
      value: 'foo',
    });
  });

  it('catches the bare `--testNamePattern` form', () => {
    expect(
      detectNarrowingFlag(tokenizeCommand('vitest run --testNamePattern foo')),
    ).toEqual({ flag: '--testNamePattern', value: 'foo' });
  });

  it('catches the `--testNamePattern=value` form', () => {
    expect(
      detectNarrowingFlag(tokenizeCommand('vitest run --testNamePattern=foo')),
    ).toEqual({ flag: '--testNamePattern', value: 'foo' });
  });

  it('does not confuse an unrelated flag for a narrowing one', () => {
    expect(
      detectNarrowingFlag(tokenizeCommand('vitest run --reporter json')),
    ).toBeNull();
  });
});

describe('isDirectVitestInvocation', () => {
  it('CONTROL: `npm run test` does not invoke vitest directly', () => {
    expect(isDirectVitestInvocation(tokenizeCommand('npm run test'))).toBe(
      false,
    );
  });

  it('recognises `vitest run`', () => {
    expect(isDirectVitestInvocation(tokenizeCommand('vitest run -t x'))).toBe(
      true,
    );
  });

  it('recognises `npx vitest`', () => {
    expect(isDirectVitestInvocation(tokenizeCommand('npx vitest run'))).toBe(
      true,
    );
  });

  it('recognises a direct call to vitest.mjs', () => {
    expect(
      isDirectVitestInvocation(
        tokenizeCommand('node node_modules/vitest/vitest.mjs run'),
      ),
    ).toBe(true);
  });

  it('ROOT CAUSE FIX (Vasquez, review of this PR, round 3): a bare `vitest` word that is merely an ARGUMENT to another program is not a direct invocation', () => {
    // Only the invoked PROGRAM counts, not any token that happens to equal
    // `vitest` -- here `echo` is what actually runs, and `vitest` is just
    // one of its arguments (identical in shape to the "printed message"
    // case elsewhere in this file, but this is the tokeniser-level check
    // itself, independent of any wrapper).
    expect(
      isDirectVitestInvocation(tokenizeCommand('echo vitest -t harmless')),
    ).toBe(false);
  });

  it('still recognises vitest preceded by an environment-variable assignment', () => {
    expect(
      isDirectVitestInvocation(tokenizeCommand('CI=true vitest run -t x')),
    ).toBe(true);
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 4): recognises a path-qualified vitest binary, not just the bare word', () => {
    // node ./node_modules/.bin/vitest is an entirely ordinary way to invoke
    // a locally installed CLI. Round 3's fix compared the invoked program
    // token EXACTLY against `vitest`/`vitest.mjs`, so a path-qualified form
    // of the bare binary (as opposed to the already-handled
    // `.../vitest/vitest.mjs` case) was still missed.
    expect(
      isDirectVitestInvocation(
        tokenizeCommand('node ./node_modules/.bin/vitest run -t x'),
      ),
    ).toBe(true);
  });

  it('recognises vitest launched through `env`, including env assignments and flags before it', () => {
    expect(
      isDirectVitestInvocation(
        tokenizeCommand('env NODE_ENV=production vitest run -t x'),
      ),
    ).toBe(true);
    expect(
      isDirectVitestInvocation(tokenizeCommand('/usr/bin/env vitest run -t x')),
    ).toBe(true);
  });
});

describe('HOME 1: package.json test/test:* scripts', () => {
  it('CONTROL: a clean scripts object produces no violations', () => {
    const violations = checkPackageJsonScripts({
      test: 'vitest run',
      'test:strict': 'node scripts/vitest-strict.mjs',
      'test:watch': 'vitest',
      build: 'vite build',
    });
    expect(violations).toEqual([]);
  });

  it('POSITIVE CONTROL: refuses a narrowing committed to "test"', () => {
    const violations = checkPackageJsonScripts({
      test: 'vitest run -t "only this arm"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL: refuses a narrowing committed to a "test:*" script', () => {
    const violations = checkPackageJsonScripts({
      'test:unit': 'vitest run --testNamePattern="only this arm"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test:unit',
      flag: '--testNamePattern',
      value: 'only this arm',
    });
  });

  it('ignores narrowing in a script that is not a test script', () => {
    // e2e is `test:e2e`, which the (test:.*)? pattern... wait, this IS a test
    // script by name. Use a script name outside the test/test:* family to
    // prove the filter is scoped, not merely permissive.
    const violations = checkPackageJsonScripts({
      lint: 'eslint . -t "not a vitest flag"',
    });
    expect(violations).toEqual([]);
  });

  it('does not false-positive on a script that merely mentions "-t" in prose-like text', () => {
    const violations = checkPackageJsonScripts({
      test: 'vitest run',
    });
    expect(violations).toEqual([]);
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR): refuses a narrowing committed through a programmatic wrapper', () => {
    // node -e spawns vitest itself, rather than being invoked as a bare
    // shell word -- the flag and value are still committed as literal
    // strings, just nested inside the JS source rather than shell-separated.
    const violations = checkPackageJsonScripts({
      test: "node -e \"spawnSync('vitest',['run','-t','only this arm'])\"",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('does not false-positive a wrapper-shaped script that never mentions vitest', () => {
    const violations = checkPackageJsonScripts({
      test: "node -e \"spawnSync('eslint',['.','-t','unrelated pattern'])\"",
    });
    expect(violations).toEqual([]);
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 2): refuses a narrowing committed through a single-string exec() wrapper', () => {
    // child_process.exec (unlike spawnSync) takes one shell-parsed command
    // STRING rather than a (command, argsArray) pair -- a different real
    // call shape than the round-1 spawnSync fixture, and one the round-1
    // fix did not yet recognise.
    const violations = checkPackageJsonScripts({
      test: 'node -e "exec(\'vitest run -t "only this arm"\')"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 2): follows an npm run alias chain to the script that actually narrows', () => {
    // "test" itself never mentions vitest or a narrowing flag -- it only
    // names another script. `npm run test` (what CI actually invokes)
    // reaches the narrowing committed to "ci" exactly as surely as if it
    // were written inline.
    const violations = checkPackageJsonScripts({
      test: 'npm run ci',
      ci: 'vitest run -t "only this arm"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      command: 'vitest run -t "only this arm"',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('follows an npm run alias chain more than one hop deep', () => {
    const violations = checkPackageJsonScripts({
      test: 'npm run ci',
      ci: 'npm run ci:unit',
      'ci:unit': 'vitest run --testNamePattern="only this arm"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '--testNamePattern',
      value: 'only this arm',
    });
  });

  it('does not loop forever on a cyclic npm run alias chain, and reports no narrowing', () => {
    const violations = checkPackageJsonScripts({
      test: 'npm run a',
      a: 'npm run test',
    });
    expect(violations).toEqual([]);
  });

  it('does not false-positive when an alias points at a script that does not exist', () => {
    const violations = checkPackageJsonScripts({
      test: 'npm run does-not-exist',
    });
    expect(violations).toEqual([]);
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 3): refuses a narrowing committed through a template-literal exec() wrapper', () => {
    // Round 2 added the single-string exec() shape (`'...'`/`"..."`); round
    // 3 found the identical call shape written as a template literal
    // (backtick-delimited) still bypassed detection.
    const violations = checkPackageJsonScripts({
      test: 'node -e "exec(`vitest run -t "only this arm"`)"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('does NOT false-positive (Vasquez, review of this PR, round 3): an exec() wrapper whose inner string only prints, never invokes, vitest', () => {
    // The wrapped string is itself `echo vitest -t harmless` -- `echo`
    // still only prints, so the "-t harmless" it prints is never executed
    // by anything, exactly like an unwrapped `echo vitest -t harmless`
    // would be. Round 3 found this false-positived because the OLD
    // `isDirectVitestInvocation` treated any bare `vitest` token as a
    // direct invocation, so the nested check misclassified `echo`'s
    // argument as if `echo` itself were vitest.
    const violations = checkPackageJsonScripts({
      test: 'node -e "exec(\'echo vitest -t harmless\')"',
    });
    expect(violations).toEqual([]);
  });
});

describe('HOME 2: workflows invoking vitest directly', () => {
  it('CONTROL: extractRunBlocks reads an inline run: step', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: npm run test',
    ].join('\n');
    expect(extractRunBlocks(contents)).toEqual([
      { lineNumber: 5, command: 'npm run test' },
    ]);
  });

  it('CONTROL: extractRunBlocks reads a block-scalar run: step', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: |',
      '          echo hello',
      '          vitest run',
      '      - name: Next step',
      '        run: echo next',
    ].join('\n');
    const blocks = extractRunBlocks(contents);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      lineNumber: 5,
      command: 'echo hello\nvitest run',
    });
    expect(blocks[1]).toEqual({ lineNumber: 9, command: 'echo next' });
  });

  it('CONTROL: a workflow that runs `npm run test` produces no violations', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: npm run test',
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toEqual([]);
  });

  it('POSITIVE CONTROL: refuses a narrowing on a direct `vitest run -t` step', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: vitest run -t "only this arm"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      location: 'ci.yml:5',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL: refuses a narrowing inside a multi-line block-scalar step', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: |',
      '          echo about to test',
      '          npx vitest run --testNamePattern="only this arm"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '--testNamePattern',
      value: 'only this arm',
    });
  });

  it('does not flag a narrowing-shaped flag on a command that is not vitest', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Not vitest',
      '        run: eslint . -t "still not vitest"',
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toEqual([]);
  });

  it('CONTROL: joinLineContinuations passes an unbroken command through unchanged', () => {
    expect(joinLineContinuations('vitest run -t foo')).toBe(
      'vitest run -t foo',
    );
  });

  it('joinLineContinuations rejoins a trailing-backslash line with the next one', () => {
    const continued = ['vitest run \\', '  -t "only this arm"'].join('\n');
    expect(joinLineContinuations(continued)).toBe(
      'vitest run  -t "only this arm"',
    );
  });

  it('detectWrappedNarrowing (unit): matches the quoted eq-form flag directly', () => {
    const violation = detectWrappedNarrowing(
      "node -e \"spawnSync('vitest',['run','--testNamePattern=only this arm'])\"",
    );
    expect(violation).toMatchObject({
      flag: '--testNamePattern',
      value: 'only this arm',
    });
  });

  it('detectWrappedNarrowing (unit): matches the quoted comma-pair flag/value form', () => {
    const violation = detectWrappedNarrowing(
      "node -e \"spawnSync('vitest',['run','-t','only this arm'])\"",
    );
    expect(violation).toMatchObject({ flag: '-t', value: 'only this arm' });
  });

  it('detectWrappedNarrowing (unit): returns null when vitest is never mentioned', () => {
    expect(
      detectWrappedNarrowing(
        "node -e \"spawnSync('eslint',['.','-t','unrelated'])\"",
      ),
    ).toBeNull();
  });

  it('detectWrappedNarrowing (unit): returns null for plain prose mentioning both words unquoted-together', () => {
    expect(
      detectWrappedNarrowing('echo "please do not narrow vitest with -t"'),
    ).toBeNull();
  });

  it('detectWrappedNarrowing (unit, round 2): matches the single-string exec() call shape', () => {
    const violation = detectWrappedNarrowing(
      'exec(\'vitest run -t "only this arm"\')',
    );
    expect(violation).toMatchObject({ flag: '-t', value: 'only this arm' });
  });

  it('detectWrappedNarrowing (unit, round 2): refuses to scan a command whose leading word only prints text', () => {
    expect(
      detectWrappedNarrowing(
        "echo \"spawnSync('vitest',['run','-t','only this arm']) is forbidden\"",
      ),
    ).toBeNull();
  });

  it('detectWrappedNarrowing (unit, round 2): still matches when the same call syntax is genuinely executed by node -e', () => {
    const violation = detectWrappedNarrowing(
      "node -e \"spawnSync('vitest',['run','-t','only this arm'])\"",
    );
    expect(violation).toMatchObject({ flag: '-t', value: 'only this arm' });
  });

  it('detectWrappedNarrowing (unit, round 3): matches the template-literal exec() call shape', () => {
    const violation = detectWrappedNarrowing(
      'exec(`vitest run -t "only this arm"`)',
    );
    expect(violation).toMatchObject({ flag: '-t', value: 'only this arm' });
  });

  it('detectWrappedNarrowing (unit, round 3): does not false-positive on an exec() wrapper that only prints, never invokes, vitest', () => {
    expect(
      detectWrappedNarrowing("exec('echo vitest -t harmless')"),
    ).toBeNull();
  });

  it('POSITIVE CONTROL (Ripley, review of this PR): refuses a narrowing split across a shell line-continuation', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: |',
      '          vitest run \\',
      '            -t "only this arm"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR): refuses a narrowing committed through a programmatic wrapper', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      "        run: node -e \"spawnSync('vitest',['run','-t','only this arm'])\"",
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('does not false-positive a wrapper-shaped step that never mentions vitest', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Not vitest',
      "        run: node -e \"spawnSync('eslint',['.','-t','unrelated pattern'])\"",
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toEqual([]);
  });

  it('does not false-positive on prose that mentions both words without a quoted flag/value pair', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Reminder',
      '        run: echo "don\'t use vitest -t flags in CI"',
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toEqual([]);
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 2): refuses a narrowing committed through a single-string exec() wrapper', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: node -e "exec(\'vitest run -t "only this arm"\')"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('does NOT false-positive (Ripley, review of this PR, round 2): a wrapper-shaped call quoted inside an echo message is a message, not code', () => {
    // The exact shape Ripley demonstrated: the wrapper-call TEXT is
    // identical to the round-1 positive control, but it is the argument to
    // `echo`, which only ever prints it -- it can never execute it.
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Reminder',
      "        run: echo \"spawnSync('vitest',['run','-t','only this arm']) is forbidden\"",
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toEqual([]);
  });

  it('POSITIVE CONTROL (Ripley, review of this PR, round 2): refuses a narrowing split across a folded (`>`) block scalar', () => {
    // Unlike the `|` literal style (round-1 fixture above), `>` FOLDS
    // adjacent non-blank lines into one line joined by a space -- there is
    // no trailing `\` here at all, because folding itself is what turns
    // these two YAML lines into a single shell line.
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: >',
      '          vitest run',
      '          -t "only this arm"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('folds a bare multi-line run: body (no explicit |/> marker) the same way `>` does', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run:',
      '          vitest run',
      '          --testNamePattern="only this arm"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '--testNamePattern',
      value: 'only this arm',
    });
  });

  it('a folded (`>`) block scalar still separates paragraphs at a blank line', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: >',
      '          echo first paragraph',
      '',
      '          echo second paragraph',
    ].join('\n');
    const blocks = extractRunBlocks(contents);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.command).toBe(
      'echo first paragraph\necho second paragraph',
    );
  });

  it('reads the live workflow directory and finds every yml file', () => {
    const workflowsDir = path.join(process.cwd(), '.github', 'workflows');
    const files = readWorkflowFiles(workflowsDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f: { file: string }) => f.file.endsWith('ci.yml'))).toBe(
      true,
    );
  });

  it('POSITIVE CONTROL (Ripley, review of this PR, round 3): refuses a narrowing printed by echo and piped into sh', () => {
    // `echo` alone only ever prints -- OUTPUT_ONLY_COMMANDS correctly
    // exempts it in isolation. Piped into `sh`, the printed text stops
    // being inert: `sh` executes it.
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: echo \'vitest run -t "only this arm"\' | sh',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('does NOT false-positive (round 3): echo piped into a program that is not a known script interpreter', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Not an interpreter',
      "        run: echo \"spawnSync('vitest',['run','-t','only this arm']) is forbidden\" | cat",
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toEqual([]);
  });

  it('POSITIVE CONTROL (Ripley, review of this PR, round 4): refuses a narrowing printed by echo and piped into a path-qualified interpreter', () => {
    // Same shape as the round-3 control above, but `sh` is invoked by its
    // full path (`/bin/bash`) rather than the bare word -- an entirely
    // ordinary way to invoke a shell, and the round-3 fix compared the
    // pipeline stage's program EXACTLY against STDIN_INTERPRETERS, so this
    // slipped past.
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: echo \'vitest run -t "only this arm"\' | /bin/bash',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 4): recognises a direct workflow invocation of a path-qualified vitest binary', () => {
    // node ./node_modules/.bin/vitest is a fairly ordinary way to invoke a
    // locally installed CLI from a workflow step, not an exotic corner case.
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: node ./node_modules/.bin/vitest run -t "only this arm"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Ripley, review of this PR, round 3): reads a folded block scalar header with a chomping indicator and trailing comment', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: >- # narrow the suite',
      '          vitest run',
      '          -t "only this arm"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Ripley, review of this PR, round 3): reads a folded block scalar header with the indentation digit before the chomping indicator', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: >2-',
      '          vitest run',
      '          -t "only this arm"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 3): refuses a narrowing committed through a template-literal exec() wrapper', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: node -e "exec(`vitest run -t "only this arm"`)"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('does NOT false-positive (Vasquez, review of this PR, round 3): an exec() wrapper whose inner string only prints, never invokes, vitest', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Not narrowed',
      '        run: node -e "exec(\'echo vitest -t harmless\')"',
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toEqual([]);
  });
});

describe('HOME 3: vitest.config.ts, resolved the way vitest itself resolves it', () => {
  const loadConfigFromFile: LoadConfigFromFile = async (...args) => {
    const vite = await import('vite');
    return vite.loadConfigFromFile(...args);
  };

  it('CONTROL: a clean config resolves with no narrowing', async () => {
    const violations = await checkVitestConfig({
      configPath: path.join(FIXTURE_DIR, 'clean.vitest.config.ts'),
      cwd: process.cwd(),
      loadConfigFromFile,
    });
    expect(violations).toEqual([]);
  });

  it('POSITIVE CONTROL: refuses a literal committed testNamePattern', async () => {
    const violations = await checkVitestConfig({
      configPath: path.join(FIXTURE_DIR, 'narrowed.vitest.config.ts'),
      cwd: process.cwd(),
      loadConfigFromFile,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'vitest.config.ts',
      flag: 'test.testNamePattern',
      value: 'only this one arm',
    });
  });

  it('POSITIVE CONTROL: catches a computed-key narrowing identically to a literal one (#518 evasion)', async () => {
    const violations = await checkVitestConfig({
      configPath: path.join(
        FIXTURE_DIR,
        'narrowedComputedKey.vitest.config.ts',
      ),
      cwd: process.cwd(),
      loadConfigFromFile,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'vitest.config.ts',
      flag: 'test.testNamePattern',
      value: 'only this one arm',
    });
  });

  it('resolveVitestConfigNarrowing returns null, not a falsy violation object, on a clean config', async () => {
    const result = await resolveVitestConfigNarrowing({
      configPath: path.join(FIXTURE_DIR, 'clean.vitest.config.ts'),
      cwd: process.cwd(),
      loadConfigFromFile,
    });
    expect(result).toBeNull();
  });
});

describe('checkAllHomes: the aggregate gate', () => {
  it('CONTROL: the live repository tree has no committed narrowing in any home', async () => {
    const violations = await checkAllHomes({ cwd: process.cwd() });
    expect(violations).toEqual([]);
  });

  it('aggregates violations across all three homes at once, with injected fixtures', async () => {
    const fakeReadFile = (filePath: string, encoding: string) => {
      if (filePath.endsWith('package.json')) {
        return JSON.stringify({
          scripts: { test: 'vitest run -t "only this arm"' },
        });
      }
      return readFileSync(filePath, encoding as BufferEncoding);
    };
    const fakeReaddir = () => ['fake.yml'];
    const fakeReadWorkflow = (filePath: string) => {
      if (filePath.endsWith('fake.yml')) {
        return [
          'jobs:',
          '  desktop:',
          '    steps:',
          '      - name: Test',
          '        run: vitest run --testNamePattern=only-this-arm',
        ].join('\n');
      }
      return readFileSync(filePath, 'utf8');
    };

    const loadConfigFromFile: LoadConfigFromFile = async (...args) => {
      const vite = await import('vite');
      return vite.loadConfigFromFile(...args);
    };

    const violations = await checkAllHomes({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'narrowed.vitest.config.ts'),
      packageJsonPath: path.join(process.cwd(), 'package.json'),
      workflowsDir: path.join(process.cwd(), '.github', 'workflows'),
      loadConfigFromFile,
      readFile: (filePath: string, encoding: string) => {
        if (filePath.endsWith('package.json'))
          return fakeReadFile(filePath, encoding);
        return fakeReadWorkflow(filePath);
      },
      readdir: fakeReaddir,
    });

    expect(violations).toHaveLength(3);
    expect(violations.map((v) => v.home).sort()).toEqual([
      'package.json',
      'vitest.config.ts',
      'workflow',
    ]);
  });

  it('throws a clear error rather than silently passing when package.json cannot be parsed', async () => {
    const loadConfigFromFile: LoadConfigFromFile = async (...args) => {
      const vite = await import('vite');
      return vite.loadConfigFromFile(...args);
    };
    await expect(
      checkAllHomes({
        cwd: process.cwd(),
        packageJsonPath: path.join(FIXTURE_DIR, 'clean.vitest.config.ts'), // not JSON
        loadConfigFromFile,
      }),
    ).rejects.toThrow();
  });
});

describe('formatReport', () => {
  it('names the home, location, and flag for every violation, not just the first', () => {
    const report = formatReport([
      {
        home: 'package.json',
        location: 'scripts.test',
        flag: '-t',
        value: 'a',
        command: 'vitest run -t a',
      },
      {
        home: 'workflow',
        location: 'ci.yml:5',
        flag: '--testNamePattern',
        value: 'b',
        command: 'vitest run --testNamePattern b',
      },
    ]);
    expect(report).toContain('package.json');
    expect(report).toContain('scripts.test');
    expect(report).toContain('workflow');
    expect(report).toContain('ci.yml:5');
    expect(report).toContain('-t = a');
    expect(report).toContain('--testNamePattern = b');
  });
});
