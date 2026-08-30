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
  CalibrationWorkspacePayload,
  CALIBRATION_EXPLANATION_TRUNCATED_CODE,
  CALIBRATION_MAX_SERVER_REJECTION_REASONS,
  CALIBRATION_MAX_PRINTER_CANDIDATES,
  CALIBRATION_MAX_PROFILE_LIST,
  OrcaProfileEntry,
  UNRECOGNIZED_CALIBRATION_INPUT,
  UNRECOGNIZED_CALIBRATION_REASON_CODE,
  deriveCalibrationWorkspaceProjection,
  normalizeCalibrationMissingInput,
  normalizeCalibrationReasonCode,
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
    const iso = new Date(parsed).toISOString();
    // An instant outside the four-digit-year range renders as an ECMAScript
    // expanded year (`+010000-01-01T00:00:00.000Z`), which is a real instant
    // but not one `z.string().datetime()` accepts. Letting it through here
    // classified the record as *readable* and then failed the IPC boundary,
    // where the response is parsed as one value — so a single unrepresentable
    // timestamp discarded the whole farm while the unreadable count sat at
    // zero, reporting nothing lost. Refusing it here makes the record
    // unreadable in the ordinary way: dropped alone, and counted.
    if (!/^\d{4}-/.test(iso)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Instant is outside the representable year range.',
      });
      return z.NEVER;
    }
    return iso;
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
 *
 * This ceiling is sized for small per-printer lists (missing inputs,
 * rejection reasons, a filament's compatible-printer names) and must not be
 * reused for a farm-wide catalog list: `/extended` uses its own, much higher
 * {@link CALIBRATION_MAX_PROFILE_LIST} instead, because this cap silently
 * dropping rows past it fed a per-profile identity lookup rather than a
 * display list — see the `/extended` schema below.
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
 * Like {@link boundedWireList}, but a single malformed element is dropped
 * instead of failing the whole array.
 *
 * `boundedWireList`'s `.pipe(z.array(element))` re-validates the sliced list
 * as one atomic value: any single element that fails `element`'s schema
 * fails the entire parse, which is exactly the "one bad row erases every
 * healthy row" failure mode the doc comment on `boundedWireList` itself
 * warns about for the object-field case. For a list surfaced directly as
 * operator-facing picker options (rather than fed into an identity lookup
 * that needs every row to exist), a malformed element that the picker was
 * never going to render correctly anyway should be quietly excluded, not
 * take the rest of the list down with it.
 */
function filteredWireList<T extends z.ZodTypeAny>(element: T) {
  return z
    .array(z.unknown())
    .nullish()
    .transform((items) =>
      (items ?? [])
        .slice(0, WIRE_LIST_CEILING)
        .map((item) => element.safeParse(item))
        .filter(
          (result): result is z.SafeParseSuccess<z.infer<T>> => result.success,
        )
        .map((result) => result.data),
    );
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

/**
 * `CalibrationFirmwareIdentityDto` — the authoritative firmware identity.
 *
 * Preserved for the calibration-context wire schema only. The candidate list
 * no longer projects firmware identity under Path D; this type is exported
 * indirectly via the context DTO so a future server that reintroduces a
 * per-printer context read (see `CALIBRATION_DISCOVERY_ROUTE_TEMPLATES` in
 * `calibrationHttp.ts`) still parses.
 */
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

/**
 * `CalibrationSlicerIdentityDto` — the authoritative slicer identity.
 *
 * Preserved for the calibration-context wire schema only; see the note on
 * {@link RemoteFirmwareIdentity}.
 */
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
 * Legacy wire shape of `CalibrationCandidateDto`.
 *
 * Retained solely because `RemoteCalibrationContextDto` extends it via
 * `.merge()`. Under Path D the candidate list is projected from
 * `RemoteCompletePrinterDto` above, and this type is not exported. Removing
 * it would break the context schema's type contract even though the
 * calibration-context route is no longer served — a follow-up that retires
 * the whole context surface can drop this and the merge with it.
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
    profilesEvaluated: z
      .boolean()
      .nullish()
      .transform((v) => v ?? null),
    printerModelId: ServerGuid.nullish().transform((v) => v ?? null),
  })
  .passthrough();

/**
 * Wire shape of `CompletePrinterDto` exactly as `GET /api/printers` serialises
 * it (`OlyForge3D/PrintFarmer:src/infra/Dtos/CompletePrinterDto.cs` on
 * `origin/development`).
 *
 * This replaces the earlier `RemoteCalibrationCandidateDto`, which projected
 * `GET /api/printers/calibration-candidates` — a route that was removed by
 * OlyForge3D/PrintFarmer#1943 together with the `IsExplicitlyEligible` gate.
 * Under Path D there is no server-side eligibility screen: every printer is a
 * candidate, and the plain printers list is the only surviving discovery
 * source. Fields the desktop no longer projects (firmware/slicer identities,
 * `eligible`, `rejectionReasons`, `missingInputs`, `profilesEvaluated`) are
 * simply absent on this DTO and correspondingly absent here.
 *
 * Only `id` and `name` are strictly required: the server always populates them
 * and a candidate without an identity cannot be selected. Every remaining
 * member is defaulted the way the server's own DTO defaults it, so an older or
 * newer deployment omitting an optional member degrades that member rather
 * than discarding the printer. `.passthrough()` keeps the many unread
 * `CompletePrinterDto` members (bed/hotend telemetry, spool info, URLs, job
 * state) from being stripped when the schema is used to project the response.
 */
const RemoteCompletePrinterDto = z
  .object({
    id: ServerGuid,
    name: z.string().min(1).max(256),
    /**
     * `PrinterModel` display name. The `nullish` guard is intentional: it lets
     * a legacy deployment omit the field entirely, degrading to "model
     * unknown" rather than failing the whole record.
     */
    modelName: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    /**
     * Catalog `PrinterModel` GUID. Present directly on `CompletePrinterDto`,
     * so no per-record `/details` enrichment is needed on the new route: the
     * primary list already carries the id the renderer's cascading profile
     * picker needs. `null` still means "model unknown, permissive fallback" —
     * see the renderer's `profileSelection.ts` for the null-branch rationale.
     */
    modelId: ServerGuid.nullish().transform((v) => v ?? null),
    isEnabled: z
      .boolean()
      .nullish()
      .transform((v) => v ?? true),
    inMaintenance: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    isOnline: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
  })
  .passthrough();

/** Engine/distribution this client negotiates; mirrors the server constants. */
export const CALIBRATION_SLICER_ENGINE = 'OrcaSlicer';
export const CALIBRATION_SLICER_DISTRIBUTION = 'upstream';

/**
 * A candidate normalised into the shape the rest of the desktop app consumes.
 *
 * Under Path D there is no server-side eligibility screen: `GET /api/printers`
 * returns every configured printer, and every printer is a valid selection.
 * This projection therefore carries only the five fields the wizards read —
 * identity, model, and reachability — plus the two enabled/maintenance flags
 * used to filter unusable printers out of the list before it reaches the
 * renderer. It deliberately does *not* carry:
 *
 * - `firmwareCompatible` / `eligibility` — removed with the eligibility gate.
 * - `orcaProfileId` — the candidate list never carried profile identity; that
 *   still lives on the context snapshot.
 * - `updatedAt` — `CompletePrinterDto` does not expose an observation time.
 * - `rejectionReasons` / `missingInputs` / `serverIncoherence` — there is no
 *   refusal to explain; the server has already accepted every returned row.
 *
 * `configurationRevision` is kept as `null` so the selection cache and the
 * context handler still typecheck against this shape. Under Path D the
 * per-printer `calibration-context` endpoint has been removed alongside the
 * candidates route, so the downstream context load will fail as its own
 * defect; a `null` revision here simply means "no revision was ever exposed
 * to this client".
 */
export const RemoteCalibrationPrinterCandidate =
  RemoteCompletePrinterDto.transform((dto) => ({
    printerId: dto.id,
    displayName: dto.name,
    /** Marketing model string, or `null` when the deployment omits it. */
    printerModel: dto.modelName,
    /**
     * Catalog printer-model Guid, propagated straight from the wire. `null`
     * when the deployment omits the field; the renderer's applicability filter
     * treats `null` as "model unknown, permissive fallback".
     */
    printerModelId: dto.modelId,
    isOnline: dto.isOnline,
    /**
     * Enabled/maintenance surface the handler uses to exclude retired hardware
     * before projecting into the renderer-facing `CalibrationPrinterCandidate`.
     */
    isEnabled: dto.isEnabled,
    inMaintenance: dto.inMaintenance,
    /**
     * The candidate list under Path D carries no configuration revision. Kept
     * as `null` so the selection cache and the context handler still
     * typecheck; a downstream context read that requires one will fail on the
     * same code path an older empty revision took.
     */
    configurationRevision: null as number | null,
  }));
export type RemoteCalibrationPrinterCandidate = z.infer<
  typeof RemoteCalibrationPrinterCandidate
>;

/**
 * `GET /api/printers` returns a bare JSON array (`IEnumerable<CompletePrinterDto>`).
 * The enveloped form is retained only so a proxy that wraps the payload is
 * still understood.
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
/**
 * The farm, assembled candidate by candidate so no single record can empty it.
 *
 * This is the general form of a defect this contract has now met five times in
 * different clothes: an over-long code, a code list one past its cap, a missing
 * -input list a legitimate five-toolhead printer exceeds, a farm larger than
 * the IPC bound. Each was fixed where it was found, and each time the next
 * field over had the same shape. `z.array(candidate)` fails the *array* when
 * any element fails, and the whole `/calibration-candidates` body is parsed as
 * one value, so any hard-rejecting member anywhere in any candidate — a
 * malformed `id`, an unparseable `observedAtUtc`, a `reachability` that came
 * back as a number, a nested firmware string that ran long — discards every
 * healthy printer in the farm.
 *
 * Parsing each candidate on its own removes the class rather than the
 * instance. A record this client cannot read is dropped and counted; the
 * printers either side of it are unaffected. The count is reported so the
 * operator learns the list is incomplete instead of quietly seeing fewer
 * printers than they own, and so a server returning garbage is diagnosable
 * rather than merely invisible.
 *
 * `truncated` is derived from the raw wire length *before* the slice and is not
 * read from the payload, so a server can neither claim completeness it does not
 * have nor manufacture a truncation warning.
 */
const boundedCandidateList = z.array(z.unknown()).transform((items) => {
  const considered = items.slice(0, CALIBRATION_MAX_PRINTER_CANDIDATES);
  const printers: RemoteCalibrationPrinterCandidate[] = [];
  let unreadable = 0;

  for (const item of considered) {
    const parsed = RemoteCalibrationPrinterCandidate.safeParse(item);
    if (parsed.success) {
      printers.push(parsed.data);
    } else {
      unreadable += 1;
    }
  }

  return {
    printers,
    truncated: items.length > CALIBRATION_MAX_PRINTER_CANDIDATES,
    unreadable,
  };
});

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
    const process = snapshot?.profiles?.process ?? null;
    const exactProfileIdentity = (
      profile: typeof filament,
    ): {
      backendProfileId: string;
      orcaProfileName: string;
      profileRevision: string;
      contentHash: string;
    } | null =>
      profile !== null &&
      profile.profileRevision !== null &&
      profile.profileRevision.length > 0 &&
      profile.sha256 !== null &&
      /^[a-f0-9]{64}$/.test(profile.sha256)
        ? {
            backendProfileId: profile.id,
            orcaProfileName: profile.name,
            profileRevision: profile.profileRevision,
            contentHash: profile.sha256,
          }
        : null;
    const machineIdentity = exactProfileIdentity(machine);
    const processIdentity = exactProfileIdentity(process);
    const filamentIdentity = exactProfileIdentity(filament);
    const profileIdentities =
      machineIdentity !== null &&
      processIdentity !== null &&
      filamentIdentity !== null
        ? {
            machine: machineIdentity,
            process: processIdentity,
            filament: filamentIdentity,
          }
        : null;
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
      processProfileId: process?.id ?? null,
      processProfileName: process?.name ?? null,
      profileIdentities,
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
      /**
       * Whether the server resolved this printer's slicer profiles when it
       * produced this record.
       *
       * Carried, not dropped. The candidate DTO and the context DTO share this
       * member, and a context is only authoritative when it is exactly `true`.
       * Losing it here left the downstream completeness and binding checks with
       * nothing to test, so an explicitly ineligible context could still bind
       * purely because its identity fields happened to be populated.
       */
      profilesEvaluated: dto.profilesEvaluated,
    };
  });
export type RemoteCalibrationPrinterContext = z.infer<
  typeof RemoteCalibrationPrinterContext
>;

/**
 * Whether a context is the server's *authoritative* verdict on a printer,
 * rather than the preliminary screen the candidate list performs.
 *
 * Requires all four, and fails closed on each:
 *
 * - `profilesEvaluated === true`. Exactly true: `false` says the server did not
 *   resolve profiles, and `null` — an older build that omits the field — says
 *   nothing at all. Neither is a statement that profiles were evaluated, and
 *   reading silence as one would let the cheap candidate screen stand in for
 *   the resolution it deliberately does not perform.
 * - `eligible === true`. The server's own verdict, not re-derived here.
 * - No `missingInputs` and no `rejectionReasons`. PrintFarmer derives
 *   `Eligible` from `reasons.Count == 0`, so a record carrying both is
 *   self-contradicting and must not be treated as a clean pass.
 *
 * Candidate eligibility is deliberately *not* consulted. A candidate passing
 * basic screening is enough to list and select a printer; it is never enough to
 * bind a calibration project to one.
 */
export function isAuthoritativeCalibrationContext(
  context: RemoteCalibrationPrinterContext,
): boolean {
  return (
    context.profilesEvaluated === true &&
    context.eligible === true &&
    context.missingInputs.length === 0 &&
    context.rejectionReasons.length === 0
  );
}

export function isExplicitCalibrationEligibilityComplete(
  candidate: RemoteCalibrationPrinterCandidate,
): boolean {
  // Under Path D the server no longer projects an eligibility verdict onto
  // the candidate wire (see the block comment on
  // {@link RemoteCalibrationPrinterCandidate}). Every printer the server
  // returns from `GET /api/printers` is a valid candidate; unusable hardware
  // is filtered by `isEnabled` and `inMaintenance` before it reaches the
  // renderer. The name is kept for the profile-projection call sites below,
  // which still need a single predicate to answer "is this candidate one the
  // server accepted".
  return candidate.isEnabled && !candidate.inMaintenance;
}

/**
 * Whether a context carries every identity the calibration contract defines
 * *and* is the server's authoritative verdict.
 *
 * Scope note: this predicate answers "is this snapshot fit to bind a project
 * to", not "is it safe to print". It deliberately does **not** consult `safety`
 * or `permissions`, because `CalibrationContextDto` has no such members —
 * requiring them made the predicate unsatisfiable against every real server,
 * which silently disabled profile listing rather than gating anything.
 *
 * It does require {@link isAuthoritativeCalibrationContext}. Identity fields
 * being populated says only that the server described the printer; it says
 * nothing about whether the server was willing to calibrate it. Without this,
 * a context explicitly reporting `eligible: false` with rejection reasons could
 * still be marked current and bound, because every id it needed happened to be
 * present — the candidate list's preliminary pass standing in for a resolution
 * it never performed.
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
    isAuthoritativeCalibrationContext(context) &&
    context.configurationId !== null &&
    context.configurationRevision !== null &&
    context.snapshotId !== null &&
    context.snapshotRevision !== null &&
    context.slicerIdentity === CALIBRATION_SLICER_ENGINE &&
    context.slicerDistribution === CALIBRATION_SLICER_DISTRIBUTION &&
    context.orcaProfileId !== null &&
    context.orcaProfileName !== null &&
    context.profileRevision !== null &&
    context.profileIdentities !== null &&
    context.toolheads.length > 0
  );
}

/**
 * Why a printer contributed no bound profile, distinguished from *that* it
 * contributed none.
 *
 * `none` is an ordinary answer: the printer is offline, ineligible, its
 * context is stale or incomplete, or no single toolhead matches. `refused` is
 * a fault: a profile existed and this client would not render it, so a real
 * profile is missing from the list. Collapsing the two into `null` made the
 * fault invisible — the handler reported a complete list while a printer's
 * profile had been dropped, which is the silent loss this contract exists to
 * remove, reached through the profile rather than the candidate.
 */
export type CalibrationOrcaProfileProjection =
  | { readonly kind: 'none' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'entry'; readonly entry: OrcaProfileEntry };

export function projectPrintFarmerOrcaProfileResult(
  candidate: RemoteCalibrationPrinterCandidate,
  context: RemoteCalibrationPrinterContext,
): CalibrationOrcaProfileProjection {
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
    return { kind: 'none' };
  }
  const matchingToolheads = context.toolheads.filter(
    (toolhead) => toolhead.nozzle.diameterMm === context.nozzleDiameterMm,
  );
  if (matchingToolheads.length !== 1) {
    return { kind: 'none' };
  }
  const toolhead = matchingToolheads[0]!;
  // `safeParse` rather than a throwing `.parse`: a bare throw here escaped the
  // per-printer catch in the profiles handler, rejected the `Promise.all` it
  // ran inside, and took the whole response with it — including the local
  // OrcaSlicer scan that the handler deliberately performs outside the server
  // path so a server fault cannot hide the profiles on this machine. The wire
  // bounds are looser than this contract in places (`profileRevision` and
  // `snapshotSha256` admit `""` upstream but are `.min(1)` here), so an empty
  // string from an ordinary serializer was enough to trigger it.
  //
  // Failure is reported as `refused`, deliberately *unlike* the conditions
  // above: those are absences, this is a profile that existed and was not
  // rendered.
  const entry = OrcaProfileEntry.safeParse({
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
  return entry.success
    ? { kind: 'entry', entry: entry.data }
    : // A profile existed and this client refused it. Reported as a fault
      // rather than as "this printer has no profile", so the handler can say
      // the list is partial instead of presenting it as complete.
      { kind: 'refused' };
}

/**
 * The entry-or-nothing view of {@link projectPrintFarmerOrcaProfileResult}.
 *
 * Retained for the tests that assert projection in isolation, where a refusal
 * and an absence really are the same outcome. Production code uses the
 * discriminated form: it has to tell an operator *why* a profile is missing,
 * and this shape cannot.
 */
export function projectPrintFarmerOrcaProfile(
  candidate: RemoteCalibrationPrinterCandidate,
  context: RemoteCalibrationPrinterContext,
): OrcaProfileEntry | null {
  const result = projectPrintFarmerOrcaProfileResult(candidate, context);
  return result.kind === 'entry' ? result.entry : null;
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
    /**
     * Whether this is the server's authoritative verdict.
     *
     * Surfaced separately from `isCurrent` so the renderer can say *why* a
     * loaded context cannot be bound: "the snapshot moved on" and "the server
     * has not evaluated this printer's profiles" are different problems with
     * different remedies, and collapsing them into one boolean left the
     * operator with no way to tell which they were looking at.
     */
    evaluationScope: isAuthoritativeCalibrationContext(context)
      ? 'full'
      : 'preliminary',
    configurationId: context.configurationId,
    configurationRevision: context.configurationRevision,
    snapshotId: context.snapshotId,
    snapshotRevision: context.snapshotRevision,
    slicerIdentity:
      context.slicerIdentity === 'OrcaSlicer' ? 'OrcaSlicer' : null,
    slicerDistribution:
      context.slicerDistribution === 'upstream' ? 'upstream' : null,
    profileRevision: context.profileRevision,
    profileIdentities: context.profileIdentities,
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
    // The server's own account of the refusal, carried through so the wizard
    // can read it out. Only meaningful on a context it refused: an
    // authoritative one has, by the server's own `Eligible = reasons.Count == 0`
    // rule, nothing to explain.
    rejectionReasonCodes: contextRefusalCodes(context),
    missingInputs: context.missingInputs
      .slice(0, CALIBRATION_MAX_SERVER_REJECTION_REASONS)
      .map(normalizeCalibrationMissingInput),
  });
}

/**
 * The reason codes to hand the renderer for a context, cut to what it carries.
 *
 * Truncation is declared rather than silent, for the reason it is declared on
 * the candidate list: a printer whose every toolhead is incompletely described
 * can legitimately exceed the cap, and showing the first sixty-four reasons as
 * though they were all of them would misrepresent how much is left to do.
 */
function contextRefusalCodes(
  context: RemoteCalibrationPrinterContext,
): string[] {
  const codes = context.rejectionReasons
    .slice(0, CALIBRATION_MAX_SERVER_REJECTION_REASONS)
    .map((reason) => normalizeCalibrationReasonCode(reason.code));
  if (
    context.rejectionReasons.length >
      CALIBRATION_MAX_SERVER_REJECTION_REASONS ||
    context.missingInputs.length > CALIBRATION_MAX_SERVER_REJECTION_REASONS
  ) {
    codes.push(CALIBRATION_EXPLANATION_TRUNCATED_CODE);
  }
  return codes;
}

export function doesCalibrationWorkspaceMatchContext(
  request: CalibrationSaveWorkspaceStateRequest,
  context: RemoteCalibrationPrinterContext,
): boolean {
  return doesCalibrationWorkspacePayloadMatchContext(
    request.workspaceState,
    context,
  );
}

export function doesCalibrationWorkspacePayloadMatchContext(
  workspaceState: CalibrationSaveWorkspaceStateRequest['workspaceState'],
  context: RemoteCalibrationPrinterContext,
): boolean {
  if (!context.isCurrent || !isExplicitCalibrationContextComplete(context)) {
    return false;
  }
  const binding = workspaceState.domainState.binding;
  const printer = binding.printer;
  const snapshot = binding.snapshot;
  const selectedProfile = workspaceState.selectedBaseProfile;
  const boundProfileIdentities = binding.profileIdentities;
  const remoteProfileIdentities = context.profileIdentities;
  const profileIdentitiesMatch =
    boundProfileIdentities !== undefined &&
    remoteProfileIdentities !== null &&
    (['machine', 'process', 'filament'] as const).every((kind) => {
      const bound = boundProfileIdentities[kind];
      const remote = remoteProfileIdentities[kind];
      return (
        bound.backendProfileId === remote.backendProfileId &&
        bound.orcaProfileName === remote.orcaProfileName &&
        bound.profileRevision === remote.profileRevision &&
        bound.contentHash === remote.contentHash
      );
    });
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
  // all printers. When the server does supply the block, every server-owned
  // field is still compared exactly.
  //
  // The three interlock booleans (`emergencyStopAvailable`,
  // `thermalProtectionConfirmed`, `ventilationAssessed`) are **operator-owned**
  // in the workspace binding: they carry the wizard's checkbox attestations,
  // which no server field mirrors. They are deliberately not compared here,
  // because comparing an operator attestation against the wire's hardcoded
  // `false` default is not drift — it is the difference between "the operator
  // said so" and "the server never mentioned it", and reporting that as drift
  // permanently invalidated every workspace against every context.
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
        snapshot.safety.maximumVolumetricRateMm3S);
  return (
    context.printerId === printer.backendPrinterId &&
    context.configurationId === printer.printerConfigurationId &&
    context.configurationRevision === printer.printerConfigurationRevision &&
    context.snapshotId === snapshot.snapshotId &&
    context.snapshotRevision === snapshot.snapshotRevision &&
    context.snapshotAt === snapshot.capturedAt &&
    context.configurationRevision === snapshot.configurationRevision &&
    profileIdentitiesMatch &&
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
 * Nested `operatorFeatures` block on `PlatformCapabilitiesDto`. Fields the
 * calibration client cares about are declared explicitly; everything else
 * passes through so this schema does not reject future features.
 *
 * Only `offlineWriteReplayEnabled` is load-bearing for calibration today: it
 * is the *nested* backing field for the desktop's `calibrationOfflineDraftEnabled`
 * gate. A flat lookup will miss it. Kept here rather than inlined so the raw
 * source-of-truth field name stays a single-source constant.
 */
const RemoteOperatorFeatureFlags = z
  .object({
    offlineWriteReplayEnabled: AdvertisedFlagRaw,
  })
  .passthrough();

/**
 * A raw-side field key on `PlatformCapabilitiesDto`, either flat (a top-level
 * property) or nested (a dotted path into a nested object). Kept as a string
 * both for readability in diagnostics and so the split-deployment tests can
 * use it as their diff key. See `readFlagBackingField` for the resolver.
 */
type RemoteCalibrationFlagSourcePath =
  | 'calibrationPersistenceEnabled'
  | 'calibrationSyncEnabled'
  | 'calibrationPhotosEnabled'
  | 'calibrationSlicingEnabled'
  | 'calibrationArtifactPromotionEnabled'
  | 'operatorFeatures.offlineWriteReplayEnabled';

/**
 * Maps each end-to-end calibration capability flag to the raw
 * `PlatformCapabilitiesDto` field that backs it.
 *
 * This is the single production source of truth for "what capability flags
 * exist" (#493 AC1): both the `flags`/`flagAdvertisement` reduction below and
 * the split-deployment test suite read the flag names from here, so a flag
 * added to this map is automatically covered by the test — nothing needs to
 * be hand-copied into `tests/`.
 *
 * Semantic mapping (verified against the server sources pinned by
 * `tests/fixtures/server-contract/platformCapabilitiesDto.snapshot.ts` at
 * PrintFarmer `678d3398934537ff6ee4528c2e51aaa4a244d37f`):
 *
 * - `calibrationApiEnabled`         ← `calibrationPersistenceEnabled`
 *   ("calibration API persistence is up"). Live value: `true`.
 *
 * - `calibrationChangeFeedEnabled`  ← `calibrationSyncEnabled`
 *   The server's `CalibrationSyncEnabled` field is the change-feed/sync
 *   path — that is exactly what the DTO XML doc at
 *   `PlatformCapabilitiesDto.cs:47-48` states. `CalibrationEventsEnabled`
 *   (`:71-72`) is a distinct future event-streaming subsystem, hardcoded
 *   `false` in `CalibrationCapabilityService.cs:203-205` and documented
 *   `false` in `docs/API.md:108-110`; do NOT bind the change-feed flag to
 *   it. Live value: `true`.
 *
 * - `calibrationOfflineDraftEnabled` ← `calibrationSyncEnabled`
 *   Offline draft replay is the *client side* of the same sync/change-feed
 *   subsystem: if sync is up the client can push offline drafts through it.
 *   Both flags therefore share one server switch by design — there is no
 *   server state where sync is down but offline draft replay is possible.
 *   `operatorFeatures.offlineWriteReplayEnabled` is a related but separate
 *   *operator*-facing capability toggle (declared and readable via
 *   `readFlagBackingField` below), not the sync switch, and it is not
 *   load-bearing for this gate. Live value: `true`.
 *
 * - `calibrationGenerationEnabled`   ← `calibrationSlicingEnabled`
 *   The desktop flag keeps its name — it answers a *desktop* question ("can
 *   this server produce calibration G-code and profile patches?") — but its
 *   backing field changed. The server's `CalibrationGenerationEnabled` was
 *   DELETED by PrintFarmer 7169f1d32 (#1995) when the generator subsystem
 *   `Farm.Web.Api.Services.Calibration.Generation` was removed by D2/#1979.
 *   Server-orchestrated filament calibration replaced it, and its switch is
 *   `CalibrationSlicingEnabled`.
 *
 *   Binding here is deliberate and load-bearing: the service computes
 *   `CalibrationSlicingEnabled = calibrationSlicingOperational`, so it tracks
 *   real deployment state. It is NOT one of the hardcoded-false fields
 *   (`CalibrationQueueEnabled`, `CalibrationJobBoundBedClearEnabled`,
 *   `CalibrationEventsEnabled`) — binding to one of those would refuse
 *   generation on every deployment forever. See note 2 in the DTO snapshot.
 *
 * - `calibrationArtifactPromotionEnabled` ← `CalibrationArtifactPromotionEnabled`
 *   A *separate* server switch from `calibrationSlicingEnabled`: slicing being
 *   operational only means a slicing fleet can produce G-code/profile
 *   artifacts; promotion is the distinct step of accepting a produced
 *   artifact as the deployment's new profile. A deployment can have slicing
 *   up and promotion down (e.g. an unhealthy promotion checkpoint store or
 *   reconciler), in which case `generate` may still succeed while applying
 *   the resulting patch must not be offered as though it will succeed.
 *   Direct 1:1 binding — the desktop flag keeps the server's name because
 *   there is no distinct desktop-side question to ask.
 *
 * `readFlagBackingField` handles both flat and nested paths so future flags
 * whose backing wire field lives inside a nested block (e.g. `operatorFeatures`)
 * can be added without changing the resolver. A flat-only resolver is blind
 * to nested values in a way that is invisible in tests — see Hicks's
 * `calibration.capabilityFlagMapping.test.ts` for the proof.
 */
export const CALIBRATION_FLAG_SOURCES = {
  calibrationApiEnabled: 'calibrationPersistenceEnabled',
  calibrationChangeFeedEnabled: 'calibrationSyncEnabled',
  calibrationOfflineDraftEnabled: 'calibrationSyncEnabled',
  calibrationPhotoUploadEnabled: 'calibrationPhotosEnabled',
  calibrationGenerationEnabled: 'calibrationSlicingEnabled',
  calibrationArtifactPromotionEnabled: 'calibrationArtifactPromotionEnabled',
} as const satisfies Record<string, RemoteCalibrationFlagSourcePath>;

/** Name of one of the negotiated end-to-end calibration capability flags. */
export type CalibrationFlagName = keyof typeof CALIBRATION_FLAG_SOURCES;

/**
 * Reads a flag's backing value out of the parsed platform capabilities DTO.
 * Handles both flat (`calibrationContextEnabled`) and nested
 * (`operatorFeatures.offlineWriteReplayEnabled`) source paths uniformly, so
 * callers do not have to special-case the nested one and get it wrong.
 *
 * Returns `undefined` when the backing field was absent from the response,
 * which the caller distinguishes from an explicit `false` for `flagAdvertisement`.
 */
function readFlagBackingField(
  dto: Record<string, unknown>,
  path: RemoteCalibrationFlagSourcePath,
): boolean | undefined {
  const segments = path.split('.');
  let cursor: unknown = dto;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return typeof cursor === 'boolean' ? cursor : undefined;
}

/**
 * Set (mutate) the backing field for a calibration flag on a raw response
 * body. Used by tests to simulate a server that turns a specific capability
 * on or off without needing to know whether the field is flat or nested.
 *
 * Exposed here rather than inlined in tests so the flat-vs-nested topology
 * of the wire is owned by one file — the production consumer — and the
 * tests cannot silently drift toward writing the wrong shape.
 */
export function setCalibrationFlagBackingField(
  body: Record<string, unknown>,
  flag: CalibrationFlagName,
  value: boolean,
): void {
  const path = CALIBRATION_FLAG_SOURCES[flag];
  const segments = path.split('.');
  const leaf = segments.pop();
  if (leaf === undefined) return;
  let cursor: Record<string, unknown> = body;
  for (const seg of segments) {
    const next = cursor[seg];
    if (next === null || typeof next !== 'object') {
      const nested: Record<string, unknown> = {};
      cursor[seg] = nested;
      cursor = nested;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[leaf] = value;
}

/** Remove the backing field so it is absent from the response. */
export function unsetCalibrationFlagBackingField(
  body: Record<string, unknown>,
  flag: CalibrationFlagName,
): void {
  const path = CALIBRATION_FLAG_SOURCES[flag];
  const segments = path.split('.');
  const leaf = segments.pop();
  if (leaf === undefined) return;
  let cursor: Record<string, unknown> = body;
  for (const seg of segments) {
    const next = cursor[seg];
    if (next === null || typeof next !== 'object') return;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[leaf];
}

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
    /**
     * The calibration context API is up. Declared here for schema-strict
     * parsing and diagnostics (`calibrationContextEnabled`/`contextImplemented`
     * are what a rollout runbook reads to plan Stage 2/3). Not the
     * load-bearing bit for `calibrationApiEnabled` — that binds to
     * `calibrationPersistenceEnabled` below; see `CALIBRATION_FLAG_SOURCES`.
     */
    calibrationContextEnabled: AdvertisedFlagRaw,
    /**
     * Calibration project persistence is implemented and enabled. **Load-bearing**
     * for `calibrationApiEnabled` — see `CALIBRATION_FLAG_SOURCES`.
     */
    calibrationPersistenceEnabled: AdvertisedFlagRaw,
    /**
     * Calibration sync / change-feed path. **Load-bearing** for both
     * `calibrationChangeFeedEnabled` and `calibrationOfflineDraftEnabled`
     * — see `CALIBRATION_FLAG_SOURCES` for why they share this switch.
     */
    calibrationSyncEnabled: AdvertisedFlagRaw,
    /**
     * A distinct, unimplemented future event-streaming subsystem. The server
     * hardcodes this `false` today (`CalibrationCapabilityService.cs:203-205`,
     * documented in `docs/API.md:108-110` and DTO XML at
     * `PlatformCapabilitiesDto.cs:71-72`); it is **not** the change-feed
     * switch, which is `calibrationSyncEnabled` above. Declared here so
     * a truthy value in a future server build is not silently dropped by
     * `.passthrough()`.
     */
    calibrationEventsEnabled: AdvertisedFlagRaw,
    /** Calibration photo capture and upload. */
    calibrationPhotosEnabled: AdvertisedFlagRaw,
    /**
     * Server-orchestrated calibration slicing. **Load-bearing** for the
     * desktop's `calibrationGenerationEnabled` flag — see
     * `CALIBRATION_FLAG_SOURCES` for why the desktop flag kept its name while
     * its backing field moved here.
     *
     * The server's own `calibrationGenerationEnabled` was deleted with the
     * generator subsystem (PrintFarmer 7169f1d32 / #1995, D2/#1979) and is
     * intentionally NOT declared here.
     */
    calibrationSlicingEnabled: AdvertisedFlagRaw,
    /**
     * A distinct server switch from `calibrationSlicingEnabled` covering
     * promotion of a produced artifact into the deployment's active profile.
     * **Load-bearing** for the desktop's `calibrationArtifactPromotionEnabled`
     * flag — see `CALIBRATION_FLAG_SOURCES`. A deployment can have slicing
     * operational while promotion is unavailable (e.g. an unhealthy
     * checkpoint store or reconciler), so `applyPatch` must not be gated on
     * `calibrationSlicingEnabled` alone.
     */
    calibrationArtifactPromotionEnabled: AdvertisedFlagRaw,
    /**
     * Nested operator-features block. `offlineWriteReplayEnabled` is a real
     * capability field the server advertises, readable via
     * `readFlagBackingField(dto, 'operatorFeatures.offlineWriteReplayEnabled')`.
     * It is **not** the load-bearing bit for `calibrationOfflineDraftEnabled`
     * today — that binds to `calibrationSyncEnabled` — but is declared here
     * so nested-path parsing is exercised on every negotiation and so a
     * future flag whose backing field lives inside a nested block can be
     * added without changing the resolver.
     */
    operatorFeatures: RemoteOperatorFeatureFlags.optional().default({}),
    /**
     * Server-reported diagnostics for capabilities the deployment is
     * currently unable to offer. Preserved verbatim onto the negotiated
     * shape so the availability handler can surface them to the operator
     * rather than flattening the refusal into a single opaque boolean.
     */
    unavailableReasons: z
      .array(
        z
          .object({
            feature: z.string().max(128),
            code: z.string().max(128),
            message: z.string().max(1024),
          })
          .passthrough(),
      )
      .max(64)
      .optional()
      .default([]),
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
    /**
     * Raw DTO passed to `readFlagBackingField` untouched so nested paths
     * (`operatorFeatures.offlineWriteReplayEnabled`) resolve correctly.
     * Zod's `.default` fills the operator-features block with `{}` when the
     * server omits it, which is what the "unknown → false" fail-closed
     * behaviour needs — a missing nested block reads every leaf as absent,
     * exactly the same as a top-level absent boolean.
     */
    const rawDto = value as unknown as Record<string, unknown>;
    const flags = {} as Record<CalibrationFlagName, boolean>;
    const flagAdvertisement = {} as Record<
      CalibrationFlagName,
      CalibrationFlagAdvertisement
    >;
    for (const [flagName, sourcePath] of Object.entries(
      CALIBRATION_FLAG_SOURCES,
    ) as [CalibrationFlagName, RemoteCalibrationFlagSourcePath][]) {
      const raw = readFlagBackingField(rawDto, sourcePath);
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
       * Absent server fields fail closed to `false` here — see
       * `flagAdvertisement` for whether that `false` was advertised or
       * merely not observed.
       */
      flags,
      /**
       * Per-flag advertisement state: whether the server said `true`,
       * explicitly said `false`, or said nothing at all (`'unknown'`). Added
       * for #493 — `flags` alone cannot prove a capability's unavailability
       * was actually reported by the server rather than defaulted.
       */
      flagAdvertisement,
      /**
       * Server-provided diagnostics for capabilities the deployment cannot
       * currently offer, projected verbatim. Empty when the server did not
       * name any refusal reason. Surfaced through the IPC availability
       * response so the renderer can explain a `missingCapabilityFlags` or
       * a disabled `calibrationGenerationEnabled` in the operator's own
       * words rather than a bare boolean.
       */
      unavailableReasons: value.unavailableReasons,
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
 * only adds evidence attachments, `calibrationGeneration` requires an entire
 * slicing fleet server-side (an online worker attesting a pinned upstream
 * OrcaSlicer build), and `calibrationArtifactPromotion` additionally requires
 * a healthy promotion checkpoint store and reconciler — a deployment can have
 * slicing operational while promotion is not. Recording measured results by
 * hand stays fully usable in all cases, so these are surfaced to the
 * renderer through `capabilityFlags` and gate their own actions instead of
 * blocking the tab.
 */
export const OPTIONAL_CALIBRATION_FEATURE_FLAGS = [
  'calibrationPhotoUploadEnabled',
  'calibrationGenerationEnabled',
  'calibrationArtifactPromotionEnabled',
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

/**
 * `CalibrationFilamentIdentityDto` — nested filament identity on the real
 * `POST /api/calibration-projects` response. Verified against PrintFarmer's
 * `Farm.Modules.Calibration/Contracts/CalibrationProjectContracts.cs` at
 * commit `0720b9d146256c69fa2780c029ab5982bba509a1`
 * (blob `48353af39c7f6b4d9d5e0062254e5fa648860e39`); see
 * `tests/fixtures/server-contract/calibrationProjectContracts.snapshot.ts`.
 */
export const RemoteCalibrationFilamentIdentity = z
  .object({
    provider: z.string().min(1).max(64),
    productId: z.string().min(1).max(256),
    sku: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    vendor: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    productName: z.string().min(1).max(256),
    material: z.string().min(1).max(64),
    diameter: z
      .number()
      .nullish()
      .transform((v) => v ?? null),
    color: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? null),
    filamentTypeId: ServerGuid.nullish().transform((v) => v ?? null),
    spoolmanFilamentId: ServerGuid.nullish().transform((v) => v ?? null),
    localSpoolId: ServerGuid.nullish().transform((v) => v ?? null),
    spoolmanSpoolId: ServerGuid.nullish().transform((v) => v ?? null),
    snapshot: z.unknown(),
  })
  .passthrough();
export type RemoteCalibrationFilamentIdentity = z.infer<
  typeof RemoteCalibrationFilamentIdentity
>;

/**
 * `CalibrationProjectDto` — the real response body of
 * `POST /api/calibration-projects` (`CalibrationProjectsController
 * .CreateProjectAsync`, verified at the commit/blob cited above).
 *
 * Deliberately NOT {@link RemoteCalibrationProject} above: that schema's
 * fields (`displayName`/`status`/`printerSnapshot`/`concurrencyToken`/
 * `workspaceState`/`createdAt`/`updatedAt`) do not exist anywhere on the
 * real DTO — a pre-existing drift between this desktop's `getProject()` and
 * the live server, out of scope for the issue that added this schema
 * (#798). This schema instead mirrors the verified shape exactly, field for
 * field, so a create-project response that no longer matches the real DTO
 * fails loudly here instead of silently wearing the wrong shape.
 */
export const RemoteCalibrationProjectRecord = z
  .object({
    id: ServerGuid,
    name: z.string().min(1).max(200),
    lifecycleStatus: z.string().min(1).max(64),
    experienceMode: z.string().min(1).max(32),
    printerId: ServerGuid,
    selectedToolheadId: ServerGuid.nullish().transform((v) => v ?? null),
    selectedToolheadIndex: z
      .number()
      .int()
      .nullish()
      .transform((v) => v ?? null),
    filament: RemoteCalibrationFilamentIdentity,
    orderedSteps: z.unknown(),
    currentStep: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    currentSelections: z.unknown(),
    revision: z.number().int().nonnegative(),
    createdAtUtc: z.string().datetime(),
    updatedAtUtc: z.string().datetime(),
    completedAtUtc: z
      .string()
      .datetime()
      .nullish()
      .transform((v) => v ?? null),
    deletedAtUtc: z
      .string()
      .datetime()
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteCalibrationProjectRecord = z.infer<
  typeof RemoteCalibrationProjectRecord
>;

/**
 * One Spoolman spool, as PrintFarmer's server mirrors it (issue #805). Both
 * IDs are PrintFarmer-side Guids — the same shape `CalibrationFilamentIdentityDto`
 * already uses for `spoolmanSpoolId`/`spoolmanFilamentId` above — not
 * Spoolman's own numeric IDs. Field names are the desktop's own projection
 * (not verified against a live server DTO, since no such route has landed
 * yet); `.passthrough()` and defensive `.nullish()` coercions keep this
 * resilient to additional/renamed fields on the real server response.
 */
export const RemoteCalibrationSpoolmanSpool = z
  .object({
    spoolmanSpoolId: ServerGuid,
    spoolmanFilamentId: ServerGuid.nullish().transform((v) => v ?? null),
    displayName: z.string().min(1).max(256),
    material: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? null),
    color: z
      .string()
      .max(64)
      .nullish()
      .transform((v) => v ?? null),
    vendor: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
    remainingWeightGrams: z
      .number()
      .nonnegative()
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteCalibrationSpoolmanSpool = z.infer<
  typeof RemoteCalibrationSpoolmanSpool
>;

/**
 * `GET` list-of-spools response. Accepts both `{ spools: [...] }` and a bare
 * array, matching `RemoteCustomProfilesList`'s tolerance below for the same
 * reason: different server builds have serialized either shape. Uses
 * {@link filteredWireList} rather than the object-field default so one
 * malformed spool (missing its Guid, an over-long label) is dropped from the
 * picker instead of blanking every healthy spool on the same printer.
 */
export const RemoteCalibrationSpoolmanSpoolsList = z
  .union([
    z
      .object({
        spools: filteredWireList(RemoteCalibrationSpoolmanSpool),
      })
      .passthrough(),
    filteredWireList(RemoteCalibrationSpoolmanSpool).transform((spools) => ({
      spools,
    })),
  ])
  .transform((v) => ({
    spools: v.spools,
  }));
export type RemoteCalibrationSpoolmanSpoolsList = z.infer<
  typeof RemoteCalibrationSpoolmanSpoolsList
>;

/**
 * `CalibrationSetupInputDto` — nested on `CalibrationMethodGuidanceDto` from
 * `GET /api/calibration-projects/method-guidance` (issue #797 / PrintFarmer#2180 gap 3/4).
 * Verified against `Farm.Modules.Calibration/Contracts/CalibrationProjectContracts.cs` at
 * PrintFarmer commit `b6a754c989e76edd71891e632bd940f1a81f3918` (contracts blob
 * `e769d4a678ac950e53953a1f6c8eabbb3b7ca80e`).
 */
export const RemoteCalibrationSetupInput = z
  .object({
    key: z.string().min(1).max(128),
    label: z.string().min(1).max(256),
    unit: z.string().max(32),
    minimum: z.number(),
    maximum: z.number(),
  })
  .passthrough();
export type RemoteCalibrationSetupInput = z.infer<
  typeof RemoteCalibrationSetupInput
>;

/**
 * `CalibrationMeasureQuantityDto` — nested on `CalibrationMethodGuidanceDto`, verified at the
 * same commit/blob cited above.
 */
export const RemoteCalibrationMeasureQuantity = z
  .object({
    key: z.string().min(1).max(128),
    minimum: z.number(),
    maximum: z.number(),
  })
  .passthrough();
export type RemoteCalibrationMeasureQuantity = z.infer<
  typeof RemoteCalibrationMeasureQuantity
>;

/**
 * `CalibrationMethodGuidanceDto[]` — the real response body of
 * `GET /api/calibration-projects/method-guidance`
 * (`CalibrationProjectsController.GetMethodGuidanceCatalog`), verified at the commit/blob
 * cited above. Server-owned, per-method display title, purpose, wiki reference, required
 * `setup` inputs, expected `measure` quantity, and canonical step sequence — the
 * server-authoritative replacement for this desktop's client-hardcoded `FILAMENT_METHOD_META`
 * stand-in (issue #797).
 */
export const RemoteCalibrationMethodGuidance = z
  .object({
    method: z.string().min(1).max(128),
    title: z.string().min(1).max(256),
    purpose: z.string().min(1).max(4096),
    wikiUrl: z.string().max(2048),
    setupInputs: z.array(RemoteCalibrationSetupInput).max(16),
    measureQuantity: RemoteCalibrationMeasureQuantity.nullish().transform(
      (v) => v ?? null,
    ),
    steps: z.array(z.string().min(1).max(64)).max(16),
  })
  .passthrough();
export type RemoteCalibrationMethodGuidance = z.infer<
  typeof RemoteCalibrationMethodGuidance
>;

/**
 * `CalibrationMethodProgressDto` — the real response body of both
 * `GET /api/calibration-projects/{id}/method-progress` (array) and
 * `PUT /api/calibration-projects/{id}/method-progress/{method}` (single object), verified at
 * the commit/blob cited above. Project-owned (not device-scoped) disposition tracking for one
 * calibration method (issue #797 / PrintFarmer#2180 gap 2): a `Skipped` method is
 * distinguishable from a `Pending` one and neither blocks project completion. `Completed` is
 * only ever derived server-side from an accepted selection observation — it is never
 * client-settable (enforced by `CalibrationProjectService.SetMethodDispositionAsync`, which
 * rejects a client-submitted `Completed` with `method_disposition_invalid`).
 */
export const RemoteCalibrationMethodProgress = z
  .object({
    id: ServerGuid,
    projectId: ServerGuid,
    method: z.string().min(1).max(128),
    disposition: z.enum(['Pending', 'Skipped', 'Completed']),
    currentStepId: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    revision: z.number().int().nonnegative(),
    createdAtUtc: z.string().datetime(),
    updatedAtUtc: z.string().datetime(),
  })
  .passthrough();
export type RemoteCalibrationMethodProgress = z.infer<
  typeof RemoteCalibrationMethodProgress
>;

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
    /**
     * `{ "error": "code_string", "detail": "…" }` envelope emitted by
     * `JobQueueController` and other non-Problem-serialising controllers.
     * Live wire capture 2026-08-21: the 428 `precondition_required` and 404
     * `job_not_found` bodies use this key, not `code`/`errorCode`. Missing it
     * silently discarded every acknowledge-bed-clear refusal on the wire.
     *
     * Bounded at 256, twice the 64-char bound on `errorCode`/`code` above,
     * because it doubles as a free-form fallback for servers that have no
     * machine code at all (see the `readJobErrorEnvelope` counterpart in
     * `calibrationHttp.ts`). The wider raw bound here is fine on its own —
     * the 64-char contract is enforced downstream, in the `.transform` below,
     * not on this field.
     */
    error: z.string().max(256).optional(),
  })
  .passthrough()
  .transform((value) => ({
    ...value,
    // Prefer the documented extension, fall back through the observed
    // vocabulary so a deployment emitting any of the three is understood.
    //
    // Clipped to 64 chars here (issue #743): `errorCode` and `code` are each
    // already bounded to 64 above, but `error` is bounded to 256, so a server
    // that omits both and only sends a 65-256-char `error` would otherwise
    // hand a too-long value to `CalibrationHttpError.serverErrorCode` ->
    // `CalibrationApiError.blockedReasonCode` (bounded 64 in
    // `src/shared/ipc.ts`), which throws at IPC serialization rather than
    // failing closed. This is the one place that 64-char contract is actually
    // enforced for the coalesced result; see the docblocks on
    // `serverErrorCode` in `calibrationHttp.ts` and on `blockedReasonCode` in
    // `src/shared/ipc.ts`, which both point back here.
    errorCode: (value.errorCode ?? value.code ?? value.error)?.slice(0, 64),
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
    calibrationOrchestrationId: ServerGuid.nullish().transform(
      (v) => v ?? null,
    ),
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
    bedClearCommandId: ServerGuid.nullish().transform((v) => v ?? null),
    bedClearIdempotencyKeySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullish()
      .transform((v) => v ?? null),
    bedClearExpiresAtUtc: ServerInstant.nullish().transform((v) => v ?? null),
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

// --- Slicer profile selection (machine → process → filament cascade) -------
//
// These schemas mirror the PrintFarmer server DTOs that back the profile
// listing endpoints. The wire is name-keyed for system profiles (there is no
// `Id` on the worker DTOs) and Guid-keyed for custom (database-owned)
// profiles. Guids for system profiles are obtained from
// `GET /api/slicer/profiles/extended` (the DB-backed row list).
//
// Verbatim citations (OlyForge3D/PrintFarmer @ b0a021000639d5ef69c818c89877520793d9f9e8):
//   - MachineProfileDto:      src/slicer/Farm.Slicer.Module/Dtos/MachineProfileDto.cs:12-102
//   - ProcessProfileDto:      src/slicer/Farm.Slicer.Module/Dtos/ProcessProfileDto.cs:12-120
//   - FilamentProfileDto:     src/slicer/Farm.Slicer.Module/Dtos/FilamentProfileDto.cs:12-95
//   - CustomProfile:          src/Web/ReactApp/src/services/slicerProfilesService.ts:229-269
//   - Extended list:          src/slicer/Farm.Slicer.Module.Api/Controllers/Slicing/ProfilesController.cs:144-158

/** Length ceiling for a single profile name string. Name is identity for system profiles. */
const MAX_PROFILE_NAME_LEN = 512;

/**
 * `MachineProfileDto` — the OrcaSlicer worker's authoritative machine profile.
 * No `Id`. `Name` is identity; every other field is display / applicability
 * metadata and is defaulted the way the C# DTO defaults it so an older or
 * newer server that omits a member degrades that member rather than dropping
 * the whole record.
 */
export const RemoteMachineProfile = z
  .object({
    name: z.string().min(1).max(MAX_PROFILE_NAME_LEN),
    manufacturer: z
      .string()
      .max(MAX_PROFILE_NAME_LEN)
      .nullish()
      .transform((v) => v ?? ''),
    description: z
      .string()
      .max(4096)
      .nullish()
      .transform((v) => v ?? null),
    // `printer_model` in JSON per [JsonPropertyName("printer_model")]; the
    // desktop consumes it as `printerModel`. The server serializes both cases
    // for camelCase clients; accept either shape.
    printerModel: z
      .string()
      .max(MAX_PROFILE_NAME_LEN)
      .nullish()
      .transform((v) => v ?? null),
    printerVariant: z
      .string()
      .max(MAX_PROFILE_NAME_LEN)
      .nullish()
      .transform((v) => v ?? null),
    instantiation: z
      .boolean()
      .nullish()
      .transform((v) => v ?? true),
    inherits: z
      .string()
      .max(MAX_PROFILE_NAME_LEN)
      .nullish()
      .transform((v) => v ?? null),
    nozzleDiameter: z
      .number()
      .finite()
      .positive()
      .nullish()
      .transform((v) => v ?? null),
    nozzleType: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? null),
    isHighFlowNozzle: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    buildVolumeX: z
      .number()
      .finite()
      .positive()
      .nullish()
      .transform((v) => v ?? null),
    buildVolumeY: z
      .number()
      .finite()
      .positive()
      .nullish()
      .transform((v) => v ?? null),
    buildVolumeZ: z
      .number()
      .finite()
      .positive()
      .nullish()
      .transform((v) => v ?? null),
  })
  .strip();
export type RemoteMachineProfile = z.infer<typeof RemoteMachineProfile>;

/**
 * `ProcessProfileDto`. `compatible_printers` is a list of exact machine
 * profile Names — the applicability rule. `compatible_printers_condition` is
 * `[JsonIgnore]` on the server so it is never exposed; the server evaluates
 * the OrcaSlicer condition itself when filtering `/for-machines`.
 */
export const RemoteProcessProfile = z
  .object({
    name: z.string().min(1).max(MAX_PROFILE_NAME_LEN),
    quality: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? 'standard'),
    compatiblePrinters: boundedWireList(
      z.string().max(MAX_PROFILE_NAME_LEN),
    ).default([]),
    layerHeight: z
      .number()
      .finite()
      .positive()
      .nullish()
      .transform((v) => v ?? null),
    infillPercentage: z
      .number()
      .finite()
      .nonnegative()
      .nullish()
      .transform((v) => v ?? null),
    supports: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    description: z
      .string()
      .max(4096)
      .nullish()
      .transform((v) => v ?? null),
    instantiation: z
      .boolean()
      .nullish()
      .transform((v) => v ?? true),
    inherits: z
      .string()
      .max(MAX_PROFILE_NAME_LEN)
      .nullish()
      .transform((v) => v ?? null),
  })
  .strip();
export type RemoteProcessProfile = z.infer<typeof RemoteProcessProfile>;

/** `FilamentProfileDto`. Applicability by `compatible_printers` name list. */
export const RemoteFilamentProfile = z
  .object({
    name: z.string().min(1).max(MAX_PROFILE_NAME_LEN),
    material: z
      .string()
      .max(128)
      .nullish()
      .transform((v) => v ?? 'PLA'),
    manufacturer: z
      .string()
      .max(MAX_PROFILE_NAME_LEN)
      .nullish()
      .transform((v) => v ?? null),
    compatiblePrinters: boundedWireList(
      z.string().max(MAX_PROFILE_NAME_LEN),
    ).default([]),
    nozzleTemperature: z
      .number()
      .finite()
      .nullish()
      .transform((v) => v ?? null),
    bedTemperature: z
      .number()
      .finite()
      .nullish()
      .transform((v) => v ?? null),
    instantiation: z
      .boolean()
      .nullish()
      .transform((v) => v ?? true),
    inherits: z
      .string()
      .max(MAX_PROFILE_NAME_LEN)
      .nullish()
      .transform((v) => v ?? null),
  })
  .strip();
export type RemoteFilamentProfile = z.infer<typeof RemoteFilamentProfile>;

/**
 * `ExtendedProfilesResponseDto` — DB-backed list of ALL profiles the server
 * knows about, INCLUDING Guids for system profiles. This is the source used
 * to resolve a canonical Name to a Guid when a downstream caller needs one.
 *
 * Server route: `GET /api/slicer/profiles/extended`
 * Controller:   `ProfilesController.cs:144-158`
 *
 * The exact wire shape of each embedded row isn't dictated by the report so we
 * accept a passthrough object per row and only require the fields we need for
 * name→Guid resolution: `id` (Guid), `name`, and `profileType`.
 */
export const RemoteExtendedProfileEntry = z
  .object({
    id: ServerGuid,
    name: z.string().min(1).max(MAX_PROFILE_NAME_LEN),
    // Server enum spellings vary between builds. Accept the canonical trio
    // ('machine' | 'process' | 'filament') and drop anything else.
    profileType: z.enum(['machine', 'process', 'filament']),
    isSystem: z
      .boolean()
      .nullish()
      .transform((v) => v ?? true),
    printerModelId: ServerGuid.nullish().transform((v) => v ?? null),
    createdAtUtc: ServerInstant.nullish().transform((v) => v ?? null),
    contentSha256: z
      .string()
      .max(256)
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteExtendedProfileEntry = z.infer<
  typeof RemoteExtendedProfileEntry
>;

/**
 * `/extended` is the sole Guid source for system profiles: three IPC
 * handlers (`for-model`, process/filament `for-machines`) build a
 * name→Guid identity map off this list and null out anything missing from
 * it. `boundedWireList`'s shared {@link WIRE_LIST_CEILING} of 1024 is sized
 * for small per-printer lists (missing inputs, rejection reasons); reusing it
 * here silently dropped every profile past row 1024 from the identity map, so
 * an imported profile past the cut looked identical to one that was never
 * imported at all — a data-correctness bug, not a display truncation.
 *
 * `/extended` therefore gets its own ceiling, decoupled from
 * {@link WIRE_LIST_CEILING} and set high enough that no real catalog is
 * expected to reach it. Truncation is still possible in principle (a
 * catalog can always grow), so it is derived from the raw wire length
 * *before* slicing and reported as `truncated`, mirroring the
 * `printersTruncated` precedent this file already established for
 * `/calibration-candidates`. Each row is validated independently (as
 * `boundedCandidateList` does) so one malformed row cannot take the rest of
 * the catalog down with it.
 *
 * The ceiling is {@link CALIBRATION_MAX_PROFILE_LIST}, shared with (not
 * merely mirrored from) the IPC response schema in `src/shared/ipc.ts` — see
 * that constant's doc comment for why #767 requires these to be the exact
 * same value rather than two numbers that happen to agree today.
 */

function boundedProfileList<T extends z.ZodTypeAny>(
  element: T,
  ceiling: number,
) {
  return z
    .array(z.unknown())
    .nullish()
    .transform((raw) => {
      const items = raw ?? [];
      const considered = items.slice(0, ceiling);
      const profiles: z.infer<T>[] = [];
      for (const item of considered) {
        const parsed = element.safeParse(item);
        if (parsed.success) {
          profiles.push(parsed.data as z.infer<T>);
        }
      }
      return { profiles, truncated: items.length > ceiling };
    });
}

/**
 * The extended list may be shaped as either a flat array or as
 * `{ profiles: [...] }`. Accept both; normalise to a flat array downstream.
 */
export const RemoteExtendedProfilesResponse = z.union([
  z
    .object({
      profiles: boundedProfileList(
        RemoteExtendedProfileEntry,
        CALIBRATION_MAX_PROFILE_LIST,
      ),
    })
    .passthrough()
    .transform((v) => v.profiles),
  boundedProfileList(RemoteExtendedProfileEntry, CALIBRATION_MAX_PROFILE_LIST),
]);
export type RemoteExtendedProfilesResponse = z.infer<
  typeof RemoteExtendedProfilesResponse
>;

/**
 * `CustomProfile` — user-created profile stored in the PrintFarmer DB with a
 * Guid Id. Custom filament profiles carry `compatiblePrinters` inline; custom
 * machine/process carry a `printerModelId` GUID for catalog scoping.
 */
export const RemoteCustomProfile = z
  .object({
    id: ServerGuid,
    name: z.string().min(1).max(MAX_PROFILE_NAME_LEN),
    profileType: z.enum(['machine', 'process', 'filament']),
    isSystem: z
      .boolean()
      .nullish()
      .transform((v) => v ?? false),
    createdAt: ServerInstant.nullish().transform((v) => v ?? null),
    rawJson: z
      .string()
      .max(1_048_576)
      .nullish()
      .transform((v) => v ?? null),
    printerModelId: ServerGuid.nullish().transform((v) => v ?? null),
    compatiblePrinters: boundedWireList(z.string().max(MAX_PROFILE_NAME_LEN))
      .nullish()
      .transform((v) => v ?? null),
  })
  .passthrough();
export type RemoteCustomProfile = z.infer<typeof RemoteCustomProfile>;

/**
 * `CustomProfilesListResponseDto`. Accept both `{ profiles: [...] }` and a
 * bare array; some builds serialize a paged envelope, others a flat list.
 */
export const RemoteCustomProfilesList = z
  .union([
    z
      .object({
        profiles: boundedWireList(RemoteCustomProfile),
      })
      .passthrough(),
    boundedWireList(RemoteCustomProfile).transform((profiles) => ({
      profiles,
    })),
  ])
  .transform((v) => ({
    profiles: v.profiles ?? [],
  }));
export type RemoteCustomProfilesList = z.infer<typeof RemoteCustomProfilesList>;

/**
 * Partial view of `PrinterDetailsDto` — only the field we need for the
 * machine-profile cascade.
 *
 * `CalibrationCandidateDto` (`/api/printers/calibration-candidates`) and
 * `CalibrationContextDto` (`/api/printers/{id}/calibration-context`) both
 * inherit from a base that has no catalog `PrinterModel` Guid on the wire.
 * `PrinterDetailsDto` (`/api/printers/{id}/details`) is the only endpoint that
 * exposes `ModelId: Guid?` today — cited server-side at
 * `OlyForge3D/PrintFarmer:src/infra/Dtos/PrinterDetailsDto.cs:17`.
 *
 * We accept every other field via `.passthrough()` so an older or newer
 * deployment shape does not fail parsing; only `modelId` is validated. The
 * projection normalises `undefined`/absent to `null` because that is exactly
 * the semantics the renderer's applicability filter expects (see
 * `src/renderer/calibration/profileSelection.ts:26-53`): `null` means "model
 * unknown, take the permissive path", any Guid means "match by exact model".
 * Collapsing absent to an empty string would silently defeat that fallback,
 * which is precisely the failure this contract fix exists to prevent.
 */
export const RemotePrinterDetailsDto = z
  .object({
    modelId: ServerGuid.nullish().transform((v) => v ?? null),
  })
  .passthrough();
export type RemotePrinterDetailsDto = z.infer<typeof RemotePrinterDetailsDto>;
