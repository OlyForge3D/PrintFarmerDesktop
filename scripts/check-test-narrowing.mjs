// #537. A committed test narrowing can silently shrink what a suite verifies,
// invisibly to the suite itself and to any gate that watches only one of its
// homes.
//
// #518 measured that a CLI `-t <pattern>` and a `testNamePattern` committed to
// `vitest.config.ts` are INDISTINGUISHABLE from inside a worker --
// `__vitest_worker__.config` carries the identical resolved value either way.
// The remedy it proposed and this file implements: read the narrowing from
// OUTSIDE vitest, before any worker starts.
//
// #537 is the gap in that remedy. A gate that only resolves
// `vitest.config.ts` is blind to a narrowing committed anywhere else a vitest
// invocation is authored. Measured with the config untouched and
// `"test": "vitest run -t \"<pattern>\""` committed to `package.json` instead:
//
//   worker testNamePattern       /<pattern>/   <- the narrowing IS in force
//   resolved vitest.config.ts    undefined     <- blind
//
// `package.json:test`/`test:*` is not hypothetical: it is the script CI
// actually runs (`ci.yml` runs `npm run test`), so a gate that ignores it
// ignores the more likely home, not a theoretical one.
//
// THREE HOMES, THREE DIFFERENT INSTRUMENTS -- deliberately not one
// enumeration mechanism reused three times:
//
//   vitest.config.ts   resolved via vite's OWN `loadConfigFromFile`, the same
//                      resolution vitest itself performs (`resolveVitestConfig`
//                      below). This is robust to how the pattern got there --
//                      a computed key (`['testName' + 'Pattern']`) resolves to
//                      the same value as a literal one, because resolution
//                      evaluates the module rather than pattern-matching its
//                      source text. #518's history (see
//                      tests/retargetSweepRealContention.test.ts) is a
//                      cautionary tale about source-text matching: two
//                      reviewers defeated it with a computed key and a third
//                      showed it false-red on a comment. This file does not
//                      repeat that mistake for this home.
//
//   package.json       the `test`/`test:*` scripts are shell command lines,
//                      not a JS module to resolve -- there is nothing to
//                      import. `checkPackageJsonScripts` tokenises each
//                      script and looks for `-t`/`--testNamePattern` the same
//                      way `vitest-strict.mjs` already tokenises argv for a
//                      different purpose (selector-vs-flag classification).
//
//   workflows          a workflow `run:` step that invokes vitest directly
//                      (bypassing `npm run test` entirely) is a third command
//                      line, not a config file and not a package.json script.
//                      `checkWorkflowFile` extracts `run:` step bodies
//                      textually -- this repository ships no YAML parser
//                      (see the identical note in
//                      `check-merge-queue-contexts.mjs`) -- and applies the
//                      same tokeniser to any step whose command names
//                      `vitest` directly.
//
// WHY NOT ENUMERATE FURTHER, AND WHY NOT STOP AT THREE
//
// The issue names these three because they are the homes measured or
// observed in this repository today, not because three is the shape of the
// problem. A fourth home (a Makefile, a pre-commit hook, an editor task
// runner) would silently escape all three checks below in exactly the way
// `package.json` escaped a config-only gate. The `vitest.config.ts` check is
// deliberately built on vitest's OWN resolution rather than a bespoke
// enumeration of config-file locations, so it stays correct as vitest's
// config-loading behaviour evolves without this file changing. The other two
// checks are, unavoidably, enumerations of known homes -- there is no
// "resolve the narrowing" primitive for a shell command line the way there is
// for a config module. Widening them (a fourth home) means adding a fourth
// function here, each with its own positive control, the same way this file
// added a second and third; the population being zero today is exactly why
// the positive controls exist as fixtures rather than depending on the live
// tree to demonstrate a real narrowing (see
// tests/checkTestNarrowing.test.ts).
//
// NOT WIRED AS A REQUIRED CI CONTEXT. Per the issue's explicit acceptance
// criterion: a step beside `Closing-reference declaration` lands inside
// `Desktop (matrix)`, two of the seven required contexts -- a false positive
// there blocks every queued PR entry, reproducing #122's deadlock shape. This
// gate's false-positive rate has not been measured, so it ships as a
// standalone script with its own test suite and is not added to any workflow.
//
// THREE REVIEW ROUNDS FOUND HOLES IN THE FIRST TWO VERSIONS, ALL FIXED HERE:
//
//   Ripley (round 1): a workflow `run:` block was split into sub-commands on
//   every newline BEFORE tokenising, so a direct invocation split across a
//   shell line-continuation (`vitest run \` / `  -t "pattern"`) put the flag
//   and its value on different "sub-commands" and neither tokenised to a
//   complete `-t <value>` pair -- the one-line form of the identical command
//   was caught, the continued form was not. `joinLineContinuations` now
//   rejoins a trailing-`\` line with the line that follows it before any
//   splitting happens, so a continued command reaches the tokeniser as the
//   single logical line it always was.
//
//   Vasquez (round 1): a committed wrapper that invokes vitest
//   programmatically --
//   `node -e "spawnSync('vitest',['run','-t','only this arm'])"` -- passed
//   both the package.json and workflow checks silently. The narrowing flag
//   and its value are still committed as literal strings, only nested
//   inside a JS string rather than separated by shell whitespace, so the
//   whitespace tokeniser folded them into one opaque token and
//   `isDirectVitestInvocation` never saw a bare `vitest` word to key off.
//   `detectWrappedNarrowing` is a second, narrower instrument that requires
//   the word `vitest` to appear anywhere in the command AND the flag to
//   appear as a quoted string literal next to its value.
//
//   Ripley (round 2): a `run: >` FOLDED block scalar was still joined with
//   `\n` the same way a `run: |` LITERAL one is, so a narrowing split across
//   two plain lines (no trailing `\` -- folding itself is what turns two
//   YAML lines into one shell line) was split into two sub-commands by
//   `checkWorkflowText`, same failure shape as the round-1 line-continuation
//   finding but for a different YAML mechanism. `foldBlockScalarLines` now
//   reproduces YAML's own fold (adjacent non-blank lines join with a space;
//   a blank line still starts a new paragraph), used for `>` and for a bare
//   `run:` with an indented body and no explicit `|`/`>` marker (YAML folds
//   a plain multi-line scalar the same way).
//
//   Ripley (round 2): `detectWrappedNarrowing` matched a wrapper-shaped
//   string wherever it appeared, so
//   `echo "spawnSync('vitest',['run','-t','only this arm']) is forbidden"`
//   tripped the gate even though `echo` only ever prints its argument and
//   can never execute it. The instrument now refuses to scan a command
//   whose leading word is one of a small, closed set of pure text-output
//   commands (`echo`, `printf`, `cat`, ...) -- it asks whether the command
//   COULD run the text before asking whether the text looks like a call.
//
//   Vasquez (round 2): `exec('vitest run -t "only this arm"')` -- the
//   single shell-parsed command STRING that `child_process.exec` actually
//   takes, as opposed to the `(command, argsArray)` shape `spawnSync` takes
//   -- was missed; only the argv-array shape was recognised.
//   `detectWrappedNarrowing` now also recognises the single-string call
//   shape and re-runs the SAME tokeniser/`detectNarrowingFlag` this file
//   already uses for a direct invocation on the string's own contents,
//   rather than adding a third bespoke regex.
//
//   Vasquez (round 2): `checkPackageJsonScripts` only read the `test`/
//   `test:*` script's own command text, so a narrowing one alias hop away
//   (`"test": "npm run ci"`, with the narrowing committed to `"ci"` instead)
//   was invisible -- `npm run test`, what CI actually invokes, reaches it
//   exactly as surely as an inline command would. `checkPackageJsonScripts`
//   now follows an `npm run <x>` / `yarn <x>` / `pnpm run <x>` reference
//   into whichever script it names, repeatedly (a `visited` set stops a
//   cycle rather than looping), until it finds a narrowing or runs out of
//   script to follow.
//
// A THIRD REVIEW ROUND FOUND FOUR MORE HOLES -- Ralph (work-monitor) flagged
// that three straight rounds each surfacing a new equivalent-class bypass
// (line continuation -> folded scalar -> chomping/comment header;
// spawnSync -> exec-string -> exec-template-literal) looks like the same
// "the population is not enumerable" trap #537's own body warns about, and
// invited (without mandating) a structurally different design. The choice
// made here: keep the static-analysis shape, but stop adding one more
// shape-specific regex per finding and instead fix the ROOT CAUSE that let
// several of round 3's findings through, plus add two small, CLOSED,
// bounded mechanisms (not open-ended enumerations) -- see the reasoning at
// the end of this note for why that is expected to narrow, not eliminate,
// future whack-a-mole risk.
//
//   Ripley (round 3): `OUTPUT_ONLY_COMMANDS` correctly refuses to scan a
//   command whose leading word can only print -- but
//   `echo "spawnSync(...) is forbidden" | sh` pipes that printed text into
//   `sh`, which DOES execute it; the gate never looked past the first
//   pipeline stage. `detectNarrowingThroughPipeline` recognises when a
//   later pipeline stage names one of a small, closed set of programs whose
//   whole purpose is to execute a script handed to them
//   (`STDIN_INTERPRETERS`: `sh`, `bash`, `node`, `python`, ...), and if the
//   first stage is an OUTPUT_ONLY_COMMANDS command, recovers what it prints
//   and recurses `detectNarrowing` on that text -- because once piped to an
//   interpreter, printed text is no longer inert.
//
//   Ripley (round 3): the block-scalar header regex only accepted a
//   chomping indicator BEFORE an indentation digit and no trailing comment,
//   so valid YAML headers like `run: >- # comment` and `run: >2-` (digit
//   before chomping) were misread as inline commands, silently dropping the
//   entire multi-line body. The header regex now accepts either order plus
//   an optional trailing comment, matching what YAML itself accepts.
//
//   Vasquez (round 3): `exec(\`vitest run -t "..."\`)` -- a template
//   literal -- still bypassed `CALL_STRING_FORM`, which only accepted `'`/
//   `"` as the call's string delimiter. Widened to accept a backtick too:
//   the call shape is identical, only the JS string syntax differs.
//
//   Vasquez (round 3): `exec('echo vitest -t harmless')` false-positived.
//   Root cause: `isDirectVitestInvocation` asked "does ANY token equal
//   `vitest`", not "IS `vitest` the invoked program" -- so `vitest` as a
//   bare argument TO `echo` counted as if `echo` were vitest itself. This
//   is a real bug independent of wrappers (it also means a bare
//   `echo vitest -t harmless` typed directly, unwrapped, would have been
//   misclassified) and is what let the round-2 nested-string check for
//   `exec('...')` treat the extracted `echo vitest -t harmless` as a direct
//   invocation. Fixed at the root: only the token in the INVOKED-PROGRAM
//   position counts (the first token, skipping leading `FOO=bar`
//   assignments, or the token after a launcher like `npx`/`node`). The
//   nested-string check in `CALL_STRING_FORM` now also calls the full,
//   recursive `detectNarrowing` (which applies this fixed check AND the
//   OUTPUT_ONLY_COMMANDS gate) instead of a narrower ad hoc re-scan, so this
//   class of false positive cannot recur through that path either.
//
// Why continue patching statically rather than pivot to a canary-run/
// dynamic design: the two round-3 additions are deliberately CLOSED,
// SMALL, STABLE sets (a handful of script interpreters; a handful of
// print-only builtins) rather than enumerations of JS call shapes or shell
// wrapper idioms, which is what kept growing every round. The
// nested-string check is also now recursive through one shared instrument
// (`detectNarrowing`) instead of being re-derived per wrapper shape.
// Together this should meaningfully narrow future bypass classes -- but it
// is a judgement call, not a proof of completeness, and is open to
// reconsideration if a further round finds another equivalent-class
// bypass.
//
// A FOURTH REVIEW ROUND CONFIRMED ALL ROUND-3 FIXES AND FOUND TWO MORE
// FINDINGS, BOTH THE SAME ROOT SHAPE -- Ralph explicitly asked both
// reviewers to weigh proportionality (this gate is non-required,
// defense-in-depth) and only block on material, easily-discoverable gaps.
// Both did, and both findings turned out to be one missing step rather than
// two more shapes to enumerate:
//
//   Vasquez (round 4): `node ./node_modules/.bin/vitest run -t x` -- an
//   ordinary way to invoke a locally installed CLI -- was not recognised as
//   a direct invocation, because the round-3 fix compared the invoked
//   program token EXACTLY against `vitest`/`vitest.mjs` rather than by its
//   basename.
//
//   Ripley (round 4): `echo '...' | /bin/bash` was not recognised as piping
//   into an interpreter, while `| bash` was -- the identical gap, on the
//   interpreter side of the pipeline check instead of the vitest side.
//
// Both are fixed by the same change: `resolveInvokedProgramBasename`
// normalises to a basename before ANY program/interpreter identity
// comparison in this file (vitest itself, a launcher, or a pipeline's
// interpreter stage), instead of each comparison doing its own ad hoc
// exact-match. This also picks up `env` (itself a launcher that takes more
// assignments/flags before naming the real program, e.g.
// `/usr/bin/env bash`, `env NODE_ENV=production vitest run`) for free,
// since it is now just one more thing the shared resolver understands
// rather than a third comparison site to patch separately.
//
// A FIFTH REVIEW ROUND SPLIT -- Vasquez approved (confirmed the round-4
// centralisation is genuine and correct), Ripley rejected: both
// independently found the SAME further gap in `basenameOf` (a path prefix
// was stripped, but not an executable-extension SUFFIX -- `node.exe`,
// `vitest.cmd`, `.\node_modules\.bin\vitest.cmd`, `bash.exe`), and differed
// only on whether it was material. Given this repo's own required CI
// contexts include `windows-latest`, `.cmd`/`.exe` are this repo's native
// Windows invocation form, not a corner case, so this is fixed as material:
// `basenameOf` now also strips a known executable extension
// (`.exe`/`.cmd`/`.bat`/`.mjs`/`.cjs`/`.js`) after taking the path's last
// segment, in the same single shared function every identity comparison in
// this file already goes through -- one more normalisation step in the same
// place, not a fourth comparison site.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const NARROWING_FLAGS = new Set(['-t', '--testNamePattern']);

/**
 * Split a shell command line into argv-like tokens, honouring single and
 * double quotes so `-t "some pattern"` is one flag and one value rather than
 * `-t`, `"some`, `pattern"`. Does not handle every shell metacharacter --
 * this is a lookup instrument for a known flag, not a shell.
 */
export function tokenizeCommand(command) {
  if (typeof command !== 'string') return [];
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Find a committed `-t`/`--testNamePattern` in an already-tokenised command.
 * Returns `{ flag, value }` for the first match, or `null`. Handles both the
 * bare form (`-t <value>`, `--testNamePattern <value>`) and the `=` form
 * (`--testNamePattern=<value>`).
 */
export function detectNarrowingFlag(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (typeof token !== 'string') continue;
    const eq = token.indexOf('=');
    if (eq > 0) {
      const flag = token.slice(0, eq);
      if (NARROWING_FLAGS.has(flag)) {
        return { flag, value: token.slice(eq + 1) };
      }
      continue;
    }
    if (NARROWING_FLAGS.has(token)) {
      const value = tokens[i + 1];
      return { flag: token, value: value === undefined ? '' : value };
    }
  }
  return null;
}

/**
 * Does this tokenised command invoke vitest directly? True for `vitest run`,
 * `npx vitest`, `node .../vitest.mjs`, or a direct call to
 * `.../vitest/vitest.mjs`. False for a command that merely mentions vitest
 * in passing (e.g. `npm run test`, which is the package.json home checked
 * separately, or `echo vitest -t harmless`, where "vitest" is just an
 * argument to a program that isn't vitest at all).
 *
 * Vasquez (review of this PR, round 3): the original check asked "does ANY
 * token equal `vitest`", not "is `vitest` the invoked program" -- so
 * `echo vitest -t harmless` counted as a direct invocation purely because
 * the bare word `vitest` happened to appear as one of `echo`'s arguments,
 * which is a false-positive root cause in its own right and is what let
 * `exec('echo vitest -t harmless')` (nested one level inside a wrapper)
 * slip through as a false NARROWING match once the wrapped value was
 * recursively re-checked with the old, looser definition. Only the
 * INVOKED PROGRAM matters: the first token (after skipping any leading
 * `FOO=bar` environment assignments), or the token immediately after a
 * known launcher (`npx`, `node`, `pnpm`, `yarn`) that takes the real
 * program as its own next argument.
 *
 * Vasquez (review of this PR, round 4): even that fix compared the invoked
 * program token EXACTLY, so a path-qualified vitest binary --
 * `node ./node_modules/.bin/vitest run -t x`, an entirely ordinary way to
 * invoke a locally installed CLI -- was not recognised (the token is
 * `./node_modules/.bin/vitest`, not the bare word `vitest`). Ripley
 * (round 4) found the same root shape from the other side:
 * `echo '...' | /bin/bash` is not recognised as piping into an interpreter,
 * while `| bash` is, because the interpreter check was ALSO an exact-token
 * comparison. Both are the identical gap: program/interpreter identity was
 * never basename-normalised. `resolveInvokedProgramBasename` fixes this
 * once, in one place, for every comparison in this file that asks "which
 * program is this" -- vitest itself, a launcher (`npx`/`node`/...), and a
 * pipeline's interpreter stage all go through it, plus a launcher form this
 * fix picks up for free: `env`, which itself accepts more `FOO=bar`
 * assignments and flags before naming the real program
 * (`/usr/bin/env bash`, `env NODE_ENV=production vitest run`).
 */
export function isDirectVitestInvocation(tokens) {
  const { index, basename } = resolveInvokedProgramBasename(tokens);
  if (isVitestBasename(basename)) return true;
  if (basename !== undefined && VITEST_LAUNCHERS.has(basename)) {
    return isVitestProgramToken(tokens[index + 1]);
  }
  return false;
}

const VITEST_LAUNCHERS = new Set(['npx', 'node', 'pnpm', 'yarn']);
const ENV_LAUNCHER = 'env';
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Windows resolves a bare command name against `PATHEXT` by trying these
// suffixes in turn -- `vitest`, `vitest.cmd`, and `.\node_modules\.bin\
// vitest.cmd` are the SAME program, exactly as `/bin/bash` and `bash` are
// the same program on any platform. This repo's own CI runs on
// `windows-latest` (Ripley, review of this PR, round 5), so these are the
// native Windows invocation form here, not an exotic corner case -- a gate
// that only recognised the extension-less form would be blind on the
// platform this repo actually tests against. `.mjs`/`.cjs`/`.js` are
// included too because `node .../vitest.mjs` (already handled before this
// round via an explicit `vitest.mjs` check) is naturally subsumed once
// extension-stripping happens in the same shared place, rather than kept
// as a separate special case.
const EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat', '.mjs', '.cjs', '.js'];

function stripKnownExecutableExtension(name) {
  const lower = name.toLowerCase();
  for (const ext of EXECUTABLE_EXTENSIONS) {
    if (lower.endsWith(ext) && name.length > ext.length) {
      return name.slice(0, name.length - ext.length);
    }
  }
  return name;
}

/**
 * The last path segment of a token, using it as a bare program name would
 * be used -- `/bin/bash` and `bash` name the same program, and neither this
 * file nor a shell cares which one was typed. Works for both `/`- and
 * `\`-separated paths so a Windows-style path behaves the same way.
 *
 * Vasquez (review of this PR, round 5) and Ripley (round 5) independently
 * found the identical further gap: this stripped a PATH PREFIX but not an
 * EXECUTABLE EXTENSION, so `node.exe`, `vitest.cmd`, and
 * `.\node_modules\.bin\vitest.cmd` were not recognised as the programs they
 * are. One more normalisation step in this same shared function closes it
 * for every comparison in the file at once, the same way path-prefix
 * stripping did in round 4.
 */
function basenameOf(token) {
  if (typeof token !== 'string') return undefined;
  const normalised = token.replaceAll('\\', '/');
  const idx = normalised.lastIndexOf('/');
  const base = idx === -1 ? normalised : normalised.slice(idx + 1);
  return stripKnownExecutableExtension(base);
}

function isVitestBasename(basename) {
  return basename === 'vitest' || basename === 'vitest.mjs';
}

/**
 * Find the token that names the actual invoked program in a tokenised
 * command, skipping constructs that only launch another program rather
 * than being the program themselves: leading `FOO=bar` environment
 * assignments, and the `env` command itself (which, in turn, accepts more
 * `FOO=bar` assignments and flags like `-i`/`-u` before naming the real
 * program it runs). Returns both the token's own INDEX (so a caller can
 * still look at what follows it, e.g. a launcher's own argument) and its
 * basename (so identity comparisons are path-qualification-proof).
 */
function resolveInvokedProgramBasename(tokens) {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(String(tokens[i] ?? ''))) {
    i += 1;
  }
  if (basenameOf(tokens[i]) === ENV_LAUNCHER) {
    i += 1;
    while (
      i < tokens.length &&
      typeof tokens[i] === 'string' &&
      (ENV_ASSIGNMENT.test(tokens[i]) || tokens[i].startsWith('-'))
    ) {
      i += 1;
    }
  }
  return { index: i, basename: basenameOf(tokens[i]) };
}

function isVitestProgramToken(token) {
  return isVitestBasename(basenameOf(token));
}

const TEST_SCRIPT_NAME = /^test(:.*)?$/;

const NPM_SCRIPT_REFERENCE =
  /^(?:npm(?:\s+run(?:-script)?)?|yarn(?:\s+run)?|pnpm(?:\s+run)?)\s+(\S+)/;

/**
 * Vasquez (review of this PR, round 2): a narrowing does not have to live in
 * the `test`/`test:*` script's own command line -- it can hide one hop away,
 * behind an npm/yarn/pnpm script alias:
 *
 *   "test": "npm run ci"
 *   "ci":   "vitest run -t \"only this arm\""
 *
 * `npm run test` -- what CI actually invokes -- reaches the narrowing exactly
 * as surely as if it were written inline, but a check that reads only the
 * `test` script's own text never sees it. This follows the reference --
 * repeatedly, since the chain can be more than one hop deep -- into whichever
 * script it names, with a `visited` set so a cycle (`test` -> `a` -> `test`)
 * reports no narrowing rather than looping forever.
 */
function resolveNarrowingThroughAliasChain(scripts, command, visited) {
  if (typeof command !== 'string') return null;
  const direct = detectNarrowing(command, { requireDirectInvocation: false });
  if (direct !== null) return { narrowing: direct, command };
  const match = NPM_SCRIPT_REFERENCE.exec(command.trim());
  if (match === null) return null;
  const target = match[1];
  if (visited.has(target)) return null;
  visited.add(target);
  return resolveNarrowingThroughAliasChain(scripts, scripts[target], visited);
}

/**
 * Home 1: `test`/`test:*` scripts in package.json.
 *
 * Pure -- takes an already-parsed `scripts` object -- so it is testable
 * without a filesystem and the positive control is just a different object
 * literal.
 */
export function checkPackageJsonScripts(scripts) {
  if (scripts === null || typeof scripts !== 'object') return [];
  const violations = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!TEST_SCRIPT_NAME.test(name)) continue;
    if (typeof command !== 'string') continue;
    const result = resolveNarrowingThroughAliasChain(
      scripts,
      command,
      new Set(),
    );
    if (result !== null) {
      violations.push({
        home: 'package.json',
        location: `scripts.${name}`,
        command: result.command,
        ...result.narrowing,
      });
    }
  }
  return violations;
}

/**
 * Join shell line-continuations (a line ending in a bare trailing `\`) before
 * a multi-line `run:` block is split into sub-commands.
 *
 * Ripley (review of this PR): splitting on every newline before tokenising
 * meant a direct workflow narrowing written across a continued line --
 *
 *   run: |
 *     vitest run \
 *       -t "only this arm"
 *
 * -- put `-t` on one physical line and its value on the next, so neither line
 * tokenised to a `-t <value>` pair and the one-line form of the identical
 * command was the only one caught. This runs before line-splitting so a
 * continued command reaches the tokeniser as the single logical line it is.
 */
export function joinLineContinuations(text) {
  const lines = String(text).split(/\r?\n/);
  const joined = [];
  let buffer = null;
  for (const line of lines) {
    const trimmedEnd = line.replace(/[ \t]+$/, '');
    const continues = trimmedEnd.endsWith('\\');
    const withoutContinuation = continues
      ? trimmedEnd.slice(0, -1)
      : trimmedEnd;
    if (buffer === null) {
      buffer = withoutContinuation;
    } else {
      buffer += ` ${withoutContinuation.trim()}`;
    }
    if (!continues) {
      joined.push(buffer);
      buffer = null;
    }
  }
  if (buffer !== null) joined.push(buffer);
  return joined.join('\n');
}

const WRAPPED_FLAG_EQ_VALUE = /['"](--testNamePattern)=([^'"]*)['"]/;
const WRAPPED_FLAG_THEN_VALUE =
  /['"](-t|--testNamePattern)['"]\s*,\s*['"]([^'"]*)['"]/;

// A committed narrowing can only ever take effect if the text is CODE that
// runs -- it cannot take effect merely by appearing, verbatim, inside a
// string that some other command prints AND NOTHING DOWNSTREAM EVER READS
// AS CODE. `echo`/`printf`/`cat`/... are pure text-output commands: on
// their own, whatever they are given -- including a fragment that happens
// to look exactly like a wrapper call -- is a message, never an
// invocation. Gating on the command's own leading word (not on whether the
// wrapper-shaped text appears anywhere) is what tells "someone typed this
// call" apart from "someone quoted this call in a warning". New executors
// (a shell, an interpreter, a task runner) are deliberately NOT enumerated
// here -- only the closed, small set of commands that can never execute
// anything is excluded, so an unlisted executor is still checked rather than
// silently trusted the way an allow-list would trust it. See
// `detectNarrowingThroughPipeline` below for the one place this exemption is
// deliberately NOT applied: piped into an interpreter, the printed text
// stops being inert.
const OUTPUT_ONLY_COMMANDS = new Set([
  'echo',
  'print',
  'printf',
  'cat',
  'true',
  'false',
  ':',
  'Write-Host',
  'Write-Output',
  'Write-Information',
]);

// A small, closed set of programs whose whole purpose is to read a script
// from somewhere (stdin, `-c`, `-e`/`--eval`) and RUN it. This set is what
// makes a piped-in or handed-in string stop being inert text -- it is
// deliberately not an enumeration of every way vitest could be wrapped (that
// enumeration is what round 2 and round 3 kept finding new members of); it
// is an enumeration of the much smaller, much more stable set of things
// capable of executing arbitrary text at all.
const STDIN_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'ksh',
  'dash',
  'csh',
  'tcsh',
  'node',
  'python',
  'python3',
  'ruby',
  'perl',
]);

// Call-name-adjacent forms only: the flag/value pair must sit inside what
// reads as an actual `child_process` call naming `vitest`, not merely
// anywhere in the text. Two shapes are distinguished because they are the
// two real call shapes Node exposes:
//   spawnSync/spawn/execFile(Sync) take (command, argsArray) -- the array
//   elements are separate, comma-quoted strings (CALL_ARRAY_FORM).
//   exec/execSync take a single, shell-parsed command STRING -- the flag and
//   its value live inside one quoted string, shell-separated by a space, not
//   a comma (CALL_STRING_FORM); that inner string is itself a command line,
//   so it is handed back to the same `detectNarrowing` this file already
//   uses for the direct-invocation case, rather than a bespoke re-scan --
//   see the round-3 fix note below for why that recursion matters.
// Both accept a single, double, OR BACKTICK (template-literal) quote as the
// delimiter -- the call shape is what is being matched, not which of JS's
// three string syntaxes was used to write the literal.
const CALL_ARRAY_FORM =
  /\b(?:spawnSync|spawn|execFile|execFileSync)\s*\(\s*['"]vitest['"]\s*,\s*\[([^\]]*)\]/;
const CALL_STRING_FORM =
  /\b(?:exec|execSync|spawnSync|spawn|execFile|execFileSync)\s*\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/;

/**
 * Vasquez (review of this PR): a committed wrapper that invokes vitest
 * *programmatically* rather than as a bare shell word --
 *
 *   node -e "spawnSync('vitest',['run','-t','only this arm'])"
 *
 * -- passed both `checkPackageJsonScripts` and `checkWorkflowText` silently.
 * The flag and its value are still committed as literal string arguments,
 * they are simply nested inside a JS string rather than separated by shell
 * whitespace, so the whitespace tokeniser folds `-e`'s entire argument into
 * one opaque token and `isDirectVitestInvocation` never sees a bare `vitest`
 * word to key off either.
 *
 * Rounds 2 and 3 kept finding a new SHAPE of wrapper (an `echo` message
 * quoting the call, a single-string `exec()`, a template literal, an `echo`
 * piped into `sh`). Enumerating one more shape every round is exactly the
 * "population is not enumerable" trap #537 itself warns about for narrowing
 * homes generally -- so round 3 stops adding shape-specific regexes as the
 * primary fix and instead corrects the root cause that let each new shape
 * slip past what was already here:
 *
 *   Ripley (round 2): `echo "spawnSync(...) is forbidden"` tripped the gate
 *   -- fixed by OUTPUT_ONLY_COMMANDS (a command that can only print can
 *   never execute what it prints).
 *
 *   Ripley (round 3): `echo "...vitest run -t ..." | sh` still slipped past
 *   OUTPUT_ONLY_COMMANDS, because piped into `sh` the echoed text IS
 *   executed -- by `sh`, not by `echo`. OUTPUT_ONLY_COMMANDS was correct
 *   about `echo` in isolation and wrong about a `echo | sh` PIPELINE, which
 *   is a different, checkable question: does any later pipeline stage name
 *   one of the small set of programs whose job is to execute a script
 *   (STDIN_INTERPRETERS)? `detectNarrowingThroughPipeline` asks exactly
 *   that, and if so, treats the first stage's own printed argument as a
 *   command line in its own right -- recursing into `detectNarrowing`
 *   rather than re-deriving the wrapped/direct split a second time.
 *
 *   Vasquez (round 2): `exec('vitest run -t "only this arm"')` -- the
 *   single-string call shape -- was missed; only the argv-array shape
 *   (`spawnSync`) was recognised. Fixed by CALL_STRING_FORM.
 *
 *   Vasquez (round 3): `exec(\`vitest run -t ...\`)` (a template literal)
 *   still bypassed CALL_STRING_FORM, which only accepted `'`/`"` as the
 *   call's string delimiter. CALL_STRING_FORM now accepts a backtick too --
 *   the call shape didn't change, only which of JS's three string syntaxes
 *   was used to write it, so this is a widened quote-character class, not a
 *   new enumerated shape.
 *
 *   Vasquez (round 3): the round-2 fix for `exec('...')` re-scanned the
 *   extracted inner string with the bare tokeniser/`detectNarrowingFlag`,
 *   which used the OLD, looser `isDirectVitestInvocation` (see that
 *   function's own comment) -- so `exec('echo vitest -t harmless')`
 *   false-positived: the extracted inner string `echo vitest -t harmless`
 *   has `vitest` as a bare TOKEN, and the old check treated any token
 *   matching as a direct invocation. That root cause is fixed on
 *   `isDirectVitestInvocation` itself (only the INVOKED PROGRAM counts, so
 *   `echo`'s own argument no longer counts), and the extracted inner string
 *   is now re-checked with the full, recursive `detectNarrowing` (which
 *   applies that same fixed check, AND the OUTPUT_ONLY_COMMANDS gate, AND
 *   can recurse into a further wrapper) instead of a narrower ad hoc
 *   re-scan -- one shared, correct instrument instead of two.
 */
export function detectWrappedNarrowing(rawText) {
  if (typeof rawText !== 'string') return null;
  if (!/\bvitest\b/.test(rawText)) return null;

  const { basename: leadingBasename } = resolveInvokedProgramBasename(
    tokenizeCommand(rawText),
  );
  if (
    leadingBasename !== undefined &&
    OUTPUT_ONLY_COMMANDS.has(leadingBasename)
  ) {
    return null;
  }

  const arrayMatch = CALL_ARRAY_FORM.exec(rawText);
  if (arrayMatch) {
    const body = arrayMatch[1];
    const eq = WRAPPED_FLAG_EQ_VALUE.exec(body);
    if (eq) return { flag: eq[1], value: eq[2] };
    const pair = WRAPPED_FLAG_THEN_VALUE.exec(body);
    if (pair) return { flag: pair[1], value: pair[2] };
  }

  const stringMatch = CALL_STRING_FORM.exec(rawText);
  if (stringMatch) {
    const inner = stringMatch[2];
    if (/\bvitest\b/.test(inner)) {
      const nested = detectNarrowing(inner, { requireDirectInvocation: true });
      if (nested !== null) return nested;
    }
  }

  const eqMatch = WRAPPED_FLAG_EQ_VALUE.exec(rawText);
  if (eqMatch) return { flag: eqMatch[1], value: eqMatch[2] };
  const pairMatch = WRAPPED_FLAG_THEN_VALUE.exec(rawText);
  if (pairMatch) return { flag: pairMatch[1], value: pairMatch[2] };
  return null;
}

/**
 * Ripley (review of this PR, round 3): a command whose OWN leading word is
 * pure text output (`echo`, `printf`, ...) is exempted by
 * OUTPUT_ONLY_COMMANDS above -- correctly, in isolation. Piped into an
 * interpreter (`| sh`, `| bash`, `| node`, ...), that exemption stops being
 * correct: the text is no longer merely printed to a terminal, it becomes
 * the SCRIPT that interpreter runs. This is deliberately narrow and
 * structural rather than one more wrapper shape to enumerate: it does not
 * try to name every way vitest could be invoked once piped, it recognises
 * the pipe itself and re-runs the full `detectNarrowing` (direct AND
 * wrapped) on whatever text was being printed, exactly as if that text had
 * been the command all along -- because, once piped to an interpreter, it
 * is.
 *
 * Ripley (review of this PR, round 4): `echo '...' | /bin/bash` was not
 * recognised -- only a bare `bash` was, because the interpreter stage was
 * compared exactly rather than by its basename, the identical gap Vasquez
 * found the same round in `isDirectVitestInvocation`. Both the interpreter
 * check and the first stage's own program check now go through
 * `resolveInvokedProgramBasename`, the same shared, basename-normalising
 * resolver `isDirectVitestInvocation` uses -- one fix for one root cause,
 * not two separate patches for what is the same gap seen from two call
 * sites.
 */
function detectNarrowingThroughPipeline(rawCommand) {
  if (typeof rawCommand !== 'string' || !rawCommand.includes('|')) {
    return null;
  }
  const stages = rawCommand
    .split('|')
    .map((stage) => stage.trim())
    .filter((stage) => stage.length > 0);
  if (stages.length < 2) return null;

  const pipesIntoInterpreter = stages.slice(1).some((stage) => {
    const { basename } = resolveInvokedProgramBasename(tokenizeCommand(stage));
    return basename !== undefined && STDIN_INTERPRETERS.has(basename);
  });
  if (!pipesIntoInterpreter) return null;

  const firstStageTokens = tokenizeCommand(stages[0]);
  const { index: firstIndex, basename: firstBasename } =
    resolveInvokedProgramBasename(firstStageTokens);
  if (firstBasename === undefined || !OUTPUT_ONLY_COMMANDS.has(firstBasename)) {
    // The first stage isn't a plain "produce text" command, so there is no
    // printed argument to recover here; `detectNarrowing`'s other checks
    // (direct invocation, wrapped-call forms) already run on the full text
    // independently of this function.
    return null;
  }
  const printedArgument = firstStageTokens.slice(firstIndex + 1).join(' ');
  return detectNarrowing(printedArgument, { requireDirectInvocation: false });
}

/**
 * Try the direct, shell-word tokenised detection first; then, if the
 * command pipes into an interpreter, recover what it actually prints and
 * check that; fall back to the wrapped/programmatic detection last. A
 * command that is direct never needs either fallback, and a command that
 * only mentions vitest in passing (no narrowing flag at all, not piped
 * anywhere) never matches any of the three.
 */
function detectNarrowing(rawCommand, { requireDirectInvocation }) {
  const tokens = tokenizeCommand(rawCommand);
  const isDirect = isDirectVitestInvocation(tokens);
  if (!requireDirectInvocation || isDirect) {
    const direct = detectNarrowingFlag(tokens);
    if (direct !== null) return direct;
  }
  const piped = detectNarrowingThroughPipeline(rawCommand);
  if (piped !== null) return piped;
  return detectWrappedNarrowing(rawCommand);
}

/**
 * Extract `run:` step bodies from a workflow's raw YAML text, textually.
 *
 * This repository ships no YAML parser (see the identical note in
 * `check-merge-queue-contexts.mjs`), and adding one for a single-purpose
 * line scan would be a bigger surface than the scan itself. Handles both the
 * inline form (`run: some command`) and the block-scalar form
 * (`run: |` / `run: >` followed by more-indented lines).
 *
 * Ripley (review of this PR, round 2): every block-scalar form was joined
 * with `\n`, which is only correct for the LITERAL style (`|`) -- YAML's
 * FOLDED style (`>`, and a plain scalar with no `|`/`>` marker at all) folds
 * adjacent non-blank lines into a single line joined by a space instead.
 * Treating a folded body as newline-joined put a continued narrowing --
 *
 *   run: >
 *     vitest run
 *     -t "only this arm"
 *
 * -- on two separate "lines", which `checkWorkflowText` then splits into two
 * separate sub-commands, neither of which tokenises to a complete
 * `-t <value>` pair; the identical narrowing written under `|` (correctly
 * newline-joined, so it needed `joinLineContinuations`'s trailing-`\` to
 * become one line) was caught, the `>` form was not. `foldBlockScalarLines`
 * now reproduces the fold: consecutive non-blank lines join with a space,
 * and a blank line still starts a new paragraph, matching what vitest's own
 * YAML-consuming runner (`actions/runner`) would hand to the shell.
 *
 * Ripley (review of this PR, round 3): the block-scalar HEADER regex only
 * accepted a chomping indicator before an indentation digit (`>-`, `>+2`)
 * and no trailing comment, but valid YAML allows the indentation indicator
 * and chomping indicator in EITHER order (`>2-` is exactly as valid as
 * `>-2`) and a trailing `# comment`. A header the regex didn't recognise --
 * `run: >- # comment` or `run: >2-` -- fell through to the "inline command
 * on the same line as `run:`" branch instead, silently dropping the entire
 * multi-line body (including any narrowing inside it) rather than reading
 * it as the block scalar it actually is. The widened regex accepts the
 * indicator and digit in either order plus an optional trailing comment,
 * matching what YAML itself accepts.
 */
export function extractRunBlocks(contents) {
  const lines = String(contents).split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^(\s*)run:\s?(.*)$/.exec(line);
    if (match === null) continue;
    const indent = match[1].length;
    const rest = match[2].trim();
    const lineNumber = i + 1;

    if (rest.length > 0 && !/^[|>][+-]?\d?[+-]?(?:\s*#.*)?$/.test(rest)) {
      // Inline command on the same line as `run:`.
      blocks.push({ lineNumber, command: rest });
      continue;
    }

    // Block scalar (`|`, `>`, `|-`, `>+`, ... or a bare `run:` immediately
    // followed by more-indented lines, which YAML treats as a plain
    // multi-line scalar and folds the same way `>` does): collect
    // subsequent lines that are indented further than `run:` itself, until
    // dedent or EOF.
    const isLiteral = rest.charAt(0) === '|';
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (candidate.trim().length === 0) {
        body.push('');
        continue;
      }
      const candidateIndent = candidate.length - candidate.trimStart().length;
      if (candidateIndent <= indent) break;
      body.push(candidate.trim());
    }
    i = j - 1;
    const command = isLiteral ? body.join('\n') : foldBlockScalarLines(body);
    blocks.push({ lineNumber, command });
  }
  return blocks;
}

/**
 * Reproduce YAML's folded-scalar (`>`) line joining: consecutive non-blank
 * lines become one line joined by a single space; a blank line closes the
 * current paragraph and starts a new one (represented here as an empty
 * paragraph, preserved as its own `\n`-separated entry so a later split on
 * blank lines still behaves the same way the literal-style body does).
 */
function foldBlockScalarLines(bodyLines) {
  const paragraphs = [];
  let current = [];
  for (const line of bodyLines) {
    if (line === '') {
      if (current.length > 0) {
        paragraphs.push(current.join(' '));
        current = [];
      }
      // A run of one or more blank lines still separates two paragraphs by
      // exactly one `\n` -- it does not accumulate an extra blank line per
      // repetition.
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs.join('\n');
}

/**
 * Home 2: any workflow step whose `run:` body invokes vitest directly, or
 * invokes it through a programmatic wrapper (see `detectWrappedNarrowing`).
 * Line-continuations are joined first (see `joinLineContinuations`) so a
 * command split across physical lines with a trailing `\` is tokenised as
 * the single logical command it is. Splits on newlines and `&&`/`;` so each
 * sub-command is checked independently -- a narrowing does not have to be
 * the only thing on its line.
 */
export function checkWorkflowText(file, contents) {
  const violations = [];
  for (const { lineNumber, command } of extractRunBlocks(contents)) {
    const subCommands = joinLineContinuations(command)
      .split(/\r?\n|&&|;/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !part.startsWith('#'));
    for (const subCommand of subCommands) {
      const narrowing = detectNarrowing(subCommand, {
        requireDirectInvocation: true,
      });
      if (narrowing !== null) {
        violations.push({
          home: 'workflow',
          location: `${file}:${lineNumber}`,
          command: subCommand,
          ...narrowing,
        });
      }
    }
  }
  return violations;
}

/**
 * Home 3: `vitest.config.ts` (or whatever vitest would resolve), read via
 * vite's OWN config resolution -- the same resolution vitest performs before
 * a worker ever starts -- rather than a bespoke re-implementation. This is
 * the home #518 already measured and is deliberately not reimplemented as a
 * source-text match: `loadConfigFromFile` evaluates the module, so a
 * computed key (`['testName' + 'Pattern']`) resolves to the same value as a
 * literal one and is caught identically.
 */
export async function resolveVitestConfigNarrowing({
  configPath,
  cwd,
  loadConfigFromFile,
}) {
  const result = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    configPath,
    cwd,
  );
  const testConfig = result?.config?.test;
  const pattern = testConfig?.testNamePattern;
  if (pattern === undefined || pattern === null || pattern === '') {
    return null;
  }
  return {
    home: 'vitest.config.ts',
    location: configPath,
    command: null,
    flag: 'test.testNamePattern',
    value: String(pattern),
  };
}

export async function checkVitestConfig({
  configPath,
  cwd,
  loadConfigFromFile,
}) {
  const narrowing = await resolveVitestConfigNarrowing({
    configPath,
    cwd,
    loadConfigFromFile,
  });
  return narrowing === null ? [] : [narrowing];
}

export function readWorkflowFiles(
  workflowsDir,
  { readdir = readdirSync, readFile = readFileSync } = {},
) {
  let entries;
  try {
    entries = readdir(workflowsDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({
      file: path.join(workflowsDir, name),
      contents: readFile(path.join(workflowsDir, name), 'utf8'),
    }));
}

/**
 * Run all three homes and return every violation found. Dependencies are
 * injected so the per-home positive controls in
 * tests/checkTestNarrowing.test.ts exercise this function directly against
 * fixture data, never the live repository tree.
 */
export async function checkAllHomes({
  cwd = process.cwd(),
  configPath = path.join(cwd, 'vitest.config.ts'),
  packageJsonPath = path.join(cwd, 'package.json'),
  workflowsDir = path.join(cwd, '.github', 'workflows'),
  loadConfigFromFile = defaultLoadConfigFromFile,
  readFile = readFileSync,
  readdir = readdirSync,
} = {}) {
  const violations = [];

  const configViolations = await checkVitestConfig({
    configPath,
    cwd,
    loadConfigFromFile,
  });
  violations.push(...configViolations);

  let pkg;
  try {
    pkg = JSON.parse(readFile(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `check-test-narrowing: could not read/parse ${packageJsonPath}: ${error.message}`,
    );
  }
  violations.push(...checkPackageJsonScripts(pkg.scripts));

  for (const { file, contents } of readWorkflowFiles(workflowsDir, {
    readdir,
    readFile,
  })) {
    violations.push(...checkWorkflowText(file, contents));
  }

  return violations;
}

export function formatReport(violations) {
  const lines = [];
  lines.push(
    'Refusing: a test narrowing is committed where CI (or a developer running',
  );
  lines.push(
    '`npm test`) would pick it up silently, shrinking what the suite verifies.',
  );
  lines.push('');
  for (const violation of violations) {
    lines.push(`  HOME: ${violation.home}`);
    lines.push(`  AT:   ${violation.location}`);
    lines.push(`  FLAG: ${violation.flag} = ${violation.value}`);
    if (violation.command) lines.push(`  CMD:  ${violation.command}`);
    lines.push('');
  }
  lines.push(
    '  Remove the committed narrowing. A local `-t`/`--testNamePattern` run',
  );
  lines.push(
    '  from the command line is unaffected -- this gate only reads what is',
  );
  lines.push('  committed to the tree.');
  return lines.join('\n');
}

export async function defaultLoadConfigFromFile(...args) {
  const vite = await import('vite');
  return vite.loadConfigFromFile(...args);
}

export async function main({
  loadConfigFromFile = defaultLoadConfigFromFile,
  log = console.error,
} = {}) {
  const violations = await checkAllHomes({ loadConfigFromFile });
  if (violations.length > 0) {
    log(formatReport(violations));
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
