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
// REVISION HISTORY -- WHY THIS IS NOT vite's BARE `loadConfigFromFile`
//
// The first version of this gate resolved `vitest.config.ts` with vite's
// `loadConfigFromFile`, which only evaluates the exported config module. A
// round of review on PR #642 (Vasquez, with a working repro) showed that is
// a static snapshot, not what vitest actually executes with, and produced
// three concrete bypasses that all resolved as "clean" under
// `loadConfigFromFile` while a real `vitest run` executed an unallowlisted
// setup file:
//
//   1. `process.argv`-gated:  `process.argv[1].includes('vitest') ? [...] : []`
//   2. `process.env`-gated:   `process.env.VITEST ? [...] : []`
//   3. plugin-injected:       a Vite plugin's `config()` hook returning
//                              `{ test: { setupFiles: [...] } }`
//
// (1) and (2) are invisible to `loadConfigFromFile` because that checker
// process is not itself a vitest invocation -- its own argv and env do not
// look like a real `vitest run`, so an attacker's config can trivially
// detect "am I being inspected by the gate, or actually run?" and answer
// differently. (3) is invisible because `loadConfigFromFile` evaluates only
// the exported config object; it does not run vite's plugin pipeline, so a
// `config()` hook's contribution to `test.setupFiles` is never merged in.
//
// THE FIX: resolve the config the way vitest itself resolves it, in a
// context that looks like a real invocation, rather than a bespoke
// re-implementation of any part of that pipeline:
//
//   - Use `createVitest` from `vitest/node` -- vitest's OWN programmatic
//     entry point, the same one its CLI (`vitest run`) calls internally
//     (see `prepareVitest`/`startVitest` in vitest's own source). This goes
//     through vite's full `createServer` config-resolution pipeline,
//     including every plugin's `config()` hook, closing bypass (3).
//   - Before calling it, set `process.env.VITEST`/`TEST`/`NODE_ENV` exactly
//     as vitest's own `prepareVitest` does before resolving config, closing
//     bypass (2).
//   - Also set `process.argv` to look like a real `vitest run` invocation
//     (argv[1] pointing at the actual installed `vitest.mjs` binary this
//     project's `npm test` would execute, with `run` as an argument),
//     closing bypass (1).
//   - Restore the original `process.argv`/env afterward, in a `finally`, so
//     this check does not leak invocation-context spoofing into anything
//     that runs after it.
//
// `createVitest` alone -- without ever calling `ctx.start()` or `ctx.init()`
// -- resolves the full config (including setupFiles) but does not glob test
// files, spin up a worker pool, or execute any setup file. This is
// deliberate: the committed setupFiles this gate is inspecting are exactly
// the ones under suspicion, so this gate must never execute them to find
// out what they are.
//
// This cannot claim to enumerate every possible signal a sufficiently
// motivated config could branch on (wall-clock timing, filesystem probing
// for a lockfile, etc.) -- see the header note in
// scripts/check-test-narrowing.mjs on why enumerating witnesses is not a
// sound strategy in general. What it does claim is closing the three
// concrete, demonstrated bypasses above by resolving config through
// vitest's real pipeline in a real invocation's argv/env context, rather
// than a hand-rolled one.
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
// `test.setupFiles` in this repository is the resolved vitest config
// itself, and this file resolves it the same way vitest's own CLI does.
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

import { createRequire } from 'node:module';
import path from 'node:path';
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
 * Resolve the path to the vitest binary this project's own `npm test`
 * (`vitest run`) would actually execute, so this gate's invocation-context
 * spoofing (see below) matches the real thing rather than a guess.
 */
export function resolveVitestBinPath({
  cwd = process.cwd(),
  requireImpl = createRequire(import.meta.url),
} = {}) {
  try {
    return requireImpl.resolve('vitest/vitest.mjs');
  } catch {
    // Fall back to the conventional install location if package-exports
    // resolution is unavailable in this context (e.g. a sandboxed test).
    return path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
  }
}

/**
 * Run `fn` with `process.argv` and the environment variables vitest's own
 * CLI sets before resolving config (`process.env.VITEST`/`TEST`/`NODE_ENV`,
 * see `prepareVitest` in vitest's source) temporarily overridden to look
 * like a real `vitest run` invocation, then restore the originals -- even
 * if `fn` throws.
 *
 * This exists because a committed `vitest.config.ts` can branch on its own
 * invocation context (`process.argv[1].includes('vitest')`,
 * `process.env.VITEST`) to behave differently when inspected by a plain
 * `node` process than when actually run by CI. Resolving config from
 * *inside* a context that looks like the real invocation closes that gap
 * (PR #642 review, bypasses 1 and 2).
 */
export async function withRealVitestInvocationContext(fn, { vitestBinPath }) {
  const originalArgv = process.argv;
  const originalEnv = {
    VITEST: process.env.VITEST,
    TEST: process.env.TEST,
    NODE_ENV: process.env.NODE_ENV,
  };
  try {
    process.argv = [process.argv[0] ?? 'node', vitestBinPath, 'run'];
    process.env.VITEST = 'true';
    process.env.TEST = 'true';
    process.env.NODE_ENV ??= 'test';
    return await fn();
  } finally {
    process.argv = originalArgv;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function toRelativePosix(entry, root) {
  if (typeof entry !== 'string') return entry;
  if (!path.isAbsolute(entry)) return entry;
  const relative = path.relative(root, entry).split(path.sep).join('/');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Read the committed `test.setupFiles` list the way vitest itself resolves
 * it: via `createVitest` (vitest's own programmatic entry point, the same
 * one its CLI uses internally), from within a context spoofed to look like
 * a real `vitest run` invocation. This closes all three bypasses found in
 * PR #642 review -- argv-gated, env-gated, and plugin-injected -- because
 * it is the real pipeline, not a re-implementation of part of it.
 *
 * Deliberately never calls `ctx.start()` or `ctx.init()`: config resolution
 * (including every plugin's `config()` hook) completes inside
 * `createVitest` itself, before any test file is globbed or any worker
 * spawned. The setupFiles this gate inspects are exactly the ones under
 * suspicion, so they must never actually execute here.
 */
export async function resolveCommittedSetupFiles({
  configPath,
  cwd,
  createVitestImpl,
  vitestBinPath = resolveVitestBinPath({ cwd }),
}) {
  return withRealVitestInvocationContext(
    async () => {
      const ctx = await createVitestImpl('test', {
        run: true,
        watch: false,
        config: configPath,
        root: cwd,
      });
      try {
        const resolved = ctx.config?.setupFiles;
        if (resolved === undefined || resolved === null) return [];
        const root = ctx.config?.root ?? cwd;
        const list = Array.isArray(resolved) ? resolved : [resolved];
        return list.map((entry) => toRelativePosix(entry, root));
      } finally {
        await ctx.close();
      }
    },
    { vitestBinPath },
  );
}

/**
 * Run the gate: resolve the committed setupFiles list and diff it against
 * the allowlist. Returns `{ unexpected, missing }`; both empty means clean.
 */
export async function checkSetupFiles({
  cwd = process.cwd(),
  configPath = fileURLToPath(new URL('../vitest.config.ts', import.meta.url)),
  expected = EXPECTED_SETUP_FILES,
  createVitestImpl = defaultCreateVitest,
  vitestBinPath,
} = {}) {
  const actual = await resolveCommittedSetupFiles({
    configPath,
    cwd,
    createVitestImpl,
    ...(vitestBinPath !== undefined ? { vitestBinPath } : {}),
  });
  return diffSetupFiles(actual, expected);
}

export function formatReport(
  { unexpected, missing },
  expected = EXPECTED_SETUP_FILES,
) {
  const lines = [];
  lines.push(
    'Refusing: the committed `test.setupFiles` list vitest would actually',
  );
  lines.push(
    'resolve for vitest.config.ts does not match the deliberate allowlist in',
  );
  lines.push('scripts/check-setup-files.mjs.');
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

export async function defaultCreateVitest(...args) {
  const vitestNode = await import('vitest/node');
  return vitestNode.createVitest(...args);
}

export async function main({
  createVitestImpl = defaultCreateVitest,
  log = console.error,
} = {}) {
  const diff = await checkSetupFiles({ createVitestImpl });
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
