import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #467. `distanceToTip` in `scripts/sha-status.mjs` now carries a cross-check:
 * if `isAncestor(sha, base)` is true, the reverse range `base..sha` must count
 * zero, or the forward count is discarded in favour of `null` (unmeasurable).
 *
 * That invariant cannot be broken by a real repository — git will never
 * report an ancestor with a nonzero reverse count — so it can only be
 * exercised by controlling what the underlying `git` calls return. This file
 * mocks `node:child_process` to do exactly that, isolated from
 * `shaStatus.test.ts`'s real-repository harness (which needs a real
 * `execFileSync` and cannot share a module mock with this file).
 */
const mocks = vi.hoisted(() => ({
  responses: new Map<string, string>(),
}));

vi.mock('node:child_process', () => {
  const execFileSync = (_command: string, args: readonly string[]) => {
    const key = args.join(' ');
    const response = mocks.responses.get(key);
    if (response === undefined) {
      throw Object.assign(new Error(`unmocked git invocation: ${key}`), {
        status: 128,
      });
    }
    if (response === '__FAIL__') {
      throw Object.assign(new Error('simulated git failure'), { status: 1 });
    }
    return response;
  };
  return { execFileSync, default: { execFileSync } };
});

const { distanceToTip } = await import('../scripts/sha-status.mjs');

afterEach(() => {
  mocks.responses.clear();
});

describe('#467: distanceToTip cross-checks the reverse range before trusting the forward one', () => {
  it('returns the forward count when the reverse range agrees (ancestor, reverse is zero)', () => {
    mocks.responses.set('rev-list --count sha..base', '4');
    mocks.responses.set('merge-base --is-ancestor sha base', '');
    mocks.responses.set('rev-list --count base..sha', '0');

    expect(distanceToTip('sha', 'base')).toBe(4);
  });

  it('returns null instead of the forward count when the reverse range disagrees', () => {
    // Simulates the #467 mechanism's outward symptom: a forward count that
    // looks plausible (7) alongside an is-ancestor answer the count cannot be
    // true simultaneously with. The cross-check must refuse to publish 7.
    mocks.responses.set('rev-list --count sha..base', '7');
    mocks.responses.set('merge-base --is-ancestor sha base', '');
    mocks.responses.set('rev-list --count base..sha', '7');

    expect(distanceToTip('sha', 'base')).toBeNull();
  });

  it('does not require reverse-range agreement when sha is not an ancestor of base', () => {
    mocks.responses.set('rev-list --count sha..base', '3');
    // is-ancestor exits nonzero (not an ancestor); execFileSync throws.
    mocks.responses.set('merge-base --is-ancestor sha base', '__FAIL__');

    expect(distanceToTip('sha', 'base')).toBe(3);
  });
});
