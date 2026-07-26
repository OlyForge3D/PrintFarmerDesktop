/**
 * Calibration-specific remote DTO schemas.
 *
 * Remote responses are parsed additively (`.passthrough()`) while required
 * safety and identity fields remain strict. The main process validates every
 * response; the renderer never sees raw remote JSON or credentials.
 *
 * These types describe what PrintFarmer server sends over the calibration
 * REST and change-feed APIs. They are deliberately separate from the shared
 * IPC contract so the wire format can evolve additively without breaking the
 * typed renderer surface.
 */

import { z } from 'zod';

// --- Identifiers -----------------------------------------------------------

const ServerGuid = z.string().uuid();
const Cursor = z.string().max(4096);

// --- Capability negotiation wire types ------------------------------------

/**
 * Remote capability-negotiation response from
 * `GET /api/calibration/capabilities`.
 * Required fields are strict; optional future fields use passthrough.
 */
export const RemoteCalibrationCapabilities = z
  .object({
    /** Minimum required negotiated API version. */
    apiVersion: z.string().min(1).max(64),
    /** Minimum required schema version for the change feed. */
    schemaVersion: z.number().int().nonnegative(),
    /** Required JWT scopes (must all be present). */
    requiredScopes: z.array(z.string().min(1).max(64)).max(32),
    /** Firmware dialect requirement. Must be 'Klipper'. */
    requiredFirmware: z.string().min(1).max(64),
    /** G-code dialect requirement. Must be 'Klipper'. */
    requiredGcodeDialect: z.string().min(1).max(64),
    /** Required upstream slicer identity. Must be 'OrcaSlicer'. */
    requiredSlicer: z.string().min(1).max(64),
    /** Capability flags — all must be true. */
    flags: z
      .object({
        calibrationApiEnabled: z.boolean(),
        calibrationChangeFeedEnabled: z.boolean(),
        calibrationOfflineDraftEnabled: z.boolean(),
        calibrationPhotoUploadEnabled: z.boolean(),
        calibrationGenerationEnabled: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();
export type RemoteCalibrationCapabilities = z.infer<
  typeof RemoteCalibrationCapabilities
>;

// --- Change feed -----------------------------------------------------------

export const CalibrationEntityType = z.enum([
  'CalibrationProject',
  'CalibrationStep',
  'CalibrationAttempt',
  'CalibrationEvent',
  'CalibrationObservation',
  'CalibrationPhoto',
  'CalibrationProfileRevision',
  'CalibrationPrinterSnapshot',
]);
export type CalibrationEntityType = z.infer<typeof CalibrationEntityType>;

export const CalibrationSyncOperation = z.enum([
  'Created',
  'Updated',
  'Deleted',
]);
export type CalibrationSyncOperation = z.infer<typeof CalibrationSyncOperation>;

/**
 * One change-feed entry from `GET /api/calibration-sync/changes`.
 * Parsed additively — future fields do not break the client.
 */
export const RemoteCalibrationChange = z
  .object({
    revision: z.number().int().nonnegative(),
    entityType: CalibrationEntityType,
    entityId: ServerGuid,
    operation: CalibrationSyncOperation,
    projectId: ServerGuid.nullish().transform((v) => v ?? null),
    actorUserId: ServerGuid,
    timestamp: z.string().datetime(),
  })
  .passthrough();
export type RemoteCalibrationChange = z.infer<typeof RemoteCalibrationChange>;

/**
 * Change-feed page response from `GET /api/calibration-sync/changes`.
 */
export const RemoteCalibrationChangesPage = z
  .object({
    changes: z.array(RemoteCalibrationChange).max(500),
    nextCursor: Cursor.nullish().transform((v) => v ?? null),
    hasMore: z.boolean(),
    serverRevision: z.number().int().nonnegative(),
  })
  .passthrough();
export type RemoteCalibrationChangesPage = z.infer<
  typeof RemoteCalibrationChangesPage
>;

// --- Remote aggregate snapshots -------------------------------------------

/**
 * Remote printer snapshot attached to a calibration project.
 * Parsed additively — extra vendor fields are preserved without leaking
 * to the renderer.
 */
export const RemotePrinterSnapshot = z
  .object({
    printerId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    printerModel: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    firmware: z.string().min(1).max(64),
    gcodeDialect: z.string().min(1).max(64),
    firmwareVersion: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    klipperConfigHash: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    orcaProfileId: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
    orcaProfileDisplayName: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
    bedWidthMm: z
      .number()
      .positive()
      .max(10_000)
      .nullish()
      .transform((v) => v ?? null),
    bedDepthMm: z
      .number()
      .positive()
      .max(10_000)
      .nullish()
      .transform((v) => v ?? null),
    nozzleDiameterMm: z
      .number()
      .positive()
      .max(10)
      .nullish()
      .transform((v) => v ?? null),
    snapshotAt: z.string().datetime(),
  })
  .passthrough();
export type RemotePrinterSnapshot = z.infer<typeof RemotePrinterSnapshot>;

/** Remote calibration project aggregate from `GET /api/calibration-projects/{id}`. */
export const RemoteCalibrationProject = z
  .object({
    id: ServerGuid,
    displayName: z.string().min(1).max(256),
    description: z
      .string()
      .max(4096)
      .nullish()
      .transform((v) => v ?? null),
    status: z.string().min(1).max(64),
    printerId: z.string().min(1).max(256),
    printerSnapshot: RemotePrinterSnapshot.nullish().transform(
      (v) => v ?? null,
    ),
    revision: z.number().int().nonnegative(),
    concurrencyToken: z.string().min(1).max(256),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
export type RemoteCalibrationProject = z.infer<typeof RemoteCalibrationProject>;

/** Remote calibration step from `GET /api/calibration-projects/{id}/steps`. */
export const RemoteCalibrationStep = z
  .object({
    id: ServerGuid,
    projectId: ServerGuid,
    ordinal: z.number().int().nonnegative().max(99),
    kind: z.string().min(1).max(64),
    status: z.string().min(1).max(64),
    displayName: z.string().min(1).max(128),
    prerequisites: z
      .string()
      .max(2048)
      .nullish()
      .transform((v) => v ?? null),
    methodNotes: z
      .string()
      .max(4096)
      .nullish()
      .transform((v) => v ?? null),
    expectedResult: z
      .string()
      .max(2048)
      .nullish()
      .transform((v) => v ?? null),
    measuredResult: z
      .string()
      .max(4096)
      .nullish()
      .transform((v) => v ?? null),
    reorderingSupported: z.boolean().optional().default(false),
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
export type RemoteCalibrationStep = z.infer<typeof RemoteCalibrationStep>;

/** Remote calibration attempt from `GET /api/calibration-attempts/{id}`. */
export const RemoteCalibrationAttempt = z
  .object({
    id: ServerGuid,
    stepId: ServerGuid,
    projectId: ServerGuid,
    attemptNumber: z.number().int().positive().max(999),
    measuredValue: z
      .number()
      .finite()
      .nullish()
      .transform((v) => v ?? null),
    measuredUnit: z
      .string()
      .max(32)
      .nullish()
      .transform((v) => v ?? null),
    isSelected: z.boolean().optional().default(false),
    printerContextSnapshotHash: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .passthrough();
export type RemoteCalibrationAttempt = z.infer<typeof RemoteCalibrationAttempt>;

/** Remote calibration event from `GET /api/calibration-events/{id}`. */
export const RemoteCalibrationEvent = z
  .object({
    id: ServerGuid,
    attemptId: ServerGuid,
    stepId: ServerGuid,
    projectId: ServerGuid,
    kind: z.string().min(1).max(64),
    payload: z.record(z.unknown()).optional().default({}),
    occurredAt: z.string().datetime(),
  })
  .passthrough();
export type RemoteCalibrationEvent = z.infer<typeof RemoteCalibrationEvent>;

/** Remote calibration observation from `GET /api/calibration-observations/{id}`. */
export const RemoteCalibrationObservation = z
  .object({
    id: ServerGuid,
    attemptId: ServerGuid,
    stepId: ServerGuid,
    projectId: ServerGuid,
    parameterKey: z.string().min(1).max(64),
    numericValue: z
      .number()
      .finite()
      .nullish()
      .transform((v) => v ?? null),
    unit: z
      .string()
      .max(32)
      .nullish()
      .transform((v) => v ?? null),
    note: z
      .string()
      .max(2048)
      .nullish()
      .transform((v) => v ?? null),
    observedAt: z.string().datetime(),
  })
  .passthrough();
export type RemoteCalibrationObservation = z.infer<
  typeof RemoteCalibrationObservation
>;

/** Remote calibration photo metadata. The renderer never receives photo URLs directly. */
export const RemoteCalibrationPhoto = z
  .object({
    id: ServerGuid,
    attemptId: ServerGuid,
    stepId: ServerGuid,
    projectId: ServerGuid,
    contentHash: z.string().max(256),
    mimeType: z.string().max(64),
    byteSize: z.number().int().positive().max(20_000_000),
    uploadedAt: z.string().datetime(),
  })
  .passthrough();
export type RemoteCalibrationPhoto = z.infer<typeof RemoteCalibrationPhoto>;

/** Remote generated profile revision. */
export const RemoteCalibrationProfileRevision = z
  .object({
    id: ServerGuid,
    projectId: ServerGuid,
    revisionLabel: z.string().min(1).max(256),
    isPromoted: z.boolean().optional().default(false),
    targetOrcaProfileId: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
    profileJsonHash: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    generatedAt: z.string().datetime(),
    promotedAt: z
      .string()
      .datetime()
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteCalibrationProfileRevision = z.infer<
  typeof RemoteCalibrationProfileRevision
>;

// --- Push/apply wire types -------------------------------------------------

/**
 * Typed ProblemDetails error from a calibration API response.
 * The main process maps HTTP status codes to these typed structures.
 */
export const RemoteCalibrationProblemDetails = z
  .object({
    type: z.string().max(2048).optional(),
    title: z.string().max(512).optional(),
    status: z.number().int().optional(),
    detail: z.string().max(4096).optional(),
    instance: z.string().max(2048).optional(),
    /** Extension field: operation-level error code. */
    errorCode: z.string().max(64).optional(),
  })
  .passthrough();
export type RemoteCalibrationProblemDetails = z.infer<
  typeof RemoteCalibrationProblemDetails
>;

/**
 * Response from `POST /api/calibration-sync/apply`.
 * Applied successfully — returns the new server revision.
 */
export const RemoteCalibrationApplySuccess = z
  .object({
    serverRevision: z.number().int().nonnegative(),
    appliedOperationIds: z
      .array(z.string().uuid())
      .max(500)
      .optional()
      .default([]),
    concurrencyToken: z.string().min(1).max(256).optional(),
  })
  .passthrough();
export type RemoteCalibrationApplySuccess = z.infer<
  typeof RemoteCalibrationApplySuccess
>;

/**
 * Conflict response from `POST /api/calibration-sync/apply` (HTTP 409).
 * The server describes the conflicted entity and its current state.
 */
export const RemoteCalibrationApplyConflict = z
  .object({
    conflictedOperationId: z.string().uuid(),
    entityType: CalibrationEntityType,
    entityId: ServerGuid,
    serverRevision: z.number().int().nonnegative(),
    serverConcurrencyToken: z.string().min(1).max(256).optional(),
    reason: z.string().max(512),
  })
  .passthrough();
export type RemoteCalibrationApplyConflict = z.infer<
  typeof RemoteCalibrationApplyConflict
>;

/**
 * The wire format for a single calibration outbox operation sent in a
 * `POST /api/calibration-sync/apply` batch request body.
 */
export const RemoteCalibrationApplyOperation = z
  .object({
    operationId: z.string().uuid(),
    /** Canonical request hash for idempotency key. */
    idempotencyKey: z.string().min(1).max(256),
    entityType: CalibrationEntityType,
    entityId: ServerGuid,
    operationKind: z.enum(['Create', 'Update', 'Delete']),
    /** The base revision this operation targets (for If-Match semantics). */
    baseRevision: z.number().int().nonnegative().nullable(),
    payload: z.record(z.unknown()),
  })
  .strict();
export type RemoteCalibrationApplyOperation = z.infer<
  typeof RemoteCalibrationApplyOperation
>;

export const RemoteCalibrationApplyRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    operations: z.array(RemoteCalibrationApplyOperation).min(1).max(100),
  })
  .strict();
export type RemoteCalibrationApplyRequest = z.infer<
  typeof RemoteCalibrationApplyRequest
>;

export type RemoteCalibrationApplyResult =
  | { kind: 'success'; value: RemoteCalibrationApplySuccess }
  | { kind: 'conflict'; value: RemoteCalibrationApplyConflict };
