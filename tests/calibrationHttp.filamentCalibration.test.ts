/**
 * CalibrationHttpClient — filament calibration slice pipeline (PR #1952).
 *
 * These tests exercise the five HTTP-client methods that back the desktop
 * filament-calibration workflow:
 *   - cloneSingleProfile           POST /api/slicer/profiles/clone
 *   - submitCalibrationSlice       POST /api/slice (calibration mode)
 *   - getSliceJobStatus            GET  /api/slice/{jobId}
 *   - sendSliceToPrinter           POST /api/slice/{jobId}/send-to-printer
 *   - updateCustomProfile          PUT  /api/slicer/profiles/custom/{id}
 *
 * Fixtures are built from verbatim DTO shapes cited in upstream PrintFarmer
 * PR #1952 (merged 2026-08-24):
 *
 *   - `SubmitSliceJobRequest`, `SubmitSliceJobResponse`, and the public
 *     `SliceJobStatusResponse` projection are pulled from
 *     `src/slicer/Farm.Slicer.Module/Contracts/SliceJobDtos.cs`
 *     @ SHA a4f230aad02a997bcfb16c9d6f588520044d4db7 (the PR's tip).
 *   - `SendToPrinterRequest` / `SendToPrinterResponse` are pulled from
 *     `src/api/Controllers/Requests/SendToPrinterRequest.cs`
 *     @ SHA 34412c068cd21464dbb30f471355f05105c482cf and
 *     `src/api/Controllers/Responses/SendToPrinterResponse.cs`
 *     @ SHA b65c764144ea8f961dfb50bbe0cb54d5016a5204.
 *   - `CalibrationMethod` enum vocabulary is pulled from
 *     `src/slicer/Farm.Slicer.Module/Models/CalibrationMethod.cs`
 *     @ SHA cbdbd55a2f2cc3f970430a7c5cc6664431c77492.
 *   - `CloneSingleProfileRequestDto` / `CloneSingleProfileResponseDto` are
 *     pulled from `src/slicer/Farm.Slicer.Module/Dtos/CloneProfilesDtos.cs`
 *     @ SHA 1207d6530282a0849dff28ac058491f3765fb1eb.
 *   - `UpdateCustomProfileRequestDto` / `ProfilesController` interactive
 *     gate + 422 `errorCode: unsupported_calibration_method` behaviour is
 *     pulled from `src/slicer/Farm.Slicer.Module.Api/Controllers/Slicing/ProfilesController.cs`
 *     @ SHA 171041657919a1994b641278b81a8cd71390b3f1.
 *
 * The critical shape decisions the tests bake in — because they were the
 * ones a naive read of the reframe prompt would get wrong:
 *
 *   1. `SliceJobStatusResponse` public projection has NO `resultFileUrl`.
 *      That field lives on the worker-only `CompleteSliceJobResponse`. The
 *      public projection has `artifactsRoute` instead — a relative URL for
 *      the per-job artifacts listing. The reframe prompt cited
 *      `resultFileUrl` as a public field; the source-of-truth check against
 *      PR #1952 corrected that.
 *   2. `slicerEngine` is the string `"OrcaSlicer"`, not the integer 0.
 *      That's a fixture-shape-driven decision — the SubmitSliceJobRequest
 *      docstring in the DTO file spells it out.
 *   3. A calibration slice OMITS `modelFileUrl`, `model3DId`,
 *      `calibrationProjectId`, `calibrationAttemptId`, and
 *      `calibrationOrchestrationId`. The worker resolves the calibration
 *      model from its own bundled `resources/calib/`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationHttpClient,
  CalibrationHttpError,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';
import {
  SLICE_POLL_INITIAL_DELAY_MS,
  SLICE_POLL_MAX_ATTEMPTS,
  SLICE_POLL_MAX_DELAY_MS,
  classifySliceJobTerminalOutcome,
  computeSlicePollHint,
} from '../src/main/calibrationSlicePoll.js';

const BASE_URL = 'http://farm.local';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PRINTER_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const CLONE_ID = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '55555555-5555-4555-8555-555555555555';
const OPERATION_ID = '66666666-6666-4666-8666-666666666666';

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

function problem(
  body: {
    title?: string;
    detail?: string;
    errorCode?: string;
    supportedMethods?: readonly string[];
  },
  status: number,
): Response {
  return new Response(
    JSON.stringify({
      type: 'https://httpstatuses.com/' + status,
      status,
      ...body,
    }),
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );
}

function stableTokens(): CalibrationTokenProvider {
  return {
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      baseUrl: BASE_URL,
      token: 'test-jwt',
      binding: 'binding-abc123',
    }),
  };
}

function makeClient(fetchMock: typeof globalThis.fetch) {
  return new CalibrationHttpClient(stableTokens(), {
    fetch: fetchMock,
    timeoutMs: 10_000,
    maxResponseBytes: 1024 * 1024,
    now: () => Date.now(),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });
}

// ------------------------------ cloneSingleProfile -------------------------

describe('CalibrationHttpClient.cloneSingleProfile', () => {
  // Verbatim `CloneSingleProfileResponseDto` from CloneProfilesDtos.cs @
  // 1207d6530282a0849dff28ac058491f3765fb1eb.
  const cloneOk = () => ({
    id: CLONE_ID,
    name: 'PolyLite PLA Blue',
    profileType: 'filament',
    isSystem: false,
  });

  it('POSTs the clone request with an idempotency-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(cloneOk(), 201));
    const client = makeClient(fetchMock);

    const result = await client.cloneSingleProfile(
      PROFILE_ID,
      BASE_URL,
      {
        sourceProfileId: SOURCE_PROFILE_ID,
        profileType: 'filament',
        name: 'PolyLite PLA Blue',
        idempotencyKey: OPERATION_ID,
      },
      AbortSignal.timeout(5_000),
    );

    expect(result.id).toBe(CLONE_ID);
    expect(result.isSystem).toBe(false);
    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(`${BASE_URL}/api/slicer/profiles/clone`);
    expect(call[1].method).toBe('POST');
    const headers = call[1].headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(OPERATION_ID);
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.sourceProfileId).toBe(SOURCE_PROFILE_ID);
    expect(parsed.profileType).toBe('filament');
    expect(parsed.name).toBe('PolyLite PLA Blue');
    // Nullable fields sent as explicit nulls, matching upstream's
    // `CloneSingleProfileRequestDto` shape.
    expect(parsed.printerModelId).toBeNull();
    expect(parsed.compatiblePrinters).toBeNull();
  });

  it('maps 403 InteractiveSessionRequirement to interactiveSessionRequired', async () => {
    // `InteractiveSessionRequirement` returns a bare 403 with no
    // ProblemDetails body — cited on ProfilesController.cs:1247-1283.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(problem({ title: 'Forbidden' }, 403));
    const client = makeClient(fetchMock);

    let caught: CalibrationHttpError | undefined;
    try {
      await client.cloneSingleProfile(
        PROFILE_ID,
        BASE_URL,
        {
          sourceProfileId: SOURCE_PROFILE_ID,
          profileType: 'filament',
          name: 'clone',
          idempotencyKey: OPERATION_ID,
        },
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      caught = error as CalibrationHttpError;
    }
    expect(caught).toBeInstanceOf(CalibrationHttpError);
    expect(caught?.code).toBe('interactiveSessionRequired');
    expect(caught?.status).toBe(403);
  });
});

// ------------------------------ submitCalibrationSlice ---------------------

describe('CalibrationHttpClient.submitCalibrationSlice', () => {
  // Verbatim `SubmitSliceJobResponse` from SliceJobDtos.cs @
  // a4f230aad02a997bcfb16c9d6f588520044d4db7:
  //   JobId Guid, JobStatus SliceJobStatus, QueuedAt DateTime,
  //   QueuePosition int? (nullable).
  const submitOk = () => ({
    jobId: JOB_ID,
    jobStatus: 'Queued',
    queuedAt: '2026-08-24T14:30:00.000Z',
    queuePosition: 3,
  });

  it('POSTs a calibration slice with slicerEngine="OrcaSlicer" and no saga IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(submitOk()));
    const client = makeClient(fetchMock);

    await client.submitCalibrationSlice(
      PROFILE_ID,
      BASE_URL,
      {
        userId: '77777777-7777-4777-8777-777777777777',
        printerId: PRINTER_ID,
        slicerProfileJson: JSON.stringify({
          machineProfileName: 'Voron 2.4 350',
          processProfileName: '0.20mm Standard @Voron 2.4',
          filamentProfileName: 'PolyLite PLA Blue',
        }),
        method: 'flow_rate_pass_1',
        idempotencyKey: OPERATION_ID,
      },
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(`${BASE_URL}/api/slice`);
    expect(call[1].method).toBe('POST');
    const headers = call[1].headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(OPERATION_ID);
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    > & { calibration: Record<string, unknown> };
    // slicerEngine is the string "OrcaSlicer" per the SubmitSliceJobRequest
    // docstring in SliceJobDtos.cs.
    expect(parsed.slicerEngine).toBe('OrcaSlicer');
    // Saga identifiers MUST NOT be present — PR #1952 rejects them with
    // `calibration_mode_conflicts_with_saga_ids` (422), and that rejection
    // is the proof that a calibration slice stays eligible for
    // `send-to-printer`. Key *presence* matters, not value: a null-valued
    // key still counts as `hasOwnProperty` and trips the 422.
    expect(
      Object.prototype.hasOwnProperty.call(parsed, 'calibrationProjectId'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(parsed, 'calibrationAttemptId'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        parsed,
        'calibrationOrchestrationId',
      ),
    ).toBe(false);
    // Geometry hand-off fields MUST NOT be present — worker resolves from
    // `resources/calib/`.
    expect(Object.prototype.hasOwnProperty.call(parsed, 'modelFileUrl')).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(parsed, 'model3DId')).toBe(
      false,
    );
    // Calibration envelope carries method + defaulted-empty params.
    expect(parsed.calibration.method).toBe('flow_rate_pass_1');
    expect(parsed.calibration.params).toEqual({});
  });

  it('parses SubmitSliceJobResponse verbatim', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(submitOk()));
    const client = makeClient(fetchMock);

    const result = await client.submitCalibrationSlice(
      PROFILE_ID,
      BASE_URL,
      {
        userId: '77777777-7777-4777-8777-777777777777',
        printerId: PRINTER_ID,
        slicerProfileJson: '{}',
        method: 'flow_rate_pass_1',
        idempotencyKey: OPERATION_ID,
      },
      AbortSignal.timeout(5_000),
    );

    expect(result.jobId).toBe(JOB_ID);
    expect(result.jobStatus).toBe('Queued');
    expect(result.queuePosition).toBe(3);
  });

  it('maps 422 unsupported_calibration_method to unsupportedCalibrationMethod', async () => {
    // Server: `SliceJobController` returns 422 with
    // `errorCode: "unsupported_calibration_method"` in the ProblemDetails
    // extensions. Body: `supportedMethods: string[]`.
    const fetchMock = vi.fn().mockResolvedValue(
      problem(
        {
          title: 'Unsupported calibration method',
          errorCode: 'unsupported_calibration_method',
          supportedMethods: [
            'flow_rate_pass_1',
            'flow_rate_pass_2',
            'temperature_tower',
          ],
        },
        422,
      ),
    );
    const client = makeClient(fetchMock);

    let caught: CalibrationHttpError | undefined;
    try {
      await client.submitCalibrationSlice(
        PROFILE_ID,
        BASE_URL,
        {
          userId: '77777777-7777-4777-8777-777777777777',
          printerId: PRINTER_ID,
          slicerProfileJson: '{}',
          method: 'flow_rate_pass_1',
          idempotencyKey: OPERATION_ID,
        },
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      caught = error as CalibrationHttpError;
    }
    expect(caught).toBeInstanceOf(CalibrationHttpError);
    expect(caught?.code).toBe('unsupportedCalibrationMethod');
    expect(caught?.status).toBe(422);
  });
});

// ------------------------------ getSliceJobStatus --------------------------

describe('CalibrationHttpClient.getSliceJobStatus', () => {
  // Verbatim from `SliceJobController.MapToPublicStatusResponse` in PR #1952
  // (SlicePrintBridgeController.cs @ 32aae2fd2ae67f67d7f04b965071034791512d93,
  // lines 1215-1258).
  //
  // NB: NO `resultFileUrl` field. The public projection exposes
  // `artifactsRoute` instead — a relative URL for the per-job artifact
  // listing. `resultFileUrl` lives on the worker-only
  // `CompleteSliceJobResponse`.
  const statusFixture = (overrides: Record<string, unknown> = {}) => ({
    id: JOB_ID,
    status: 'Processing',
    progressPercent: 42,
    progressMessage: 'Slicing perimeters',
    queuedAt: '2026-08-24T14:30:00.000Z',
    startedAt: '2026-08-24T14:30:05.000Z',
    completedAt: null,
    errorMessage: null,
    layoutDegradation: null,
    failureReason: null,
    failureHint: null,
    estimatedPrintTimeSeconds: null,
    filamentUsedGrams: null,
    workerId: 'worker-01',
    modelFileName: 'flow_rate_pass_1.3mf',
    slicerEngine: 'OrcaSlicer',
    artifactsRoute: `/api/slice/${JOB_ID}/artifacts`,
    ...overrides,
  });

  it('GETs the public status projection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(statusFixture()));
    const client = makeClient(fetchMock);

    const result = await client.getSliceJobStatus(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(`${BASE_URL}/api/slice/${JOB_ID}`);
    expect(call[1]?.method ?? 'GET').toBe('GET');
    expect(result.id).toBe(JOB_ID);
    expect(result.status).toBe('Processing');
    expect(result.progressPercent).toBe(42);
    // artifactsRoute — the public projection's opaque URL fragment, NOT
    // resultFileUrl (which lives on the worker-only projection).
    expect(result.artifactsRoute).toBe(`/api/slice/${JOB_ID}/artifacts`);
  });

  it('parses a terminal Failed snapshot with failureReason and failureHint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        statusFixture({
          status: 'Failed',
          progressPercent: 87,
          completedAt: '2026-08-24T14:32:15.000Z',
          errorMessage: 'Slicer aborted',
          failureReason: 'slicer_engine_crash',
          failureHint: 'Worker returned no artifacts.',
        }),
      ),
    );
    const client = makeClient(fetchMock);

    const result = await client.getSliceJobStatus(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result.status).toBe('Failed');
    expect(result.failureReason).toBe('slicer_engine_crash');
    expect(result.failureHint).toBe('Worker returned no artifacts.');
  });
});

// ------------------------------ sendSliceToPrinter -------------------------

describe('CalibrationHttpClient.sendSliceToPrinter', () => {
  // Verbatim SendToPrinterResponse from SendToPrinterResponse.cs @
  // b65c764144ea8f961dfb50bbe0cb54d5016a5204.
  const sendOk = (printStarted: boolean) => ({
    jobId: JOB_ID,
    printerId: PRINTER_ID,
    fileName: 'flow_rate_pass_1.3mf',
    printStarted,
    message: printStarted ? 'Print started.' : 'Uploaded to printer queue.',
  });

  it('POSTs { printerId, startPrint: true } and echoes printStarted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(sendOk(true)));
    const client = makeClient(fetchMock);

    const result = await client.sendSliceToPrinter(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      {
        printerId: PRINTER_ID,
        startPrint: true,
        idempotencyKey: OPERATION_ID,
      },
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/slice/${JOB_ID}/send-to-printer`,
    );
    expect(call[1].method).toBe('POST');
    const headers = call[1].headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(OPERATION_ID);
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    // Body carries only the send-to-printer DTO fields — idempotencyKey
    // rides in the header, never in the body.
    expect(parsed).toEqual({ printerId: PRINTER_ID, startPrint: true });
    expect(result.printStarted).toBe(true);
    expect(result.fileName).toBe('flow_rate_pass_1.3mf');
  });

  it('POSTs { printerId, startPrint: false } for upload-only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(sendOk(false)));
    const client = makeClient(fetchMock);

    const result = await client.sendSliceToPrinter(
      PROFILE_ID,
      BASE_URL,
      JOB_ID,
      {
        printerId: PRINTER_ID,
        startPrint: false,
        idempotencyKey: OPERATION_ID,
      },
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.startPrint).toBe(false);
    expect(result.printStarted).toBe(false);
  });
});

// ------------------------------ updateCustomProfile ------------------------

describe('CalibrationHttpClient.updateCustomProfile', () => {
  // Verbatim `CloneSingleProfileResponseDto` — the PUT returns the updated
  // profile row in the same projection.
  const updatedOk = () => ({
    id: CLONE_ID,
    name: 'PolyLite PLA Blue',
    profileType: 'filament',
    isSystem: false,
  });

  it('PUTs the rawJson replacement with an idempotency-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(updatedOk()));
    const client = makeClient(fetchMock);

    await client.updateCustomProfile(
      PROFILE_ID,
      BASE_URL,
      CLONE_ID,
      {
        rawJson: '{"filament_flow_ratio": 0.98}',
        idempotencyKey: OPERATION_ID,
      },
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/slicer/profiles/custom/${CLONE_ID}`,
    );
    expect(call[1].method).toBe('PUT');
    const headers = call[1].headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(OPERATION_ID);
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    // Only non-null entries are respected server-side, per
    // ProfilesController.cs:1352-1395.
    expect(parsed.rawJson).toBe('{"filament_flow_ratio": 0.98}');
    // The other UpdateCustomProfileRequestDto fields are all serialized as
    // explicit nulls / false — the desktop only touches rawJson for a
    // measurement update.
    expect(parsed.name).toBeNull();
    expect(parsed.description).toBeNull();
    expect(parsed.printerModelId).toBeNull();
    expect(parsed.clearPrinterModelId).toBe(false);
    expect(parsed.compatiblePrinters).toBeNull();
    expect(parsed.clearCompatiblePrinters).toBe(false);
  });

  it('maps 403 InteractiveSessionRequirement to interactiveSessionRequired', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(problem({ title: 'Forbidden' }, 403));
    const client = makeClient(fetchMock);

    let caught: CalibrationHttpError | undefined;
    try {
      await client.updateCustomProfile(
        PROFILE_ID,
        BASE_URL,
        CLONE_ID,
        { rawJson: '{}', idempotencyKey: OPERATION_ID },
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      caught = error as CalibrationHttpError;
    }
    expect(caught).toBeInstanceOf(CalibrationHttpError);
    expect(caught?.code).toBe('interactiveSessionRequired');
  });
});

// ------------------------------ computeSlicePollHint -----------------------

describe('computeSlicePollHint', () => {
  it('returns the initial delay for attempt 0', () => {
    const hint = computeSlicePollHint(0);
    expect(hint.delayMs).toBe(SLICE_POLL_INITIAL_DELAY_MS);
    expect(hint.cappedOut).toBe(false);
  });

  it('grows the delay geometrically until the per-interval cap', () => {
    // Attempt 1: 500 * 1.5 = 750
    expect(computeSlicePollHint(1).delayMs).toBe(750);
    // Attempt 2: 500 * 1.5^2 = 1125
    expect(computeSlicePollHint(2).delayMs).toBe(1125);
    // Attempt 3: 500 * 1.5^3 ≈ 1688
    expect(computeSlicePollHint(3).delayMs).toBe(1688);
  });

  it('bounds the delay at SLICE_POLL_MAX_DELAY_MS', () => {
    // At attempt ~10, 500 * 1.5^10 ≈ 28,834 > 15,000 cap.
    const late = computeSlicePollHint(20);
    expect(late.delayMs).toBe(SLICE_POLL_MAX_DELAY_MS);
    expect(late.cappedOut).toBe(false);
  });

  it('reports cappedOut when the next attempt would exceed the cap', () => {
    // Next attempt = SLICE_POLL_MAX_ATTEMPTS = terminal.
    const hint = computeSlicePollHint(SLICE_POLL_MAX_ATTEMPTS - 1);
    expect(hint.delayMs).toBeNull();
    expect(hint.cappedOut).toBe(true);
  });

  it('remains cappedOut for any pollAttempt at or past the cap', () => {
    const hint = computeSlicePollHint(SLICE_POLL_MAX_ATTEMPTS + 100);
    expect(hint.delayMs).toBeNull();
    expect(hint.cappedOut).toBe(true);
  });

  it('defensively floors negative pollAttempt to zero', () => {
    const hint = computeSlicePollHint(-1);
    expect(hint.delayMs).toBe(SLICE_POLL_INITIAL_DELAY_MS);
    expect(hint.cappedOut).toBe(false);
  });
});

describe('classifySliceJobTerminalOutcome', () => {
  it('classifies Queued and Processing as non-terminal (null)', () => {
    expect(classifySliceJobTerminalOutcome('Queued')).toBeNull();
    expect(classifySliceJobTerminalOutcome('Processing')).toBeNull();
  });

  it('classifies Completed as completed', () => {
    expect(classifySliceJobTerminalOutcome('Completed')).toBe('completed');
  });

  it('classifies Failed as failed', () => {
    expect(classifySliceJobTerminalOutcome('Failed')).toBe('failed');
  });

  it('classifies Cancelled as failed (the renderer treats it as terminal-not-good)', () => {
    // A cancelled calibration slice is not a normal ending — either the
    // operator or an admin cut it short. Same UI treatment as Failed.
    expect(classifySliceJobTerminalOutcome('Cancelled')).toBe('failed');
  });
});
