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
  CALIBRATION_MAX_SERVER_REJECTION_REASONS,
  CALIBRATION_MAX_PRINTER_CANDIDATES,
  OrcaProfileEntry,
  UNRECOGNIZED_CALIBRATION_INPUT,
  UNRECOGNIZED_CALIBRATION_REASON_CODE,
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

/**
 * Normalises a .NET `DateTime`/`DateTimeOffset` JSON string to a strict
 * ISO-8601 UTC instant.
 *
 * `System.Text.Json` renders a `DateTime` whose `Kind` is `Unspecified` or
 * `Local` without a `Z` suffix (`"2026-08-11T07:32:40.656"`), which
 * `z.string().datetime()` rejects outright. Those values are contract-legal
 * server output, so rejecting them would drop otherwise valid printers for a
 * formatting difference. Anything that is not a real instant is still refused.
 */
const ServerInstant = z
  .string()
  .min(1)
  .max(64)
  .transform((value, ctx) => {
    // Treat an offset-less timestamp as UTC: PrintFarmer persists calibration
    // timestamps in UTC (`ObservedAtUtc`, `CapturedAtUtc`, ...), so the missing
    // suffix is a serializer artefact rather than an unknown zone.
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    const candidate = hasZone ? value : `${value}Z`;
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Not an ISO-8601 instant.',
      });
      return z.NEVER;
    }
    return new Date(parsed).toISOString();
  });

/**
 * The longest single string this client carries off the wire.
 *
 * Generous on purpose: it is a classification threshold, not a gate. The
 * transport already caps the whole body, so this only decides what is worth
 * carrying forward, and exceeding it degrades one field rather than rejecting
 * the response.
 */
const CALIBRATION_MAX_WIRE_STRING = 512;

/**
 * A list that degrades by length instead of refusing by length.
 *
 * `z.array(...).max(n)` rejects, and rejection here is not local: the whole
 * `/calibration-candidates` body is one parsed value, so one printer with one
 * item too many erased every healthy printer in the farm. Exceeding the cap is
 * not even a sign of a bad server — the evaluator asks about a dozen questions
 * of every toolhead, so a freshly added five-toolhead machine reports far more
 * than sixty-four missing inputs perfectly legitimately.
 *
 * The elements are pre-sliced as `unknown` before the real element schema
 * runs, so a runaway list costs a slice rather than tens of thousands of
 * validations, and the ceiling is high enough above the per-printer cap that
 * "was this cut?" is still answerable afterwards.
 */
const WIRE_LIST_CEILING = 1024;

function boundedWireList<T extends z.ZodTypeAny>(element: T) {
  return z
    .array(z.unknown())
    .nullish()
    .transform((items) => (items ?? []).slice(0, WIRE_LIST_CEILING))
    .pipe(z.array(element));
}

/**
 * One structured rejection reason from `CalibrationRejectionReasonDto`.
 * Retained verbatim so an ineligible printer can explain itself instead of
 * vanishing from the list.
 *
 * Every member degrades instead of throwing. A length bound that *rejects* is
 * a length bound that discards: `schema.parse` runs over the whole
 * `/calibration-candidates` array as one value, so a single reason whose code
 * or message ran long took every printer in the farm with it — the empty
 * discovery this contract exists to prevent, reachable by a server sending one
 * over-long string. The bounds are kept as classification thresholds (nothing
 * unbounded is carried forward, and the transport already caps the body), but
 * exceeding one now yields a value the catalogue does not recognise, which
 * {@link normalizeCalibrationReasonCode} maps to the unrecognized sentinel
 * exactly as it maps any other unknown code.
 */
export const RemoteCalibrationRejectionReason = z
  .object({
    code: z
      .string()
      .min(1)
      .max(CALIBRATION_MAX_WIRE_STRING)
      .catch(UNRECOGNIZED_CALIBRATION_REASON_CODE),
    field: z
      .string()
      .max(CALIBRATION_MAX_WIRE_STRING)
      .nullish()
      .transform((v) => v ?? '')
      .catch(''),
    message: z
      .string()
      .max(CALIBRATION_MAX_WIRE_STRING)
      .nullish()
      .transform((v) => v ?? '')
      .catch(''),
  })
  .passthrough();

/** `CalibrationFirmwareIdentityDto` — the authoritative firmware identity. */
const RemoteFirmwareIdentity = z
  .object({
    family: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    gcodeDialect: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    detectionSource: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    version: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    verified: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
  })
  .passthrough();

/** `CalibrationSlicerIdentityDto` — the authoritative slicer identity. */
const RemoteSlicerIdentity = z
  .object({
    engine: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    distribution: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    version: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    profileFormat: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();

/**
 * Wire shape of `CalibrationCandidateDto` exactly as
 * `GET /api/printers/calibration-candidates` serialises it.
 *
 * This replaces an earlier hand-invented shape (`printerId`, `displayName`,
 * `updatedAt`, a nested `eligibility` object) that no PrintFarmer build has
 * ever emitted. Because those fields were *required*, every real candidate
 * failed validation, so fixing the route alone would still have produced an
 * empty printer list.
 *
 * Only `id` and `name` are strictly required: the server always populates them
 * and a candidate without an identity cannot be selected. Every remaining
 * member is defaulted the way the server's own DTO defaults it, so an older or
 * newer deployment omitting an optional member degrades that member rather
 * than discarding the printer.
 */
const RemoteCalibrationCandidateDto = z
  .object({
    id: ServerGuid,
    name: z.string().min(1).max(256),
    enabled: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    inMaintenance: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    configurationRevision: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform((v) => v ?? null),
    reachability: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? 'unknown'),
    operationalState: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? 'unknown'),
    observedAtUtc: ServerInstant.nullish().transform((v) => v ?? null),
    lastSeenAtUtc: ServerInstant.nullish().transform((v) => v ?? null),
    isStale: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    firmware: RemoteFirmwareIdentity.nullish().transform((v) => v ?? null),
    slicer: RemoteSlicerIdentity.nullish().transform((v) => v ?? null),
    eligible: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    missingInputs: boundedWireList(
      z
        .string()
        .max(CALIBRATION_MAX_WIRE_STRING)
        .catch(UNRECOGNIZED_CALIBRATION_INPUT),
    ),
    rejectionReasons: boundedWireList(RemoteCalibrationRejectionReason),
  })
  .passthrough();

/**
 * Projects the server's explicit identity fields onto the strict eligibility
 * shape the renderer consumes.
 *
 * Eligibility is PrintFarmer-authoritative and explicit: it is granted only
 * when the server itself says `eligible`, reports no rejection reasons and no
 * missing inputs, and *names* Klipper firmware, the Klipper G-code dialect and
 * an upstream OrcaSlicer engine. Nothing is inferred from printer model,
 * manufacturer or backend type, and no local printer database participates.
 */
function deriveCandidateEligibility(
  dto: z.infer<typeof RemoteCalibrationCandidateDto>,
): {
  firmwareFamily: string | null;
  gcodeDialect: string | null;
  slicerFamily: string | null;
  slicerDistribution: string | null;
  slicerIdentity: string | null;
  hardwareContextComplete: boolean;
  safetyContextComplete: boolean;
  permissionsComplete: boolean;
  reasons: string[];
} | null {
  const firmwareFamily = dto.firmware?.family ?? null;
  const gcodeDialect = dto.firmware?.gcodeDialect ?? null;
  const slicerEngine = dto.slicer?.engine ?? null;
  const slicerDistribution = dto.slicer?.distribution ?? null;

  const explicitlyCompatible =
    dto.eligible &&
    dto.rejectionReasons.length === 0 &&
    dto.missingInputs.length === 0 &&
    firmwareFamily === 'Klipper' &&
    gcodeDialect === 'Klipper' &&
    slicerEngine === CALIBRATION_SLICER_ENGINE &&
    slicerDistribution === CALIBRATION_SLICER_DISTRIBUTION;

  if (!explicitlyCompatible) return null;

  return {
    firmwareFamily,
    gcodeDialect,
    slicerFamily: slicerEngine,
    slicerDistribution,
    slicerIdentity: slicerEngine,
    // The server's `eligible` verdict is the aggregate of its hardware,
    // safety and permission input checks; `missingInputs` is empty precisely
    // when all of them were satisfied.
    hardwareContextComplete: true,
    safetyContextComplete: true,
    permissionsComplete: true,
    reasons: [],
  };
}

/**
 * How, if at all, the server's own eligibility verdict fails to hold together.
 *
 * There are two server invariants here, not one, and conflating them is what
 * let a real violation escape:
 *
 * - `Eligible = reasons.Count == 0`. Defined purely on `rejectionReasons`.
 * - `RejectMissing` records a reason beside every missing input, so a missing
 *   input without a reason cannot occur either.
 *
 * The predicate used to test a single merged notion of "was anything said
 * against it", folding `missingInputs` in with `rejectionReasons`. That reads
 * naturally and is wrong: `{ eligible: false, rejectionReasons: [],
 * missingInputs: ['firmware.family'] }` violates the first invariant outright,
 * yet counted as *explained* and so matched neither branch. It fell through to
 * the unverified-eligibility fallback — a code whose meaning is the opposite,
 * that the server granted eligibility it had not evidenced — so a genuine
 * invariant violation was reported as the weaker, wrong diagnosis. Testing the
 * invariants separately is what makes each verdict mean what it says.
 *
 * - `contradiction` — the server said this printer is ready and, in the same
 *   breath, said why it is not: either a rejection reason beside `eligible`,
 *   or a missing input with no reason to go with it.
 * - `unexplainedRefusal` — the server refused without a single rejection
 *   reason. It may still name missing inputs; that is a second violation of
 *   the same pair, not evidence that the refusal was explained.
 *
 * The client fails all of them closed. Naming which occurred is what lets an
 * operator report a server defect instead of doubting the printer.
 */
export type CalibrationServerIncoherence =
  'contradiction' | 'unexplainedRefusal';

function detectServerEligibilityIncoherence(
  dto: z.infer<typeof RemoteCalibrationCandidateDto>,
): CalibrationServerIncoherence | null {
  const reasoned = dto.rejectionReasons.length > 0;

  // `Eligible = reasons.Count == 0`, tested on reasons alone as the server
  // defines it.
  if (dto.eligible && reasoned) return 'contradiction';
  if (!dto.eligible && !reasoned) return 'unexplainedRefusal';

  // A missing input the server never raised a reason for. Only reachable
  // while `eligible` is true, since the refusal case is already caught above:
  // the server is simultaneously claiming readiness and naming an input it is
  // still waiting on.
  if (dto.missingInputs.length > 0 && !reasoned) return 'contradiction';

  return null;
}

/** Engine/distribution this client negotiates; mirrors the server constants. */
export const CALIBRATION_SLICER_ENGINE = 'OrcaSlicer';
export const CALIBRATION_SLICER_DISTRIBUTION = 'upstream';

/**
 * A candidate normalised into the shape the rest of the desktop app consumes.
 *
 * `rejectionReasons` and `missingInputs` are carried through deliberately: the
 * server returns *every* enabled printer with an `eligible` verdict, so a
 * printer that cannot be calibrated must be able to say why rather than being
 * filtered into an unexplained empty list.
 */
export const RemoteCalibrationPrinterCandidate =
  RemoteCalibrationCandidateDto.transform((dto) => ({
    printerId: dto.id,
    displayName: dto.name,
    // The candidate DTO carries no marketing model string. Inventing one from
    // the backend enum would be exactly the model-based inference the
    // calibration contract forbids.
    printerModel: null as string | null,
    firmwareCompatible: deriveCandidateEligibility(dto) !== null,
    // Profile identity lives on the context snapshot, never on the candidate.
    orcaProfileId: null as string | null,
    isOnline: dto.reachability === 'online' && !dto.isStale,
    enabled: dto.enabled,
    inMaintenance: dto.inMaintenance,
    reachability: dto.reachability,
    operationalState: dto.operationalState,
    isStale: dto.isStale,
    configurationRevision: dto.configurationRevision,
    updatedAt: dto.observedAtUtc ?? dto.lastSeenAtUtc,
    eligible: dto.eligible,
    // Cut to what the renderer will carry. The cut is declared below rather
    // than made silently: a five-toolhead machine can legitimately report more
    // missing inputs than this, and showing the first sixty-four as though
    // they were the whole account would be its own quiet falsehood.
    missingInputs: dto.missingInputs.slice(
      0,
      CALIBRATION_MAX_SERVER_REJECTION_REASONS,
    ),
    rejectionReasons: dto.rejectionReasons.slice(
      0,
      CALIBRATION_MAX_SERVER_REJECTION_REASONS,
    ),
    /** Whether either explanation list was longer than the renderer carries. */
    explanationTruncated:
      dto.missingInputs.length > CALIBRATION_MAX_SERVER_REJECTION_REASONS ||
      dto.rejectionReasons.length > CALIBRATION_MAX_SERVER_REJECTION_REASONS,
    /**
     * How the server's eligibility verdict failed to hold together, if it did.
     * Carried so the incoherence can be reported as itself rather than
     * silently normalised into an ordinary refusal.
     */
    serverIncoherence: detectServerEligibilityIncoherence(dto),
    eligibility: deriveCandidateEligibility(dto),
  }));
export type RemoteCalibrationPrinterCandidate = z.infer<
  typeof RemoteCalibrationPrinterCandidate
>;

/**
 * `GET /api/printers/calibration-candidates` returns a bare JSON array
 * (`IReadOnlyList<CalibrationCandidateDto>`). The enveloped form is retained
 * only so a proxy that wraps the payload is still understood.
 *
 * The list is cut to {@link CALIBRATION_MAX_PRINTER_CANDIDATES} rather than
 * refused above it, and that constant is shared with the IPC schema. The two
 * used to disagree — 500 here, 200 there — so a farm of 201 to 500 printers
 * parsed cleanly off the network and was then rejected on the way to the
 * renderer, as one value, taking every healthy printer with it. Refusing a
 * whole farm because it is large is the failure this contract exists to
 * remove, not a safety property.
 *
 * Cutting quietly is its own failure, though. `truncated` is returned beside
 * the list so the app can say the list is partial instead of presenting 500 of
 * 540 printers as the whole farm — an operator hunting a printer that is
 * simply off the end would otherwise conclude it is not enrolled.
 *
 * It is derived from the raw wire length *before* the slice and is not read
 * from the payload, so a server can neither claim completeness it does not
 * have nor manufacture a truncation warning.
 */
const boundedCandidateList = z
  .array(z.unknown())
  .transform((items) => ({
    printers: items.slice(0, CALIBRATION_MAX_PRINTER_CANDIDATES),
    truncated: items.length > CALIBRATION_MAX_PRINTER_CANDIDATES,
  }))
  .pipe(
    z.object({
      printers: z.array(RemoteCalibrationPrinterCandidate),
      truncated: z.boolean(),
    }),
  );

export const RemoteCalibrationPrinters = z.union([
  boundedCandidateList,
  z
    .object({ printers: boundedCandidateList })
    .passthrough()
    .transform((value) => value.printers),
]);
export type RemoteCalibrationPrinters = z.infer<
  typeof RemoteCalibrationPrinters
>;

/**
 * `CalibrationToolheadDto` — one physical toolhead on the snapshot.
 * The server keys toolheads by `id`/`index` and describes the nozzle with flat
 * members rather than a nested `nozzle` object.
 */
const RemoteToolheadDto = z
  .object({
    id: ServerGuid,
    index: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform((v) => v ?? 0),
    name: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    isPrimary: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    nozzleDiameter: z
      .number()
      .positive()
      .max(10)
      .nullish()
      .transform((v) => v ?? null),
    nozzleType: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    nozzleMaterial: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    isDirectDrive: z
      .boolean()
      .nullish()
      .transform((v) => v ?? null),
    driveType: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    maxVolumetricFlow: z
      .number()
      .positive()
      .max(10_000)
      .nullish()
      .transform((v) => v ?? null),
    /**
     * Maximum hotend temperature this toolhead accepts.
     *
     * The server treats it as required for eligibility — it emits
     * `hotend_max_temperature_missing` when absent — so an eligible printer
     * always carries it. Parsed here so the baseline temperature an operator
     * enters can be range-checked against the hardware rather than against a
     * fabricated ceiling.
     */
    maxHotendTemperature: z
      .number()
      .positive()
      .max(1_000)
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();

/** `CalibrationProfileDto` — a slicer profile identity on the snapshot. */
const RemoteCalibrationProfileDto = z
  .object({
    id: ServerGuid,
    kind: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? null),
    name: z.string().min(1).max(512),
    slicerType: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    slicerDistribution: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    slicerVersion: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    profileFormat: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    profileRevision: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    sha256: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();

const RemoteBuildVolumeDto = z
  .object({
    x: z
      .number()
      .nullish()
      .transform((v) => v ?? null),
    y: z
      .number()
      .nullish()
      .transform((v) => v ?? null),
    z: z
      .number()
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();

/** `PrinterConfigurationSnapshotDto` — the nested configuration snapshot. */
const RemotePrinterConfigurationSnapshot = z
  .object({
    schemaVersion: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? null),
    printerId: ServerGuid.nullish().transform((v) => v ?? null),
    configurationRevision: z
      .number()
      .int()
      .nonnegative()
      .nullish()
      .transform((v) => v ?? null),
    capturedAtUtc: ServerInstant.nullish().transform((v) => v ?? null),
    buildVolume: RemoteBuildVolumeDto.nullish().transform((v) => v ?? null),
    toolheads: z
      .array(RemoteToolheadDto)
      .max(64)
      .nullish()
      .transform((v) => v ?? []),
    maxBedTemperature: z
      .number()
      .nullish()
      .transform((v) => v ?? null),
    hasHeatedBed: z
      .boolean()
      .nullish()
      .transform((v) => v ?? null),
    firmware: RemoteFirmwareIdentity.nullish().transform((v) => v ?? null),
    slicer: RemoteSlicerIdentity.nullish().transform((v) => v ?? null),
    profiles: z
      .object({
        machine: RemoteCalibrationProfileDto.nullish().transform(
          (v) => v ?? null,
        ),
        process: RemoteCalibrationProfileDto.nullish().transform(
          (v) => v ?? null,
        ),
        filament: RemoteCalibrationProfileDto.nullish().transform(
          (v) => v ?? null,
        ),
      })
      .passthrough()
      .nullish()
      .transform((v) => v ?? null),
    baselineSettings: z
      .object({
        activeNozzleDiameter: z
          .number()
          .positive()
          .max(10)
          .nullish()
          .transform((v) => v ?? null),
      })
      .passthrough()
      .nullish()
      .transform((v) => v ?? null),
    snapshotSha256: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();

/**
 * Wire shape of `CalibrationContextDto` as
 * `GET /api/printers/{id}/calibration-context?slicerType=OrcaSlicer` returns
 * it: every `CalibrationCandidateDto` member, plus snapshot metadata and the
 * nested `snapshot` aggregate.
 *
 * The previous schema expected a flat, invented object (`printerId`,
 * `firmware.firmware`, `snapshotAt`, top-level `orcaProfileId`,
 * `configurationId`, `safety`, `permissions`). None of those members exist on
 * the wire, so context parsing could not succeed against any real server.
 */
const RemoteCalibrationContextDto = RemoteCalibrationCandidateDto.merge(
  z.object({
    schemaVersion: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? null),
    snapshotSha256: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    capturedAtUtc: ServerInstant.nullish().transform((v) => v ?? null),
    capturedBySubject: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    supportsPressureAdvance: z
      .boolean()
      .nullish()
      .transform((v) => v ?? null),
    supportsFirmwareRetraction: z
      .boolean()
      .nullish()
      .transform((v) => v ?? null),
    snapshot: RemotePrinterConfigurationSnapshot.nullish().transform(
      (v) => v ?? null,
    ),
  }),
);

/**
 * A printer context normalised for the rest of the app.
 *
 * Two distinct profile identities are propagated deliberately:
 * `orcaProfileId` is the server's immutable `Guid` for the filament profile,
 * while `orcaProfileName` is the human/OrcaSlicer-facing name. They are not
 * interchangeable — the GUID identifies the profile across revisions and is
 * what hashes and revisions bind to, whereas only the name can be matched
 * against a local OrcaSlicer profile file. Collapsing them (the previous
 * behaviour) meant a GUID was compared against local `profile.name` values and
 * could never match.
 */
export const RemoteCalibrationPrinterContext =
  RemoteCalibrationContextDto.transform((dto) => {
    const snapshot = dto.snapshot;
    const filament = snapshot?.profiles?.filament ?? null;
    const machine = snapshot?.profiles?.machine ?? null;
    const toolheads = (snapshot?.toolheads ?? []).map((toolhead) => ({
      toolId: toolhead.id,
      toolheadId: toolhead.id,
      toolheadIndex: toolhead.index,
      extruderType:
        toolhead.isDirectDrive === true
          ? ('directDrive' as const)
          : toolhead.isDirectDrive === false
            ? ('bowden' as const)
            : null,
      nozzle: {
        // The nozzle has no independent server identity; it is addressed
        // through its owning toolhead.
        id: toolhead.id,
        diameterMm: toolhead.nozzleDiameter,
        material: toolhead.nozzleMaterial,
      },
    }));
    // Machine limits the DTO does publish, taken across the toolheads it
    // describes. The most permissive toolhead sets the ceiling because a
    // baseline value is only unsafe if no installed hardware can accept it.
    const maximumVolumetricRateMm3S = snapshot?.toolheads.reduce<number | null>(
      (highest, toolhead) =>
        toolhead.maxVolumetricFlow === null
          ? highest
          : Math.max(highest ?? 0, toolhead.maxVolumetricFlow),
      null,
    );
    const maximumNozzleTemperatureC = snapshot?.toolheads.reduce<number | null>(
      (highest, toolhead) =>
        toolhead.maxHotendTemperature === null
          ? highest
          : Math.max(highest ?? 0, toolhead.maxHotendTemperature),
      null,
    );
    return {
      printerId: dto.id,
      displayName: dto.name,
      printerModel: null as string | null,
      firmware: {
        firmware: dto.firmware?.family ?? null,
        gcodeDialect: dto.firmware?.gcodeDialect ?? null,
        firmwareVersion: dto.firmware?.version ?? null,
        verified: dto.firmware?.verified ?? false,
        // PrintFarmer's `CalibrationFirmwareIdentityDto` carries no Klipper
        // config hash. Reporting `null` states that plainly instead of
        // fabricating a value the server never sent.
        klipperConfigHash: null as string | null,
      },
      /** Immutable server identity (Guid) of the filament profile. */
      orcaProfileId: filament?.id ?? null,
      /** OrcaSlicer-facing profile name; the only value safe to match locally. */
      orcaProfileName: filament?.name ?? null,
      orcaProfileDisplayName: filament?.name ?? null,
      /** Machine profile identity, kept distinct from the filament profile. */
      machineProfileId: machine?.id ?? null,
      machineProfileName: machine?.name ?? null,
      profileRevision: filament?.profileRevision ?? null,
      contentHash: filament?.sha256 ?? null,
      bedWidthMm: snapshot?.buildVolume?.x ?? null,
      bedDepthMm: snapshot?.buildVolume?.y ?? null,
      nozzleDiameterMm:
        snapshot?.baselineSettings?.activeNozzleDiameter ??
        (toolheads.length === 1 ? toolheads[0]!.nozzle.diameterMm : null),
      snapshotAt: dto.capturedAtUtc ?? snapshot?.capturedAtUtc ?? null,
      /** The snapshot is identified by its content hash; there is no separate ID. */
      snapshotId: dto.snapshotSha256 ?? snapshot?.snapshotSha256 ?? null,
      configurationRevision:
        dto.configurationRevision ?? snapshot?.configurationRevision ?? null,
      configurationId: snapshot?.printerId ?? null,
      /**
       * The snapshot has no revision independent of the configuration it was
       * captured from, so the configuration revision is the snapshot revision.
       */
      snapshotRevision: snapshot?.configurationRevision ?? null,
      /**
       * Machine limits come from the snapshot; the interlock assertions do not
       * exist at all.
       *
       * `CalibrationContextDto` publishes real physical limits — build volume,
       * maximum bed temperature, per-toolhead maximum volumetric flow and nozzle
       * temperature — and those are carried through here so baseline values can
       * be range-checked against the machine the operator actually selected.
       *
       * What it does not publish is any statement about emergency-stop
       * availability, thermal-protection confirmation or ventilation assessment.
       * Those stay `false`: absent evidence is not a safety assurance, and the
       * app must never claim the server confirmed something it never mentioned.
       *
       * Reporting the whole block as `null` (as an earlier revision did) conflated
       * the two. It discarded limits the server *had* supplied and made
       * `bindingFromContext` unsatisfiable, so no calibration project could be
       * created against any real server at all.
       *
       * Enforcement for generation and print start lives in
       * `calibrationActionGate.ts`, not here.
       */
      safety:
        snapshot?.buildVolume == null ||
        snapshot.maxBedTemperature === null ||
        maximumNozzleTemperatureC === null ||
        maximumVolumetricRateMm3S === null
          ? null
          : {
              buildVolumeMm: {
                x: snapshot.buildVolume.x,
                y: snapshot.buildVolume.y,
                z: snapshot.buildVolume.z,
              },
              maximumNozzleTemperatureC,
              maximumBedTemperatureC: snapshot.maxBedTemperature,
              maximumVolumetricRateMm3S,
              // Never asserted by PrintFarmer. Machine-moving actions are gated
              // in `calibrationActionGate.ts` on evidence that does exist.
              emergencyStopAvailable: false,
              thermalProtectionConfirmed: false,
              ventilationAssessed: false,
            },
      /**
       * Likewise, per-printer calibration permissions are not part of the
       * context DTO. Authorisation is enforced by the server on every call and
       * surfaced through capability `effectivePermissions`, not here.
       */
      permissions: null as {
        readPrinter: boolean;
        writeCalibration: boolean;
        generateCalibration: boolean;
        startPrint: boolean;
      } | null,
      slicerIdentity: dto.slicer?.engine ?? null,
      slicerDistribution: dto.slicer?.distribution ?? null,
      isCurrent:
        dto.configurationRevision !== null &&
        snapshot?.configurationRevision !== null &&
        dto.configurationRevision === snapshot?.configurationRevision,
      toolheads,
      eligible: dto.eligible,
      missingInputs: dto.missingInputs,
      rejectionReasons: dto.rejectionReasons,
      supportsPressureAdvance: dto.supportsPressureAdvance,
      supportsFirmwareRetraction: dto.supportsFirmwareRetraction,
      capturedBySubject: dto.capturedBySubject,
      schemaVersion: dto.schemaVersion,
    };
  });
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

/**
 * Whether a context carries every identity the calibration contract actually
 * defines.
 *
 * Scope note: this predicate answers "is the server's description of this
 * printer complete enough to identify and list it", not "is it safe to print".
 * It deliberately does **not** consult `safety` or `permissions`, because
 * `CalibrationContextDto` has no such members — requiring them here made the
 * predicate unsatisfiable against every real server, which silently disabled
 * profile listing rather than gating anything.
 *
 * Authorisation for anything that mutates server state or moves a machine lives
 * in `calibrationActionGate.ts`, which gates on evidence that exists: the
 * canonical `effectivePermissions`, the negotiated capability flags, the
 * printer/revision/snapshot/tool binding, and a main-process bed-clear
 * acknowledgement ledger. Until that gate existed the only checks that actually
 * ran were the server's own refusal and the `calibrationGenerationEnabled`
 * flag — a comment here once named `isCalibrationContextSafetyAssured` as the
 * interlock, but that predicate had no call sites, so the protection it
 * described did not exist. This module still performs no interlock of its own
 * beyond the drift detection in {@link doesCalibrationWorkspaceMatchContext}.
 */
export function isExplicitCalibrationContextComplete(
  context: RemoteCalibrationPrinterContext,
): boolean {
  return (
    context.configurationId !== null &&
    context.configurationRevision !== null &&
    context.snapshotId !== null &&
    context.snapshotRevision !== null &&
    context.slicerIdentity === CALIBRATION_SLICER_ENGINE &&
    context.slicerDistribution === CALIBRATION_SLICER_DISTRIBUTION &&
    context.orcaProfileId !== null &&
    context.orcaProfileName !== null &&
    context.profileRevision !== null &&
    context.toolheads.length > 0
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
    // Profile identity is carried by the context snapshot only.
    // `CalibrationCandidateDto` has no profile member, so cross-checking the
    // candidate for one could never succeed.
    context.orcaProfileId === null ||
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
    // The GUID above identifies the profile; only this name can be matched
    // against a file in the local OrcaSlicer installation.
    orcaProfileName: context.orcaProfileName,
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
  // PrintFarmer's `CalibrationContextDto` publishes no safety block, so there
  // is nothing to compare against the workspace's recorded safety envelope.
  // This previously returned false outright, which did not detect drift — it
  // simply made every workspace unmatchable, blocking creation and refresh for
  // all printers. When the server does supply the block, every field is still
  // compared exactly.
  //
  // This is drift detection, not authorisation: actions that move the machine
  // are gated in `calibrationActionGate.ts` on canonical effective permissions,
  // negotiated capability flags, the printer/revision/snapshot/tool binding and
  // a main-process bed-clear acknowledgement ledger. This module performs no
  // client-side interlock of its own; what follows is drift detection.
  const remoteSafety = context.safety;
  const safetyMatches =
    remoteSafety === null ||
    (remoteSafety.buildVolumeMm.x === snapshot.safety.buildVolumeMm.x &&
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
      remoteSafety.ventilationAssessed === snapshot.safety.ventilationAssessed);
  return (
    context.printerId === printer.backendPrinterId &&
    context.configurationId === printer.printerConfigurationId &&
    context.configurationRevision === printer.printerConfigurationRevision &&
    context.snapshotId === snapshot.snapshotId &&
    context.snapshotRevision === snapshot.snapshotRevision &&
    context.snapshotAt === snapshot.capturedAt &&
    context.configurationRevision === snapshot.configurationRevision &&
    safetyMatches &&
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

/** Required upstream slicer engine identity for calibration. */
export const REQUIRED_SLICER_ENGINE = 'OrcaSlicer';
/** Required firmware family and G-code dialect for calibration. */
export const REQUIRED_FIRMWARE_FAMILY = 'Klipper';

/**
 * A boolean capability switch that a server may not know about yet.
 *
 * Absent means "not advertised", which is treated as *disabled* so negotiation
 * stays fail-closed on older servers. A present value of the wrong type is
 * still a contract violation and fails validation.
 */
const AdvertisedFlag = z.boolean().optional().default(false);

/**
 * Same wire contract as {@link AdvertisedFlag} — boolean or absent, wrong
 * type still fails validation — but *without* defaulting absence to `false`.
 *
 * Used only for the raw fields that back the negotiated calibration
 * `flags` (#493): the "not advertised at all" fact must survive parsing so it
 * can be reported as `unknown` rather than being silently indistinguishable
 * from an explicit `false`. `AdvertisedFlag`'s eager default would erase that
 * distinction before it ever reaches the transform below.
 */
const AdvertisedFlagRaw = z.boolean().optional();

const RemoteSlicerEngineCapability = z
  .object({
    type: z.string().max(128).optional().default(''),
    version: z.string().max(128).optional().default(''),
    distribution: z.string().max(128).optional().default(''),
    supported: AdvertisedFlag,
  })
  .passthrough();

/**
 * Maps each end-to-end calibration capability flag to the raw
 * `PlatformCapabilitiesDto` field that backs it.
 *
 * This is the single production source of truth for "what capability flags
 * exist" (#493 AC1): both the `flags`/`flagAdvertisement` reduction below and
 * the split-deployment test suite read the flag names from here, so a flag
 * added to this map is automatically covered by the test — nothing needs to
 * be hand-copied into `tests/`.
 */
export const CALIBRATION_FLAG_SOURCES = {
  calibrationApiEnabled: 'calibrationPersistenceEnabled',
  calibrationChangeFeedEnabled: 'calibrationSyncEnabled',
  calibrationOfflineDraftEnabled: 'calibrationSyncEnabled',
  calibrationPhotoUploadEnabled: 'calibrationPhotosEnabled',
  calibrationGenerationEnabled: 'calibrationGenerationEnabled',
} as const;

/** Name of one of the negotiated end-to-end calibration capability flags. */
export type CalibrationFlagName = keyof typeof CALIBRATION_FLAG_SOURCES;

/**
 * Whether the server advertised a value for a capability flag's backing
 * field at all — distinct from whether that value was `true` or `false`.
 *
 * `'unknown'` means the field was absent from the response, so availability
 * cannot be determined from what the server sent (#493 AC4). It must never be
 * treated as `'true'`; production code and the tests both fail closed to
 * `false` for `flags` when this is `'unknown'`.
 */
export type CalibrationFlagAdvertisement = 'true' | 'false' | 'unknown';

/**
 * Remote capability-negotiation response from
 * `GET /api/calibration/capabilities`.
 *
 * The server returns `PlatformCapabilitiesDto` — the same shape as the
 * anonymous `GET /api/system/capabilities` response plus the authenticated
 * `effectivePermissions` and `effectiveCapabilities` members. Parsing is
 * additive: unknown members pass through and capability switches this client
 * does not receive are treated as disabled rather than as a malformed body.
 *
 * The parsed value is normalised into the negotiation shape the calibration
 * feature gate consumes, so callers never depend on raw wire naming.
 */
export const RemoteCalibrationCapabilities = z
  .object({
    /** Server-wide API contract version. Always present since contract 1.0. */
    apiContractVersion: z.string().min(1).max(64),
    /** Calibration API contract version; null when calibration is unavailable. */
    calibrationApiVersion: z
      .string()
      .max(64)
      .nullish()
      .transform((value) => value ?? null),
    /** Calibration persistence schema version; null when unavailable. */
    calibrationSchemaVersion: z
      .string()
      .max(64)
      .nullish()
      .transform((value) => value ?? null),
    /** Calibration project persistence is implemented and enabled. */
    calibrationPersistenceEnabled: AdvertisedFlagRaw,
    /** Calibration synchronisation (change feed + offline draft push). */
    calibrationSyncEnabled: AdvertisedFlagRaw,
    /** Calibration photo capture and upload. */
    calibrationPhotosEnabled: AdvertisedFlagRaw,
    /** Calibration command generation and G-code promotion. */
    calibrationGenerationEnabled: AdvertisedFlagRaw,
    /** Firmware families the calibration contract supports. */
    supportedFirmwareFamilies: z
      .array(z.string().max(64))
      .max(32)
      .optional()
      .default([]),
    /** G-code dialects the calibration contract supports. */
    supportedGcodeDialects: z
      .array(z.string().max(64))
      .max(32)
      .optional()
      .default([]),
    /** Slicer engines this deployment supports. */
    supportedSlicerEngines: z
      .array(RemoteSlicerEngineCapability)
      .max(32)
      .optional()
      .default([]),
    /**
     * The caller's effective `resource:action` permissions. Only the
     * authenticated calibration capability endpoint populates this.
     */
    effectivePermissions: z
      .array(z.string().max(64))
      .max(64)
      .nullish()
      .transform((value) => value ?? []),
  })
  .passthrough()
  .transform((value) => {
    /** Raw per-field advertisement, keyed by the DTO field name — before
     * defaulting absence away, so `undefined` here is still observable. */
    const rawFields: Record<
      (typeof CALIBRATION_FLAG_SOURCES)[CalibrationFlagName],
      boolean | undefined
    > = {
      calibrationPersistenceEnabled: value.calibrationPersistenceEnabled,
      calibrationSyncEnabled: value.calibrationSyncEnabled,
      calibrationPhotosEnabled: value.calibrationPhotosEnabled,
      calibrationGenerationEnabled: value.calibrationGenerationEnabled,
    };
    const flags = {} as Record<CalibrationFlagName, boolean>;
    const flagAdvertisement = {} as Record<
      CalibrationFlagName,
      CalibrationFlagAdvertisement
    >;
    for (const [flagName, sourceField] of Object.entries(
      CALIBRATION_FLAG_SOURCES,
    ) as [
      CalibrationFlagName,
      (typeof CALIBRATION_FLAG_SOURCES)[CalibrationFlagName],
    ][]) {
      const raw = rawFields[sourceField];
      // Fail-closed: absent or explicit `false` both leave the flag
      // unavailable. Only `flagAdvertisement` distinguishes them (#493 AC4).
      flags[flagName] = raw === true;
      flagAdvertisement[flagName] =
        raw === undefined ? 'unknown' : raw ? 'true' : 'false';
    }
    return {
      /** Negotiated calibration API version, or null when not advertised. */
      apiVersion: value.calibrationApiVersion,
      /** Negotiated calibration schema version, or null when not advertised. */
      schemaVersion: value.calibrationSchemaVersion,
      /** Server-wide API contract version. */
      apiContractVersion: value.apiContractVersion,
      /** Permissions the current token actually grants. */
      grantedScopes: value.effectivePermissions,
      supportedFirmwareFamilies: value.supportedFirmwareFamilies,
      supportedGcodeDialects: value.supportedGcodeDialects,
      supportedSlicerEngines: value.supportedSlicerEngines,
      /**
       * End-to-end capability flags the calibration feature gate requires.
       * Offline drafts are pushed through the calibration sync endpoint, so
       * they are gated by the same server switch as the change feed. Absent
       * server fields fail closed to `false` here — see `flagAdvertisement`
       * for whether that `false` was advertised or merely not observed.
       */
      flags,
      /**
       * Per-flag advertisement state: whether the server said `true`,
       * explicitly said `false`, or said nothing at all (`'unknown'`). Added
       * for #493 — `flags` alone cannot prove a capability's unavailability
       * was actually reported by the server rather than defaulted.
       */
      flagAdvertisement,
    };
  });
export type RemoteCalibrationCapabilities = z.infer<
  typeof RemoteCalibrationCapabilities
>;

/**
 * Capability flags without which the calibration workspace cannot function at
 * all: durable persistence plus the change feed and offline draft push the sync
 * engine relies on. These are preconditions, not features — if any is disabled
 * there is nothing the workspace could usefully do, so calibration is withheld.
 *
 * This is deliberately the same set `CalibrationSyncEngine` enforces, so the
 * availability gate and the sync gate cannot disagree about what "usable" means.
 */
export const REQUIRED_CALIBRATION_FLAGS = [
  'calibrationApiEnabled',
  'calibrationChangeFeedEnabled',
  'calibrationOfflineDraftEnabled',
] as const;

/**
 * Capability flags that switch individual features on and off rather than
 * gating the workspace.
 *
 * A deployment can legitimately run calibration without them. `calibrationPhotos`
 * only adds evidence attachments, and `calibrationGeneration` requires an entire
 * slicing fleet server-side (an online worker attesting a pinned upstream
 * OrcaSlicer build), which many deployments will not have. Recording measured
 * results by hand stays fully usable in both cases, so these are surfaced to the
 * renderer through `capabilityFlags` and gate their own actions instead of
 * blocking the tab.
 */
export const OPTIONAL_CALIBRATION_FEATURE_FLAGS = [
  'calibrationPhotoUploadEnabled',
  'calibrationGenerationEnabled',
] as const;

/** Names the capability flags the server did not advertise as enabled. */
export function missingCalibrationFlags(
  capabilities: RemoteCalibrationCapabilities,
  required: readonly (keyof RemoteCalibrationCapabilities['flags'])[] = REQUIRED_CALIBRATION_FLAGS,
): string[] {
  return required.filter((flag) => !capabilities.flags[flag]);
}

/**
 * Names the optional calibration features this server has switched off.
 *
 * Callers use this for diagnostics only: a disabled feature narrows what the
 * workspace offers, it never makes calibration unavailable.
 */
export function disabledCalibrationFeatures(
  capabilities: RemoteCalibrationCapabilities,
): string[] {
  return missingCalibrationFlags(
    capabilities,
    OPTIONAL_CALIBRATION_FEATURE_FLAGS,
  );
}

/**
 * Names the capability flags whose availability the server response did not
 * actually determine — the backing field was absent, not `false` (#493 AC4).
 *
 * A flag can appear here and still read `false` in `flags`, because `flags`
 * fails closed on `unknown` too; this is the only place that distinguishes
 * "the server said no" from "the server said nothing".
 */
export function unknownCalibrationFlags(
  capabilities: RemoteCalibrationCapabilities,
): string[] {
  return (
    Object.keys(CALIBRATION_FLAG_SOURCES) as CalibrationFlagName[]
  ).filter((flag) => capabilities.flagAdvertisement[flag] === 'unknown');
}

/** True when the server supports Klipper firmware *and* the Klipper dialect. */
export function supportsKlipper(
  capabilities: RemoteCalibrationCapabilities,
): boolean {
  return (
    capabilities.supportedFirmwareFamilies.includes(REQUIRED_FIRMWARE_FAMILY) &&
    capabilities.supportedGcodeDialects.includes(REQUIRED_FIRMWARE_FAMILY)
  );
}

/** True when the server advertises a supported upstream OrcaSlicer engine. */
export function supportsOrcaSlicer(
  capabilities: RemoteCalibrationCapabilities,
): boolean {
  return capabilities.supportedSlicerEngines.some(
    (engine) => engine.type === REQUIRED_SLICER_ENGINE && engine.supported,
  );
}

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
    /**
     * Extension field as actually emitted by PrintFarmer. ASP.NET controllers
     * write the machine-readable code to `code`
     * (`problem.Extensions["code"] = ...` in `PrinterCalibrationController`),
     * not `errorCode`. Reading only `errorCode` silently discarded every
     * server diagnosis — including `profile_service_unavailable`, which is the
     * one code that explains an empty production printer list.
     */
    code: z.string().max(64).optional(),
  })
  .passthrough()
  .transform((value) => ({
    ...value,
    // Prefer the documented extension, fall back to the legacy name so a
    // deployment emitting either is understood.
    errorCode: value.errorCode ?? value.code,
  }));
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

// ─── Generation orchestration (issue #899 / #54) ────────────────────────────

/**
 * Remote orchestration status from GET /api/calibration-orchestrations/{id}.
 *
 * `status` and `currentStep` are free-form strings from the saga implementation.
 * The desktop MUST NOT switch exhaustively on them; render the raw value with
 * a fallback for any unrecognised state.
 *
 * All fields are parsed additively (passthrough) so the server can add fields
 * without breaking the desktop.
 */
export const RemoteCalibrationOrchestrationStatus = z
  .object({
    id: ServerGuid,
    projectId: ServerGuid,
    attemptId: ServerGuid,
    operationId: z.string(),
    /** Free-form — e.g. "Running", "Completed". NOT an enum. */
    status: z.string(),
    /** Free-form — e.g. "submitting-slice-job", "awaiting-worker". NOT an enum. */
    currentStep: z.string(),
    revision: z.number().int(),
    retryCount: z.number().int(),
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
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    problems: z
      .array(
        z
          .object({
            code: z.string(),
            field: z
              .string()
              .nullish()
              .transform((v) => v ?? null),
            message: z.string(),
          })
          .passthrough(),
      )
      .max(100)
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
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    planManifestSha256: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    gcodeSha256: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    manifestSha256: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    generatorVersion: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    slicerContainerDigest: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
    slicerBinarySha256: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    statusRoute: z.string(),
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

// ─── Primary job-queue REST DTOs (issue #900 / #54) ─────────────────────────

/**
 * Dispatch attempt result embedded in a queue job DTO.
 * `outcome` is a DispatchAttemptOutcome literal:
 *   InProgress | Accepted | Rejected | FailedBeforeStart | Unknown
 *
 * `jobRevision` and `dispatchStateRevision` are opaque base-64 strings
 * encoding provider row-version bytes. Treat as opaque tokens and forward
 * without application-level interpretation (see admin guide §10.4).
 */
export const RemoteDispatchAttemptResult = z
  .object({
    attemptId: ServerGuid.nullish().transform((v) => v ?? null),
    attemptNumber: z
      .number()
      .int()
      .nullish()
      .transform((v) => v ?? null),
    /** DispatchAttemptOutcome literal — NOT an enum — forward-compat. */
    outcome: z.string(),
    backendAcceptedAtUtc: z
      .string()
      .datetime()
      .nullish()
      .transform((v) => v ?? null),
    errorCode: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    errorDetail: z
      .string()
      .max(4096)
      .nullish()
      .transform((v) => v ?? null),
    isRetryable: z.boolean(),
    requiresReconciliation: z.boolean(),
    /** Opaque base-64 job rowVersion. */
    jobRevision: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
    /** Opaque base-64 dispatch state rowVersion. */
    dispatchStateRevision: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteDispatchAttemptResult = z.infer<
  typeof RemoteDispatchAttemptResult
>;

/**
 * Response from GET /api/job-queue/{id} and (on creation) POST /api/job-queue.
 *
 * `rowVersion` / `dispatchStateRowVersion` are opaque base-64 strings encoding
 * provider row-version bytes (application-managed on SQLite/PostgreSQL; native
 * ROWVERSION on SQL Server). Forward them without interpretation as
 * `If-Match` / `X-Dispatch-State-If-Match` headers on bed-clear mutations.
 * See admin guide §10.4 for the 400/412/428 outcome distinction.
 *
 * `status` is a PrintJobStatus literal:
 *   Queued | Assigned | Starting | Printing | Paused | Completed | Failed | Cancelled
 */
export const RemoteJobQueueJob = z
  .object({
    id: ServerGuid,
    /** Opaque base-64 job ETag. Send as If-Match on bed-clear. */
    rowVersion: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
    revision: z.number().int(),
    /** Opaque base-64 dispatch state ETag. Send as X-Dispatch-State-If-Match. */
    dispatchStateRowVersion: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
    dispatchStateRevision: z
      .number()
      .int()
      .nullish()
      .transform((v) => v ?? null),
    dispatchResult: RemoteDispatchAttemptResult.nullish().transform(
      (v) => v ?? null,
    ),
    /** "Standard" | "FilamentCalibration" | null */
    jobKind: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    calibrationProjectId: ServerGuid.nullish().transform((v) => v ?? null),
    calibrationAttemptId: ServerGuid.nullish().transform((v) => v ?? null),
    pinnedPrinterConfigRevision: z
      .number()
      .int()
      .nullish()
      .transform((v) => v ?? null),
    gcodeFileId: ServerGuid.nullish().transform((v) => v ?? null),
    gcodeFileName: z.string().optional().default(''),
    assignedPrinterId: ServerGuid.nullish().transform((v) => v ?? null),
    assignedPrinterName: z.string().optional().default(''),
    /** PrintJobStatus literal — NOT an enum — forward-compat. */
    status: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    /**
     * BedClearState literal — NOT an enum — forward-compat.
     * Values: None | Acknowledged | Consumed | Invalidated
     */
    bedClearState: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    priority: z.number().int(),
    queuePosition: z.number().int(),
    copies: z.number().int(),
    completedCopies: z.number().int(),
    remainingCopies: z.number().int(),
    isIdempotentReplay: z.boolean().optional().default(false),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();
export type RemoteJobQueueJob = z.infer<typeof RemoteJobQueueJob>;

/**
 * Success body returned by POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start.
 * Both ETags may be null if the service did not have current row versions.
 */
export const RemoteAcknowledgeBedClearSuccess = z
  .object({
    message: z.string().optional(),
    jobETag: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
    dispatchStateETag: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteAcknowledgeBedClearSuccess = z.infer<
  typeof RemoteAcknowledgeBedClearSuccess
>;

/**
 * 412 body returned by the bed-clear endpoint when ETags are out of date.
 * Use the returned ETags to retry without a separate GET.
 */
export const RemoteAcknowledgeBedClearConflict = z
  .object({
    error: z.string(),
    detail: z.string().optional(),
    /** Current job ETag — use as If-Match on the next attempt. */
    jobETag: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
    /** Current dispatch state ETag — use as X-Dispatch-State-If-Match on the next attempt. */
    dispatchStateETag: z
      .string()
      .max(512)
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteAcknowledgeBedClearConflict = z.infer<
  typeof RemoteAcknowledgeBedClearConflict
>;

/**
 * Request body for POST /api/job-queue (FilamentCalibration job creation).
 */
export const RemoteQueuePrintJobDto = z
  .object({
    gcodeFileId: z.string().uuid(),
    jobKind: z.literal('FilamentCalibration'),
    idempotencyKey: z.string(),
    idempotencyScope: z.string().optional(),
    calibrationProjectId: z.string().uuid().optional(),
    calibrationAttemptId: z.string().uuid().optional(),
    calibrationConfigSnapshotId: z.string().uuid().optional(),
    calibrationOrchestrationId: z.string().uuid().optional(),
    sourceArtifactId: z.string().uuid().optional(),
    assignedPrinterId: z.string().uuid(),
    priority: z.enum(['Low', 'Normal', 'High', 'Urgent']).optional(),
    pinnedPrinterConfigRevision: z.number().int().nullable().optional(),
    requiredFirmwareFamily: z.string().max(256).nullable().optional(),
    requiredGcodeDialect: z.string().max(256).nullable().optional(),
    requiredSlicerEngine: z.string().max(256).nullable().optional(),
    requiredSlicerDistribution: z.string().max(256).nullable().optional(),
    requiredSlicerVersion: z.string().max(256).nullable().optional(),
    requiredSlicerContainerDigest: z.string().max(512).nullable().optional(),
    gcodeContentSha256: z.string().max(256).nullable().optional(),
    specificationSha256: z.string().max(256).nullable().optional(),
    machineProfileSha256: z.string().max(256).nullable().optional(),
    processProfileSha256: z.string().max(256).nullable().optional(),
    filamentProfileSha256: z.string().max(256).nullable().optional(),
    printerConfigSnapshotSha256: z.string().max(256).nullable().optional(),
    copies: z.number().int().min(1).max(1).optional(),
  })
  .passthrough();
export type RemoteQueuePrintJobDto = z.infer<typeof RemoteQueuePrintJobDto>;

/**
 * SignalR QueueEventEnvelope (schema version "3").
 *
 * The `Printer-{printerId}` group receives REDACTED envelopes where
 * `jobId`, `jobRevision`, `bedClearState`, and many other fields are nulled
 * and `eventType` is always "PrintFarmer.Queue.PrinterStateChanged.v1".
 * NEVER treat printer-group envelopes as job state.
 *
 * For full job data: subscribe to the `QueueJob-{jobId}` group via
 * `SubscribeToQueueJobAsync(jobId)`.
 *
 * Use `sequence` for gap detection; REST is authoritative on any gap.
 */
export const RemoteQueueEventEnvelope = z
  .object({
    schemaVersion: z.string(),
    eventId: ServerGuid,
    sequence: z.number().int(),
    eventType: z.string(),
    occurredAtUtc: z.string().datetime(),
    jobId: ServerGuid.nullish().transform((v) => v ?? null),
    printerId: ServerGuid.nullish().transform((v) => v ?? null),
    projectId: ServerGuid.nullish().transform((v) => v ?? null),
    calibrationAttemptId: ServerGuid.nullish().transform((v) => v ?? null),
    /** PrintJobStatus literal. */
    jobStatus: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    /** "Standard" | "FilamentCalibration" | null */
    jobKind: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    /** Opaque base-64 job rowVersion. */
    jobRevision: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    /** Opaque base-64 dispatch state rowVersion. */
    dispatchStateRevision: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    attemptId: ServerGuid.nullish().transform((v) => v ?? null),
    attemptNumber: z
      .number()
      .int()
      .nullish()
      .transform((v) => v ?? null),
    /** DispatchAttemptOutcome literal. */
    attemptOutcome: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    /** BedClearState: None | Acknowledged | Consumed | Invalidated */
    bedClearState: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    bedClearCommandId: ServerGuid.nullish().transform((v) => v ?? null),
    bedClearExpiresAtUtc: z
      .string()
      .datetime()
      .nullish()
      .transform((v) => v ?? null),
    errorCode: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    failureCode: z
      .string()
      .nullish()
      .transform((v) => v ?? null),
    failureRetryable: z
      .boolean()
      .nullish()
      .transform((v) => v ?? null),
    failureRequiresReconciliation: z
      .boolean()
      .nullish()
      .transform((v) => v ?? null),
    jobLogicalRevision: z
      .number()
      .int()
      .nullish()
      .transform((v) => v ?? null),
    dispatchStateLogicalRevision: z
      .number()
      .int()
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteQueueEventEnvelope = z.infer<typeof RemoteQueueEventEnvelope>;

// ─── Primary job-queue change feed (issue #54) ──────────────────────────────

/**
 * Response from GET /api/job-queue/changes?afterSequence=&limit=
 *
 * `events` are the QueueEventEnvelope records since the cursor.
 * `nextSequence` is server-supplied and is meant to become `afterSequence` on
 * the next poll, but nothing in this schema ties it to `events` — a value
 * exceeding the highest delivered sequence would otherwise be adopted
 * verbatim, letting the server steer the cursor across responses and skip
 * events without detection (#487). That relationship (nextSequence must not
 * exceed `events.at(-1)?.sequence ?? afterSequence`, and exceeding it means a
 * gap) is enforced in `src/main/ipc.ts`'s `calibration:pollQueueChanges`
 * handler, the only place with both the request cursor and this parsed page
 * in scope.
 *
 * schemaVersion "3" is current (QueueEventSchemaVersions.Current = "3").
 */
export const RemoteJobQueueChangeFeedPage = z
  .object({
    afterSequence: z.number().int(),
    nextSequence: z.number().int(),
    hasMore: z.boolean(),
    events: z.array(RemoteQueueEventEnvelope).max(500),
  })
  .passthrough();
export type RemoteJobQueueChangeFeedPage = z.infer<
  typeof RemoteJobQueueChangeFeedPage
>;

/**
 * Response from GET /api/job-queue/subscription-resources
 *
 * Lists active job IDs, printer IDs, and project IDs that the client
 * should subscribe to via SignalR. Only active jobs are included
 * (Queued | Assigned | Starting | Printing | Paused).
 */
export const RemoteQueueSubscriptionResources = z
  .object({
    printerIds: z.array(ServerGuid).max(500),
    jobIds: z.array(ServerGuid).max(500),
    projectIds: z.array(ServerGuid).max(500),
  })
  .passthrough();
export type RemoteQueueSubscriptionResources = z.infer<
  typeof RemoteQueueSubscriptionResources
>;
