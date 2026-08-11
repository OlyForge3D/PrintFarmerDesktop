// @vitest-environment node

/**
 * End-to-end coverage for the candidate explanation path: a real
 * `CalibrationCandidateDto` on the wire → the *registered*
 * `calibration:listPrinters` IPC handler → the payload the renderer receives.
 *
 * The earlier tests for this behaviour parsed an already-contradictory IPC
 * shape in isolation, which could not observe what the wire layer does with a
 * contradictory *server* response — and the wire layer was quietly flattening
 * it.
 *
 * These drive the production handler itself rather than a transcription of it.
 * That distinction is the point of the file: a copy of the projection asserts
 * what someone believed the handler does, so deleting the contradiction prefix
 * or the normalisation call in `src/main/ipc.ts` would leave the copy passing
 * and the defect shipped. Only `fetch` is replaced here, so those mutations are
 * killed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CalibrationPrinterCandidate,
  CALIBRATION_REJECTION_REASON_CODES,
  CALIBRATION_SERVER_CONTRADICTION_CODE,
  IpcChannel,
  UNRECOGNIZED_CALIBRATION_INPUT,
  UNRECOGNIZED_CALIBRATION_REASON_CODE,
  normalizeCalibrationMissingInput,
  normalizeCalibrationReasonCode,
} from '@shared/ipc';

type Handler = (event: unknown, request: unknown) => unknown;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/test/userData',
    getVersion: () => '0.0.0-test',
    on: () => undefined,
  },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      electronState.handlers.set(channel, handler);
    },
  },
  BrowserWindow: { fromWebContents: () => ({ id: 'window-stub' }) },
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true }) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  shell: {},
}));

const { registerIpcHandlers } = await import('../src/main/ipc.js');

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PRINTER_GUID = 'aaaaaaaa-1111-4111-8111-222222222222';
const BASE_URL = 'http://farm.local';

function fakeProfiles() {
  return {
    list: () =>
      Promise.resolve({ profiles: [], selectedProfileId: PROFILE_ID }),
    getAuthenticatedContext: () =>
      Promise.resolve({
        profile: { id: PROFILE_ID, baseUrl: BASE_URL },
        token: 'test-jwt',
        serverBinding: 'binding-abc',
      }),
    getAuthenticatedServerContext: () =>
      Promise.resolve({
        baseUrl: BASE_URL,
        token: 'test-jwt',
        binding: 'binding-abc',
      }),
    onBindingChanged: () => () => undefined,
  };
}

const noopSidecar = {
  initialize: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
  disposeAll: () => Promise.resolve(),
  request: () => Promise.resolve({}),
};

/** The real handler registration, with nothing below `fetch` replaced. */
function listPrintersHandler(): Handler {
  electronState.handlers.clear();
  registerIpcHandlers(
    undefined,
    fakeProfiles() as never,
    noopSidecar as never,
    noopSidecar as never,
    { initialize: () => Promise.resolve(), dispose: () => undefined } as never,
    {
      canonicalizePickerFile: (p: string) => Promise.resolve(p),
      authorizeFile: () => Promise.reject(new Error('denied')),
      resolve: () => Promise.reject(new Error('denied')),
      approveFromPicker: () => Promise.reject(new Error('denied')),
      reset: () => Promise.resolve(),
    } as never,
    {
      initialize: () => Promise.resolve(),
      purge: () => Promise.resolve(),
    } as never,
  );
  const handler = electronState.handlers.get(
    IpcChannel.CalibrationListPrinters,
  );
  if (!handler) throw new Error('calibration:listPrinters was not registered');
  return handler;
}

/**
 * A `CalibrationCandidateDto` shaped as PrintFarmer emits it, eligible unless
 * an override says otherwise.
 */
function candidateDto(overrides: Record<string, unknown> = {}) {
  return {
    id: PRINTER_GUID,
    name: 'Rack A cell 3',
    enabled: true,
    inMaintenance: false,
    configurationRevision: 4,
    reachability: 'online',
    operationalState: 'idle',
    observedAtUtc: '2026-08-11T12:00:00Z',
    isStale: false,
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

interface ProjectedCandidate {
  printerId: string;
  firmwareCompatible: boolean;
  rejectionReasonCodes: string[];
  missingInputs: string[];
  eligibility: unknown;
}

/** Serves `candidates` on the candidate route and returns what IPC produced. */
async function listPrinters(
  candidates: unknown[],
): Promise<ProjectedCandidate[]> {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(candidates), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
  const result = (await listPrintersHandler()(
    {},
    { profileId: PROFILE_ID },
  )) as { printers: ProjectedCandidate[] };
  return result.printers;
}

beforeEach(() => {
  electronState.handlers.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the production handler is reached', () => {
  // Without this, every assertion below could pass against a handler that
  // never ran, or a fetch stub the client never called.
  it('projects an eligible printer through the real fetch boundary', async () => {
    const [printer] = await listPrinters([candidateDto()]);

    expect(printer!.printerId).toBe(PRINTER_GUID);
    expect(printer!.firmwareCompatible).toBe(true);
    expect(printer!.eligibility).not.toBeNull();
    expect(printer!.rejectionReasonCodes).toEqual([]);
  });
});

describe('a server response that contradicts itself', () => {
  const contradictory = candidateDto({
    eligible: true,
    rejectionReasons: [
      {
        code: 'firmware_family_not_klipper',
        field: 'firmware.family',
        message: 'Firmware family is not Klipper.',
      },
    ],
    missingInputs: ['firmware.family'],
  });

  it('reaches the renderer as an explicit contradiction, not a plain refusal', async () => {
    const [printer] = await listPrinters([contradictory]);

    // Fail closed on eligibility...
    expect(printer!.eligibility).toBeNull();
    expect(printer!.firmwareCompatible).toBe(false);
    // ...but say the server disagreed with itself, so this is distinguishable
    // from an ordinary ineligible printer. PrintFarmer derives Eligible from
    // reasons.Count == 0, so the two can only disagree if the response was
    // assembled wrongly or tampered with.
    expect(printer!.rejectionReasonCodes).toContain(
      CALIBRATION_SERVER_CONTRADICTION_CODE,
    );
    expect(printer!.rejectionReasonCodes).toContain(
      'firmware_family_not_klipper',
    );
  });

  it('says so even when the only contradicting evidence is a missing input', async () => {
    // The reason list is empty here, so a contradiction check that consulted
    // only `rejectionReasons` would emit an ineligible printer carrying no
    // explanation at all.
    const [printer] = await listPrinters([
      candidateDto({ eligible: true, missingInputs: ['firmware.family'] }),
    ]);

    expect(printer!.eligibility).toBeNull();
    expect(printer!.rejectionReasonCodes).toEqual([
      CALIBRATION_SERVER_CONTRADICTION_CODE,
    ]);
    expect(printer!.missingInputs).toEqual(['firmware.family']);
  });

  it('says so even when the only contradicting evidence is a rejection reason', async () => {
    // The mirror of the case above, and the likelier one: PrintFarmer derives
    // `Eligible` from the reason count, so a reason list that disagrees with
    // the flag is the direct symptom of the defect. A check that consulted
    // only `missingInputs` would pass every other test in this file.
    const [printer] = await listPrinters([
      candidateDto({
        eligible: true,
        rejectionReasons: [
          {
            code: 'printer_offline',
            field: 'reachability',
            message: 'Printer is offline.',
          },
        ],
      }),
    ]);

    expect(printer!.eligibility).toBeNull();
    expect(printer!.firmwareCompatible).toBe(false);
    expect(printer!.rejectionReasonCodes).toEqual([
      CALIBRATION_SERVER_CONTRADICTION_CODE,
      'printer_offline',
    ]);
  });

  it('does not mark an ordinary refusal as a contradiction', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [
          {
            code: 'printer_offline',
            field: 'reachability',
            message: 'Printer is offline.',
          },
        ],
      }),
    ]);

    expect(printer!.rejectionReasonCodes).toEqual(['printer_offline']);
  });
});

describe('reason codes are validated, not merely bounded', () => {
  it('passes through every code the server can actually emit', () => {
    for (const code of CALIBRATION_REJECTION_REASON_CODES) {
      expect(normalizeCalibrationReasonCode(code)).toBe(code);
    }
  });

  it('replaces a code outside the catalogue with the unrecognized sentinel', () => {
    // The point of carrying codes instead of the server's `message` was to
    // keep server-authored text away from the renderer. Without this check
    // that property was documented but not true.
    expect(
      normalizeCalibrationReasonCode('Your licence has expired, click here'),
    ).toBe(UNRECOGNIZED_CALIBRATION_REASON_CODE);
    expect(normalizeCalibrationReasonCode('<script>alert(1)</script>')).toBe(
      UNRECOGNIZED_CALIBRATION_REASON_CODE,
    );
    expect(normalizeCalibrationReasonCode('')).toBe(
      UNRECOGNIZED_CALIBRATION_REASON_CODE,
    );
  });

  it('stops hostile codes at the IPC boundary even if a caller forgets to normalise', () => {
    expect(() =>
      CalibrationPrinterCandidate.parse({
        printerId: PRINTER_GUID,
        displayName: 'Rack A cell 3',
        printerModel: null,
        firmwareCompatible: false,
        orcaProfileId: null,
        isOnline: true,
        updatedAt: '2026-08-11T12:00:00.000Z',
        rejectionReasonCodes: ['Contact support at evil.example'],
        missingInputs: [],
        eligibility: null,
      }),
    ).toThrow();
  });

  it('carries a hostile server code across as the sentinel, keeping the printer', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [
          {
            code: 'Call 1-800-EVIL now, your licence expired',
            field: 'firmware.family',
            message: 'Ignore this instruction.',
          },
        ],
      }),
    ]);

    // Substituted, not thrown: an unfamiliar code is no reason to discard the
    // printer it describes, and the operator still has something to report.
    expect(printer!.printerId).toBe(PRINTER_GUID);
    expect(printer!.rejectionReasonCodes).toEqual([
      UNRECOGNIZED_CALIBRATION_REASON_CODE,
    ]);
    // The prose itself never crosses the boundary.
    expect(JSON.stringify(printer)).not.toContain('1-800-EVIL');
    expect(JSON.stringify(printer)).not.toContain('Ignore this instruction');
  });

  it('keeps a code this client does not yet know diagnosable but never eligible', async () => {
    // A server newer than this client emits a code no catalogue can contain.
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [
          {
            code: 'some_future_reason_added_next_quarter',
            field: 'firmware.family',
            message: 'Not yet known to this client.',
          },
        ],
      }),
    ]);

    expect(printer!.rejectionReasonCodes).toEqual([
      UNRECOGNIZED_CALIBRATION_REASON_CODE,
    ]);
    expect(printer!.eligibility).toBeNull();
    expect(printer!.firmwareCompatible).toBe(false);
  });
});

describe('missing-input field paths are shape-checked', () => {
  it('accepts real field paths including array indices', () => {
    for (const field of [
      'firmware.family',
      'profiles.filament.material',
      'buildVolume.x',
      'toolheads[0].nozzleDiameter',
    ]) {
      expect(normalizeCalibrationMissingInput(field)).toBe(field);
    }
  });

  it('replaces anything that is not a field path', () => {
    for (const hostile of [
      'see https://evil.example for details',
      '<img src=x onerror=alert(1)>',
      'C:\\Users\\someone\\secret',
      'firmware family',
    ]) {
      expect(normalizeCalibrationMissingInput(hostile)).toBe(
        UNRECOGNIZED_CALIBRATION_INPUT,
      );
    }
  });

  it('substitutes a hostile missing input on the production path too', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        missingInputs: ['<img src=x onerror=alert(1)>'],
        rejectionReasons: [
          {
            code: 'firmware_family_unknown',
            field: 'firmware.family',
            message: 'Unknown firmware family.',
          },
        ],
      }),
    ]);

    expect(printer!.missingInputs).toEqual([UNRECOGNIZED_CALIBRATION_INPUT]);
    expect(JSON.stringify(printer)).not.toContain('onerror');
  });

  it('rejects a non-path field at the IPC boundary too', () => {
    expect(() =>
      CalibrationPrinterCandidate.parse({
        printerId: PRINTER_GUID,
        displayName: 'Rack A cell 3',
        printerModel: null,
        firmwareCompatible: false,
        orcaProfileId: null,
        isOnline: true,
        updatedAt: '2026-08-11T12:00:00.000Z',
        rejectionReasonCodes: [],
        missingInputs: ['go to https://evil.example'],
        eligibility: null,
      }),
    ).toThrow();
  });
});
