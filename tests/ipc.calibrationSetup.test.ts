/**
 * IPC contract tests for the Path C calibration channels
 * (see decisions/inbox/bishop-calibration-path-c-implementation.md).
 *
 * These tests defend the schema shapes that Dallas's renderer consumes when
 * building the cascading profile picker. They are deliberately NOT written
 * as fixtures that agree with a mock server — they assert exact JSON round
 * trips through the shared `ipcSchemas` registry so a wire drift breaks
 * loudly here first.
 *
 * Fixtures are shaped from verbatim DTOs in the research report at
 * `printfarmer-api-contract.md` lines 47-105, 130-166, 208-227.
 */

import { describe, expect, it } from 'vitest';
import {
  IPC_CONTRACT_VERSION,
  IpcChannel,
  ipcSchemas,
} from '../src/shared/ipc.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PRINTER_ID = '22222222-2222-4222-8222-222222222222';
const PRINTER_MODEL_ID = '33333333-3333-4333-8333-333333333333';
const MACHINE_GUID = '44444444-4444-4444-8444-444444444444';
const PROCESS_GUID = '55555555-5555-4555-8555-555555555555';
const FILAMENT_GUID = '66666666-6666-4666-8666-666666666666';
const CUSTOM_GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION_ID = '77777777-7777-4777-8777-777777777777';

describe('Path C — IPC contract', () => {
  it('IPC contract version was bumped to 3 for the Path C channels', () => {
    // A version bump on a wire boundary that has receivers on both sides is
    // NEVER free — every version-pinned test in the repo also has to be
    // touched. If this assertion drifts, run `grep -r IPC_CONTRACT_VERSION`
    // and update every place explicitly, do not paper over it here.
    expect(IPC_CONTRACT_VERSION).toBe(3);
  });

  it('registers all six Path C channels', () => {
    expect(
      ipcSchemas[IpcChannel.CalibrationListExtendedProfiles],
    ).toBeDefined();
    expect(
      ipcSchemas[IpcChannel.CalibrationListMachineProfilesForModel],
    ).toBeDefined();
    expect(
      ipcSchemas[IpcChannel.CalibrationListProcessProfilesForMachines],
    ).toBeDefined();
    expect(
      ipcSchemas[IpcChannel.CalibrationListFilamentProfilesForMachines],
    ).toBeDefined();
    expect(ipcSchemas[IpcChannel.CalibrationListCustomProfiles]).toBeDefined();
    expect(ipcSchemas[IpcChannel.CalibrationSetupPrinter]).toBeDefined();
  });
});

describe('CalibrationListExtendedProfiles schema', () => {
  it('parses a valid ok response with three unified refs', () => {
    const schema =
      ipcSchemas[IpcChannel.CalibrationListExtendedProfiles].response;
    const parsed = schema.parse({
      status: 'ok',
      machineProfiles: [
        {
          name: 'Voron 2.4 350',
          guid: MACHINE_GUID,
          source: 'system',
          displayLabel: 'Voron 2.4 350',
          contentSha256: 'ABCDEF00',
        },
      ],
      processProfiles: [
        {
          name: '0.20mm Standard @Voron 2.4',
          guid: PROCESS_GUID,
          source: 'system',
          displayLabel: 'standard',
          contentSha256: null,
        },
      ],
      filamentProfiles: [
        {
          name: 'Generic PLA @Voron 2.4',
          guid: FILAMENT_GUID,
          source: 'system',
          displayLabel: 'Generic PLA',
          contentSha256: null,
        },
      ],
      fetchedAt: '2026-08-22T22:00:00.000Z',
    });
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') {
      expect(parsed.machineProfiles[0]?.guid).toBe(MACHINE_GUID);
    }
  });

  it('rejects a machine ref whose guid is not a UUID', () => {
    const schema =
      ipcSchemas[IpcChannel.CalibrationListExtendedProfiles].response;
    expect(() =>
      schema.parse({
        status: 'ok',
        machineProfiles: [
          {
            name: 'x',
            guid: 'not-a-guid',
            source: 'system',
            displayLabel: null,
            contentSha256: null,
          },
        ],
        processProfiles: [],
        filamentProfiles: [],
        fetchedAt: '2026-08-22T22:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('CalibrationListMachineProfilesForModel schema', () => {
  it('carries noModelAlias so the renderer can distinguish "no alias" from "empty"', () => {
    const schema =
      ipcSchemas[IpcChannel.CalibrationListMachineProfilesForModel].response;
    const parsed = schema.parse({
      status: 'ok',
      profiles: [],
      noModelAlias: true,
      fetchedAt: '2026-08-22T22:00:00.000Z',
    });
    if (parsed.status === 'ok') {
      expect(parsed.noModelAlias).toBe(true);
      expect(parsed.profiles).toHaveLength(0);
    }
  });

  it('accepts a request with printerModelId', () => {
    const req =
      ipcSchemas[IpcChannel.CalibrationListMachineProfilesForModel].request;
    const parsed = req.parse({
      profileId: PROFILE_ID,
      printerModelId: PRINTER_MODEL_ID,
    });
    expect(parsed.printerModelId).toBe(PRINTER_MODEL_ID);
  });
});

describe('CalibrationListProcessProfilesForMachines schema', () => {
  it('requires machineNames to be non-empty', () => {
    const req =
      ipcSchemas[IpcChannel.CalibrationListProcessProfilesForMachines].request;
    // Control: non-empty passes.
    expect(() =>
      req.parse({
        profileId: PROFILE_ID,
        machineNames: ['Voron 2.4 350'],
      }),
    ).not.toThrow();
    // Empty is rejected — an empty applicability filter would either
    // return the entire catalogue (thousands of rows) or an empty set,
    // and neither shape helps the operator make a choice.
    expect(() =>
      req.parse({
        profileId: PROFILE_ID,
        machineNames: [],
      }),
    ).toThrow();
  });
});

describe('CalibrationListCustomProfiles schema', () => {
  it('parses a custom profile with compatiblePrinters', () => {
    const schema =
      ipcSchemas[IpcChannel.CalibrationListCustomProfiles].response;
    const parsed = schema.parse({
      status: 'ok',
      profiles: [
        {
          id: CUSTOM_GUID,
          name: 'My Custom Filament',
          profileType: 'filament',
          printerModelId: null,
          compatiblePrinters: ['Voron 2.4 350'],
          createdAt: '2026-08-22T22:00:00.000Z',
        },
      ],
      fetchedAt: '2026-08-22T22:00:00.000Z',
    });
    if (parsed.status === 'ok') {
      expect(parsed.profiles[0]?.compatiblePrinters).toEqual(['Voron 2.4 350']);
    }
  });
});

describe('CalibrationSetupPrinter schema', () => {
  it('requires all three profile Guids on the request', () => {
    const req = ipcSchemas[IpcChannel.CalibrationSetupPrinter].request;
    // Control: complete request passes.
    expect(() =>
      req.parse({
        profileId: PROFILE_ID,
        printerId: PRINTER_ID,
        machineProfileId: MACHINE_GUID,
        processProfileId: PROCESS_GUID,
        filamentProfileId: FILAMENT_GUID,
        rowVersion: 'rv-1',
        operationId: OPERATION_ID,
      }),
    ).not.toThrow();
    // Missing machineProfileId is rejected — the desktop UX requires the
    // operator to have picked all three before this channel is invoked.
    expect(() =>
      req.parse({
        profileId: PROFILE_ID,
        printerId: PRINTER_ID,
        processProfileId: PROCESS_GUID,
        filamentProfileId: FILAMENT_GUID,
        rowVersion: 'rv-1',
        operationId: OPERATION_ID,
      }),
    ).toThrow();
  });

  it('allows rowVersion to be null (first-ever setup)', () => {
    const req = ipcSchemas[IpcChannel.CalibrationSetupPrinter].request;
    expect(() =>
      req.parse({
        profileId: PROFILE_ID,
        printerId: PRINTER_ID,
        machineProfileId: MACHINE_GUID,
        processProfileId: PROCESS_GUID,
        filamentProfileId: FILAMENT_GUID,
        rowVersion: null,
        operationId: OPERATION_ID,
      }),
    ).not.toThrow();
  });

  it('parses an ok response with server-supplied rowVersion', () => {
    const schema = ipcSchemas[IpcChannel.CalibrationSetupPrinter].response;
    const parsed = schema.parse({
      status: 'ok',
      printerId: PRINTER_ID,
      eligible: true,
      machineProfileId: MACHINE_GUID,
      processProfileId: PROCESS_GUID,
      filamentProfileId: FILAMENT_GUID,
      rowVersion: 'rv-2',
      updatedAtUtc: '2026-08-22T22:00:00.000Z',
    });
    if (parsed.status === 'ok') {
      expect(parsed.rowVersion).toBe('rv-2');
      expect(parsed.eligible).toBe(true);
    }
  });

  it('parses an error response with calibrationSetupConflict', () => {
    const schema = ipcSchemas[IpcChannel.CalibrationSetupPrinter].response;
    const parsed = schema.parse({
      status: 'error',
      error: {
        code: 'calibrationSetupConflict',
        message:
          'Printer calibration binding changed since the wizard was opened.',
        retryable: false,
        retryAfterSeconds: null,
        reference: null,
      },
    });
    expect(parsed.status).toBe('error');
    if (parsed.status === 'error') {
      expect(parsed.error.code).toBe('calibrationSetupConflict');
    }
  });
});
