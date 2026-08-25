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
  CALIBRATION_MAX_PROFILE_LIST,
  IPC_CONTRACT_VERSION,
  IpcChannel,
  ipcSchemas,
} from '../src/shared/ipc.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PRINTER_MODEL_ID = '33333333-3333-4333-8333-333333333333';
const MACHINE_GUID = '44444444-4444-4444-8444-444444444444';
const PROCESS_GUID = '55555555-5555-4555-8555-555555555555';
const FILAMENT_GUID = '66666666-6666-4666-8666-666666666666';
const CUSTOM_GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Path C — IPC contract', () => {
  it('IPC contract version was bumped to 6 for the #767 profilesTruncated field', () => {
    // A version bump on a wire boundary that has receivers on both sides is
    // NEVER free — every version-pinned test in the repo also has to be
    // touched. If this assertion drifts, run `grep -r IPC_CONTRACT_VERSION`
    // and update every place explicitly, do not paper over it here.
    //
    // v3 → v4 rationale: `calibration:setupPrinter` was a v3 channel; removing
    // it is a breaking wire change (a renderer built against v3 that calls
    // `setupCalibrationPrinter` fails against a v4 main). Removal, unlike
    // additive changes, forces the contract-version bump.
    //
    // v4 → v5 rationale: #756 removed the printer-calibration saga's 19
    // renderer↔main channels (list/get/save/attempts/photos/conflicts/
    // orchestration/queue/import). A renderer built against v4 that calls any
    // of them fails against v5 main; that is a breaking wire change.
    //
    // v5 → v6 rationale: #767 added a new required `profilesTruncated`
    // field to four `.strict()` response schemas
    // (CalibrationListExtendedProfiles, CalibrationListMachineProfilesForModel,
    // CalibrationListProcessProfilesForMachines,
    // CalibrationListFilamentProfilesForMachines). A renderer built against
    // v5 strict-parsing a v6 main's response (missing field) — or a v6
    // renderer parsing a v5 main's response (extra field a strict schema
    // requires) — fails; that is a breaking wire change even though it is
    // purely additive at the type level.
    expect(IPC_CONTRACT_VERSION).toBe(6);
  });

  it('registers all five surviving cascade channels', () => {
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
      profilesTruncated: false,
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
        profilesTruncated: false,
        fetchedAt: '2026-08-22T22:00:00.000Z',
      }),
    ).toThrow();
  });

  it('accepts a machineProfiles bucket at exactly CALIBRATION_MAX_PROFILE_LIST rows — regression for #767 (the IPC .max() cap must track the wire ceiling, not disagree with it)', () => {
    // #767 fix review found the wire-layer ceiling (formerly a bespoke
    // EXTENDED_PROFILE_CEILING, now the shared CALIBRATION_MAX_PROFILE_LIST)
    // had been raised to 10,000 without raising the IPC schema's own,
    // independently-defined `.max()` cap, which was still 2048. A catalog
    // with 2049-10000 profiles in one bucket parsed fine off the wire
    // (correctly reporting profilesTruncated: false) and then threw an
    // ordinary ZodError here, turning a legitimately large, untruncated
    // catalog into a hard error instead of a successfully delivered list.
    // Both ceilings now share the one exported CALIBRATION_MAX_PROFILE_LIST
    // constant; this proves the IPC schema doesn't reject a full-size,
    // untruncated bucket.
    const schema =
      ipcSchemas[IpcChannel.CalibrationListExtendedProfiles].response;
    const machineProfiles = Array.from(
      { length: CALIBRATION_MAX_PROFILE_LIST },
      (_, i) => ({
        name: `Machine Profile ${i}`,
        guid: MACHINE_GUID,
        source: 'system' as const,
        displayLabel: null,
        contentSha256: null,
      }),
    );
    const parsed = schema.parse({
      status: 'ok',
      machineProfiles,
      processProfiles: [],
      filamentProfiles: [],
      profilesTruncated: false,
      fetchedAt: '2026-08-22T22:00:00.000Z',
    });
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') {
      expect(parsed.machineProfiles).toHaveLength(CALIBRATION_MAX_PROFILE_LIST);
    }
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
      profilesTruncated: false,
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
