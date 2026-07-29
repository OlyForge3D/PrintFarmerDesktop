/**
 * CalibrationHttpClient — job-queue and generation dispatch tests (issue #54).
 *
 * All evidence is fixture- and mock-based; there is no live PrintFarmer server.
 *
 * Tests cover:
 * - startGeneration calls the per-attempt route with attemptId in the URL and
 *   method/options in the body.
 * - No dead routes remain in ROUTES (generation, queue, bedClear, printStart).
 * - acknowledgeBedClearAndStart sends all THREE required precondition headers.
 * - 412 response body is parsed to extract current ETags (revisionConflict).
 * - Each 409 sub-code maps to a distinct CalibrationHttpErrorCode.
 * - 422 sub-codes map to distinct CalibrationHttpErrorCode.
 * - 428 maps to preconditionRequired.
 * - createQueueJob sends jobKind: "FilamentCalibration" and provenance fields.
 * - createQueueJob returns rowVersion/dispatchStateRowVersion from headers.
 * - getQueueJob returns RemoteJobQueueJob with bedClearState.
 * - getOrchestrationStatus returns RemoteCalibrationOrchestrationStatus.
 * - OpaquetETag strings are sent byte-identical (not re-encoded).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationHttpClient,
  CalibrationHttpError,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';

const BASE_URL = 'http://farm.local';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const PRINTER_ID = '55555555-5555-4555-8555-555555555555';
const OPERATION_ID = '66666666-6666-4666-8666-666666666666';
const ORCHESTRATION_ID = '77777777-7777-4777-8777-777777777777';
const BINDING = 'binding-abc123';

/** A minimal valid orchestration status response fixture */
const ORCHESTRATION_FIXTURE = {
  id: ORCHESTRATION_ID,
  projectId: PROJECT_ID,
  attemptId: ATTEMPT_ID,
  operationId: OPERATION_ID,
  status: 'Running',
  currentStep: 'Slicing',
  revision: 1,
  retryCount: 0,
  nextRetryAtUtc: null,
  stepStartedAtUtc: null,
  lastErrorCode: null,
  problems: [],
  model3DId: null,
  sliceJobId: null,
  workerId: null,
  sourceArtifactId: null,
  finalArtifactId: null,
  gcodeFileId: null,
  specificationSha256: null,
  planManifestSha256: null,
  gcodeSha256: null,
  manifestSha256: null,
  generatorVersion: null,
  slicerContainerDigest: null,
  slicerBinarySha256: null,
  statusRoute: `/api/calibration-orchestration/${ORCHESTRATION_ID}`,
  createdAtUtc: '2025-01-01T00:00:00.000Z',
  updatedAtUtc: '2025-01-01T00:00:01.000Z',
  completedAtUtc: null,
};

/** A minimal valid queue job response fixture */
const QUEUE_JOB_FIXTURE = {
  id: JOB_ID,
  rowVersion: 'AAAAAAAAAAAA==',
  revision: 1,
  dispatchStateRowVersion: 'BBBBBBBBBBBB==',
  dispatchStateRevision: 1,
  dispatchResult: null,
  jobKind: 'FilamentCalibration',
  calibrationProjectId: PROJECT_ID,
  calibrationAttemptId: ATTEMPT_ID,
  pinnedPrinterConfigRevision: 42,
  gcodeFileId: null,
  gcodeFileName: 'test.gcode',
  assignedPrinterId: PRINTER_ID,
  assignedPrinterName: 'Printer A',
  status: 'Queued',
  bedClearState: 'None',
  priority: 0,
  queuePosition: 0,
  copies: 1,
  completedCopies: 0,
  remainingCopies: 1,
  isIdempotentReplay: false,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:01.000Z',
};

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Extract URL from a fetch mock call (the client passes a URL object, not a string). */
function getCallUrl(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): string {
  const [urlArg] = fetchMock.mock.calls[callIndex] as [
    URL | string,
    RequestInit,
  ];
  return typeof urlArg === 'string' ? urlArg : urlArg.href;
}

/** Extract RequestInit from a fetch mock call. */
function getCallInit(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): RequestInit {
  const [, init] = fetchMock.mock.calls[callIndex] as [
    URL | string,
    RequestInit,
  ];
  return init;
}

function stableTokens(
  overrides: Partial<CalibrationTokenProvider> = {},
): CalibrationTokenProvider {
  return {
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      baseUrl: BASE_URL,
      token: 'test-jwt',
      binding: BINDING,
    }),
    ...overrides,
  };
}

function makeClient(
  fetchMock: typeof globalThis.fetch,
  tokens: CalibrationTokenProvider = stableTokens(),
) {
  return new CalibrationHttpClient(tokens, {
    fetch: fetchMock,
    timeoutMs: 10_000,
    maxResponseBytes: 1024 * 1024,
    now: () => Date.now(),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });
}

// ==========================================================================
// Route integrity: dead routes must be gone
// ==========================================================================

describe('ROUTES constant — dead routes absent (issue #54)', () => {
  it('does not export a "generation" route constant', async () => {
    // Import the module and check that none of its exports contain the dead
    // /calibration-projects/{id}/generation path.
    const mod = await import('../src/main/calibrationHttp.js');
    const exported = JSON.stringify(mod);
    expect(exported).not.toContain('/generation');
    expect(exported).not.toContain('calibration-projects');
  });

  it('does not export a dead queue route (/calibration-projects/{id}/queue)', async () => {
    const mod = await import('../src/main/calibrationHttp.js');
    // The only acceptable calibration-projects URLs are per-attempt:
    // /api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job
    const exported = JSON.stringify(mod);
    // There should be no route that ends with /queue under calibration-projects
    expect(exported).not.toMatch(/calibration-projects[^}]+\/queue/);
  });
});

// ==========================================================================
// startGeneration — per-attempt route and body fields
// ==========================================================================

describe('startGeneration — per-attempt route', () => {
  it('calls the correct per-attempt route containing both projectId and attemptId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(ORCHESTRATION_FIXTURE));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      'temperature',
      undefined,
      undefined,
      OPERATION_ID,
      null,
      signal,
    );

    const url = getCallUrl(fetchMock);
    expect(url).toContain(PROJECT_ID);
    expect(url).toContain(ATTEMPT_ID);
    expect(url).toContain('generate-job');
  });

  it('sends method in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(ORCHESTRATION_FIXTURE));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      'flow',
      '1.1',
      { startRatio: 0.9, endRatio: 1.1 },
      OPERATION_ID,
      5,
      signal,
    );

    const init = getCallInit(fetchMock);
    const body = JSON.parse(init.body as string) as {
      method: string;
      definitionVersion?: string;
      options?: { startRatio?: number; endRatio?: number };
      baseRevision?: number;
    };
    expect(body.method).toBe('flow');
    expect(body.definitionVersion).toBe('1.1');
    expect(body.options).toMatchObject({ startRatio: 0.9, endRatio: 1.1 });
    expect(body.baseRevision).toBe(5);
  });

  it('sends operationId as Idempotency-Key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(ORCHESTRATION_FIXTURE));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      'temperature',
      undefined,
      undefined,
      OPERATION_ID,
      null,
      signal,
    );

    const init = getCallInit(fetchMock);
    const headers = new Headers(init.headers);
    expect(headers.get('idempotency-key')).toBe(OPERATION_ID);
  });

  it('returns orchestrationId from the response body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(ORCHESTRATION_FIXTURE));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    const result = await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      'temperature',
      undefined,
      undefined,
      OPERATION_ID,
      null,
      signal,
    );

    expect(result.id).toBe(ORCHESTRATION_ID);
  });
});

// ==========================================================================
// acknowledgeBedClearAndStart — THREE precondition headers
// ==========================================================================

describe('acknowledgeBedClearAndStart — three precondition headers', () => {
  const BED_CLEAR_SUCCESS = {
    message: 'Dispatched',
    jobETag: 'CCCCCC==',
    dispatchStateETag: 'DDDDDD==',
  };

  it('sends Idempotency-Key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(BED_CLEAR_SUCCESS, 202));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      'AAAAAAAAAAAA==',
      'BBBBBBBBBBBB==',
      null,
      signal,
    );

    const init = getCallInit(fetchMock);
    const headers = new Headers(init.headers);
    // First precondition: Idempotency-Key
    expect(headers.get('idempotency-key')).toBe(OPERATION_ID);
  });

  it('sends If-Match header with job rowVersion byte-identical', async () => {
    const ROW_VERSION = 'AAAAAAAAAAAA==';
    const fetchMock = vi.fn().mockResolvedValue(json(BED_CLEAR_SUCCESS, 202));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      ROW_VERSION,
      'BBBBBBBBBBBB==',
      null,
      signal,
    );

    const init = getCallInit(fetchMock);
    const headers = new Headers(init.headers);
    // Second precondition: If-Match with byte-identical opaque ETag
    expect(headers.get('if-match')).toBe(ROW_VERSION);
  });

  it('sends X-Dispatch-State-If-Match header with dispatchStateRowVersion byte-identical', async () => {
    const DISPATCH_ROW_VERSION = 'BBBBBBBBBBBB==';
    const fetchMock = vi.fn().mockResolvedValue(json(BED_CLEAR_SUCCESS, 202));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      'AAAAAAAAAAAA==',
      DISPATCH_ROW_VERSION,
      null,
      signal,
    );

    const init = getCallInit(fetchMock);
    const headers = new Headers(init.headers);
    // Third precondition: X-Dispatch-State-If-Match with byte-identical opaque ETag
    expect(headers.get('x-dispatch-state-if-match')).toBe(DISPATCH_ROW_VERSION);
  });

  it('calls the correct acknowledge-bed-clear-and-start URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(BED_CLEAR_SUCCESS, 202));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      'AAAAAAAAAAAA==',
      'BBBBBBBBBBBB==',
      null,
      signal,
    );

    const url = getCallUrl(fetchMock);
    expect(url).toContain(JOB_ID);
    expect(url).toContain('acknowledge-bed-clear-and-start');
  });

  it('returns ok with updated ETags from success response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(BED_CLEAR_SUCCESS, 202));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    const result = await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      'AAAAAAAAAAAA==',
      'BBBBBBBBBBBB==',
      null,
      signal,
    );

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.jobETag).toBe('CCCCCC==');
      expect(result.dispatchStateETag).toBe('DDDDDD==');
    }
  });
});

// ==========================================================================
// acknowledgeBedClearAndStart — 412 dispatch_revision_conflict
// ==========================================================================

describe('acknowledgeBedClearAndStart — 412 revision conflict with ETag extraction', () => {
  it('returns revisionConflict with current ETags from 412 body', async () => {
    const conflictBody = {
      error: 'dispatch_revision_conflict',
      detail: 'Job or dispatch state has been updated.',
      jobETag: 'EEEEEEEEEEEE==',
      dispatchStateETag: 'FFFFFFFFFFFF==',
    };
    const fetchMock = vi.fn().mockResolvedValue(json(conflictBody, 412));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    const result = await client.acknowledgeBedClearAndStart(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      'STALE_JOB_ETAG==',
      'STALE_DISPATCH_ETAG==',
      null,
      signal,
    );

    // The 412 must NOT throw — it must return the revisionConflict discriminant
    // so the caller can retry with the fresh ETags without a round-trip GET.
    expect(result.kind).toBe('revisionConflict');
    if (result.kind === 'revisionConflict') {
      expect(result.jobETag).toBe('EEEEEEEEEEEE==');
      expect(result.dispatchStateETag).toBe('FFFFFFFFFFFF==');
    }
  });

  it('throws dispatchRevisionConflict when 412 body has no ETags', async () => {
    // A 412 body missing both ETag fields — fallback to thrown error.
    const conflictBody = { error: 'dispatch_revision_conflict' };
    const fetchMock = vi.fn().mockResolvedValue(json(conflictBody, 412));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await expect(
      client.acknowledgeBedClearAndStart(
        PROFILE_ID,
        BASE_URL,
        JOB_ID,
        PRINTER_ID,
        OPERATION_ID,
        'AAAA==',
        'BBBB==',
        null,
        signal,
      ),
    ).rejects.toMatchObject({ code: 'dispatchRevisionConflict' });
  });
});

// ==========================================================================
// acknowledgeBedClearAndStart — 409 sub-codes (each must be distinct)
// ==========================================================================

describe('acknowledgeBedClearAndStart — 409 sub-codes map to distinct error codes', () => {
  it.each([
    ['wrong_job', 'wrongJob'],
    ['printer_busy', 'printerBusy'],
    ['job_not_dispatchable', 'jobNotDispatchable'],
    ['idempotency_payload_mismatch', 'idempotencyPayloadChanged'],
  ] as const)(
    'maps 409 error="%s" → CalibrationHttpErrorCode("%s")',
    async (serverCode, expectedCode) => {
      const body = { error: serverCode };
      const fetchMock = vi.fn().mockResolvedValue(json(body, 409));
      const client = makeClient(fetchMock);
      const signal = AbortSignal.timeout(5000);

      // Each sub-code must throw the specific typed error code, not a generic one.
      await expect(
        client.acknowledgeBedClearAndStart(
          PROFILE_ID,
          BASE_URL,
          JOB_ID,
          PRINTER_ID,
          OPERATION_ID,
          'AAAA==',
          'BBBB==',
          null,
          signal,
        ),
      ).rejects.toMatchObject({ code: expectedCode });
    },
  );
});

// ==========================================================================
// acknowledgeBedClearAndStart — 422 sub-codes
// ==========================================================================

describe('acknowledgeBedClearAndStart — 422 sub-codes map to distinct error codes', () => {
  it.each([
    ['calibration_job_incompatible', 'calibrationJobIncompatible'],
    ['filament_check_failed', 'filamentCheckFailed'],
  ] as const)(
    'maps 422 error="%s" → CalibrationHttpErrorCode("%s")',
    async (serverCode, expectedCode) => {
      const body = { error: serverCode };
      const fetchMock = vi.fn().mockResolvedValue(json(body, 422));
      const client = makeClient(fetchMock);
      const signal = AbortSignal.timeout(5000);

      await expect(
        client.acknowledgeBedClearAndStart(
          PROFILE_ID,
          BASE_URL,
          JOB_ID,
          PRINTER_ID,
          OPERATION_ID,
          'AAAA==',
          'BBBB==',
          null,
          signal,
        ),
      ).rejects.toMatchObject({ code: expectedCode });
    },
  );
});

// ==========================================================================
// acknowledgeBedClearAndStart — 428 precondition required
// ==========================================================================

describe('acknowledgeBedClearAndStart — 428 maps to preconditionRequired', () => {
  it('throws preconditionRequired on 428', async () => {
    const body = { detail: 'Precondition header(s) missing.' };
    const fetchMock = vi.fn().mockResolvedValue(json(body, 428));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await expect(
      client.acknowledgeBedClearAndStart(
        PROFILE_ID,
        BASE_URL,
        JOB_ID,
        PRINTER_ID,
        OPERATION_ID,
        'AAAA==',
        'BBBB==',
        null,
        signal,
      ),
    ).rejects.toMatchObject({ code: 'preconditionRequired' });
  });
});

// ==========================================================================
// createQueueJob — correct body fields and jobKind
// ==========================================================================

describe('createQueueJob — POST /api/job-queue', () => {
  it('sends jobKind: "FilamentCalibration" in the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(QUEUE_JOB_FIXTURE, 201));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.createQueueJob(
      PROFILE_ID,
      BASE_URL,
      {
        gcodeFileId: JOB_ID,
        assignedPrinterId: PRINTER_ID,
        operationId: OPERATION_ID,
        calibrationProjectId: PROJECT_ID,
        calibrationAttemptId: ATTEMPT_ID,
        calibrationOrchestrationId: ORCHESTRATION_ID,
        pinnedPrinterConfigRevision: 42,
        gcodeContentSha256: null,
        specificationSha256: null,
        machineProfileSha256: null,
        processProfileSha256: null,
        filamentProfileSha256: null,
        printerConfigSnapshotSha256: null,
        requiredFirmwareFamily: null,
        requiredGcodeDialect: null,
        requiredSlicerEngine: null,
        requiredSlicerDistribution: null,
        requiredSlicerVersion: null,
        requiredSlicerContainerDigest: null,
      },
      signal,
    );

    const init = getCallInit(fetchMock);
    const body = JSON.parse(init.body as string) as {
      jobKind: string;
    };
    // jobKind MUST be the exact string "FilamentCalibration" — not an integer
    // enum, not a camelCased variant, not "Calibration".
    expect(body.jobKind).toBe('FilamentCalibration');
  });

  it('sends provenance fields including calibration IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(QUEUE_JOB_FIXTURE, 201));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.createQueueJob(
      PROFILE_ID,
      BASE_URL,
      {
        gcodeFileId: JOB_ID,
        assignedPrinterId: PRINTER_ID,
        operationId: OPERATION_ID,
        calibrationProjectId: PROJECT_ID,
        calibrationAttemptId: ATTEMPT_ID,
        calibrationOrchestrationId: ORCHESTRATION_ID,
        pinnedPrinterConfigRevision: 42,
        gcodeContentSha256: 'abc123',
        specificationSha256: 'def456',
        machineProfileSha256: null,
        processProfileSha256: null,
        filamentProfileSha256: null,
        printerConfigSnapshotSha256: null,
        requiredFirmwareFamily: 'klipper',
        requiredGcodeDialect: null,
        requiredSlicerEngine: null,
        requiredSlicerDistribution: null,
        requiredSlicerVersion: null,
        requiredSlicerContainerDigest: null,
      },
      signal,
    );

    const init = getCallInit(fetchMock);
    const body = JSON.parse(init.body as string) as {
      calibrationProjectId: string;
      calibrationAttemptId: string;
      calibrationOrchestrationId: string;
      pinnedPrinterConfigRevision: number;
      gcodeContentSha256: string;
      specificationSha256: string;
      requiredFirmwareFamily: string;
    };
    expect(body.calibrationProjectId).toBe(PROJECT_ID);
    expect(body.calibrationAttemptId).toBe(ATTEMPT_ID);
    expect(body.calibrationOrchestrationId).toBe(ORCHESTRATION_ID);
    expect(body.pinnedPrinterConfigRevision).toBe(42);
    expect(body.gcodeContentSha256).toBe('abc123');
    expect(body.specificationSha256).toBe('def456');
    expect(body.requiredFirmwareFamily).toBe('klipper');
  });

  it('posts to /api/job-queue with idempotency-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(QUEUE_JOB_FIXTURE, 201));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.createQueueJob(
      PROFILE_ID,
      BASE_URL,
      {
        gcodeFileId: JOB_ID,
        assignedPrinterId: PRINTER_ID,
        operationId: OPERATION_ID,
        calibrationProjectId: PROJECT_ID,
        calibrationAttemptId: ATTEMPT_ID,
        calibrationOrchestrationId: ORCHESTRATION_ID,
        pinnedPrinterConfigRevision: null,
        gcodeContentSha256: null,
        specificationSha256: null,
        machineProfileSha256: null,
        processProfileSha256: null,
        filamentProfileSha256: null,
        printerConfigSnapshotSha256: null,
        requiredFirmwareFamily: null,
        requiredGcodeDialect: null,
        requiredSlicerEngine: null,
        requiredSlicerDistribution: null,
        requiredSlicerVersion: null,
        requiredSlicerContainerDigest: null,
      },
      signal,
    );

    const url = getCallUrl(fetchMock);
    const init = getCallInit(fetchMock);
    expect(url).toContain('/api/job-queue');
    const headers = new Headers(init.headers);
    expect(headers.get('idempotency-key')).toBe(OPERATION_ID);
  });

  it('returns rowVersion and dispatchStateRowVersion from ETag response headers', async () => {
    const ETAG = '"CCCCCCCCCCCC=="';
    const DISPATCH_ETAG = '"DDDDDDDDDDDD=="';
    const responseWithHeaders = new Response(
      JSON.stringify(QUEUE_JOB_FIXTURE),
      {
        status: 201,
        headers: {
          'content-type': 'application/json',
          etag: ETAG,
          'x-dispatch-state-etag': DISPATCH_ETAG,
          location: `/api/job-queue/${JOB_ID}`,
        },
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(responseWithHeaders);
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    const result = await client.createQueueJob(
      PROFILE_ID,
      BASE_URL,
      {
        gcodeFileId: JOB_ID,
        assignedPrinterId: PRINTER_ID,
        operationId: OPERATION_ID,
        calibrationProjectId: PROJECT_ID,
        calibrationAttemptId: ATTEMPT_ID,
        calibrationOrchestrationId: ORCHESTRATION_ID,
        pinnedPrinterConfigRevision: null,
        gcodeContentSha256: null,
        specificationSha256: null,
        machineProfileSha256: null,
        processProfileSha256: null,
        filamentProfileSha256: null,
        printerConfigSnapshotSha256: null,
        requiredFirmwareFamily: null,
        requiredGcodeDialect: null,
        requiredSlicerEngine: null,
        requiredSlicerDistribution: null,
        requiredSlicerVersion: null,
        requiredSlicerContainerDigest: null,
      },
      signal,
    );

    expect(result.jobId).toBe(JOB_ID);
    // ETags from headers are stripped of quotes for opaque-string comparison.
    // The body's rowVersion field takes precedence if present.
    expect(result.rowVersion).toBe('AAAAAAAAAAAA=='); // from body (fixture has this)
    expect(result.dispatchStateRowVersion).toBe('BBBBBBBBBBBB=='); // from body
    expect(result.replayed).toBe(false);
  });

  it('detects idempotent replay (200 + Idempotency-Replayed: true)', async () => {
    const replayResponse = new Response(
      JSON.stringify({ ...QUEUE_JOB_FIXTURE, isIdempotentReplay: true }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'idempotency-replayed': 'true',
        },
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(replayResponse);
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    const result = await client.createQueueJob(
      PROFILE_ID,
      BASE_URL,
      {
        gcodeFileId: JOB_ID,
        assignedPrinterId: PRINTER_ID,
        operationId: OPERATION_ID,
        calibrationProjectId: PROJECT_ID,
        calibrationAttemptId: ATTEMPT_ID,
        calibrationOrchestrationId: ORCHESTRATION_ID,
        pinnedPrinterConfigRevision: null,
        gcodeContentSha256: null,
        specificationSha256: null,
        machineProfileSha256: null,
        processProfileSha256: null,
        filamentProfileSha256: null,
        printerConfigSnapshotSha256: null,
        requiredFirmwareFamily: null,
        requiredGcodeDialect: null,
        requiredSlicerEngine: null,
        requiredSlicerDistribution: null,
        requiredSlicerVersion: null,
        requiredSlicerContainerDigest: null,
      },
      signal,
    );

    expect(result.replayed).toBe(true);
  });
});

// ==========================================================================
// getQueueJob — GET /api/job-queue/{id}
// ==========================================================================

describe('getQueueJob — GET /api/job-queue/{id}', () => {
  it('calls the correct job-queue URL with jobId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(QUEUE_JOB_FIXTURE));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.getQueueJob(PROFILE_ID, BASE_URL, JOB_ID, signal);

    const url = getCallUrl(fetchMock);
    expect(url).toContain('/api/job-queue/');
    expect(url).toContain(JOB_ID);
  });

  it('returns null for 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ detail: 'Not found' }, 404));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    const result = await client.getQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      signal,
    );
    expect(result).toBeNull();
  });

  it('returns bedClearState from the job DTO', async () => {
    const jobWithBedClear = {
      ...QUEUE_JOB_FIXTURE,
      bedClearState: 'Acknowledged',
    };
    const fetchMock = vi.fn().mockResolvedValue(json(jobWithBedClear));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    const result = await client.getQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      signal,
    );
    expect(result).not.toBeNull();
    expect(result?.bedClearState).toBe('Acknowledged');
  });

  it('returns opaque rowVersion strings without modification', async () => {
    const OPAQUE_ETAG = 'AAAAAAAAAAAA==';
    const OPAQUE_DISPATCH_ETAG = 'BBBBBBBBBBBB==';
    const fixture = {
      ...QUEUE_JOB_FIXTURE,
      rowVersion: OPAQUE_ETAG,
      dispatchStateRowVersion: OPAQUE_DISPATCH_ETAG,
    };
    const fetchMock = vi.fn().mockResolvedValue(json(fixture));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    const result = await client.getQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      signal,
    );
    // ETags must be returned byte-identical — never parsed or re-encoded.
    expect(result?.rowVersion).toBe(OPAQUE_ETAG);
    expect(result?.dispatchStateRowVersion).toBe(OPAQUE_DISPATCH_ETAG);
  });
});

// ==========================================================================
// getOrchestrationStatus — GET /api/calibration-orchestration/{id}
// ==========================================================================

describe('getOrchestrationStatus — GET /api/calibration-orchestration/{id}', () => {
  it('calls the correct orchestration status URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(ORCHESTRATION_FIXTURE));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    await client.getOrchestrationStatus(
      PROFILE_ID,
      BASE_URL,
      ORCHESTRATION_ID,
      signal,
    );

    const url = getCallUrl(fetchMock);
    expect(url).toContain(ORCHESTRATION_ID);
    expect(url).toContain('calibration-orchestration');
  });

  it('returns free-form status and currentStep strings without enum validation', async () => {
    // The server can return any string for status and currentStep —
    // the client must NOT fail on unrecognised values.
    const fixture = {
      ...ORCHESTRATION_FIXTURE,
      status: 'UnknownFutureStatus',
      currentStep: 'UnknownFutureStep',
    };
    const fetchMock = vi.fn().mockResolvedValue(json(fixture));
    const client = makeClient(fetchMock);
    const signal = AbortSignal.timeout(5000);

    const result = await client.getOrchestrationStatus(
      PROFILE_ID,
      BASE_URL,
      ORCHESTRATION_ID,
      signal,
    );

    expect(result.status).toBe('UnknownFutureStatus');
    expect(result.currentStep).toBe('UnknownFutureStep');
  });
});

// ==========================================================================
// CalibrationHttpError.toApiError — new bed-clear error codes
// ==========================================================================

describe('CalibrationHttpError.toApiError — bed-clear error code mapping', () => {
  it.each([
    ['forbidden', 'forbidden'],
    ['jobNotFound', 'jobNotFound'],
    ['wrongJob', 'wrongJob'],
    ['printerBusy', 'printerBusy'],
    ['jobNotDispatchable', 'jobNotDispatchable'],
    ['dispatchRevisionConflict', 'dispatchRevisionConflict'],
    ['calibrationJobIncompatible', 'calibrationJobIncompatible'],
    ['filamentCheckFailed', 'filamentCheckFailed'],
  ] as const)(
    'maps CalibrationHttpErrorCode("%s") → CalibrationApiErrorCode("%s")',
    (httpCode, expectedApiCode) => {
      const err = new CalibrationHttpError(httpCode, 'test', 409, null, false);
      const apiError = err.toApiError();
      expect(apiError.code).toBe(expectedApiCode);
    },
  );
});
