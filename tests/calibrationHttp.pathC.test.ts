/**
 * CalibrationHttpClient — profile picker + printer details endpoints.
 *
 * These tests exercise the client methods that drive the machine → process →
 * filament profile cascade (owner directive 2026-08-23,
 * `.squad/decisions/inbox/vasquez-filament-calibration-reframe.md`) plus the
 * printer-details enrichment used to source `printerModelId`:
 *   - getExtendedProfiles           GET /api/slicer/profiles/extended
 *   - getMachineProfilesForModel    GET /api/slicer/profiles/machine/for-model/{modelId}
 *   - getProcessProfilesForMachines POST /api/slicer/profiles/process/for-machines
 *   - getFilamentProfilesForMachines POST /api/slicer/profiles/filament/for-machines
 *   - getCustomProfiles             GET /api/slicer/profiles/custom
 *   - getPrinterDetails             GET /api/printers/{printerId}/details
 *
 * Fixtures are shaped from verbatim DTOs cited in the research report at
 * `printfarmer-api-contract.md` lines 47-105 (Machine/Process/Filament DTOs)
 * and 130-166 (Custom profile React interface). Do NOT reshape them to match
 * the client's expectations; the whole point is that we mapped the client to
 * the server's shape, not the other way around.
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
const PRINTER_MODEL_ID = '33333333-3333-4333-8333-333333333333';
const MACHINE_GUID = '44444444-4444-4444-8444-444444444444';
const PROCESS_GUID = '55555555-5555-4555-8555-555555555555';
const FILAMENT_GUID = '66666666-6666-4666-8666-666666666666';

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

function stableTokens(): CalibrationTokenProvider {
  return {
    getAuthenticatedContext: vi.fn().mockResolvedValue({
      baseUrl: BASE_URL,
      token: 'test-jwt',
      binding: 'binding-abc123',
    }),
  };
}

function makeClient(
  fetchMock: typeof globalThis.fetch,
  maxResponseBytes = 1024 * 1024,
) {
  return new CalibrationHttpClient(stableTokens(), {
    fetch: fetchMock,
    timeoutMs: 10_000,
    maxResponseBytes,
    now: () => Date.now(),
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });
}

describe('CalibrationHttpClient.getExtendedProfiles', () => {
  // Verbatim from research report §A.4: the extended list is DB-backed and
  // carries the Guid `id` for every profile, including system-authored ones.
  // The shape uses `profileType: 'machine' | 'process' | 'filament'`.
  const extendedFixture = () => ({
    profiles: [
      {
        id: MACHINE_GUID,
        name: 'Voron 2.4 350',
        profileType: 'machine',
        isSystem: true,
        printerModelId: PRINTER_MODEL_ID,
        contentSha256: 'ABCDEF00',
        createdAtUtc: '2025-01-15T12:00:00.000Z',
      },
      {
        id: PROCESS_GUID,
        name: '0.20mm Standard @Voron 2.4',
        profileType: 'process',
        isSystem: true,
        contentSha256: 'ABCDEF01',
      },
      {
        id: FILAMENT_GUID,
        name: 'Generic PLA @Voron 2.4',
        profileType: 'filament',
        isSystem: true,
        contentSha256: 'ABCDEF02',
      },
    ],
  });

  it('parses the wrapped {profiles: [...]} shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(extendedFixture()));
    const client = makeClient(fetchMock);

    const result = await client.getExtendedProfiles(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(result.profiles).toHaveLength(3);
    expect(result.profiles[0]?.id).toBe(MACHINE_GUID);
    expect(result.profiles[0]?.profileType).toBe('machine');
    expect(result.profiles[1]?.profileType).toBe('process');
    expect(result.profiles[2]?.profileType).toBe('filament');
  });

  it('parses a bare array (some server builds return it flat)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json(extendedFixture().profiles));
    const client = makeClient(fetchMock);

    const result = await client.getExtendedProfiles(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(result.profiles).toHaveLength(3);
    expect(result.profiles[0]?.id).toBe(MACHINE_GUID);
  });

  it('targets GET /api/slicer/profiles/extended', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(extendedFixture()));
    const client = makeClient(fetchMock);

    await client.getExtendedProfiles(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [
      URL | string,
      RequestInit | undefined,
    ];
    expect(String(call[0])).toBe(`${BASE_URL}/api/slicer/profiles/extended`);
    expect(call[1]?.method ?? 'GET').toBe('GET');
  });
});

describe('CalibrationHttpClient.getExtendedProfiles — issue #767 (1024-row truncation)', () => {
  // A single machine profile row, name-varied by index so a profile at
  // position >1024 has a distinct, assertable identity.
  const machineRow = (index: number) => ({
    id: `77770000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `Machine Profile ${index}`,
    profileType: 'machine' as const,
    isSystem: true,
    printerModelId: null,
    contentSha256: null,
  });

  // Matched control-arm fixture (used by both the "under the cap" and the
  // "past the old 1024 cap" assertions below) so the two cases exercise
  // identical code paths and differ only in list length — proving the cut
  // is gone rather than that the small list happened to fit anyway.
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => machineRow(i));

  it('control arm: a fixture well under the old 1024 cap resolves every row (500 profiles)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ profiles: rows(500) }));
    const client = makeClient(fetchMock);

    const result = await client.getExtendedProfiles(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(result.profiles).toHaveLength(500);
    expect(result.profiles[499]?.name).toBe('Machine Profile 499');
    expect(result.truncated).toBe(false);
  });

  it('a profile past the old 1024-row cut is still present and resolvable (1500 profiles)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ profiles: rows(1500) }));
    const client = makeClient(fetchMock, 4 * 1024 * 1024);

    const result = await client.getExtendedProfiles(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    // Every row survived — the 1024-row cut that used to apply to /extended
    // is gone. Position 1200 (>1024) is asserted explicitly because it is
    // exactly the row this issue reported as silently dropped.
    expect(result.profiles).toHaveLength(1500);
    const pastOldCap = result.profiles.find(
      (p) => p.name === 'Machine Profile 1200',
    );
    expect(pastOldCap).toBeDefined();
    expect(pastOldCap?.id).toBe(machineRow(1200).id);
    expect(result.truncated).toBe(false);
  });

  it('reports truncated: true (and still caps the list) once the wire exceeds the new, much higher ceiling', async () => {
    // One row past EXTENDED_PROFILE_CEILING (10_000) so the cut is provably
    // observable rather than silently absent, mirroring the
    // `printersTruncated` precedent for `/calibration-candidates`.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ profiles: rows(10_001) }));
    const client = makeClient(fetchMock, 8 * 1024 * 1024);

    const result = await client.getExtendedProfiles(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(result.profiles).toHaveLength(10_000);
    expect(result.truncated).toBe(true);
  });
});

describe('CalibrationHttpClient.getMachineProfilesForModel', () => {
  // Verbatim from research report lines 47-70: MachineProfileDto.
  // Note that system profiles have NO id field on the wire — the canonical
  // Name is the sole identity from the worker DTOs.
  const machineFixture = () => [
    {
      name: 'Voron 2.4 350',
      manufacturer: 'Voron',
      description: 'Voron 2.4 350mm',
      printerModel: 'Voron 2.4 350',
      printerVariant: '0.4',
      instantiation: true,
      nozzleDiameter: 0.4,
      nozzleType: 'brass',
      buildVolumeX: 350,
      buildVolumeY: 350,
      buildVolumeZ: 350,
    },
  ];

  it('parses an array of MachineProfileDto', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(machineFixture()));
    const client = makeClient(fetchMock);

    const result = await client.getMachineProfilesForModel(
      PROFILE_ID,
      BASE_URL,
      PRINTER_MODEL_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Voron 2.4 350');
    expect(result[0]?.buildVolumeX).toBe(350);
  });

  it('surfaces a 404 (no OrcaSlicer alias) as notFound', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 404 }));
    const client = makeClient(fetchMock);

    await expect(
      client.getMachineProfilesForModel(
        PROFILE_ID,
        BASE_URL,
        PRINTER_MODEL_ID,
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: 'notFound' });
  });

  it('targets GET /api/slicer/profiles/machine/for-model/{modelId}', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(machineFixture()));
    const client = makeClient(fetchMock);

    await client.getMachineProfilesForModel(
      PROFILE_ID,
      BASE_URL,
      PRINTER_MODEL_ID,
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [
      URL | string,
      RequestInit | undefined,
    ];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/slicer/profiles/machine/for-model/${PRINTER_MODEL_ID}`,
    );
    expect(call[1]?.method ?? 'GET').toBe('GET');
  });
});

describe('CalibrationHttpClient.getProcessProfilesForMachines', () => {
  // Verbatim from research report lines 72-88: ProcessProfileDto.
  const processFixture = () => [
    {
      name: '0.20mm Standard @Voron 2.4',
      quality: 'standard',
      compatiblePrinters: ['Voron 2.4 350', 'Voron 2.4 300'],
      layerHeight: 0.2,
      infillPercentage: 20,
      supports: false,
      instantiation: true,
    },
  ];

  it('parses ProcessProfileDto[] and posts machineNames in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(processFixture()));
    const client = makeClient(fetchMock);

    const result = await client.getProcessProfilesForMachines(
      PROFILE_ID,
      BASE_URL,
      ['Voron 2.4 350'],
      AbortSignal.timeout(5_000),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('0.20mm Standard @Voron 2.4');
    expect(result[0]?.compatiblePrinters).toContain('Voron 2.4 350');

    const call = fetchMock.mock.calls[0] as [
      URL | string,
      RequestInit | undefined,
    ];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/slicer/profiles/process/for-machines`,
    );
    expect(call[1]?.method).toBe('POST');
    expect(JSON.parse(call[1]?.body as string)).toEqual({
      machineNames: ['Voron 2.4 350'],
    });
  });
});

describe('CalibrationHttpClient.getFilamentProfilesForMachines', () => {
  // Verbatim from research report lines 90-105: FilamentProfileDto.
  const filamentFixture = () => [
    {
      name: 'Generic PLA @Voron 2.4',
      material: 'PLA',
      manufacturer: 'Generic',
      compatiblePrinters: ['Voron 2.4 350', 'Voron 2.4 300'],
      nozzleTemperature: 215,
      bedTemperature: 60,
      instantiation: true,
    },
  ];

  it('parses FilamentProfileDto[] and posts machineNames', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(filamentFixture()));
    const client = makeClient(fetchMock);

    const result = await client.getFilamentProfilesForMachines(
      PROFILE_ID,
      BASE_URL,
      ['Voron 2.4 350'],
      AbortSignal.timeout(5_000),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Generic PLA @Voron 2.4');
    expect(result[0]?.material).toBe('PLA');
    expect(result[0]?.nozzleTemperature).toBe(215);

    const call = fetchMock.mock.calls[0] as [
      URL | string,
      RequestInit | undefined,
    ];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/slicer/profiles/filament/for-machines`,
    );
    expect(call[1]?.method).toBe('POST');
  });
});

describe('CalibrationHttpClient.getCustomProfiles', () => {
  // Verbatim from research report lines 130-166: React CustomProfile
  // interface. Custom profiles DO carry an id Guid.
  const customFixture = () => ({
    profiles: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        name: 'My Custom Voron Machine',
        profileType: 'machine',
        isSystem: false,
        printerModelId: PRINTER_MODEL_ID,
        createdAt: '2025-03-01T10:00:00.000Z',
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'My Custom Filament',
        profileType: 'filament',
        isSystem: false,
        compatiblePrinters: ['Voron 2.4 350'],
      },
    ],
  });

  it('parses the wrapped custom-profile shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(customFixture()));
    const client = makeClient(fetchMock);

    const result = await client.getCustomProfiles(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(result.profiles).toHaveLength(2);
    expect(result.profiles[0]?.id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(result.profiles[0]?.isSystem).toBe(false);
    expect(result.profiles[1]?.compatiblePrinters).toEqual(['Voron 2.4 350']);
  });

  it('parses a bare array', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(customFixture().profiles));
    const client = makeClient(fetchMock);

    const result = await client.getCustomProfiles(
      PROFILE_ID,
      BASE_URL,
      AbortSignal.timeout(5_000),
    );

    expect(result.profiles).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// getPrinterDetails
// -----------------------------------------------------------------------------
//
// Sourced from `OlyForge3D/PrintFarmer:src/infra/Dtos/PrinterDetailsDto.cs`:
//   public sealed record PrinterDetailsDto(
//     Guid Id, string Name, ..., Guid? ModelId, string? ModelName, ...);
//
// Only `modelId` is validated by our schema (`.passthrough()` accepts the rest)
// because this endpoint is called for one purpose only: to enrich the
// candidate list with the catalog `PrinterModel` Guid that
// `CalibrationCandidateDto` omits.  A fixture that mirrored the full
// `PrinterDetailsDto` would tempt a future change to read from a passthrough
// field and silently create a second, un-schema'd wire coupling.
describe('CalibrationHttpClient.getPrinterDetails', () => {
  const detailsFixture = () => ({
    id: PRINTER_ID,
    name: 'Voron 2.4 350 — cell 3',
    slugName: 'cell-3',
    modelId: PRINTER_MODEL_ID,
    modelName: 'Voron 2.4 350',
    firmwareFamily: 'Klipper',
    firmwareVersion: 'v0.12.0',
    isOnline: true,
    lastSeenAtUtc: '2026-08-20T18:30:00.000Z',
  });

  it('parses PrinterDetailsDto and returns the catalog modelId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(detailsFixture()));
    const client = makeClient(fetchMock);

    const result = await client.getPrinterDetails(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result.modelId).toBe(PRINTER_MODEL_ID);
  });

  it('coerces a missing modelId to null (server predates the field)', async () => {
    // Same call, same fixture minus `modelId`. This is the "field known,
    // value unknown" case that the schema's `.nullish().transform(v => v ?? null)`
    // exists to normalise. The renderer's permissive fallback reads `null`
    // as "model unknown, show the wider pool" — an empty string would
    // collapse that into "known-but-matches-nothing" instead.
    const withoutModel = detailsFixture();
    delete (withoutModel as { modelId?: unknown }).modelId;
    const fetchMock = vi.fn().mockResolvedValue(json(withoutModel));
    const client = makeClient(fetchMock);

    const result = await client.getPrinterDetails(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result.modelId).toBeNull();
  });

  it('coerces an explicit null modelId to null (server has no catalog match)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ ...detailsFixture(), modelId: null }));
    const client = makeClient(fetchMock);

    const result = await client.getPrinterDetails(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    expect(result.modelId).toBeNull();
  });

  it('targets GET /api/printers/{printerId}/details with the auth header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(detailsFixture()));
    const client = makeClient(fetchMock);

    await client.getPrinterDetails(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [
      URL | string,
      RequestInit | undefined,
    ];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/printers/${PRINTER_ID}/details`,
    );
    expect(call[1]?.method ?? 'GET').toBe('GET');
  });

  // Control: prove the failure mode we tolerate. `getPrinterDetails` is
  // meant to *raise* on HTTP failure so the caller (the `listPrinters`
  // handler) can catch and record `printerModelId: null`. If the method
  // silently swallowed the error, the handler would never learn the
  // enrichment failed and might record something misleading — this control
  // fails if the method starts absorbing errors.
  it('rejects on a 404 so the caller can decide what to do', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = makeClient(fetchMock);

    await expect(
      client.getPrinterDetails(
        PROFILE_ID,
        BASE_URL,
        PRINTER_ID,
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toBeInstanceOf(CalibrationHttpError);
  });

  it('rejects on a 403 (missing scope) so the caller can decide what to do', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"error":"forbidden"}', {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = makeClient(fetchMock);

    await expect(
      client.getPrinterDetails(
        PROFILE_ID,
        BASE_URL,
        PRINTER_ID,
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toBeInstanceOf(CalibrationHttpError);
  });
});
