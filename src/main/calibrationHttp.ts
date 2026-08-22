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
import { CalibrationApiError, type CalibrationApiErrorCode } from '@shared/ipc';
import type {
  RemoteCalibrationApplyRequest,
  RemoteCalibrationApplyResult,
  RemoteCalibrationChangesPage,
  RemoteCalibrationProject,
  RemoteCalibrationStep,
  RemoteCalibrationAttempt,
  RemoteCalibrationPhoto,
  RemoteCalibrationCapabilities,
  RemoteCalibrationPrinters,
  RemoteCalibrationPrinterContext,
  RemoteCalibrationOrchestrationStatus,
  RemoteJobQueueJob,
  RemoteJobQueueChangeFeedPage,
  RemoteQueueSubscriptionResources,
} from './calibrationWire.js';
import {
  RemoteCalibrationApplySuccess,
  RemoteCalibrationApplyConflict,
  RemoteCalibrationProblemDetails,
  RemoteCalibrationChangesPage as ChangesPageSchema,
  RemoteCalibrationCapabilities as CapabilitiesSchema,
  RemoteCalibrationProject as ProjectSchema,
  RemoteCalibrationStep as StepSchema,
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
} from './calibrationWire.js';

// --- Issue-#138 route templates (single authoritative source) ----------------
// The four parity-guarded contract routes are defined here as templates; ROUTES
// derives those four entries from them. Mutating a template changes the actual
// HTTP call path and fails the executable fetch parity tests.

/**
 * Normalized route templates for the four issue-#138 contract paths.
 * Parameters use `{name}` placeholders. Each template is the single source
 * from which the corresponding `ROUTES` entry (and executable HTTP call) is
 * derived via `buildRoute`. Exported so documentation-parity tests can compare
 * these values against admin guide §10.1 without a second policy table.
 * Source: OlyForge3D/PrintFarmer JobQueueController + CalibrationGenerationController,
 * verified at 167a3b134a678a0d9a8c10371da8333d03ddc636 and 9c1d7e4b97c5f0fee0f0c702aa864374b3e21cf0.
 */
export const CALIBRATION_QUEUE_ROUTE_TEMPLATES = {
  /** POST — create a FilamentCalibration queue job. */
  jobQueue: '/api/job-queue',
  /** GET — fetch a specific queue job by its ID. */
  jobQueueJob: '/api/job-queue/{jobId}',
  /** POST — start generation for one immutable attempt; both IDs required. */
  generateJob:
    '/api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job',
  /** POST — acknowledge bed clear and start dispatch for an exact job. */
  acknowledgeBedClear: '/api/job-queue/{jobId}/acknowledge-bed-clear-and-start',
} as const;

/**
 * Canonical printer-discovery route templates (issue: calibration discovery
 * 404 drift).
 *
 * These are the two routes the calibration wizard needs before it can show a
 * single printer. They are NOT under `/api/calibration/...`: PrintFarmer serves
 * them from `PrinterCalibrationController`, which is `[Route("api/printers")]`.
 *
 * Verified three ways against production `0.2.3+125d2c9b2`:
 * 1. `PrinterCalibrationController.cs` on OlyForge3D/PrintFarmer@development —
 *    `[HttpGet("calibration-candidates")]` and
 *    `[HttpGet("{id:guid}/calibration-context")]`.
 * 2. The live `GET /api/calibration/capabilities` payload, whose `routes`
 *    member advertises exactly these two paths.
 * 3. Live GET probes: the previous `/api/calibration/printers` returns 404
 *    while `/api/printers/calibration-candidates` returns 401 unauthenticated.
 *
 * `slicerType` is a REQUIRED query parameter on the context route. The server
 * compares it with `StringComparison.Ordinal` against
 * `CalibrationContractConstants.SlicerEngine` and returns HTTP 400
 * `unsupported_slicer_type` when it is absent or differs by case. It is pinned
 * here rather than derived from a response so a server-supplied value can never
 * steer the request.
 */
export const CALIBRATION_DISCOVERY_ROUTE_TEMPLATES = {
  /** GET — printers the server considers calibration candidates. */
  calibrationCandidates: '/api/printers/calibration-candidates',
  /** GET — per-printer calibration context; `slicerType` is mandatory. */
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
// influence them. The four contract-critical routes derive from
// CALIBRATION_QUEUE_ROUTE_TEMPLATES so a template mutation changes the call.

const ROUTES = {
  capabilities: '/api/calibration/capabilities',
  /** GET — canonical calibration candidate list (see templates above). */
  printerCandidates:
    CALIBRATION_DISCOVERY_ROUTE_TEMPLATES.calibrationCandidates,
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
  project: (id: string) =>
    `/api/calibration-projects/${encodeURIComponent(id)}`,
  projectSteps: (projectId: string) =>
    `/api/calibration-projects/${encodeURIComponent(projectId)}/steps`,
  projectAttempts: (projectId: string, stepId: string) =>
    `/api/calibration-projects/${encodeURIComponent(projectId)}/steps/${encodeURIComponent(stepId)}/attempts`,
  attempt: (id: string) =>
    `/api/calibration-attempts/${encodeURIComponent(id)}`,
  photo: (id: string) => `/api/calibration-photos/${encodeURIComponent(id)}`,
  photoUpload: (id: string) =>
    `/api/calibration-photos/${encodeURIComponent(id)}/upload`,
  profileRevisions: (projectId: string) =>
    `/api/calibration-projects/${encodeURIComponent(projectId)}/profile-revisions`,
  // --- Generation orchestration (issue #899) ---------------------------------
  /** POST — starts generation for a specific attempt. */
  generateJob: (projectId: string, attemptId: string) =>
    buildRoute(CALIBRATION_QUEUE_ROUTE_TEMPLATES.generateJob, {
      projectId,
      attemptId,
    }),
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
  | 'unclassifiedValidationFailure';

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

// --- Main client class ----------------------------------------------------

export class CalibrationHttpClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxResponseBytes: number;
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

  async getProjectSteps(
    profileId: string,
    baseUrl: string,
    projectId: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationStep[]> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.projectSteps(projectId),
      z.array(StepSchema).max(50),
      signal,
    );
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

  async getProjectAttempts(
    profileId: string,
    baseUrl: string,
    projectId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationAttempt[]> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.projectAttempts(projectId, stepId),
      z.array(AttemptSchema).max(999),
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

  async startGeneration(
    profileId: string,
    baseUrl: string,
    projectId: string,
    attemptId: string,
    method: string,
    definitionVersion: string | undefined,
    options: Record<string, unknown> | undefined,
    operationId: string,
    baseRevision: number | null,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationOrchestrationStatus> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': operationId,
    };
    const body: Record<string, unknown> = { method };
    if (definitionVersion !== undefined)
      body.definitionVersion = definitionVersion;
    if (options !== undefined) body.options = options;
    if (baseRevision !== null) body.baseRevision = baseRevision;

    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.generateJob(projectId, attemptId),
      { method: 'POST', headers, body: JSON.stringify(body) },
      signal,
      true,
    );
    try {
      if (pending.response.status === 409 || pending.response.status === 412) {
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
      return await this.parse(pending, OrchestrationStatusSchema);
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
          return await this.parse(pending, schema);
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
  ): Promise<T> {
    const body = await this.readBody(pending);
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

  private async readBody(pending: PendingResponse): Promise<string> {
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
        if (totalBytes > this.maxResponseBytes) {
          await reader.cancel();
          throw new CalibrationHttpError(
            'bodyTooLarge',
            `Calibration API response exceeded ${this.maxResponseBytes} byte limit.`,
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
