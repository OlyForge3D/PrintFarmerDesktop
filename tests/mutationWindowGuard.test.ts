import { describe, expect, it } from 'vitest';
import { join, sep } from 'node:path';
import {
  LOCK_PATH,
  LOCK_RELATIVE_PATH,
  MUTATION_TOKEN_VARIABLE,
  describeForeignMutationWindow,
  isFileDirty,
} from './mutationWindowGuard';
import {
  MUTATION_TOKEN_VARIABLE as HARNESS_TOKEN_VARIABLE,
  lockPathFor,
} from '../scripts/mutation-harness.mjs';

/**
 * The guard exists because a neighbouring mutation window produced failures
 * that looked exactly like real defects and could not be reproduced afterwards.
 * These cases pin the states it has to tell apart, so an inversion of any one
 * of them fails here rather than in a review round.
 */
describe('foreign mutation window guard', () => {
  const lock = (overrides: Record<string, unknown> = {}): (() => string) => {
    return () =>
      JSON.stringify({
        token: 'window-token',
        pid: process.pid, // Alive by construction: this process is running.
        file: 'src/renderer/calibration/NewCalibrationProject.tsx',
        label: 'invert the survivor branch',
        openedAt: '2026-08-11T22:00:00.000Z',
        ...overrides,
      });
  };

  const dead = 0x7fffffff; // Odd, so Windows (multiples of 4) never assigns it.

  it('stops a run that does not own a live window, and says why', () => {
    const problem = describeForeignMutationWindow({
      readLock: lock(),
      token: 'a-different-token',
    });

    expect(problem).not.toBeNull();
    // The message has to name the cause, or the reader diagnoses the test.
    expect(problem).toContain('mutation-harness window is open');
    expect(problem).toContain('NewCalibrationProject.tsx');
    expect(problem).toContain('invert the survivor branch');
    // Remediation has to be reachable from the message alone: a stale lock is
    // otherwise a wedged tree with no stated escape.
    expect(problem).toContain(LOCK_PATH);
    expect(problem).toContain('2026-08-11T22:00:00.000Z');
  });

  it('admits the harness run that owns the window', () => {
    // Without this the harness could never run an arm: its own child run reads
    // the mutation deliberately.
    expect(
      describeForeignMutationWindow({
        readLock: lock(),
        token: 'window-token',
      }),
    ).toBeNull();
  });

  it('ignores a dead holder once its file is back to normal', () => {
    // A crashed harness that did restore the file must not wedge later runs.
    expect(
      describeForeignMutationWindow({
        readLock: lock({ pid: dead }),
        token: 'a-different-token',
        isHolderAlive: () => false,
        isDirty: () => false,
      }),
    ).toBeNull();
  });

  it('still refuses when a dead holder left its file mutated', () => {
    // The fail-open hole: `finally` does not run on SIGINT, so a hard-killed
    // harness leaves the mutant on disk with only a dead holder recorded.
    // Waving that through means every later run silently compiles the mutant.
    const problem = describeForeignMutationWindow({
      readLock: lock({ pid: dead }),
      token: 'a-different-token',
      isHolderAlive: () => false,
      isDirty: () => true,
    });

    expect(problem).not.toBeNull();
    expect(problem).toContain('killed before it restored');
    expect(problem).toContain('NewCalibrationProject.tsx');
    expect(problem).toContain(LOCK_PATH);
  });

  it('asks about the file the holder named, not some other file', () => {
    // A dirtiness probe pointed at the wrong path would answer a question
    // nobody asked and wave the real mutation through.
    const asked: string[] = [];
    describeForeignMutationWindow({
      readLock: lock({ pid: dead }),
      token: 'a-different-token',
      isHolderAlive: () => false,
      isDirty: (file) => {
        asked.push(file);
        return true;
      },
    });

    expect(asked).toEqual([
      'src/renderer/calibration/NewCalibrationProject.tsx',
    ]);
  });

  it('ignores absent and unreadable locks', () => {
    const missing = (): string => {
      throw new Error('ENOENT');
    };
    expect(describeForeignMutationWindow({ readLock: missing })).toBeNull();
    expect(
      describeForeignMutationWindow({ readLock: () => 'not json' }),
    ).toBeNull();
    // A lock with no token is debris, not a window.
    expect(
      describeForeignMutationWindow({ readLock: lock({ token: 42 }) }),
    ).toBeNull();
  });

  it('stops an unowned window even when the run carries no token at all', () => {
    // The ordinary developer case: a plain `npx vitest` during a harness run.
    expect(
      describeForeignMutationWindow({ readLock: lock(), token: undefined }),
    ).not.toBeNull();
  });
});

/**
 * The producer and the consumer of this protocol live in different files and
 * different languages. Nothing else pins them together, and every way they can
 * disagree degrades the guard to a silent no-op: a lock written where the guard
 * does not look, or a token read from a variable the harness does not set,
 * leaves every run admitted and every test green. That is the one failure this
 * whole mechanism exists to make impossible, so it is asserted rather than
 * assumed.
 */
describe('the lock protocol is shared, not duplicated', () => {
  it('agrees with the harness on the environment variable', () => {
    expect(MUTATION_TOKEN_VARIABLE).toBe(HARNESS_TOKEN_VARIABLE);
  });

  it('reads the lock exactly where the harness writes it', () => {
    // The load-bearing assertion. An earlier revision resolved LOCK_PATH from
    // `import.meta.url` and produced `tests/undefined` under vitest's
    // transform: a path no lock can occupy, so the guard admitted every run
    // while all of its behavioural tests stayed green, because those inject
    // `readLock`. Only this comparison against the producer could see it.
    expect(LOCK_PATH).toBe(lockPathFor(process.cwd()));
    expect(LOCK_PATH.endsWith(LOCK_RELATIVE_PATH.replace(/\//gu, sep))).toBe(
      true,
    );
  });

  it('keeps the lock outside the tree git reports', () => {
    // classifyRestore compares `git status --porcelain` before and after each
    // arm. A lock visible to git would read as an introduced change and report
    // every arm confounded.
    expect(LOCK_RELATIVE_PATH.startsWith('node_modules/')).toBe(true);
  });
});

/**
 * The real dirtiness probe, which every case above replaces with a fake.
 *
 * Its failure direction is load-bearing and was briefly untested: a mutation
 * flipping the unreadable-tree answer from "possibly dirty" to "clean" survived
 * the whole file, because nothing reached the default. A guard that cannot see
 * the tree must not conclude the tree is clean, so both branches are pinned
 * here against real git.
 */
describe('the dirtiness probe behind the crash check', () => {
  it('reports a path git knows nothing about as clean', () => {
    // `git status --porcelain -- <unmatched>` exits 0 with no output, so this
    // reaches the success branch without depending on the tree's live state.
    expect(isFileDirty('no/such/file-2f4a1c.ts')).toBe(false);
  });

  it('answers "possibly dirty" when it cannot ask git at all', () => {
    // A repo root that does not exist makes the spawn throw. Answering "clean"
    // here would wave through exactly the abandoned mutation the check exists
    // to catch.
    expect(isFileDirty('anything.ts', join(sep, 'nonexistent-2f4a1c'))).toBe(
      true,
    );
  });
});
