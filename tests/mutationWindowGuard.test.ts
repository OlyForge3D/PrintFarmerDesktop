import { describe, expect, it } from 'vitest';
import { describeForeignMutationWindow } from './mutationWindowGuard';

/**
 * The guard exists because a neighbouring mutation window produced failures
 * that looked exactly like real defects and could not be reproduced afterwards.
 * These cases pin the four states it has to tell apart, so an inversion of any
 * one of them fails here rather than in a review round.
 */
describe('foreign mutation window guard', () => {
  const lock = (overrides: Record<string, unknown> = {}): (() => string) => {
    return () =>
      JSON.stringify({
        token: 'window-token',
        pid: process.pid, // Alive by construction: this process is running.
        file: 'src/renderer/calibration/NewCalibrationProject.tsx',
        label: 'invert the survivor branch',
        ...overrides,
      });
  };

  it('stops a run that does not own a live window, and says why', () => {
    const problem = describeForeignMutationWindow(lock(), 'a-different-token');

    expect(problem).not.toBeNull();
    // The message has to name the cause, or the reader diagnoses the test.
    expect(problem).toContain('mutation-harness window is open');
    expect(problem).toContain('NewCalibrationProject.tsx');
    expect(problem).toContain('invert the survivor branch');
  });

  it('admits the harness run that owns the window', () => {
    // Without this the harness could never run an arm: its own child run reads
    // the mutation deliberately.
    expect(describeForeignMutationWindow(lock(), 'window-token')).toBeNull();
  });

  it('ignores a window whose holder is gone', () => {
    // A crashed harness must not wedge every later run. PID 0x7fffffff is not a
    // live process; treating this as an open window would be unrecoverable.
    expect(
      describeForeignMutationWindow(
        lock({ pid: 0x7fffffff }),
        'a-different-token',
      ),
    ).toBeNull();
  });

  it('ignores absent and unreadable locks', () => {
    const missing = (): string => {
      throw new Error('ENOENT');
    };
    expect(describeForeignMutationWindow(missing, undefined)).toBeNull();
    expect(
      describeForeignMutationWindow(() => 'not json', undefined),
    ).toBeNull();
    // A lock with no token is debris, not a window.
    expect(
      describeForeignMutationWindow(lock({ token: 42 }), undefined),
    ).toBeNull();
  });

  it('stops an unowned window even when the run carries no token at all', () => {
    // The ordinary developer case: a plain `npx vitest` during a harness run.
    expect(describeForeignMutationWindow(lock(), undefined)).not.toBeNull();
  });
});
