/**
 * CalibrationHttpClient.listSpoolmanSpools — issue #805.
 *
 * `GET /api/printers/{printerId}/spoolman-spools`, consumed by the filament
 * calibration wizard's spool-picker step before `createProject` runs (see
 * `tests/calibrationHttp.createProject.test.ts` for the transport-level
 * coverage of the fields this picker feeds).
 *
 * Unlike the other `calibrationHttp.ts` routes, this endpoint has NOT been
 * verified against a live `OlyForge3D/PrintFarmer` checkout — no
 * Spoolman-listing route existed in that codebase's contract snapshots at
 * the time this issue was implemented (see the doc comments on
 * `ROUTES.spoolmanSpools` and `RemoteCalibrationSpoolmanSpool`). These tests
 * therefore focus on the defensive parsing behaviour (`.passthrough()`,
 * nullish coercion, both wrapped and bare-array response shapes) that keeps
 * an unexpected real server shape from crashing the wizard, rather than
 * asserting a byte-exact field list sourced from server code.
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
const SPOOL_ID = '33333333-3333-4333-8333-333333333333';
const FILAMENT_ID = '44444444-4444-4444-8444-444444444444';

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

function spoolFixture() {
  return {
    spoolmanSpoolId: SPOOL_ID,
    spoolmanFilamentId: FILAMENT_ID,
    displayName: 'Prusament PLA — Galaxy Black (#12)',
    material: 'PLA',
    color: 'Galaxy Black',
    vendor: 'Prusament',
    remainingWeightGrams: 750,
  };
}

describe('CalibrationHttpClient.listSpoolmanSpools', () => {
  it('GETs /api/printers/{printerId}/spoolman-spools and parses the wrapped shape', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ spools: [spoolFixture()] }));
    const client = makeClient(fetchMock);

    const result = await client.listSpoolmanSpools(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.spoolmanSpoolId).toBe(SPOOL_ID);
    expect(result[0]?.spoolmanFilamentId).toBe(FILAMENT_ID);
    expect(result[0]?.displayName).toBe('Prusament PLA — Galaxy Black (#12)');

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/printers/${PRINTER_ID}/spoolman-spools`,
    );
    expect(call[1].method).toBe('GET');
  });

  it('parses a bare array response, matching getCustomProfiles-style server tolerance', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([spoolFixture()]));
    const client = makeClient(fetchMock);

    const result = await client.listSpoolmanSpools(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.spoolmanSpoolId).toBe(SPOOL_ID);
  });

  it('defaults an omitted spoolmanFilamentId/material/color/vendor/remainingWeightGrams to null instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        spools: [
          {
            spoolmanSpoolId: SPOOL_ID,
            displayName: 'Unlabelled spool',
          },
        ],
      }),
    );
    const client = makeClient(fetchMock);

    const result = await client.listSpoolmanSpools(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result[0]?.spoolmanFilamentId).toBeNull();
    expect(result[0]?.material).toBeNull();
    expect(result[0]?.color).toBeNull();
    expect(result[0]?.vendor).toBeNull();
    expect(result[0]?.remainingWeightGrams).toBeNull();
  });

  it('tolerates unexpected extra fields on a spool via passthrough instead of rejecting the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        spools: [{ ...spoolFixture(), lotNumber: 'LOT-2026-08' }],
      }),
    );
    const client = makeClient(fetchMock);

    const result = await client.listSpoolmanSpools(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.spoolmanSpoolId).toBe(SPOOL_ID);
  });

  it('returns an empty list when the server reports no spools for the printer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ spools: [] }));
    const client = makeClient(fetchMock);

    const result = await client.listSpoolmanSpools(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result).toEqual([]);
  });

  it('maps a non-2xx response to a CalibrationHttpError instead of throwing raw', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        problem({ title: 'Not Found', errorCode: 'printerNotFound' }, 404),
      );
    const client = makeClient(fetchMock);

    let caught: CalibrationHttpError | undefined;
    try {
      await client.listSpoolmanSpools(
        PROFILE_ID,
        BASE_URL,
        PRINTER_ID,
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      caught = error as CalibrationHttpError;
    }
    expect(caught).toBeInstanceOf(CalibrationHttpError);
    expect(caught?.status).toBe(404);
  });

  it('rejects a spool missing its required spoolmanSpoolId instead of silently coercing it', async () => {
    const malformed = spoolFixture() as Record<string, unknown>;
    delete malformed.spoolmanSpoolId;
    const fetchMock = vi.fn().mockResolvedValue(json({ spools: [malformed] }));
    const client = makeClient(fetchMock);

    await expect(
      client.listSpoolmanSpools(
        PROFILE_ID,
        BASE_URL,
        PRINTER_ID,
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toThrow();
  });
});
