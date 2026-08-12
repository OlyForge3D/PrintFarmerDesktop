import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LOCK_RELATIVE_PATH,
  MUTATION_TOKEN_VARIABLE,
  lockPathFor,
} from '../scripts/mutationWindowProtocol.mjs';

export { LOCK_RELATIVE_PATH, MUTATION_TOKEN_VARIABLE };

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

/**
 * Resolved through the shared protocol, so the guard reads exactly where the
 * harness writes.
 *
 * An earlier revision derived this from `import.meta.url`. Under vitest's
 * transform that produced `tests/undefined` -- a path no lock will ever occupy,
 * so the guard silently admitted every run while all of its own tests stayed
 * green, because they inject `readLock`. The parity test below caught it. That
 * is the failure mode this whole mechanism exists to prevent, reproduced inside
 * the mechanism itself, and it is why the constants are now shared rather than
 * restated.
 */
export const LOCK_PATH = lockPathFor(process.cwd());

export interface MutationWindowProbes {
  readonly readLock?: () => string;
  readonly token?: string | undefined;
  readonly isHolderAlive?: (pid: unknown) => boolean;
  readonly isDirty?: (file: string) => boolean;
  readonly removeLock?: () => void;
}

function defaultReadLock(): string {
  return readFileSync(LOCK_PATH, 'utf8');
}

function defaultRemoveLock(): void {
  rmSync(LOCK_PATH, { force: true });
}

function defaultIsHolderAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return false;
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the tree still hold an edit to the file the dead holder was mutating?
 *
 * Failing to answer is treated as "yes, possibly": a guard that cannot see the
 * tree must not conclude the tree is clean. Exported so that direction is
 * testable -- inverting it is otherwise invisible, since every behavioural case
 * injects its own probe.
 */
export function isFileDirty(
  file: string,
  repoRoot: string = dirname(dirname(dirname(LOCK_PATH))),
): boolean {
  try {
    const porcelain = execFileSync(
      'git',
      ['status', '--porcelain', '--', file],
      {
        encoding: 'utf8',
        // The repository root: the lock sits at <root>/node_modules/.cache/…,
        // so three levels up from the lock is where git should be asked.
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return porcelain.trim() !== '';
  } catch {
    return true;
  }
}

export function describeForeignMutationWindow(
  probes: MutationWindowProbes = {},
): string | null {
  const {
    readLock = defaultReadLock,
    token = process.env[MUTATION_TOKEN_VARIABLE],
    isHolderAlive = defaultIsHolderAlive,
    isDirty = isFileDirty,
    removeLock = defaultRemoveLock,
  } = probes;

  let raw: string;
  try {
    raw = readLock();
  } catch {
    return null; // No window is open, which is the ordinary case.
  }

  let lock: {
    token?: unknown;
    pid?: unknown;
    file?: unknown;
    label?: unknown;
    openedAt?: unknown;
  };
  try {
    lock = JSON.parse(raw) as typeof lock;
  } catch {
    // Unparseable debris fails *open* deliberately. The lock is written before
    // the mutant reaches disk, so a half-written lock strictly precedes any
    // mutation, and the check repeats at every later test boundary. Failing
    // closed here would let one truncated leftover wedge the tree with no
    // stated way out -- strictly worse than what it would prevent.
    return null;
  }

  if (typeof lock.token !== 'string') return null;
  if (lock.token === token) return null; // This run owns the window.

  const file = typeof lock.file === 'string' ? lock.file : null;
  const openedAt =
    typeof lock.openedAt === 'string' ? lock.openedAt : 'unknown';

  // A dead holder is not automatically debris. `finally` does not run on
  // SIGINT, so a hard-killed harness leaves the mutant on disk *and* the lock
  // behind. Treating that as debris fails open in exactly the case where the
  // tree durably holds a mutation -- every later run would silently compile
  // it. So the file the holder named decides: still modified, still refuse.
  if (!isHolderAlive(lock.pid)) {
    if (file === null || !isDirty(file)) {
      // Debris, and swept rather than left. `assertNoForeignMutationWindow`
      // runs in every `afterEach`, so a lock nobody will ever remove costs a
      // `git status` per test: measured at ~10.2s -> ~29.7s on a single file.
      // The tree is clean and the holder is gone, so there is nothing left to
      // protect and nothing to lose by removing it.
      removeLock();
      return null;
    }
    return [
      'Refusing to run: a mutation-harness run was killed before it restored',
      'the file it mutated, and that file is still modified in this tree.',
      `  mutated file: ${file}`,
      `  arm:          ${String(lock.label)}`,
      `  holder pid:   ${String(lock.pid)} (no longer running)`,
      `  opened at:    ${openedAt}`,
      `  lock file:    ${LOCK_PATH}`,
      'Restore that file, then delete the lock file named above. Until then a',
      'result here would describe the mutation rather than the code.',
    ].join('\n');
  }

  return [
    'Refusing to run: a mutation-harness window is open in this working tree.',
    `  mutated file: ${String(lock.file)}`,
    `  arm:          ${String(lock.label)}`,
    `  holder pid:   ${String(lock.pid)}`,
    `  opened at:    ${openedAt}`,
    `  lock file:    ${LOCK_PATH}`,
    'The tree currently holds a deliberate mutation, so any result here is',
    'meaningless: failures would name a defect that does not exist. Wait for',
    'scripts/mutation-harness.mjs to finish, then run again. If nothing is',
    'running the lock is stale -- delete the lock file named above.',
  ].join('\n');
}

export function assertNoForeignMutationWindow(): void {
  const problem = describeForeignMutationWindow();
  if (problem !== null) throw new Error(problem);
}
