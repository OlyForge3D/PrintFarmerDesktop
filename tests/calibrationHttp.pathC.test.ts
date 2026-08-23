/**
 * CalibrationHttpClient — profile picker + calibration-setup endpoints
 * (Path C: PUT /api/printers/{id}/calibration-setup).
 *
 * These tests exercise the six methods added to drive the calibration wizard:
 *   - getExtendedProfiles         GET /api/slicer/profiles/extended
 *   - getMachineProfilesForModel  GET /api/slicer/profiles/machine/for-model/{modelId}
 *   - getProcessProfilesForMachines POST /api/slicer/profiles/process/for-machines
 *   - getFilamentProfilesForMachines POST /api/slicer/profiles/filament/for-machines
 *   - getCustomProfiles           GET /api/slicer/profiles/custom
 *   - putCalibrationSetup         PUT /api/printers/{printerId}/calibration-setup
 *
 * Fixtures are shaped from verbatim DTOs cited in the research report at
 * `printfarmer-api-contract.md` lines 47-105 (Machine/Process/Filament DTOs),
 * 130-166 (Custom profile React interface), 208-227 (CalibrationSetupRequest).
 * Do NOT reshape them to match the client's expectations; the whole point is
 * that we mapped the client to the server's shape, not the other way around.
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
const OPERATION_ID = '77777777-7777-4777-8777-777777777777';

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

describe('CalibrationHttpClient.putCalibrationSetup', () => {
  // Verbatim from research report lines 208-227: CalibrationSetupRequestDto
  // Includes the three profile GUIDs. Response is CalibrationSetupResultDto.
  const setupResult = () => ({
    printerId: PRINTER_ID,
    eligible: true,
    machineProfileId: MACHINE_GUID,
    processProfileId: PROCESS_GUID,
    filamentProfileId: FILAMENT_GUID,
    rowVersion: 'rv-2',
    updatedAtUtc: '2026-08-22T22:00:00.000Z',
  });

  it('posts machine/process/filament Guids and Idempotency-Key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(setupResult()));
    const client = makeClient(fetchMock);

    const result = await client.putCalibrationSetup(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      {
        machineProfileId: MACHINE_GUID,
        processProfileId: PROCESS_GUID,
        filamentProfileId: FILAMENT_GUID,
      },
      OPERATION_ID,
      'rv-1',
      AbortSignal.timeout(5_000),
    );

    expect(result.printerId).toBe(PRINTER_ID);
    expect(result.eligible).toBe(true);
    expect(result.rowVersion).toBe('rv-2');

    const call = fetchMock.mock.calls[0] as [
      URL | string,
      RequestInit | undefined,
    ];
    expect(String(call[0])).toBe(
      `${BASE_URL}/api/printers/${PRINTER_ID}/calibration-setup`,
    );
    expect(call[1]?.method).toBe('PUT');
    const headers = call[1]?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe(OPERATION_ID);
    expect(headers['if-match']).toBe('rv-1');
    expect(JSON.parse(call[1]?.body as string)).toEqual({
      machineProfileId: MACHINE_GUID,
      processProfileId: PROCESS_GUID,
      filamentProfileId: FILAMENT_GUID,
    });
  });

  it('omits If-Match when rowVersion is null (first-ever setup)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(setupResult()));
    const client = makeClient(fetchMock);

    await client.putCalibrationSetup(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      {
        machineProfileId: MACHINE_GUID,
        processProfileId: PROCESS_GUID,
        filamentProfileId: FILAMENT_GUID,
      },
      OPERATION_ID,
      null,
      AbortSignal.timeout(5_000),
    );

    const call = fetchMock.mock.calls[0] as [
      URL | string,
      RequestInit | undefined,
    ];
    const headers = call[1]?.headers as Record<string, string>;
    expect(headers['if-match']).toBeUndefined();
  });

  it('maps 412 to calibrationSetupConflict (not revisionConflict)', async () => {
    // Control test: prove the code path exists by asserting the 412 branch
    // returns the calibration-specific error, not the shared revisionConflict
    // code, since silent retry would clobber a concurrent change.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: 'Precondition Failed',
          status: 412,
        }),
        {
          status: 412,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
    );
    const client = makeClient(fetchMock);

    await expect(
      client.putCalibrationSetup(
        PROFILE_ID,
        BASE_URL,
        PRINTER_ID,
        {
          machineProfileId: MACHINE_GUID,
          processProfileId: PROCESS_GUID,
          filamentProfileId: FILAMENT_GUID,
        },
        OPERATION_ID,
        'stale-rv',
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toBeInstanceOf(CalibrationHttpError);

    await expect(
      client.putCalibrationSetup(
        PROFILE_ID,
        BASE_URL,
        PRINTER_ID,
        {
          machineProfileId: MACHINE_GUID,
          processProfileId: PROCESS_GUID,
          filamentProfileId: FILAMENT_GUID,
        },
        OPERATION_ID,
        'stale-rv',
        AbortSignal.timeout(5_000),
      ),
    ).rejects.toMatchObject({ code: 'calibrationSetupConflict' });
  });

  it('accepts a response with an all-zero machineProfileId (server clears binding)', async () => {
    // The server MAY return a cleared binding when the caller sent an
    // all-zero Guid. Our wire schema treats all three Guids as nullable
    // on the response so we can render "still needs setup" without an
    // additional round-trip.
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        printerId: PRINTER_ID,
        eligible: false,
        machineProfileId: null,
        processProfileId: null,
        filamentProfileId: null,
        rowVersion: 'rv-2',
      }),
    );
    const client = makeClient(fetchMock);

    const result = await client.putCalibrationSetup(
      PROFILE_ID,
      BASE_URL,
      PRINTER_ID,
      {
        machineProfileId: MACHINE_GUID,
        processProfileId: PROCESS_GUID,
        filamentProfileId: FILAMENT_GUID,
      },
      OPERATION_ID,
      'rv-1',
      AbortSignal.timeout(5_000),
    );

    expect(result.eligible).toBe(false);
    expect(result.machineProfileId).toBeNull();
  });
});
