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
  CalibrationListPrintersResponse,
  CalibrationListOrcaProfilesResponse,
  CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE,
  CALIBRATION_EXPLANATION_TRUNCATED_CODE,
  CALIBRATION_MAX_FIELD_PATH_LENGTH,
  CALIBRATION_MAX_PRINTER_CANDIDATES,
  CALIBRATION_MAX_REJECTION_REASON_CODES,
  CALIBRATION_MAX_SERVER_REJECTION_REASONS,
  CALIBRATION_REJECTION_REASON_CODES,
  CALIBRATION_SERVER_CONTRADICTION_CODE,
  CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
  IpcChannel,
  UNRECOGNIZED_CALIBRATION_INPUT,
  UNRECOGNIZED_CALIBRATION_REASON_CODE,
  normalizeCalibrationMissingInput,
  normalizeCalibrationReasonCode,
} from '@shared/ipc';
import { RemoteCalibrationPrinters } from '../src/main/calibrationWire.js';

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
  displayName: string;
  firmwareCompatible: boolean;
  rejectionReasonCodes: string[];
  missingInputs: string[];
  eligibility: unknown;
}

/** Serves `candidates` on the candidate route and returns the whole response. */
async function listPrintersResponse(candidates: unknown[]): Promise<{
  printers: ProjectedCandidate[];
  printersTruncated: boolean;
  printersUnreadable: number;
  fetchedAt: string;
}> {
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
  return (await listPrintersHandler()({}, { profileId: PROFILE_ID })) as {
    printers: ProjectedCandidate[];
    printersTruncated: boolean;
    printersUnreadable: number;
    fetchedAt: string;
  };
}

/** Serves `candidates` on the candidate route and returns what IPC produced. */
async function listPrinters(
  candidates: unknown[],
): Promise<ProjectedCandidate[]> {
  return (await listPrintersResponse(candidates)).printers;
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

describe('the client-only sentinels cannot be forged from the wire', () => {
  // `server_contradiction` is not a diagnosis, it is an accusation: it means
  // *this client* caught the server disagreeing with itself. Validating raw
  // server codes against an enum that contained it let the accused write the
  // accusation — a coherent printer could arrive already carrying the marker,
  // indistinguishable from one the client synthesized. The two enums exist to
  // separate what a server may say from what the client may conclude.

  it('degrades a forged contradiction marker to the unrecognized sentinel', () => {
    expect(
      normalizeCalibrationReasonCode(CALIBRATION_SERVER_CONTRADICTION_CODE),
    ).toBe(UNRECOGNIZED_CALIBRATION_REASON_CODE);
  });

  it('degrades a forged unrecognized sentinel too', () => {
    // Collides with its own substitute, which is harmless precisely because
    // the resulting claim is true: `unrecognized_reason` is not a catalogue
    // code, so a server sending it verbatim is unrecognized.
    expect(
      normalizeCalibrationReasonCode(UNRECOGNIZED_CALIBRATION_REASON_CODE),
    ).toBe(UNRECOGNIZED_CALIBRATION_REASON_CODE);
  });

  it('does not let a coherent printer arrive pre-marked as a contradiction', async () => {
    // The whole response is self-consistent: not eligible, with a reason. Only
    // the code is a lie.
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [
          {
            code: CALIBRATION_SERVER_CONTRADICTION_CODE,
            field: 'firmware.family',
            message: 'Nothing actually contradicts here.',
          },
        ],
      }),
    ]);

    expect(printer!.rejectionReasonCodes).toEqual([
      UNRECOGNIZED_CALIBRATION_REASON_CODE,
    ]);
    expect(printer!.rejectionReasonCodes).not.toContain(
      CALIBRATION_SERVER_CONTRADICTION_CODE,
    );
  });

  it('still reports a genuine contradiction exactly once when the server also forges one', async () => {
    // Here the server really does contradict itself *and* claims the marker.
    // The marker present in the output must be the client's, and the forged
    // copy must not double it.
    const [printer] = await listPrinters([
      candidateDto({
        eligible: true,
        rejectionReasons: [
          {
            code: CALIBRATION_SERVER_CONTRADICTION_CODE,
            field: 'firmware.family',
            message: 'Forged.',
          },
        ],
      }),
    ]);

    expect(printer!.eligibility).toBeNull();
    expect(printer!.rejectionReasonCodes).toEqual([
      CALIBRATION_SERVER_CONTRADICTION_CODE,
      UNRECOGNIZED_CALIBRATION_REASON_CODE,
    ]);
    expect(
      printer!.rejectionReasonCodes.filter(
        (code) => code === CALIBRATION_SERVER_CONTRADICTION_CODE,
      ),
    ).toHaveLength(1);
  });

  it('still admits the marker on the renderer-facing schema, where the client adds it', () => {
    // Narrowing the wire enum must not narrow the boundary the client's own
    // synthesized code has to cross, or the fix would break the feature.
    expect(() =>
      CalibrationPrinterCandidate.parse({
        printerId: PRINTER_GUID,
        displayName: 'Rack A cell 3',
        printerModel: null,
        firmwareCompatible: false,
        orcaProfileId: null,
        isOnline: true,
        updatedAt: '2026-08-11T12:00:00.000Z',
        rejectionReasonCodes: [
          CALIBRATION_SERVER_CONTRADICTION_CODE,
          UNRECOGNIZED_CALIBRATION_REASON_CODE,
        ],
        missingInputs: [],
        eligibility: null,
      }),
    ).not.toThrow();
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

/**
 * Field paths and codes taken from the server rather than invented.
 *
 * Every string below was read out of `PrinterCalibrationContextService.cs` at
 * the pinned blob. A fixture that no PrintFarmer build emits cannot catch a
 * parity regression — it can only agree with whatever the client already does,
 * which is how `slicer_engine` (a string the server never sends; it sends
 * `slicer.engine`) sat in the discovery fixtures while two real paths were
 * being silently discarded.
 *
 * Sourcing is specifically to `RejectMissing`, which is the only helper that
 * adds to `missingInputs`; plain `Reject` accepts the set and never writes to
 * it. `profiles.filament.exactJson.required_nozzle_HRC` is a `Reject` field
 * and therefore *not* a missing input, so it is deliberately absent below —
 * asserting it here would be a fixture for a message the server never sends.
 */
describe('the shapes the server actually sends survive the boundary', () => {
  // Two of these address keys inside an OrcaSlicer profile document, so they
  // are snake_case; an identifier-only pattern reduced both to
  // `unrecognized_input`. The toolhead paths interpolate an array index.
  const REAL_SERVER_FIELD_PATHS = [
    'firmware.family',
    'firmware.gcodeDialect',
    'firmware.detectionConfidence',
    'bedOrigin.x',
    'buildVolume.z',
    'activeToolheadIndex',
    'slicer.engine',
    'slicer.filamentProfileId',
    'profiles.filament.material',
    'profiles.machine.updatedAtUtc',
    'profiles.machine.exactJson.gcode_flavor',
    'profiles.machine.exactJson.nozzle_diameter',
    'toolheads[0].nozzleDiameter',
    'toolheads[0].offset.x',
  ];

  it('keeps every real field path intact', () => {
    for (const field of REAL_SERVER_FIELD_PATHS) {
      expect(normalizeCalibrationMissingInput(field)).toBe(field);
    }
  });

  it('carries them through the registered handler unchanged', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        missingInputs: REAL_SERVER_FIELD_PATHS,
        rejectionReasons: [
          {
            code: 'profile_nozzle_data_missing',
            field: 'profiles.machine.exactJson.nozzle_diameter',
            message: 'The machine profile does not state a nozzle diameter.',
          },
        ],
      }),
    ]);

    expect(printer!.missingInputs).toEqual(REAL_SERVER_FIELD_PATHS);
    expect(printer!.missingInputs).not.toContain(
      UNRECOGNIZED_CALIBRATION_INPUT,
    );
  });

  it('still refuses traversal, separators and prose', () => {
    for (const hostile of [
      '../../etc/passwd',
      'profiles..machine',
      'profiles/machine/exactJson',
      'profiles\\machine',
      '.leadingDot',
      'profiles.machine.',
      '_leadingUnderscore',
      'firmware family',
      'see https://evil.example for details',
    ]) {
      expect(normalizeCalibrationMissingInput(hostile)).toBe(
        UNRECOGNIZED_CALIBRATION_INPUT,
      );
    }
  });

  it('accepts the safety codes the server forwards indirectly', async () => {
    // These six never appear as literals in the eligibility evaluator: it
    // forwards `safety.Code` from `CalibrationProfileSafetyValidator`. A
    // catalogue built by scanning that one file for literals omits all of
    // them, and every one then degrades to `unrecognized_reason`.
    const indirect = [
      'profile_contains_credential',
      'profile_contains_filesystem_path',
      'profile_contains_private_url',
      'profile_contains_unsafe_command',
      'profile_json_invalid',
      'profile_json_missing',
    ];

    for (const code of indirect) {
      expect(CALIBRATION_REJECTION_REASON_CODES).toContain(code);
      expect(normalizeCalibrationReasonCode(code)).toBe(code);
    }

    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: indirect.map((code) => ({
          code,
          field: 'profiles.machine.exactJson',
          message: 'Profile safety validation failed.',
        })),
      }),
    ]);

    expect(printer!.rejectionReasonCodes).toEqual(indirect);
  });
});

describe('the code bound accounts for the code the client adds', () => {
  /** A full server response: the wire cap of distinct real reasons. */
  function maximalReasons() {
    return Array.from(
      { length: CALIBRATION_MAX_SERVER_REJECTION_REASONS },
      (_unused, index) => ({
        code: CALIBRATION_REJECTION_REASON_CODES[
          index % CALIBRATION_REJECTION_REASON_CODES.length
        ]!,
        field: 'firmware.family',
        message: 'Reason.',
      }),
    );
  }

  it('reserves a slot for each diagnostic the client can add', () => {
    // One naming an incoherent verdict, one declaring the list was cut.
    expect(CALIBRATION_MAX_REJECTION_REASON_CODES).toBe(
      CALIBRATION_MAX_SERVER_REJECTION_REASONS + 2,
    );
  });

  it('survives a full 64 reasons that also contradict, instead of erasing the list', async () => {
    // Both bounds used to be spelled `.max(64)`. A contradictory response at
    // the server's cap produced 65 codes, the IPC schema refused the whole
    // `{ printers: [...] }` value, and *every* printer vanished — the
    // empty-discovery failure this contract exists to prevent.
    const printers = await listPrinters([
      candidateDto({ eligible: true, rejectionReasons: maximalReasons() }),
    ]);

    expect(printers).toHaveLength(1);
    // Exactly at the cap, so nothing is cut: 64 reasons plus the marker.
    expect(printers[0]!.rejectionReasonCodes).toHaveLength(
      CALIBRATION_MAX_SERVER_REJECTION_REASONS + 1,
    );
    expect(printers[0]!.rejectionReasonCodes.length).toBeLessThanOrEqual(
      CALIBRATION_MAX_REJECTION_REASON_CODES,
    );
    expect(printers[0]!.rejectionReasonCodes).not.toContain(
      CALIBRATION_EXPLANATION_TRUNCATED_CODE,
    );
    expect(printers[0]!.rejectionReasonCodes[0]).toBe(
      CALIBRATION_SERVER_CONTRADICTION_CODE,
    );
    expect(printers[0]!.eligibility).toBeNull();
  });

  it('does not drop a neighbouring printer when one candidate is maximal', async () => {
    // The parse covers the whole list, so the blast radius of an over-long
    // candidate is every other printer in the farm.
    const printers = await listPrinters([
      candidateDto({ eligible: true, rejectionReasons: maximalReasons() }),
      candidateDto({ id: '99999999-9999-4999-8999-999999999999' }),
    ]);

    expect(printers).toHaveLength(2);
    expect(printers[1]!.eligibility).not.toBeNull();
  });

  it('keeps duplicate codes rather than collapsing them, and stays bounded', async () => {
    // Repetition is information: the same code can be reported against
    // several fields. Preserved, but still inside the bound.
    const printers = await listPrinters([
      candidateDto({
        eligible: true,
        rejectionReasons: Array.from(
          { length: CALIBRATION_MAX_SERVER_REJECTION_REASONS },
          () => ({
            code: 'printer_offline',
            field: 'reachability',
            message: 'Printer is offline.',
          }),
        ),
      }),
    ]);

    const codes = printers[0]!.rejectionReasonCodes;
    expect(codes).toHaveLength(CALIBRATION_MAX_SERVER_REJECTION_REASONS + 1);
    expect(codes.length).toBeLessThanOrEqual(
      CALIBRATION_MAX_REJECTION_REASON_CODES,
    );
    expect(codes.filter((code) => code === 'printer_offline')).toHaveLength(
      CALIBRATION_MAX_SERVER_REJECTION_REASONS,
    );
  });
});

describe('an incoherent verdict is named in whichever direction it breaks', () => {
  // PrintFarmer computes `Eligible = reasons.Count == 0`, and RejectMissing
  // always records a reason beside the missing input, so a coherent response
  // satisfies `eligible === (nothing was said against it)`. Detecting only the
  // eligible-with-reasons half left the mirror arriving as an ordinary
  // ineligible printer with an empty explanation — a refusal an operator can
  // neither act on nor report.

  it('names an unexplained refusal instead of shrugging', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [],
        missingInputs: [],
      }),
    ]);

    expect(printer!.eligibility).toBeNull();
    expect(printer!.firmwareCompatible).toBe(false);
    expect(printer!.rejectionReasonCodes).toEqual([
      CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
    ]);
  });

  it('never hands the renderer an empty explanation for a refused printer', async () => {
    // The guarantee stated as itself, across every shape that reaches the
    // ineligible branch — including the residual one where the server is
    // coherent and reason-free but never names the required identities.
    const shapes = [
      candidateDto({ eligible: false, rejectionReasons: [] }),
      candidateDto({
        eligible: false,
        rejectionReasons: [
          { code: 'printer_offline', field: 'reachability', message: 'Off.' },
        ],
      }),
      candidateDto({
        eligible: true,
        rejectionReasons: [
          { code: 'printer_offline', field: 'reachability', message: 'Off.' },
        ],
      }),
      // Coherent and reason-free, but the firmware it names is not Klipper, so
      // this client cannot verify the eligibility the server granted.
      candidateDto({
        eligible: true,
        firmware: {
          family: 'Marlin',
          gcodeDialect: 'Marlin',
          detectionSource: 'probe',
          version: '2.1.2',
          verified: true,
        },
      }),
    ];

    const printers = await listPrinters(shapes);

    expect(printers).toHaveLength(shapes.length);
    for (const printer of printers) {
      expect(printer.eligibility).toBeNull();
      expect(printer.rejectionReasonCodes.length).toBeGreaterThan(0);
    }
  });

  it('says which identity claim it could not verify, rather than nothing', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: true,
        slicer: {
          engine: 'PrusaSlicer',
          distribution: 'upstream',
          version: '2.7.0',
          profileFormat: 'ini',
        },
      }),
    ]);

    expect(printer!.eligibility).toBeNull();
    expect(printer!.rejectionReasonCodes).toEqual([
      CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE,
    ]);
  });

  it('leaves a coherent refusal and a coherent grant alone', async () => {
    const [refused, granted] = await listPrinters([
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
      candidateDto(),
    ]);

    expect(refused!.rejectionReasonCodes).toEqual(['printer_offline']);
    expect(granted!.eligibility).not.toBeNull();
    expect(granted!.rejectionReasonCodes).toEqual([]);
  });

  it('refuses without a reason, even while naming missing inputs', async () => {
    // The shape that escaped: `Eligible = reasons.Count == 0` is defined on
    // rejection reasons alone, so this violates it outright — yet a predicate
    // that folded `missingInputs` into one merged "was anything said against
    // it" counted the printer as explained, matched neither branch, and let it
    // fall through to the unverified-eligibility fallback, whose meaning is
    // the opposite. A real invariant violation reported as a weaker, wrong
    // diagnosis.
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [],
        missingInputs: ['firmware.family'],
      }),
    ]);

    expect(printer!.eligibility).toBeNull();
    expect(printer!.rejectionReasonCodes).toEqual([
      CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
    ]);
    expect(printer!.rejectionReasonCodes).not.toContain(
      CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE,
    );
    // The inputs it did name are still carried; they are simply not a reason.
    expect(printer!.missingInputs).toEqual(['firmware.family']);
  });

  it('classifies every combination of the two server invariants', async () => {
    // `Eligible = reasons.Count == 0`, and RejectMissing records a reason
    // beside every missing input. Spelled out as a table so a future change to
    // the predicate has to confront each cell rather than the one case that
    // happened to be exercised.
    const reason = {
      code: 'printer_offline',
      field: 'reachability',
      message: 'Printer is offline.',
    };
    const cases: {
      label: string;
      dto: Record<string, unknown>;
      expected: string | null;
    }[] = [
      {
        label: 'eligible, silent — coherent',
        dto: { eligible: true, rejectionReasons: [], missingInputs: [] },
        expected: null,
      },
      {
        label: 'eligible with a reason — contradiction',
        dto: { eligible: true, rejectionReasons: [reason], missingInputs: [] },
        expected: CALIBRATION_SERVER_CONTRADICTION_CODE,
      },
      {
        label: 'eligible with a missing input and no reason — contradiction',
        dto: {
          eligible: true,
          rejectionReasons: [],
          missingInputs: ['firmware.family'],
        },
        expected: CALIBRATION_SERVER_CONTRADICTION_CODE,
      },
      {
        label: 'refused with a reason — coherent',
        dto: { eligible: false, rejectionReasons: [reason], missingInputs: [] },
        expected: null,
      },
      {
        label: 'refused with a reason and a missing input — coherent',
        dto: {
          eligible: false,
          rejectionReasons: [reason],
          missingInputs: ['firmware.family'],
        },
        expected: null,
      },
      {
        label: 'refused saying nothing — unexplained refusal',
        dto: { eligible: false, rejectionReasons: [], missingInputs: [] },
        expected: CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
      },
      {
        label:
          'refused with a missing input but no reason — unexplained refusal',
        dto: {
          eligible: false,
          rejectionReasons: [],
          missingInputs: ['firmware.family'],
        },
        expected: CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
      },
    ];

    const printers = await listPrinters(
      cases.map((entry) => candidateDto(entry.dto)),
    );

    expect(printers).toHaveLength(cases.length);
    cases.forEach((entry, index) => {
      const codes = printers[index]!.rejectionReasonCodes;
      if (entry.expected === null) {
        expect(
          codes.some((code) =>
            [
              CALIBRATION_SERVER_CONTRADICTION_CODE,
              CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
            ].includes(code),
          ),
          entry.label,
        ).toBe(false);
      } else {
        expect(codes, entry.label).toContain(entry.expected);
      }
    });
  });

  it('keeps both incoherence markers unforgeable from the wire', () => {
    for (const sentinel of [
      CALIBRATION_SERVER_CONTRADICTION_CODE,
      CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
      CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE,
    ]) {
      expect(normalizeCalibrationReasonCode(sentinel)).toBe(
        UNRECOGNIZED_CALIBRATION_REASON_CODE,
      );
    }
  });
});

describe('an over-long string degrades one field, not the whole farm', () => {
  // `schema.parse` runs over the entire `/calibration-candidates` array as one
  // value, so a length bound that *rejects* is a length bound that discards:
  // one over-long code took every printer with it, which is exactly the empty
  // discovery this contract exists to prevent.
  const OVERLONG = 'a'.repeat(4096);

  it('maps an over-long code to the sentinel and keeps the printer', async () => {
    const printers = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [
          { code: OVERLONG, field: 'firmware.family', message: 'Long.' },
        ],
      }),
    ]);

    expect(printers).toHaveLength(1);
    expect(printers[0]!.rejectionReasonCodes).toEqual([
      UNRECOGNIZED_CALIBRATION_REASON_CODE,
    ]);
  });

  it('maps an over-long field path to the sentinel and keeps the printer', async () => {
    const printers = await listPrinters([
      candidateDto({
        eligible: false,
        missingInputs: [OVERLONG],
        rejectionReasons: [
          {
            code: 'firmware_family_unknown',
            field: 'firmware.family',
            message: 'Unknown.',
          },
        ],
      }),
    ]);

    expect(printers).toHaveLength(1);
    expect(printers[0]!.missingInputs).toEqual([
      UNRECOGNIZED_CALIBRATION_INPUT,
    ]);
  });

  it('substitutes a path that is well-formed but longer than the renderer carries', () => {
    // Shape alone is not enough: a dotted path of legal segments can still
    // exceed the bound, and passing it through would move the rejection to the
    // IPC schema, which throws for the whole response rather than one field.
    const segments = Array.from({ length: 40 }, () => 'segment');
    const wellFormedButLong = segments.join('.');

    expect(wellFormedButLong.length).toBeGreaterThan(
      CALIBRATION_MAX_FIELD_PATH_LENGTH,
    );
    expect(normalizeCalibrationMissingInput(wellFormedButLong)).toBe(
      UNRECOGNIZED_CALIBRATION_INPUT,
    );
  });

  it('does not let one over-long candidate erase its neighbours', async () => {
    const printers = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [
          { code: OVERLONG, field: OVERLONG, message: OVERLONG },
        ],
        missingInputs: [OVERLONG],
      }),
      candidateDto({ id: '99999999-9999-4999-8999-999999999999' }),
    ]);

    expect(printers).toHaveLength(2);
    expect(printers[1]!.eligibility).not.toBeNull();
    // And none of the over-long text reached the renderer.
    expect(JSON.stringify(printers)).not.toContain('aaaaaaaaaa');
  });

  it('still refuses an over-long path at the IPC boundary if one gets that far', () => {
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
        missingInputs: ['a'.repeat(CALIBRATION_MAX_FIELD_PATH_LENGTH + 1)],
        eligibility: null,
      }),
    ).toThrow();
  });
});

describe('a list longer than the cap is cut, never a reason to refuse the farm', () => {
  // Exceeding the per-printer cap is not a sign of a bad server. The evaluator
  // asks about a dozen questions of every toolhead, so a freshly added
  // five-toolhead machine reports far more than sixty-four missing inputs with
  // nothing wrong anywhere. Rejecting on count took every healthy printer in
  // the farm with it.
  const OVER_CAP = CALIBRATION_MAX_SERVER_REJECTION_REASONS + 30;

  function manyFieldPaths(count: number) {
    return Array.from(
      { length: count },
      (_unused, index) => `toolheads[${index % 8}].nozzleDiameter`,
    );
  }

  function manyReasons(count: number) {
    return Array.from({ length: count }, (_unused, index) => ({
      code: CALIBRATION_REJECTION_REASON_CODES[
        index % CALIBRATION_REJECTION_REASON_CODES.length
      ]!,
      field: `toolheads[${index % 8}].nozzleDiameter`,
      message: 'Missing.',
    }));
  }

  it('keeps a healthy printer visible beside one with too many missing inputs', async () => {
    const printers = await listPrinters([
      candidateDto({
        eligible: false,
        missingInputs: manyFieldPaths(OVER_CAP),
        rejectionReasons: manyReasons(OVER_CAP),
      }),
      candidateDto({ id: '99999999-9999-4999-8999-999999999999' }),
    ]);

    expect(printers).toHaveLength(2);
    // The healthy one is untouched...
    expect(printers[1]!.eligibility).not.toBeNull();
    // ...and the crowded one is still present, still refused, still explained.
    expect(printers[0]!.eligibility).toBeNull();
    expect(printers[0]!.rejectionReasonCodes.length).toBeGreaterThan(0);
  });

  it('says the explanation was cut rather than cutting it silently', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        missingInputs: manyFieldPaths(OVER_CAP),
        rejectionReasons: manyReasons(OVER_CAP),
      }),
    ]);

    expect(printer!.rejectionReasonCodes).toContain(
      CALIBRATION_EXPLANATION_TRUNCATED_CODE,
    );
    expect(printer!.missingInputs).toHaveLength(
      CALIBRATION_MAX_SERVER_REJECTION_REASONS,
    );
  });

  it('flags truncation from an over-long missing-input list alone', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        missingInputs: manyFieldPaths(OVER_CAP),
        rejectionReasons: manyReasons(1),
      }),
    ]);

    expect(printer!.rejectionReasonCodes).toContain(
      CALIBRATION_EXPLANATION_TRUNCATED_CODE,
    );
  });

  it('flags truncation from an over-long reason list alone', async () => {
    // The mirror of the case above, and the one the other overflow tests could
    // not pin: they overflow both lists at once, so either half of the
    // truncation check could have been deleted with every assertion still
    // passing. Here `missingInputs` is comfortably under the cap, so only the
    // reasons arm can be responsible.
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        missingInputs: manyFieldPaths(2),
        rejectionReasons: manyReasons(OVER_CAP),
      }),
    ]);

    expect(printer!.missingInputs).toHaveLength(2);
    expect(printer!.rejectionReasonCodes).toContain(
      CALIBRATION_EXPLANATION_TRUNCATED_CODE,
    );
    expect(
      printer!.rejectionReasonCodes.filter(
        (code) => code !== CALIBRATION_EXPLANATION_TRUNCATED_CODE,
      ),
    ).toHaveLength(CALIBRATION_MAX_SERVER_REJECTION_REASONS);
  });

  it('stays inside the IPC bound when it is crowded AND contradictory', async () => {
    // The worst case for the arithmetic: a full server list, cut, plus the
    // incoherence marker, plus the truncation marker.
    const printers = await listPrinters([
      candidateDto({
        eligible: true,
        missingInputs: manyFieldPaths(OVER_CAP),
        rejectionReasons: manyReasons(OVER_CAP),
      }),
    ]);

    const codes = printers[0]!.rejectionReasonCodes;
    expect(codes.length).toBeLessThanOrEqual(
      CALIBRATION_MAX_REJECTION_REASON_CODES,
    );
    expect(codes[0]).toBe(CALIBRATION_SERVER_CONTRADICTION_CODE);
    expect(codes).toContain(CALIBRATION_EXPLANATION_TRUNCATED_CODE);
    expect(codes).toHaveLength(CALIBRATION_MAX_REJECTION_REASON_CODES);
  });

  it('does not claim truncation for a printer that fits', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        missingInputs: manyFieldPaths(3),
        rejectionReasons: manyReasons(3),
      }),
    ]);

    expect(printer!.rejectionReasonCodes).not.toContain(
      CALIBRATION_EXPLANATION_TRUNCATED_CODE,
    );
  });

  it('keeps the truncation marker unforgeable from the wire', () => {
    expect(
      normalizeCalibrationReasonCode(CALIBRATION_EXPLANATION_TRUNCATED_CODE),
    ).toBe(UNRECOGNIZED_CALIBRATION_REASON_CODE);
  });
});

describe('a large farm is not a reason to show an empty one', () => {
  // The wire allowed 500 candidates and the IPC schema allowed 200, so a farm
  // between those numbers parsed off the network and was then rejected on the
  // way to the renderer — as one value, taking every printer with it.
  it('delivers a farm larger than the old IPC ceiling', async () => {
    const farm = Array.from({ length: 260 }, (_unused, index) =>
      candidateDto({
        id: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-222222222222`,
      }),
    );

    const printers = await listPrinters(farm);

    expect(printers).toHaveLength(260);
    expect(printers.every((printer) => printer.eligibility !== null)).toBe(
      true,
    );
  });

  it('cuts a farm beyond the shared cap instead of refusing all of it', async () => {
    const farm = Array.from(
      { length: CALIBRATION_MAX_PRINTER_CANDIDATES + 40 },
      (_unused, index) =>
        candidateDto({
          id: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-222222222222`,
        }),
    );

    const printers = await listPrinters(farm);

    expect(printers).toHaveLength(CALIBRATION_MAX_PRINTER_CANDIDATES);
  });

  it('says the farm list is partial rather than presenting it as whole', async () => {
    // Cutting silently is its own untruth: an operator hunting a printer that
    // is simply off the end would read "500 candidates loaded" and conclude it
    // was never enrolled.
    const farm = Array.from({ length: 540 }, (_unused, index) =>
      candidateDto({
        id: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-222222222222`,
      }),
    );

    const response = await listPrintersResponse(farm);

    expect(response.printers).toHaveLength(CALIBRATION_MAX_PRINTER_CANDIDATES);
    expect(response.printersTruncated).toBe(true);
    // The ones that did survive are intact, not damaged by the cut.
    expect(response.printers.every((p) => p.eligibility !== null)).toBe(true);
  });

  it('does not claim truncation at exactly the cap', async () => {
    const farm = Array.from(
      { length: CALIBRATION_MAX_PRINTER_CANDIDATES },
      (_unused, index) =>
        candidateDto({
          id: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-222222222222`,
        }),
    );

    const response = await listPrintersResponse(farm);

    expect(response.printers).toHaveLength(CALIBRATION_MAX_PRINTER_CANDIDATES);
    expect(response.printersTruncated).toBe(false);
  });

  it('does not claim truncation for an ordinary farm', async () => {
    const response = await listPrintersResponse([candidateDto()]);

    expect(response.printersTruncated).toBe(false);
  });

  it('will not let the server assert or deny the cut itself', async () => {
    // The flag is derived from the raw wire length in the main process. A
    // server that wraps its payload and claims completeness cannot be believed
    // over the count, or the warning would be suppressible by the party whose
    // response triggered it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              printers: Array.from({ length: 520 }, (_unused, index) =>
                candidateDto({
                  id: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-222222222222`,
                }),
              ),
              printersTruncated: false,
              truncated: false,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    const response = (await listPrintersHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as { printers: ProjectedCandidate[]; printersTruncated: boolean };

    expect(response.printersTruncated).toBe(true);
  });
});

describe('no single candidate can empty the farm', () => {
  /**
   * The invariant, asserted as itself rather than one more instance of it.
   *
   * Five review rounds each found a different member that hard-rejected and
   * therefore discarded the whole response: an over-long code, a code list one
   * past its cap, a missing-input list a real five-toolhead printer exceeds, a
   * farm larger than the IPC bound. Each was fixed where it was found, and
   * each time the next field over had the same shape. What follows does not
   * name a field: it corrupts every member of a real candidate, one at a time,
   * with values chosen to break length, count, type and shape, and requires
   * that a healthy printer standing beside the broken one always survives.
   *
   * A sixth round finding field N+1 would fail here first.
   */
  const CORRUPTIONS: { label: string; value: unknown }[] = [
    { label: 'null', value: null },
    { label: 'a number', value: 42 },
    { label: 'a negative number', value: -1 },
    { label: 'a fraction', value: 1.5 },
    { label: 'true', value: true },
    { label: 'an empty string', value: '' },
    { label: 'a very long string', value: 'x'.repeat(2_000) },
    { label: 'an empty array', value: [] },
    { label: 'an array of numbers', value: [1, 2, 3] },
    { label: 'an empty object', value: {} },
    { label: 'a deeply nested object', value: { a: { b: { c: { d: 1 } } } } },
    { label: 'a huge array', value: Array.from({ length: 300 }, () => 'x') },
    { label: 'text where an instant belongs', value: 'yesterday' },
    { label: 'a malformed guid', value: 'not-a-guid' },
  ];

  const HEALTHY_ID = '99999999-9999-4999-8999-999999999999';

  function candidateKeys(): string[] {
    return Object.keys(candidateDto());
  }

  it('survives every corruption of every top-level member', () => {
    // Asserted at the wire schema, which is the seam that decides whether one
    // candidate can fail the array. Driven directly rather than through the
    // handler so the corpus can be exhaustive: this is ~300 cases, and each
    // round trip through the HTTP client's retry and timeout machinery costs
    // far more than the parse being measured. Handler-level cases below cover
    // the same property end to end.
    const failures: string[] = [];

    for (const key of candidateKeys()) {
      for (const corruption of CORRUPTIONS) {
        const broken = candidateDto({ [key]: corruption.value });
        const healthy = candidateDto({ id: HEALTHY_ID });

        let parsed;
        try {
          parsed = RemoteCalibrationPrinters.parse([broken, healthy]);
        } catch (error) {
          failures.push(
            `${key} = ${corruption.label}: threw ${String(error).slice(0, 120)}`,
          );
          continue;
        }

        if (
          !parsed.printers.some((printer) => printer.printerId === HEALTHY_ID)
        ) {
          failures.push(
            `${key} = ${corruption.label}: the healthy printer was discarded`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('survives every corruption of the nested firmware and slicer identities', () => {
    const failures: string[] = [];
    const nested: [string, string[]][] = [
      ['firmware', ['family', 'gcodeDialect', 'detectionSource', 'version']],
      ['slicer', ['engine', 'distribution', 'version', 'profileFormat']],
    ];

    for (const [parent, keys] of nested) {
      for (const key of keys) {
        for (const corruption of CORRUPTIONS) {
          const base = candidateDto();
          const broken = candidateDto({
            [parent]: {
              ...(base[parent as keyof typeof base] as object),
              [key]: corruption.value,
            },
          });
          const healthy = candidateDto({ id: HEALTHY_ID });

          try {
            const parsed = RemoteCalibrationPrinters.parse([broken, healthy]);
            if (
              !parsed.printers.some(
                (printer) => printer.printerId === HEALTHY_ID,
              )
            ) {
              failures.push(
                `${parent}.${key} = ${corruption.label}: healthy printer discarded`,
              );
            }
          } catch (error) {
            failures.push(
              `${parent}.${key} = ${corruption.label}: threw ${String(error).slice(0, 120)}`,
            );
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('survives a candidate that is not an object at all', async () => {
    for (const junk of [null, 7, 'printer', [], true]) {
      const printers = await listPrinters([junk, candidateDto()]);
      expect(printers).toHaveLength(1);
      expect(printers[0]!.printerId).toBe(PRINTER_GUID);
    }
  });

  it('counts what it could not read instead of hiding the gap', async () => {
    const response = await listPrintersResponse([
      candidateDto({ id: 'not-a-guid' }),
      null,
      candidateDto(),
    ]);

    expect(response.printers).toHaveLength(1);
    expect(response.printersUnreadable).toBe(2);
  });

  it('reports nothing unreadable when the whole farm parses', async () => {
    const response = await listPrintersResponse([
      candidateDto(),
      candidateDto({ id: HEALTHY_ID }),
    ]);

    expect(response.printers).toHaveLength(2);
    expect(response.printersUnreadable).toBe(0);
  });

  it('isolates a record the wire accepts but the renderer contract refuses', async () => {
    // The seam the corruption sweep above could not see. It asserts against
    // the wire schema, so a value that *passes* the wire and fails only at the
    // IPC boundary slipped through: `ServerInstant` accepted an out-of-range
    // instant and rendered it as an ECMAScript expanded year
    // (`+010000-01-01T00:00:00.000Z`), which `z.string().datetime()` rejects.
    // The candidate was therefore classified readable, the response schema
    // covers the whole list, and one such timestamp discarded every healthy
    // printer while reporting nothing lost.
    for (const instant of [
      '+010000-01-01T00:00:00.000Z',
      '10000-01-01',
      'January 1, 12345',
    ]) {
      const response = await listPrintersResponse([
        candidateDto({ observedAtUtc: instant, lastSeenAtUtc: null }),
        candidateDto({ id: HEALTHY_ID }),
      ]);

      expect(
        response.printers.some((printer) => printer.printerId === HEALTHY_ID),
        instant,
      ).toBe(true);
      expect(response.printers, instant).toHaveLength(1);
      // Counted, not silently dropped: the whole point of the count is that a
      // shorter list than the operator owns is visible as a fault.
      expect(response.printersUnreadable, instant).toBe(1);
    }
  });

  it('drives the corruption sweep through the registered handler too', async () => {
    // The sweep above runs at the wire schema for speed. This runs a smaller
    // corpus through the production handler, so a value that is only refused
    // further downstream — as the expanded-year instant was — cannot hide in
    // the gap between the two layers again.
    const throughHandler = [
      { label: 'expanded-year instant', dto: { observedAtUtc: '10000-01-01' } },
      { label: 'null id', dto: { id: null } },
      { label: 'numeric reachability', dto: { reachability: 7 } },
      { label: 'array firmware', dto: { firmware: [1, 2, 3] } },
      {
        label: 'long operational state',
        dto: { operationalState: 'x'.repeat(5_000) },
      },
      { label: 'fractional revision', dto: { configurationRevision: 1.5 } },
    ];

    for (const entry of throughHandler) {
      const response = await listPrintersResponse([
        candidateDto(entry.dto),
        candidateDto({ id: HEALTHY_ID }),
      ]);

      expect(
        response.printers.some((printer) => printer.printerId === HEALTHY_ID),
        entry.label,
      ).toBe(true);
      expect(
        response.printers.length + response.printersUnreadable,
        entry.label,
      ).toBe(2);
    }
  });
});

describe('the unreadable count is bounded and required at the schema itself', () => {
  // Asserted against the schemas directly, not only through handler happy
  // paths. A handler test proves what the handler does today; these prove what
  // the contract will accept from anything, including a future caller that
  // forgets to propagate the field.
  const validCandidate = {
    printerId: PRINTER_GUID,
    displayName: 'Rack A cell 3',
    printerModel: null,
    firmwareCompatible: false,
    orcaProfileId: null,
    isOnline: true,
    updatedAt: '2026-08-11T12:00:00.000Z',
    rejectionReasonCodes: ['printer_offline'],
    missingInputs: [],
    eligibility: null,
  };

  function printersResponse(overrides: Record<string, unknown> = {}) {
    return {
      printers: [validCandidate],
      printersTruncated: false,
      printersUnreadable: 0,
      fetchedAt: '2026-08-11T12:00:00.000Z',
      ...overrides,
    };
  }

  it('accepts a count at exactly the candidate cap when nothing was readable', () => {
    // Zero readable printers, because the two numbers are parts of one whole:
    // a full cap of unreadable records leaves no room for a readable one.
    expect(() =>
      CalibrationListPrintersResponse.parse(
        printersResponse({
          printers: [],
          printersUnreadable: CALIBRATION_MAX_PRINTER_CANDIDATES,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects readable and unreadable counts that together exceed the cap', () => {
    // The physically impossible case a per-field bound cannot see: one printer
    // was read, and five hundred more were not, from a list that only ever
    // holds five hundred.
    expect(() =>
      CalibrationListPrintersResponse.parse(
        printersResponse({
          printers: [validCandidate],
          printersUnreadable: CALIBRATION_MAX_PRINTER_CANDIDATES,
        }),
      ),
    ).toThrow();
  });

  it('accepts a readable printer alongside the largest count that still fits', () => {
    // The boundary from the other side, so the rule above bounds rather than
    // blankets.
    expect(() =>
      CalibrationListPrintersResponse.parse(
        printersResponse({
          printers: [validCandidate],
          printersUnreadable: CALIBRATION_MAX_PRINTER_CANDIDATES - 1,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a count one past the cap', () => {
    // The production count is derived by counting failures among the
    // candidates considered, so it cannot exceed them. Saying so in the schema
    // makes that reasoning executable rather than a comment.
    expect(() =>
      CalibrationListPrintersResponse.parse(
        printersResponse({
          printersUnreadable: CALIBRATION_MAX_PRINTER_CANDIDATES + 1,
        }),
      ),
    ).toThrow();
  });

  it('rejects a negative count', () => {
    expect(() =>
      CalibrationListPrintersResponse.parse(
        printersResponse({ printersUnreadable: -1 }),
      ),
    ).toThrow();
  });

  it('rejects omission rather than assuming nothing was lost', () => {
    const withoutCount = { ...printersResponse() };
    delete (withoutCount as Record<string, unknown>).printersUnreadable;
    expect(() => CalibrationListPrintersResponse.parse(withoutCount)).toThrow();
  });

  it('applies the same bound and requirement to the profiles response', () => {
    const base = {
      profiles: [],
      discovery: {
        kind: 'ok' as const,
        message: 'Server profile discovery completed.',
        serverCode: null,
      },
      printersUnreadable: 0,
      printersTruncated: false,
      localProfiles: [],
      localDiscovery: {
        kind: 'ok' as const,
        message: 'Local OrcaSlicer profile scan completed.',
      },
    };

    expect(() =>
      CalibrationListOrcaProfilesResponse.parse({
        ...base,
        printersUnreadable: CALIBRATION_MAX_PRINTER_CANDIDATES,
      }),
    ).not.toThrow();
    expect(() =>
      CalibrationListOrcaProfilesResponse.parse({
        ...base,
        printersUnreadable: CALIBRATION_MAX_PRINTER_CANDIDATES + 1,
      }),
    ).toThrow();

    // Omission must reject rather than default to zero. Main, preload and
    // renderer ship together, so there is no old caller to accommodate — and a
    // default would turn a future propagation slip into a confident claim that
    // every record was readable.
    const withoutCount = { ...base } as Record<string, unknown>;
    delete withoutCount.printersUnreadable;
    expect(() =>
      CalibrationListOrcaProfilesResponse.parse(withoutCount),
    ).toThrow();

    const withoutTruncation = { ...base } as Record<string, unknown>;
    delete withoutTruncation.printersTruncated;
    expect(() =>
      CalibrationListOrcaProfilesResponse.parse(withoutTruncation),
    ).toThrow();
  });
});

describe('the server message is never treated as a machine code', () => {
  it('ignores `message` entirely, however plausible it looks', async () => {
    // The message is the one field the server writes freely. Even when it is
    // shaped exactly like a catalogue code, it must not become one.
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [
          {
            code: 'printer_offline',
            field: 'reachability',
            message: 'firmware_family_not_klipper',
          },
        ],
      }),
    ]);

    expect(printer!.rejectionReasonCodes).toEqual(['printer_offline']);
    expect(printer!.rejectionReasonCodes).not.toContain(
      'firmware_family_not_klipper',
    );
    expect(JSON.stringify(printer)).not.toContain(
      'firmware_family_not_klipper',
    );
  });

  it('keeps the printer visible and ineligible rather than dropping it', async () => {
    const [printer] = await listPrinters([
      candidateDto({
        eligible: false,
        rejectionReasons: [
          {
            code: 'not a code at all, just prose',
            field: 'firmware.family',
            message: 'Prose.',
          },
        ],
        missingInputs: ['not a path either'],
      }),
    ]);

    expect(printer!.printerId).toBe(PRINTER_GUID);
    expect(printer!.displayName).toBe('Rack A cell 3');
    expect(printer!.eligibility).toBeNull();
    expect(printer!.firmwareCompatible).toBe(false);
    expect(printer!.rejectionReasonCodes).toEqual([
      UNRECOGNIZED_CALIBRATION_REASON_CODE,
    ]);
    expect(printer!.missingInputs).toEqual([UNRECOGNIZED_CALIBRATION_INPUT]);
  });
});
