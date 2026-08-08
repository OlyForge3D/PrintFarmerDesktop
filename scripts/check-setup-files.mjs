// #539. A committed `setupFiles` entry runs inside every vitest worker before
// any test module, with full access to `process`, `path`, and `os`. Six lines
// there can redefine `process.platform`, `process.execPath`, `path.sep`, and
// `os.EOL` -- every witness a test uses to identify the platform it is
// running on, including the ones deliberately chosen because they are "not
// derived from `process.platform`" (see
// tests/retargetSweepRealContention.test.ts). Measured on a real Windows
// runner: all four are `configurable: true`, so `Object.defineProperty`
// replaces them outright regardless of `writable`. A platform-conditional
// test that cross-examines its own skip decision against those witnesses is
// therefore silenceable from a file the test itself never opens.
//
// #518 proposed cross-examining several witnesses from inside the worker.
// That raises the attack's cost from one line to six; it does not close it,
// because every witness it can name is an in-process value the same setup
// file can redefine. #537 already established the general remedy for a
// sibling defect class (committed test-narrowing): read the committed
// configuration from OUTSIDE the vitest worker, before any worker -- and by
// extension any setup file -- has run, and refuse anything not on an
// explicit allowlist.
//
// WHY THIS IS ONE HOME, NOT THREE (unlike #537's testNamePattern)
//
// #537 measured three distinct places a `-t`/`--testNamePattern` narrowing
// could be committed: `vitest.config.ts`, a `package.json` `test`/`test:*`
// script (a CLI flag), and a workflow `run:` step invoking vitest directly
// (also a CLI flag). `setupFiles` has no CLI equivalent -- `vitest --help`
// and `vitest run --help` expose no `--setupFiles` flag, so there is no
// package.json-script or workflow-run-step home for it to hide in the way a
// narrowing can. The only committed surface that can populate
// `test.setupFiles` in this repository is the resolved vitest config itself.
// This file resolves that config the same way #537's gate resolves
// `vitest.config.ts` for its own home 3: via vite's OWN `loadConfigFromFile`,
// the identical resolution vitest performs before a worker starts, rather
// than a source-text match. That also means a second config file (e.g. an
// errant `vitest.config.js` alongside `vitest.config.ts`) cannot smuggle in
// a different answer: vite resolves exactly one config file by its own
// priority order, and this check reads whatever that resolution actually
// produces, not a hand-picked path.
//
// THE ALLOWLIST IS DELIBERATE, NOT INCIDENTAL
//
// `EXPECTED_SETUP_FILES` is the complete, deliberate list of setup files this
// project has reviewed and committed to trusting inside every worker. Adding
// a legitimate new one is a one-line, intentional edit to that constant --
// see `formatReport` below for the exact instruction this gate prints on a
// mismatch, so a real addition is never a mystery red.
//
// NOT WIRED AS A REQUIRED CI CONTEXT. Per the issue's explicit acceptance
// criterion: this must run green on `development` for a while before it is
// safe to make required, for the same reason #537's gate is not required --
// a false positive inside a required "Desktop (matrix)" context deadlocks
// every queued PR entry (#122's shape). This ships as a standalone script
// with its own test suite only.

import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The complete, deliberate allowlist of `test.setupFiles` entries this
 * project has reviewed and trusts to run inside every vitest worker, before
 * any test module. Update this constant -- and only this constant -- when a
 * new setup file is genuinely and intentionally added to
 * `vitest.config.ts`.
 */
export const EXPECTED_SETUP_FILES = ['./tests/setup.ts'];

/**
 * Compare the committed `setupFiles` list against the allowlist as sets:
 * order is not a defect (vitest does not document setupFiles ordering as
 * meaningful across this project's single entry), but any entry that is
 * present and not expected, or expected and missing, is.
 */
export function diffSetupFiles(actual, expected = EXPECTED_SETUP_FILES) {
  const actualList = Array.isArray(actual) ? actual : [];
  const actualSet = new Set(actualList.map(String));
  const expectedSet = new Set(expected.map(String));

  const unexpected = [...actualSet].filter((entry) => !expectedSet.has(entry));
  const missing = [...expectedSet].filter((entry) => !actualSet.has(entry));

  return { unexpected, missing };
}

/**
 * Read the committed `test.setupFiles` list via vite's OWN config
 * resolution -- the same resolution vitest itself performs before a worker
 * ever starts -- rather than a bespoke re-implementation or a source-text
 * match. This means a computed or spread-constructed setupFiles array
 * resolves to the same answer as a literal one, because resolution
 * evaluates the module rather than pattern-matching its source text.
 */
export async function resolveCommittedSetupFiles({
  configPath,
  cwd,
  loadConfigFromFile,
}) {
  const result = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    configPath,
    cwd,
  );
  const setupFiles = result?.config?.test?.setupFiles;
  if (setupFiles === undefined || setupFiles === null) return [];
  return Array.isArray(setupFiles) ? setupFiles : [setupFiles];
}

/**
 * Run the gate: resolve the committed setupFiles list and diff it against
 * the allowlist. Returns `{ unexpected, missing }`; both empty means clean.
 */
export async function checkSetupFiles({
  cwd = process.cwd(),
  configPath = fileURLToPath(new URL('../vitest.config.ts', import.meta.url)),
  expected = EXPECTED_SETUP_FILES,
  loadConfigFromFile = defaultLoadConfigFromFile,
} = {}) {
  const actual = await resolveCommittedSetupFiles({
    configPath,
    cwd,
    loadConfigFromFile,
  });
  return diffSetupFiles(actual, expected);
}

export function formatReport(
  { unexpected, missing },
  expected = EXPECTED_SETUP_FILES,
) {
  const lines = [];
  lines.push(
    'Refusing: the committed `test.setupFiles` list in vitest.config.ts does',
  );
  lines.push(
    'not match the deliberate allowlist in scripts/check-setup-files.mjs.',
  );
  lines.push('');
  lines.push(
    'Every setupFiles entry runs inside each vitest worker before any test',
  );
  lines.push(
    'module, with full access to process/path/os -- an unreviewed entry can',
  );
  lines.push(
    'redefine process.platform, process.execPath, path.sep, and os.EOL,',
  );
  lines.push(
    'silencing every platform witness a test cross-examines against itself.',
  );
  lines.push('');
  if (unexpected.length > 0) {
    lines.push('  UNEXPECTED (present in vitest.config.ts, not allowlisted):');
    for (const entry of unexpected) lines.push(`    + ${entry}`);
  }
  if (missing.length > 0) {
    lines.push('  MISSING (allowlisted, not present in vitest.config.ts):');
    for (const entry of missing) lines.push(`    - ${entry}`);
  }
  lines.push('');
  lines.push(
    '  EXPECTED_SETUP_FILES is a deliberate allowlist, not a computed value:',
  );
  lines.push(`    ${JSON.stringify(expected)}`);
  lines.push('');
  lines.push('  If this addition is genuine and intentional, update');
  lines.push(
    '  EXPECTED_SETUP_FILES in scripts/check-setup-files.mjs to match -- that',
  );
  lines.push(
    '  one-line edit is the entire remedy for a legitimate new setup file.',
  );
  lines.push(
    '  If it is not something you added on purpose, treat it as a possible',
  );
  lines.push(
    '  attempt to spoof platform witnesses (process.platform, process.execPath,',
  );
  lines.push(
    '  path.sep, os.EOL) from inside the test worker; see issue #539.',
  );
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
  const diff = await checkSetupFiles({ loadConfigFromFile });
  if (diff.unexpected.length > 0 || diff.missing.length > 0) {
    log(formatReport(diff));
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
