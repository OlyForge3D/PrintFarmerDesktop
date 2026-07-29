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
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import {
  CalibrationPrinterContext as CalibrationPrinterContextSchema,
  CalibrationPrinterEligibility,
  CalibrationWorkspacePayload,
  OrcaProfileEntry,
  deriveCalibrationWorkspaceProjection,
  type CalibrationPrinterContext,
  type CalibrationSaveWorkspaceStateRequest,
} from '@shared/ipc';
import type { SaveCalibrationWorkspaceStateInput } from './sidecar.js';

const MAX_CALIBRATION_WORKSPACE_BYTES = 512 * 1024;
export const MAX_CALIBRATION_PHOTO_BYTES = 20_000_000;

function calibrationPhotoType(bytes: Buffer): {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
} | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

export async function inspectCalibrationPhoto(approvedPath: string): Promise<{
  bytes: Buffer;
  contentHash: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  extension: 'jpg' | 'png' | 'webp';
}> {
  const linkInfo = await lstat(approvedPath);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    throw new Error('The approved photo must be a regular, non-symlink file.');
  }
  const file = await open(
    approvedPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer;
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > MAX_CALIBRATION_PHOTO_BYTES
    ) {
      throw new Error('The approved photo has an invalid size.');
    }
    bytes = await file.readFile();
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (before.ino !== 0 && after.ino !== before.ino)
    ) {
      throw new Error('The approved photo changed while it was being read.');
    }
  } finally {
    await file.close();
  }
  const detected = calibrationPhotoType(bytes);
  if (!detected) {
    throw new Error('Only JPEG, PNG, and WebP photo bytes are accepted.');
  }
  return {
    bytes,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    ...detected,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function prepareCalibrationWorkspaceSave(
  request: CalibrationSaveWorkspaceStateRequest,
  selectedProfileId: string | null,
  printerContextFresh: boolean,
): SaveCalibrationWorkspaceStateInput {
  if (selectedProfileId === null || request.profileId !== selectedProfileId) {
    throw Object.assign(
      new Error('Calibration request does not match the selected profile.'),
      { code: 'CALIBRATION_PROFILE_MISMATCH' },
    );
  }
  if (request.workspaceState.domainState.projectId !== request.projectId) {
    throw Object.assign(
      new Error('Workspace project identity does not match the request.'),
      { code: 'CALIBRATION_PROJECT_MISMATCH' },
    );
  }
  if (
    request.workspaceState.domainState.binding.printer.backendProfileId !==
    selectedProfileId
  ) {
    throw Object.assign(
      new Error('Workspace binding does not match the selected profile.'),
      { code: 'CALIBRATION_PROFILE_MISMATCH' },
    );
  }
  if (
    Buffer.byteLength(JSON.stringify(request.workspaceState), 'utf8') >
    MAX_CALIBRATION_WORKSPACE_BYTES
  ) {
    throw Object.assign(
      new Error('Calibration workspace exceeds the 512 KiB limit.'),
      { code: 'CALIBRATION_WORKSPACE_TOO_LARGE' },
    );
  }
  const projection = deriveCalibrationWorkspaceProjection(
    request.workspaceState.domainState,
  );
  return {
    profileId: selectedProfileId,
    projectId: request.projectId,
    displayName: request.displayName,
    description: request.description ?? null,
    printerId: request.printerId,
    status: projection.status,
    completedStepCount: projection.completedStepCount,
    totalStepCount: projection.totalStepCount,
    printerContextFresh,
    baseRevision: request.baseRevision ?? null,
    operationId: request.operationId,
    idempotencyKey: createHash('sha256')
      .update(canonicalJson(request))
      .digest('hex'),
    workspaceState: request.workspaceState,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

// --- Identifiers -----------------------------------------------------------

const ServerGuid = z.string().uuid();
const Cursor = z.string().max(4096);

const RemotePrinterEligibility = z
  .object({
    firmwareFamily: z
      .string()
      .min(1)
      .max(128)
      .nullish()
      .transform((value) => value ?? null),
    gcodeDialect: z
      .string()
      .min(1)
      .max(128)
      .nullish()
      .transform((value) => value ?? null),
    slicerFamily: z
      .string()
      .min(1)
      .max(128)
      .nullish()
      .transform((value) => value ?? null),
    slicerDistribution: z
      .string()
      .min(1)
      .max(256)
      .nullish()
      .transform((value) => value ?? null),
    slicerIdentity: z
      .string()
      .min(1)
      .max(128)
      .nullish()
      .transform((value) => value ?? null),
    hardwareContextComplete: z
      .boolean()
      .nullish()
      .transform((value) => value ?? null),
    safetyContextComplete: z
      .boolean()
      .nullish()
      .transform((value) => value ?? null),
    permissionsComplete: z
      .boolean()
      .nullish()
      .transform((value) => value ?? null),
    reasons: z
      .array(z.string().min(1).max(512))
      .max(32)
      .nullish()
      .transform((value) => value ?? null),
  })
  .passthrough();

export const RemoteCalibrationPrinterCandidate = z
  .object({
    printerId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    printerModel: z
      .string()
      .max(256)
      .nullish()
      .transform((value) => value ?? null),
    firmwareCompatible: z.boolean().optional().default(false),
    orcaProfileId: z
      .string()
      .max(512)
      .nullish()
      .transform((value) => value ?? null),
    isOnline: z.boolean().optional().default(false),
    updatedAt: z.string().datetime(),
    eligibility: RemotePrinterEligibility.nullish().transform(
      (value) => value ?? null,
    ),
  })
  .passthrough();
export type RemoteCalibrationPrinterCandidate = z.infer<
  typeof RemoteCalibrationPrinterCandidate
>;

export const RemoteCalibrationPrinters = z.union([
  z.array(RemoteCalibrationPrinterCandidate).max(200),
  z
    .object({
      printers: z.array(RemoteCalibrationPrinterCandidate).max(200),
    })
    .passthrough()
    .transform((value) => value.printers),
]);
export type RemoteCalibrationPrinters = z.infer<
  typeof RemoteCalibrationPrinters
>;

const RemoteToolhead = z
  .object({
    toolId: z.string().min(1).max(256),
    toolheadId: z.string().min(1).max(256),
    extruderType: z.enum(['directDrive', 'bowden']),
    nozzle: z
      .object({
        id: z.string().min(1).max(256),
        diameterMm: z.number().positive().max(10),
        material: z.string().min(1).max(256),
      })
      .passthrough(),
  })
  .passthrough();

const RemoteSafetyContext = z
  .object({
    buildVolumeMm: z
      .object({
        x: z.number().positive().max(10_000),
        y: z.number().positive().max(10_000),
        z: z.number().positive().max(10_000),
      })
      .passthrough(),
    maximumNozzleTemperatureC: z.number().positive().max(2_000),
    maximumBedTemperatureC: z.number().nonnegative().max(1_000),
    maximumVolumetricRateMm3S: z.number().positive().max(10_000),
    emergencyStopAvailable: z.boolean(),
    thermalProtectionConfirmed: z.boolean(),
    ventilationAssessed: z.boolean(),
  })
  .passthrough();

const RemoteCalibrationPermissions = z
  .object({
    readPrinter: z.boolean(),
    writeCalibration: z.boolean(),
    generateCalibration: z.boolean(),
    startPrint: z.boolean(),
  })
  .passthrough();

export const RemoteCalibrationPrinterContext = z
  .object({
    printerId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    printerModel: z
      .string()
      .max(256)
      .nullish()
      .transform((value) => value ?? null),
    firmware: z
      .object({
        firmware: z.literal('Klipper'),
        gcodeDialect: z.literal('Klipper'),
        firmwareVersion: z
          .string()
          .max(128)
          .nullish()
          .transform((value) => value ?? null),
        klipperConfigHash: z
          .string()
          .max(256)
          .nullish()
          .transform((value) => value ?? null),
      })
      .passthrough(),
    orcaProfileId: z
      .string()
      .max(512)
      .nullish()
      .transform((value) => value ?? null),
    orcaProfileDisplayName: z
      .string()
      .max(512)
      .nullish()
      .transform((value) => value ?? null),
    bedWidthMm: z
      .number()
      .positive()
      .max(10_000)
      .nullish()
      .transform((value) => value ?? null),
    bedDepthMm: z
      .number()
      .positive()
      .max(10_000)
      .nullish()
      .transform((value) => value ?? null),
    nozzleDiameterMm: z
      .number()
      .positive()
      .max(10)
      .nullish()
      .transform((value) => value ?? null),
    snapshotAt: z.string().datetime(),
    isCurrent: z.boolean().optional().default(false),
    configurationId: z
      .string()
      .min(1)
      .max(256)
      .nullish()
      .transform((value) => value ?? null),
    configurationRevision: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform((value) => value ?? null),
    snapshotId: z
      .string()
      .min(1)
      .max(256)
      .nullish()
      .transform((value) => value ?? null),
    snapshotRevision: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform((value) => value ?? null),
    slicerIdentity: z
      .string()
      .min(1)
      .max(128)
      .nullish()
      .transform((value) => value ?? null),
    slicerDistribution: z
      .string()
      .min(1)
      .max(256)
      .nullish()
      .transform((value) => value ?? null),
    profileRevision: z
      .string()
      .min(1)
      .max(256)
      .nullish()
      .transform((value) => value ?? null),
    contentHash: z
      .string()
      .max(256)
      .nullish()
      .transform((value) => value ?? null),
    toolheads: z.array(RemoteToolhead).max(32).optional().default([]),
    safety: RemoteSafetyContext.nullish().transform((value) => value ?? null),
    permissions: RemoteCalibrationPermissions.nullish().transform(
      (value) => value ?? null,
    ),
  })
  .passthrough();
export type RemoteCalibrationPrinterContext = z.infer<
  typeof RemoteCalibrationPrinterContext
>;

export function isExplicitCalibrationEligibilityComplete(
  candidate: RemoteCalibrationPrinterCandidate,
): boolean {
  return projectCalibrationEligibility(candidate) !== null;
}

export function projectCalibrationEligibility(
  candidate: RemoteCalibrationPrinterCandidate,
): z.infer<typeof CalibrationPrinterEligibility> | null {
  if (candidate.eligibility === null) return null;
  const result = CalibrationPrinterEligibility.safeParse({
    firmwareFamily: candidate.eligibility.firmwareFamily,
    gcodeDialect: candidate.eligibility.gcodeDialect,
    slicerFamily: candidate.eligibility.slicerFamily,
    slicerDistribution: candidate.eligibility.slicerDistribution,
    slicerIdentity: candidate.eligibility.slicerIdentity,
    hardwareContextComplete: candidate.eligibility.hardwareContextComplete,
    safetyContextComplete: candidate.eligibility.safetyContextComplete,
    permissionsComplete: candidate.eligibility.permissionsComplete,
    reasons: candidate.eligibility.reasons,
  });
  return result.success ? result.data : null;
}

export function isExplicitCalibrationContextComplete(
  context: RemoteCalibrationPrinterContext,
): boolean {
  return (
    context.configurationId !== null &&
    context.configurationRevision !== null &&
    context.snapshotId !== null &&
    context.snapshotRevision !== null &&
    context.slicerIdentity === 'OrcaSlicer' &&
    context.slicerDistribution === 'upstream' &&
    context.orcaProfileId !== null &&
    context.orcaProfileDisplayName !== null &&
    context.profileRevision !== null &&
    context.toolheads.length > 0 &&
    context.safety !== null &&
    context.safety.emergencyStopAvailable &&
    context.safety.thermalProtectionConfirmed &&
    context.safety.ventilationAssessed &&
    context.permissions !== null &&
    context.permissions.readPrinter &&
    context.permissions.writeCalibration &&
    context.permissions.generateCalibration &&
    context.permissions.startPrint
  );
}

export function projectPrintFarmerOrcaProfile(
  candidate: RemoteCalibrationPrinterCandidate,
  context: RemoteCalibrationPrinterContext,
): OrcaProfileEntry | null {
  if (
    !candidate.isOnline ||
    !isExplicitCalibrationEligibilityComplete(candidate) ||
    !context.isCurrent ||
    !isExplicitCalibrationContextComplete(context) ||
    candidate.printerId !== context.printerId ||
    candidate.orcaProfileId === null ||
    candidate.orcaProfileId !== context.orcaProfileId ||
    context.configurationRevision === null ||
    context.snapshotId === null ||
    context.nozzleDiameterMm === null ||
    context.profileRevision === null
  ) {
    return null;
  }
  const matchingToolheads = context.toolheads.filter(
    (toolhead) => toolhead.nozzle.diameterMm === context.nozzleDiameterMm,
  );
  if (matchingToolheads.length !== 1) {
    return null;
  }
  const toolhead = matchingToolheads[0]!;
  return OrcaProfileEntry.parse({
    orcaProfileId: context.orcaProfileId,
    displayName: context.orcaProfileDisplayName,
    vendor: null,
    material: null,
    source: 'printFarmer',
    upstreamVerified: true,
    printerId: context.printerId,
    configurationRevision: context.configurationRevision,
    snapshotId: context.snapshotId,
    toolId: toolhead.toolId,
    toolheadId: toolhead.toolheadId,
    nozzleId: toolhead.nozzle.id,
    nozzleDiameterMm: toolhead.nozzle.diameterMm,
    profileRevision: context.profileRevision,
    contentHash:
      context.contentHash !== null && /^[a-f0-9]{64}$/.test(context.contentHash)
        ? context.contentHash
        : null,
    exportable: false,
  });
}

export function projectCalibrationPrinterContext(
  context: RemoteCalibrationPrinterContext,
): CalibrationPrinterContext {
  const complete = isExplicitCalibrationContextComplete(context);
  return CalibrationPrinterContextSchema.parse({
    printerId: context.printerId,
    displayName: context.displayName,
    printerModel: context.printerModel,
    firmware: {
      firmware: context.firmware.firmware,
      gcodeDialect: context.firmware.gcodeDialect,
      firmwareVersion: context.firmware.firmwareVersion,
      klipperConfigHash: context.firmware.klipperConfigHash,
    },
    orcaProfileId: context.orcaProfileId,
    orcaProfileDisplayName: context.orcaProfileDisplayName,
    bedWidthMm: context.bedWidthMm,
    bedDepthMm: context.bedDepthMm,
    nozzleDiameterMm: context.nozzleDiameterMm,
    snapshotAt: context.snapshotAt,
    isCurrent: context.isCurrent && complete,
    configurationId: context.configurationId,
    configurationRevision: context.configurationRevision,
    snapshotId: context.snapshotId,
    snapshotRevision: context.snapshotRevision,
    slicerIdentity:
      context.slicerIdentity === 'OrcaSlicer' ? 'OrcaSlicer' : null,
    slicerDistribution:
      context.slicerDistribution === 'upstream' ? 'upstream' : null,
    profileRevision: context.profileRevision,
    contentHash:
      context.contentHash !== null && /^[a-f0-9]{64}$/.test(context.contentHash)
        ? context.contentHash
        : null,
    toolheads: context.toolheads.map((toolhead) => ({
      toolId: toolhead.toolId,
      toolheadId: toolhead.toolheadId,
      extruderType: toolhead.extruderType,
      nozzle: {
        id: toolhead.nozzle.id,
        diameterMm: toolhead.nozzle.diameterMm,
        material: toolhead.nozzle.material,
      },
    })),
    safety:
      context.safety === null
        ? null
        : {
            buildVolumeMm: {
              x: context.safety.buildVolumeMm.x,
              y: context.safety.buildVolumeMm.y,
              z: context.safety.buildVolumeMm.z,
            },
            maximumNozzleTemperatureC: context.safety.maximumNozzleTemperatureC,
            maximumBedTemperatureC: context.safety.maximumBedTemperatureC,
            maximumVolumetricRateMm3S: context.safety.maximumVolumetricRateMm3S,
            emergencyStopAvailable: context.safety.emergencyStopAvailable,
            thermalProtectionConfirmed:
              context.safety.thermalProtectionConfirmed,
            ventilationAssessed: context.safety.ventilationAssessed,
          },
    permissions:
      context.permissions === null
        ? null
        : {
            readPrinter: context.permissions.readPrinter,
            writeCalibration: context.permissions.writeCalibration,
            generateCalibration: context.permissions.generateCalibration,
            startPrint: context.permissions.startPrint,
          },
  });
}

export function doesCalibrationWorkspaceMatchContext(
  request: CalibrationSaveWorkspaceStateRequest,
  context: RemoteCalibrationPrinterContext,
): boolean {
  if (!context.isCurrent || !isExplicitCalibrationContextComplete(context)) {
    return false;
  }
  const binding = request.workspaceState.domainState.binding;
  const printer = binding.printer;
  const snapshot = binding.snapshot;
  const selectedProfile = request.workspaceState.selectedBaseProfile;
  const selectedToolhead = snapshot.toolheads.find(
    (toolhead) =>
      toolhead.toolId === binding.selectedToolId &&
      toolhead.toolheadId === binding.selectedToolheadId &&
      toolhead.nozzle.nozzleId === binding.selectedNozzleId,
  );
  const remoteToolhead = context.toolheads.find(
    (toolhead) =>
      toolhead.toolId === binding.selectedToolId &&
      toolhead.toolheadId === binding.selectedToolheadId &&
      toolhead.nozzle.id === binding.selectedNozzleId,
  );
  const remoteSafety = context.safety;
  if (remoteSafety === null) return false;
  return (
    context.printerId === printer.backendPrinterId &&
    context.configurationId === printer.printerConfigurationId &&
    context.configurationRevision === printer.printerConfigurationRevision &&
    context.snapshotId === snapshot.snapshotId &&
    context.snapshotRevision === snapshot.snapshotRevision &&
    context.snapshotAt === snapshot.capturedAt &&
    context.configurationRevision === snapshot.configurationRevision &&
    remoteSafety.buildVolumeMm.x === snapshot.safety.buildVolumeMm.x &&
    remoteSafety.buildVolumeMm.y === snapshot.safety.buildVolumeMm.y &&
    remoteSafety.buildVolumeMm.z === snapshot.safety.buildVolumeMm.z &&
    remoteSafety.maximumNozzleTemperatureC ===
      snapshot.safety.maximumNozzleTemperatureC &&
    remoteSafety.maximumBedTemperatureC ===
      snapshot.safety.maximumBedTemperatureC &&
    remoteSafety.maximumVolumetricRateMm3S ===
      snapshot.safety.maximumVolumetricRateMm3S &&
    remoteSafety.emergencyStopAvailable ===
      snapshot.safety.emergencyStopAvailable &&
    remoteSafety.thermalProtectionConfirmed ===
      snapshot.safety.thermalProtectionConfirmed &&
    remoteSafety.ventilationAssessed === snapshot.safety.ventilationAssessed &&
    selectedToolhead !== undefined &&
    remoteToolhead !== undefined &&
    selectedToolhead.extruderType === remoteToolhead.extruderType &&
    selectedToolhead.nozzle.diameterMm === remoteToolhead.nozzle.diameterMm &&
    selectedToolhead.nozzle.material === remoteToolhead.nozzle.material &&
    context.nozzleDiameterMm === remoteToolhead.nozzle.diameterMm &&
    selectedProfile.orcaProfileId === context.orcaProfileId &&
    selectedProfile.displayName === context.orcaProfileDisplayName &&
    selectedProfile.printerId === context.printerId &&
    selectedProfile.configurationRevision === context.configurationRevision &&
    selectedProfile.snapshotId === context.snapshotId &&
    selectedProfile.toolId === remoteToolhead.toolId &&
    selectedProfile.toolheadId === remoteToolhead.toolheadId &&
    selectedProfile.nozzleId === remoteToolhead.nozzle.id &&
    selectedProfile.nozzleDiameterMm === remoteToolhead.nozzle.diameterMm &&
    selectedProfile.profileRevision === context.profileRevision &&
    selectedProfile.contentHash ===
      (context.contentHash !== null &&
      /^[a-f0-9]{64}$/.test(context.contentHash)
        ? context.contentHash
        : null)
  );
}

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
    firmware: z.literal('Klipper'),
    gcodeDialect: z.literal('Klipper'),
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
    status: z.enum([
      'draft',
      'inProgress',
      'awaitingGeneration',
      'generated',
      'complete',
      'archived',
    ]),
    printerId: z.string().min(1).max(256),
    printerSnapshot: RemotePrinterSnapshot.nullish().transform(
      (v) => v ?? null,
    ),
    revision: z.number().int().nonnegative(),
    concurrencyToken: z.string().min(1).max(256),
    /** Exact domain workspace when the server has one; invalid legacy shapes are not hydrated. */
    workspaceState: CalibrationWorkspacePayload.nullish()
      .catch(null)
      .transform((value) => value ?? null),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough()
  .transform((project) => {
    const workspace = project.workspaceState;
    return workspace !== null &&
      (Buffer.byteLength(JSON.stringify(workspace), 'utf8') >
        MAX_CALIBRATION_WORKSPACE_BYTES ||
        workspace.domainState.projectId !== project.id ||
        workspace.domainState.binding.printer.backendPrinterId !==
          project.printerId)
      ? { ...project, workspaceState: null }
      : project;
  });
export type RemoteCalibrationProject = z.infer<typeof RemoteCalibrationProject>;

/** Remote calibration step from `GET /api/calibration-projects/{id}/steps`. */
export const RemoteCalibrationStep = z
  .object({
    id: ServerGuid,
    projectId: ServerGuid,
    ordinal: z.number().int().nonnegative().max(99),
    kind: z.enum([
      'temperatureTower',
      'retraction',
      'flowRate',
      'pressureAdvance',
      'firstLayerHeight',
      'firstLayerWidth',
      'overhangAngle',
      'toleranceTest',
      'speedTest',
    ]),
    status: z.enum([
      'pending',
      'inProgress',
      'observationRequired',
      'complete',
      'skipped',
    ]),
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

// --- Generation orchestration (issue #54) ----------------------------------

/**
 * One structured, redacted reason a generation request was refused.
 * Mirrors `CalibrationGenerationProblemDto` from the PrintFarmer API.
 * Storage paths, credentials, and raw logs are excluded by the server.
 */
export const RemoteCalibrationGenerationProblem = z
  .object({
    code: z.string().min(1).max(64),
    field: z.string().max(128),
    message: z.string().max(512),
  })
  .passthrough();
export type RemoteCalibrationGenerationProblem = z.infer<
  typeof RemoteCalibrationGenerationProblem
>;

/**
 * Durable, redacted status of one calibration generation orchestration.
 * Mirrors `CalibrationOrchestrationStatusDto` from the PrintFarmer API at
 * `GET /api/calibration-orchestrations/{id}` and `POST …/generate-job` (202/200).
 *
 * Carries identifiers, digests, counters, and timestamps only.  Storage
 * paths, worker endpoints, API keys, private URLs, and raw slicer logs are
 * excluded by the server before this reaches PFD.
 */
export const RemoteCalibrationOrchestrationStatus = z
  .object({
    id: ServerGuid,
    projectId: ServerGuid,
    attemptId: ServerGuid,
    operationId: z.string().min(1).max(256),
    status: z.string().min(1).max(64),
    currentStep: z.string().min(1).max(128),
    revision: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    nextRetryAtUtc: z
      .string()
      .datetime()
      .nullish()
      .transform((v) => v ?? null),
    stepStartedAtUtc: z
      .string()
      .datetime()
      .nullish()
      .transform((v) => v ?? null),
    lastErrorCode: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? null),
    problems: z
      .array(RemoteCalibrationGenerationProblem)
      .max(50)
      .optional()
      .default([]),
    model3DId: ServerGuid.nullish().transform((v) => v ?? null),
    sliceJobId: ServerGuid.nullish().transform((v) => v ?? null),
    workerId: ServerGuid.nullish().transform((v) => v ?? null),
    sourceArtifactId: ServerGuid.nullish().transform((v) => v ?? null),
    finalArtifactId: ServerGuid.nullish().transform((v) => v ?? null),
    gcodeFileId: ServerGuid.nullish().transform((v) => v ?? null),
    specificationSha256: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    planManifestSha256: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    gcodeSha256: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    manifestSha256: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    generatorVersion: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    slicerContainerDigest: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    slicerBinarySha256: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    statusRoute: z.string().min(1).max(2048),
    createdAtUtc: z.string().datetime(),
    updatedAtUtc: z.string().datetime(),
    completedAtUtc: z
      .string()
      .datetime()
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteCalibrationOrchestrationStatus = z.infer<
  typeof RemoteCalibrationOrchestrationStatus
>;

// --- Job queue (issue #54) ------------------------------------------------

/**
 * Queue-focused view of a print job from `GET /api/job-queue/{id}`.
 * Mirrors `JobQueuePrintJobDto` from the PrintFarmer API (PR #979).
 *
 * Key fields for bed-clear acknowledgement:
 * - `rowVersion`: echoed as `If-Match` header
 * - `dispatchStateRowVersion`: echoed as `X-Dispatch-State-If-Match` header
 * - `pinnedPrinterConfigRevision`: echoed as `expectedPrinterConfigRevision` in body
 * - `assignedPrinterId`: the printer the job is assigned to
 * - `calibrationProjectId`: the calibration project that owns this job
 *
 * Storage paths and credentials never appear in this DTO.
 */
export const RemoteJobQueueJob = z
  .object({
    id: ServerGuid,
    rowVersion: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    revision: z.number().int().nonnegative(),
    dispatchStateRowVersion: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    dispatchStateRevision: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform((v) => v ?? null),
    calibrationProjectId: ServerGuid.nullish().transform((v) => v ?? null),
    pinnedPrinterConfigRevision: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform((v) => v ?? null),
    assignedPrinterId: ServerGuid.nullish().transform((v) => v ?? null),
    assignedPrinterName: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? ''),
    gcodeFileName: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? ''),
    gcodeFileId: ServerGuid.nullish().transform((v) => v ?? null),
    status: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? null),
    priority: z.number().int().nonnegative().optional().default(0),
    queuePosition: z.number().int().nonnegative().optional().default(0),
    requiredNozzleDiameter: z
      .number()
      .positive()
      .max(10)
      .nullish()
      .transform((v) => v ?? null),
    requiredMaterialType: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    bedClearState: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? null),
    bedClearCommandId: ServerGuid.nullish().transform((v) => v ?? null),
    bedClearExpiresAtUtc: z
      .string()
      .datetime()
      .nullish()
      .transform((v) => v ?? null),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
export type RemoteJobQueueJob = z.infer<typeof RemoteJobQueueJob>;
