/**
 * Structured logging for calibration main-process operations (issue #159).
 *
 * ## Why this module exists
 *
 * `operationId` is threaded correctly through the calibration transport and is
 * used as the backend idempotency key, but it never reached a log record. When
 * a calibration operation failed in the field there was no way to tie a desktop
 * log line to a backend operation, an orchestration, or a dispatch.
 *
 * ## Redaction contract
 *
 * Redaction here is **structural, not a filter**. `docs/security/THREAT_MODEL.md`
 * puts it plainly: "a filter is a blocklist, and blocklists leak." So:
 *
 * - A record can only carry the fields in {@link CALIBRATION_LOG_FIELDS}. There
 *   is no key for a header, a token, a credential, a photo, or a path, so no
 *   caller can put one in a record even by accident.
 * - {@link CalibrationLogInput} has **no `message` key**. Free text cannot be
 *   supplied at all; `message` is looked up from a fixed catalog keyed by
 *   `errorCode`, falling back to `event`. In particular a
 *   `CalibrationHttpError.message` is never logged — `statusError` copies the
 *   backend's ProblemDetails `detail` into it, so it is backend-controlled text
 *   and issue #159 names stringifying a backend body as a failure.
 * - Identifier values still pass {@link safeIdentifier} as a secondary guard,
 *   because a *caller* could pass the wrong variable into a legitimate key.
 *
 * The default sink writes one JSON line via `process.stdout.write`, not
 * `console.*`, so this module needs no exemption from the policy test in
 * `tests/calibrationLogPolicy.test.ts` that bans bare console calls across the
 * calibration surface.
 *
 * @module calibrationLog
 */

import type { CalibrationHttpErrorCode } from './calibrationHttp.js';
import type { CalibrationEngineErrorCode } from './calibrationEngine.js';

// --- Vocabulary -------------------------------------------------------------

export const CALIBRATION_LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type CalibrationLogLevel = (typeof CALIBRATION_LOG_LEVELS)[number];

export const CALIBRATION_LOG_COMPONENTS = [
  'calibration.http',
  'calibration.engine',
  'calibration.sync',
  'calibration.photo',
  'calibration.profile',
  'calibration.sidecar',
] as const;
export type CalibrationLogComponent =
  (typeof CALIBRATION_LOG_COMPONENTS)[number];

export const CALIBRATION_LOG_OUTCOMES = ['ok', 'failed'] as const;
export type CalibrationLogOutcome = (typeof CALIBRATION_LOG_OUTCOMES)[number];

/**
 * Every error code a record may carry. Mirrors the two existing typed unions
 * plus `unexpected` for a throw that is neither. The compile-time assertions
 * below fail `tsc` if either union gains a member that is not mirrored here, so
 * this vocabulary cannot silently drift from the code it describes.
 */
export const CALIBRATION_LOG_ERROR_CODES = [
  // CalibrationHttpErrorCode
  'cancelled',
  'timeout',
  'transport',
  'authentication',
  'authorization',
  'rateLimited',
  'server',
  'notFound',
  'invalidResponse',
  'bodyTooLarge',
  'preconditionRequired',
  'revisionConflict',
  'idempotencyPayloadChanged',
  'invalidData',
  'workerUnavailable',
  'forbidden',
  'jobNotFound',
  'wrongJob',
  'printerBusy',
  'jobNotDispatchable',
  'dispatchRevisionConflict',
  'calibrationJobIncompatible',
  'filamentCheckFailed',
  // CalibrationEngineErrorCode
  'NOT_FOUND',
  'UNAVAILABLE',
  'CAPABILITIES_MISMATCH',
  'CANCELLED',
  'DISPOSED',
  // Neither of the above.
  'unexpected',
] as const;
export type CalibrationLogErrorCode =
  (typeof CALIBRATION_LOG_ERROR_CODES)[number];

type AssertCovered<TUnion extends CalibrationLogErrorCode> = TUnion;
/** Fails `tsc` if a member is added to `CalibrationHttpErrorCode` and not here. */
export type HttpErrorCodesAreLoggable = AssertCovered<CalibrationHttpErrorCode>;
/** Fails `tsc` if a member is added to `CalibrationEngineErrorCode` and not here. */
export type EngineErrorCodesAreLoggable =
  AssertCovered<CalibrationEngineErrorCode>;

/**
 * The complete set of keys a record may carry, in emission order. Adding a key
 * here is the only way to widen what a log record can express — which is what
 * makes the redaction guarantee structural.
 */
export const CALIBRATION_LOG_FIELDS = [
  'timestamp',
  'level',
  'component',
  'event',
  'correlationId',
  'operationId',
  'dispatchId',
  'dispatchRevision',
  'profileId',
  'projectId',
  'attemptId',
  'orchestrationId',
  'outcome',
  'errorCode',
  'message',
  'httpStatus',
  'durationMs',
] as const;
export type CalibrationLogField = (typeof CALIBRATION_LOG_FIELDS)[number];

export interface CalibrationLogRecord {
  /** ISO 8601 UTC. */
  timestamp: string;
  level: CalibrationLogLevel;
  component: CalibrationLogComponent;
  /** Dotted, past tense: `generation.requested`, `bedClear.acknowledged`. */
  event: string;
  /** Stable across every stage of one user-initiated calibration flow. */
  correlationId?: string;
  /** Per-call idempotency key; the value support gives the server team. */
  operationId?: string;
  /** Queue job id. Present on queue dispatch and bed-clear acknowledgement. */
  dispatchId?: string;
  /** Dispatch-state ETag/rowversion. Opaque and safe. */
  dispatchRevision?: string;
  profileId?: string;
  projectId?: string;
  attemptId?: string;
  orchestrationId?: string;
  outcome?: CalibrationLogOutcome;
  errorCode?: CalibrationLogErrorCode;
  /** Catalogued safe text. Never backend text, never an `Error.message`. */
  message?: string;
  httpStatus?: number;
  durationMs?: number;
}

/**
 * What a call site may supply. Deliberately has no `message` key: free text
 * cannot enter a record, so a backend body or an `Error.message` cannot be
 * smuggled in through a legitimate-looking field.
 */
export interface CalibrationLogInput {
  level: CalibrationLogLevel;
  component: CalibrationLogComponent;
  event: string;
  correlationId?: string | null;
  operationId?: string | null;
  dispatchId?: string | null;
  dispatchRevision?: string | null;
  profileId?: string | null;
  projectId?: string | null;
  attemptId?: string | null;
  orchestrationId?: string | null;
  outcome?: CalibrationLogOutcome;
  errorCode?: CalibrationLogErrorCode;
  httpStatus?: number | null;
  durationMs?: number | null;
}

// --- Safe message catalog ---------------------------------------------------

/** Substituted for an identifier that fails {@link safeIdentifier}. */
export const UNSAFE_IDENTIFIER_PLACEHOLDER = '[unsafe-identifier-dropped]';

const ERROR_MESSAGES: Record<CalibrationLogErrorCode, string> = {
  cancelled: 'The request was cancelled.',
  timeout: 'The request timed out before the server responded.',
  transport: 'The server could not be reached.',
  authentication: 'Authentication with the server failed.',
  authorization: 'The server rejected the credentials for this operation.',
  rateLimited: 'The server is rate limiting requests; retry later.',
  server: 'The server reported an internal error.',
  notFound: 'The requested resource does not exist on the server.',
  invalidResponse: 'The server response did not match the expected contract.',
  bodyTooLarge: 'The server response exceeded the size limit.',
  preconditionRequired: 'The server requires a revision precondition.',
  revisionConflict: 'The local revision is behind the server revision.',
  idempotencyPayloadChanged:
    'The idempotency key was reused with a different payload.',
  invalidData: 'The server rejected the request as invalid.',
  workerUnavailable: 'No generation worker is available.',
  forbidden: 'The operation is not permitted for the granted scopes.',
  jobNotFound: 'The queue job does not exist.',
  wrongJob: 'The queue job does not match the requested operation.',
  printerBusy: 'The printer is busy with another job.',
  jobNotDispatchable: 'The queue job is not in a dispatchable state.',
  dispatchRevisionConflict: 'The dispatch state changed before the request.',
  calibrationJobIncompatible:
    'The queue job is not compatible with this calibration.',
  filamentCheckFailed: 'The printer filament check failed.',
  NOT_FOUND: 'The requested calibration resource was not found locally.',
  UNAVAILABLE: 'Calibration is unavailable for the selected server profile.',
  CAPABILITIES_MISMATCH:
    'The server capabilities do not satisfy calibration requirements.',
  CANCELLED: 'The calibration operation was cancelled.',
  DISPOSED: 'The calibration engine was disposed mid-operation.',
  unexpected: 'An unexpected error interrupted the calibration operation.',
};

const EVENT_MESSAGES: Record<string, string> = {
  'generation.requested': 'Calibration generation was requested.',
  'generation.submitted': 'Calibration generation was accepted by the server.',
  'orchestration.polled': 'Calibration orchestration status was polled.',
  'queue.stateRead': 'Calibration queue job state was read.',
  'bedClear.acknowledged': 'Bed clear was acknowledged and dispatch started.',
  'bedClear.revisionConflict':
    'Bed clear acknowledgement hit a revision conflict.',
  'sync.completed': 'Calibration synchronization completed.',
  'sync.failed': 'Calibration synchronization failed.',
  'capabilities.negotiated': 'Server calibration capabilities were negotiated.',
};

/**
 * The safe text for a record. Error code wins over event, because when an
 * operation fails the code is the more specific fact.
 */
export function calibrationLogMessage(
  event: string,
  errorCode?: CalibrationLogErrorCode,
): string {
  if (errorCode !== undefined) return ERROR_MESSAGES[errorCode];
  return EVENT_MESSAGES[event] ?? event;
}

// --- Secondary identifier guard --------------------------------------------

const MAX_IDENTIFIER_LENGTH = 128;
/** Three base64url segments — the shape of a JWT. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Secondary guard on identifier values. The primary guarantee is that no key
 * exists for a secret; this catches a call site passing the *wrong variable*
 * into a legitimate key. Rejects anything with a path separator or whitespace
 * (an absolute local path), anything JWT-shaped, and anything over-long.
 *
 * Returns {@link UNSAFE_IDENTIFIER_PLACEHOLDER} rather than dropping the field,
 * so a bad call site leaves visible evidence instead of vanishing.
 */
export function safeIdentifier(value: string): string {
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
    return UNSAFE_IDENTIFIER_PLACEHOLDER;
  }
  if (/[\s/\\]/.test(value)) return UNSAFE_IDENTIFIER_PLACEHOLDER;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return UNSAFE_IDENTIFIER_PLACEHOLDER;
  }
  if (JWT_SHAPE.test(value)) return UNSAFE_IDENTIFIER_PLACEHOLDER;
  return value;
}

function safeNumber(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

// --- Record construction ----------------------------------------------------

const IDENTIFIER_FIELDS = [
  'correlationId',
  'operationId',
  'dispatchId',
  'dispatchRevision',
  'profileId',
  'projectId',
  'attemptId',
  'orchestrationId',
] as const;

/**
 * Build a record from an input. Only allowlisted fields survive, identifiers
 * pass {@link safeIdentifier}, and `message` comes from the catalog.
 */
export function buildCalibrationLogRecord(
  input: CalibrationLogInput,
  now: () => Date = () => new Date(),
): CalibrationLogRecord {
  const record: CalibrationLogRecord = {
    timestamp: now().toISOString(),
    level: input.level,
    component: input.component,
    event: input.event,
  };
  for (const field of IDENTIFIER_FIELDS) {
    const value = input[field];
    if (typeof value === 'string') record[field] = safeIdentifier(value);
  }
  if (input.outcome !== undefined) record.outcome = input.outcome;
  if (input.errorCode !== undefined) record.errorCode = input.errorCode;
  record.message = calibrationLogMessage(input.event, input.errorCode);
  if (typeof input.httpStatus === 'number') {
    const status = safeNumber(input.httpStatus);
    if (status !== undefined) record.httpStatus = status;
  }
  if (typeof input.durationMs === 'number') {
    const duration = safeNumber(input.durationMs);
    if (duration !== undefined) record.durationMs = Math.max(0, duration);
  }
  return record;
}

// --- Sink -------------------------------------------------------------------

export type CalibrationLogSink = (record: CalibrationLogRecord) => void;

/**
 * Default sink: one JSON object per line on stdout. Deliberately not
 * `console.*` — see the module docblock.
 */
const stdoutSink: CalibrationLogSink = (record) => {
  process.stdout.write(`${JSON.stringify(record)}\n`);
};

let activeSink: CalibrationLogSink = stdoutSink;

export function setCalibrationLogSink(sink: CalibrationLogSink): void {
  activeSink = sink;
}

export function resetCalibrationLogSink(): void {
  activeSink = stdoutSink;
}

/**
 * Redirect records into an array for the duration of a test. Returns the live
 * array and a `stop` that restores the previous sink.
 */
export function captureCalibrationLogs(): {
  records: CalibrationLogRecord[];
  stop: () => void;
} {
  const previous = activeSink;
  const records: CalibrationLogRecord[] = [];
  activeSink = (record) => records.push(record);
  return {
    records,
    stop: () => {
      activeSink = previous;
    },
  };
}

/** Build a record, hand it to the active sink, and return it. */
export function emitCalibrationLog(
  input: CalibrationLogInput,
): CalibrationLogRecord {
  const record = buildCalibrationLogRecord(input);
  activeSink(record);
  return record;
}

// --- Error classification ---------------------------------------------------

const KNOWN_ERROR_CODES = new Set<string>(CALIBRATION_LOG_ERROR_CODES);

/**
 * Classify a thrown value into a typed code and an HTTP status.
 *
 * Reads only `code` and `status`, both structurally safe. It deliberately never
 * reads `message`: on a `CalibrationHttpError` that field carries the backend's
 * ProblemDetails `detail` (`calibrationHttp.ts` `statusError`), which is
 * server-controlled text and could echo anything the server was sent.
 *
 * Duck-typed rather than `instanceof` so this module stays free of a runtime
 * import cycle with `calibrationHttp` and `calibrationEngine`.
 */
export function describeCalibrationFailure(error: unknown): {
  errorCode: CalibrationLogErrorCode;
  httpStatus?: number;
} {
  if (typeof error !== 'object' || error === null) {
    return { errorCode: 'unexpected' };
  }
  const candidate = error as { code?: unknown; status?: unknown };
  const errorCode: CalibrationLogErrorCode =
    typeof candidate.code === 'string' && KNOWN_ERROR_CODES.has(candidate.code)
      ? (candidate.code as CalibrationLogErrorCode)
      : 'unexpected';
  if (typeof candidate.status === 'number') {
    const status = safeNumber(candidate.status);
    if (status !== undefined) return { errorCode, httpStatus: status };
  }
  return { errorCode };
}
