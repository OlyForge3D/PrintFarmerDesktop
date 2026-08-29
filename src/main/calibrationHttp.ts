/**
 * Calibration-specific authenticated HTTP client.
 *
 * Security contract:
 * - Uses `ServerProfileService.getAuthenticatedContext()` for profile/identity
 *   fencing before and after every request.
 * - Exactly one bounded 401 token refresh per request sequence.
 * - Renderer cannot control URLs, methods, headers, or receive credentials.
 * - All routes are fixed constants; no renderer-supplied path is accepted.
 * - JWTs never appear in logs.
 * - Response and body limits enforced on every response.
 * - HTTP 428/412/409/422/503 map to distinct typed CalibrationApiError states.
 * - Idempotency-Key, operation IDs, ETag/If-Match, base revisions, opaque
 *   cursors, and exact replay all handled explicitly.
 *
 * @module calibrationHttp
 */

import { z } from 'zod';
import type { z as ZodType } from 'zod';
import {
  CalibrationApiError,
  type CalibrationApiErrorCode,
  CalibrationSliceMethod,
} from '@shared/ipc';
import type {
  RemoteCalibrationApplyRequest,
  RemoteCalibrationApplyResult,
  RemoteCalibrationChangesPage,
  RemoteCalibrationProject,
  RemoteCalibrationAttempt,
  RemoteCalibrationPhoto,
  RemoteCalibrationCapabilities,
  RemoteCalibrationPrinters,
  RemoteCalibrationPrinterContext,
  RemoteCalibrationOrchestrationStatus,
  RemoteJobQueueJob,
  RemoteJobQueueChangeFeedPage,
  RemoteQueueSubscriptionResources,
  RemoteExtendedProfilesResponse,
  RemoteMachineProfile,
  RemoteProcessProfile,
  RemoteFilamentProfile,
  RemoteCustomProfilesList,
  RemotePrinterDetailsDto,
  RemoteCalibrationProjectRecord,
} from './calibrationWire.js';
import {
  RemoteCalibrationApplySuccess,
  RemoteCalibrationApplyConflict,
  RemoteCalibrationProblemDetails,
  RemoteCalibrationChangesPage as ChangesPageSchema,
  RemoteCalibrationCapabilities as CapabilitiesSchema,
  RemoteCalibrationProject as ProjectSchema,
  RemoteCalibrationAttempt as AttemptSchema,
  RemoteCalibrationPhoto as PhotoSchema,
  RemoteCalibrationPrinters as PrintersSchema,
  RemoteCalibrationPrinterContext as PrinterContextSchema,
  RemoteCalibrationOrchestrationStatus as OrchestrationStatusSchema,
  RemoteJobQueueJob as JobQueueJobSchema,
  RemoteAcknowledgeBedClearSuccess as AcknowledgeBedClearSuccessSchema,
  RemoteAcknowledgeBedClearConflict as AcknowledgeBedClearConflictSchema,
  RemoteJobQueueChangeFeedPage as JobQueueChangeFeedPageSchema,
  RemoteQueueSubscriptionResources as QueueSubscriptionResourcesSchema,
  RemoteExtendedProfilesResponse as ExtendedProfilesSchema,
  RemoteMachineProfile as MachineProfileSchema,
  RemoteProcessProfile as ProcessProfileSchema,
  RemoteFilamentProfile as FilamentProfileSchema,
  RemoteCustomProfilesList as CustomProfilesListSchema,
  RemotePrinterDetailsDto as PrinterDetailsSchema,
  RemoteCalibrationProjectRecord as ProjectRecordSchema,
} from './calibrationWire.js';

// --- Issue-#138 route templates (single authoritative source) ----------------
// The parity-guarded contract routes are defined here as templates; ROUTES
// derives those entries from them. Mutating a template changes the actual
// HTTP call path and fails the executable fetch parity tests.

/**
 * Normalized route templates for the issue-#138 contract paths.
 * Parameters use `{name}` placeholders. Each template is the single source
 * from which the corresponding `ROUTES` entry (and executable HTTP call) is
 * derived via `buildRoute`. Exported so documentation-parity tests can compare
 * these values against admin guide §10.1 without a second policy table.
 * Source: OlyForge3D/PrintFarmer JobQueueController, verified at
 * 167a3b134a678a0d9a8c10371da8333d03ddc636.
 *
 * A fourth entry, `generateJob`
 * (`/api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job`),
 * was removed here by issue #784: the server deleted that route (and the
 * whole deterministic generation pipeline it fronted) in
 * OlyForge3D/PrintFarmer#1979/#1993, so the desktop's builder and its
 * `startGeneration` caller had no live handler to reach and were deleted as
 * dead code rather than repointed.
 */
export const CALIBRATION_QUEUE_ROUTE_TEMPLATES = {
  /** POST — create a FilamentCalibration queue job. */
  jobQueue: '/api/job-queue',
  /** GET — fetch a specific queue job by its ID. */
  jobQueueJob: '/api/job-queue/{jobId}',
  /** POST — acknowledge bed clear and start dispatch for an exact job. */
  acknowledgeBedClear: '/api/job-queue/{jobId}/acknowledge-bed-clear-and-start',
} as const;

/**
 * Canonical printer-discovery route templates.
 *
 * `PrinterCalibrationController` — which had served both
 * `/api/printers/calibration-candidates` and
 * `/api/printers/{id}/calibration-context` — was removed by
 * OlyForge3D/PrintFarmer#1943 alongside the `IsExplicitlyEligible` gate.
 * Under Path D there is no server-side eligibility screen: every printer
 * `PrintersController.GetAsync` returns is a valid calibration candidate,
 * and the plain printers list is the only surviving discovery source.
 *
 * The context route is kept here for the moment as a transitional stub, so
 * the callers that still reference `printerContext(...)` continue to
 * typecheck. The endpoint itself is gone on `origin/development`; a caller
 * that hits it will receive an ordinary 404, surfaced through the same
 * `CalibrationHttpError` path any other missing resource takes. Removing the
 * remaining callers is a separate follow-up (the `NewCalibrationProject`
 * flow relies on it).
 */
export const CALIBRATION_DISCOVERY_ROUTE_TEMPLATES = {
  /** GET — every printer PrintFarmer has, without an eligibility filter. */
  printers: '/api/printers',
  /**
   * GET — per-printer calibration context.
   *
   * Retired server-side by #1943; kept here so remaining callers still
   * typecheck. `slicerType` is preserved in the template because a future
   * server-orchestrated calibration API is likely to reintroduce a
   * per-printer context read, and the query parameter is cheap to keep.
   */
  calibrationContext:
    '/api/printers/{printerId}/calibration-context?slicerType=OrcaSlicer',
} as const;

/**
 * The only slicer engine this client negotiates. Must match the server's
 * `CalibrationContractConstants.SlicerEngine` byte-for-byte.
 */
export const CALIBRATION_SLICER_TYPE = 'OrcaSlicer' as const;

/** Replace `{key}` placeholders with URI-encoded values. */
function buildRoute(template: string, params: Record<string, string>): string {
  return Object.entries(params).reduce(
    (path, [key, value]) => path.replace(`{${key}}`, encodeURIComponent(value)),
    template,
  );
}

// --- Fixed API route constants -----------------------------------------------
// These are the only routes this client will ever call. The renderer cannot
// influence them. The contract-critical routes derive from
// CALIBRATION_QUEUE_ROUTE_TEMPLATES so a template mutation changes the call.

const ROUTES = {
  capabilities: '/api/calibration/capabilities',
  /** GET — every printer PrintFarmer has (see templates above). */
  printerCandidates: CALIBRATION_DISCOVERY_ROUTE_TEMPLATES.printers,
  /**
   * GET — canonical per-printer calibration context. `slicerType` is pinned to
   * the constant the server requires; it is never taken from a response.
   *
   * `configurationRevision` is appended when the caller has one, pinning the
   * snapshot to the revision the caller already reasoned about.
   */
  printerContext: (printerId: string, configurationRevision?: number) => {
    const route = buildRoute(
      CALIBRATION_DISCOVERY_ROUTE_TEMPLATES.calibrationContext,
      { printerId },
    );
    return configurationRevision === undefined
      ? route
      : `${route}&configurationRevision=${encodeURIComponent(String(configurationRevision))}`;
  },
  changes: '/api/calibration-sync/changes',
  apply: '/api/calibration-sync/apply',
  /**
   * POST — create a `CalibrationProject`. Verified against
   * `CalibrationProjectsController.CreateProjectAsync` at PrintFarmer
   * commit `0720b9d146256c69fa2780c029ab5982bba509a1` and cross-checked
   * against that commit's `RouteTableSnapshot.txt`; not one of #784's
   * dead routes. See `createProject` below.
   */
  projects: '/api/calibration-projects',
  project: (id: string) =>
    `/api/calibration-projects/${encodeURIComponent(id)}`,
  attempt: (id: string) =>
    `/api/calibration-attempts/${encodeURIComponent(id)}`,
  photo: (id: string) => `/api/calibration-photos/${encodeURIComponent(id)}`,
  photoUpload: (id: string) =>
    `/api/calibration-photos/${encodeURIComponent(id)}/upload`,
  // --- Generation orchestration (issue #899) ---------------------------------
  /** GET — polls orchestration status by orchestration ID. */
  orchestrationStatus: (orchestrationId: string) =>
    `/api/calibration-orchestrations/${encodeURIComponent(orchestrationId)}`,
  // --- Primary job-queue REST (issue #900) — derived from CALIBRATION_QUEUE_ROUTE_TEMPLATES ----
  /** POST — create a queue job. */
  jobQueue: CALIBRATION_QUEUE_ROUTE_TEMPLATES.jobQueue,
  /** GET — fetch a single queue job by ID. */
  jobQueueJob: (jobId: string) =>
    buildRoute(CALIBRATION_QUEUE_ROUTE_TEMPLATES.jobQueueJob, { jobId }),
  /** GET — change feed cursor poll. */
  jobQueueChanges: '/api/job-queue/changes',
  /** GET — subscription resources hint. */
  jobQueueSubscriptionResources: '/api/job-queue/subscription-resources',
  /** POST — acknowledge bed clear and start dispatch. */
  acknowledgeBedClearAndStart: (jobId: string) =>
    buildRoute(CALIBRATION_QUEUE_ROUTE_TEMPLATES.acknowledgeBedClear, {
      jobId,
    }),
  // --- Slicer profile selection (machine → process → filament cascade) -------
  /** GET — DB-backed list of ALL profiles (has Guids for system profiles). */
  extendedProfiles: '/api/slicer/profiles/extended',
  /** GET — machine profiles for a catalog printer-model GUID. */
  machineProfilesForModel: (modelId: string) =>
    `/api/slicer/profiles/machine/for-model/${encodeURIComponent(modelId)}`,
  /** POST — process profiles applicable to the given machine names. */
  processProfilesForMachines: '/api/slicer/profiles/process/for-machines',
  /** POST — filament profiles applicable to the given machine names. */
  filamentProfilesForMachines: '/api/slicer/profiles/filament/for-machines',
  /** GET — the current user's custom profiles. */
  customProfiles: '/api/slicer/profiles/custom',
  /**
   * POST — resolve (and auto-import if needed) a single catalog profile's
   * identity for a printer model, PrintFarmer#2004 / PR #2008. Non-admin —
   * gated only by `Calibration.Update`, which the desktop already holds.
   */
  resolveProfileForModel: (modelId: string) =>
    `/api/slicer/profiles/resolve-for-model/${encodeURIComponent(modelId)}`,
  /**
   * GET — printer details, used only to source the catalog
   * `PrinterModel` Guid that `CalibrationCandidateDto` omits from the wire.
   *
   * The full response is `PrinterDetailsDto`
   * (`OlyForge3D/PrintFarmer:src/infra/Dtos/PrinterDetailsDto.cs:10`) — this
   * client parses only `modelId`.
   */
  printerDetails: (printerId: string) =>
    `/api/printers/${encodeURIComponent(printerId)}/details`,
  // --- Filament calibration slice pipeline (upstream PR #1952) ---------------
  // Routes are fixed constants. The renderer cannot influence them; the ID
  // path parameters flow in through structurally-validated Guids on the IPC
  // boundary and are URI-encoded here on the way out.
  /** POST — clone one slicer profile. Auth: interactive session + Slicing.Submit. */
  cloneProfile: '/api/slicer/profiles/clone',
  /** POST — submit a slice job (calibration or ordinary). Auth: Slicing.Submit. */
  sliceJobs: '/api/slice',
  /** GET — read a slice job's public status projection. Auth: Slicing.Submit. */
  sliceJob: (jobId: string) => `/api/slice/${encodeURIComponent(jobId)}`,
  /** POST — send a completed slice job's gcode to its printer. Auth: Queue.Start. */
  sliceJobSendToPrinter: (jobId: string) =>
    `/api/slice/${encodeURIComponent(jobId)}/send-to-printer`,
  /** PUT — mutate a custom slicer profile. Auth: interactive session + Slicing.Submit. */
  customProfile: (customProfileId: string) =>
    `/api/slicer/profiles/custom/${encodeURIComponent(customProfileId)}`,
} as const;

/**
 * The three semantic precondition header names enforced by the server
 * `AcknowledgeBedClearAndStartAsync` action (JobQueueController.cs).
 * This constant is the production authority used to build the headers in
 * `acknowledgeBedClearAndStart`; it is exported so documentation-parity
 * tests can compare the same values against admin guide §10.3 without
 * duplicating constants.
 *
 * Server semantics: If-Match and X-Dispatch-State-If-Match have no body
 * fallback and return 428 when absent. Idempotency-Key has a body fallback
 * (`request.IdempotencyKey`); 428 requires both header and body to be blank.
 */
export const BED_CLEAR_PRECONDITION_HEADER_NAMES = [
  'idempotency-key',
  'if-match',
  'x-dispatch-state-if-match',
] as const satisfies readonly string[];

// --- Error types -----------------------------------------------------------

export type CalibrationHttpErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'transport'
  | 'authentication'
  | 'authorization'
  | 'rateLimited'
  | 'server'
  | 'notFound'
  | 'invalidResponse'
  | 'bodyTooLarge'
  | 'preconditionRequired'
  | 'revisionConflict'
  | 'idempotencyPayloadChanged'
  | 'invalidData'
  | 'workerUnavailable'
  // --- Calibration discovery 503 discrimination ---
  // PrinterCalibrationController returns 503 for three unrelated causes. These
  // two name the non-worker causes so operators are not sent to the slicing
  // fleet for a profile-resolver or printer-status fault.
  | 'profileServiceUnavailable'
  | 'printerStatusUnavailable'
  // The context route rejects a missing/mis-cased `slicerType` with 400
  // `unsupported_slicer_type`. That is a client contract error, not user data.
  | 'unsupportedSlicerType'
  // --- Bed-clear / queue specific (issue #54) ---
  | 'forbidden'
  | 'jobNotFound'
  | 'wrongJob'
  | 'printerBusy'
  | 'jobNotDispatchable'
  | 'dispatchRevisionConflict'
  | 'calibrationJobIncompatible'
  | 'filamentCheckFailed'
  // A 409 whose server-supplied error code this build does not recognise.
  // Deliberately distinct from every diagnosed 409 so that an unclassified
  // refusal cannot be read as a diagnosed one (#326).
  | 'unclassifiedConflict'
  // A 422 whose server-supplied error code this build does not recognise.
  // The 409 sibling above is the precedent: 'invalidData' was previously
  // returned here, and it is a *diagnosed* code produced by ten other call
  // sites, so an unrecognised rejection was byte-identical to a validated one
  // (#508).
  | 'unclassifiedValidationFailure'
  // --- Filament calibration slice pipeline (PR #1952) ---
  // 422 `unsupported_calibration_method` from `POST /api/slice`. Kept
  // distinct from `invalidData` because the response carries
  // `supportedMethods` and the fix is "pick one of these", not "clean up".
  | 'unsupportedCalibrationMethod'
  // 403 from `POST /api/slicer/profiles/clone` or
  // `PUT /api/slicer/profiles/custom/{id}` when the caller lacks a live
  // interactive session (upstream `InteractiveSessionRequirement`). Distinct
  // from the generic `forbidden` because the operator's fix is to sign in via
  // the app's live session, not chase missing scopes.
  | 'interactiveSessionRequired'
  // Terminal `Failed` observed by the poll driver on a slice job. Distinct
  // from the transport `server` code because the server *has* answered — the
  // job is dead and retrying the same job id will not change anything.
  | 'sliceJobFailed'
  // Poll driver reached its wall-clock cap without observing a terminal
  // status. The server has not declared the job dead — the desktop has given
  // up watching.
  | 'sliceJobTimeout';

export class CalibrationHttpError extends Error {
  constructor(
    readonly code: CalibrationHttpErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly ambiguous = false,
    /**
     * The backend's ProblemDetails `detail`/`title`, verbatim and untrusted.
     *
     * Kept off `message` deliberately (issue #177): `message` reaches the
     * renderer through {@link toApiError} and through
     * `CalibrationSyncStatus.error`, and a server that puts a token, a GPS pair
     * or an absolute path in `detail` would have it rendered. This field is the
     * same text with no path to either surface, so the operator's only
     * actionable string is preserved rather than destroyed.
     *
     * It is *not* logged. `calibrationLog.ts` refuses server-controlled free
     * text by construction and `tests/calibrationLogPolicy.test.ts` enforces
     * that; routing this into a record would breach that control.
     *
     * The disposition was ratified on #177 as **catalogued-plus-opaque-
     * reference**: the renderer gets a catalogued message plus the flow's
     * correlation id (`CalibrationApiError.reference`), and this text never
     * leaves the main process. Recoverability is carried by the reference, not
     * by the string — the operator quotes the reference and the raw detail is
     * read here, in process, rather than rendered or logged.
     */
    readonly serverDetail: string | null = null,
    /**
     * The backend's ProblemDetails `instance`, verbatim and untrusted.
     *
     * Carried for parity with `serverDetail` now that `statusError` validates
     * the response against `RemoteCalibrationProblemDetails` (issue #370),
     * but deliberately **not** wired into the #177 opaque reference here --
     * that remains the conditional the #177 ruling reserved, contingent on
     * confirming the backend actually populates this field. Same
     * in-process-only disposition as `serverDetail`: never logged, never
     * reaches `message` or the renderer.
     */
    readonly serverInstance: string | null = null,
    /**
     * The backend's ProblemDetails `errorCode` extension field, verbatim and
     * untrusted, capped at 64 characters. The cap is enforced in the
     * `.transform` on `RemoteCalibrationProblemDetails`
     * (`calibrationWire.ts`) — not by the raw `errorCode` field's own bound
     * alone, which a server can bypass via the wider (256-char) `error`
     * fallback the transform also coalesces (issue #743). `serverErrorCode`
     * populated from `readJobErrorEnvelope` (the bed-clear/job-queue path)
     * is separately clipped to the same 64 chars at its own read site.
     *
     * Same in-process-only disposition as `serverDetail` for logging and for
     * appearing in `.message`. Distinct from `serverDetail` in one respect:
     * this field IS transferred across the IPC boundary onto
     * `CalibrationApiError.blockedReasonCode` by `toApiError` below, so the
     * renderer can name the specific dispatch gate that closed. The transfer
     * is safe on the same grounds as the HTTP status code — a bounded,
     * enum-shaped identifier drawn from a curated vocabulary
     * (`DispatchSafetyGates.MapBlockedReason`), not free-form server prose.
     * See the docblock on `CalibrationApiError.blockedReasonCode` in
     * `src/shared/ipc.ts` for the ratifying disposition.
     */
    readonly serverErrorCode: string | null = null,
  ) {
    super(message);
    this.name = 'CalibrationHttpError';
  }

  /**
   * Map this transport-layer error to the IPC-level CalibrationApiError type.
   *
   * `reference` is required rather than defaulted: this is the only place the
   * renderer's error is minted, so a default here would silently produce a null
   * reference on every caller that forgot one, and nothing would fail. Callers
   * that genuinely have no correlated flow pass `null` explicitly, which is a
   * decision in the diff instead of an omission.
   */
  toApiError(reference: string | null): z.infer<typeof CalibrationApiError> {
    const codeMap: Partial<
      Record<CalibrationHttpErrorCode, CalibrationApiErrorCode>
    > = {
      preconditionRequired: 'preconditionRequired',
      revisionConflict: 'revisionConflict',
      idempotencyPayloadChanged: 'idempotencyPayloadChanged',
      invalidData: 'invalidData',
      workerUnavailable: 'workerUnavailable',
      server: 'serverError',
      forbidden: 'forbidden',
      jobNotFound: 'jobNotFound',
      wrongJob: 'wrongJob',
      printerBusy: 'printerBusy',
      jobNotDispatchable: 'jobNotDispatchable',
      dispatchRevisionConflict: 'dispatchRevisionConflict',
      calibrationJobIncompatible: 'calibrationJobIncompatible',
      filamentCheckFailed: 'filamentCheckFailed',
      unsupportedCalibrationMethod: 'unsupportedCalibrationMethod',
      interactiveSessionRequired: 'interactiveSessionRequired',
      sliceJobFailed: 'sliceJobFailed',
      sliceJobTimeout: 'sliceJobTimeout',
    };
    // 'unclassifiedConflict' and 'unclassifiedValidationFailure' are
    // deliberately absent from this map. The shared
    // IPC enum has no unclassified member and widening it is a contract change
    // owned by #219, so the fall-through to 'serverError' is a *rendering*
    // fallback and not a classification. The honest code survives where it can
    // be acted on: in the main process, in the structured log vocabulary, and
    // in this error's message, which carries the raw server code (#326, #508).
    const apiCode = codeMap[this.code] ?? 'serverError';
    const retryable = [
      'timeout',
      'transport',
      'rateLimited',
      'server',
      'workerUnavailable',
    ].includes(this.code);
    return {
      code: apiCode,
      message: this.message,
      retryable,
      retryAfterSeconds: this.retryAfterMs
        ? Math.ceil(this.retryAfterMs / 1000)
        : null,
      reference,
      // Passed through the IPC boundary because it is a bounded, enum-shaped
      // ProblemDetails extension, capped at 64 characters (enforced in the
      // `RemoteCalibrationProblemDetails` `.transform` in `calibrationWire.ts`,
      // and separately in `readJobErrorEnvelope` for the bed-clear/job-queue
      // path — see issue #743) and populated by PrintFarmer with the
      // vocabulary defined in `DispatchSafetyGates.MapBlockedReason`), so the
      // renderer can name the specific dispatch gate that closed. This is a
      // deliberate widening of the docblock claim on `serverErrorCode` above:
      // that field's "in-process-only" wording covered `serverInstance` as
      // well because both were untested policy notes, and `serverErrorCode`
      // was the only member of that group carrying a code the renderer needs
      // in order to translate a refusal into a sentence. `serverDetail` and
      // `serverInstance` remain #177-withheld (they carry free-form prose and
      // untrusted URLs respectively); the renderer contract is
      // `CalibrationApiError.blockedReasonCode` in `src/shared/ipc.ts`.
      blockedReasonCode: this.serverErrorCode,
    };
  }
}

/**
 * Renders a response validation failure so the operator can see *which* field
 * drifted, not just that something was `Required`. Never includes the received
 * value, which could carry server data the renderer must not see.
 */
function describeValidationError(error: unknown): string {
  if (!(error instanceof z.ZodError)) return String(error);
  const issues = error.errors.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
  if (issues.length === 0) return 'unknown validation error';
  const remaining = error.errors.length - issues.length;
  return remaining > 0
    ? `${issues.join('; ')} (+${remaining} more)`
    : issues.join('; ');
}

/**
 * Result type for bed-clear acknowledgement operations.
 * Discriminated by `kind` to distinguish the 412 conflict case (which carries
 * current ETags for retry) from success and generic errors.
 */
export type AcknowledgeBedClearResult =
  | {
      kind: 'ok';
      jobETag: string | null;
      dispatchStateETag: string | null;
    }
  | {
      kind: 'revisionConflict';
      /** Current job ETag from the 412 response — use for retry. */
      jobETag: string;
      /** Current dispatch state ETag from the 412 response — use for retry. */
      dispatchStateETag: string;
    };

/**
 * Result type for queue job creation (POST /api/job-queue).
 */
export type CreateQueueJobResult = {
  jobId: string;
  rowVersion: string | null;
  dispatchStateRowVersion: string | null;
  replayed: boolean;
};

// --- Token provider interface ----------------------------------------------

export interface CalibrationTokenProvider {
  getAuthenticatedContext(
    profileId: string,
    expectedBaseUrl?: string,
    forceRefresh?: boolean,
  ): Promise<{ baseUrl: string; token: string; binding: string }>;
}

// --- Client options --------------------------------------------------------

export interface CalibrationHttpClientOptions {
  fetch?: typeof globalThis.fetch;
  /** Overall request timeout in ms (default: 15 s). */
  timeoutMs?: number;
  /** Connect probe timeout in ms (default: 5 s). */
  connectTimeoutMs?: number;
  /** Maximum response body in bytes (default: 1 MiB). */
  maxResponseBytes?: number;
  /**
   * Maximum response body in bytes for the slicer profile-catalog endpoints
   * (default: 32 MiB).
   *
   * These are held to a separate, much larger ceiling because the server
   * returns far more per profile than the desktop consumes: every
   * `FilamentProfileDto` / `ProcessProfileDto` carries the entire OrcaSlicer
   * profile in its opaque `Settings` bag plus `StartGcode`/`EndGcode`
   * (`FilamentProfileDto.cs:80-86`), while the desktop projects each row down
   * to `{ name, guid, source, displayLabel }` and discards the rest. A farm
   * with a full vendor filament library therefore clears the general 1 MiB cap
   * on a request whose useful payload is a few kilobytes of names.
   *
   * The general cap stays where it is: it is the anti-DoS bound for every
   * other calibration response, and widening it globally to accommodate one
   * over-broad list endpoint would weaken all of them. The real remedy is a
   * lightweight server-side projection (PrintFarmer#2049); this ceiling exists
   * so the desktop is not blocked in the meantime.
   */
  profileCatalogMaxResponseBytes?: number;
  /** Maximum photo upload body in bytes (default: 20 MiB). */
  maxPhotoBytes?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// --- Internal pending-response handle -------------------------------------

interface PendingResponse {
  response: Response;
  signal: AbortSignal;
  timedOut(): boolean;
  ambiguous: boolean;
  dispose(): void;
}

// --- Helper: deadline AbortSignal -----------------------------------------

function deadlineSignal(
  outer: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
  const controller = new AbortController();
  let _timedOut = false;
  const timer = setTimeout(() => {
    _timedOut = true;
    controller.abort(new DOMException('Timeout', 'TimeoutError'));
  }, timeoutMs);
  const onAbort = () => controller.abort(outer.reason);
  outer.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => _timedOut,
    dispose: () => {
      clearTimeout(timer);
      outer.removeEventListener('abort', onAbort);
    },
  };
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * Whether a request may be re-issued once its token has been renewed.
 *
 * Only requests that change nothing. See the 401 branch in `request()`: a
 * renewed token can resolve to a different principal, so replaying a mutation
 * would perform it as somebody the operator never chose to be.
 */
function isReplayableAfterReauthentication(
  method: string | undefined,
): boolean {
  const verb = (method ?? 'GET').toUpperCase();
  return verb === 'GET' || verb === 'HEAD';
}

function mapError(
  error: unknown,
  signal: AbortSignal,
  ambiguous: boolean,
  timedOut = false,
): CalibrationHttpError {
  if (error instanceof CalibrationHttpError) return error;
  if (
    signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError')
  ) {
    if (timedOut) {
      return new CalibrationHttpError(
        'timeout',
        'Request timed out.',
        null,
        null,
        ambiguous,
      );
    }
    return new CalibrationHttpError('cancelled', 'Request was cancelled.');
  }
  if (error instanceof TypeError) {
    // undici's `fetch` throws `TypeError('fetch failed')` with the underlying
    // network exception attached as `cause` when the round-trip cannot
    // complete (ECONNREFUSED, TLS negotiation failure, DNS, socket reset,
    // ...). That is a genuine transport condition and belongs in the
    // retryable classification.
    //
    // A `TypeError` **without** a `cause` from this call site means the
    // *request* could not be constructed at all — e.g. `RequestInit` was
    // rejected because a field failed a `WebIDL` type check (a bad `signal`,
    // an unclonable body, an invalid method). That is a programming error in
    // *this* process, not a network failure, and conflating the two would
    // send the caller into an isTransient retry loop against a doomed
    // request and would present in operator-facing telemetry as if the print
    // farm was flaky. The distinct message prefix here surfaces the true
    // cause so the next debugger does not chase a phantom transport fault.
    // See #TODO(cross-team) if a specific downstream ever needs to
    // discriminate this without message parsing.
    if (error.cause === undefined) {
      return new CalibrationHttpError(
        'transport',
        `Request construction failed (client-side programming error, not a network condition): ${error.message}`,
        null,
        null,
        ambiguous,
      );
    }
    return new CalibrationHttpError(
      'transport',
      error.message,
      null,
      null,
      ambiguous,
    );
  }
  return new CalibrationHttpError(
    'transport',
    error instanceof Error ? error.message : 'Unknown transport error',
    null,
    null,
    ambiguous,
  );
}

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function isTransient(error: CalibrationHttpError): boolean {
  return [
    'transport',
    'timeout',
    'rateLimited',
    'server',
    'workerUnavailable',
  ].includes(error.code);
}

/**
 * Map a 409 error code string from the bed-clear endpoint to a typed error code.
 *
 * Unrecognised codes return `'unclassifiedConflict'`, which no named case
 * produces. Returning a diagnosed code here would make *"the server told us the
 * payload changed"* and *"the server told us something we have never seen"*
 * byte-identical to every consumer — including the runbooks, which assign the
 * diagnosed code a definite cause (#326).
 *
 * This matches {@link mapBedClearErrorCode422}, whose fallback is likewise a
 * code that none of its named cases produces. That sentence was false when it
 * was written: 422's fallback was `'invalidData'`, a diagnosed code with ten
 * producers elsewhere in the main process. It is true as of #508, which is the
 * change that made the comment honest rather than aspirational.
 */
function mapBedClearErrorCode409(
  errorCode: string | null,
): CalibrationHttpErrorCode {
  switch (errorCode) {
    case 'wrong_job':
      return 'wrongJob';
    case 'printer_busy':
      return 'printerBusy';
    case 'job_not_dispatchable':
      return 'jobNotDispatchable';
    case 'idempotency_payload_mismatch':
      return 'idempotencyPayloadChanged';
    default:
      return 'unclassifiedConflict';
  }
}

/**
 * Map a 422 error code string from the bed-clear endpoint to a typed error code.
 *
 * Unrecognised codes return `'unclassifiedValidationFailure'`, which no named
 * case produces. Returning `'invalidData'` here — as this function did before
 * #508 — made *"the server validated the payload and rejected it"* and *"the
 * server said something this build has never seen"* byte-identical to every
 * consumer, including the runbooks, which give `invalidData` the definite cause
 * *"the server rejected the request as invalid."*
 *
 * This is the treatment {@link mapBedClearErrorCode409} already applied twenty
 * lines above; the two mappers now agree.
 */
function mapBedClearErrorCode422(
  errorCode: string | null,
): CalibrationHttpErrorCode {
  switch (errorCode) {
    case 'calibration_job_incompatible':
      return 'calibrationJobIncompatible';
    case 'filament_check_failed':
      return 'filamentCheckFailed';
    default:
      return 'unclassifiedValidationFailure';
  }
}

// --- Filament calibration slice pipeline (PR #1952) response schemas --------
//
// Kept next to the transport methods that consume them and NOT under
// `calibrationWire.ts`, because these schemas encode the *desktop's* narrower
// view of the PR #1952 DTOs — `isSystem: false` is pinned as a literal for
// clones (upstream hardcodes that), `slicerEngine` is bounded to 64 chars for
// the wire, etc. Widening any of these bounds is a contract change owned by
// this module.

/**
 * `CloneSingleProfileResponseDto` from `CloneProfilesDtos.cs` — the *clone*
 * endpoint's 4-field projection. Consumed by `cloneSingleProfile` only.
 *
 * (An earlier revision of this schema claimed the PUT-custom endpoint returns
 * the same projection. That was wrong: `ProfilesService.UpdateCustomProfileAsync`
 * is typed `Task<CustomProfileDto>` in `IProfilesService.cs`, which is the
 * richer 10-field DTO in the same header. See `CustomProfileResponseSchema`
 * below.)
 */
const CloneSingleProfileResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(512),
    profileType: z.enum(['machine', 'process', 'filament']),
    isSystem: z.literal(false),
  })
  .strict();

/**
 * `ResolveProfileForModelResultDto` (`ProfileResolutionDtos.cs`,
 * PrintFarmer#2004 / PR #2008). `profileId` is non-null on success (whether
 * already-imported or freshly auto-imported); null only alongside a
 * populated `error`.
 */
const ResolveProfileForModelResponseSchema = z
  .object({
    printerModelId: z.string().uuid(),
    profileType: z.enum(['Machine', 'Process', 'Filament']),
    profileName: z.string().min(1).max(512),
    profileId: z.string().uuid().nullable(),
    imported: z.boolean(),
    error: z.string().max(2048).nullable(),
  })
  .strict();

/**
 * `CustomProfileDto` from `CloneProfilesDtos.cs` — the *update-custom* endpoint's
 * 10-field projection. `PUT /api/slicer/profiles/custom/{id}` (via
 * `IProfilesService.UpdateCustomProfileAsync`) returns this shape, NOT the
 * 4-field clone projection. Consumed by `updateCustomProfile` only.
 *
 * `rawJson` is a serialized string (the OrcaSlicer profile JSON), unbounded on
 * the C# side but bounded here at 1 MiB — anything larger than that would
 * already fail the client's `maxResponseBytes` cap.
 *
 * `compatiblePrinters` is `IReadOnlyList<string>?` on the C# side — a nullable
 * list of enum-name-shaped machine variants; each entry is capped at 128 chars
 * to match what the source profile can carry.
 */
const CustomProfileResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(512),
    profileType: z.enum(['machine', 'process', 'filament']),
    // `CustomProfileDto.IsSystem` is `bool`, not `false`-literal — the
    // `custom/` route is only meant to serve non-system profiles in
    // production, but the invariant lives at the routing/authorization
    // layer, not on the wire. If an operator or a shallow-clone bug ever
    // aims this endpoint at a system row, the response can still legally
    // carry `isSystem: true`, and rejecting that with a schema error would
    // conflate "programming invariant violated" with "server returned
    // malformed JSON". Clone-isolation must be observed on the calling
    // side (compare returned id to the source id) rather than defended
    // by the parser here.
    isSystem: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime().nullable(),
    description: z.string().max(2048).nullable(),
    rawJson: z
      .string()
      .max(1024 * 1024)
      .nullable(),
    printerModelId: z.string().uuid().nullable(),
    compatiblePrinters: z.array(z.string().max(128)).max(256).nullable(),
  })
  .strict();

/**
 * `SubmitSliceJobResponse` from `SliceJobDtos.cs`. `queuePosition` is `int?`
 * on the C# side — a server that accepts the job straight into `Processing`
 * (no queue wait) returns null.
 */
const SubmitSliceJobResponseSchema = z
  .object({
    jobId: z.string().uuid(),
    status: z.enum([
      'Queued',
      'Processing',
      'Completed',
      'Failed',
      'Cancelled',
    ]),
    queuedAt: z.string().datetime(),
    queuePosition: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * `SliceJobStatusResponse` — the *public* projection from
 * `SliceJobController.MapToPublicStatusResponse` (PR #1952 lines 1215-1258).
 * Does NOT include `resultFileUrl`; the artifact hand-off is via
 * `send-to-printer` and the per-job `artifactsRoute`, not a direct download.
 */
const SliceJobStatusResponseSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum([
      'Queued',
      'Processing',
      'Completed',
      'Failed',
      'Cancelled',
    ]),
    progressPercent: z.number().int().min(0).max(100),
    progressMessage: z.string().max(512).nullable(),
    queuedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    errorMessage: z.string().max(2048).nullable(),
    /**
     * Admin-only worker-side failure detail (`SliceJobStatusResponse.ErrorDetail`
     * in `SliceJobDtos.cs` @ `a4f230aa...`) — the DTO documents this as
     * "populated only for farm admins. Never returned to non-admin callers".
     * For the desktop's operator identity this is expected to always be null,
     * but the field IS on the wire in every response (the C# type has it
     * unconditionally). The schema was previously missing it entirely, which
     * paired with `.strict()` was rejecting the entire status response with
     * `Unrecognized key(s) in object: 'errorDetail'`. Bounded at 4 KiB so a
     * mis-configured admin-privileged response cannot smuggle unbounded
     * worker diagnostics through the wire.
     */
    errorDetail: z.string().max(4096).nullable(),
    /**
     * `LayoutDegradationReason?` enum from `SlicerModels.cs` — serialized as
     * `JsonStringEnumConverter`, so the wire value is the enum member name
     * (e.g. `"BedCenterUnknown"`) or `null`. Was previously `z.boolean()`,
     * which contradicted both the DTO type and the fixture's citation and
     * would reject any non-null value the real server produced.
     */
    layoutDegradation: z.string().max(64).nullable(),
    failureReason: z.string().max(128).nullable(),
    failureHint: z.string().max(2048).nullable(),
    estimatedPrintTimeSeconds: z.number().int().nonnegative().nullable(),
    filamentUsedGrams: z.number().finite().nonnegative().nullable(),
    workerId: z.string().max(128).nullable(),
    modelFileName: z.string().max(512),
    slicerEngine: z.string().max(64),
    artifactsRoute: z.string().max(512).nullable(),
  })
  .strict();

/** `SendToPrinterResponse` from `Responses/SendToPrinterResponse.cs`. */
const SendToPrinterResponseSchema = z
  .object({
    jobId: z.string().uuid(),
    printerId: z.string().uuid(),
    fileName: z.string().max(512),
    printStarted: z.boolean(),
    message: z.string().max(2048).nullable(),
  })
  .strict();

/**
 * Upgrade an `authorization` error (403) into `interactiveSessionRequired`
 * when we know the endpoint's only 403 path is the
 * `InteractiveSessionRequirement` gate. Preserves every other field of the
 * underlying `CalibrationHttpError` — `serverDetail`, `serverInstance`,
 * `serverErrorCode`, `status`, `ambiguous`, `retryAfterMs`. A non-403 error
 * passes through unchanged.
 */
function remapInteractiveSession(
  error: CalibrationHttpError,
): CalibrationHttpError {
  if (error.code !== 'authorization' || error.status !== 403) {
    return error;
  }
  return new CalibrationHttpError(
    'interactiveSessionRequired',
    'The server requires an interactive session to modify slicer profiles.',
    error.status,
    error.retryAfterMs,
    error.ambiguous,
    error.serverDetail,
    error.serverInstance,
    error.serverErrorCode,
  );
}

/**
 * Wire values of `CalibrationMethod` this client supports. Derived from the
 * single `CalibrationSliceMethod` catalogue rather than hand-listed, so it
 * cannot drift from what the desktop actually offers. PA Pattern / PA Line are
 * absent because they are absent from that catalogue (upstream issue #1938).
 *
 * Exported so the remap-to-actionable-message function below can name them in
 * the operator-facing error text without relying on the server echoing them
 * back on `supportedMethods` — the client knows its own supported set at
 * compile time, and it is the operator's fix ("pick one of these") regardless
 * of whether the server bothered to include the list.
 */
export const CLIENT_SUPPORTED_CALIBRATION_METHODS =
  CalibrationSliceMethod.options;
export type ClientSupportedCalibrationMethod =
  (typeof CLIENT_SUPPORTED_CALIBRATION_METHODS)[number];

/**
 * Upgrade an `invalidData` error (422) into `unsupportedCalibrationMethod`
 * when the server's ProblemDetails `errorCode` extension is
 * `unsupported_calibration_method`. Preserves every other field of the
 * underlying error so the response's `supportedMethods` list survives on
 * `serverDetail` for the operator log.
 */
function remapUnsupportedCalibrationMethod(
  error: CalibrationHttpError,
): CalibrationHttpError {
  if (
    error.code !== 'invalidData' ||
    error.status !== 422 ||
    error.serverErrorCode !== 'unsupported_calibration_method'
  ) {
    return error;
  }
  return new CalibrationHttpError(
    'unsupportedCalibrationMethod',
    // Name the wire-supported methods in the catalogued (client-authored)
    // message so the wizard's error text is actionable ("pick one of these")
    // instead of a bare "unsupported" refusal that the operator cannot act
    // on without cross-referencing docs. The list is from the client's own
    // compile-time constant — the `serverDetail`-carried `supportedMethods`
    // extension the server sends alongside is kept for the operator log
    // (see docblock above) but never injected into `.message`, per the
    // invariant that `.message` is client-authored and never carries
    // server-controlled text.
    `The server does not support the requested calibration method for this slicer engine. Supported methods: ${CLIENT_SUPPORTED_CALIBRATION_METHODS.join(', ')}.`,
    error.status,
    error.retryAfterMs,
    error.ambiguous,
    error.serverDetail,
    error.serverInstance,
    error.serverErrorCode,
  );
}

// --- Main client class ----------------------------------------------------

export class CalibrationHttpClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly profileCatalogMaxResponseBytes: number;
  private readonly maxPhotoBytes: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleepImpl: (
    ms: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(
    private readonly tokens: CalibrationTokenProvider,
    options: CalibrationHttpClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.profileCatalogMaxResponseBytes =
      options.profileCatalogMaxResponseBytes ?? 32 * 1024 * 1024;
    this.maxPhotoBytes = options.maxPhotoBytes ?? 20 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleepImpl = options.sleep ?? sleep;
  }

  // --- Public API ----------------------------------------------------------

  async getCapabilities(
    profileId: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationCapabilities> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.capabilities,
      CapabilitiesSchema,
      signal,
    );
  }

  async getPrinters(
    profileId: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationPrinters> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.printerCandidates,
      PrintersSchema,
      signal,
    );
  }

  async getPrinterContext(
    profileId: string,
    baseUrl: string,
    printerId: string,
    signal: AbortSignal,
    configurationRevision?: number,
  ): Promise<RemoteCalibrationPrinterContext> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.printerContext(printerId, configurationRevision),
      PrinterContextSchema,
      signal,
    );
  }

  async getChanges(
    profileId: string,
    baseUrl: string,
    cursor: string | null,
    projectId: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationChangesPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== null) query.set('after', cursor);
    if (projectId !== null) query.set('projectId', projectId);
    return this.get(
      profileId,
      baseUrl,
      `${ROUTES.changes}?${query.toString()}`,
      ChangesPageSchema,
      signal,
    );
  }

  async apply(
    profileId: string,
    baseUrl: string,
    body: RemoteCalibrationApplyRequest,
    operationId: string,
    etag: string | null,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationApplyResult> {
    if (body.operations.length === 0 || body.operations.length > 100) {
      throw new CalibrationHttpError(
        'invalidData',
        'Calibration apply batches must contain 1..=100 operations.',
      );
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': operationId,
    };
    if (etag !== null) headers['if-match'] = etag;

    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.apply,
      { method: 'POST', headers, body: JSON.stringify(body) },
      signal,
      true,
    );
    try {
      if (pending.response.status === 409) {
        const conflict = await this.parse(
          pending,
          RemoteCalibrationApplyConflict,
        );
        return { kind: 'conflict', value: conflict };
      }
      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          true,
          pending.timedOut(),
        );
      }
      const success = await this.parse(pending, RemoteCalibrationApplySuccess);
      return { kind: 'success', value: success };
    } catch (error) {
      if (
        error instanceof CalibrationHttpError &&
        ['invalidResponse', 'bodyTooLarge', 'transport'].includes(error.code)
      ) {
        throw new CalibrationHttpError(
          error.code,
          error.message,
          error.status,
          error.retryAfterMs,
          true,
        );
      }
      throw error;
    } finally {
      pending.dispose();
    }
  }

  // --- Slicer profile listing (machine → process → filament cascade) --------

  /**
   * `GET /api/slicer/profiles/extended` — the DB-backed catalog.
   *
   * This is the ONLY listing endpoint that returns Guids for system profiles.
   * Every other listing route (`/for-model`, `/for-machines`, `/custom`) returns
   * either name-keyed worker DTOs or Guid-keyed custom rows. When a downstream
   * caller needs a Guid for a system profile identified by name, it resolves
   * that name against this list.
   *
   * Server: `ProfilesController.cs:144-158`. Requires `Slicing.Submit`.
   */
  async getExtendedProfiles(
    profileId: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<RemoteExtendedProfilesResponse> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.extendedProfiles,
      ExtendedProfilesSchema,
      signal,
      4,
      this.profileCatalogMaxResponseBytes,
    );
  }

  /**
   * `GET /api/slicer/profiles/machine/for-model/{modelId:guid}` — system
   * machine profiles for a catalog printer model. Returns 404 with no body
   * when the catalog has no OrcaSlicer alias for the model; we surface that as
   * a distinct `notFound` code so the renderer can guide the operator to add
   * an alias rather than treat the printer as un-calibratable.
   *
   * Server: `ProfilesController.cs:846-900`. Requires `Slicing.Submit`.
   */
  async getMachineProfilesForModel(
    profileId: string,
    baseUrl: string,
    modelId: string,
    signal: AbortSignal,
  ): Promise<RemoteMachineProfile[]> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.machineProfilesForModel(modelId),
      z.array(MachineProfileSchema).max(2048),
      signal,
      4,
      this.profileCatalogMaxResponseBytes,
    );
  }

  /**
   * `POST /api/slicer/profiles/process/for-machines` — server-side applicability
   * filter. Body: `{ machineNames: string[] }` (each name is the canonical
   * `MachineProfileDto.Name`). Server evaluates `compatible_printers` and
   * `compatible_printers_condition` inside the OrcaSlicer worker.
   *
   * Server: `ProfilesController.cs:909-933`. Requires `Slicing.Submit`.
   */
  async getProcessProfilesForMachines(
    profileId: string,
    baseUrl: string,
    machineNames: readonly string[],
    signal: AbortSignal,
  ): Promise<RemoteProcessProfile[]> {
    return this.postProfileFilter(
      profileId,
      baseUrl,
      ROUTES.processProfilesForMachines,
      machineNames,
      z.array(ProcessProfileSchema).max(2048),
      signal,
    );
  }

  /**
   * `POST /api/slicer/profiles/filament/for-machines` — server-side applicability
   * filter, same body shape as the process endpoint.
   *
   * Server: `ProfilesController.cs:942-966`. Requires `Slicing.Submit`.
   */
  async getFilamentProfilesForMachines(
    profileId: string,
    baseUrl: string,
    machineNames: readonly string[],
    signal: AbortSignal,
  ): Promise<RemoteFilamentProfile[]> {
    return this.postProfileFilter(
      profileId,
      baseUrl,
      ROUTES.filamentProfilesForMachines,
      machineNames,
      z.array(FilamentProfileSchema).max(2048),
      signal,
    );
  }

  /**
   * `GET /api/slicer/profiles/custom` — the current user's custom (non-system)
   * profiles. These carry a `Guid Id` directly; the desktop uses that Guid on
   * the setup PUT without going through `/extended`. Applicability is
   * client-side per §B.2 of the report.
   *
   * Server: `ProfilesController.cs:1327-1343`. Requires `Slicing.Submit`.
   */
  async getCustomProfiles(
    profileId: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<RemoteCustomProfilesList> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.customProfiles,
      CustomProfilesListSchema,
      signal,
    );
  }

  /**
   * `GET /api/printers/{printerId}/details` — used only to source the catalog
   * `PrinterModel` Guid that the calibration-candidates list omits from the
   * wire.
   *
   * The `/for-model/{modelId}` endpoint needs a real Guid to return the
   * system machine profiles applicable to a printer; without one the cascade
   * degrades to the catalog-wide `/extended` list and shows profiles for every
   * model instead of just the operator's. Every other server field on the
   * details response is ignored here — this is a targeted enrichment, not a
   * general printer read.
   *
   * Failure is deliberately swallowed at the call site (the `listPrinters`
   * handler enriches with `Promise.allSettled`): a printer whose details
   * cannot be read still surfaces in the candidate list, with
   * `printerModelId: null`, which the renderer's permissive fallback (Dallas's
   * `profileSelection.ts:49-53`) treats as "model unknown, show the wider
   * pool". Losing the whole list because one printer's details endpoint
   * returned 403 or 404 would reintroduce exactly the empty-list failure the
   * candidate contract already exists to prevent.
   */
  async getPrinterDetails(
    profileId: string,
    baseUrl: string,
    printerId: string,
    signal: AbortSignal,
  ): Promise<RemotePrinterDetailsDto> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.printerDetails(printerId),
      PrinterDetailsSchema,
      signal,
    );
  }

  // --- Filament calibration slice pipeline (PR #1952) -----------------------
  //
  // Each method here is a single-shot HTTP call plus a targeted error remap.
  // The remap upgrades two specific `CalibrationHttpError` codes:
  //   - a 403 on the clone/PUT profile endpoints becomes
  //     `interactiveSessionRequired` (upstream `InteractiveSessionRequirement`),
  //   - a 422 on `POST /api/slice` whose ProblemDetails `errorCode` is
  //     `unsupported_calibration_method` becomes
  //     `unsupportedCalibrationMethod`.
  // Both remaps run only for endpoints where the diagnosis is unambiguous, so
  // the generic `authorization` / `invalidData` codes remain the right answer
  // everywhere else.
  //
  // The poll-driver terminal-outcome codes (`sliceJobFailed`,
  // `sliceJobTimeout`) are minted at the IPC-handler layer where the poll
  // schedule lives — not here, because the transport layer does not decide
  // when to stop looking.

  /**
   * `POST /api/slicer/profiles/clone` — clone a single filament profile in the
   * OrcaSlicer worker's DB. Renames the clone in the same call, per the owner's
   * workflow ("… rename it to match the filament they are calibrating").
   *
   * Upstream `ProfilesController.cs:1247-1283`. Auth: `Slicing.Submit` +
   * `InteractiveSessionRequirement`. `request.idempotencyKey`, when set,
   * populates the `Idempotency-Key` header so a re-issued clone is not
   * double-executed on the server.
   */
  async cloneSingleProfile(
    profileId: string,
    baseUrl: string,
    request: {
      sourceProfileId: string;
      profileType: 'machine' | 'process' | 'filament';
      name: string | null;
      printerModelId?: string | null;
      compatiblePrinters?: readonly string[] | null;
      idempotencyKey?: string | null;
    },
    signal: AbortSignal,
  ): Promise<{
    id: string;
    name: string;
    profileType: 'machine' | 'process' | 'filament';
    isSystem: false;
  }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (
      request.idempotencyKey !== undefined &&
      request.idempotencyKey !== null
    ) {
      headers['idempotency-key'] = request.idempotencyKey;
    }
    const body = JSON.stringify({
      sourceProfileId: request.sourceProfileId,
      profileType: request.profileType,
      name: request.name,
      printerModelId: request.printerModelId ?? null,
      compatiblePrinters:
        request.compatiblePrinters === undefined ||
        request.compatiblePrinters === null
          ? null
          : [...request.compatiblePrinters],
    });
    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.cloneProfile,
      { method: 'POST', headers, body },
      signal,
      true,
    );
    try {
      if (!pending.response.ok) {
        throw remapInteractiveSession(
          await this.statusError(pending.response, true, pending.timedOut()),
        );
      }
      return await this.parse(pending, CloneSingleProfileResponseSchema);
    } finally {
      pending.dispose();
    }
  }

  /**
   * `POST /api/slicer/profiles/resolve-for-model/{modelId}` — resolves (and
   * auto-imports if needed) a single catalog profile's identity by name,
   * PrintFarmer#2004 / PR #2008. Unlike `cloneSingleProfile`, gated only by
   * `Calibration.Update` — no `InteractiveSessionRequirement`, so no
   * `remapInteractiveSession` here. A `status:200` body with a populated
   * `error` and `profileId: null` (ambiguous name, worker unreachable, model
   * not found) is a legal response, not an HTTP failure — the caller decides
   * how to surface it.
   */
  async resolveProfileForModel(
    profileId: string,
    baseUrl: string,
    modelId: string,
    request: {
      profileType: 'machine' | 'process' | 'filament';
      profileName: string;
    },
    signal: AbortSignal,
  ): Promise<{
    profileId: string | null;
    imported: boolean;
    error: string | null;
  }> {
    // The server's `ProfileResolutionType` enum serializes/parses as its
    // literal C# member names (`[JsonConverter(typeof(JsonStringEnumConverter))]`
    // on the enum itself, bypassing the API's global camelCase property
    // naming policy which only governs property names, not enum values) —
    // PascalCase, not the lowercase the rest of this desktop's wire uses.
    const wireProfileType =
      request.profileType === 'machine'
        ? 'Machine'
        : request.profileType === 'process'
          ? 'Process'
          : 'Filament';
    const body = JSON.stringify({
      profileType: wireProfileType,
      profileName: request.profileName,
    });
    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.resolveProfileForModel(modelId),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      },
      signal,
      true,
    );
    try {
      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          true,
          pending.timedOut(),
        );
      }
      const parsed = await this.parse(
        pending,
        ResolveProfileForModelResponseSchema,
      );
      return {
        profileId: parsed.profileId,
        imported: parsed.imported,
        error: parsed.error,
      };
    } finally {
      pending.dispose();
    }
  }

  /**
   * `POST /api/slice` in calibration mode — omits `modelFileUrl` /
   * `model3DId` so the worker resolves the calibration model from its own
   * `resources/calib/`. Populates neither `calibrationProjectId` nor
   * `calibrationAttemptId` nor `calibrationOrchestrationId` — upstream PR
   * #1952 rejects any of those with `calibration_mode_conflicts_with_saga_ids`
   * (422), and that rejection is the proof that a calibration slice remains an
   * ordinary slice job eligible for `send-to-printer`.
   *
   * Saga fields are OMITTED entirely, not set to `null`. Hicks's acceptance
   * suite specifically inspects key *presence* (`hasOwnProperty`) on the
   * wire body — a null-valued key still trips the upstream 422 gate.
   *
   * Upstream `SliceJobController` + `SliceJobDtos.SubmitSliceJobRequest`. Auth:
   * `Slicing.Submit`. `request.idempotencyKey`, when set, populates the
   * `Idempotency-Key` header. A 422 `unsupported_calibration_method` is
   * remapped to `unsupportedCalibrationMethod` so the renderer can surface
   * the `supportedMethods` list as an actionable "pick one of these" instead
   * of a generic invalid-data error.
   */
  async submitCalibrationSlice(
    profileId: string,
    baseUrl: string,
    request: {
      userId: string;
      printerId: string;
      slicerProfileJson: string;
      method: CalibrationSliceMethod;
      params?: Record<string, number> | null;
      idempotencyKey?: string | null;
    },
    signal: AbortSignal,
  ): Promise<{
    jobId: string;
    status: 'Queued' | 'Processing' | 'Completed' | 'Failed' | 'Cancelled';
    queuedAt: string;
    queuePosition: number | null;
  }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (
      request.idempotencyKey !== undefined &&
      request.idempotencyKey !== null
    ) {
      headers['idempotency-key'] = request.idempotencyKey;
    }
    // Saga keys are OMITTED from the object literal entirely. Setting them
    // to `null` still counts as `hasOwnProperty` on the parsed body and
    // trips the upstream 422 `calibration_mode_conflicts_with_saga_ids`.
    const body = JSON.stringify({
      userId: request.userId,
      printerId: request.printerId,
      slicerEngine: 'OrcaSlicer',
      slicerProfileJson: request.slicerProfileJson,
      calibration: {
        method: request.method,
        params: request.params ?? {},
      },
    });
    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.sliceJobs,
      { method: 'POST', headers, body },
      signal,
      true,
    );
    try {
      if (!pending.response.ok) {
        throw remapUnsupportedCalibrationMethod(
          await this.statusError(pending.response, true, pending.timedOut()),
        );
      }
      return await this.parse(pending, SubmitSliceJobResponseSchema);
    } finally {
      pending.dispose();
    }
  }

  /**
   * `GET /api/slice/{jobId}` — public status projection from PR #1952. Does
   * NOT include `resultFileUrl`; that field lives on the worker-only
   * `CompleteSliceJobResponse`. Auth: `Slicing.Submit`.
   */
  async getSliceJobStatus(
    profileId: string,
    baseUrl: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<{
    id: string;
    status: 'Queued' | 'Processing' | 'Completed' | 'Failed' | 'Cancelled';
    progressPercent: number;
    progressMessage: string | null;
    queuedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    errorMessage: string | null;
    errorDetail: string | null;
    layoutDegradation: string | null;
    failureReason: string | null;
    failureHint: string | null;
    estimatedPrintTimeSeconds: number | null;
    filamentUsedGrams: number | null;
    workerId: string | null;
    modelFileName: string;
    slicerEngine: string;
    artifactsRoute: string | null;
  }> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.sliceJob(jobId),
      SliceJobStatusResponseSchema,
      signal,
    );
  }

  /**
   * `POST /api/slice/{jobId}/send-to-printer` — hand a completed slice job to
   * the printer's queue. Machine-moving action when `startPrint === true`; the
   * IPC handler layer enforces `calibrationActionGate.ts` before this method
   * is called. `request.idempotencyKey`, when set, populates the
   * `Idempotency-Key` header. Auth: `Queue.Start`.
   */
  async sendSliceToPrinter(
    profileId: string,
    baseUrl: string,
    jobId: string,
    request: {
      printerId: string;
      startPrint: boolean;
      idempotencyKey?: string | null;
    },
    signal: AbortSignal,
  ): Promise<{
    jobId: string;
    printerId: string;
    fileName: string;
    printStarted: boolean;
    message: string | null;
  }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (
      request.idempotencyKey !== undefined &&
      request.idempotencyKey !== null
    ) {
      headers['idempotency-key'] = request.idempotencyKey;
    }
    const body = JSON.stringify({
      printerId: request.printerId,
      startPrint: request.startPrint,
    });
    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.sliceJobSendToPrinter(jobId),
      { method: 'POST', headers, body },
      signal,
      true,
    );
    try {
      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          true,
          pending.timedOut(),
        );
      }
      return await this.parse(pending, SendToPrinterResponseSchema);
    } finally {
      pending.dispose();
    }
  }

  /**
   * `PUT /api/slicer/profiles/custom/{id}` — mutate a custom slicer profile.
   * `rawJson` replaces the profile JSON verbatim, so callers wanting to update
   * only measured filament fields must read-modify-write against the current
   * profile. The IPC handler drives that cycle; this transport method takes
   * the already-merged JSON.
   *
   * The URL only names a custom profile id, but that is a documented
   * contract, not a structural guarantee — the IPC handler in
   * `src/main/ipc.ts` refuses to invoke this method against any profile
   * whose `isSystem === true` in the current custom-profiles listing. That
   * is the structural fence protecting source (system) profiles from
   * accidental mutation.
   *
   * Upstream `ProfilesController.cs:1352-1395`. Auth: `Slicing.Submit` +
   * `InteractiveSessionRequirement`. `request.idempotencyKey`, when set,
   * populates the `Idempotency-Key` header so a re-issued measurement write
   * is not applied twice on the server.
   */
  async updateCustomProfile(
    profileId: string,
    baseUrl: string,
    customProfileId: string,
    request: {
      rawJson?: string | null;
      name?: string | null;
      description?: string | null;
      idempotencyKey?: string | null;
    },
    signal: AbortSignal,
  ): Promise<{
    id: string;
    name: string;
    profileType: 'machine' | 'process' | 'filament';
    isSystem: boolean;
    createdAt: string;
    updatedAt: string | null;
    description: string | null;
    rawJson: string | null;
    printerModelId: string | null;
    compatiblePrinters: readonly string[] | null;
  }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (
      request.idempotencyKey !== undefined &&
      request.idempotencyKey !== null
    ) {
      headers['idempotency-key'] = request.idempotencyKey;
    }
    const body = JSON.stringify({
      rawJson: request.rawJson ?? null,
      name: request.name ?? null,
      description: request.description ?? null,
      printerModelId: null,
      clearPrinterModelId: false,
      compatiblePrinters: null,
      clearCompatiblePrinters: false,
    });
    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.customProfile(customProfileId),
      { method: 'PUT', headers, body },
      signal,
      true,
    );
    try {
      if (!pending.response.ok) {
        throw remapInteractiveSession(
          await this.statusError(pending.response, true, pending.timedOut()),
        );
      }
      return await this.parse(pending, CustomProfileResponseSchema);
    } finally {
      pending.dispose();
    }
  }

  // --- End filament calibration slice pipeline ------------------------------

  /**
   * Shared body for the two `for-machines` POST endpoints. Both take exactly
   * the same request shape (`{ machineNames: string[] }`) and both return an
   * array we cap at 2048 elements. Extracted so the two callers cannot drift.
   */
  private async postProfileFilter<T>(
    profileId: string,
    baseUrl: string,
    resource: string,
    machineNames: readonly string[],
    responseSchema: ZodType.ZodType<T, ZodType.ZodTypeDef, unknown>,
    signal: AbortSignal,
  ): Promise<T> {
    if (machineNames.length === 0) {
      throw new CalibrationHttpError(
        'invalidData',
        'At least one machine name is required to filter profiles.',
      );
    }
    if (machineNames.length > 64) {
      throw new CalibrationHttpError(
        'invalidData',
        'Machine name filter accepts at most 64 names per request.',
      );
    }
    const body = JSON.stringify({ machineNames: [...machineNames] });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const pending = await this.request(
      profileId,
      baseUrl,
      resource,
      { method: 'POST', headers, body },
      signal,
      false,
    );
    try {
      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          false,
          pending.timedOut(),
        );
      }
      return await this.parse(
        pending,
        responseSchema,
        this.profileCatalogMaxResponseBytes,
      );
    } finally {
      pending.dispose();
    }
  }

  async getProject(
    profileId: string,
    baseUrl: string,
    projectId: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationProject | null> {
    return this.getOptional(
      profileId,
      baseUrl,
      ROUTES.project(projectId),
      ProjectSchema,
      signal,
    );
  }

  /**
   * `POST /api/calibration-projects` — creates a `CalibrationProject` bound
   * to a printer and a filament identity, in the requested experience mode.
   * Verified against `CalibrationProjectsController.CreateProjectAsync` and
   * `CalibrationProjectService.CreateProjectAsync`/`ValidateProjectCreate`
   * at PrintFarmer commit `0720b9d146256c69fa2780c029ab5982bba509a1`
   * (contracts blob `48353af39c7f6b4d9d5e0062254e5fa648860e39`); see
   * `tests/fixtures/server-contract/calibrationProjectContracts.snapshot.ts`.
   *
   * `printerConfigurationRevision` is sent as a constant `1`.
   * `CreateProjectAsync`'s own source comment documents "Path D (#1981):
   * filament calibration is context-free" — no printer configuration
   * context is resolved for this workflow, so the server only floor-checks
   * `>= 1` and never cross-validates the value against real printer state.
   *
   * Idempotent by `(clientId, requestId)` plus a server-computed hash of
   * the body: a retried create carrying the same two ids returns the
   * existing project rather than creating a duplicate, so callers should
   * pass a fresh `requestId` only for a genuinely new attempt.
   *
   * `filamentSnapshot`/`orderedSteps`/`currentSelections` must be JSON
   * containers (object or array) — the server rejects a primitive with
   * `invalidData`. This desktop does not yet drive step ordering or
   * selections from the created project (out of scope for #798; see #794),
   * so empty containers are sent and the existing clone-based workflow
   * continues to own those concerns until #795 lands.
   */
  async createProject(
    profileId: string,
    baseUrl: string,
    request: {
      clientId: string;
      requestId: string;
      name: string;
      printerId: string;
      filamentProvider: string;
      filamentProductId: string;
      filamentProductName: string;
      filamentMaterial: string;
      experienceMode: 'Coach' | 'Expert';
    },
    signal: AbortSignal,
  ): Promise<RemoteCalibrationProjectRecord> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    const body = JSON.stringify({
      clientId: request.clientId,
      requestId: request.requestId,
      name: request.name,
      printerId: request.printerId,
      printerConfigurationRevision: 1,
      selectedToolheadId: null,
      selectedToolheadIndex: null,
      filamentProvider: request.filamentProvider,
      filamentProductId: request.filamentProductId,
      filamentSku: null,
      filamentVendor: null,
      filamentProductName: request.filamentProductName,
      filamentMaterial: request.filamentMaterial,
      filamentDiameter: null,
      filamentColor: null,
      filamentTypeId: null,
      spoolmanFilamentId: null,
      localSpoolId: null,
      spoolmanSpoolId: null,
      filamentSnapshot: {},
      orderedSteps: [],
      currentStep: null,
      currentSelections: {},
      experienceMode: request.experienceMode,
    });
    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.projects,
      { method: 'POST', headers, body },
      signal,
      true,
    );
    try {
      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          true,
          pending.timedOut(),
        );
      }
      return await this.parse(pending, ProjectRecordSchema);
    } finally {
      pending.dispose();
    }
  }

  async getAttempt(
    profileId: string,
    baseUrl: string,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationAttempt | null> {
    return this.getOptional(
      profileId,
      baseUrl,
      ROUTES.attempt(attemptId),
      AttemptSchema,
      signal,
    );
  }

  async getPhoto(
    profileId: string,
    baseUrl: string,
    photoId: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationPhoto | null> {
    return this.getOptional(
      profileId,
      baseUrl,
      ROUTES.photo(photoId),
      PhotoSchema,
      signal,
    );
  }

  /**
   * Stream upload a staged photo file. The main process reads bytes from disk
   * (never the renderer); this method uploads with a bounded body limit.
   *
   * @param photoId - Client-generated stable photo ID
   * @param photoBytes - The photo bytes (main process reads from approvedPath)
   * @param mimeType - MIME type of the photo
   * @param contentHash - SHA-256 of the photo content (for integrity)
   * @param operationId - Idempotency key
   */
  async uploadPhoto(
    profileId: string,
    baseUrl: string,
    photoId: string,
    photoBytes: Uint8Array,
    mimeType: string,
    contentHash: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (photoBytes.byteLength > this.maxPhotoBytes) {
      throw new CalibrationHttpError(
        'invalidData',
        `Photo exceeds maximum size of ${this.maxPhotoBytes} bytes.`,
      );
    }
    const headers: Record<string, string> = {
      'content-type': mimeType,
      'content-length': String(photoBytes.byteLength),
      'x-content-sha256': contentHash,
      'idempotency-key': operationId,
    };
    // Use ArrayBuffer for the body so TypeScript's BodyInit is satisfied across all targets
    const body: ArrayBuffer =
      photoBytes.buffer instanceof ArrayBuffer
        ? photoBytes.buffer.slice(
            photoBytes.byteOffset,
            photoBytes.byteOffset + photoBytes.byteLength,
          )
        : new Uint8Array(photoBytes).buffer;
    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.photoUpload(photoId),
      { method: 'PUT', headers, body },
      signal,
      true,
    );
    try {
      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          true,
          pending.timedOut(),
        );
      }
      await discard(pending.response);
    } finally {
      pending.dispose();
    }
  }

  async getOrchestrationStatus(
    profileId: string,
    baseUrl: string,
    orchestrationId: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationOrchestrationStatus> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.orchestrationStatus(orchestrationId),
      OrchestrationStatusSchema,
      signal,
    );
  }

  async getQueueJob(
    profileId: string,
    baseUrl: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<RemoteJobQueueJob | null> {
    return this.getOptional(
      profileId,
      baseUrl,
      ROUTES.jobQueueJob(jobId),
      JobQueueJobSchema,
      signal,
    );
  }

  /**
   * Poll the job-queue change feed for new events since `afterSequence`.
   *
   * Uses ROUTES.jobQueueChanges: GET /api/job-queue/changes?afterSequence=&limit=
   *
   * Envelope `schemaVersion` is "3". Use `nextSequence` as the cursor on the
   * next poll. If any gap is detected (missing sequence numbers) the caller
   * must refetch job state via REST.
   *
   * NOTE: Printer-group envelopes are REDACTED — never treat them as job state.
   *       Subscribe via SubscribeToQueueJobAsync(jobId) for full job envelopes.
   */
  async getQueueChanges(
    profileId: string,
    baseUrl: string,
    afterSequence: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<RemoteJobQueueChangeFeedPage> {
    const query = new URLSearchParams({
      afterSequence: String(afterSequence),
      limit: String(Math.min(limit, 500)),
    });
    return this.get(
      profileId,
      baseUrl,
      `${ROUTES.jobQueueChanges}?${query.toString()}`,
      JobQueueChangeFeedPageSchema,
      signal,
    );
  }

  /**
   * Fetch subscription resources: lists active job, printer, and project IDs
   * the client should subscribe to via SignalR.
   *
   * Uses ROUTES.jobQueueSubscriptionResources: GET /api/job-queue/subscription-resources
   *
   * Active states: Queued | Assigned | Starting | Printing | Paused.
   */
  async getQueueSubscriptionResources(
    profileId: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<RemoteQueueSubscriptionResources> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.jobQueueSubscriptionResources,
      QueueSubscriptionResourcesSchema,
      signal,
    );
  }

  /**
   * Create a FilamentCalibration queue job via POST /api/job-queue.
   *
   * 201 → new job (reads `Location` header for job ID and `ETag` / `X-Dispatch-State-ETag` headers for ETags).
   * 200 with `Idempotency-Replayed: true` → exact replay; reads existing job from response body.
   */
  async createQueueJob(
    profileId: string,
    baseUrl: string,
    dto: {
      gcodeFileId: string;
      assignedPrinterId: string;
      operationId: string;
      calibrationProjectId?: string;
      calibrationAttemptId?: string;
      calibrationOrchestrationId?: string;
      pinnedPrinterConfigRevision: number | null;
      gcodeContentSha256: string | null;
      specificationSha256: string | null;
      machineProfileSha256: string | null;
      processProfileSha256: string | null;
      filamentProfileSha256: string | null;
      printerConfigSnapshotSha256: string | null;
      requiredFirmwareFamily: string | null;
      requiredGcodeDialect: string | null;
      requiredSlicerEngine: string | null;
      requiredSlicerDistribution: string | null;
      requiredSlicerVersion: string | null;
      requiredSlicerContainerDigest: string | null;
    },
    signal: AbortSignal,
  ): Promise<CreateQueueJobResult> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': dto.operationId,
    };

    const body: Record<string, unknown> = {
      gcodeFileId: dto.gcodeFileId,
      jobKind: 'FilamentCalibration',
      idempotencyKey: dto.operationId,
      idempotencyScope: dto.calibrationProjectId
        ? `calib-project-${dto.calibrationProjectId}`
        : undefined,
      assignedPrinterId: dto.assignedPrinterId,
      calibrationProjectId: dto.calibrationProjectId,
      calibrationAttemptId: dto.calibrationAttemptId,
      calibrationOrchestrationId: dto.calibrationOrchestrationId,
      pinnedPrinterConfigRevision: dto.pinnedPrinterConfigRevision,
      requiredFirmwareFamily: dto.requiredFirmwareFamily,
      requiredGcodeDialect: dto.requiredGcodeDialect,
      requiredSlicerEngine: dto.requiredSlicerEngine,
      requiredSlicerDistribution: dto.requiredSlicerDistribution,
      requiredSlicerVersion: dto.requiredSlicerVersion,
      requiredSlicerContainerDigest: dto.requiredSlicerContainerDigest,
      gcodeContentSha256: dto.gcodeContentSha256,
      specificationSha256: dto.specificationSha256,
      machineProfileSha256: dto.machineProfileSha256,
      processProfileSha256: dto.processProfileSha256,
      filamentProfileSha256: dto.filamentProfileSha256,
      printerConfigSnapshotSha256: dto.printerConfigSnapshotSha256,
      copies: 1,
    };

    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.jobQueue,
      { method: 'POST', headers, body: JSON.stringify(body) },
      signal,
      true,
    );
    try {
      if (pending.response.status === 409) {
        throw await this.statusError(
          pending.response,
          true,
          pending.timedOut(),
        );
      }
      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          true,
          pending.timedOut(),
        );
      }
      const replayed =
        pending.response.headers.get('idempotency-replayed') === 'true';

      // Extract ETags — server quotes them: `"base64..."` — strip quotes.
      const stripQuotes = (s: string | null): string | null => {
        if (s === null) return null;
        return s.replace(/^W\/"?|"$/g, '').replace(/^"/, '');
      };

      const parsedBody = await this.parse(pending, JobQueueJobSchema);
      const etagHeader = pending.response.headers.get('etag');
      const dispatchEtagHeader = pending.response.headers.get(
        'x-dispatch-state-etag',
      );
      const rowVersion = parsedBody.rowVersion ?? stripQuotes(etagHeader);
      const dispatchStateRowVersion =
        parsedBody.dispatchStateRowVersion ?? stripQuotes(dispatchEtagHeader);

      // For 201 Created, get job ID from Location header or body.
      let jobId: string = parsedBody.id;
      if (pending.response.status === 201) {
        const locationHeader = pending.response.headers.get('location');
        if (locationHeader) {
          const parts = locationHeader.split('/');
          const fromLocation = parts[parts.length - 1];
          if (fromLocation && /^[0-9a-f-]{36}$/i.test(fromLocation)) {
            jobId = fromLocation;
          }
        }
      }

      return {
        jobId,
        rowVersion,
        dispatchStateRowVersion,
        replayed,
      };
    } finally {
      pending.dispose();
    }
  }

  /**
   * Acknowledge bed clear and start dispatch for an exact queue job.
   *
   * Requires THREE preconditions (all returning 428 if missing):
   *   - `Idempotency-Key` header
   *   - `If-Match` header (job rowVersion, opaque base-64)
   *   - `X-Dispatch-State-If-Match` header (dispatch state rowVersion, opaque base-64)
   *
   * A 412 `dispatch_revision_conflict` response body carries the CURRENT ETags
   * for retry — returned as `kind: 'revisionConflict'` rather than thrown.
   */
  async acknowledgeBedClearAndStart(
    profileId: string,
    baseUrl: string,
    jobId: string,
    printerId: string,
    operationId: string,
    rowVersion: string,
    dispatchStateRowVersion: string,
    expectedPrinterConfigRevision: number | null | undefined,
    signal: AbortSignal,
  ): Promise<AcknowledgeBedClearResult> {
    const [ikHeader, ifMatchHeader, dispatchIfMatchHeader] =
      BED_CLEAR_PRECONDITION_HEADER_NAMES;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [ikHeader]: operationId,
      [ifMatchHeader]: rowVersion,
      [dispatchIfMatchHeader]: dispatchStateRowVersion,
    };
    const bodyObj: Record<string, unknown> = {
      printerId,
      idempotencyKey: operationId,
    };
    if (expectedPrinterConfigRevision != null) {
      bodyObj.expectedPrinterConfigRevision = expectedPrinterConfigRevision;
    }

    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.acknowledgeBedClearAndStart(jobId),
      { method: 'POST', headers, body: JSON.stringify(bodyObj) },
      signal,
      true,
    );
    try {
      // 412 — dispatch_revision_conflict: parse body to extract current ETags
      if (pending.response.status === 412) {
        let conflictBody: {
          jobETag: string | null;
          dispatchStateETag: string | null;
        } = {
          jobETag: null,
          dispatchStateETag: null,
        };
        try {
          const rawBody = await this.readBody(pending);
          if (rawBody.length > 0) {
            const parsed = AcknowledgeBedClearConflictSchema.parse(
              JSON.parse(rawBody),
            );
            conflictBody = {
              jobETag: parsed.jobETag,
              dispatchStateETag: parsed.dispatchStateETag,
            };
          }
        } catch {
          // Best-effort parse; fall through to error if ETags absent
        }
        if (
          conflictBody.jobETag === null ||
          conflictBody.dispatchStateETag === null
        ) {
          throw new CalibrationHttpError(
            'dispatchRevisionConflict',
            'Dispatch revision conflict — current ETags unavailable.',
            412,
            null,
            pending.ambiguous,
          );
        }
        return {
          kind: 'revisionConflict',
          jobETag: conflictBody.jobETag,
          dispatchStateETag: conflictBody.dispatchStateETag,
        };
      }

      // 409 — map error code to typed error
      if (pending.response.status === 409) {
        const envelope = await this.readJobErrorEnvelope(pending);
        const code409 = mapBedClearErrorCode409(envelope.error);
        throw new CalibrationHttpError(
          code409,
          `Bed-clear conflict: ${envelope.error ?? 'conflict'}`,
          409,
          null,
          pending.ambiguous,
          envelope.detail,
          null,
          envelope.error,
        );
      }

      // 422 — map error code to typed error
      if (pending.response.status === 422) {
        const envelope = await this.readJobErrorEnvelope(pending);
        const code422 = mapBedClearErrorCode422(envelope.error);
        throw new CalibrationHttpError(
          code422,
          `Bed-clear validation failed: ${envelope.error ?? 'invalid'}`,
          422,
          null,
          pending.ambiguous,
          envelope.detail,
          null,
          envelope.error,
        );
      }

      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          true,
          pending.timedOut(),
        );
      }

      // 202 Accepted or 200 OK (idempotent replay)
      const parsedSuccess = await this.parse(
        pending,
        AcknowledgeBedClearSuccessSchema,
      );
      return {
        kind: 'ok',
        jobETag: parsedSuccess.jobETag,
        dispatchStateETag: parsedSuccess.dispatchStateETag,
      };
    } finally {
      pending.dispose();
    }
  }

  // --- Private implementation -----------------------------------------------

  private async get<T>(
    profileId: string,
    baseUrl: string,
    resource: string,
    schema: ZodType.ZodType<T, ZodType.ZodTypeDef, unknown>,
    signal: AbortSignal,
    maxAttempts = 4,
    maxBytes: number = this.maxResponseBytes,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const pending = await this.request(
          profileId,
          baseUrl,
          resource,
          { method: 'GET' },
          signal,
          false,
        );
        try {
          if (!pending.response.ok) {
            throw await this.statusError(
              pending.response,
              false,
              pending.timedOut(),
            );
          }
          return await this.parse(pending, schema, maxBytes);
        } finally {
          pending.dispose();
        }
      } catch (error) {
        const mapped = mapError(error, signal, false);
        attempt += 1;
        if (
          attempt >= maxAttempts ||
          !isTransient(mapped) ||
          mapped.code === 'cancelled'
        ) {
          throw mapped;
        }
        await this.sleepImpl(this.retryDelay(mapped, attempt), signal);
      }
    }
  }

  private async getOptional<T>(
    profileId: string,
    baseUrl: string,
    resource: string,
    schema: ZodType.ZodType<T, ZodType.ZodTypeDef, unknown>,
    signal: AbortSignal,
  ): Promise<T | null> {
    try {
      return await this.get(profileId, baseUrl, resource, schema, signal);
    } catch (error) {
      if (error instanceof CalibrationHttpError && error.code === 'notFound') {
        return null;
      }
      throw error;
    }
  }

  private async request(
    profileId: string,
    baseUrl: string,
    resource: string,
    init: RequestInit,
    signal: AbortSignal,
    postMayBeAmbiguous: boolean,
  ): Promise<PendingResponse> {
    if (signal.aborted) {
      throw new CalibrationHttpError(
        'cancelled',
        'Request was cancelled before it started.',
      );
    }

    // --- Profile/identity fence (before request) ---
    let context: { baseUrl: string; token: string; binding: string };
    try {
      context = await this.tokens.getAuthenticatedContext(
        profileId,
        baseUrl,
        false,
      );
    } catch {
      throw new CalibrationHttpError(
        'authentication',
        'Calibration authentication could not be obtained.',
      );
    }
    // Fence: baseUrl must not have changed since we resolved it
    if (context.baseUrl !== baseUrl) {
      throw new CalibrationHttpError(
        'authentication',
        'Server profile changed before calibration request; aborting for safety.',
      );
    }

    for (let authAttempt = 0; authAttempt < 2; authAttempt += 1) {
      if (signal.aborted) {
        throw new CalibrationHttpError('cancelled', 'Request was cancelled.');
      }
      const combined = deadlineSignal(signal, this.timeoutMs);
      try {
        // JWT is sent in Authorization header only; never logged
        const response = await this.fetchImpl(
          new URL(resource.replace(/^\//, ''), `${context.baseUrl}/`),
          {
            ...init,
            headers: {
              accept: 'application/json',
              ...init.headers,
              // NOTE: The JWT is NOT logged anywhere in this code path.
              authorization: `Bearer ${context.token}`,
            },
            signal: combined.signal,
          },
        );

        if (response.status !== 401 || authAttempt > 0) {
          // --- Profile/identity fence (after response) ---
          // Verify the profile hasn't been replaced/deleted during the request.
          let postContext: { baseUrl: string; binding: string };
          try {
            postContext = await this.tokens.getAuthenticatedContext(
              profileId,
              baseUrl,
              false,
            );
          } catch {
            await discard(response);
            combined.dispose();
            throw new CalibrationHttpError(
              'authentication',
              'Server profile was removed during calibration request.',
            );
          }
          if (
            postContext.baseUrl !== context.baseUrl ||
            postContext.binding !== context.binding
          ) {
            await discard(response);
            combined.dispose();
            throw new CalibrationHttpError(
              'authentication',
              'Server profile or binding changed during calibration request; aborting for safety.',
            );
          }

          return {
            response,
            signal: combined.signal,
            timedOut: () => combined.timedOut(),
            ambiguous: postMayBeAmbiguous,
            dispose: () => combined.dispose(),
          };
        }

        // 401 on first attempt → refresh token and retry, but only for a read.
        //
        // A rejected token is normally just an expired one, and silently
        // renewing it keeps a fifteen-minute JWT from interrupting an operator
        // mid-task. That reasoning holds for a GET and fails for anything that
        // changes state: the exchange authenticates whatever principal the
        // configured key *currently* resolves to, which is not guaranteed to be
        // the principal the operator was acting as when they pressed the button.
        // Re-issuing a queue, dispatch, generate or delete under a freshly
        // minted identity is an action nobody asked for. Mutations therefore
        // surface the 401 and wait for a deliberate retry.
        await discard(response);
        combined.dispose();
        if (!isReplayableAfterReauthentication(init.method)) {
          throw new CalibrationHttpError(
            'authentication',
            'Calibration authentication expired; the request was not retried.',
            401,
          );
        }
        try {
          context = await this.tokens.getAuthenticatedContext(
            profileId,
            baseUrl,
            true,
          );
        } catch {
          throw new CalibrationHttpError(
            'authentication',
            'Token refresh failed after 401 response from calibration API.',
            401,
          );
        }
        if (context.baseUrl !== baseUrl) {
          throw new CalibrationHttpError(
            'authentication',
            'Server profile base URL changed during token refresh.',
          );
        }
      } catch (error) {
        combined.dispose();
        throw mapError(error, signal, postMayBeAmbiguous, combined.timedOut());
      }
    }

    throw new CalibrationHttpError(
      'authentication',
      'Authentication was rejected by the calibration API.',
      401,
    );
  }

  private async parse<T>(
    pending: PendingResponse,
    schema: ZodType.ZodType<T, ZodType.ZodTypeDef, unknown>,
    maxBytes: number = this.maxResponseBytes,
  ): Promise<T> {
    const body = await this.readBody(pending, maxBytes);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new CalibrationHttpError(
        'invalidResponse',
        'Calibration API returned non-JSON body.',
      );
    }
    try {
      return schema.parse(json);
    } catch (error) {
      throw new CalibrationHttpError(
        'invalidResponse',
        `Calibration API response validation failed: ${describeValidationError(error)}`,
      );
    }
  }

  private async readBody(
    pending: PendingResponse,
    maxBytes: number = this.maxResponseBytes,
  ): Promise<string> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      if (!pending.response.body) {
        return '';
      }
      const reader = pending.response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new CalibrationHttpError(
            'bodyTooLarge',
            `Calibration API response exceeded ${maxBytes} byte limit.`,
            pending.response.status,
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof CalibrationHttpError) throw error;
      throw mapError(
        error,
        pending.signal,
        pending.ambiguous,
        pending.timedOut(),
      );
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }

  /**
   * Read a `{ "error": "code", "detail": "…" }` refusal envelope from a
   * PrintFarmer job-queue endpoint. Live wire capture (2026-08-21) shows
   * these controllers respond with `application/json` on well-formed
   * refusals — 428 `precondition_required`, 404 `job_not_found`, 409
   * `printer_busy` — but the same controllers can also return `text/plain`
   * from generic paths (`NotFound()` no-arg, `NotFound("Thumbnail not
   * available")`). Feeding those through `JSON.parse` unconditionally used
   * to throw and be silently swallowed by the try/catch, so the operator saw
   * only the catalogued fallback and never the text the server sent.
   *
   * A text/plain body is now carried through as `detail` verbatim, trimmed
   * and truncated to the same 4096-char bound the `RemoteCalibrationProblemDetails`
   * schema applies to `detail`. `error` (the machine code) can only come from
   * the JSON path — a text/plain refusal has no code — so callers should
   * expect `error` to be `null` when only `detail` is populated.
   *
   * `error` is truncated to 64 chars (issue #743), the same way `detail` is
   * truncated to 4096 above, rather than left unbounded. This value flows
   * straight into `CalibrationHttpError.serverErrorCode` at the 409/422
   * call sites below and from there onto `CalibrationApiError.blockedReasonCode`
   * (bounded 64 in `src/shared/ipc.ts`); an unbounded `error` here let a
   * 65-256-char server value pass this read and then throw a Zod validation
   * exception at IPC serialization instead of failing closed.
   */
  private async readJobErrorEnvelope(
    pending: PendingResponse,
  ): Promise<{ error: string | null; detail: string | null }> {
    let error: string | null = null;
    let detail: string | null = null;
    try {
      const rawBody = await this.readBody(pending);
      if (rawBody.length > 0) {
        const contentType =
          pending.response.headers.get('content-type')?.toLowerCase() ?? '';
        const isJson =
          contentType.startsWith('application/json') ||
          contentType.startsWith('application/problem+json');
        const isPlainText = contentType.startsWith('text/plain');
        if (isJson || (!isPlainText && contentType === '')) {
          const parsed = JSON.parse(rawBody) as {
            error?: unknown;
            detail?: unknown;
          };
          if (typeof parsed.error === 'string') {
            error =
              parsed.error.length > 64
                ? parsed.error.slice(0, 64)
                : parsed.error;
          }
          if (typeof parsed.detail === 'string') {
            detail =
              parsed.detail.length > 4096
                ? parsed.detail.slice(0, 4096)
                : parsed.detail;
          }
        } else if (isPlainText) {
          const trimmed = rawBody.trim();
          detail = trimmed.length > 4096 ? trimmed.slice(0, 4096) : trimmed;
        }
      }
    } catch {
      // Non-JSON payload on a JSON content-type; fall through with nulls so
      // the catalogued refusal string still names the failure.
    }
    return { error, detail };
  }

  private async statusError(
    response: Response,
    ambiguous: boolean,
    timedOut: boolean,
  ): Promise<CalibrationHttpError> {
    // Read ProblemDetails for operator context. This text is server-controlled
    // and never becomes the error's `message` -- see issue #177 and the
    // `serverDetail` docblock on CalibrationHttpError.
    //
    // Parsed through `RemoteCalibrationProblemDetails` (issue #370) rather
    // than a hand-rolled cast, so `instance` and `errorCode` are preserved
    // and the schema's own per-field bounds (`detail` <= 4096 chars, etc.)
    // apply -- not a bound on the whole JSON body, which would reject a
    // contract-legal maximal `detail` before it could be read. The body-size
    // check here is a coarse DoS guard only, reusing the client's configured
    // response cap; it is not a stand-in for the schema's field validation.
    //
    // Content-type sniff before JSON.parse (2026-08-21): live PrintFarmer
    // returns `text/plain` bodies from several error paths -- notably
    // `GcodeFilesController.NotFound("Thumbnail not available")`. Feeding
    // those through `JSON.parse` used to *silently discard the body* via the
    // outer try/catch, so the operator saw only the catalogued fallback and
    // never the string the server actually sent. A text/plain body is now
    // carried through as `detail` verbatim, trimmed and truncated to the
    // schema's `detail` limit so the caller cannot ship an unbounded string.
    let detail: string | null = null;
    let instance: string | null = null;
    let errorCode: string | null = null;
    try {
      const body = await response.text();
      if (body.length > 0 && body.length <= this.maxResponseBytes) {
        const contentType =
          response.headers.get('content-type')?.toLowerCase() ?? '';
        const isJson =
          contentType.startsWith('application/json') ||
          contentType.startsWith('application/problem+json');
        const isPlainText = contentType.startsWith('text/plain');
        if (isJson || (!isPlainText && contentType === '')) {
          // JSON, or an unlabelled body we can best-effort parse as JSON --
          // the pre-content-type-check behaviour, preserved so a server that
          // omits `Content-Type` on a JSON body still works.
          const json: unknown = JSON.parse(body);
          const parsed = RemoteCalibrationProblemDetails.safeParse(json);
          if (parsed.success) {
            // `title` is as server-controlled as `detail`; both are untrusted
            // and both are carried on `serverDetail` only.
            detail = parsed.data.detail ?? parsed.data.title ?? null;
            instance = parsed.data.instance ?? null;
            errorCode = parsed.data.errorCode ?? null;
          }
        } else if (isPlainText) {
          // Truncate to the same bound the JSON schema would apply to
          // `detail`, so a text/plain path cannot ship a longer server string
          // than the JSON path can.
          const trimmed = body.trim();
          detail = trimmed.length > 4096 ? trimmed.slice(0, 4096) : trimmed;
        }
      }
    } catch {
      // Non-JSON error body; ignore
    }
    // The catalogued string is what the user sees. It used to be a *fallback*
    // -- `detail ?? fallback` -- so the untrusted value silently outranked all
    // eleven reviewed literals below whenever the server supplied one.
    //
    // `fail` exists so the server text cannot be forgotten at a call site: it
    // attaches `serverDetail` on every arm, and any new arm that uses it gets
    // the same treatment without the author having to remember a sixth
    // positional argument.
    const fail = (
      code: CalibrationHttpErrorCode,
      catalogued: string,
      status: number | null,
      retryAfterMs: number | null = null,
      isAmbiguous = false,
    ) =>
      new CalibrationHttpError(
        code,
        catalogued,
        status,
        retryAfterMs,
        isAmbiguous,
        detail,
        instance,
        errorCode,
      );

    // HTTP semantic mapping (issue #52 contract)
    switch (response.status) {
      case 400:
        return fail(
          'invalidData',
          'Invalid calibration request.',
          400,
          null,
          ambiguous,
        );
      case 401:
        return fail(
          'authentication',
          'Calibration authentication required.',
          401,
        );
      case 403:
        return fail('authorization', 'Calibration access denied.', 403);
      case 404:
        return fail('notFound', 'Calibration resource not found.', 404);
      case 409:
        return fail(
          'idempotencyPayloadChanged',
          'Idempotency key payload changed.',
          409,
          null,
          ambiguous,
        );
      case 412:
        return fail(
          'revisionConflict',
          'Revision precondition failed (If-Match).',
          412,
          null,
          ambiguous,
        );
      case 422:
        return fail(
          'invalidData',
          'Calibration data is invalid or unsafe.',
          422,
          null,
          ambiguous,
        );
      case 428:
        return fail(
          'preconditionRequired',
          'Base revision is required for this calibration operation.',
          428,
        );
      case 503:
        // A 503 from calibration discovery is NOT interchangeable with a
        // slicer-worker outage. `PrinterCalibrationController.CreateProblem`
        // maps `profile_service_unavailable` (the upstream OrcaSlicer profile
        // resolver being unreachable) and `status_unavailable` (printer status
        // not readable) onto the same status code as worker faults. Collapsing
        // all three into `workerUnavailable` told operators to look at the
        // slicing fleet when the actual missing dependency is the profile
        // resolver, which is exactly the production state on 0.2.3 and exactly
        // what `unavailableReasons[].code` reports. Discriminating on the
        // server-supplied `code` extension keeps the three separable.
        if (errorCode === 'profile_service_unavailable') {
          return fail(
            'profileServiceUnavailable',
            'PrintFarmer cannot reach its upstream OrcaSlicer profile resolver, so it cannot list calibration printers.',
            503,
            null,
            ambiguous,
          );
        }
        if (errorCode === 'status_unavailable') {
          return fail(
            'printerStatusUnavailable',
            'PrintFarmer could not read live printer status for this calibration request.',
            503,
            null,
            ambiguous,
          );
        }
        return fail(
          'workerUnavailable',
          'Calibration generation or telemetry service is unavailable.',
          503,
          null,
          ambiguous,
        );
      default: {
        if (timedOut) {
          return fail(
            'timeout',
            'Calibration request timed out.',
            null,
            null,
            ambiguous,
          );
        }
        if (TRANSIENT_STATUSES.has(response.status)) {
          const retryAfter = response.headers.get('retry-after');
          const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;
          const code: CalibrationHttpErrorCode =
            response.status === 429 ? 'rateLimited' : 'server';
          return fail(
            code,
            `Calibration server error (${response.status}).`,
            response.status,
            retryMs,
            ambiguous,
          );
        }
        return fail(
          'server',
          `Calibration request failed (${response.status}).`,
          response.status,
          null,
          ambiguous,
        );
      }
    }
  }

  private retryDelay(error: CalibrationHttpError, attempt: number): number {
    if (error.retryAfterMs !== null) return error.retryAfterMs;
    const base = 500;
    const max = 30_000;
    const jitter = this.random() * 0.2;
    return Math.min(base * Math.pow(2, attempt - 1) * (1 + jitter), max);
  }
}
