/**
 * Issue #365 — `conflict_kind` is the IPC contract's source for `kind`, not
 * `entity_type`.
 *
 * Before this issue, the list path re-derived a displayed kind from the raw
 * entity type on every read (`classifyCalibrationConflictKind`), with a
 * guessed fallback (`projectMetadata`) for anything it could not map. That
 * guess is gone: `mapCalibrationConflictKind` is now a write-time classifier
 * only (called once, when a conflict is recorded), and the list path reads
 * `conflictKind` back from the wire directly. A conflict whose `conflictKind`
 * is null or not a member of the six-value enum is excluded from the
 * returned list rather than advertised under a fabricated kind.
 *
 * These tests assert against the real adapter and a real transport. Nothing
 * here restates the store's resolution policy: the wire fixture below
 * supplies `availableResolutions` the way the real store would (issue #304 --
 * the store is now the only place that table exists), and these tests check
 * only the property they name -- that only a classified conflict is
 * advertised, under the kind the store actually recorded, with whatever
 * resolutions the wire said and nothing else.
 */

import { describe, expect, it } from 'vitest';

import {
  SidecarCalibrationAdapter,
  mapCalibrationConflictKind,
  supportsConflictResolution,
} from '../src/main/calibrationService.js';
import type { SidecarClient } from '../src/main/sidecar.js';

/**
 * Every entity type the sync engine's `fetchAggregate` switch names, which is
 * the authoritative list of what can reach the conflict table.
 * See `src/main/calibrationEngine.ts`.
 */
const MAPPED_ENTITY_TYPES = [
  'CalibrationProject',
  'CalibrationStep',
  'CalibrationAttempt',
  'CalibrationPrinterSnapshot',
] as const;

const UNMAPPED_ENTITY_TYPES = [
  'CalibrationEvent',
  'CalibrationObservation',
  'CalibrationPhoto',
  'CalibrationProfileRevision',
] as const;

/**
 * A single, kind-agnostic stand-in for whatever `available_resolutions()`
 * (`native/model-core/src/sync.rs`) put on the wire. Deliberately the *same*
 * value for every classified kind, and deliberately not the real per-kind
 * policy for any of them (e.g. `stepOrdering` never really gets
 * `manualFieldMerge`) -- a per-kind table here, correct or not, would be
 * exactly the second transcription issue #304 removed, just moved into a
 * test fixture. These tests only exercise "the adapter passes through
 * whatever the wire said, unfiltered by kind"; they must stay unable to
 * observe what the real per-kind policy is at all.
 */
const FIXTURE_AVAILABLE_RESOLUTIONS = [
  'keepLocalAsNewRevision',
  'manualFieldMerge',
] as const;

/**
 * Builds a wire-shaped conflict row the way the store now produces one:
 * `entityType` carries the entity type, `conflictKind` carries whatever was
 * classified (and persisted) for it at record time -- `null` when
 * `mapCalibrationConflictKind` returned `null`, exactly mirroring what
 * `record_calibration_conflict` would have stored -- and `availableResolutions`
 * carries the fixture value above for any classified kind, mirroring the
 * *shape* of what `calibration_conflict_from_row` sends without asserting
 * anything about the real per-kind contents.
 */
function conflictRow(entityType: string): Record<string, unknown> {
  const kind = mapCalibrationConflictKind(entityType);
  return {
    conflictId: `conflict-${entityType}`,
    profileId: 'profile-1',
    projectId: 'project-1',
    entityType,
    conflictKind: kind,
    availableResolutions: kind ? FIXTURE_AVAILABLE_RESOLUTIONS : [],
    entityId: `entity-${entityType}`,
    operationId: null,
    localPayload: { displayName: 'local' },
    serverPayload: { displayName: 'server' },
    serverRevision: 7,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

/**
 * A sidecar stub supplying only what the list path consumes.
 *
 * Note what does *not* make the adapter resolve-capable: this object. The
 * adapter passes **itself** to `conflictResolutionsFor`, and it owns a
 * `resolveCalibrationConflict` method (#296), so advertisement is driven by the
 * adapter class rather than by the injected client. An earlier version of this
 * helper carried a `resolveCalibrationConflict` stub and a comment claiming it
 * guarded against the masking-guard failure. **Removing that stub changed
 * nothing, which is how the claim was found to be false** -- the comment
 * described a mechanism that was not there, the same defect class as #304.
 *
 * The real guard against "everything is `[]`, so the assertions pass for the
 * wrong reason" is the positive control below, which fails if advertisement is
 * empty for a classifiable kind.
 */
function capableSidecar(
  rows: readonly Record<string, unknown>[],
): SidecarClient {
  return {
    listCalibrationConflicts: () => Promise.resolve(rows),
  } as unknown as SidecarClient;
}

describe('#365 conflict_kind, not entity_type, is the source of the listed kind', () => {
  it('excludes conflicts it cannot classify from the returned list', async () => {
    const adapter = new SidecarCalibrationAdapter(
      capableSidecar(UNMAPPED_ENTITY_TYPES.map(conflictRow)),
    );

    const conflicts = await adapter.listCalibrationConflicts(
      'profile-1',
      'project-1',
    );

    // The falsifier: an unclassified conflict (conflictKind: null) must not
    // appear in the list at all -- not with an empty `availableResolutions`,
    // not under a guessed `kind`. The store already refuses to *resolve*
    // these (CALIBRATION_CONFLICT_KIND_UNCLASSIFIED); listing them as
    // classified-but-unresolvable would offer a button the store rejects.
    expect(
      conflicts,
      'entity types with no ratified conflict kind must be refused, not guessed',
    ).toHaveLength(0);
  });

  it('never offers manualFieldMerge for a conflict it could not classify', async () => {
    const adapter = new SidecarCalibrationAdapter(
      capableSidecar([conflictRow('CalibrationProfileRevision')]),
    );

    const conflicts = await adapter.listCalibrationConflicts(
      'profile-1',
      'project-1',
    );

    // A conflicted profile revision is exact profile JSON -- named in the
    // schema doc's exclusion list for textual merge. Unreachable today
    // (unclassified conflicts are excluded above), but if a future entity
    // type maps here, it must never be excluded via `manualFieldMerge`
    // sneaking through instead of via omission.
    for (const conflict of conflicts) {
      expect(conflict.availableResolutions).not.toContain('manualFieldMerge');
    }
  });

  it('lists classified conflicts under the recorded conflictKind, not a re-derived one', async () => {
    const adapter = new SidecarCalibrationAdapter(
      capableSidecar(MAPPED_ENTITY_TYPES.map(conflictRow)),
    );

    const conflicts = await adapter.listCalibrationConflicts(
      'profile-1',
      'project-1',
    );

    expect(conflicts).toHaveLength(MAPPED_ENTITY_TYPES.length);

    // Positive control. Without this, excluding everything would satisfy the
    // exclusion test above, and the fix would be indistinguishable from
    // breaking listing entirely.
    expect(supportsConflictResolution(adapter)).toBe(true);
    for (const conflict of conflicts) {
      expect(
        conflict.availableResolutions,
        `${conflict.entityId} is classifiable, so it must advertise exactly ` +
          'what the store sent, unfiltered by kind -- the adapter has no ' +
          'per-kind opinion left to filter with',
      ).toEqual(FIXTURE_AVAILABLE_RESOLUTIONS);
    }
  });

  it('never accepts an entity-type-shaped value as a conflictKind', async () => {
    // The two columns cannot both be read as the conflict vocabulary: a row
    // whose conflictKind was (incorrectly) populated with the entity type
    // string must be refused exactly like a null conflictKind, because
    // 'CalibrationProfileRevision' is not a member of CalibrationConflictKind.
    const adapter = new SidecarCalibrationAdapter(
      capableSidecar([
        {
          conflictId: 'conflict-mismatched',
          profileId: 'profile-1',
          projectId: 'project-1',
          entityType: 'CalibrationProfileRevision',
          conflictKind: 'CalibrationProfileRevision',
          entityId: 'entity-mismatched',
          operationId: null,
          localPayload: null,
          serverPayload: null,
          serverRevision: 7,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]),
    );

    const conflicts = await adapter.listCalibrationConflicts(
      'profile-1',
      'project-1',
    );

    expect(conflicts).toHaveLength(0);
  });

  it('classifies every mapped entity type and refuses every unmapped one', () => {
    // Guards the lists above against the engine growing a case that this file
    // never exercises -- the way an unmapped type slipped through originally.
    const all = [...MAPPED_ENTITY_TYPES, ...UNMAPPED_ENTITY_TYPES];
    expect(new Set(all).size).toBe(all.length);
    for (const entityType of MAPPED_ENTITY_TYPES) {
      expect(mapCalibrationConflictKind(entityType)).not.toBeNull();
    }
    for (const entityType of UNMAPPED_ENTITY_TYPES) {
      expect(mapCalibrationConflictKind(entityType)).toBeNull();
    }
  });

  it('falsifier: record then list through the real adapter yields a kind in the six-value enum', async () => {
    const CONFLICT_KINDS = [
      'projectMetadata',
      'stepOrdering',
      'stepDraft',
      'outcomeSelection',
      'staleprinterSnapshot',
      'deletionVsLocalEdit',
    ];

    const recorded: Record<string, unknown>[] = [];
    const sidecar = {
      recordCalibrationConflict: (
        _profileId: string,
        _operationId: string,
        entityType: string,
        entityId: string,
        _reason: string,
        serverRevision: number,
        conflictKind?: string,
      ) => {
        recorded.push({
          conflictId: `conflict-${entityId}`,
          profileId: 'profile-1',
          projectId: 'project-1',
          entityType,
          conflictKind: conflictKind ?? null,
          entityId,
          operationId: null,
          localPayload: null,
          serverPayload: null,
          serverRevision,
          createdAt: '2026-01-01T00:00:00Z',
        });
        return Promise.resolve();
      },
      listCalibrationConflicts: () => Promise.resolve(recorded),
    } as unknown as SidecarClient;

    const adapter = new SidecarCalibrationAdapter(sidecar);

    // Record through the normal path: classify at record time, exactly as
    // `calibrationEngine.ts`'s push loop does.
    const entityType = 'CalibrationProject';
    await adapter.recordCalibrationConflict('profile-1', 'operation-1', {
      entityType,
      entityId: 'project-1',
      reason: 'server revision moved ahead',
      serverRevision: 9,
      conflictKind: mapCalibrationConflictKind(entityType),
    });

    // Read it back through the IPC contract.
    const [conflict] = await adapter.listCalibrationConflicts(
      'profile-1',
      'project-1',
    );

    expect(conflict).toBeDefined();
    expect(CONFLICT_KINDS).toContain(conflict!.kind);
  });
});
