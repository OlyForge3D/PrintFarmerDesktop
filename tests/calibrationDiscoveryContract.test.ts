/**
 * Regression coverage for the calibration discovery contract (printer
 * candidates and per-printer context).
 *
 * These tests drive the real `CalibrationHttpClient` and the real wire schemas
 * against fixtures copied from PrintFarmer's own DTO definitions. Nothing that
 * is being fixed is mocked away: the fetch boundary is the only seam, so a
 * route, query-string or schema regression fails here rather than in
 * production.
 *
 * Fixture provenance: `CompletePrinterDto` in `src/infra/Dtos/CompletePrinterDto.cs`
 * on OlyForge3D/PrintFarmer@origin/development (post-`OlyForge3D/PrintFarmer#1943`,
 * which removed `/api/printers/calibration-candidates` and the
 * `IsExplicitlyEligible` gate). Under Path D the desktop discovers printers
 * via the plain `GET /api/printers` list — every printer is a candidate — and
 * the candidate list carries no server-side eligibility metadata.
 */

import { describe, expect, it } from 'vitest';
import {
  CalibrationHttpClient,
  CalibrationHttpError,
  CALIBRATION_DISCOVERY_ROUTE_TEMPLATES,
} from '../src/main/calibrationHttp.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const BASE_URL = 'https://printfarmer.example';
const PRINTER_ID = 'aaaaaaaa-1111-4111-8111-222222222222';
const MODEL_ID = 'bbbbbbbb-2222-4222-8222-333333333333';

function tokens() {
  return {
    getAuthenticatedContext: () =>
      Promise.resolve({
        baseUrl: BASE_URL,
        token: 'test-token',
        binding: 'binding-1',
        profile: { baseUrl: BASE_URL },
      }),
    refresh: () => Promise.resolve(undefined),
  } as never;
}

/** Captures the exact URL the production client requests. */
function recordingFetch(
  body: unknown,
  init: { status?: number } = {},
): { calls: string[]; fetch: typeof fetch } {
  const calls: string[] = [];
  const impl = (input: RequestInfo | URL) => {
    calls.push(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { calls, fetch: impl };
}

/**
 * A verbatim-shaped `CompletePrinterDto` for an online, enabled printer, as
 * `GET /api/printers` serialises it. Fields the client does not project
 * (bed/hotend telemetry, spool info, URLs, job state) are omitted; the wire
 * schema's `.passthrough()` guarantees their presence does not affect
 * projection.
 */
function completePrinterDto(overrides: Record<string, unknown> = {}) {
  return {
    id: PRINTER_ID,
    name: 'Voron 2.4 #1',
    modelId: MODEL_ID,
    modelName: 'Voron 2.4 (350mm)',
    isEnabled: true,
    inMaintenance: false,
    isOnline: true,
    ...overrides,
  };
}

describe('calibration discovery routes', () => {
  it('requests the plain printers list, not the retired calibration-candidates path', async () => {
    const { calls, fetch } = recordingFetch([completePrinterDto()]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    await client.getPrinters(PROFILE_ID, BASE_URL, AbortSignal.timeout(5_000));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${BASE_URL}/api/printers`);
    // The retired route removed by OlyForge3D/PrintFarmer#1943 must never be
    // requested again; hitting it now returns 404 (`Calibration resource not
    // found`), the very defect this contract fix exists to prevent.
    expect(calls[0]).not.toContain('/api/printers/calibration-candidates');
  });

  it('keeps the route templates aligned with what the server serves', () => {
    // These are the values `GET /api/printers` and the calibration-context
    // route template resolve to under Path D. `printers` replaces the retired
    // `calibrationCandidates` template; `calibrationContext` stays as a
    // transitional stub while the per-printer context surface is retired
    // separately (also removed server-side by #1943).
    expect(CALIBRATION_DISCOVERY_ROUTE_TEMPLATES.printers).toBe(
      '/api/printers',
    );
    expect(CALIBRATION_DISCOVERY_ROUTE_TEMPLATES.calibrationContext).toBe(
      '/api/printers/{printerId}/calibration-context?slicerType=OrcaSlicer',
    );
  });
});

describe('calibration candidate DTO normalisation', () => {
  it('parses a real bare-array printers payload into a usable candidate', async () => {
    const { fetch } = recordingFetch([completePrinterDto()]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const { printers } = await client.getPrinters(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    // The whole point of the fix: a real payload yields a non-empty list.
    expect(printers).toHaveLength(1);
    expect(printers[0]!.printerId).toBe(PRINTER_ID);
    expect(printers[0]!.displayName).toBe('Voron 2.4 #1');
    expect(printers[0]!.isOnline).toBe(true);
    // Path D: `printerModelId` is already on `CompletePrinterDto`, so the
    // renderer's cascading profile picker no longer needs a per-record
    // enrichment round-trip.
    expect(printers[0]!.printerModelId).toBe(MODEL_ID);
    expect(printers[0]!.printerModel).toBe('Voron 2.4 (350mm)');
  });

  it('parses disabled and in-maintenance printers so the handler can filter them', async () => {
    // The wire schema is inclusive: it projects every printer the server
    // returns. Selection filtering (skipping disabled or in-maintenance
    // printers) happens in the IPC handler, not here, so the schema keeps
    // both fields on the projected record for the handler to gate on.
    const { fetch } = recordingFetch([
      completePrinterDto({
        id: 'cccccccc-3333-4333-8333-444444444444',
        isEnabled: false,
      }),
      completePrinterDto({
        id: 'dddddddd-4444-4444-8444-555555555555',
        inMaintenance: true,
      }),
      completePrinterDto(),
    ]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const { printers } = await client.getPrinters(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(printers).toHaveLength(3);
    const disabled = printers.find(
      (p) => p.printerId === 'cccccccc-3333-4333-8333-444444444444',
    );
    expect(disabled?.isEnabled).toBe(false);
    const maintenance = printers.find(
      (p) => p.printerId === 'dddddddd-4444-4444-8444-555555555555',
    );
    expect(maintenance?.inMaintenance).toBe(true);
    const healthy = printers.find((p) => p.printerId === PRINTER_ID);
    expect(healthy?.isEnabled).toBe(true);
    expect(healthy?.inMaintenance).toBe(false);
  });

  it('drops a malformed candidate and counts it, rather than emptying silently', async () => {
    // A malformed payload must never be swallowed. Failing the whole request
    // used to discard every healthy printer alongside the bad one; the
    // response is now split so the loss is reported instead of hidden.
    const { fetch } = recordingFetch([{ id: 'not-a-guid', name: '' }]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const result = await client.getPrinters(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(result.printers).toEqual([]);
    expect(result.unreadable).toBe(1);
  });

  it('keeps the healthy printers when one candidate beside them is malformed', async () => {
    const { fetch } = recordingFetch([
      { id: 'not-a-guid', name: '' },
      completePrinterDto(),
    ]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const result = await client.getPrinters(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(result.printers).toHaveLength(1);
    expect(result.printers[0]!.printerId).toBe(PRINTER_ID);
    expect(result.unreadable).toBe(1);
  });
});

describe('calibration discovery error discrimination', () => {
  it('separates a profile-resolver outage from a slicer-worker outage', async () => {
    // Production returns exactly this body while the profile resolver is
    // unroutable. Reading it as `workerUnavailable` sent operators to the
    // slicing fleet for a fault that lives somewhere else entirely.
    const { fetch } = recordingFetch(
      {
        status: 503,
        title: 'Profile service unavailable',
        code: 'profile_service_unavailable',
      },
      { status: 503 },
    );
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const error = await client
      .getPrinters(PROFILE_ID, BASE_URL, AbortSignal.timeout(5_000))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CalibrationHttpError);
    expect((error as CalibrationHttpError).code).toBe(
      'profileServiceUnavailable',
    );
  });

  it('maps an unauthenticated candidate request to authentication', async () => {
    const { fetch } = recordingFetch({ status: 401 }, { status: 401 });
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const error = await client
      .getPrinters(PROFILE_ID, BASE_URL, AbortSignal.timeout(5_000))
      .catch((caught: unknown) => caught);

    expect((error as CalibrationHttpError).code).toBe('authentication');
  });

  it('maps a missing calibration permission to authorization', async () => {
    const { fetch } = recordingFetch({ status: 403 }, { status: 403 });
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const error = await client
      .getPrinters(PROFILE_ID, BASE_URL, AbortSignal.timeout(5_000))
      .catch((caught: unknown) => caught);

    expect((error as CalibrationHttpError).code).toBe('authorization');
  });

  it('maps route drift to notFound rather than an empty result', async () => {
    // This is the shape the retired `/api/printers/calibration-candidates`
    // returned once #1943 removed the endpoint — the runtime break Vasquez
    // reported. If the desktop ever regresses back to that route, this
    // assertion catches it.
    const { fetch } = recordingFetch({ status: 404 }, { status: 404 });
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const error = await client
      .getPrinters(PROFILE_ID, BASE_URL, AbortSignal.timeout(5_000))
      .catch((caught: unknown) => caught);

    expect((error as CalibrationHttpError).code).toBe('notFound');
  });
});
