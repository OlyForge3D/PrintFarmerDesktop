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
import { resolve } from 'node:path';

export const MUTATION_TOKEN_VARIABLE = 'PRINTFARMER_MUTATION_TOKEN';

// Under `node_modules` deliberately: `classifyRestore` compares
// `git status --porcelain` before and after each arm, and a lock git can see
// would read as an introduced change and report every arm confounded.
export const LOCK_RELATIVE_PATH =
  'node_modules/.cache/printfarmer-mutation.lock';

export function lockPathFor(cwd) {
  return resolve(cwd ?? process.cwd(), LOCK_RELATIVE_PATH);
}
