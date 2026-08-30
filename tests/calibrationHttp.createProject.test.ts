/**
 * CalibrationHttpClient.createProject — issue #798.
 *
 * `POST /api/calibration-projects`, verified against
 * `CalibrationProjectsController.CreateProjectAsync` at PrintFarmer commit
 * `0720b9d146256c69fa2780c029ab5982bba509a1` (contracts blob
 * `48353af39c7f6b4d9d5e0062254e5fa648860e39`); see
 * `tests/fixtures/server-contract/calibrationProjectContracts.snapshot.ts`
 * for the field-name provenance stamp.
 *
 * This is the transport-level counterpart to the wizard-level tests in
 * `tests/filamentCalibrationWizard.test.tsx` — it asserts the exact route,
 * HTTP body, and response-schema mapping the wizard's tests treat as a
 * black box.
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
const REQUEST_ID = '88888888-8888-4888-8888-888888888888';

function json(body: unknown, status = 201): Response {
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

// Verbatim `CalibrationProjectDto` shape from
// `CalibrationProjectContracts.cs` @ 0720b9d146256c69fa2780c029ab5982bba509a1.
function projectOk() {
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
  };
}

describe('CalibrationHttpClient.createProject', () => {
  it('POSTs to /api/calibration-projects with the exact server field names', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(projectOk()));
    const client = makeClient(fetchMock);

    const result = await client.createProject(
      PROFILE_ID,
      BASE_URL,
      {
        clientId: 'desktop',
        requestId: REQUEST_ID,
        name: 'PolyLite PLA Blue (calibration project)',
        printerId: PRINTER_ID,
        filamentProvider: 'printfarmer',
        filamentProductId: FILAMENT_PRODUCT_ID,
        filamentProductName: 'PolyLite PLA Blue',
        filamentMaterial: 'unknown',
        experienceMode: 'Coach',
      },
      AbortSignal.timeout(5_000),
    );

    expect(result.id).toBe(PROJECT_ID);
    expect(result.lifecycleStatus).toBe('Active');
    expect(result.revision).toBe(1);

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(call[0])).toBe(`${BASE_URL}/api/calibration-projects`);
    expect(call[1].method).toBe('POST');
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.clientId).toBe('desktop');
    expect(parsed.requestId).toBe(REQUEST_ID);
    expect(parsed.name).toBe('PolyLite PLA Blue (calibration project)');
    expect(parsed.printerId).toBe(PRINTER_ID);
    // `printerConfigurationRevision` is a constant `1` — filament
    // calibration is context-free, per `CreateProjectAsync`'s own "Path D
    // (#1981)" doc comment.
    expect(parsed.printerConfigurationRevision).toBe(1);
    expect(parsed.filamentProvider).toBe('printfarmer');
    expect(parsed.filamentProductId).toBe(FILAMENT_PRODUCT_ID);
    expect(parsed.filamentProductName).toBe('PolyLite PLA Blue');
    expect(parsed.filamentMaterial).toBe('unknown');
    expect(parsed.experienceMode).toBe('Coach');
    // Issue #805: the request omitted all three spool fields — they must
    // default to `null` so a caller that hasn't been updated for spool
    // selection (or an operator who explicitly skipped it) still creates a
    // valid project.
    expect(parsed.spoolmanFilamentId).toBeNull();
    expect(parsed.localSpoolId).toBeNull();
    expect(parsed.spoolmanSpoolId).toBeNull();
    // Step/selection ownership stays with the existing clone workflow until
    // #795 lands — sent as empty JSON containers, never a primitive.
    expect(parsed.filamentSnapshot).toEqual({});
    expect(parsed.orderedSteps).toEqual([]);
    expect(parsed.currentSelections).toEqual({});
    expect(parsed.currentStep).toBeNull();
  });

  it('POSTs the operator-selected Spoolman spool fields when the wizard supplies them (issue #805)', async () => {
    const SPOOLMAN_SPOOL_ID = '99999999-9999-4999-8999-999999999999';
    const fetchMock = vi.fn().mockResolvedValue(json(projectOk()));
    const client = makeClient(fetchMock);

    await client.createProject(
      PROFILE_ID,
      BASE_URL,
      {
        clientId: 'desktop',
        requestId: REQUEST_ID,
        name: 'PolyLite PLA Blue (calibration project)',
        printerId: PRINTER_ID,
        filamentProvider: 'printfarmer',
        filamentProductId: FILAMENT_PRODUCT_ID,
        filamentProductName: 'PolyLite PLA Blue',
        filamentMaterial: 'unknown',
        experienceMode: 'Coach',
        spoolmanFilamentId: SPOOLMAN_SPOOL_ID,
        spoolmanSpoolId: SPOOLMAN_SPOOL_ID,
        localSpoolId: null,
      },
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    const parsed = JSON.parse(call[1].body as string) as Record<
      string,
      unknown
    >;
    expect(parsed.spoolmanFilamentId).toBe(SPOOLMAN_SPOOL_ID);
    expect(parsed.spoolmanSpoolId).toBe(SPOOLMAN_SPOOL_ID);
    // Not populated by the wizard — this app tracks no local-spool
    // inventory of its own — but explicit `null` must still round-trip,
    // not be dropped from the request body.
    expect(parsed.localSpoolId).toBeNull();
  });

  it('maps a 409 conflict to a CalibrationHttpError instead of throwing raw', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        problem({ title: 'Conflict', errorCode: 'projectAlreadyExists' }, 409),
      );
    const client = makeClient(fetchMock);

    let caught: CalibrationHttpError | undefined;
    try {
      await client.createProject(
        PROFILE_ID,
        BASE_URL,
        {
          clientId: 'desktop',
          requestId: REQUEST_ID,
          name: 'PolyLite PLA Blue (calibration project)',
          printerId: PRINTER_ID,
          filamentProvider: 'printfarmer',
          filamentProductId: FILAMENT_PRODUCT_ID,
          filamentProductName: 'PolyLite PLA Blue',
          filamentMaterial: 'unknown',
          experienceMode: 'Coach',
        },
        AbortSignal.timeout(5_000),
      );
    } catch (error) {
      caught = error as CalibrationHttpError;
    }
    expect(caught).toBeInstanceOf(CalibrationHttpError);
    expect(caught?.status).toBe(409);
  });

  it('rejects a response missing a required field instead of silently coercing it', async () => {
    const malformed = projectOk() as Record<string, unknown>;
    delete malformed.lifecycleStatus;
    const fetchMock = vi.fn().mockResolvedValue(json(malformed));
    const client = makeClient(fetchMock);

    await expect(
      client.createProject(
        PROFILE_ID,
        BASE_URL,
        {
          clientId: 'desktop',
          requestId: REQUEST_ID,
          name: 'PolyLite PLA Blue (calibration project)',
          printerId: PRINTER_ID,
          filamentProvider: 'printfarmer',
          filamentProductId: FILAMENT_PRODUCT_ID,
          filamentProductName: 'PolyLite PLA Blue',
          filamentMaterial: 'unknown',
          experienceMode: 'Coach',
        },
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toThrow();
  });
});
