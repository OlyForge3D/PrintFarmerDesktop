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
  // Generation: POST /api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job
  // (PR #979 / 167a3b134a678a0d9a8c10371da8333d03ddc636)
  generateJob: (projectId: string, attemptId: string) =>
    `/api/calibration-projects/${encodeURIComponent(projectId)}/attempts/${encodeURIComponent(attemptId)}/generate-job`,
  // Orchestration status: GET /api/calibration-orchestrations/{id}
  orchestrationStatus: (orchestrationId: string) =>
    `/api/calibration-orchestrations/${encodeURIComponent(orchestrationId)}`,
  // Job queue: GET /api/job-queue/{id}
  jobQueueJob: (jobId: string) => `/api/job-queue/${encodeURIComponent(jobId)}`,
  // Bed-clear and start: POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start
  // (PR #979 / 167a3b134a678a0d9a8c10371da8333d03ddc636)
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
  /** Bed-clear: 409 wrong_job — the acknowledgement names a different job. */
  | 'wrongJob'
  /** Bed-clear: 409 printer_busy — printer is busy with another job. */
  | 'printerBusy'
  /** Bed-clear: 409 job_not_dispatchable — job is not dispatchable. */
  | 'jobNotDispatchable'
  /** Bed-clear: 422 calibration_job_incompatible — compatibility tuple invalid. */
  | 'calibrationJobIncompatible';

/** Typed outcome of a `POST …/acknowledge-bed-clear-and-start` request. */
export type BedClearAckOutcome =
  | { kind: 'starting'; jobId: string }
  | { kind: 'alreadyStarting'; jobId: string }
  | {
      kind: 'conflict';
      reason: string;
      detail: string | null;
    }
  | { kind: 'staleRevision' }
  | { kind: 'printerOffline'; detail: string | null }
  | { kind: 'preconditionRequired'; detail: string | null };

export class CalibrationHttpError extends Error {
  constructor(
    readonly code: CalibrationHttpErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'CalibrationHttpError';
  }

  /** Map this transport-layer error to the IPC-level CalibrationApiError type. */
  toApiError(): z.infer<typeof CalibrationApiError> {
    const codeMap: Partial<
      Record<CalibrationHttpErrorCode, CalibrationApiErrorCode>
    > = {
      preconditionRequired: 'preconditionRequired',
      revisionConflict: 'revisionConflict',
      idempotencyPayloadChanged: 'idempotencyPayloadChanged',
      invalidData: 'invalidData',
      workerUnavailable: 'workerUnavailable',
      server: 'serverError',
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
    };
  }
}

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

  /**
   * Start or resume the durable calibration generation saga for an attempt.
   * Maps to `POST /api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job`
   * (PR #979 / 167a3b134a678a0d9a8c10371da8333d03ddc636).
   *
   * Headers:
   * - `Idempotency-Key`: stable client-generated UUID for exact-replay detection
   *
   * Body: typed `CalibrationGenerateJobRequest` with method, definitionVersion, options, baseRevision.
   *
   * Responses: 202 (new/resumed), 200 (exact replay), 409/412/422/503 on failure.
   *
   * @returns The durable orchestration status (includes orchestrationId and statusRoute for polling).
   */
  async startGeneration(
    profileId: string,
    baseUrl: string,
    projectId: string,
    attemptId: string,
    operationId: string,
    method: string,
    definitionVersion: string,
    options: Record<string, unknown> | null,
    baseRevision: number | null,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationOrchestrationStatus> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'Idempotency-Key': operationId,
    };
    const body: Record<string, unknown> = { method, definitionVersion };
    if (options !== null) body.options = options;
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
      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          true,
          pending.timedOut(),
        );
      }
      const responseBody = await this.readBody(pending);
      return OrchestrationStatusSchema.parse(JSON.parse(responseBody));
    } finally {
      pending.dispose();
    }
  }

  /**
   * Fetch the durable orchestration status for REST reconciliation after restart/reconnect.
   * Maps to `GET /api/calibration-orchestrations/{id}`
   * (PR #979 / 167a3b134a678a0d9a8c10371da8333d03ddc636).
   *
   * This is the authoritative REST source for all stage display after restart;
   * SignalR progress is a hint only.
   */
  async getOrchestrationStatus(
    profileId: string,
    baseUrl: string,
    orchestrationId: string,
    signal: AbortSignal,
  ): Promise<RemoteCalibrationOrchestrationStatus | null> {
    return this.getOptional(
      profileId,
      baseUrl,
      ROUTES.orchestrationStatus(orchestrationId),
      OrchestrationStatusSchema,
      signal,
    );
  }

  /**
   * Fetch the authoritative queue job state for a single job.
   * Maps to `GET /api/job-queue/{id}`
   * (PR #979 / 167a3b134a678a0d9a8c10371da8333d03ddc636).
   *
   * The response includes `RowVersion` and `DispatchStateRowVersion` as ETags
   * in the `ETag` and `X-Dispatch-State-ETag` response headers (stored in the
   * `rowVersion` and `dispatchStateRowVersion` fields of the DTO).
   *
   * REST is authoritative; SignalR events are hints only. On reconnect or gap,
   * this endpoint must be polled to converge to authoritative state.
   */
  async getJobQueueJob(
    profileId: string,
    baseUrl: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<RemoteJobQueueJob | null> {
    const pending = await this.request(
      profileId,
      baseUrl,
      ROUTES.jobQueueJob(jobId),
      { method: 'GET' },
      signal,
      false,
    );
    try {
      if (pending.response.status === 404) {
        await discard(pending.response);
        return null;
      }
      if (!pending.response.ok) {
        throw await this.statusError(
          pending.response,
          false,
          pending.timedOut(),
        );
      }
      const body = await this.readBody(pending);
      const dto = JobQueueJobSchema.parse(JSON.parse(body));
      // Merge ETags from response headers into the DTO if present.
      // The server also provides these in the response body fields, but headers
      // are canonical and must not be overwritten with stale body values.
      const etagHeader = pending.response.headers.get('ETag');
      const dispatchEtagHeader = pending.response.headers.get(
        'X-Dispatch-State-ETag',
      );
      return {
        ...dto,
        rowVersion:
          etagHeader !== null
            ? etagHeader.replace(/^"|"$/g, '')
            : dto.rowVersion,
        dispatchStateRowVersion:
          dispatchEtagHeader !== null
            ? dispatchEtagHeader.replace(/^"|"$/g, '')
            : dto.dispatchStateRowVersion,
      };
    } finally {
      pending.dispose();
    }
  }

  /**
   * Acknowledge bed-clear and authorize dispatch for a specific job.
   * Maps to `POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start`
   * (PR #979 / 167a3b134a678a0d9a8c10371da8333d03ddc636).
   *
   * This is the single endpoint for combined bed-clear acknowledgement and print start.
   * No separate startPrint endpoint exists.
   *
   * Required headers (per PR #979 API contract):
   * - `Idempotency-Key`: stable UUID for exact-replay detection
   * - `If-Match`: base-64 ETag of the job row (from `GET /api/job-queue/{id}`)
   * - `X-Dispatch-State-If-Match`: base-64 ETag of the printer dispatch state
   *
   * Required body fields:
   * - `printerId`: UUID of the assigned printer
   *
   * Optional body fields:
   * - `expectedPrinterConfigRevision`: printer config revision at request time
   *
   * Typed outcomes (B-03):
   * - 202: newly accepted → `{ kind: 'starting', jobId }`
   * - 200: idempotent replay → `{ kind: 'alreadyStarting', jobId }`
   * - 409: wrong job/printer/state → `{ kind: 'conflict', reason, detail }`
   * - 412: stale dispatch revision → `{ kind: 'staleRevision' }` (refetch before retry)
   * - 503: printer offline/stale → `{ kind: 'printerOffline', detail }`
   * - 428: missing Idempotency-Key → `{ kind: 'preconditionRequired', detail }`
   *
   * An accepted-but-unconfirmed start remains in `Starting` state; no blind retry
   * is offered or triggered automatically (B-04).
   */
  async acknowledgeBedClear(
    profileId: string,
    baseUrl: string,
    jobId: string,
    printerId: string,
    operationId: string,
    jobEtag: string | null,
    dispatchStateEtag: string | null,
    expectedPrinterConfigRevision: number | null,
    signal: AbortSignal,
  ): Promise<BedClearAckOutcome> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'Idempotency-Key': operationId,
    };
    if (jobEtag !== null) {
      headers['If-Match'] = `"${jobEtag}"`;
    }
    if (dispatchStateEtag !== null) {
      headers['X-Dispatch-State-If-Match'] = `"${dispatchStateEtag}"`;
    }
    const bodyObj: Record<string, unknown> = { printerId };
    if (expectedPrinterConfigRevision !== null) {
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
      const status = pending.response.status;

      if (status === 202 || status === 200) {
        await discard(pending.response);
        return status === 202
          ? { kind: 'starting', jobId }
          : { kind: 'alreadyStarting', jobId };
      }

      if (status === 409) {
        let detail: string | null = null;
        let reason = 'conflict';
        try {
          const body = await this.readBody(pending);
          const parsed = z
            .object({
              error: z.string().optional(),
              detail: z.string().optional(),
            })
            .passthrough()
            .safeParse(JSON.parse(body));
          if (parsed.success) {
            reason = parsed.data.error ?? 'conflict';
            detail = parsed.data.detail ?? null;
          }
        } catch {
          // Ignore parse errors; use defaults
        }
        return { kind: 'conflict', reason, detail };
      }

      if (status === 412) {
        await discard(pending.response);
        return { kind: 'staleRevision' };
      }

      if (status === 503) {
        let detail: string | null = null;
        try {
          const body = await this.readBody(pending);
          const parsed = z
            .object({ detail: z.string().optional() })
            .passthrough()
            .safeParse(JSON.parse(body));
          if (parsed.success) detail = parsed.data.detail ?? null;
        } catch {
          // Ignore parse errors
        }
        return { kind: 'printerOffline', detail };
      }

      if (status === 428) {
        let detail: string | null = null;
        try {
          const body = await this.readBody(pending);
          const parsed = z
            .object({ detail: z.string().optional() })
            .passthrough()
            .safeParse(JSON.parse(body));
          if (parsed.success) detail = parsed.data.detail ?? null;
        } catch {
          // Ignore parse errors
        }
        return { kind: 'preconditionRequired', detail };
      }

      // All other non-2xx statuses → throw typed error
      throw await this.statusError(pending.response, true, pending.timedOut());
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
      const detail =
        error instanceof z.ZodError ? error.errors[0]?.message : String(error);
      throw new CalibrationHttpError(
        'invalidResponse',
        `Calibration API response validation failed: ${detail}`,
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
    // Try to read ProblemDetails for richer error context
    let detail: string | null = null;
    try {
      const body = await response.text();
      if (body.length > 0 && body.length < 4096) {
        const parsed = JSON.parse(body) as {
          detail?: string;
          title?: string;
          errorCode?: string;
        };
        detail = parsed.detail ?? parsed.title ?? null;
      }
    } catch {
      // Non-JSON error body; ignore
    }
    const msg = (fallback: string) => detail ?? fallback;

    // HTTP semantic mapping (issue #52 contract)
    switch (response.status) {
      case 400:
        return new CalibrationHttpError(
          'invalidData',
          msg('Invalid calibration request.'),
          400,
          null,
          ambiguous,
        );
      case 401:
        return new CalibrationHttpError(
          'authentication',
          msg('Calibration authentication required.'),
          401,
        );
      case 403:
        return new CalibrationHttpError(
          'authorization',
          msg('Calibration access denied.'),
          403,
        );
      case 404:
        return new CalibrationHttpError(
          'notFound',
          msg('Calibration resource not found.'),
          404,
        );
      case 409:
        return new CalibrationHttpError(
          'idempotencyPayloadChanged',
          msg('Idempotency key payload changed.'),
          409,
          null,
          ambiguous,
        );
      case 412:
        return new CalibrationHttpError(
          'revisionConflict',
          msg('Revision precondition failed (If-Match).'),
          412,
          null,
          ambiguous,
        );
      case 422:
        return new CalibrationHttpError(
          'invalidData',
          msg('Calibration data is invalid or unsafe.'),
          422,
          null,
          ambiguous,
        );
      case 428:
        return new CalibrationHttpError(
          'preconditionRequired',
          msg('Base revision is required for this calibration operation.'),
          428,
        );
      case 503:
        return new CalibrationHttpError(
          'workerUnavailable',
          msg('Calibration generation or telemetry service is unavailable.'),
          503,
          null,
          ambiguous,
        );
      default: {
        if (timedOut) {
          return new CalibrationHttpError(
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
          return new CalibrationHttpError(
            code,
            msg(`Calibration server error (${response.status}).`),
            response.status,
            retryMs,
            ambiguous,
          );
        }
        return new CalibrationHttpError(
          'server',
          msg(`Calibration request failed (${response.status}).`),
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
