// The lock protocol shared by the mutation harness and the test-suite guard.
//
// These three values are the entire contract between a process that opens a
// mutation window and a process that must refuse to run inside one. They lived
// as independent literals in two files until review pointed out the obvious:
// every way the two copies can disagree turns the guard into a silent no-op --
// a lock written where the guard does not look, or a token read from a variable
// the harness does not set, admits every run and keeps every test green.
//
// That is the one failure the guard exists to prevent, so it is made structurally
// impossible rather than asserted. This module holds no state and performs no
// side effects, so either side can import it freely -- including `tests/setup.ts`,
// which runs in every test process.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const MUTATION_TOKEN_VARIABLE = 'PRINTFARMER_MUTATION_TOKEN';

// Under `node_modules` deliberately: `classifyRestore` compares
// `git status --porcelain` before and after each arm, and a lock git can see
// would read as an introduced change and report every arm confounded.
export const LOCK_RELATIVE_PATH =
  'node_modules/.cache/printfarmer-mutation.lock';

/**
 * The project root at or above `start`, identified by its `package.json`.
 *
 * Anchoring the lock on a bare `process.cwd()` left one way for the guard to
 * stop guarding in silence: a run started from a subdirectory resolves a
 * different lock path, finds nothing there, and admits every run exactly as if
 * no window were open. Walking up to the project root makes producer and
 * consumer agree regardless of where either was launched.
 *
 * Falls back to `start` when no `package.json` is found, which is what the
 * harness's own tests rely on -- they run arms inside scratch directories that
 * are deliberately outside any project, and their locks must stay there rather
 * than reaching into the real checkout.
 */
export function projectRootFrom(start) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(resolve(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function lockPathFor(cwd) {
  return resolve(projectRootFrom(cwd ?? process.cwd()), LOCK_RELATIVE_PATH);
}
