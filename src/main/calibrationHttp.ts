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

// --- Fixed API route constants ---------------------------------------------
// These are the only routes this client will ever call. The renderer cannot
// influence them.

const ROUTES = {
  capabilities: '/api/calibration/capabilities',
  printers: '/api/calibration/printers',
  printerContext: (printerId: string) =>
    `/api/calibration/printers/${encodeURIComponent(printerId)}/context`,
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
    `/api/calibration-projects/${encodeURIComponent(projectId)}/attempts/${encodeURIComponent(attemptId)}/generate-job`,
  /** GET — polls orchestration status by orchestration ID. */
  orchestrationStatus: (orchestrationId: string) =>
    `/api/calibration-orchestrations/${encodeURIComponent(orchestrationId)}`,
  // --- Primary job-queue REST (issue #900) ------------------------------------
  /** POST — create a queue job. */
  jobQueue: '/api/job-queue',
  /** GET — fetch a single queue job by ID. */
  jobQueueJob: (jobId: string) => `/api/job-queue/${encodeURIComponent(jobId)}`,
  /** GET — change feed cursor poll. */
  jobQueueChanges: '/api/job-queue/changes',
  /** GET — subscription resources hint. */
  jobQueueSubscriptionResources: '/api/job-queue/subscription-resources',
  /** POST — acknowledge bed clear and start dispatch. */
  acknowledgeBedClearAndStart: (jobId: string) =>
    `/api/job-queue/${encodeURIComponent(jobId)}/acknowledge-bed-clear-and-start`,
} as const;

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
  // --- Bed-clear / queue specific (issue #54) ---
  | 'forbidden'
  | 'jobNotFound'
  | 'wrongJob'
  | 'printerBusy'
  | 'jobNotDispatchable'
  | 'dispatchRevisionConflict'
  | 'calibrationJobIncompatible'
  | 'filamentCheckFailed';

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
 * Unrecognised codes fall back to 'idempotencyPayloadChanged'.
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
      return 'idempotencyPayloadChanged';
  }
}

/**
 * Map a 422 error code string from the bed-clear endpoint to a typed error code.
 * Unrecognised codes fall back to 'invalidData'.
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
      return 'invalidData';
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
      ROUTES.printers,
      PrintersSchema,
      signal,
    );
  }

  async getPrinterContext(
    profileId: string,
    baseUrl: string,
    printerId: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationPrinterContext> {
    return this.get(
      profileId,
      baseUrl,
      ROUTES.printerContext(printerId),
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
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': operationId,
      'if-match': rowVersion,
      'x-dispatch-state-if-match': dispatchStateRowVersion,
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
        let errorCode: string | null = null;
        try {
          const rawBody = await this.readBody(pending);
          if (rawBody.length > 0) {
            const parsed = JSON.parse(rawBody) as { error?: string };
            errorCode = parsed.error ?? null;
          }
        } catch {
          // ignore parse errors
        }
        const code409 = mapBedClearErrorCode409(errorCode);
        throw new CalibrationHttpError(
          code409,
          `Bed-clear conflict: ${errorCode ?? 'conflict'}`,
          409,
          null,
          pending.ambiguous,
        );
      }

      // 422 — map error code to typed error
      if (pending.response.status === 422) {
        let errorCode: string | null = null;
        try {
          const rawBody = await this.readBody(pending);
          if (rawBody.length > 0) {
            const parsed = JSON.parse(rawBody) as { error?: string };
            errorCode = parsed.error ?? null;
          }
        } catch {
          // ignore parse errors
        }
        const code422 = mapBedClearErrorCode422(errorCode);
        throw new CalibrationHttpError(
          code422,
          `Bed-clear validation failed: ${errorCode ?? 'invalid'}`,
          422,
          null,
          pending.ambiguous,
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

        // 401 on first attempt → refresh token and retry
        await discard(response);
        combined.dispose();
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

  private async statusError(
    response: Response,
    ambiguous: boolean,
    timedOut: boolean,
  ): Promise<CalibrationHttpError> {
    // Read ProblemDetails for operator context. This text is server-controlled
    // and never becomes the error's `message` -- see issue #177 and the
    // `serverDetail` docblock on CalibrationHttpError.
    let detail: string | null = null;
    try {
      const body = await response.text();
      if (body.length > 0 && body.length < 4096) {
        const parsed = JSON.parse(body) as {
          detail?: string;
          title?: string;
          errorCode?: string;
        };
        // `title` is as server-controlled as `detail`; both are untrusted and
        // both are carried on `serverDetail` only.
        detail = parsed.detail ?? parsed.title ?? null;
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
