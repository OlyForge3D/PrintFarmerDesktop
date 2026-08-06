#!/usr/bin/env node
// Every selector must match something, not merely one of them.
//
// #369: `vitest run <a> <b>` where <b> matches nothing exits 0 and reports
// success. Measured at v2.1.9 in this repository:
//
//   vitest run tests/closingReferences.test.ts tests/thisFileDoesNotExist.test.ts
//     Test Files  1 passed (1)
//     exit=0
//
// The only evidence that half the command was discarded is `1 passed (1)` --
// a number you have to already be counting, against an expectation you have to
// already hold.
//
// THE GUARD IS PRESENT WHERE IT IS NOT NEEDED AND ABSENT WHERE IT IS
//
// vitest does protect the total-miss case:
//
//   vitest run tests/nope.test.ts   ->  "No test files found"  exit=1
//
// That is the case you would notice anyway -- nothing ran, no output, plainly
// wrong. The protection stops the instant one other selector matches. But
// typing several paths and getting ONE wrong is enormously more likely than
// getting ALL of them wrong. `--passWithNoTests=false` does not help; it
// governs "zero files matched overall", which is the already-covered case.
//
// This matters here because the repository's verification discipline is built
// on "verify with the smallest targeted command that actually covers the
// change" -- which in practice means multi-selector runs. A renamed file, a
// path recalled from memory, or a command copied out of an older issue body
// all degrade silently into a NARROWER RUN THAT STILL REPORTS SUCCESS, and the
// operator reports coverage they do not have.
//
//   THE DEFECT IS IN THE INSTRUMENT USED TO VERIFY EVERYTHING ELSE.
//
// WHY THIS DELEGATES THE MATCHING RATHER THAN REIMPLEMENTING IT
//
// The obvious implementation -- glob the test directory and check each
// selector against it -- would reimplement vitest's filter semantics. A
// reimplementation that drifts answers a NEIGHBOURING QUESTION and returns a
// confident, well-formed, wrong answer (#214, #253). So each selector is put
// to vitest itself via `vitest list --filesOnly`, whose whole job is to say
// which files a filter selects. Measured:
//
//   list --filesOnly tests/closingReferences.test.ts  ->  1 line,  exit 0
//   list --filesOnly tests/thisFileDoesNotExist.ts    ->  0 lines, exit 0
//
// Note the discriminator is the LINE COUNT, not the exit code: both exit 0.
// Any test asserting "unmatched" here must therefore have a positive control
// proving the matched case produces lines, or it is asserting nothing.
//
// WHAT IT REFUSES TO GUESS
//
// Distinguishing a selector from a flag's value is not decidable from argv
// alone: in `--reporter json`, `json` is positional but is not a selector.
// Guessing wrong in one direction breaks valid commands; guessing wrong in the
// other reintroduces the silent narrowing this exists to stop.
//
// So it does not guess. A token following a BARE flag it does not recognise is
// classified `ambiguous`, is not checked, and IS NAMED ON STDERR. That fails
// open for that token -- but it fails open LOUDLY, and an unchecked selector
// you have been told about is a different object from one you have not.
// Recognised value-taking flags are consumed silently; `--flag=value` needs no
// table at all and is always unambiguous.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_UNMATCHED = 1;
export const EXIT_INCONCLUSIVE = 2;

export const MATCHED = 'matched';
export const UNMATCHED = 'unmatched';
export const INCONCLUSIVE = 'inconclusive';

export const SKIP_FLAG_VALUE = 'flag-value';
export const SKIP_AMBIGUOUS = 'ambiguous';

// Value-taking vitest/vite flags in their BARE form. `--flag=value` never
// reaches this table. Being absent from it is not an error -- it downgrades the
// following token to `ambiguous`, which is reported rather than assumed.
export const VALUE_TAKING_FLAGS = new Set([
  '-c',
  '-t',
  '-r',
  '--config',
  '--root',
  '--dir',
  '--reporter',
  '--outputFile',
  '--testNamePattern',
  '--environment',
  '--pool',
  '--shard',
  '--retry',
  '--bail',
  '--maxWorkers',
  '--minWorkers',
  '--maxConcurrency',
  '--testTimeout',
  '--hookTimeout',
  '--teardownTimeout',
  '--slowTestThreshold',
  '--cache.dir',
  '--exclude',
  '--include',
  '--project',
  '--mode',
  '--logHeapUsage',
]);

const SUBCOMMANDS = new Set([
  'run',
  'watch',
  'dev',
  'related',
  'bench',
  'list',
  'init',
  'typecheck',
]);

export function isFlag(token) {
  return typeof token === 'string' && token.startsWith('-') && token !== '-';
}

/**
 * Split argv into selectors we will verify and tokens we deliberately will not.
 * The first positional token is dropped when it is a vitest subcommand, since
 * `run` in `vitest run foo` is not a selector.
 */
export function selectorCandidates(argv = []) {
  const candidates = [];
  const skipped = [];
  let seenSubcommand = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string') continue;

    if (isFlag(token)) {
      if (!token.includes('=') && VALUE_TAKING_FLAGS.has(token)) {
        const value = argv[i + 1];
        if (value !== undefined && !isFlag(value)) {
          skipped.push({ token: value, reason: SKIP_FLAG_VALUE, after: token });
          i += 1;
        }
      } else if (!token.includes('=')) {
        const value = argv[i + 1];
        if (
          value !== undefined &&
          !isFlag(value) &&
          !(!seenSubcommand && SUBCOMMANDS.has(value))
        ) {
          skipped.push({ token: value, reason: SKIP_AMBIGUOUS, after: token });
          i += 1;
        }
      }
      continue;
    }

    if (!seenSubcommand && SUBCOMMANDS.has(token)) {
      seenSubcommand = true;
      continue;
    }

    candidates.push(token);
  }

  return { candidates, skipped };
}

/**
 * Classify one `vitest list --filesOnly` result. The discriminator is the line
 * count; both matched and unmatched exit 0.
 */
export function classifyListing({ code, stdout } = {}) {
  if (code !== 0) return INCONCLUSIVE;
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? MATCHED : UNMATCHED;
}

export function formatRefusal({ unmatched = [], candidates = [] } = {}) {
  const lines = [];
  lines.push('Refusing to run: a selector matched no test files.');
  lines.push('');
  for (const selector of unmatched) {
    lines.push(`  MATCHED NOTHING: ${selector}`);
  }
  lines.push('');
  lines.push(
    '  vitest would have exited 0 here, running only the selectors that did',
  );
  lines.push(
    '  match, and reported success for a narrower run than you asked for.',
  );
  lines.push('');
  lines.push(`  selectors checked: ${candidates.length}`);
  lines.push('');
  lines.push(
    '  If the file was renamed, the command may have been copied from an',
  );
  lines.push(
    '  older note, checkpoint or issue body. Re-derive it from the tree.',
  );
  return lines.join('\n');
}

export function formatInconclusive({ selector, code } = {}) {
  return [
    'Refusing to run: could not determine what a selector matches.',
    '',
    `  SELECTOR: ${selector}`,
    `  \`vitest list\` exited ${code}`,
    '',
    '  An unreadable answer is not a passing one. Fix the vitest invocation',
    '  (a config error will surface here first) and re-run.',
  ].join('\n');
}

export function resolveVitestBin(require = createRequire(import.meta.url)) {
  return require.resolve('vitest/vitest.mjs');
}

/**
 * The injected default. Exported so it is reachable from tests rather than
 * being an unexecuted I/O boundary (#447).
 */
export function listFilesFor(
  selector,
  { cwd = process.cwd(), bin = resolveVitestBin() } = {},
) {
  const result = spawnSync(
    process.execPath,
    [bin, 'list', '--filesOnly', selector],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  return { code: result.status ?? 1, stdout: result.stdout ?? '' };
}

export function runVitest(
  argv,
  { cwd = process.cwd(), bin = resolveVitestBin() } = {},
) {
  const result = spawnSync(process.execPath, [bin, ...argv], {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

export function checkSelectors(argv, { list = listFilesFor } = {}) {
  const { candidates, skipped } = selectorCandidates(argv);
  const unmatched = [];
  for (const selector of candidates) {
    // Called once and kept: calling again to read the exit code would be a
    // second measurement of a different moment.
    const listing = list(selector);
    const verdict = classifyListing(listing);
    if (verdict === INCONCLUSIVE) {
      return {
        verdict: INCONCLUSIVE,
        selector,
        code: listing.code,
        candidates,
        skipped,
      };
    }
    if (verdict === UNMATCHED) unmatched.push(selector);
  }
  return {
    verdict: unmatched.length > 0 ? UNMATCHED : MATCHED,
    unmatched,
    candidates,
    skipped,
  };
}

export function main(
  argv = [],
  { list = listFilesFor, run = runVitest, log = console.error } = {},
) {
  const outcome = checkSelectors(argv, { list });

  for (const entry of outcome.skipped) {
    if (entry.reason === SKIP_AMBIGUOUS) {
      log(
        `vitest-strict: NOT CHECKED (ambiguous): ${entry.token} -- follows the unrecognised flag ${entry.after}`,
      );
    }
  }

  if (outcome.verdict === INCONCLUSIVE) {
    log(formatInconclusive({ selector: outcome.selector, code: outcome.code }));
    return EXIT_INCONCLUSIVE;
  }

  if (outcome.verdict === UNMATCHED) {
    log(
      formatRefusal({
        unmatched: outcome.unmatched,
        candidates: outcome.candidates,
      }),
    );
    return EXIT_UNMATCHED;
  }

  return run(argv);
}

// `new URL('file://' + path)` is wrong on Windows, where argv[1] is `D:\...`.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
