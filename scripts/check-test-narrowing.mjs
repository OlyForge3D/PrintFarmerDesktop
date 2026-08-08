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
// TWO REVIEW ROUNDS FOUND HOLES IN THE FIRST VERSION, BOTH FIXED HERE:
//
//   Ripley: a workflow `run:` block was split into sub-commands on every
//   newline BEFORE tokenising, so a direct invocation split across a shell
//   line-continuation (`vitest run \` / `  -t "pattern"`) put the flag and
//   its value on different "sub-commands" and neither tokenised to a
//   complete `-t <value>` pair -- the one-line form of the identical command
//   was caught, the continued form was not. `joinLineContinuations` now
//   rejoins a trailing-`\` line with the line that follows it before any
//   splitting happens, so a continued command reaches the tokeniser as the
//   single logical line it always was.
//
//   Vasquez: a committed wrapper that invokes vitest programmatically --
//   `node -e "spawnSync('vitest',['run','-t','only this arm'])"` -- passed
//   both the package.json and workflow checks silently. The narrowing flag
//   and its value are still committed as literal strings, only nested
//   inside a JS string rather than separated by shell whitespace, so the
//   whitespace tokeniser folded them into one opaque token and
//   `isDirectVitestInvocation` never saw a bare `vitest` word to key off.
//   `detectWrappedNarrowing` is a second, narrower instrument that requires
//   the word `vitest` to appear anywhere in the command AND the flag to
//   appear as a quoted string literal next to its value -- the shape an
//   argument list takes when authored as data rather than typed as a shell
//   command -- so it catches the wrapper without matching prose that merely
//   mentions both words.

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
 * `npx vitest`, or a direct call to `.../vitest/vitest.mjs`. False for a
 * command that merely mentions vitest in passing (e.g. `npm run test`,
 * which is the package.json home checked separately).
 */
export function isDirectVitestInvocation(tokens) {
  return tokens.some((token) => {
    if (typeof token !== 'string') return false;
    if (token === 'vitest') return true;
    const normalised = token.replaceAll('\\', '/');
    return (
      normalised === 'vitest.mjs' ||
      normalised.endsWith('/vitest.mjs') ||
      normalised.endsWith('/vitest/vitest.mjs')
    );
  });
}

const TEST_SCRIPT_NAME = /^test(:.*)?$/;

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
    const narrowing = detectNarrowing(command, {
      requireDirectInvocation: false,
    });
    if (narrowing !== null) {
      violations.push({
        home: 'package.json',
        location: `scripts.${name}`,
        command,
        ...narrowing,
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
 * This is a second, narrower instrument alongside the tokeniser rather than
 * a replacement for it: it requires the literal word `vitest` to appear
 * SOMEWHERE in the command (so it does not fire on `eslint . -t x`, which
 * has a narrowing-shaped flag but never mentions vitest), and it requires
 * the flag itself to appear as a QUOTED string literal immediately followed
 * by its value (comma-separated, as an argv array element, or `=`-joined
 * inside one quoted token) -- the shape an argument list actually takes when
 * it is authored as data rather than typed as a shell command. That
 * quoting requirement is what keeps this from matching ordinary prose that
 * happens to mention both words (a comment reading "don't use vitest -t
 * flags in CI" has no quoted `-t` next to a quoted value, so it does not
 * match).
 */
export function detectWrappedNarrowing(rawText) {
  if (typeof rawText !== 'string') return null;
  if (!/\bvitest\b/.test(rawText)) return null;
  const eqMatch = WRAPPED_FLAG_EQ_VALUE.exec(rawText);
  if (eqMatch) return { flag: eqMatch[1], value: eqMatch[2] };
  const pairMatch = WRAPPED_FLAG_THEN_VALUE.exec(rawText);
  if (pairMatch) return { flag: pairMatch[1], value: pairMatch[2] };
  return null;
}

/**
 * Try the direct, shell-word tokenised detection first; fall back to the
 * wrapped/programmatic detection only when the direct one finds nothing. A
 * command that is direct never needs the fallback, and a command that only
 * mentions vitest in passing (no narrowing flag at all) never matches
 * either.
 */
function detectNarrowing(rawCommand, { requireDirectInvocation }) {
  const tokens = tokenizeCommand(rawCommand);
  const isDirect = isDirectVitestInvocation(tokens);
  if (!requireDirectInvocation || isDirect) {
    const direct = detectNarrowingFlag(tokens);
    if (direct !== null) return direct;
  }
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

    if (rest.length > 0 && !/^[|>][+-]?\d*$/.test(rest)) {
      // Inline command on the same line as `run:`.
      blocks.push({ lineNumber, command: rest });
      continue;
    }

    // Block scalar (`|`, `>`, `|-`, `>+`, ...): collect subsequent lines that
    // are indented further than `run:` itself, until dedent or EOF.
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
    blocks.push({ lineNumber, command: body.join('\n') });
  }
  return blocks;
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
