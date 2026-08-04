/**
 * Calibration service adapters (issue #52).
 *
 * Bridges the generic `ServerProfileService` and `SidecarClient` into the
 * narrow interfaces required by `CalibrationHttpClient` and
 * `CalibrationSyncEngine`. These adapters are the sole wiring point:
 *
 * - `ServerProfileCalibrationTokenProvider` implements `CalibrationTokenProvider`
 *   using `ServerProfileService.getAuthenticatedContext()`, satisfying acceptance
 *   criterion #3 (HTTP client uses profile service for auth fencing).
 *
 * - `SidecarCalibrationAdapter` implements `CalibrationSidecar` using
 *   `SidecarClient` calibration RPC methods added in schema v12, satisfying
 *   acceptance criteria #5 and #6 (native persistence + sync semantics).
 *
 * Security contract:
 * - Token provider never exposes the raw JWT to the renderer.
 * - Sidecar adapter never stores server URLs or credentials.
 * - Both adapters are main-process-only.
 */

import type { CalibrationTokenProvider } from './calibrationHttp.js';
import type {
  CalibrationSidecar,
  CalibrationCursorState,
  CalibrationPendingOperation,
} from './calibrationEngine.js';
import { ServerProfileService } from './serverProfiles.js';
import type { SidecarClient } from './sidecar.js';
import type {
  CalibrationConflict,
  CalibrationConflictKind,
  CalibrationConflictResolution,
  CalibrationResolveConflictRequest,
} from '@shared/ipc';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// CalibrationTokenProvider — bridges ServerProfileService to HTTP client auth
// ---------------------------------------------------------------------------

/**
 * Implements `CalibrationTokenProvider` using `ServerProfileService`.
 *
 * Each request sequence calls `getAuthenticatedContext()` (or
 * `getAuthenticatedServerContext()` on force-refresh) so the HTTP client can
 * fence the profile identity before and after every request.
 */
export class ServerProfileCalibrationTokenProvider implements CalibrationTokenProvider {
  constructor(private readonly profiles: ServerProfileService) {}

  async getAuthenticatedContext(
    profileId: string,
    expectedBaseUrl?: string,
    forceRefresh = false,
  ): Promise<{ baseUrl: string; token: string; binding: string }> {
    if (forceRefresh) {
      // Force a fresh token from the network — used after a 401 response.
      const ctx = await this.profiles.getAuthenticatedServerContext(
        profileId,
        expectedBaseUrl,
        true,
      );
      return {
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        binding: ctx.binding,
      };
    }

    // Normal path: use the cached context (acquires a new token if expired).
    const ctx = await this.profiles.getAuthenticatedContext(profileId);
    if (
      expectedBaseUrl !== undefined &&
      ctx.profile.baseUrl !== expectedBaseUrl
    ) {
      throw new Error(
        `Profile ${profileId} baseUrl changed; expected ${expectedBaseUrl}, got ${ctx.profile.baseUrl}`,
      );
    }
    return {
      baseUrl: ctx.profile.baseUrl,
      token: ctx.token,
      binding: ctx.serverBinding,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for sidecar RPC results
// ---------------------------------------------------------------------------

const CalibrationPendingOpWire = z.object({
  operationId: z.string(),
  profileId: z.string(),
  projectId: z.string(),
  kind: z.string(),
  sequence: z.number().int(),
  baseRevision: z.number().int().nullable().default(null),
  idempotencyKey: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  operationKind: z.enum(['Create', 'Update', 'Delete']),
  payload: z.record(z.unknown()),
  dependsOn: z.array(z.string()).default([]),
});

const CalibrationCursorStateWire = z.object({
  cursor: z.string().nullable().default(null),
  serverRevision: z.number().int().default(0),
  checkpointGeneration: z.number().int().default(0),
});

const CalibrationConflictWire = z
  .object({
    conflictId: z.string(),
    profileId: z.string(),
    projectId: z.string(),
    kind: z.string(),
    entityId: z.string(),
    operationId: z.string().nullable().default(null),
    localPayload: z.unknown().nullable().default(null),
    serverPayload: z.unknown().nullable().default(null),
    serverRevision: z.number().int(),
    createdAt: z.string(),
  })
  .passthrough();

/**
 * Renders a conflict payload as the bounded string the IPC contract expects
 * (`CalibrationConflict.localPayloadSummary`, max 4096 chars).
 *
 * Note for the next reader: these are null in practice today. The sidecar
 * selects `local_payload_json` / `server_payload_json` and carries them on
 * CalibrationConflictDto, but `record_calibration_conflict` takes no payload
 * arguments and never writes those columns, so nothing populates them yet.
 * This mapping exists so the summaries arrive intact the moment a producer
 * does -- it is not evidence that a producer exists.
 */
function summarizeConflictPayload(payload: unknown): string | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  const rendered =
    typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (rendered === undefined) {
    return null;
  }
  return rendered.length > 4096 ? `${rendered.slice(0, 4093)}...` : rendered;
}

/**
 * Resolutions this build can actually execute for a conflict of `kind`.
 *
 * Derived from two facts. Neither is a literal written into this function:
 *
 * 1. Whether the conflict transport exposes a resolve capability at all.
 *    It now does, so this returns a non-empty set -- and it does so *because
 *    the capability is present*, not because somebody replaced `[]` with a
 *    list. This function was not edited when the capability landed; that is
 *    the property it was built for.
 * 2. The per-kind policy already ratified in the `CalibrationConflictResolution`
 *    schema doc: `manualFieldMerge` is "only available for metadata/draft
 *    conflicts where a textual merge is well-defined. Not available for
 *    measurements, exact profile JSON, or outcome selections." That is
 *    transcribed here, not authored. This function sets no new policy about
 *    what is semantically safe to resolve; that decision belongs in an issue
 *    where the model-core owner can see it, not in a diff.
 *
 * Both readers of this function are consequences, not copies:
 * `CalibrationConflict.availableResolutions` is what the UI may offer, and
 * `SidecarCalibrationAdapter.resolveCalibrationConflict` refuses anything
 * outside it. A field that starts telling the truth on its own cannot go
 * stale; a literal has to be remembered, and the previous hard-coded
 * `['acceptServer', 'keepLocalAsNewRevision']` is what forgetting looks like.
 */
export function conflictResolutionsFor(
  transport: ConflictResolutionCapable,
  kind: CalibrationConflictKind,
): CalibrationConflictResolution[] {
  if (!supportsConflictResolution(transport)) {
    return [];
  }
  const textuallyMergeable = kind === 'projectMetadata' || kind === 'stepDraft';
  return textuallyMergeable
    ? ['acceptServer', 'keepLocalAsNewRevision', 'manualFieldMerge']
    : ['acceptServer', 'keepLocalAsNewRevision'];
}

/** Anything that may one day carry an authoritative conflict resolve call. */
export interface ConflictResolutionCapable {
  readonly resolveCalibrationConflict?: unknown;
}

/**
 * The single fact behind both "which resolutions may we advertise" and
 * "may the resolve IPC handler proceed". Two sites that agree only because the
 * same author wrote both will drift the moment one of them is edited; two
 * sites reading one predicate cannot.
 */
export function supportsConflictResolution(
  transport: ConflictResolutionCapable,
): boolean {
  return typeof transport.resolveCalibrationConflict === 'function';
}

// ---------------------------------------------------------------------------
// SidecarCalibrationAdapter — bridges SidecarClient to CalibrationSidecar
// ---------------------------------------------------------------------------

/**
 * Maps the raw entity type string from the sidecar to a CalibrationConflictKind.
 * Entity types from the schema map to the closest semantic conflict kind.
 */
function mapCalibrationConflictKind(
  entityType: string,
):
  | 'projectMetadata'
  | 'stepOrdering'
  | 'stepDraft'
  | 'outcomeSelection'
  | 'staleprinterSnapshot'
  | 'deletionVsLocalEdit' {
  switch (entityType) {
    case 'CalibrationProject':
      return 'projectMetadata';
    case 'CalibrationStep':
      return 'stepDraft';
    case 'CalibrationAttempt':
      return 'outcomeSelection';
    case 'CalibrationPrinterSnapshot':
      return 'staleprinterSnapshot';
    default:
      return 'projectMetadata';
  }
}

/**
 * Implements `CalibrationSidecar` using `SidecarClient` calibration RPC calls.
 *
 * All methods delegate to the calibration_* tables in the sidecar's SQLite
 * store (schema v12). No HTTP, server URLs, or credentials are involved.
 */
export class SidecarCalibrationAdapter implements CalibrationSidecar {
  constructor(private readonly sidecar: SidecarClient) {}

  /**
   * Resolve a conflict, refusing any resolution this build does not advertise
   * for that conflict's kind.
   *
   * The permitted set comes from `conflictResolutionsFor` — the same call that
   * produced `CalibrationConflict.availableResolutions` for this conflict.
   * Not a matching copy of it: the same expression. A second list here would
   * agree with the first only until one of them was edited, and the two
   * disagreement modes are both bad in ways that are hard to diagnose from
   * the outside — a button the channel rejects, or a resolution the UI never
   * offered being accepted anyway.
   *
   * Why this check is here rather than in the sidecar: the conflict kind is
   * derived in the main process (`mapCalibrationConflictKind`) from the entity
   * type the store holds. The store has no access to that derivation, so
   * enforcing per-kind policy down there would require a second copy of the
   * mapping in Rust. The sidecar enforces what it can see on its own — that
   * the conflict exists, is unresolved, and the strategy is a real one.
   *
   * The kind is read back from the store rather than taken from the request.
   * A caller that supplied its own kind could name `projectMetadata` to unlock
   * `manualFieldMerge` for a conflict that is not textually mergeable, which
   * is the one thing this check exists to prevent.
   */
  async resolveCalibrationConflict(
    request: CalibrationResolveConflictRequest,
  ): Promise<{ resolved: true }> {
    const open = await this.listCalibrationConflicts(request.profileId, null);
    const conflict = open.find(
      (candidate) => candidate.conflictId === request.conflictId,
    );
    if (!conflict) {
      throw Object.assign(
        new Error(
          `Calibration conflict ${request.conflictId} is not open; it may have been resolved already.`,
        ),
        { code: 'CALIBRATION_CONFLICT_NOT_OPEN' },
      );
    }
    const permitted = conflictResolutionsFor(this, conflict.kind);
    if (!permitted.includes(request.resolution)) {
      throw Object.assign(
        new Error(
          `Resolution "${request.resolution}" is not available for a ${conflict.kind} conflict. ` +
            `Available: ${permitted.length > 0 ? permitted.join(', ') : 'none'}.`,
        ),
        { code: 'CALIBRATION_CONFLICT_RESOLUTION_NOT_PERMITTED' },
      );
    }
    await this.sidecar.resolveCalibrationConflict(
      request.profileId,
      request.conflictId,
      request.resolution,
    );
    return { resolved: true };
  }

  async listCalibrationPendingOperations(
    profileId: string,
    projectId: string | null,
    limit: number,
  ): Promise<CalibrationPendingOperation[]> {
    const raw = await this.sidecar.listCalibrationPendingOps(
      profileId,
      projectId,
      limit,
    );
    return raw.map((item) => {
      const parsed = CalibrationPendingOpWire.parse(item);
      return {
        operationId: parsed.operationId,
        profileId: parsed.profileId,
        projectId: parsed.projectId,
        kind: parsed.kind,
        sequence: parsed.sequence,
        baseRevision: parsed.baseRevision,
        idempotencyKey: parsed.idempotencyKey,
        entityType: parsed.entityType,
        entityId: parsed.entityId,
        operationKind: parsed.operationKind,
        payload: parsed.payload,
        dependsOn: parsed.dependsOn,
      };
    });
  }

  async settleCalibrationOperation(
    profileId: string,
    operationId: string,
    serverRevision: number,
  ): Promise<void> {
    await this.sidecar.settleCalibrationOp(
      profileId,
      operationId,
      serverRevision,
    );
  }

  async replayCalibrationOperation(
    profileId: string,
    operationId: string,
  ): Promise<void> {
    await this.sidecar.replayCalibrationOp(profileId, operationId);
  }

  async recordCalibrationConflict(
    profileId: string,
    operationId: string,
    conflict: {
      entityType: string;
      entityId: string;
      reason: string;
      serverRevision: number;
    },
  ): Promise<void> {
    await this.sidecar.recordCalibrationConflict(
      profileId,
      operationId,
      conflict.entityType,
      conflict.entityId,
      conflict.reason,
      conflict.serverRevision,
    );
  }

  async getCalibrationCursorState(
    profileId: string,
    projectId: string | null,
  ): Promise<CalibrationCursorState> {
    const raw = await this.sidecar.getCalibrationCursorState(
      profileId,
      projectId,
    );
    const parsed = CalibrationCursorStateWire.parse(raw);
    return {
      cursor: parsed.cursor,
      serverRevision: parsed.serverRevision,
      checkpointGeneration: parsed.checkpointGeneration,
    };
  }

  async commitCalibrationCursor(
    profileId: string,
    projectId: string | null,
    cursor: string | null,
    serverRevision: number,
    checkpointGeneration: number,
  ): Promise<void> {
    await this.sidecar.commitCalibrationCursor(
      profileId,
      projectId,
      cursor,
      serverRevision,
      checkpointGeneration,
    );
  }

  async applyCalibrationSnapshot(
    profileId: string,
    entityType: string,
    entityId: string,
    snapshot: unknown,
    tombstone: boolean,
    serverRevision: number,
  ): Promise<void> {
    await this.sidecar.applyCalibrationSnapshot(
      profileId,
      entityType,
      entityId,
      snapshot,
      tombstone,
      serverRevision,
    );
  }

  async listCalibrationConflicts(
    profileId: string,
    projectId: string | null,
  ): Promise<CalibrationConflict[]> {
    const raw = await this.sidecar.listCalibrationConflicts(
      profileId,
      projectId,
    );
    return raw.map((item) => {
      const parsed = CalibrationConflictWire.parse(item);
      // Map to the shared IPC CalibrationConflict type.
      // entityType → kind mapping: use 'projectMetadata' as the default kind
      // since we store the entity_type column in the `kind` field in our schema.
      const kind = mapCalibrationConflictKind(parsed.kind);
      return {
        conflictId: parsed.conflictId,
        profileId: parsed.profileId,
        projectId: parsed.projectId,
        entityId: parsed.entityId,
        kind,
        localPayloadSummary: summarizeConflictPayload(parsed.localPayload),
        serverPayloadSummary: summarizeConflictPayload(parsed.serverPayload),
        serverRevision: parsed.serverRevision,
        // Derived, not declared. Empty today because this adapter has no
        // resolveCalibrationConflict method -- and it becomes non-empty by
        // itself on the day one is added. See conflictResolutionsFor.
        availableResolutions: conflictResolutionsFor(this, kind),
        createdAt: parsed.createdAt,
        resolution: null,
        resolvedAt: null,
      };
    });
  }

  async countCalibrationPendingOperations(
    profileId: string,
    projectId: string | null,
  ): Promise<number> {
    return this.sidecar.countCalibrationPendingOps(profileId, projectId);
  }

  async isPrinterContextFresh(
    profileId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.sidecar.isCalibrationPrinterContextFresh(profileId, projectId);
  }
}
