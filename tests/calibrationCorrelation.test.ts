// @vitest-environment node

/**
 * Correlation registry for calibration flows (issue #159).
 *
 * The acceptance criterion is that the correlation ID is *stable across the
 * stages of one user-initiated operation*. These tests assert the resolved
 * **values**, not that a `correlationId` key exists: a field that is always
 * `undefined` satisfies a key-presence check while proving nothing.
 */

import { describe, expect, it } from 'vitest';
import { CalibrationCorrelationRegistry } from '../src/main/calibrationCorrelation.js';

const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const ORCHESTRATION = '77777777-7777-4777-8777-777777777777';
const JOB = '44444444-4444-4444-8444-444444444444';

function counted(): {
  registry: CalibrationCorrelationRegistry;
  minted: () => number;
} {
  let mints = 0;
  const registry = new CalibrationCorrelationRegistry({
    mintId: () => {
      mints += 1;
      return `corr-${String(mints)}`;
    },
  });
  return { registry, minted: () => mints };
}

describe('CalibrationCorrelationRegistry', () => {
  it('resolves the same value across generation, orchestration, queue and acknowledgement', () => {
    const { registry, minted } = counted();
    const started = registry.beginFlow({
      attempt: ATTEMPT,
      operation: OPERATION,
    });
    registry.bind('orchestration', ORCHESTRATION, started);
    registry.bind('job', JOB, started);

    const atPoll = registry.resolveOrBegin([['orchestration', ORCHESTRATION]]);
    const atQueue = registry.resolveOrBegin([['job', JOB]]);
    const atAck = registry.resolveOrBegin([
      ['job', JOB],
      ['operation', OPERATION],
    ]);

    // Values, not keys. All four stages must be the *same* string.
    expect(started).toBe('corr-1');
    expect([atPoll, atQueue, atAck]).toEqual([started, started, started]);
    // And exactly one flow was minted: a fresh mint per stage would still make
    // every stage "have a correlationId" while breaking the stability claim.
    expect(minted()).toBe(1);
  });

  it('gives two independent flows distinct values', () => {
    const { registry } = counted();
    const first = registry.beginFlow({ attempt: ATTEMPT });
    const second = registry.beginFlow({ attempt: 'other-attempt' });
    expect(first).not.toBe(second);
  });

  it('mints a new flow when nothing is bound, and binds it for later stages', () => {
    const { registry, minted } = counted();
    const first = registry.resolveOrBegin([['job', JOB]]);
    expect(minted()).toBe(1);
    // A later stage carrying the same job resolves the minted flow rather than
    // starting another one.
    expect(registry.resolveOrBegin([['job', JOB]])).toBe(first);
    expect(minted()).toBe(1);
  });

  it('back-fills the identifiers a stage supplies for the first time', () => {
    const { registry } = counted();
    const started = registry.beginFlow({ operation: OPERATION });
    // The queue stage learns the job id; the acknowledgement then resolves
    // through the job alone.
    registry.resolveOrBegin([
      ['operation', OPERATION],
      ['job', JOB],
    ]);
    expect(registry.resolve('job', JOB)).toBe(started);
  });

  it('returns null for an unbound or empty identifier', () => {
    const { registry } = counted();
    expect(registry.resolve('job', JOB)).toBeNull();
    expect(registry.resolve('job', '')).toBeNull();
    expect(registry.resolve('job', null)).toBeNull();
  });

  it('evicts oldest-first at the bound instead of growing without limit', () => {
    const registry = new CalibrationCorrelationRegistry({
      maxEntries: 3,
      mintId: () => 'corr-fixed',
    });
    for (let index = 0; index < 10; index += 1) {
      registry.bind('job', `job-${String(index)}`, `corr-${String(index)}`);
    }
    expect(registry.size()).toBe(3);
    // The oldest is gone, the newest survives.
    expect(registry.resolve('job', 'job-0')).toBeNull();
    expect(registry.resolve('job', 'job-9')).toBe('corr-9');
  });

  it('keeps a re-bound identifier alive against eviction', () => {
    const registry = new CalibrationCorrelationRegistry({
      maxEntries: 2,
      mintId: () => 'corr-fixed',
    });
    registry.bind('job', 'a', 'corr-a');
    registry.bind('job', 'b', 'corr-b');
    // Touching 'a' makes it the most recent, so adding 'c' must evict 'b'.
    registry.bind('job', 'a', 'corr-a');
    registry.bind('job', 'c', 'corr-c');
    expect(registry.resolve('job', 'a')).toBe('corr-a');
    expect(registry.resolve('job', 'b')).toBeNull();
  });

  it('does not refresh eviction position on a bare resolve', () => {
    // Paired with the test below: the two arms differ in exactly one thing —
    // which accessor touches 'a' — so the asymmetry the module docblock claims
    // is the only thing that can explain a difference in outcome.
    const registry = new CalibrationCorrelationRegistry({
      maxEntries: 2,
      mintId: () => 'corr-fixed',
    });
    registry.bind('job', 'a', 'corr-a');
    registry.bind('job', 'b', 'corr-b');
    // A lookup is not a touch, so 'a' is still the oldest and 'a' is what goes.
    expect(registry.resolve('job', 'a')).toBe('corr-a');
    registry.bind('job', 'c', 'corr-c');
    expect(registry.resolve('job', 'a')).toBeNull();
    expect(registry.resolve('job', 'b')).toBe('corr-b');
  });

  it('does refresh eviction position when resolved through resolveOrBegin', () => {
    const registry = new CalibrationCorrelationRegistry({
      maxEntries: 2,
      mintId: () => 'corr-fixed',
    });
    registry.bind('job', 'a', 'corr-a');
    registry.bind('job', 'b', 'corr-b');
    // Re-binds every candidate on a hit, so 'a' becomes the most recent.
    const hit = registry.resolveOrBeginWithOrigin([['job', 'a']]);
    expect(hit.correlationId).toBe('corr-a');
    expect(hit.origin).toBe('continued');
    registry.bind('job', 'c', 'corr-c');
    expect(registry.resolve('job', 'a')).toBe('corr-a');
    expect(registry.resolve('job', 'b')).toBeNull();
  });

  it('does not confuse identifiers that collide across kinds', () => {
    const registry = new CalibrationCorrelationRegistry({
      mintId: () => 'corr-x',
    });
    registry.bind('job', 'shared-id', 'corr-job');
    registry.bind('orchestration', 'shared-id', 'corr-orchestration');
    expect(registry.resolve('job', 'shared-id')).toBe('corr-job');
    expect(registry.resolve('orchestration', 'shared-id')).toBe(
      'corr-orchestration',
    );
  });

  it('reports how it answered, so a continued flow is distinguishable', () => {
    const { registry } = counted();
    const first = registry.beginFlow({ attempt: ATTEMPT });
    const later = registry.resolveOrBeginWithOrigin([['attempt', ATTEMPT]]);
    expect(later.correlationId).toBe(first);
    expect(later.origin).toBe('continued');
  });

  it('marks a flow it has never seen as resumed rather than continued', () => {
    const { registry } = counted();
    const cold = registry.resolveOrBeginWithOrigin([['job', JOB]]);
    // Assert the value, not the key: an origin that were always undefined
    // would satisfy a presence check and tell an operator nothing.
    expect(cold.origin).toBe('resumed');
    expect(cold.correlationId).not.toBe('');
  });

  it('declares a lost correlation when eviction drops a flow mid-operation', () => {
    // The eviction trapdoor: the flow whose bindings age out is a long, slow,
    // failing one, which is exactly the incident the runbooks exist for. This
    // pins what a stage emits *after* that has happened, so #160 can describe a
    // signature rather than a silence.
    const { registry, minted } = counted();
    const original = registry.beginFlow({ attempt: ATTEMPT });
    registry.bind('job', JOB, original);

    // Push the flow's bindings past the bound with unrelated traffic.
    const bound = new CalibrationCorrelationRegistry({
      maxEntries: 4,
      mintId: () => 'unused',
    });
    bound.bind('attempt', ATTEMPT, 'corr-victim');
    bound.bind('job', JOB, 'corr-victim');
    for (let index = 0; index < 8; index += 1) {
      bound.bind(
        'job',
        `filler-${String(index)}`,
        `corr-filler-${String(index)}`,
      );
    }
    expect(
      bound.resolve('job', JOB),
      'the eviction never happened, so the assertions below prove nothing',
    ).toBeNull();

    const after = bound.resolveOrBeginWithOrigin([['job', JOB]]);
    expect(
      after.correlationId,
      'an evicted flow must not silently reuse the correlation ID it lost',
    ).not.toBe('corr-victim');
    expect(
      after.origin,
      'an evicted flow must announce that its later stages are no longer correlated',
    ).toBe('resumed');

    // The unevicted registry is the control: same call, and it continues.
    expect(registry.resolveOrBeginWithOrigin([['job', JOB]])).toEqual({
      correlationId: original,
      origin: 'continued',
    });
    expect(minted()).toBe(1);
  });
});
