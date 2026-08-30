/**
 * CalibrationHttpClient — project/attempt/observation/draft-profile methods
 * (issue #795).
 *
 * These exercise the transport-level counterpart to the draft-profile
 * write-back and completion-promotion path:
 *   - getProjectRecord   GET   /api/calibration-projects/{projectId}
 *   - createAttempt      POST  /api/calibration-projects/{projectId}/attempts
 *   - appendObservation  POST  /api/calibration-attempts/{attemptId}/observations
 *   - getDraftProfile    GET   /api/calibration-projects/{projectId}/draft-profile
 *   - completeProject    PATCH /api/calibration-projects/{projectId}
 *
 * Fixtures mirror the verbatim DTO shapes cited in
 * `src/main/calibrationWire.ts` (`RemoteCalibrationProjectRecord`,
 * `RemoteCalibrationAttemptRecord`, `RemoteCalibrationObservationRecord`,
 * `RemoteCalibrationDraftProfileRecord`), verified against PrintFarmer
 * commit `20630b47d593f90c6bc0c9ade4a1525a74d2b283`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationHttpClient,
  CalibrationHttpError,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';

const BASE_URL = 'http://farm.local';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PRINTER_ID = '22222222-2222-4222-8222-222222222222';
const FILAMENT_PRODUCT_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '77777777-7777-4777-8777-777777777777';
const ATTEMPT_ID = '99999999-9999-4999-8999-999999999999';
const OBSERVATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DRAFT_PROFILE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROMOTED_PROFILE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQUEST_ID = '88888888-8888-4888-8888-888888888888';
const OPERATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function notFound(): Response {
  return new Response(
    JSON.stringify({
      type: 'https://httpstatuses.com/404',
      status: 404,
      title: 'Not Found',
    }),
    { status: 404, headers: { 'content-type': 'application/problem+json' } },
  );
}

function problem(
  body: { title?: string; detail?: string; errorCode?: string },
  status: number,
): Response {
  return new Response(
    JSON.stringify({
      type: 'https://httpstatuses.com/' + status,
      status,
      ...body,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
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

function projectRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: PROJECT_ID,
    name: 'PolyLite PLA Blue (calibration project)',
    lifecycleStatus: 'Active',
    experienceMode: 'Coach',
    printerId: PRINTER_ID,
    selectedToolheadId: null,
    selectedToolheadIndex: null,
    filament: {
      provider: 'printfarmer',
      productId: FILAMENT_PRODUCT_ID,
      sku: null,
      vendor: null,
      productName: 'PolyLite PLA Blue',
      material: 'unknown',
      diameter: null,
      color: null,
      filamentTypeId: null,
      spoolmanFilamentId: null,
      localSpoolId: null,
      spoolmanSpoolId: null,
      snapshot: {},
    },
    orderedSteps: [],
    currentStep: null,
    currentSelections: {},
    revision: 1,
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    updatedAtUtc: '2026-01-01T00:00:00.000Z',
    completedAtUtc: null,
    deletedAtUtc: null,
    ...overrides,
  };
}

function attemptRecord(): Record<string, unknown> {
  return {
    id: ATTEMPT_ID,
    projectId: PROJECT_ID,
    sequence: 0,
    parentAttemptId: null,
    calibrationKind: 'temperature',
    method: 'temperature_tower',
    definitionVersion: '1',
    input: {},
    specification: { start_temperature_c: 150, end_temperature_c: 300 },
    specificationSha256: 'a'.repeat(64),
    profileSnapshotIds: {},
    actualSpoolSnapshot: null,
    disposition: 'Pending',
    createdAtUtc: '2026-01-01T00:00:00.000Z',
  };
}

function observationRecord(): Record<string, unknown> {
  return {
    id: OBSERVATION_ID,
    attemptId: ATTEMPT_ID,
    sequence: 0,
    observationType: 'selection',
    measurements: { temperature_c: 215 },
    result: {},
    units: {},
    confidence: null,
    retestRecommended: false,
    notes: null,
    selectionParentObservationId: null,
    selectionReason: null,
    observedAtUtc: '2026-01-01T00:00:00.000Z',
  };
}

function draftProfileRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: DRAFT_PROFILE_ID,
    projectId: PROJECT_ID,
    values: { temperature_c: 215 },
    revision: 1,
    promotedProfileId: null,
    promotedAtUtc: null,
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    updatedAtUtc: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ------------------------------ getProjectRecord ---------------------------

describe('CalibrationHttpClient.getProjectRecord', () => {
  it('GETs /api/calibration-projects/{projectId} and parses the live shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(projectRecord()));
    const client = makeClient(fetchMock);

    const result = await client.getProjectRecord(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result?.id).toBe(PROJECT_ID);
    expect(result?.revision).toBe(1);
    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/calibration-projects/${PROJECT_ID}`,
    );
    expect(call[1].method ?? 'GET').toBe('GET');
  });

  it('returns null on a 404 (deleted or unknown project) instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(notFound());
    const client = makeClient(fetchMock);

    const result = await client.getProjectRecord(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result).toBeNull();
  });
});

// --------------------------------- createAttempt ----------------------------

describe('CalibrationHttpClient.createAttempt', () => {
  it('POSTs to /api/calibration-projects/{projectId}/attempts with the selection-observation-ready shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(attemptRecord(), 201));
    const client = makeClient(fetchMock);

    const result = await client.createAttempt(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      {
        clientId: 'desktop',
        requestId: REQUEST_ID,
        calibrationKind: 'temperature',
        method: 'temperature_tower',
        specification: { start_temperature_c: 150, end_temperature_c: 300 },
      },
      AbortSignal.timeout(5_000),
    );

    expect(result.id).toBe(ATTEMPT_ID);
    expect(result.projectId).toBe(PROJECT_ID);
    expect(result.method).toBe('temperature_tower');

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/calibration-projects/${PROJECT_ID}/attempts`,
    );
    expect(call[1].method).toBe('POST');
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.clientId).toBe('desktop');
    expect(parsed.requestId).toBe(REQUEST_ID);
    expect(parsed.calibrationKind).toBe('temperature');
    expect(parsed.method).toBe('temperature_tower');
    expect(parsed.definitionVersion).toBe('1');
    expect(parsed.parentAttemptId).toBeNull();
    expect(parsed.specification).toEqual({
      start_temperature_c: 150,
      end_temperature_c: 300,
    });
  });

  it('sends an empty specification object when the method declares no setup inputs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(attemptRecord(), 201));
    const client = makeClient(fetchMock);

    await client.createAttempt(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      {
        clientId: 'desktop',
        requestId: REQUEST_ID,
        calibrationKind: 'flow',
        method: 'flow_rate_pass_1',
      },
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.specification).toEqual({});
  });

  it('maps a 409 conflict to a CalibrationHttpError instead of throwing raw', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        problem({ title: 'Conflict', errorCode: 'attemptAlreadyExists' }, 409),
      );
    const client = makeClient(fetchMock);

    let caught: CalibrationHttpError | undefined;
    try {
      await client.createAttempt(
        PROFILE_ID,
        BASE_URL,
        PROJECT_ID,
        {
          clientId: 'desktop',
          requestId: REQUEST_ID,
          calibrationKind: 'temperature',
          method: 'temperature_tower',
        },
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      caught = error as CalibrationHttpError;
    }
    expect(caught).toBeInstanceOf(CalibrationHttpError);
    expect(caught?.status).toBe(409);
  });
});

// ------------------------------- appendObservation --------------------------

describe('CalibrationHttpClient.appendObservation', () => {
  it('POSTs a "selection" observation to /api/calibration-attempts/{attemptId}/observations', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(observationRecord(), 201));
    const client = makeClient(fetchMock);

    const result = await client.appendObservation(
      PROFILE_ID,
      BASE_URL,
      ATTEMPT_ID,
      {
        clientId: 'desktop',
        operationId: OPERATION_ID,
        measurements: { temperature_c: 215 },
      },
      AbortSignal.timeout(5_000),
    );

    expect(result.id).toBe(OBSERVATION_ID);
    expect(result.attemptId).toBe(ATTEMPT_ID);
    expect(result.observationType).toBe('selection');

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/calibration-attempts/${ATTEMPT_ID}/observations`,
    );
    expect(call[1].method).toBe('POST');
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.clientId).toBe('desktop');
    expect(parsed.operationId).toBe(OPERATION_ID);
    expect(parsed.observationType).toBe('selection');
    expect(parsed.measurements).toEqual({ temperature_c: 215 });
    expect(parsed.selectionParentObservationId).toBeNull();
  });
});

// -------------------------------- getDraftProfile ---------------------------

describe('CalibrationHttpClient.getDraftProfile', () => {
  it('GETs /api/calibration-projects/{projectId}/draft-profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(draftProfileRecord()));
    const client = makeClient(fetchMock);

    const result = await client.getDraftProfile(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result?.id).toBe(DRAFT_PROFILE_ID);
    expect(result?.promotedProfileId).toBeNull();
    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/calibration-projects/${PROJECT_ID}/draft-profile`,
    );
  });

  it('returns null when no selection observation has been accepted yet (404)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(notFound());
    const client = makeClient(fetchMock);

    const result = await client.getDraftProfile(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result).toBeNull();
  });

  it('reports a populated promotedProfileId once the project has completed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        draftProfileRecord({
          promotedProfileId: PROMOTED_PROFILE_ID,
          promotedAtUtc: '2026-01-02T00:00:00.000Z',
        }),
      ),
    );
    const client = makeClient(fetchMock);

    const result = await client.getDraftProfile(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result?.promotedProfileId).toBe(PROMOTED_PROFILE_ID);
  });
});

// -------------------------------- completeProject ---------------------------

describe('CalibrationHttpClient.completeProject', () => {
  it('PATCHes lifecycleStatus: Completed with the given baseRevision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        projectRecord({
          lifecycleStatus: 'Completed',
          revision: 2,
          completedAtUtc: '2026-01-02T00:00:00.000Z',
        }),
      ),
    );
    const client = makeClient(fetchMock);

    const result = await client.completeProject(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      1,
      AbortSignal.timeout(5_000),
    );

    expect(result.lifecycleStatus).toBe('Completed');
    expect(result.revision).toBe(2);

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/calibration-projects/${PROJECT_ID}`,
    );
    expect(call[1].method).toBe('PATCH');
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.baseRevision).toBe(1);
    expect(parsed.lifecycleStatus).toBe('Completed');
  });

  it('treats completing an already-Completed project as a benign no-op, not an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(
        projectRecord({
          lifecycleStatus: 'Completed',
          revision: 2,
          completedAtUtc: '2026-01-02T00:00:00.000Z',
        }),
      ),
    );
    const client = makeClient(fetchMock);

    await expect(
      client.completeProject(
        PROFILE_ID,
        BASE_URL,
        PROJECT_ID,
        2,
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toMatchObject({ lifecycleStatus: 'Completed' });
  });

  it('maps a 428 precondition-required error to a CalibrationHttpError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      problem(
        {
          title: 'Precondition Required',
          errorCode: 'precondition_required',
        },
        428,
      ),
    );
    const client = makeClient(fetchMock);

    let caught: CalibrationHttpError | undefined;
    try {
      await client.completeProject(
        PROFILE_ID,
        BASE_URL,
        PROJECT_ID,
        1,
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      caught = error as CalibrationHttpError;
    }
    expect(caught).toBeInstanceOf(CalibrationHttpError);
    expect(caught?.status).toBe(428);
  });
});
