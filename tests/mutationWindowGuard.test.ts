import { describe, expect, it } from 'vitest';
import { join, resolve, sep, dirname } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  LOCK_PATH,
  LOCK_RELATIVE_PATH,
  MUTATION_TOKEN_VARIABLE,
  describeForeignMutationWindow,
  isFileDirty,
  removeLockIfUnchanged,
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
        removeLock: () => undefined,
      }),
    ).toBeNull();
  });

  it('asks the real liveness prober, which must call this pid dead', () => {
    // No `isHolderAlive` override. Injecting it everywhere left the real
    // prober's "not alive" answer unpinned, and a regression there wedges the
    // tree with a refusal nobody can falsify.
    expect(
      describeForeignMutationWindow({
        readLock: lock({ pid: dead }),
        token: 'a-different-token',
        isDirty: () => false,
        removeLock: () => undefined,
      }),
    ).toBeNull();
  });

  it('treats a lock with a nonsense pid as having no live holder', () => {
    // Same prober, its other rejection: a pid that is not an integer at all.
    expect(
      describeForeignMutationWindow({
        readLock: lock({ pid: 'not-a-pid' }),
        token: 'a-different-token',
        isDirty: () => false,
        removeLock: () => undefined,
      }),
    ).toBeNull();
  });

  it('sweeps a debris lock instead of leaving it to slow every later run', () => {
    // The guard runs in every afterEach. A lock nobody removes costs a
    // `git status` per test for the life of the checkout.
    const readLock = lock({ pid: dead });
    const swept: string[] = [];
    describeForeignMutationWindow({
      readLock,
      token: 'a-different-token',
      isHolderAlive: () => false,
      isDirty: () => false,
      removeLock: (expected) => {
        swept.push(expected);
      },
    });

    // Handing the sweeper anything other than the bytes that were classified
    // means it can never match, so the lock is never removed and the cost this
    // sweep exists to remove comes silently back.
    expect(swept).toEqual([readLock()]);
  });

  it('keeps the lock when it is still refusing', () => {
    // The converse control: a lock that is doing its job must survive.
    let swept = 0;
    const problem = describeForeignMutationWindow({
      readLock: lock({ pid: dead }),
      token: 'a-different-token',
      isHolderAlive: () => false,
      isDirty: () => true,
      removeLock: () => {
        swept += 1;
      },
    });

    expect(problem).not.toBeNull();
    expect(swept).toBe(0);
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
    // An earlier revision resolved LOCK_PATH from `import.meta.url` and
    // produced `tests/undefined` under vitest's transform: a path no lock can
    // occupy, so the guard admitted every run while all of its behavioural
    // tests stayed green, because those inject `readLock`. Only comparison
    // against the producer could see it.
    expect(LOCK_PATH).toBe(lockPathFor(process.cwd()));
    expect(LOCK_PATH.endsWith(LOCK_RELATIVE_PATH.replace(/\//gu, sep))).toBe(
      true,
    );
  });

  it('resolves the same lock from a subdirectory as from the root', () => {
    // The residual hazard behind the comparison above: both sides agreeing on
    // `process.cwd()` says nothing if cwd is not the project root. A run
    // started from a subdirectory would look for a lock that is not there and
    // admit every run, silently. This is the assertion that is not tautological
    // -- it compares two different inputs, not one function against itself.
    expect(lockPathFor(join(process.cwd(), 'tests'))).toBe(LOCK_PATH);
    expect(lockPathFor(join(process.cwd(), 'src', 'renderer'))).toBe(LOCK_PATH);
  });

  it('leaves a lock outside any project where it was asked for', () => {
    // The harness's own tests run arms in scratch directories outside the
    // checkout and depend on the lock staying there rather than reaching into
    // the real tree.
    const detached = resolve(sep, 'nonexistent-2f4a1c', 'scratch');
    expect(lockPathFor(detached).startsWith(detached)).toBe(true);
  });

  it('keeps the lock outside the tree git reports', () => {
    // classifyRestore compares `git status --porcelain` before and after each
    // arm. A lock visible to git would read as an introduced change and report
    // every arm confounded.
    expect(LOCK_RELATIVE_PATH.startsWith('node_modules/')).toBe(true);
  });
});

/**
 * The real sweeper, which every case above replaces with a fake.
 *
 * Injecting the remover everywhere left the implementation invisible: it could
 * be emptied, or pointed at a recursive delete of the whole cache directory,
 * with the entire suite green. That is the same shape as the `tests/undefined`
 * lock path recorded above -- behaviour green under injected probes, broken on
 * the only path that ever runs.
 */
describe('the sweeper behind the debris path', () => {
  const scratch = (name: string): string =>
    join(process.cwd(), 'node_modules', '.cache', `sweep-probe-${name}.tmp`);

  it('removes the lock it was given, and nothing around it', () => {
    const lock = scratch('match');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, 'the-classified-bytes');
    try {
      removeLockIfUnchanged('the-classified-bytes', lock);
      expect(existsSync(lock)).toBe(false);
      // A sweeper that takes the directory with it destroys every other
      // tool's cache, and no assertion on the lock alone would notice.
      expect(existsSync(dirname(lock))).toBe(true);
    } finally {
      rmSync(lock, { force: true });
    }
  });

  it('leaves a lock whose bytes changed since it was classified', () => {
    // The measured fail-open: classification reads the lock, spends ~35ms in
    // `git status`, and a harness opening a window in that gap writes its lock
    // before its mutant. Deleting unconditionally removed that live lock and
    // the next run was admitted with the mutant on disk.
    const lock = scratch('raced');
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, 'a-live-window-opened-here');
    try {
      removeLockIfUnchanged('the-debris-that-was-classified', lock);
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(lock, 'utf8')).toBe('a-live-window-opened-here');
    } finally {
      rmSync(lock, { force: true });
    }
  });

  it('stays quiet when it cannot remove the lock at all', () => {
    // Several workers meet the same debris and all try to remove it; the
    // losers see EPERM on Windows, which `force` does not suppress. Throwing
    // here would fail an unrelated test from inside `afterEach`. A directory
    // stands in for the unreadable case.
    const busy = scratch('directory');
    mkdirSync(busy, { recursive: true });
    try {
      expect(() => removeLockIfUnchanged('anything', busy)).not.toThrow();
    } finally {
      rmSync(busy, { force: true, recursive: true });
    }
  });

  it('does not mind a lock that has already been swept', () => {
    expect(() =>
      removeLockIfUnchanged('anything', scratch('absent')),
    ).not.toThrow();
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

  it('reports a file git can see, and answers about that file', () => {
    // The direction the feature exists for, and the one that was unpinned:
    // `return porcelain.trim() !== ''` could be replaced by `return false`, or
    // the probe could ask git about some fixed clean path instead of the one it
    // was given, and every other case here stayed green. Both mutants have to
    // fail this.
    const scratch = 'tests/.dirty-probe-9c1f7a2e.tmp';
    const absolute = join(process.cwd(), scratch);
    writeFileSync(absolute, 'transient\n');
    try {
      expect(isFileDirty(scratch)).toBe(true);
      // Discriminates: a probe ignoring its argument cannot give both answers.
      expect(isFileDirty('no/such/file-2f4a1c.ts')).toBe(false);
    } finally {
      rmSync(absolute, { force: true });
    }
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
