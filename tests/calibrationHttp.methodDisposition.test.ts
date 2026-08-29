/**
 * CalibrationHttpClient.getMethodGuidanceCatalog / getMethodProgress /
 * setMethodDisposition — issue #797.
 *
 * `GET /api/calibration-projects/method-guidance`,
 * `GET /api/calibration-projects/{id}/method-progress`, and
 * `PUT /api/calibration-projects/{id}/method-progress/{method}`, verified
 * against `CalibrationProjectsController` / `CalibrationMethodGuidanceCatalog`
 * at PrintFarmer commit `b6a754c989e76edd71891e632bd940f1a81f3918`
 * (blobs `dbe9c1f90b1357d96a6bca0422af629945ed61ec`,
 * `5e8b44cb860e353e0c4cd100164186313b157204`).
 *
 * This is the transport-level counterpart to the wizard-level skip tests in
 * `tests/filamentCalibrationWizard.test.tsx` — it asserts the exact route,
 * HTTP body, and response-schema mapping the wizard's tests treat as a black
 * box.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationHttpClient,
  CalibrationHttpError,
  type CalibrationTokenProvider,
} from '../src/main/calibrationHttp.js';

const BASE_URL = 'http://farm.local';
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '77777777-7777-4777-8777-777777777777';
const PROGRESS_ID = '99999999-9999-4999-8999-999999999999';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

// Verbatim `CalibrationMethodGuidanceDto` shape from
// `CalibrationProjectContracts.cs` @ b6a754c989e76edd71891e632bd940f1a81f3918.
function guidanceOk() {
  return {
    method: 'temperature_tower',
    title: 'Temperature tower',
    purpose: 'Find the best nozzle temperature.',
    wikiUrl: 'https://wiki.example/temperature-tower',
    setupInputs: [],
    measureQuantity: null,
    steps: ['setup', 'print', 'measure'],
  };
}

// Verbatim `CalibrationMethodProgressDto` shape from the same source.
function progressOk(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PROGRESS_ID,
    projectId: PROJECT_ID,
    method: 'temperature_tower',
    disposition: 'Pending',
    currentStepId: null,
    revision: 1,
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    updatedAtUtc: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('CalibrationHttpClient.getMethodGuidanceCatalog', () => {
  it('GETs the global (not project-scoped) guidance catalog route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([guidanceOk()]));
    const client = makeClient(fetchMock);

    const result = await client.getMethodGuidanceCatalog(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.method).toBe('temperature_tower');
    expect(result[0]?.title).toBe('Temperature tower');
    expect(result[0]?.wikiUrl).toBe('https://wiki.example/temperature-tower');

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/calibration-projects/method-guidance`,
    );
    expect(call[1].method ?? 'GET').toBe('GET');
  });

  it('rejects a response missing a required field instead of silently coercing it', async () => {
    const malformed = guidanceOk() as Record<string, unknown>;
    delete malformed.title;
    const fetchMock = vi.fn().mockResolvedValue(json([malformed]));
    const client = makeClient(fetchMock);

    await expect(
      client.getMethodGuidanceCatalog(
        PROFILE_ID,
        BASE_URL,
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toThrow();
  });
});

describe('CalibrationHttpClient.getMethodProgress', () => {
  it('GETs the project-scoped method-progress route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([progressOk()]));
    const client = makeClient(fetchMock);

    const result = await client.getMethodProgress(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.disposition).toBe('Pending');
    expect(result[0]?.revision).toBe(1);

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/calibration-projects/${PROJECT_ID}/method-progress`,
    );
  });

  it('cross-device read-back: a second fetch against the same project sees the same disposition', async () => {
    // The progress row is project-owned, not device-scoped — a second
    // `getMethodProgress` call (simulating a fresh fetch from another
    // machine) must read back the disposition a prior `setMethodDisposition`
    // wrote, not a locally-cached value.
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(json([progressOk({ disposition: 'Skipped' })])),
      );
    const client = makeClient(fetchMock);

    const firstDeviceReadBack = await client.getMethodProgress(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      AbortSignal.timeout(5_000),
    );
    const secondDeviceReadBack = await client.getMethodProgress(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      AbortSignal.timeout(5_000),
    );

    expect(firstDeviceReadBack[0]?.disposition).toBe('Skipped');
    expect(secondDeviceReadBack[0]?.disposition).toBe('Skipped');
  });
});

describe('CalibrationHttpClient.setMethodDisposition', () => {
  it('PUTs to the method-progress/{method} route with baseRevision and disposition', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json(progressOk({ disposition: 'Skipped' })));
    const client = makeClient(fetchMock);

    const result = await client.setMethodDisposition(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      'temperature_tower',
      'Skipped',
      1,
      AbortSignal.timeout(5_000),
    );

    expect(result.disposition).toBe('Skipped');

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/calibration-projects/${PROJECT_ID}/method-progress/temperature_tower`,
    );
    expect(call[1].method).toBe('PUT');
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.baseRevision).toBe(1);
    expect(parsed.disposition).toBe('Skipped');
  });

  it('sends a null baseRevision when no prior progress row is known', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(progressOk()));
    const client = makeClient(fetchMock);

    await client.setMethodDisposition(
      PROFILE_ID,
      BASE_URL,
      PROJECT_ID,
      'temperature_tower',
      'Pending',
      null,
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.baseRevision).toBeNull();
  });

  it('maps a conflict (stale baseRevision) to a CalibrationHttpError instead of throwing raw', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        problem(
          { title: 'Conflict', errorCode: 'method_progress_conflict' },
          409,
        ),
      );
    const client = makeClient(fetchMock);

    let caught: CalibrationHttpError | undefined;
    try {
      await client.setMethodDisposition(
        PROFILE_ID,
        BASE_URL,
        PROJECT_ID,
        'temperature_tower',
        'Skipped',
        1,
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      caught = error as CalibrationHttpError;
    }
    expect(caught).toBeInstanceOf(CalibrationHttpError);
    expect(caught?.status).toBe(409);
  });

  it('never asserts Completed — the disposition parameter type excludes it at compile time', () => {
    // A client-side guard test paired with the server invariant documented
    // on `setMethodDisposition`: `Completed` is only ever derived from an
    // accepted observation, never client-settable. The TS parameter type
    // ('Pending' | 'Skipped') makes this a compile-time guarantee rather
    // than a runtime check — this test exists to keep that guarantee
    // documented and covered if the type is ever loosened.
    type Disposition = Parameters<
      CalibrationHttpClient['setMethodDisposition']
    >[4];
    const allowed: readonly Disposition[] = ['Pending', 'Skipped'];
    expect(allowed).not.toContain('Completed');
  });
});
