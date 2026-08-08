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
import {
  CalibrationConflictKind as CalibrationConflictKindSchema,
  type CalibrationConflict,
  type CalibrationConflictKind,
  type CalibrationConflictResolution,
  type CalibrationResolveConflictRequest,
  type CalibrationResolveConflictResponse,
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
    /**
     * The conflicted row's entity type (e.g. `CalibrationProject`), sourced
     * from the store's `entity_type` column. Renamed from `kind` (issue
     * #365): this field never carried a conflict kind, and naming it `kind`
     * invited exactly the defect this issue fixes -- parsing it against the
     * six-value `CalibrationConflictKind` enum, which no entity type is ever
     * a member of.
     */
    entityType: z.string(),
    entityId: z.string(),
    operationId: z.string().nullable().default(null),
    localPayload: z.unknown().nullable().default(null),
    serverPayload: z.unknown().nullable().default(null),
    serverRevision: z.number().int(),
    createdAt: z.string(),
    /**
     * The ratified conflict kind, when the store classified this conflict at
     * record time. This -- not `entityType` -- is the IPC contract's source
     * for `CalibrationConflict.kind` (issue #365). `null` means unclassified;
     * the list path below refuses to guess a kind for it rather than
     * fabricating one.
     */
    conflictKind: z.string().nullable().default(null),
  })
  .passthrough();

/**
 * The exact predicate `CalibrationConflict` enforces on its timestamp fields.
 * Declared once so the pass-through branch below cannot drift away from the
 * contract it is standing in for.
 */
const IsoTimestamp = z.string().datetime();

/**
 * Convert a sidecar `*_at` value into the ISO-8601 the IPC contract declares.
 *
 * The store writes those columns as whole seconds since the Unix epoch, as text
 * (`sqlite_catalog.rs: now_ts`), and says so in that function's own docstring.
 * The IPC contract declares them `z.string().datetime()`. Both are internally
 * consistent; nothing converted between them, so `calibration_conflicts.created_at`
 * reached a `.datetime()` parse as `"1785881744"` and was rejected.
 *
 * The conversion belongs at this boundary and not in the store. `now_ts` has
 * eleven call sites across the catalog, so changing it would rewrite the on-disk
 * format of every `*_at` column at once and leave every already-persisted row in
 * the old format — a strictly larger blast radius than the defect, and one no
 * evidence here supports.
 *
 * A value already in ISO-8601 passes through unchanged, gated on `IsoTimestamp`
 * rather than on a looser check, so "accepted here" and "accepted by the
 * contract" cannot diverge. Anything that is neither form throws and names the
 * field, because returning it unchanged is precisely the behaviour that let an
 * epoch timestamp travel to the renderer unremarked.
 */
function sidecarTimestampToIso(value: string, field: string): string {
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) {
      throw new Error(
        `${field}: sidecar epoch seconds outside the safe integer range: ${value}`,
      );
    }
    return new Date(seconds * 1000).toISOString();
  }
  if (IsoTimestamp.safeParse(value).success) {
    return value;
  }
  throw new Error(
    `${field}: sidecar timestamp is neither epoch seconds nor ISO-8601: ${value}`,
  );
}

/**
 * The store's resolution result.
 *
 * `supersededObservations` has no `.default([])`. The store always emits the
 * field, so a default here would only ever fire when the response did *not*
 * report supersession — silently converting "unexamined" into "nothing was
 * superseded", which is precisely the conflation the field exists to prevent.
 * Making it required means that failure arrives as a parse error naming the
 * missing field instead of as a clean-looking empty list.
 */
const CalibrationConflictResolutionWire = z
  .object({
    conflictId: z.string(),
    profileId: z.string(),
    projectId: z.string(),
    kind: z.enum([
      'projectMetadata',
      'stepOrdering',
      'stepDraft',
      'outcomeSelection',
      'staleprinterSnapshot',
      'deletionVsLocalEdit',
    ]),
    resolution: z.enum([
      'acceptServer',
      'keepLocalAsNewRevision',
      'manualFieldMerge',
    ]),
    resolvedAt: z.string(),
    revisionId: z.string().nullable().default(null),
    supersedesRevisionId: z.string().nullable().default(null),
    supersededObservations: z.array(
      z.object({
        observationId: z.string(),
        attemptId: z.string(),
        stepId: z.string(),
        parameterKey: z.string(),
        boundSnapshotRevision: z.number().int(),
      }),
    ),
    replayed: z.boolean().default(false),
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
 *    `SidecarCalibrationAdapter` now has one (#296), so for that transport this
 *    returns the table below rather than `[]` -- and it does so *because the
 *    capability is present*, not because somebody edited this function. A
 *    transport without the method still gets `[]`.
 * 2. The per-kind policy already ratified in the `CalibrationConflictResolution`
 *    schema doc: `manualFieldMerge` is "only available for metadata/draft
 *    conflicts where a textual merge is well-defined. Not available for
 *    measurements, exact profile JSON, or outcome selections." That is
 *    transcribed here, not authored. This function sets no new policy about
 *    what is semantically safe to resolve; that decision belongs in an issue
 *    where the model-core owner can see it, not in a diff.
 *
 * The capability half worked exactly as designed: #296 gave the adapter a
 * `resolveCalibrationConflict` method, and this function started returning
 * resolutions with neither call site edited. **What went stale was the comment
 * that used to stand here**, which described the pre-#296 state in the present
 * tense -- "today it does not, so this returns `[]` for every kind". The
 * self-activating value could not go stale; the prose asserting that it could
 * not, did. A correct design documented in a tense that expires reads as
 * current, because the design it describes really is still working.
 *
 * The transcription half of point 2 is the part with no such protection, and it
 * is why `tests/calibrationResolutionPolicyParity.test.ts` exists. The same
 * policy is enforced by `CalibrationConflictKind::available_resolutions` in
 * `native/model-core/src/sync.rs`, which is what
 * `sqlite_catalog.rs` rejects against. Two transcriptions of one ratified
 * policy across a language boundary agreed only because two authors were
 * careful (#304). **Editing the branch below without editing the Rust table
 * now fails that test**, in both directions: over-advertising offers the user a
 * button the store rejects, and under-advertising hides a permitted resolution
 * with no error at all.
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
 * Maps the raw entity type string from a sync conflict to the ratified
 * `CalibrationConflictKind` it should be recorded under, or `null` when no
 * entity type in this switch names it.
 *
 * **This is a write-time classifier (issue #365), not a display helper.**
 * `calibrationEngine.ts`'s push loop calls it to compute the `conflictKind`
 * passed to `recordCalibrationConflict` alongside `entityType`, which
 * `SidecarCalibrationAdapter` forwards unchanged. The list path no longer
 * calls this function at all: it reads `conflict_kind` back from the store
 * as the contract's source of truth, because re-deriving a kind from
 * `entity_type` on read is exactly the guessing this issue removes (see
 * `classifyCalibrationConflictKind`, deleted with it).
 *
 * `null` is still the point of the `default` arm. `stepOrdering` and
 * `deletionVsLocalEdit` are unreachable from any entity type and are not
 * added here -- `deletionVsLocalEdit` in particular cannot be derived from an
 * entity type at all, it is a property of the sync *operation*. A conflict
 * classified `null` here is recorded with `conflict_kind = NULL`: the store
 * already refuses to resolve it (`CALIBRATION_CONFLICT_KIND_UNCLASSIFIED`),
 * and the list path now refuses to advertise it as classified rather than
 * guessing a display kind for it (issue #219's residual default arm).
 */
export function mapCalibrationConflictKind(
  entityType: string,
): CalibrationConflictKind | null {
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
      return null;
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
   * Resolve a calibration conflict through the authoritative store.
   *
   * Present, so `conflictResolutionsFor` now returns resolutions and the
   * resolve IPC handler stops refusing. Neither of those sites was edited to
   * make that happen: both read `supportsConflictResolution`, and assigning
   * this method is the whole change. That was the point of the seam.
   *
   * The per-kind policy is **not** re-checked here. It is enforced in the store
   * (`resolve_calibration_conflict` in `native/model-core/src/sqlite_catalog.rs`)
   * against the ratified table in `sync.rs`, reading the kind back from the
   * stored row rather than from this request. A second copy here would be a
   * second place to be wrong, and an adapter-side check is a convention the
   * next writer of a store method can bypass without noticing.
   *
   * Historical note kept because the mechanism is easy to reintroduce: this was
   * previously `declare readonly resolveCalibrationConflict?: ...`, and the
   * `declare` was load-bearing. This project targets ES2022, so
   * `useDefineForClassFields` is on, and a plain optional *field* declaration
   * emits an own property initialised to `undefined` on every instance, which
   * shadows the prototype and makes the capability probe report absent. A
   * method like this one lives on the prototype and is not affected — but
   * turning it back into a field would silently re-break the seam with
   * typecheck, lint and every existing test still green.
   */
  async resolveCalibrationConflict(
    request: CalibrationResolveConflictRequest,
  ): Promise<CalibrationResolveConflictResponse> {
    const raw = await this.sidecar.resolveCalibrationConflict({
      profileId: request.profileId,
      conflictId: request.conflictId,
      resolution: request.resolution,
      mergedFields: request.mergedFields,
    });
    const parsed = CalibrationConflictResolutionWire.parse(raw);
    const resolvedAtIso = sidecarTimestampToIso(
      parsed.resolvedAt,
      'resolvedAt',
    );
    return {
      conflict: {
        conflictId: parsed.conflictId,
        profileId: parsed.profileId,
        projectId: parsed.projectId,
        kind: parsed.kind,
        entityId: request.conflictId,
        localPayloadSummary: null,
        serverPayloadSummary: null,
        serverRevision: 0,
        availableResolutions: conflictResolutionsFor(this, parsed.kind),
        resolvedAt: resolvedAtIso,
        resolution: parsed.resolution,
        // NOT the creation instant: the resolution DTO carries no `created_at`,
        // so no honest value is available at this boundary and this one is
        // fabricated from the resolution instant. Converting the format does not
        // repair it — a well-formed ISO string is exactly what makes the
        // fabrication survive the response parse added for this issue. Filed
        // separately; fixing it needs a field added to the sidecar DTO, which is
        // a change to the store's contract rather than to this adapter.
        createdAt: resolvedAtIso,
      },
      supersededObservations: parsed.supersededObservations,
    };
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
      conflictKind: string | null;
    },
  ): Promise<void> {
    await this.sidecar.recordCalibrationConflict(
      profileId,
      operationId,
      conflict.entityType,
      conflict.entityId,
      conflict.reason,
      conflict.serverRevision,
      conflict.conflictKind ?? undefined,
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
    // The IPC contract's `kind` is sourced from `conflict_kind`, never
    // re-derived from `entityType` (issue #365). A conflict whose
    // `conflictKind` is null or not a member of the six-value enum is
    // refused here -- excluded from the returned list -- rather than
    // advertised under a guessed kind: the store already refuses to
    // *resolve* an unclassified conflict with
    // CALIBRATION_CONFLICT_KIND_UNCLASSIFIED, so listing it as classified
    // would offer a button the store rejects.
    const conflicts: CalibrationConflict[] = [];
    for (const item of raw) {
      const parsed = CalibrationConflictWire.parse(item);
      const kindResult = CalibrationConflictKindSchema.safeParse(
        parsed.conflictKind,
      );
      if (!kindResult.success) {
        continue;
      }
      const kind = kindResult.data;
      conflicts.push({
        conflictId: parsed.conflictId,
        profileId: parsed.profileId,
        projectId: parsed.projectId,
        entityId: parsed.entityId,
        kind,
        localPayloadSummary: summarizeConflictPayload(parsed.localPayload),
        serverPayloadSummary: summarizeConflictPayload(parsed.serverPayload),
        serverRevision: parsed.serverRevision,
        availableResolutions: conflictResolutionsFor(this, kind),
        createdAt: sidecarTimestampToIso(parsed.createdAt, 'createdAt'),
        resolution: null,
        resolvedAt: null,
      });
    }
    return conflicts;
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
