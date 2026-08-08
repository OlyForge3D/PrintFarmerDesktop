/**
 * #363 — the store writes `*_at` columns as epoch seconds; the IPC contract
 * declares them ISO-8601, and nothing converted between the two.
 *
 * `sqlite_catalog.rs: now_ts` returns whole seconds since the Unix epoch as
 * text, and its own docstring names that as the storage convention for every
 * `*_at` column. `CalibrationConflict` in `src/shared/ipc.ts` declares
 * `createdAt: z.string().datetime()` and `resolvedAt: z.string().datetime()`.
 * The adapter's wire schema types both as a bare `z.string()`, which accepts
 * `"1785881744"` without complaint, so the mismatch had no reader anywhere on
 * the path.
 *
 * Every expectation below is paired with a control, because the failure mode
 * this file exists to prevent is an assertion that cannot fail:
 *
 * - Asserting the emitted value *satisfies* the contract proves nothing unless
 *   the same input, unconverted, is shown to *violate* it. Otherwise "the
 *   contract accepts our output" is equally consistent with a contract that
 *   accepts anything. `UNCONVERTED_IS_REJECTED` is that control.
 * - Asserting the output merely *looks* like a timestamp is satisfied by a
 *   converter that ignores its input and returns the current time. So the
 *   converted instant is compared against the epoch value it came from.
 * - The already-ISO fixtures every other calibration test uses would pass
 *   whether or not a converter existed, which is why none of them caught this.
 *   These specs supply a genuine epoch value, which no fixture in the tree did.
 */

import { describe, expect, it } from 'vitest';

import { SidecarCalibrationAdapter } from '../src/main/calibrationService.js';
import type { SidecarClient } from '../src/main/sidecar.js';
import { CalibrationConflict, IpcChannel, ipcSchemas } from '@shared/ipc';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONFLICT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** A real value in the shape 
ow_ts() emits: whole seconds, as text. */
const EPOCH_SECONDS = '1785881744';
/** The same instant, in the form the contract declares. */
const EPOCH_AS_ISO = '2026-08-04T22:15:44.000Z';
/** A distinct, earlier instant -- used to prove createdAt and resolvedAt are
 * threaded through independently rather than one being copied from the other
 * (issue #525). */
const EARLIER_EPOCH_SECONDS = '1785800000';
const EARLIER_EPOCH_AS_ISO = '2026-08-03T23:33:20.000Z';

/**
 * The control the rest of the file rests on. If the contract ever stops
 * rejecting the raw store value, every "the contract accepts our output"
 * expectation below becomes vacuous, and this fails first and says so.
 */
const UNCONVERTED_IS_REJECTED = () => {
  expect(
    CalibrationConflict.shape.createdAt.safeParse(EPOCH_SECONDS).success,
    'the raw store value must VIOLATE the contract, or asserting that the ' +
      'converted value satisfies it proves nothing about the conversion',
  ).toBe(false);
};

function conflictRow(overrides: Record<string, unknown> = {}) {
  return {
    conflictId: CONFLICT_ID,
    profileId: PROFILE_ID,
    projectId: PROJECT_ID,
    // The entity type (#365 renamed the column from `kind` to `entity_type`;
    // the IPC contract's `kind` is now sourced from `conflictKind` below).
    entityType: 'CalibrationProject',
    conflictKind: 'projectMetadata',
    entityId: '44444444-4444-4444-8444-444444444444',
    operationId: null,
    localPayload: { displayName: 'local' },
    serverPayload: { displayName: 'server' },
    serverRevision: 7,
    createdAt: EPOCH_SECONDS,
    ...overrides,
  };
}

function listingSidecar(
  rows: readonly Record<string, unknown>[],
): SidecarClient {
  return {
    listCalibrationConflicts: () => Promise.resolve(rows),
  } as unknown as SidecarClient;
}

function resolvingSidecar(
  resolvedAt: unknown,
  createdAt: unknown,
): SidecarClient {
  return {
    resolveCalibrationConflict: () =>
      Promise.resolve({
        conflictId: CONFLICT_ID,
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        kind: 'projectMetadata',
        resolution: 'acceptServer',
        resolvedAt,
        createdAt,
        supersededObservations: [],
      }),
  } as unknown as SidecarClient;
}

describe('#363 sidecar epoch timestamps are converted at the adapter boundary', () => {
  it('emits a listed conflict whose createdAt the IPC contract accepts', async () => {
    UNCONVERTED_IS_REJECTED();

    const adapter = new SidecarCalibrationAdapter(
      listingSidecar([conflictRow()]),
    );

    const conflicts = await adapter.listCalibrationConflicts(
      PROFILE_ID,
      PROJECT_ID,
    );

    // Non-empty first: every claim below is about the contents of this array,
    // and an empty array satisfies a `for` loop silently.
    expect(conflicts).toHaveLength(1);

    const parsed = CalibrationConflict.safeParse(conflicts[0]);
    expect(
      parsed.success,
      `the adapter emitted a conflict the contract rejects: ${
        parsed.success ? '' : JSON.stringify(parsed.error?.issues)
      }`,
    ).toBe(true);
  });

  it('converts to the instant the epoch value names, not merely to some ISO string', async () => {
    const adapter = new SidecarCalibrationAdapter(
      listingSidecar([conflictRow()]),
    );

    const conflicts = await adapter.listCalibrationConflicts(
      PROFILE_ID,
      PROJECT_ID,
    );

    // Assert the captured set is non-empty BEFORE asserting anything about its
    // contents: every assertion below is vacuously satisfied by an empty array.
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts.at(0);
    if (!conflict) throw new Error('the adapter returned no conflicts');

    // A converter that ignored its input and returned `new Date()` would satisfy
    // a shape-only check. This pins the value.
    expect(conflict.createdAt).toBe(EPOCH_AS_ISO);
    expect(Date.parse(conflict.createdAt) / 1000).toBe(Number(EPOCH_SECONDS));
  });

  it('leaves an already-ISO value untouched rather than converting it twice', async () => {
    const adapter = new SidecarCalibrationAdapter(
      listingSidecar([conflictRow({ createdAt: '2026-01-01T00:00:00Z' })]),
    );

    const conflicts = await adapter.listCalibrationConflicts(
      PROFILE_ID,
      PROJECT_ID,
    );

    // Assert the captured set is non-empty BEFORE asserting anything about its
    // contents: every assertion below is vacuously satisfied by an empty array.
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts.at(0);
    if (!conflict) throw new Error('the adapter returned no conflicts');

    // Every other calibration fixture in the tree is already ISO. If the
    // converter mangled that form, this change would break them all -- and this
    // states the requirement here rather than leaving it to be inferred from
    // unrelated suites going red.
    expect(conflict.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('refuses a timestamp that is neither epoch seconds nor ISO-8601, naming the field', async () => {
    const adapter = new SidecarCalibrationAdapter(
      listingSidecar([conflictRow({ createdAt: 'yesterday afternoon' })]),
    );

    // A converter that passed unrecognised input through would reproduce the
    // very defect being fixed: a value reaching the contract unconverted and
    // unremarked. It must fail loudly, and say which field.
    await expect(
      adapter.listCalibrationConflicts(PROFILE_ID, PROJECT_ID),
    ).rejects.toThrow(/createdAt/);
  });

  it('converts resolvedAt on the resolve channel and satisfies the response contract', async () => {
    UNCONVERTED_IS_REJECTED();

    const adapter = new SidecarCalibrationAdapter(
      resolvingSidecar(EPOCH_SECONDS, EPOCH_SECONDS),
    );

    const response = await adapter.resolveCalibrationConflict({
      profileId: PROFILE_ID,
      conflictId: CONFLICT_ID,
      resolution: 'acceptServer',
    });

    expect(response.conflict.resolvedAt).toBe(EPOCH_AS_ISO);

    // Against the real channel schema, which is what the handler now parses
    // with -- so this spec and production read the same declaration.
    const parsed =
      ipcSchemas[IpcChannel.CalibrationResolveConflict].response.safeParse(
        response,
      );
    expect(
      parsed.success,
      `the resolve response violates its own channel contract: ${
        parsed.success ? '' : JSON.stringify(parsed.error?.issues)
      }`,
    ).toBe(true);
  });

  /**
   * #525 — `createdAt` must not be fabricated from `resolvedAt`.
   *
   * The store's resolution DTO now carries its own `created_at` (the
   * conflict's detection instant), threaded independently from
   * `resolved_at`. Before this fix, the adapter reused `resolvedAtIso` for
   * both fields, which is indistinguishable from a correct value by any
   * check that inspects the value rather than its provenance -- so this test
   * supplies a `createdAt` genuinely distinct from `resolvedAt` and asserts
   * neither collapses into the other.
   */
  it('reports the conflict-detection instant independently of the resolution instant', async () => {
    const adapter = new SidecarCalibrationAdapter(
      resolvingSidecar(EPOCH_SECONDS, EARLIER_EPOCH_SECONDS),
    );

    const response = await adapter.resolveCalibrationConflict({
      profileId: PROFILE_ID,
      conflictId: CONFLICT_ID,
      resolution: 'acceptServer',
    });

    expect(response.conflict.createdAt).toBe(EARLIER_EPOCH_AS_ISO);
    expect(response.conflict.resolvedAt).toBe(EPOCH_AS_ISO);
    expect(
      response.conflict.createdAt,
      'createdAt must not be fabricated from resolvedAt: a conflict that sat ' +
        'unresolved for any length of time must report distinct instants for ' +
        'when it was detected versus when it was resolved',
    ).not.toBe(response.conflict.resolvedAt);

    const parsed =
      ipcSchemas[IpcChannel.CalibrationResolveConflict].response.safeParse(
        response,
      );
    expect(
      parsed.success,
      `the resolve response violates its own channel contract: ${
        parsed.success ? '' : JSON.stringify(parsed.error?.issues)
      }`,
    ).toBe(true);
  });
});
