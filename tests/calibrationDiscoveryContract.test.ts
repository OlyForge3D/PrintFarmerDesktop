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
 * Fixture provenance: `CalibrationCandidateDto` / `CalibrationContextDto` in
 * `src/infra/Calibration/CalibrationContracts.cs` on
 * OlyForge3D/PrintFarmer@development, cross-checked against the live
 * `routes` member of `GET /api/calibration/capabilities` on production
 * `0.2.3+125d2c9b2`.
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

/** A verbatim-shaped `CalibrationCandidateDto` for an eligible Klipper printer. */
function eligibleCandidateDto(overrides: Record<string, unknown> = {}) {
  return {
    id: PRINTER_ID,
    name: 'Voron 2.4 #1',
    enabled: true,
    inMaintenance: false,
    backend: 'Moonraker',
    location: { id: '33333333-3333-4333-8333-333333333333', name: 'Rack A' },
    configurationRevision: 7,
    reachability: 'online',
    operationalState: 'idle',
    statusSource: 'moonraker',
    observedAtUtc: '2026-08-11T14:00:00Z',
    lastSeenAtUtc: '2026-08-11T14:00:00Z',
    isStale: false,
    staleAfterSeconds: 60,
    statusSupported: true,
    supportsStatus: true,
    supportsFileUpload: true,
    supportsStartPrint: true,
    supportsUploadAndPrint: true,
    supportsDirectCommand: true,
    supportsMultiExtruderStatus: false,
    buildVolume: { x: 350, y: 350, z: 340 },
    bedOrigin: { x: 0, y: 0 },
    physicalToolheadCount: 1,
    activeToolheadIndex: 0,
    toolheads: [],
    firmware: {
      family: 'Klipper',
      gcodeDialect: 'Klipper',
      detectionSource: 'moonraker',
      version: 'v0.12.0',
      verified: true,
    },
    slicer: {
      engine: 'OrcaSlicer',
      distribution: 'upstream',
      version: '2.4.2',
      profileFormat: 'orca-json',
    },
    eligible: true,
    missingInputs: [],
    rejectionReasons: [],
    ...overrides,
  };
}

describe('calibration discovery routes', () => {
  it('requests the canonical candidate route, not the 404 legacy path', async () => {
    const { calls, fetch } = recordingFetch([eligibleCandidateDto()]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    await client.getPrinters(PROFILE_ID, BASE_URL, AbortSignal.timeout(5_000));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${BASE_URL}/api/printers/calibration-candidates`);
    // The path production answered with 404 must never be requested again.
    expect(calls[0]).not.toContain('/api/calibration/printers');
  });

  it('sends the mandatory slicerType on the context route', async () => {
    const { calls, fetch } = recordingFetch({
      ...eligibleCandidateDto(),
      schemaVersion: '1.0',
      snapshotSha256: 'a'.repeat(64),
      capturedAtUtc: '2026-08-11T14:00:00Z',
      capturedBySubject: 'subject-1',
      snapshot: { configurationRevision: 7, toolheads: [] },
    });
    const client = new CalibrationHttpClient(tokens(), { fetch });

    await client.getPrinterContext(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    // The server compares slicerType with StringComparison.Ordinal and answers
    // 400 unsupported_slicer_type when it is absent or differently cased.
    expect(calls[0]).toBe(
      `${BASE_URL}/api/printers/${PRINTER_ID}/calibration-context?slicerType=OrcaSlicer`,
    );
  });

  it('keeps the route templates aligned with what the server advertises', () => {
    // These are the values the live capabilities payload publishes under
    // `routes.calibrationCandidates` and `routes.calibrationContext`.
    expect(CALIBRATION_DISCOVERY_ROUTE_TEMPLATES.calibrationCandidates).toBe(
      '/api/printers/calibration-candidates',
    );
    expect(CALIBRATION_DISCOVERY_ROUTE_TEMPLATES.calibrationContext).toBe(
      '/api/printers/{printerId}/calibration-context?slicerType=OrcaSlicer',
    );
  });
});

describe('calibration candidate DTO normalisation', () => {
  it('parses a real bare-array candidate payload into a usable printer', async () => {
    const { fetch } = recordingFetch([eligibleCandidateDto()]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const printers = await client.getPrinters(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    // The whole point of the fix: a real payload yields a non-empty list.
    expect(printers).toHaveLength(1);
    expect(printers[0]!.printerId).toBe(PRINTER_ID);
    expect(printers[0]!.displayName).toBe('Voron 2.4 #1');
    expect(printers[0]!.isOnline).toBe(true);
    expect(printers[0]!.firmwareCompatible).toBe(true);
    expect(printers[0]!.eligibility).not.toBeNull();
  });

  it('keeps an ineligible printer visible with its rejection reasons', async () => {
    const { fetch } = recordingFetch([
      eligibleCandidateDto({
        eligible: false,
        // `slicer.engine`, as the server actually spells it — an earlier
        // fixture said `slicer_engine`, which no PrintFarmer build emits, so
        // it could not have caught a field-path regression.
        missingInputs: ['slicer.engine'],
        rejectionReasons: [
          {
            code: 'firmware_family_not_klipper',
            field: 'firmware.family',
            message: 'Firmware family is not Klipper.',
          },
        ],
        firmware: {
          family: 'Marlin',
          gcodeDialect: 'Marlin',
          detectionSource: 'probe',
          version: null,
          verified: false,
        },
      }),
    ]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const printers = await client.getPrinters(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    // Present, but explicitly not calibratable, and able to say why.
    expect(printers).toHaveLength(1);
    expect(printers[0]!.eligibility).toBeNull();
    expect(printers[0]!.firmwareCompatible).toBe(false);
    expect(printers[0]!.rejectionReasons[0]!.code).toBe(
      'firmware_family_not_klipper',
    );
  });

  it('refuses eligibility that the server did not explicitly grant', async () => {
    // Firmware and slicer look right, but the server's own verdict is false.
    // Eligibility must follow PrintFarmer, never a locally re-derived guess.
    const { fetch } = recordingFetch([
      eligibleCandidateDto({ eligible: false }),
    ]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const printers = await client.getPrinters(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(printers[0]!.eligibility).toBeNull();
  });

  it('rejects a malformed candidate payload instead of silently emptying', async () => {
    const { fetch } = recordingFetch([{ id: 'not-a-guid', name: '' }]);
    const client = new CalibrationHttpClient(tokens(), { fetch });

    await expect(
      client.getPrinters(PROFILE_ID, BASE_URL, AbortSignal.timeout(5_000)),
    ).rejects.toBeInstanceOf(CalibrationHttpError);
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
    const { fetch } = recordingFetch({ status: 404 }, { status: 404 });
    const client = new CalibrationHttpClient(tokens(), { fetch });

    const error = await client
      .getPrinters(PROFILE_ID, BASE_URL, AbortSignal.timeout(5_000))
      .catch((caught: unknown) => caught);

    expect((error as CalibrationHttpError).code).toBe('notFound');
  });
});
