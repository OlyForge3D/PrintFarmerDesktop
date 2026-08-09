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
// NOT WIRED AS A REQUIRED CI CONTEXT, AND DELIBERATELY NOT ADDED TO ci.yml AT
// ALL (round 10, Ripley's reachability finding). Per the issue's explicit
// acceptance criterion: a step beside `Closing-reference declaration` lands
// inside `Desktop (matrix)`, two of the seven required contexts -- a false
// positive there blocks every queued PR entry, reproducing #122's deadlock
// shape. This gate's false-positive rate has not been measured, so it ships
// as a standalone script with its own test suite.
//
// Ripley (round 10) found the standalone script was not merely non-required
// but wholly UNREACHABLE: no npm script named it and no workflow invoked it.
// `"check:test-narrowing"` in package.json now gives it the same stable,
// discoverable entrypoint every other `check:*` script in this repo has
// (`npm run check:test-narrowing`). Wiring that entrypoint into `ci.yml`
// itself was considered and deliberately rejected, not skipped: this repo's
// own tests (`ciWorkflowTriggers.test.ts`'s byte-identical rendered-context
// pin, `.squad/skills/testing/SKILL.md`'s CI-gate transcription, and
// `mergeQueueReadiness.test.ts`) treat "a job ci.yml renders" and "a
// required, branch-protection-checked context" as the same thing for EVERY
// job ci.yml currently has -- there is no existing example in this workflow
// of a job that renders a check run without also being required. Adding one
// would mean the first check run this repo has ever rendered from ci.yml
// without requiring it, entangling far more than this script (SKILL.md's
// documented list, three separate pinning tests, and the merge-queue
// classification machinery) for a change the issue's own acceptance
// criterion 3 already says must not be required. `check:test-narrowing` is
// therefore recorded in `UNENFORCED_CHECKS`
// (scripts/check-script-reachability.mjs) instead: its judgement is fully
// exercised under `npm run test` (tests/checkTestNarrowing.test.ts), and its
// main() is a deliberate, documented, tested absence rather than a silent
// one -- exactly the shape `check:review-coverage` and `check:behind-base`
// already use in that same allowlist for their own, differently-reasoned
// unwired mains.
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
//
// A SIXTH REVIEW ROUND confirmed round 5's three reproductions are fixed,
// and found two new things, one from each reviewer, of DIFFERENT kinds:
//
//   Vasquez (round 6): round 5's extension-stripping was too broad -- it
//   stripped `.js`/`.cjs`/`.mjs` unconditionally, so `node scripts/vitest.js
//   run -t "only this arm"` (an ordinary project script that merely happens
//   to be named `vitest.js`, not the real vitest binary) was misidentified
//   as a direct invocation. This is a CORRECTNESS REGRESSION introduced by
//   round 5's own fix, not a missing case -- fixed by narrowing which
//   extensions are stripped unconditionally to the Windows executable
//   WRAPPER extensions only (`.exe`/`.cmd`/`.bat`; see
//   `WINDOWS_WRAPPER_EXTENSIONS`), since only those are OS-level artifacts
//   rather than a real, distinguishing part of a node-ecosystem filename.
//   The real vitest entry file (`vitest.mjs`) is still recognised, but via
//   the pre-existing explicit literal check in `isVitestBasename`, not by
//   assuming every similarly-named `.js`-family file is vitest.
//
//   Ripley (round 6): PowerShell as a wrapper/interpreter was still
//   unrecognised -- `echo '...' | powershell.exe` (piped) and
//   `pwsh -Command 'vitest run -t ...'` (handed a script directly via a
//   flag, not piped) both reproduced as undetected. Given this repo's own
//   CI runs on `windows-latest`, PowerShell is arguably a MORE natural
//   Windows wrapper than `bash`/`sh`, not a stretch finding. Fixed by (a)
//   adding `powershell`/`pwsh` to `STDIN_INTERPRETERS` (closes the piped
//   form, reusing `detectNarrowingThroughPipeline` unchanged) and (b) a new,
//   equally structural `detectNarrowingThroughInlineScriptArgument`, which
//   recognises the OTHER shape these same interpreters share -- being
//   handed a script directly via `-c`/`-Command`/`-e`/`--eval` rather than
//   through stdin -- without enumerating vitest-specific wrapper shapes.
//   Also folded in while touching identity comparisons: mixed-case program
//   names (`Vitest.CMD`, `NPX.CMD`, `BASH.EXE`) are Windows-legal spellings
//   of the same programs, so `basenameOf` now lower-cases its result, the
//   same single shared point every comparison in this file already goes
//   through.
//
// A SEVENTH REVIEW ROUND split again -- Ripley approved (confirmed both
// round-6 fixes hold), Vasquez rejected on one new finding, judged material
// because it is a DIRECT-invocation gap rather than one more wrapper shape:
// `.\node_modules\.bin\vitest.ps1 run -t "only this arm"` -- npm's own
// Windows `.bin` shims include a `.ps1` alongside `vitest`/`vitest.cmd` --
// was not recognised. `.ps1` is the same kind of OS/toolchain wrapper
// artifact as `.exe`/`.cmd`/`.bat` (not a deliberate node-ecosystem filename
// distinction the way `.js`/`.mjs` are, per the round-6 finding above), so
// it is added to the same `WINDOWS_WRAPPER_EXTENSIONS` set rather than
// treated as new mechanism.
//
// Ripley (round 7) also reproduced two further gaps --
// `powershell -EncodedCommand ...` and `wsl bash -c 'vitest run -t ...'` --
// but explicitly classed both as non-blocking given this gate's
// non-required, defense-in-depth role (#537 acceptance criterion 3). They
// are recorded here, deliberately, as a KNOWN, ACCEPTED GAP rather than left
// implicit: `-EncodedCommand` takes a base64-encoded script, which this
// gate's text-based scan cannot decode without materially expanding scope
// (a PowerShell-script-of-arbitrary-encoding is a different kind of problem
// than pattern-matching a plaintext command line), and `wsl <cmd>` runs the
// rest of its argv inside a separate Linux environment this gate has no
// visibility into by design (it reads workflow/package.json/config text,
// not a spawned subprocess's own environment). Revisit if either shape is
// ever found actually committed, rather than closing them pre-emptively.
//
// AN EIGHTH REVIEW ROUND split again -- Vasquez approved (confirmed the
// round-7 `.ps1` fix works, does not reopen the round-6 `.js` false
// positive, and that the documented residual-gaps approach above is
// reasonable). Ripley rejected: round 7's own reasoning for where to put
// `.ps1` was WRONG. `.ps1` is not an OS launcher-wrapper artifact the way
// `.exe`/`.cmd`/`.bat` are (those are safe to blanket-strip because they
// are never a meaningful part of a real script's identity) -- it is a
// genuine PowerShell SCRIPTING extension, in the exact same category as
// `.js`/`.mjs`/`.cjs`, which is precisely why blanket-stripping those
// caused round 6's false positive and had to be reverted to an explicit
// literal-name check instead. Grouping `.ps1` with `.cmd` reintroduced that
// identical mistake one extension later: an arbitrary, unrelated
// `.\scripts\vitest.ps1` would be misclassified as the real vitest binary.
// Fixed exactly as Ripley suggested, mirroring round 6's own resolution:
// `.ps1` is removed from `WINDOWS_WRAPPER_EXTENSIONS` (which now strips
// only `.exe`/`.cmd`/`.bat` again), and `vitest.ps1` is added to the same
// explicit-literal-name check `isVitestBasename` already used for
// `vitest.mjs` (now `VITEST_LITERAL_NAMES`, a small named set instead of
// two inline string comparisons, since it grew a member) -- same
// mechanism, right list.
//
// A NINTH REVIEW ROUND split again -- Vasquez approved (confirmed the `.ps1`
// fix, now living in `VITEST_LITERAL_NAMES`, closes round 8's false
// positive and the `node.ps1` basename collision, without regressing any
// prior Vasquez-reviewed case). Ripley rejected: the `.ps1` fix narrowed the
// false-positive surface but did not eliminate it -- see
// `VITEST_LITERAL_NAMES` below and `hasNodeModulesPathContext`, which was
// added this round precisely because Ripley generalised the finding beyond
// `.ps1`: literal-name matching by basename alone, with no path context,
// was ALREADY wrong for `vitest.mjs` too, and this round closes it for both
// uniformly rather than patching `.ps1` again in isolation.
//
// A TENTH REVIEW ROUND found two detection gaps (both Vasquez) and one
// structural gap (Ripley) that is not about detection at all:
//
//   Vasquez (round 10): `checkPackageJsonScripts({ test: 'npm --silent run
//   ci', ci: 'vitest run -t "only this arm"' })` returned no violation --
//   the alias-chain resolver required the package-manager token and the
//   `run` keyword to be textually ADJACENT, so any flag between them
//   (`--silent`, `--quiet`, ...) broke the match and the chain was never
//   followed into `ci`, silently treating a resolvable alias as an opaque,
//   harmless string. `resolveScriptAliasTarget` replaces that regex with a
//   tokenising resolver that explicitly skips flag tokens both before and
//   after the `run`/`run-script` keyword -- the same "skip flag tokens"
//   idiom this file already used for `env`'s own flags in
//   `resolveInvokedProgramBasename`, applied here for the third time rather
//   than invented a third way.
//
//   Vasquez (round 10): `npm exec vitest run -t "only this arm"` and `npx
//   --yes vitest run -t "only this arm"` both passed `checkWorkflowText`
//   silently. Two compounding gaps: `npm` was entirely absent from
//   `VITEST_LAUNCHERS`, and even for launchers already recognised,
//   `isDirectVitestInvocation` read the token IMMEDIATELY after the
//   launcher as "the launched program", so a subcommand marker (`exec`) or
//   a leading flag (`--yes`) in between meant the real target token was
//   never reached. `findLauncherTargetToken` now skips both `-`-prefixed
//   flags and a small `LAUNCHER_SUBCOMMAND_MARKERS` set (`exec`, `--`)
//   before reading the target -- and `npm` joins `VITEST_LAUNCHERS`. A
//   negative control (`npm run test` must still read as an ORDINARY script
//   reference, not a direct invocation, now that `npm` is a launcher) pins
//   that this widening does not reopen a false positive on the single most
//   common command line in the whole repo.
//
//   Ripley (round 10): the gate was not reachable from any real execution
//   path at all -- no npm script named it, and no workflow ran it, so nine
//   rounds of hardening the DETECTION logic sat behind an entrypoint that
//   nothing ever called. `"check:test-narrowing"` now exists in
//   package.json, following this repo's own `check:*` naming convention.
//   Wiring that script into `ci.yml` was considered and declined -- see the
//   "NOT WIRED AS A REQUIRED CI CONTEXT" note above for the full reasoning
//   -- and `check:test-narrowing` is instead recorded in
//   `UNENFORCED_CHECKS` (scripts/check-script-reachability.mjs), the exact
//   allowlist this repo already uses for every other check whose judgement
//   is enforced under `npm run test` but whose CLI entrypoint is not yet
//   wired to a live trigger, so the absence is documented and tested rather
//   than silent.

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
  if (isVitestBasename(basename, tokens[index])) return true;
  if (basename !== undefined && VITEST_LAUNCHERS.has(basename)) {
    return isVitestProgramToken(findLauncherTargetToken(tokens, index + 1));
  }
  return false;
}

const VITEST_LAUNCHERS = new Set(['npx', 'npm', 'node', 'pnpm', 'yarn']);
const ENV_LAUNCHER = 'env';
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Vasquez (review of this PR, round 10): the launcher branch above only
// recognised the launched program when it was the IMMEDIATE next token --
// `npx vitest ...` matched, but `npx --yes vitest ...` and
// `npm exec vitest ...` (both ordinary, common launcher spellings: `--yes`
// suppresses npx's interactive install-confirmation prompt, and `exec` is
// how npm/pnpm/yarn run a binary directly without it being a package.json
// script) did not, because the token in between (`--yes`, `exec`) was
// never skipped. `npm` itself was also missing from `VITEST_LAUNCHERS`
// entirely -- only `npx`/`node`/`pnpm`/`yarn` were recognised as launchers,
// so `npm exec vitest ...` failed at the very first step regardless.
//
// Fixed by (a) adding `npm` to `VITEST_LAUNCHERS`, and (b) skipping past
// the launcher's own flags (`--yes`/`-y`/`--silent`/`-s`/etc., recognised
// generically by a leading `-`, exactly as `env`'s own flags are already
// skipped above) and the `exec`/`--` subcommand markers before reading the
// actually-launched program token, rather than assuming it is always the
// very next one.
const LAUNCHER_SUBCOMMAND_MARKERS = new Set(['exec', '--']);

function findLauncherTargetToken(tokens, startIndex) {
  let i = startIndex;
  while (
    i < tokens.length &&
    typeof tokens[i] === 'string' &&
    (tokens[i].startsWith('-') || LAUNCHER_SUBCOMMAND_MARKERS.has(tokens[i]))
  ) {
    i += 1;
  }
  return tokens[i];
}

// Windows resolves a bare command name against `PATHEXT` by trying these
// suffixes in turn -- `vitest`, `vitest.cmd`, and `.\node_modules\.bin\
// vitest.cmd` are the SAME program, exactly as `/bin/bash` and `bash` are
// the same program on any platform. This repo's own CI runs on
// `windows-latest` (Ripley, review of this PR, round 5), so these are the
// native Windows invocation form here, not an exotic corner case -- a gate
// that only recognised the extension-less form would be blind on the
// platform this repo actually tests against.
//
// Vasquez (review of this PR, round 6): round 5's first version of this set
// ALSO included `.js`/`.cjs`/`.mjs`, on the theory that `node .../vitest.mjs`
// (the real vitest package entry file) was "naturally subsumed" by the same
// stripping. That reasoning does not hold for `.js`/`.cjs` the way it does
// for `.exe`/`.cmd`/`.bat`: a Windows executable-wrapper extension is an OS
// artifact, never a deliberate identity distinction a user makes, but a
// `.js`/`.mjs`/`.cjs` suffix genuinely IS part of a file's name in the node
// ecosystem -- `scripts/vitest.js` is a real, different file from `vitest`,
// e.g. an ordinary project script that merely happens to be named that.
// Stripping `.js` unconditionally therefore reintroduced exactly the kind of
// false positive round 3 fixed for `echo vitest -t harmless` (a bare-token
// match standing in for "is this actually the invoked program"), just one
// layer down: `node scripts/vitest.js run -t "only this arm"` was
// misidentified as invoking the real vitest binary. Only the Windows
// executable-WRAPPER extensions are stripped unconditionally here; the real
// vitest entry file's specific name (`vitest.mjs`) is still recognised, but
// via the existing explicit literal check in `isVitestBasename` below, not
// by assuming every `.js`-family file named similarly is vitest.
//
// Vasquez (review of this PR, round 7): `.ps1` was missing -- npm's own
// Windows `.bin` shims include a `vitest.ps1` alongside `vitest`/
// `vitest.cmd`, so `.\node_modules\.bin\vitest.ps1 run -t "only this arm"`
// is a DIRECT invocation of the real vitest wrapper, not a wrapped/piped
// shape, and was still missed.
//
// Ripley (review of this PR, round 8): the round-7 fix put `.ps1` in the
// WRONG set. `.ps1` is not an OS launcher-wrapper artifact the way
// `.exe`/`.cmd`/`.bat` are -- it is a genuine PowerShell SCRIPTING
// extension, in the same category as `.js`/`.mjs`/`.cjs` (which is exactly
// why blanket-stripping THOSE caused round 6's false positive, reverted to
// an explicit-literal check instead). Blanket-stripping `.ps1` here
// reintroduced that identical mistake one extension later:
// `.\scripts\vitest.ps1` (an arbitrary, unrelated PowerShell script that
// merely happens to be named similarly) would be misclassified as the real
// vitest binary. `.ps1` is removed from this set; the real vitest wrapper's
// specific name (`vitest.ps1`) is recognised instead via the same explicit
// literal check `isVitestBasename` already uses for `vitest.mjs` -- the
// right mechanism, just the right list.
const WINDOWS_WRAPPER_EXTENSIONS = ['.exe', '.cmd', '.bat'];

function stripKnownExecutableExtension(name) {
  const lower = name.toLowerCase();
  for (const ext of WINDOWS_WRAPPER_EXTENSIONS) {
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
 * stripping did in round 4. (Round 6 narrowed which extensions this strips
 * -- see `WINDOWS_WRAPPER_EXTENSIONS` above -- but the mechanism, one shared
 * normalisation point, is unchanged.)
 *
 * Ripley (review of this PR, round 6): also noted mixed-case executable
 * names (Windows program/path resolution is case-insensitive: `Vitest.CMD`,
 * `NPX.CMD`, `BASH.EXE` all name the same programs as their lower-case
 * spellings) were not recognised, since every identity comparison in this
 * file (`isVitestBasename`, `VITEST_LAUNCHERS`, `STDIN_INTERPRETERS`,
 * `OUTPUT_ONLY_COMMANDS`) is a case-sensitive Set lookup. Lower-casing the
 * basename here, at the one shared point every one of those comparisons
 * already flows through, fixes it for all of them at once rather than
 * teaching each Set lookup to be case-insensitive separately.
 */
function basenameOf(token) {
  if (typeof token !== 'string') return undefined;
  const normalised = token.replaceAll('\\', '/');
  const idx = normalised.lastIndexOf('/');
  const base = idx === -1 ? normalised : normalised.slice(idx + 1);
  return stripKnownExecutableExtension(base).toLowerCase();
}

// Known literal names for the real vitest binary/wrapper that are not
// safe to derive by stripping an extension -- either because the
// extension is a genuine node-ecosystem scripting extension that could
// legitimately name an unrelated file (`.mjs`, and now `.ps1` -- see
// Ripley, round 8, on `WINDOWS_WRAPPER_EXTENSIONS` above for why `.ps1`
// moved here rather than being blanket-stripped), not an OS-launcher
// artifact. Each of these is vitest's own real, documented Windows/Node
// `.bin` shim name, checked by exact literal match rather than assumed
// from a stripped extension.
//
// Ripley (review of this PR, round 9): moving `.ps1` here from
// `WINDOWS_WRAPPER_EXTENSIONS` narrowed round 8's false-positive surface
// but did not eliminate it -- matching `vitest.mjs`/`vitest.ps1` by
// BASENAME ALONE, with no path context, still misclassifies any arbitrary
// script that happens to be named exactly that (e.g. `.\scripts\vitest.ps1`,
// a project script with nothing to do with the real vitest binary) as the
// real thing. Ripley also flagged this as a pre-existing gap in the
// mechanism itself, not new to `.ps1`: the same reasoning already applied,
// unnoticed, to `vitest.mjs`.
//
// The bare name `vitest` is NOT in the same boat: it names the program by
// however the OS/shell resolves it from `PATH` (or `PATHEXT`), exactly the
// way `bash`/`node`/any other bare command name is invoked and resolved
// throughout this whole file -- there is no "path" to sanity-check for a
// bare command name, and treating an unqualified `vitest` invocation as
// the real vitest binary is the plain, intended reading of that token, not
// an assumption layered on top of it.
//
// `vitest.mjs`/`vitest.ps1`, by contrast, are only ever real as npm's own
// `.bin` shims / the package's own entry file -- both of which always sit
// inside a `node_modules` tree. A script coincidentally sharing that exact
// filename OUTSIDE a `node_modules` path is not that shim. Requiring the
// full invoked token's path to contain a `node_modules` path segment
// before trusting an EXTENSION-QUALIFIED literal name closes this for
// `.mjs` and `.ps1` alike, uniformly, rather than adding another
// per-extension patch.
const VITEST_LITERAL_NAMES = new Set(['vitest', 'vitest.mjs', 'vitest.ps1']);

// Extension-qualified literal names are only trustworthy when the token
// that carried them plausibly comes from a real npm/vitest install
// location -- see the comment on `VITEST_LITERAL_NAMES` above. The bare
// `vitest` name has no such requirement.
const VITEST_LITERAL_NAMES_REQUIRING_NODE_MODULES_CONTEXT = new Set([
  'vitest.mjs',
  'vitest.ps1',
]);

function hasNodeModulesPathContext(token) {
  if (typeof token !== 'string') return false;
  const normalised = token.replaceAll('\\', '/').toLowerCase();
  return normalised.split('/').includes('node_modules');
}

function isVitestBasename(basename, token) {
  if (!VITEST_LITERAL_NAMES.has(basename)) return false;
  if (!VITEST_LITERAL_NAMES_REQUIRING_NODE_MODULES_CONTEXT.has(basename)) {
    return true;
  }
  return hasNodeModulesPathContext(token);
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
  return isVitestBasename(basenameOf(token), token);
}

const TEST_SCRIPT_NAME = /^test(:.*)?$/;

const NPM_SCRIPT_MANAGERS = new Set(['npm', 'yarn', 'pnpm']);
const RUN_KEYWORDS = new Set(['run', 'run-script']);

// npm's own, small, closed set of lifecycle scripts it will run bare, with
// no `run`/`run-script` keyword at all -- `npm test`, `npm start`, `npm
// stop`, `npm restart` are documented npm CLI shorthands for their
// same-named package.json script. Every OTHER bare `npm <token>` (`ci`,
// `install`, `publish`, `audit`, `config`, ...) names one of npm's OWN
// built-in subcommands, which npm always resolves before ever considering
// a package.json script of the same name -- there is no bare-shorthand
// fallback to a script for any name outside this set.
const NPM_BARE_LIFECYCLE_SCRIPTS = new Set([
  'test',
  'start',
  'stop',
  'restart',
]);

/**
 * Skip past any run of flag tokens (anything starting with `-`) starting at
 * `startIndex`, returning the index of the first non-flag token. Shared by
 * both the launcher-target resolution above and the script-alias
 * resolution below, since both need to see past a package manager's own
 * options (`--yes`, `--silent`, `-s`, ...) to find the token that actually
 * names a program or script.
 */
function skipFlagTokens(tokens, startIndex) {
  let i = startIndex;
  while (
    i < tokens.length &&
    typeof tokens[i] === 'string' &&
    tokens[i].startsWith('-')
  ) {
    i += 1;
  }
  return i;
}

/**
 * Resolve the script name an `npm`/`yarn`/`pnpm` command line refers to, if
 * it is one of the "run another package.json script" forms this alias
 * chain follows -- `npm run <name>`, `npm run-script <name>`,
 * `yarn run <name>`, `pnpm run <name>`, or npm's OWN bare lifecycle
 * shorthand (`npm test`/`start`/`stop`/`restart`, see
 * `NPM_BARE_LIFECYCLE_SCRIPTS` above). Returns `null` for anything else,
 * including `npm exec`/`npx` (a DIRECT invocation, handled by
 * `isDirectVitestInvocation`/`VITEST_LAUNCHERS` instead), any other bare
 * `npm <token>` (one of npm's own built-in subcommands, not a script
 * alias), and a bare `yarn`/`pnpm <token>` with no `run` keyword (this file
 * does not follow that shorthand at all -- see the false-positive note
 * below).
 *
 * Vasquez (review of this PR, round 10): the previous regex-based version
 * of this (`NPM_SCRIPT_REFERENCE`) required the package manager name and
 * the `run` keyword to be adjacent, so `npm --silent run ci` -- an
 * entirely ordinary way to quiet npm's own output while still running the
 * `ci` script -- was not recognised as a reference to `ci` at all, letting
 * a narrowing hide behind an alias exactly one option away from the
 * already-handled `npm run ci` shape. Tokenising the command and skipping
 * flag tokens (the same `-`-prefixed recognition already used for other
 * launcher options in this file) before AND after the `run` keyword closes
 * this the same way skipping flags before the actual program in
 * `findLauncherTargetToken` does for direct invocations.
 *
 * Vasquez (review of PR #647, round 11): that same fix, read too broadly,
 * treated ANY bare `npm <token>` (with no `run` keyword at all) as a
 * script-alias reference -- `checkPackageJsonScripts({ test: 'npm ci', ci:
 * 'vitest run -t "only this arm"' })` flagged a violation even though `npm
 * ci` runs npm's OWN built-in `ci` subcommand (a clean-install command),
 * never `scripts.ci`, regardless of whether a script by that name exists.
 * npm resolves its fixed set of built-in subcommands FIRST, always -- a
 * same-named script is never reached bare, only through `npm run ci`.  The
 * only bare exception npm itself documents is a small, closed set of
 * lifecycle shorthands (`test`, `start`, `stop`, `restart`); everything
 * else bare is a built-in, not a fallback to a script. Rather than grow an
 * ever-longer blocklist of npm's own built-ins (`ci`, `install`, `i`,
 * `publish`, `audit`, `config`, `dedupe`, `exec`, `init`, `link`, ... --
 * the same "one more shape" pattern that cost this file ten review rounds
 * elsewhere), this narrows to an ALLOWLIST of the four names npm itself
 * treats as bare script shorthand, which is provably complete rather than
 * provably incomplete: npm defines no others. `yarn`/`pnpm` bare shorthand
 * (`yarn foo` without `run`) is a real fallback those tools DO perform, but
 * only after checking their own considerably larger built-in command sets
 * first (`yarn install`, `yarn add`, `pnpm install`, ...) -- the identical
 * false-positive shape this fix closes for npm. No review round has
 * reproduced it for yarn/pnpm yet, and this file would rather state that
 * plainly than patch it speculatively: bare `yarn`/`pnpm <token>` is
 * therefore not followed as an alias at all (a real, intentional gap --
 * `yarn <script>`/`pnpm <script>` without the `run` keyword still requires
 * `yarn run <script>`/`pnpm run <script>` to be resolved by this file).
 */
function resolveScriptAliasTarget(command) {
  const tokens = tokenizeCommand(command.trim());
  if (tokens.length === 0) return null;
  const manager = basenameOf(tokens[0]);
  if (!NPM_SCRIPT_MANAGERS.has(manager)) return null;
  const afterManager = skipFlagTokens(tokens, 1);
  if (afterManager < tokens.length && RUN_KEYWORDS.has(tokens[afterManager])) {
    const target = tokens[skipFlagTokens(tokens, afterManager + 1)];
    return typeof target === 'string' ? target : null;
  }
  if (manager !== 'npm') return null;
  const bareTarget = tokens[afterManager];
  return typeof bareTarget === 'string' &&
    NPM_BARE_LIFECYCLE_SCRIPTS.has(bareTarget)
    ? bareTarget
    : null;
}

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
 * `test` script's own text never sees it.
 *
 * Rounds 11-12 (Vasquez, review of PR #647) each closed one more shape of
 * npm's own script-resolution semantics that a purely alias-chasing model
 * missed -- npm's closed bare-lifecycle set (round 11), then `restart`'s
 * stop/start fallback (round 12) -- and each fix, read narrowly, missed the
 * next: `restart`'s fallback still didn't account for npm's pre/post hook
 * convention (`pretest`/`posttest`, `prestart`/`poststart`, ...), which
 * apply to EVERY npm-run script, not just the ones this file happened to
 * special-case already. Both reviewers independently flagged this as the
 * same pattern as the earlier interpreter/extension "one more shape"
 * saga (#640) and asked for the underlying model to be made systematic
 * rather than patched once more.
 *
 * `resolveNarrowingForScript` is that systematic model: given ANY script
 * name npm would run (the `test`/`test:*` scripts directly, or any name
 * reached through an alias chain), it evaluates npm's own real execution
 * order for that name --
 *
 *   pre<name> (if defined) -> <name>'s own resolution -> post<name> (if defined)
 *
 * -- where "<name>'s own resolution" is either `scripts[name]` itself, or,
 * for the one name npm documents an irregular fallback for (`restart` with
 * no `scripts.restart` defined), the same pre/post-wrapped resolution of
 * `stop` followed by `start`. Because this is name-based rather than
 * command-text-based, following an alias into another script name (`npm
 * run ci` -> `ci`) recurses through this same function, so THAT script's
 * own pre/post hooks are checked too -- a narrowing hiding behind
 * `preci`/`postci` is reached exactly as a narrowing hiding behind
 * `pretest`/`posttest` on the entry script is. `visited` is threaded
 * through the whole graph (entry script, its hooks, every aliased target,
 * and THEIR hooks) so any cycle reports no narrowing rather than looping
 * forever, rather than resetting per hop.
 *
 * Ripley (review of PR #647, round 12): left a non-blocking note that if
 * npm's lifecycle handling grows further, a small data table would be
 * preferable to more special-cases. `restart`'s stop/start fallback is
 * npm's only documented irregular lifecycle chain -- everything else
 * (arbitrary custom scripts, the plain bare-lifecycle names) follows the
 * uniform pre/name/post shape -- so it remains a single explicit branch
 * here rather than a table with one row, but the shape is intentionally
 * factored so a genuine second irregular chain could be added as a
 * sibling branch without restructuring the pre/post wrapping itself.
 */
function resolveNarrowingForScript(scripts, name, visited) {
  if (visited.has(name)) return null;
  visited.add(name);

  if (name === 'restart' && typeof scripts.restart !== 'string') {
    // npm's restart fallback substitutes `stop` then `start` for the
    // missing `restart` script -- but each of THOSE only actually runs
    // (and only actually triggers ITS OWN pre/post hooks) if that script
    // itself exists. Recursing here, rather than unconditionally checking
    // `prestop`/`poststop`/`prestart`/`poststart`, means an absent `stop`
    // contributes nothing (npm never invokes `stop`'s hooks around a
    // script that isn't there), exactly matching the base-script-must-
    // exist rule enforced below for the ordinary (non-restart) case.
    return (
      resolveNarrowingForScript(scripts, 'stop', visited) ??
      resolveNarrowingForScript(scripts, 'start', visited)
    );
  }

  // Vasquez and Ripley (review of PR #647, round 14): the round-13
  // pre/post model checked `pre<name>`/`post<name>` even when `<name>`
  // itself has no script at all -- a false-positive regression, since
  // real npm errors ("missing script: ...") and never runs pre/post
  // hooks (or the restart fallback above) for a script that does not
  // exist. `test: 'npm run ci'` with no `ci` script but a `preci` that
  // narrows was flagged here even though real `npm run ci` never reaches
  // `preci` at all -- it fails before any hook runs. Requiring the base
  // script to exist BEFORE consulting its hooks (rather than checking
  // hooks unconditionally, then the base script) restores that ordering.
  if (typeof scripts[name] !== 'string') return null;

  const preResult = checkLifecycleHook(scripts, `pre${name}`, visited);
  if (preResult !== null) return preResult;

  const mainResult = checkScriptCommandForNarrowing(
    scripts,
    scripts[name],
    visited,
  );
  if (mainResult !== null) return mainResult;

  return checkLifecycleHook(scripts, `post${name}`, visited);
}

/**
 * Check one pre/post lifecycle hook script (`pre<name>`/`post<name>`) for a
 * narrowing, including through its own alias chain. Unlike the script it
 * hooks, a hook itself gets no further pre/post wrapping of its own (npm
 * has no `prepretest`) -- it is just another command line that may
 * directly narrow or alias elsewhere.
 */
function checkLifecycleHook(scripts, hookName, visited) {
  if (visited.has(hookName)) return null;
  if (typeof scripts[hookName] !== 'string') return null;
  visited.add(hookName);
  return checkScriptCommandForNarrowing(scripts, scripts[hookName], visited);
}

/**
 * Check a single command line for a narrowing -- either directly in the
 * command itself, or one hop further through whatever script it aliases to
 * (which is then checked with its own full pre/main/post resolution via
 * `resolveNarrowingForScript`, so a narrowing behind an aliased script's
 * OWN lifecycle hooks is still reached).
 */
function checkScriptCommandForNarrowing(scripts, command, visited) {
  if (typeof command !== 'string') return null;
  const direct = detectNarrowing(command, { requireDirectInvocation: false });
  if (direct !== null) return { narrowing: direct, command };
  const target = resolveScriptAliasTarget(command);
  if (target === null) return null;
  return resolveNarrowingForScript(scripts, target, visited);
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
  for (const name of Object.keys(scripts)) {
    if (!TEST_SCRIPT_NAME.test(name)) continue;
    if (typeof scripts[name] !== 'string') continue;
    const result = resolveNarrowingForScript(scripts, name, new Set());
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
  'write-host',
  'write-output',
  'write-information',
]);

// A small, closed set of programs whose whole purpose is to read a script
// from somewhere (stdin, `-c`, `-e`/`--eval`) and RUN it. This set is what
// makes a piped-in or handed-in string stop being inert text -- it is
// deliberately not an enumeration of every way vitest could be wrapped (that
// enumeration is what round 2 and round 3 kept finding new members of); it
// is an enumeration of the much smaller, much more stable set of things
// capable of executing arbitrary text at all.
//
// Ripley (review of this PR, round 6): `powershell`/`pwsh` were missing --
// on this repo's own `windows-latest` CI, PowerShell is arguably a MORE
// natural wrapper/interpreter than `bash`/`sh`, not a stretch addition.
// Reproduced both `echo '...' | powershell.exe` (piped, see
// `detectNarrowingThroughPipeline`) and `pwsh -Command 'vitest run -t ...'`
// (handed a script directly via a flag, not piped -- see
// `detectNarrowingThroughInlineScriptArgument` below, a new, equally small
// and structural check for that second shape, rather than one more
// wrapper-shape regex).
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
  'powershell',
  'pwsh',
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

const INLINE_SCRIPT_FLAGS = new Set([
  '-c',
  '-command',
  '--command',
  '-e',
  '--eval',
]);

/**
 * Ripley (review of this PR, round 6): `pwsh -Command 'vitest run -t
 * "only this arm"'` was not recognised. This is a sibling of
 * `detectNarrowingThroughPipeline` above rather than the same case: nothing
 * is piped here, an interpreter is simply handed the script it should run
 * as one of its OWN arguments (`-c`, `-Command`, `-e`/`--eval` are the
 * shapes `sh`/`bash`/`powershell`/`pwsh`/`node`/`python`/`ruby`/`perl` all
 * share for "run this string as code"). The same structural idea applies:
 * do not try to enumerate every wrapper shape, recognise the mechanism (an
 * interpreter from `STDIN_INTERPRETERS`, handed an inline script via one of
 * these flags) and re-run the full `detectNarrowing` on that argument,
 * exactly as if it had been the command all along.
 *
 * PowerShell's own flag casing (`-Command`) is matched case-insensitively,
 * consistent with `basenameOf`'s case-insensitive program-name handling
 * added the same round (see its comment) -- Windows/PowerShell flag
 * spelling is not meaningfully case-sensitive either.
 *
 * Deliberately tried LAST in `detectNarrowing` (after `detectWrappedNarrowing`):
 * this function's own `tokenizeCommand`-based parse of the raw text can
 * mis-split a nested same-character quote (e.g. `node -e
 * "exec(\`vitest run -t "x"\`)"`, where the wrapped-call regexes below
 * already handle the nesting correctly) and recover a truncated value.
 * Trying the more nesting-tolerant wrapped-call check first means a command
 * matching both never reaches this less tolerant one.
 */
function detectNarrowingThroughInlineScriptArgument(rawCommand) {
  const tokens = tokenizeCommand(rawCommand);
  const { index, basename } = resolveInvokedProgramBasename(tokens);
  if (basename === undefined || !STDIN_INTERPRETERS.has(basename)) return null;
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (typeof token !== 'string') continue;
    if (INLINE_SCRIPT_FLAGS.has(token.toLowerCase())) {
      const inline = tokens[i + 1];
      if (typeof inline !== 'string') continue;
      const nested = detectNarrowing(inline, {
        requireDirectInvocation: false,
      });
      if (nested !== null) return nested;
    }
  }
  return null;
}

/**
 * Try the direct, shell-word tokenised detection first; then, if the
 * command pipes into an interpreter, recover what it actually prints and
 * check that; then the wrapped/programmatic detection (`exec(...)` and
 * friends); finally, if it hands an interpreter an inline script as one of
 * its OWN arguments (`-c`/`-Command`/`-e`), recover that (tried last -- see
 * that function's own comment for why). A command that is direct never
 * needs any fallback, and a command that only mentions vitest in passing (no
 * narrowing flag at all, not piped or handed inline anywhere) never matches
 * any of the four.
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
  // Wrapped-call detection (`exec('vitest run -t ...')`, and friends) is
  // tried BEFORE the inline-script-argument check below, deliberately: it
  // uses regexes built to survive a nested same-character quote (e.g. a
  // template literal containing a doubly-quoted flag value), where
  // `detectNarrowingThroughInlineScriptArgument`'s `tokenizeCommand`-based
  // parse of the SAME raw text would mis-split on that nesting and recover
  // a truncated value. Trying the more nesting-tolerant check first means a
  // command matching both never falls through to the less tolerant one.
  const wrapped = detectWrappedNarrowing(rawCommand);
  if (wrapped !== null) return wrapped;
  return detectNarrowingThroughInlineScriptArgument(rawCommand);
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
