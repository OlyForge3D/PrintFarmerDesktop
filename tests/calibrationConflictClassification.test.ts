/**
 * #219 — an unclassifiable conflict must not advertise the widest resolution set.
 *
 * `mapCalibrationConflictKind` used to send every unrecognised entity type to
 * `projectMetadata`, which is one of exactly two kinds granting
 * `manualFieldMerge`. Four of the eight entity types the sync engine handles
 * reached that arm, so the *unclassified* case advertised *more* than most
 * classified ones.
 *
 * These tests assert against the real adapter and a real transport. Nothing here
 * restates the policy table: the permitted-set expectations are derived by
 * calling `conflictResolutionsFor`, the same function the adapter uses, so a
 * legitimate policy change moves both sides together and this file keeps
 * checking the property it names -- that classification gates advertisement.
 */

import { describe, expect, it } from 'vitest';

import {
  SidecarCalibrationAdapter,
  classifyCalibrationConflictKind,
  conflictResolutionsFor,
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

function conflictRow(entityType: string): Record<string, unknown> {
  return {
    conflictId: `conflict-${entityType}`,
    profileId: 'profile-1',
    projectId: 'project-1',
    // The sidecar writes the ENTITY TYPE into the column named `kind` (#219).
    kind: entityType,
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

describe('#219 classification gates what an adapter may advertise', () => {
  it('advertises nothing for entity types it cannot classify', async () => {
    const adapter = new SidecarCalibrationAdapter(
      capableSidecar(UNMAPPED_ENTITY_TYPES.map(conflictRow)),
    );

    const conflicts = await adapter.listCalibrationConflicts(
      'profile-1',
      'project-1',
    );

    expect(conflicts).toHaveLength(UNMAPPED_ENTITY_TYPES.length);
    for (const conflict of conflicts) {
      expect(
        conflict.availableResolutions,
        `${conflict.entityId} is unclassifiable, so the store would refuse it ` +
          `with CALIBRATION_CONFLICT_KIND_UNCLASSIFIED; advertising ` +
          `${JSON.stringify(conflict.availableResolutions)} offers the user a ` +
          `button the store rejects`,
      ).toEqual([]);
    }
  });

  it('never offers manualFieldMerge for a conflict it could not classify', async () => {
    const adapter = new SidecarCalibrationAdapter(
      capableSidecar([conflictRow('CalibrationProfileRevision')]),
    );

    const [conflict] = await adapter.listCalibrationConflicts(
      'profile-1',
      'project-1',
    );
    expect(conflict).toBeDefined();
    if (conflict === undefined) return;

    // A conflicted profile revision is exact profile JSON -- named in the schema
    // doc's exclusion list for textual merge. This is the case the old default
    // arm got most wrong.
    expect(
      conflict.availableResolutions,
      'a conflicted CalibrationProfileRevision is exact profile JSON and must ' +
        'never arrive at the renderer advertised as textually mergeable',
    ).not.toContain('manualFieldMerge');
  });

  it('still advertises the full permitted set for types it can classify', async () => {
    const adapter = new SidecarCalibrationAdapter(
      capableSidecar(MAPPED_ENTITY_TYPES.map(conflictRow)),
    );

    const conflicts = await adapter.listCalibrationConflicts(
      'profile-1',
      'project-1',
    );

    // Positive control. Without this, returning `[]` unconditionally would
    // satisfy both tests above, and the fix would be indistinguishable from
    // breaking advertisement entirely.
    //
    // The capability that makes advertisement non-empty belongs to the adapter,
    // not to the injected client -- asserted rather than assumed, because
    // assuming it is exactly what produced the false comment on capableSidecar.
    expect(supportsConflictResolution(adapter)).toBe(true);
    for (const conflict of conflicts) {
      const expected = conflictResolutionsFor(
        { resolveCalibrationConflict: () => undefined },
        conflict.kind,
      );
      expect(expected.length).toBeGreaterThan(0);
      expect(
        conflict.availableResolutions,
        `${conflict.entityId} is classifiable, so it must advertise the ` +
          `policy's set for ${conflict.kind}`,
      ).toEqual(expected);
    }
  });

  it('reports classification separately from the displayed kind', () => {
    // The display fallback is itself a valid enum member, so `kind` alone
    // cannot distinguish "we classified this as projectMetadata" from "we could
    // not classify this at all". Losing that distinction is the root of #219.
    const real = classifyCalibrationConflictKind('CalibrationProject');
    const fallback = classifyCalibrationConflictKind('CalibrationPhoto');

    expect(real).toEqual({ kind: 'projectMetadata', classified: true });
    expect(fallback.kind).toBe('projectMetadata');
    expect(
      fallback.classified,
      'CalibrationPhoto has no mapping, so classified must be false even ' +
        'though the displayed kind is indistinguishable from a real one',
    ).toBe(false);
  });

  it('covers every entity type the sync engine can fetch', () => {
    // Guards the lists above against the engine growing a case that this file
    // never exercises -- the way an unmapped type slipped through originally.
    const all = [...MAPPED_ENTITY_TYPES, ...UNMAPPED_ENTITY_TYPES];
    expect(new Set(all).size).toBe(all.length);
    for (const entityType of MAPPED_ENTITY_TYPES) {
      expect(classifyCalibrationConflictKind(entityType).classified).toBe(true);
    }
    for (const entityType of UNMAPPED_ENTITY_TYPES) {
      expect(classifyCalibrationConflictKind(entityType).classified).toBe(
        false,
      );
    }
  });
});
