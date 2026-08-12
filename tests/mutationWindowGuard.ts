import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Refuse to interpret a suite run that is reading a half-mutated working tree.
 *
 * `scripts/mutation-harness.mjs` applies each arm to the real source file, runs
 * the suite, then restores it. While that window is open, any *other* process
 * running the suite compiles the mutant. Measured on this repository: looping
 * `tests/calibration.workspace.test.tsx` alongside a harness run failed 2 of 4
 * concurrent runs, and the failures landed exactly on the tests guarding the
 * mutated lines. By the time anyone inspects, the tree is clean and the failure
 * will not reproduce, so it reads as flake in the test rather than as a
 * neighbour's edit. One such observation cost a full review round.
 *
 * A run inside someone else's mutation window has no interpretation: green
 * would mean the mutant survived, red would name a defect that does not exist.
 * So it is stopped rather than reported. The harness's own child runs carry the
 * window's token and are admitted.
 */
export const MUTATION_TOKEN_VARIABLE = 'PRINTFARMER_MUTATION_TOKEN';
const LOCK_PATH = 'node_modules/.cache/printfarmer-mutation.lock';

function holderIsAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return false;
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    // A crashed harness must not wedge every later run, so a lock whose owner
    // is gone is treated as debris rather than as an open window.
    return false;
  }
}

export function describeForeignMutationWindow(
  readLock: () => string = () => readFileSync(resolve(LOCK_PATH), 'utf8'),
  token: string | undefined = process.env[MUTATION_TOKEN_VARIABLE],
): string | null {
  let raw: string;
  try {
    raw = readLock();
  } catch {
    return null; // No window is open, which is the ordinary case.
  }

  let lock: { token?: unknown; pid?: unknown; file?: unknown; label?: unknown };
  try {
    lock = JSON.parse(raw) as typeof lock;
  } catch {
    return null; // Unreadable debris is not evidence of a live window.
  }

  if (typeof lock.token !== 'string') return null;
  if (lock.token === token) return null; // This run owns the window.
  if (!holderIsAlive(lock.pid)) return null;

  return [
    'Refusing to run: a mutation-harness window is open in this working tree.',
    `  mutated file: ${String(lock.file)}`,
    `  arm:          ${String(lock.label)}`,
    `  holder pid:   ${String(lock.pid)}`,
    'The tree currently holds a deliberate mutation, so any result here is',
    'meaningless: failures would name a defect that does not exist. Wait for',
    'scripts/mutation-harness.mjs to finish, then run again.',
  ].join('\n');
}

export function assertNoForeignMutationWindow(): void {
  const problem = describeForeignMutationWindow();
  if (problem !== null) throw new Error(problem);
}
