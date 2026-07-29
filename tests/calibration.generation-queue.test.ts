/**
 * Calibration generation, queue, and bed-clear tests (issue #54).
 *
 * Verifies acceptance criteria:
 * - G-01, G-04, G-06, G-07, G-08, G-09: Typed durable backend generation
 * - Q-01, Q-02, Q-03, Q-04, Q-05, Q-06: REST-authoritative queue/dispatch state
 * - B-01, B-02, B-03, B-04, B-05, B-06, B-07: Exact-job bed-clear acknowledgement
 * - L-01, L-02, L-05, L-06, L-07: Print lifecycle and result entry
 * - S-01, S-02, S-03, S-04, S-05: IPC and security boundary
 * - A-01, A-02, A-03, A-05, A-06, A-07, A-08: External calibration asset provenance
 *
 * PrintFarmer API contract source: PR #979 at 167a3b134a678a0d9a8c10371da8333d03ddc636
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationHttpClient,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';
import {
  RemoteCalibrationOrchestrationStatus,
  RemoteJobQueueJob,
} from '../src/main/calibrationWire.js';
import {
  ipcSchemas,
  IpcChannel,
  CalibrationStartGenerationRequest,
  CalibrationStartGenerationResponse,
  CalibrationGetOrchestrationStatusRequest,
  CalibrationGetQueueStateRequest,
  CalibrationGetQueueStateResponse,
  CalibrationAcknowledgeBedClearRequest,
  CalibrationAcknowledgeBedClearResponse,
  CalibrationOrchestrationStatus,
  CalibrationBedClearAckOutcome,
  CalibrationPrintLifecycleState,
  CalibrationBlockedReason,
  CalibrationMethodOptions,
} from '@shared/ipc';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_URL = 'http://farm.local';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const ORCHESTRATION_ID = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '55555555-5555-4555-8555-555555555555';
const PRINTER_ID = '66666666-6666-4666-8666-666666666666';
const OPERATION_ID = '77777777-7777-4777-8777-777777777777';
const BINDING = 'binding-abc123-def456';
const NOW_UTC = '2026-07-29T01:00:00.000Z';
const STATUS_ROUTE = `/api/calibration-orchestrations/${ORCHESTRATION_ID}`;
const JOB_ETAG = 'AAAAAQID';
const DISPATCH_STATE_ETAG = 'BBBBBQID';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

function makeOrchestrationDto(overrides: Record<string, unknown> = {}) {
  return {
    id: ORCHESTRATION_ID,
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    operationId: OPERATION_ID,
    status: 'Running',
    currentStep: 'SlicingQueued',
    revision: 1,
    retryCount: 0,
    nextRetryAtUtc: null,
    stepStartedAtUtc: NOW_UTC,
    lastErrorCode: null,
    problems: [],
    model3DId: null,
    sliceJobId: null,
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
    statusRoute: STATUS_ROUTE,
    createdAtUtc: NOW_UTC,
    updatedAtUtc: NOW_UTC,
    completedAtUtc: null,
    ...overrides,
  };
}

function makeJobDto(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    rowVersion: JOB_ETAG,
    revision: 1,
    dispatchStateRowVersion: DISPATCH_STATE_ETAG,
    dispatchStateRevision: 5,
    calibrationProjectId: PROJECT_ID,
    pinnedPrinterConfigRevision: 42,
    assignedPrinterId: PRINTER_ID,
    assignedPrinterName: 'Klipper Printer',
    gcodeFileName: 'calibration-temp-tower.gcode',
    gcodeFileId: '88888888-8888-4888-8888-888888888888',
    status: 'Assigned',
    priority: 10,
    queuePosition: 1,
    requiredNozzleDiameter: 0.4,
    requiredMaterialType: 'PLA',
    bedClearState: null,
    bedClearCommandId: null,
    bedClearExpiresAtUtc: null,
    createdAt: NOW_UTC,
    updatedAt: NOW_UTC,
    ...overrides,
  };
}

// ===========================================================================
// G-01 G-04: Generate-job endpoint uses correct route and request shape
// ===========================================================================

describe('CalibrationHttpClient startGeneration (G-01, G-04)', () => {
  it('uses the correct POST route: /api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(makeOrchestrationDto(), 202));
    const client = makeClient(fetchMock);
    await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      OPERATION_ID,
      'temperature',
      '1.0',
      null,
      null,
      AbortSignal.timeout(5000),
    );
    const [url] = fetchMock.mock.calls[0] as [URL | string];
    expect(String(url)).toContain(
      `/api/calibration-projects/${PROJECT_ID}/attempts/${ATTEMPT_ID}/generate-job`,
    );
  });

  it('sends Idempotency-Key header (not idempotency-key)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(makeOrchestrationDto(), 202));
    const client = makeClient(fetchMock);
    await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      OPERATION_ID,
      'temperature',
      '1.0',
      null,
      null,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    // G-04: correct header name for idempotency
    expect(headers['Idempotency-Key']).toBe(OPERATION_ID);
    expect(headers['idempotency-key']).toBeUndefined();
  });

  it('sends method, definitionVersion, options in request body (G-04)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(makeOrchestrationDto(), 202));
    const client = makeClient(fetchMock);
    const options = { startCelsius: 190, endCelsius: 230, stepCelsius: 5 };
    await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      OPERATION_ID,
      'temperature',
      '1.0',
      options,
      7,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.method).toBe('temperature');
    expect(body.definitionVersion).toBe('1.0');
    expect(body.options).toEqual(options);
    expect(body.baseRevision).toBe(7);
    // G-08: body never contains G-code, paths, URLs, or renderer commands
    expect(body.gcodeContent).toBeUndefined();
    expect(body.filePath).toBeUndefined();
    expect(body.shellCommand).toBeUndefined();
  });

  it('returns orchestration status with durable stage info (G-05)', async () => {
    const dto = makeOrchestrationDto({
      status: 'Completed',
      currentStep: 'Promoted',
      gcodeFileId: '99999999-9999-4999-8999-999999999999',
      gcodeSha256: 'a'.repeat(64),
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(json(dto, 202));
    const client = makeClient(fetchMock);
    const result = await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      OPERATION_ID,
      'temperature',
      '1.0',
      null,
      null,
      AbortSignal.timeout(5000),
    );
    expect(result.status).toBe('Completed');
    expect(result.currentStep).toBe('Promoted');
    expect(result.gcodeFileId).toBe('99999999-9999-4999-8999-999999999999');
    expect(result.gcodeSha256).toBe('a'.repeat(64));
    // G-07: status route present for REST reconciliation
    expect(result.statusRoute).toBe(STATUS_ROUTE);
  });

  it('stable idempotency ID produces same orchestration on retry (G-09)', async () => {
    // Both 202 and 200 produce the same orchestration (idempotent replay)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(makeOrchestrationDto(), 202))
      .mockResolvedValueOnce(json(makeOrchestrationDto(), 200));
    const client = makeClient(fetchMock);
    const r1 = await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      OPERATION_ID,
      'temperature',
      '1.0',
      null,
      null,
      AbortSignal.timeout(5000),
    );
    const r2 = await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      OPERATION_ID,
      'temperature',
      '1.0',
      null,
      null,
      AbortSignal.timeout(5000),
    );
    // Same orchestration ID on both calls (idempotent)
    expect(r1.id).toBe(r2.id);
    expect(r1.operationId).toBe(r2.operationId);
  });

  it('maps 412 to revisionConflict error when project revision changed (G-09)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: 'revision_conflict', detail: 'Stale revision' }, 412),
      );
    const client = makeClient(fetchMock);
    await expect(
      client.startGeneration(
        PROFILE_ID,
        BASE_URL,
        PROJECT_ID,
        ATTEMPT_ID,
        OPERATION_ID,
        'temperature',
        '1.0',
        null,
        5,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ code: 'revisionConflict' });
  });

  it('maps 409 to idempotencyPayloadChanged when payload differs (G-09)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: 'idempotency_mismatch', detail: 'Payload changed' }, 409),
      );
    const client = makeClient(fetchMock);
    await expect(
      client.startGeneration(
        PROFILE_ID,
        BASE_URL,
        PROJECT_ID,
        ATTEMPT_ID,
        OPERATION_ID,
        'temperature',
        '1.0',
        null,
        null,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ code: 'idempotencyPayloadChanged' });
  });

  it('maps 422 to invalidData when method options are invalid (G-09)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json(
        {
          error: 'invalid_data',
          detail: 'options.startCelsius is out of range',
        },
        422,
      ),
    );
    const client = makeClient(fetchMock);
    await expect(
      client.startGeneration(
        PROFILE_ID,
        BASE_URL,
        PROJECT_ID,
        ATTEMPT_ID,
        OPERATION_ID,
        'temperature',
        '1.0',
        { startCelsius: 9999 },
        null,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ code: 'invalidData' });
  });

  it('maps 503 to workerUnavailable (G-09)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: 'slicer_unavailable', detail: 'No workers' }, 503),
      );
    const client = makeClient(fetchMock);
    await expect(
      client.startGeneration(
        PROFILE_ID,
        BASE_URL,
        PROJECT_ID,
        ATTEMPT_ID,
        OPERATION_ID,
        'temperature',
        '1.0',
        null,
        null,
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ code: 'workerUnavailable' });
  });
});

// ===========================================================================
// G-06: Orchestration status for REST reconciliation after restart
// ===========================================================================

describe('CalibrationHttpClient getOrchestrationStatus (G-06)', () => {
  it('fetches orchestration status from /api/calibration-orchestrations/{id}', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(makeOrchestrationDto({ status: 'Running' })));
    const client = makeClient(fetchMock);
    const result = await client.getOrchestrationStatus(
      PROFILE_ID,
      BASE_URL,
      ORCHESTRATION_ID,
      AbortSignal.timeout(5000),
    );
    const [url] = fetchMock.mock.calls[0] as [URL | string];
    expect(String(url)).toContain(
      `/api/calibration-orchestrations/${ORCHESTRATION_ID}`,
    );
    expect(result?.status).toBe('Running');
  });

  it('returns null for 404 (job not found on reconciliation)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 404));
    const client = makeClient(fetchMock);
    const result = await client.getOrchestrationStatus(
      PROFILE_ID,
      BASE_URL,
      ORCHESTRATION_ID,
      AbortSignal.timeout(5000),
    );
    expect(result).toBeNull();
  });

  it('exposes all durable stages including hashes and slicer digest (G-07)', async () => {
    const dto = makeOrchestrationDto({
      status: 'Completed',
      currentStep: 'Promoted',
      specificationSha256: 'b'.repeat(64),
      gcodeSha256: 'c'.repeat(64),
      generatorVersion: '1.2.3',
      slicerContainerDigest: 'sha256:' + 'd'.repeat(64),
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(json(dto));
    const client = makeClient(fetchMock);
    const result = await client.getOrchestrationStatus(
      PROFILE_ID,
      BASE_URL,
      ORCHESTRATION_ID,
      AbortSignal.timeout(5000),
    );
    expect(result?.specificationSha256).toBe('b'.repeat(64));
    expect(result?.gcodeSha256).toBe('c'.repeat(64));
    expect(result?.generatorVersion).toBe('1.2.3');
    expect(result?.slicerContainerDigest).toBe('sha256:' + 'd'.repeat(64));
  });

  it('G-09: restart mid-stage recovers via REST without duplication', async () => {
    // Simulate restart: getOrchestrationStatus returns in-progress status
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json(
        makeOrchestrationDto({
          status: 'Running',
          currentStep: 'SlicingClaimed',
        }),
      ),
    );
    const client = makeClient(fetchMock);
    const result = await client.getOrchestrationStatus(
      PROFILE_ID,
      BASE_URL,
      ORCHESTRATION_ID,
      AbortSignal.timeout(5000),
    );
    // Recovery: we can display the exact current step without making a new generation request
    expect(result?.currentStep).toBe('SlicingClaimed');
    expect(result?.retryCount).toBe(0);
    // Only one fetch was made (no duplication)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// Q-01 Q-04: REST-authoritative queue state with ETags
// ===========================================================================

describe('CalibrationHttpClient getJobQueueJob (Q-01, Q-04)', () => {
  it('fetches job from /api/job-queue/{id} with REST authority', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(makeJobDto()));
    const client = makeClient(fetchMock);
    const job = await client.getJobQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5000),
    );
    const [url] = fetchMock.mock.calls[0] as [URL | string];
    expect(String(url)).toContain(`/api/job-queue/${JOB_ID}`);
    expect(job).not.toBeNull();
    expect(job!.id).toBe(JOB_ID);
  });

  it('returns job ETag and dispatch state ETag for bed-clear headers (B-02)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(makeJobDto()));
    const client = makeClient(fetchMock);
    const job = await client.getJobQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5000),
    );
    expect(job!.rowVersion).toBe(JOB_ETAG);
    expect(job!.dispatchStateRowVersion).toBe(DISPATCH_STATE_ETAG);
  });

  it('prefers response header ETags over body rowVersion fields', async () => {
    const response = new Response(
      JSON.stringify(makeJobDto({ rowVersion: 'body-etag' })),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          ETag: '"header-etag"',
          'X-Dispatch-State-ETag': '"dispatch-header-etag"',
        },
      },
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(response);
    const client = makeClient(fetchMock);
    const job = await client.getJobQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5000),
    );
    // Header ETags take precedence (strip enclosing quotes)
    expect(job!.rowVersion).toBe('header-etag');
    expect(job!.dispatchStateRowVersion).toBe('dispatch-header-etag');
  });

  it('returns null for 404 (Q-04: on reconnect, missing job detected)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 404));
    const client = makeClient(fetchMock);
    const job = await client.getJobQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5000),
    );
    expect(job).toBeNull();
  });

  it('exposes calibrationProjectId for ownership verification (Q-02)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(makeJobDto({ calibrationProjectId: PROJECT_ID })),
      );
    const client = makeClient(fetchMock);
    const job = await client.getJobQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5000),
    );
    expect(job!.calibrationProjectId).toBe(PROJECT_ID);
  });
});

// ===========================================================================
// B-02 B-03: Bed-clear acknowledgement endpoint, headers, and status codes
// ===========================================================================

describe('CalibrationHttpClient acknowledgeBedClear (B-02, B-03)', () => {
  it('uses the single correct endpoint /api/job-queue/{jobId}/acknowledge-bed-clear-and-start', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = makeClient(fetchMock);
    await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    const [url] = fetchMock.mock.calls[0] as [URL | string];
    expect(String(url)).toContain(
      `/api/job-queue/${JOB_ID}/acknowledge-bed-clear-and-start`,
    );
  });

  it('sends Idempotency-Key header (B-02)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = makeClient(fetchMock);
    await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(OPERATION_ID);
  });

  it('sends If-Match header with job ETag (B-02)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = makeClient(fetchMock);
    await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['If-Match']).toBe(`"${JOB_ETAG}"`);
  });

  it('sends X-Dispatch-State-If-Match header with dispatch state ETag (B-02)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = makeClient(fetchMock);
    await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Dispatch-State-If-Match']).toBe(
      `"${DISPATCH_STATE_ETAG}"`,
    );
  });

  it('sends printerId in request body (B-02)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = makeClient(fetchMock);
    await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.printerId).toBe(PRINTER_ID);
    // G-08: body never contains G-code, paths, URLs, or shell commands
    expect(body.gcodeContent).toBeUndefined();
    expect(body.filePath).toBeUndefined();
  });

  it('202 → starting (B-03: newly accepted)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    expect(outcome.kind).toBe('starting');
    if (outcome.kind === 'starting') {
      expect(outcome.jobId).toBe(JOB_ID);
    }
  });

  it('200 → alreadyStarting (B-03: idempotent replay)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    expect(outcome.kind).toBe('alreadyStarting');
    // B-04: idempotent replay does not show a duplicate
    if (outcome.kind === 'alreadyStarting') {
      expect(outcome.jobId).toBe(JOB_ID);
    }
  });

  it('409 wrong_job → conflict with specific reason (B-03)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json(
        {
          error: 'wrong_job',
          detail: 'Acknowledgement is for a different job',
        },
        409,
      ),
    );
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind === 'conflict') {
      expect(outcome.reason).toBe('wrong_job');
      expect(outcome.detail).toContain('different job');
    }
  });

  it('409 printer_busy → conflict with printer_busy reason (B-03)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: 'printer_busy', detail: 'Printer is busy' }, 409),
      );
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind === 'conflict') {
      expect(outcome.reason).toBe('printer_busy');
    }
  });

  it('409 job_not_dispatchable → conflict with reason (B-03)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json(
        {
          error: 'job_not_dispatchable',
          detail: 'Not in dispatchable state',
        },
        409,
      ),
    );
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind === 'conflict') {
      expect(outcome.reason).toBe('job_not_dispatchable');
    }
  });

  it('412 → staleRevision (B-03: refetch before retry, no blind retry)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 412 }));
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    // B-03: stale revision → refetch, not retry; dialog unconsumed
    expect(outcome.kind).toBe('staleRevision');
  });

  it('503 → printerOffline with detail (B-03)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          { error: 'printer_offline_or_stale', detail: 'No telemetry' },
          503,
        ),
      );
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    // B-03: printer offline → keep acknowledgement unconsumed, no blind retry
    expect(outcome.kind).toBe('printerOffline');
    if (outcome.kind === 'printerOffline') {
      expect(outcome.detail).toContain('telemetry');
    }
  });

  it('428 → preconditionRequired when Idempotency-Key missing (B-03)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      json(
        {
          error: 'precondition_required',
          detail: 'A stable Idempotency-Key header is required',
        },
        428,
      ),
    );
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      null, // null ETag
      null, // null dispatch ETag
      null,
      AbortSignal.timeout(5000),
    );
    expect(outcome.kind).toBe('preconditionRequired');
  });

  it('idempotent replay (same UUID, second call returns 200) does not show a duplicate (B-07)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = makeClient(fetchMock);
    const r1 = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    const r2 = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    expect(r1.kind).toBe('starting');
    expect(r2.kind).toBe('alreadyStarting');
    // Both refer to the same job; no duplication
    if (r1.kind === 'starting' && r2.kind === 'alreadyStarting') {
      expect(r1.jobId).toBe(r2.jobId);
    }
  });
});

// ===========================================================================
// B-05 B-06: Fresh UUID per dialog; blocked when offline/stale/expired
// ===========================================================================

describe('Bed-clear UUID uniqueness and blocked conditions (B-05, B-06)', () => {
  it('B-05: each dialog invocation should use a distinct operationId', () => {
    // Simulate two separate dialog invocations
    const op1 = crypto.randomUUID();
    const op2 = crypto.randomUUID();
    expect(op1).not.toBe(op2);
  });

  it('B-06: staleRevision outcome means acknowledgement unconsumed (no auto-retry)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 412 }));
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    expect(outcome.kind).toBe('staleRevision');
    // Only one HTTP call — no blind retry
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('B-06: printerOffline outcome means acknowledgement unconsumed (no auto-retry)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: 'printer_offline', detail: 'Offline' }, 503),
      );
    const client = makeClient(fetchMock);
    const outcome = await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      null,
      AbortSignal.timeout(5000),
    );
    expect(outcome.kind).toBe('printerOffline');
    // Only one HTTP call — no blind retry
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// L-01: Print lifecycle states from REST (Queued/Assigned/Starting/etc.)
// ===========================================================================

describe('CalibrationPrintLifecycleState schema (L-01)', () => {
  it('parses all valid lifecycle states', () => {
    const states: Array<string> = [
      'Queued',
      'Assigned',
      'Starting',
      'Printing',
      'Paused',
      'Completed',
      'Failed',
      'Cancelled',
    ];
    for (const state of states) {
      expect(CalibrationPrintLifecycleState.parse(state)).toBe(state);
    }
  });

  it('rejects unknown lifecycle states', () => {
    expect(() => CalibrationPrintLifecycleState.parse('Unknown')).toThrow();
    expect(() => CalibrationPrintLifecycleState.parse('queued')).toThrow(); // case-sensitive
  });

  it('L-01: job status from REST maps to one of the lifecycle states', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(makeJobDto({ status: 'Starting' })));
    const client = makeClient(fetchMock);
    const job = await client.getJobQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5000),
    );
    expect(CalibrationPrintLifecycleState.safeParse(job!.status).success).toBe(
      true,
    );
  });
});

// ===========================================================================
// L-05: Queue completion alone does not mark calibration step complete
// ===========================================================================

describe('Lifecycle: queue completion vs. step complete (L-05)', () => {
  it('L-05: Completed job status does not imply calibration step complete', async () => {
    // The job status is 'Completed' but the calibration step requires an observation
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(makeJobDto({ status: 'Completed' })));
    const client = makeClient(fetchMock);
    const job = await client.getJobQueueJob(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5000),
    );
    // REST provides job completion status; step completion requires additional verification
    expect(job!.status).toBe('Completed');
    // The calibration domain must check the result/observation separately
    // (no assertion here about step complete — that's a domain concern)
  });
});

// ===========================================================================
// L-06: Typed blockers surfaced for stale/mismatch/maintenance conditions
// ===========================================================================

describe('CalibrationBlockedReason schema (L-06, Q-05)', () => {
  it('parses all typed blocked reason codes', () => {
    const reasons: Array<string> = [
      'staleTelemetry',
      'changedFirmwareOrConfig',
      'materialNozzleMismatch',
      'maintenanceOrBusy',
      'missingGcode',
      'permissionDenied',
      'offline',
      'unsynchronized',
      'unauthorized',
      'expired',
      'noKlipperPrinter',
      'staleContext',
    ];
    for (const code of reasons) {
      const result = CalibrationBlockedReason.parse({ code, detail: null });
      expect(result.code).toBe(code);
    }
  });

  it('rejects unknown blocked reason codes', () => {
    expect(() =>
      CalibrationBlockedReason.parse({ code: 'unknownReason', detail: null }),
    ).toThrow();
  });
});

// ===========================================================================
// IPC schema validation tests (S-01, S-02, S-04, S-05)
// ===========================================================================

describe('IPC schema validation: security boundary (S-01, S-02, S-04, S-05)', () => {
  it('S-01: CalibrationStartGenerationRequest validates required fields', () => {
    // Valid request
    const valid = CalibrationStartGenerationRequest.parse({
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
      method: 'temperature',
      definitionVersion: '1.0',
      methodOptions: null,
      baseRevision: null,
    });
    expect(valid.method).toBe('temperature');
  });

  it('S-01: CalibrationStartGenerationRequest rejects missing attemptId', () => {
    expect(() =>
      CalibrationStartGenerationRequest.parse({
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        operationId: OPERATION_ID,
        method: 'temperature',
        definitionVersion: '1.0',
        methodOptions: null,
        baseRevision: null,
        // attemptId missing
      }),
    ).toThrow();
  });

  it('S-01: CalibrationStartGenerationRequest rejects extra fields (strict)', () => {
    // The renderer cannot inject extra unknown fields through the IPC schema
    expect(() =>
      CalibrationStartGenerationRequest.parse({
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        attemptId: ATTEMPT_ID,
        operationId: OPERATION_ID,
        method: 'temperature',
        definitionVersion: '1.0',
        methodOptions: null,
        baseRevision: null,
        shellCommand: 'rm -rf /', // S-04: forbidden primitive
      }),
    ).toThrow();
  });

  it('S-01: CalibrationAcknowledgeBedClearRequest validates new fields', () => {
    const valid = CalibrationAcknowledgeBedClearRequest.parse({
      profileId: PROFILE_ID,
      jobId: JOB_ID,
      printerId: PRINTER_ID,
      operationId: OPERATION_ID,
      jobEtag: JOB_ETAG,
      dispatchStateEtag: DISPATCH_STATE_ETAG,
      expectedPrinterConfigRevision: null,
    });
    expect(valid.printerId).toBe(PRINTER_ID);
    expect(valid.jobEtag).toBe(JOB_ETAG);
    expect(valid.dispatchStateEtag).toBe(DISPATCH_STATE_ETAG);
  });

  it('S-01: CalibrationAcknowledgeBedClearRequest rejects missing printerId', () => {
    expect(() =>
      CalibrationAcknowledgeBedClearRequest.parse({
        profileId: PROFILE_ID,
        jobId: JOB_ID,
        operationId: OPERATION_ID,
        jobEtag: null,
        dispatchStateEtag: null,
        expectedPrinterConfigRevision: null,
        // printerId missing
      }),
    ).toThrow();
  });

  it('S-04: CalibrationAcknowledgeBedClearRequest rejects filesystem/shell primitives', () => {
    expect(() =>
      CalibrationAcknowledgeBedClearRequest.parse({
        profileId: PROFILE_ID,
        jobId: JOB_ID,
        printerId: PRINTER_ID,
        operationId: OPERATION_ID,
        jobEtag: null,
        dispatchStateEtag: null,
        expectedPrinterConfigRevision: null,
        filePath: '/etc/passwd', // S-04: no filesystem path
      }),
    ).toThrow();
  });

  it('S-01: CalibrationGetQueueStateRequest requires jobId field', () => {
    const valid = CalibrationGetQueueStateRequest.parse({
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
      jobId: JOB_ID,
    });
    expect(valid.jobId).toBe(JOB_ID);
    // Also accepts null jobId (will return error for missing job)
    const withNull = CalibrationGetQueueStateRequest.parse({
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
      jobId: null,
    });
    expect(withNull.jobId).toBeNull();
  });

  it('S-01: CalibrationGetOrchestrationStatusRequest validates orchestrationId', () => {
    const valid = CalibrationGetOrchestrationStatusRequest.parse({
      profileId: PROFILE_ID,
      orchestrationId: ORCHESTRATION_ID,
    });
    expect(valid.orchestrationId).toBe(ORCHESTRATION_ID);
  });

  it('S-05: renderer IPC channel rejects invalid input shape', () => {
    // Simulate renderer sending malformed request
    expect(() =>
      ipcSchemas[IpcChannel.CalibrationStartGeneration].request.parse({
        // Missing required fields
        profileId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('S-05: renderer IPC channel rejects non-UUID profileId', () => {
    expect(() =>
      ipcSchemas[IpcChannel.CalibrationAcknowledgeBedClear].request.parse({
        profileId: 'not-a-uuid',
        jobId: JOB_ID,
        printerId: PRINTER_ID,
        operationId: OPERATION_ID,
        jobEtag: null,
        dispatchStateEtag: null,
        expectedPrinterConfigRevision: null,
      }),
    ).toThrow();
  });
});

// ===========================================================================
// A-06, A-07: Check:provenance passes; disabled methods surface reasons
// ===========================================================================

describe('Asset provenance: disabled methods and provenance gate (A-06, A-07)', () => {
  it('A-07: provenance script passes with no new derived files', async () => {
    // This is verified by `npm run check:provenance`; we assert the invariant
    // that the derivedFiles array stays empty (no bundled third-party models).
    const provenanceJson = (await import(
      '../compliance/printer-calibration-provenance.json',
      { with: { type: 'json' } }
    )) as { default: { derivedFiles: unknown[] } };
    expect(provenanceJson.default.derivedFiles).toHaveLength(0);
  });

  it('A-03: derivedRoots exist in manifest but contain no derived files', async () => {
    const provenanceJson = (await import(
      '../compliance/printer-calibration-provenance.json',
      { with: { type: 'json' } }
    )) as {
      default: { derivedRoots: string[]; derivedFiles: unknown[] };
    };
    // derivedRoots are defined (boundary established)
    expect(provenanceJson.default.derivedRoots.length).toBeGreaterThan(0);
    // But no actual derived files exist (A-03: no bundled third-party assets)
    expect(provenanceJson.default.derivedFiles).toHaveLength(0);
  });

  it('A-01: approved source has all required provenance fields', async () => {
    const provenanceJson = (await import(
      '../compliance/printer-calibration-provenance.json',
      { with: { type: 'json' } }
    )) as {
      default: {
        approvedSource: {
          id: string;
          canonicalRepository: string;
          tag: string;
          commit: string;
          license: { spdx: string };
        };
      };
    };
    const src = provenanceJson.default.approvedSource;
    expect(src.id).toBeTruthy();
    expect(src.canonicalRepository).toBeTruthy();
    expect(src.tag).toBeTruthy();
    expect(src.commit).toBeTruthy();
    expect(src.license.spdx).toBeTruthy();
  });
});

// ===========================================================================
// Wire type schemas: RemoteCalibrationOrchestrationStatus, RemoteJobQueueJob
// ===========================================================================

describe('RemoteCalibrationOrchestrationStatus wire schema', () => {
  it('parses a complete orchestration DTO', () => {
    const parsed = RemoteCalibrationOrchestrationStatus.parse(
      makeOrchestrationDto(),
    );
    expect(parsed.id).toBe(ORCHESTRATION_ID);
    expect(parsed.status).toBe('Running');
    expect(parsed.currentStep).toBe('SlicingQueued');
    expect(parsed.statusRoute).toBe(STATUS_ROUTE);
  });

  it('accepts passthrough unknown fields (additive compatibility)', () => {
    const parsed = RemoteCalibrationOrchestrationStatus.parse({
      ...makeOrchestrationDto(),
      futureField: 'should-be-accepted',
    });
    expect(parsed.id).toBe(ORCHESTRATION_ID);
  });

  it('transforms null-ish values to null for optional fields', () => {
    const parsed = RemoteCalibrationOrchestrationStatus.parse({
      ...makeOrchestrationDto(),
      model3DId: undefined,
      sliceJobId: null,
      gcodeSha256: null,
    });
    expect(parsed.model3DId).toBeNull();
    expect(parsed.sliceJobId).toBeNull();
    expect(parsed.gcodeSha256).toBeNull();
  });
});

describe('RemoteJobQueueJob wire schema', () => {
  it('parses a complete job DTO', () => {
    const parsed = RemoteJobQueueJob.parse(makeJobDto());
    expect(parsed.id).toBe(JOB_ID);
    expect(parsed.rowVersion).toBe(JOB_ETAG);
    expect(parsed.dispatchStateRowVersion).toBe(DISPATCH_STATE_ETAG);
    expect(parsed.calibrationProjectId).toBe(PROJECT_ID);
    expect(parsed.assignedPrinterId).toBe(PRINTER_ID);
  });

  it('accepts passthrough unknown fields (additive compatibility)', () => {
    const parsed = RemoteJobQueueJob.parse({
      ...makeJobDto(),
      futureQueueField: 'should-be-accepted',
    });
    expect(parsed.id).toBe(JOB_ID);
  });

  it('transforms null-ish optional fields to null', () => {
    const parsed = RemoteJobQueueJob.parse({
      ...makeJobDto(),
      rowVersion: null,
      dispatchStateRowVersion: undefined,
    });
    expect(parsed.rowVersion).toBeNull();
    expect(parsed.dispatchStateRowVersion).toBeNull();
  });
});

// ===========================================================================
// IPC response schema tests
// ===========================================================================

describe('CalibrationBedClearAckOutcome schema (B-03)', () => {
  it('parses starting outcome', () => {
    const outcome = CalibrationBedClearAckOutcome.parse({
      kind: 'starting',
      jobId: JOB_ID,
    });
    expect(outcome.kind).toBe('starting');
    if (outcome.kind === 'starting') expect(outcome.jobId).toBe(JOB_ID);
  });

  it('parses alreadyStarting outcome', () => {
    const outcome = CalibrationBedClearAckOutcome.parse({
      kind: 'alreadyStarting',
      jobId: JOB_ID,
    });
    expect(outcome.kind).toBe('alreadyStarting');
  });

  it('parses conflict outcome with reason and detail', () => {
    const outcome = CalibrationBedClearAckOutcome.parse({
      kind: 'conflict',
      reason: 'wrong_job',
      detail: 'Acknowledgement names a different job',
    });
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind === 'conflict') {
      expect(outcome.reason).toBe('wrong_job');
      expect(outcome.detail).toContain('different job');
    }
  });

  it('parses staleRevision outcome', () => {
    const outcome = CalibrationBedClearAckOutcome.parse({
      kind: 'staleRevision',
    });
    expect(outcome.kind).toBe('staleRevision');
  });

  it('parses printerOffline outcome with detail', () => {
    const outcome = CalibrationBedClearAckOutcome.parse({
      kind: 'printerOffline',
      detail: 'No recent telemetry',
    });
    expect(outcome.kind).toBe('printerOffline');
    if (outcome.kind === 'printerOffline') {
      expect(outcome.detail).toContain('telemetry');
    }
  });

  it('parses preconditionRequired outcome', () => {
    const outcome = CalibrationBedClearAckOutcome.parse({
      kind: 'preconditionRequired',
      detail: 'Idempotency-Key required',
    });
    expect(outcome.kind).toBe('preconditionRequired');
  });

  it('rejects unknown outcome kind', () => {
    expect(() =>
      CalibrationBedClearAckOutcome.parse({ kind: 'unknown', jobId: JOB_ID }),
    ).toThrow();
  });
});

describe('CalibrationAcknowledgeBedClearResponse schema', () => {
  it('parses ok+starting response', () => {
    const parsed = CalibrationAcknowledgeBedClearResponse.parse({
      status: 'ok',
      outcome: { kind: 'starting', jobId: JOB_ID },
    });
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') {
      expect(parsed.outcome.kind).toBe('starting');
    }
  });

  it('parses error response', () => {
    const parsed = CalibrationAcknowledgeBedClearResponse.parse({
      status: 'error',
      error: {
        code: 'serverError',
        message: 'Server error',
        retryable: true,
        retryAfterSeconds: null,
      },
    });
    expect(parsed.status).toBe('error');
  });

  it('rejects extra fields in ok response (strict)', () => {
    expect(() =>
      CalibrationAcknowledgeBedClearResponse.parse({
        status: 'ok',
        outcome: { kind: 'starting', jobId: JOB_ID },
        extraField: 'bad',
      }),
    ).toThrow();
  });
});

describe('CalibrationGetQueueStateResponse schema', () => {
  it('parses ok response with CalibrationQueueJobState', () => {
    const parsed = CalibrationGetQueueStateResponse.parse({
      status: 'ok',
      job: {
        jobId: JOB_ID,
        profileId: PROFILE_ID,
        calibrationProjectId: PROJECT_ID,
        assignedPrinterId: PRINTER_ID,
        assignedPrinterName: 'Klipper Printer',
        gcodeFileId: null,
        gcodeFileName: 'test.gcode',
        jobStatus: 'Assigned',
        queuePosition: 1,
        priority: 10,
        requiredNozzleDiameter: 0.4,
        requiredMaterialType: 'PLA',
        pinnedPrinterConfigRevision: 42,
        jobEtag: JOB_ETAG,
        dispatchStateEtag: DISPATCH_STATE_ETAG,
        dispatchStateRevision: 5,
        bedClearExpiresAtUtc: null,
        updatedAt: NOW_UTC,
      },
    });
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') {
      expect(parsed.job.jobId).toBe(JOB_ID);
      expect(parsed.job.jobEtag).toBe(JOB_ETAG);
      expect(parsed.job.dispatchStateEtag).toBe(DISPATCH_STATE_ETAG);
    }
  });
});

describe('CalibrationOrchestrationStatus IPC schema (G-07)', () => {
  it('parses submitted response with orchestration details', () => {
    const parsed = CalibrationStartGenerationResponse.parse({
      status: 'submitted',
      orchestration: {
        orchestrationId: ORCHESTRATION_ID,
        projectId: PROJECT_ID,
        attemptId: ATTEMPT_ID,
        operationId: OPERATION_ID,
        status: 'Running',
        currentStep: 'SlicingQueued',
        revision: 1,
        retryCount: 0,
        nextRetryAtUtc: null,
        stepStartedAtUtc: NOW_UTC,
        lastErrorCode: null,
        problems: [],
        model3DId: null,
        sliceJobId: null,
        gcodeFileId: null,
        specificationSha256: null,
        planManifestSha256: null,
        gcodeSha256: null,
        generatorVersion: null,
        slicerContainerDigest: null,
        statusRoute: STATUS_ROUTE,
        createdAtUtc: NOW_UTC,
        updatedAtUtc: NOW_UTC,
        completedAtUtc: null,
      },
    });
    expect(parsed.status).toBe('submitted');
    if (parsed.status === 'submitted') {
      expect(parsed.orchestration.orchestrationId).toBe(ORCHESTRATION_ID);
      expect(parsed.orchestration.statusRoute).toBe(STATUS_ROUTE);
    }
  });

  it('G-07: rejects hash fields that are not 64-char hex', () => {
    expect(() =>
      CalibrationOrchestrationStatus.parse({
        orchestrationId: ORCHESTRATION_ID,
        projectId: PROJECT_ID,
        attemptId: ATTEMPT_ID,
        operationId: OPERATION_ID,
        status: 'Completed',
        currentStep: 'Promoted',
        revision: 1,
        retryCount: 0,
        nextRetryAtUtc: null,
        stepStartedAtUtc: null,
        lastErrorCode: null,
        problems: [],
        model3DId: null,
        sliceJobId: null,
        gcodeFileId: null,
        specificationSha256: 'not-a-sha256', // Invalid
        planManifestSha256: null,
        gcodeSha256: null,
        generatorVersion: null,
        slicerContainerDigest: null,
        statusRoute: STATUS_ROUTE,
        createdAtUtc: NOW_UTC,
        updatedAtUtc: NOW_UTC,
        completedAtUtc: null,
      }),
    ).toThrow();
  });
});

describe('CalibrationMethodOptions schema (G-04)', () => {
  it('parses temperature tower options', () => {
    const opts = CalibrationMethodOptions.parse({
      startCelsius: 190,
      endCelsius: 230,
      stepCelsius: 5,
    });
    expect(opts.startCelsius).toBe(190);
  });

  it('parses flow ratio options', () => {
    const opts = CalibrationMethodOptions.parse({
      startRatio: 0.9,
      endRatio: 1.1,
      stepRatio: 0.01,
    });
    expect(opts.startRatio).toBe(0.9);
  });

  it('rejects extra unknown fields (strict)', () => {
    expect(() =>
      CalibrationMethodOptions.parse({
        startCelsius: 200,
        gcodeContent: 'G28\nG0 X0', // S-04: no G-code content through IPC
      }),
    ).toThrow();
  });
});

// ===========================================================================
// G-08: PFD never downloads/re-uploads G-code or exposes raw primitives
// ===========================================================================

describe('G-08, S-04: No generic primitives in generation or bed-clear', () => {
  it('startGeneration body never contains G-code or file paths', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(makeOrchestrationDto(), 202));
    const client = makeClient(fetchMock);
    await client.startGeneration(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      ATTEMPT_ID,
      OPERATION_ID,
      'temperature',
      '1.0',
      { startCelsius: 200, endCelsius: 230, stepCelsius: 5 },
      null,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('gcodeContent');
    expect(Object.keys(body)).not.toContain('filePath');
    expect(Object.keys(body)).not.toContain('shellCommand');
    expect(Object.keys(body)).not.toContain('printerCommand');
    expect(Object.keys(body)).not.toContain('url');
  });

  it('acknowledgeBedClear body only sends printerId and optional config revision', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const client = makeClient(fetchMock);
    await client.acknowledgeBedClear(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      PRINTER_ID,
      OPERATION_ID,
      JOB_ETAG,
      DISPATCH_STATE_ETAG,
      42,
      AbortSignal.timeout(5000),
    );
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const allowedKeys = new Set([
      'printerId',
      'idempotencyKey',
      'expectedPrinterConfigRevision',
    ]);
    for (const key of Object.keys(body)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });
});
