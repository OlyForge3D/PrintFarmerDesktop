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

  it('POSITIVE CONTROL (Vasquez/Ripley, review of this PR, round 5): recognises Windows executable-extension-qualified launcher and binary forms', () => {
    // This repo's own CI runs on windows-latest -- `.cmd`/`.exe` suffixes
    // are the native Windows invocation form here, not an exotic corner
    // case. `npx.cmd`, `node.exe`, and a `.bin\vitest.cmd` path are all the
    // same programs as their extension-less equivalents.
    expect(
      isDirectVitestInvocation(tokenizeCommand('npx.cmd vitest run -t x')),
    ).toBe(true);
    expect(
      isDirectVitestInvocation(
        tokenizeCommand('node.exe node_modules/vitest/vitest.mjs run -t x'),
      ),
    ).toBe(true);
    expect(
      isDirectVitestInvocation(
        tokenizeCommand(
          '.\\node_modules\\.bin\\vitest.cmd run -t "only this arm"',
        ),
      ),
    ).toBe(true);
  });

  it('NEGATIVE CONTROL (Vasquez, review of this PR, round 6): does not misidentify an ordinary project script merely named similarly to vitest', () => {
    // Round 5's first version of extension-stripping stripped `.js`
    // unconditionally, which made `scripts/vitest.js` -- a real, different
    // file that just happens to share vitest's name minus the extension --
    // indistinguishable from the actual vitest binary. Only the Windows
    // executable-WRAPPER extensions (`.exe`/`.cmd`/`.bat`) are OS artifacts
    // safe to strip unconditionally; `.js`/`.cjs` are a real part of a
    // node-ecosystem filename and must not be assumed away.
    expect(
      isDirectVitestInvocation(
        tokenizeCommand('node scripts/vitest.js run -t x'),
      ),
    ).toBe(false);
  });

  it('POSITIVE CONTROL (Ripley, review of this PR, round 6): recognises mixed-case Windows program/path spellings', () => {
    // Windows program and path resolution is case-insensitive --
    // `Vitest.CMD`, `NPX.CMD`, and `BASH.EXE` (used as a pipeline
    // interpreter, see the workflow-level control below) name the exact
    // same programs as their lower-case spellings.
    expect(
      isDirectVitestInvocation(tokenizeCommand('NPX.CMD vitest run -t x')),
    ).toBe(true);
    expect(
      isDirectVitestInvocation(
        tokenizeCommand('.\\node_modules\\.bin\\Vitest.CMD run -t x'),
      ),
    ).toBe(true);
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 7): recognises a direct .ps1 wrapper invocation', () => {
    // npm's own Windows `.bin` shims include a `vitest.ps1` alongside
    // `vitest`/`vitest.cmd` -- this is a DIRECT invocation of the real
    // vitest wrapper, recognised (round 8) by an explicit literal-name
    // check, the same mechanism used for `vitest.mjs`, not by blanket
    // `.ps1` extension-stripping (see the negative control below for why).
    expect(
      isDirectVitestInvocation(
        tokenizeCommand(
          '.\\node_modules\\.bin\\vitest.ps1 run -t "only this arm"',
        ),
      ),
    ).toBe(true);
  });

  it('NEGATIVE CONTROL (Ripley, review of this PR, round 8): does not misidentify an arbitrary script merely because its name collides with a known launcher after extension-stripping', () => {
    // Round 7's first version of this fix put `.ps1` in
    // `WINDOWS_WRAPPER_EXTENSIONS` (the blanket-strip set), which meant a
    // completely unrelated script literally named `node.ps1` (a PowerShell
    // script that has nothing to do with Node.js -- it merely happens to
    // share a name) would strip to `node`, collide with the real `node`
    // launcher name, and cause its next argument to be inspected as if it
    // were `node`'s own invocation of vitest. `.ps1` is a real PowerShell
    // scripting extension (like `.js`/`.mjs`), not an OS-launcher-wrapper
    // artifact (like `.cmd`/`.exe`/`.bat`), so arbitrarily-named `.ps1`
    // files must not be blanket-stripped down to a bare name that can
    // collide with `VITEST_LAUNCHERS`, `STDIN_INTERPRETERS`, or
    // `isVitestBasename`.
    expect(
      isDirectVitestInvocation(tokenizeCommand('node.ps1 vitest run -t x')),
    ).toBe(false);
  });

  it('NEGATIVE CONTROL (Ripley, review of this PR, round 9): an unrelated script literally named vitest.ps1 outside a node_modules tree is not misidentified as the real vitest wrapper', () => {
    // Round 8 moved `.ps1` from blanket-extension-stripping to an explicit
    // literal-name match, which closed the false-positive surface for
    // ARBITRARY `.ps1` filenames but not for a script that happens to be
    // named EXACTLY `vitest.ps1` outside of a real install location --
    // e.g. `.\scripts\vitest.ps1`, a project script with nothing to do
    // with the real vitest binary. The real `vitest.ps1` (npm's own
    // Windows `.bin` shim) always lives inside a `node_modules` tree, so
    // requiring that path context before trusting the extension-qualified
    // literal name closes this without narrowing the literal-name match
    // itself.
    expect(
      isDirectVitestInvocation(
        tokenizeCommand('.\\scripts\\vitest.ps1 run -t x'),
      ),
    ).toBe(false);
  });

  it('POSITIVE CONTROL (Ripley, review of this PR, round 9): still recognises vitest.mjs and vitest.ps1 through other real node_modules layouts, not just .bin', () => {
    // The `node_modules` path-context requirement above must not become so
    // narrow that it only recognises the `.bin` shim shape -- vitest's own
    // package entry file living at `node_modules/vitest/vitest.mjs` (used
    // elsewhere in this file) and a hypothetical nested `.ps1` wrapper
    // under `node_modules` should both still count, since both genuinely
    // sit inside a real install location.
    expect(
      isDirectVitestInvocation(
        tokenizeCommand('node node_modules/vitest/dist/vitest.ps1 run -t x'),
      ),
    ).toBe(true);
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 10): recognises `npm exec vitest` and `npx --yes vitest`, not just the bare launcher-then-vitest form', () => {
    // `npm exec <binary>` runs a binary directly (bypassing package.json
    // scripts entirely, the same as `npx`), and `npx --yes` is an ordinary
    // way to suppress npx's interactive install-confirmation prompt --
    // both are ordinary launcher spellings, not exotic ones. The previous
    // version of this check only recognised `vitest` as the IMMEDIATE next
    // token after the launcher, so the `exec` subcommand and the `--yes`
    // flag in between both defeated it, and `npm` was not even in
    // `VITEST_LAUNCHERS` to begin with.
    expect(
      isDirectVitestInvocation(tokenizeCommand('npm exec vitest run -t x')),
    ).toBe(true);
    expect(
      isDirectVitestInvocation(tokenizeCommand('npx --yes vitest run -t x')),
    ).toBe(true);
  });

  it('NEGATIVE CONTROL (Vasquez, review of this PR, round 10): `npm run <script>` is still not a direct invocation merely because `npm` is now a recognised launcher', () => {
    // Adding `npm` to `VITEST_LAUNCHERS` (for `npm exec vitest`, above)
    // must not make an ordinary `npm run <script-name>` -- which names a
    // package.json script, not a program -- look like a direct invocation
    // just because `npm` now matches the launcher set. That form is
    // resolved through the alias chain (HOME 1's own tests), not here.
    expect(isDirectVitestInvocation(tokenizeCommand('npm run test'))).toBe(
      false,
    );
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

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 10): follows an alias chain through a launcher flag between the package manager and `run`', () => {
    // `npm --silent run ci` is an entirely ordinary way to quiet npm's own
    // output while still running the `ci` script -- the previous
    // regex-based alias resolver required `npm`/`run` to be adjacent, so
    // this exact shape let a narrowing hide one option away from the
    // already-covered `npm run ci` case above.
    const violations = checkPackageJsonScripts({
      test: 'npm --silent run ci',
      ci: 'vitest run -t "only this arm"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('NEGATIVE CONTROL (Vasquez, review of PR #647, round 11): bare `npm ci` is npm\'s own built-in subcommand, not a reference to a "ci" script', () => {
    // Round 10 widened bare-shorthand alias resolution to any `npm <token>`
    // with no `run` keyword, which over-reached: npm always resolves its
    // OWN fixed set of built-in subcommands (`ci`, `install`, `publish`,
    // `audit`, ...) first, regardless of whether a same-named script also
    // exists -- `npm ci` never runs `scripts.ci` bare, only `npm run ci`
    // does. `test: 'npm ci'` here must be read as literally running npm's
    // clean-install command (no narrowing flag in it at all), NOT as a
    // reference to the `ci` script below, which DOES carry a narrowing.
    const violations = checkPackageJsonScripts({
      test: 'npm ci',
      ci: 'vitest run -t "only this arm"',
    });
    expect(violations).toEqual([]);
  });

  it("POSITIVE CONTROL (Vasquez, review of PR #647, round 11): npm's own bare lifecycle shorthand (`npm test`) still resolves to the `test` script", () => {
    // Unlike `npm ci`/`npm install`/other built-ins, `npm test` IS one of
    // npm's own documented bare shorthands for `npm run test` -- narrowing
    // the round-11 fix to an allowlist of npm's real bare lifecycle names
    // (test/start/stop/restart) must not also break this legitimate case.
    const violations = checkPackageJsonScripts({
      test: 'npm test',
      pretest: 'echo unrelated',
    });
    expect(violations).toEqual([]);
    const withNarrowing = checkPackageJsonScripts({
      prepublish: 'npm test',
      test: 'vitest run -t "only this arm"',
    });
    expect(withNarrowing).toHaveLength(1);
    expect(withNarrowing[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('NEGATIVE CONTROL (Vasquez, review of PR #647, round 11): bare `yarn`/`pnpm <token>` (no `run` keyword) is not followed as a script alias', () => {
    // yarn/pnpm DO fall back to running a same-named script for an
    // unrecognised bare subcommand, but only after checking their own
    // (considerably larger) built-in command sets first -- the identical
    // false-positive shape `npm ci` just exposed. No review round has
    // reproduced a concrete yarn/pnpm built-in collision yet, so this file
    // does not follow bare yarn/pnpm shorthand at all rather than guess at
    // an allowlist for tools whose bare-command semantics were not
    // measured here; `run`/`run-script` still resolves it either way.
    const bareYarn = checkPackageJsonScripts({
      test: 'yarn build',
      build: 'vitest run -t "only this arm"',
    });
    expect(bareYarn).toEqual([]);
    const explicitYarnRun = checkPackageJsonScripts({
      test: 'yarn run build',
      build: 'vitest run -t "only this arm"',
    });
    expect(explicitYarnRun).toHaveLength(1);
  });

  it("POSITIVE CONTROL (Vasquez, review of PR #647, round 12): bare `npm restart` falls back to npm's own stop-then-start chain when no `restart` script is defined", () => {
    // npm documents that `npm restart` is not a no-op when `scripts.restart`
    // is absent -- it runs `stop` then `start` instead. Treating `restart`
    // exactly like `test`/`start`/`stop` (only ever resolving to
    // `scripts.restart` itself) missed this real fallback: here, no
    // `restart` script exists, so bare `npm restart` genuinely reaches the
    // narrowed `start` script.
    const violations = checkPackageJsonScripts({
      test: 'npm restart',
      start: 'vitest run -t "only this arm"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Vasquez, review of PR #647, round 12): the restart fallback tries `stop` before `start`', () => {
    // npm runs `stop` first, then `start` -- confirms this file follows the
    // same order rather than only ever reaching `start`.
    const violations = checkPackageJsonScripts({
      test: 'npm restart',
      stop: 'vitest run -t "only this arm"',
      start: 'echo unrelated',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('NEGATIVE CONTROL (Vasquez, review of PR #647, round 12): an explicit `restart` script takes priority over the stop/start fallback', () => {
    // When `scripts.restart` itself exists, npm runs that directly -- the
    // stop/start fallback only applies when no `restart` script is defined
    // at all. A narrowing hiding in `start` here must not be reached,
    // because `npm restart` never gets there.
    const violations = checkPackageJsonScripts({
      test: 'npm restart',
      restart: 'echo ok',
      start: 'vitest run -t "only this arm"',
    });
    expect(violations).toEqual([]);
  });

  it('POSITIVE CONTROL (Vasquez, review of PR #647, round 13): a narrowing in `pretest` runs before `test` and is reached', () => {
    // npm runs `pretest` before `test` for every `npm test`/`npm run test`
    // invocation, whether or not `test` itself narrows. A narrowing that
    // lives only in `pretest` is just as real a narrowing of what CI
    // actually runs as one in `test` itself.
    const violations = checkPackageJsonScripts({
      pretest: 'vitest run -t "only this arm"',
      test: 'echo actual-tests-here',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Vasquez, review of PR #647, round 13): a narrowing in `posttest` is reached', () => {
    // Symmetric with `pretest` -- `posttest` runs after `test` and is just
    // as reachable a home for a narrowing.
    const violations = checkPackageJsonScripts({
      test: 'echo actual-tests-here',
      posttest: 'vitest run -t "only this arm"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it("POSITIVE CONTROL (Vasquez, review of PR #647, round 13): a narrowing in an ALIASED script's own pre-hook is reached, not just the entry script's", () => {
    // `test` aliases to `ci` via `npm run ci`; `ci` itself has a `preci`
    // hook. Because alias resolution recurses through the same
    // name-based resolver, `preci`'s narrowing must be reached exactly as
    // `pretest`'s would be for the entry script.
    const violations = checkPackageJsonScripts({
      test: 'npm run ci',
      preci: 'vitest run -t "only this arm"',
      ci: 'echo actual-tests-here',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it("POSITIVE CONTROL (Vasquez, review of PR #647, round 13): a narrowing in `prestart`/`poststart` is reached through npm restart's stop/start fallback", () => {
    // The restart fallback (round 12) resolves to `stop` then `start` --
    // each of THOSE also carries its own pre/post hooks that must be
    // checked too, not just their own bare command text.
    const violations = checkPackageJsonScripts({
      test: 'npm restart',
      prestart: 'vitest run -t "only this arm"',
      start: 'echo actual-start-here',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('NEGATIVE CONTROL (Vasquez, review of PR #647, round 13): an unrelated `pre`/`post`-prefixed script that is not actually a lifecycle hook is not treated as one', () => {
    // `prepublish` is a REAL npm lifecycle hook name (fires around `npm
    // publish`), but a script like `prebuild` or `pretestdata` that merely
    // happens to start with `pre`/`post` and is not `pre`+the exact entry
    // script name must not be mistaken for that entry script's hook.
    const violations = checkPackageJsonScripts({
      test: 'echo actual-tests-here',
      pretestdata: 'vitest run -t "only this arm"',
    });
    expect(violations).toEqual([]);
  });

  it("NEGATIVE CONTROL (Vasquez and Ripley, review of PR #647, round 14): a hook's narrowing is not reached when the base script it hooks does not exist", () => {
    // Real `npm run ci` errors ("Missing script: \"ci\"") and never runs
    // `preci` at all when `ci` itself has no script -- round 13 checked
    // `preci` unconditionally, flagging this even though the aliased `ci`
    // is never actually reached. The hook must only be consulted once its
    // base script is confirmed to exist.
    const violations = checkPackageJsonScripts({
      test: 'npm run ci',
      preci: 'vitest run -t "only this arm"',
    });
    expect(violations).toEqual([]);
  });

  it("NEGATIVE CONTROL (Vasquez and Ripley, review of PR #647, round 14): the restart fallback does not reach a missing target's hooks either", () => {
    // Real `npm restart` with no `restart` script substitutes `stop` then
    // `start` -- but only for scripts that actually exist. Here `stop`
    // itself has no script, so real npm never runs `stop` at all, and
    // therefore never runs `prestop`/`poststop` either; only `start`
    // (which does exist) is actually reached.
    const violations = checkPackageJsonScripts({
      test: 'npm restart',
      prestop: 'vitest run -t "only this arm"',
      start: 'echo actual-start-here',
    });
    expect(violations).toEqual([]);
  });

  it('POSITIVE CONTROL (Ripley, review of PR #647, round 15): `prerestart`/`postrestart` still run even when `restart` itself falls back to stop/start', () => {
    // npm always runs `prerestart`/`postrestart` around whatever `restart`
    // resolves to -- its OWN script if defined, or the stop/start fallback
    // if not. Round 14's fix moved the fallback branch entirely before the
    // pre/post checks, which meant `prerestart` was skipped outright
    // whenever `scripts.restart` was absent, even though real `npm test`
    // here genuinely runs `prerestart` before falling back to `start`.
    const violations = checkPackageJsonScripts({
      test: 'npm restart',
      prerestart: 'vitest run -t "only this arm"',
      start: 'echo actual-start-here',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
    const postViolations = checkPackageJsonScripts({
      test: 'npm restart',
      start: 'echo actual-start-here',
      postrestart: 'vitest run -t "only this arm"',
    });
    expect(postViolations).toHaveLength(1);
    expect(postViolations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('NEGATIVE CONTROL (Ripley, review of PR #647, round 16): `postrestart` is not reached when the restart fallback chain never actually completes', () => {
    // `stop` is optional in npm's fallback (silently skipped if absent),
    // but `start` is not -- if neither `restart` nor `start` is defined,
    // npm aborts ("missing script: start") before `postrestart` ever
    // fires. Round 15's fix made `postrestart` reachable through the
    // fallback unconditionally, which over-corrected: here, with no
    // `restart`/`stop`/`start` script at all, real npm never gets far
    // enough to run `postrestart`.
    const violations = checkPackageJsonScripts({
      test: 'npm restart',
      postrestart: 'vitest run -t "only this arm"',
    });
    expect(violations).toEqual([]);
  });

  it("POSITIVE CONTROL (Ripley, review of PR #647, round 16): `stop`'s own narrowing is still reached even though the overall restart later aborts on a missing `start`", () => {
    // `stop` genuinely runs (and any narrowing in it is genuinely reached)
    // before npm gets to the point of discovering `start` is missing and
    // aborting -- this must still be flagged even though the chain as a
    // whole never reaches `postrestart`.
    const violations = checkPackageJsonScripts({
      test: 'npm restart',
      stop: 'vitest run -t "only this arm"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Vasquez, review of PR #647, round 15): a `--` end-of-options marker before a dash-prefixed script alias name still resolves it', () => {
    // `--` is npm's (and getopt-style CLIs generally) canonical "end of
    // options" marker -- everything after it is positional, even a token
    // that itself starts with `-`. `npm run -- -ci` names a script
    // literally called `-ci` (an unusual but valid package.json script
    // key); skipping flag tokens with no `--` boundary consumed `-ci` as
    // if it were another option, leaving no alias target resolved at all.
    const violations = checkPackageJsonScripts({
      test: 'npm run -- -ci',
      '-ci': 'vitest run -t "only this arm"',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'package.json',
      location: 'scripts.test',
      flag: '-t',
      value: 'only this arm',
    });
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

  it('POSITIVE CONTROL (Vasquez/Ripley, review of this PR, round 5): recognises Windows executable-extension-qualified forms in a workflow step', () => {
    // This repo's required contexts include windows-latest -- `.cmd` is the
    // native Windows form of a locally installed npm binary, not a corner
    // case, and `npx.cmd`/`bash.exe` are equally ordinary on that platform.
    const npxCmd = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: npx.cmd vitest run -t "only this arm"',
    ].join('\n');
    expect(checkWorkflowText('ci.yml', npxCmd)).toHaveLength(1);

    const binCmd = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: .\\node_modules\\.bin\\vitest.cmd run -t "only this arm"',
    ].join('\n');
    expect(checkWorkflowText('ci.yml', binCmd)).toHaveLength(1);

    const pipedIntoBashExe = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: echo \'vitest run -t "only this arm"\' | bash.exe',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', pipedIntoBashExe);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('POSITIVE CONTROL (Ripley, review of this PR, round 6): recognises PowerShell as a pipeline interpreter and as an inline-script wrapper', () => {
    // This repo's own CI runs on windows-latest -- PowerShell is arguably a
    // MORE natural wrapper there than bash/sh, not a stretch case.
    const pipedIntoPowershellExe = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: echo \'vitest run -t "only this arm"\' | powershell.exe',
    ].join('\n');
    const pipedViolations = checkWorkflowText('ci.yml', pipedIntoPowershellExe);
    expect(pipedViolations).toHaveLength(1);
    expect(pipedViolations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });

    // Not piped -- handed the script directly via `-Command`, the other
    // shape sh/bash/powershell/node/python/ruby/perl all share.
    const inlineCommand = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: pwsh -Command \'vitest run -t "only this arm"\'',
    ].join('\n');
    const inlineViolations = checkWorkflowText('ci.yml', inlineCommand);
    expect(inlineViolations).toHaveLength(1);
    expect(inlineViolations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('NEGATIVE CONTROL (Vasquez, review of this PR, round 6): does not misidentify an ordinary project script merely named similarly to vitest', () => {
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: node scripts/vitest.js run -t "only this arm"',
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toHaveLength(0);
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 7): recognises a direct .ps1 wrapper invocation in a workflow step', () => {
    // npm's own Windows `.bin` shims include a `vitest.ps1` alongside
    // `vitest`/`vitest.cmd` -- this is a direct invocation, not a wrapper
    // shape, so it is checked here rather than only at the unit level.
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: .\\node_modules\\.bin\\vitest.ps1 run -t "only this arm"',
    ].join('\n');
    const violations = checkWorkflowText('ci.yml', contents);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });
  });

  it('NEGATIVE CONTROL (Ripley, review of this PR, round 8): does not misidentify an arbitrary script merely because its name collides with a known launcher after extension-stripping', () => {
    // Round 7's first version of this fix put `.ps1` in the blanket-strip
    // set, so a workflow step invoking a completely unrelated
    // `node.ps1` script (nothing to do with Node.js) would strip to
    // `node`, collide with the real `node` launcher, and cause its
    // argument to be treated as `node`'s own invocation of vitest.
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: node.ps1 vitest run -t "only this arm"',
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toHaveLength(0);
  });

  it('NEGATIVE CONTROL (Ripley, review of this PR, round 9): an unrelated script literally named vitest.ps1 outside a node_modules tree is not misidentified in a workflow step', () => {
    // Round 8's literal-name match for `vitest.ps1` had no path context, so
    // an arbitrary project script coincidentally named exactly that (not
    // npm's real `.bin` shim, which always lives under `node_modules`)
    // would still be misclassified as the real vitest binary.
    const contents = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: .\\scripts\\vitest.ps1 run -t "only this arm"',
    ].join('\n');
    expect(checkWorkflowText('ci.yml', contents)).toHaveLength(0);
  });

  it('POSITIVE CONTROL (Vasquez, review of this PR, round 10): recognises `npm exec vitest` and `npx --yes vitest` direct invocations in a workflow step', () => {
    const execForm = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: npm exec vitest run -t "only this arm"',
    ].join('\n');
    const execViolations = checkWorkflowText('ci.yml', execForm);
    expect(execViolations).toHaveLength(1);
    expect(execViolations[0]).toMatchObject({
      home: 'workflow',
      flag: '-t',
      value: 'only this arm',
    });

    const yesFlagForm = [
      'jobs:',
      '  desktop:',
      '    steps:',
      '      - name: Test',
      '        run: npx --yes vitest run -t "only this arm"',
    ].join('\n');
    const yesFlagViolations = checkWorkflowText('ci.yml', yesFlagForm);
    expect(yesFlagViolations).toHaveLength(1);
    expect(yesFlagViolations[0]).toMatchObject({
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
