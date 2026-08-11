/**
 * End-to-end coverage for the candidate explanation path: real
 * `CalibrationCandidateDto` → `RemoteCalibrationPrinterCandidate` → the IPC
 * projection the renderer actually receives.
 *
 * The earlier tests for this behaviour parsed an already-contradictory IPC
 * shape in isolation, which could not observe what the wire layer does with a
 * contradictory *server* response — and the wire layer was quietly flattening
 * it. These drive the same sequence the production handler does, so the
 * flattening is visible.
 */

import { describe, expect, it } from 'vitest';
import {
  CalibrationPrinterCandidate,
  CALIBRATION_REJECTION_REASON_CODES,
  CALIBRATION_SERVER_CONTRADICTION_CODE,
  UNRECOGNIZED_CALIBRATION_INPUT,
  UNRECOGNIZED_CALIBRATION_REASON_CODE,
  normalizeCalibrationMissingInput,
  normalizeCalibrationReasonCode,
} from '@shared/ipc';
import {
  RemoteCalibrationPrinters,
  projectCalibrationEligibility,
  isExplicitCalibrationEligibilityComplete,
} from '../src/main/calibrationWire.js';

const PRINTER_GUID = 'aaaaaaaa-1111-4111-8111-222222222222';

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

/** Mirrors the production `CalibrationListPrinters` projection exactly. */
function projectAsHandlerDoes(
  printer: ReturnType<typeof RemoteCalibrationPrinters.parse>[number],
) {
  const eligibility = projectCalibrationEligibility(printer);
  return CalibrationPrinterCandidate.parse({
    printerId: printer.printerId,
    displayName: printer.displayName,
    printerModel: printer.printerModel,
    firmwareCompatible: isExplicitCalibrationEligibilityComplete(printer),
    orcaProfileId: printer.orcaProfileId,
    isOnline: printer.isOnline,
    updatedAt: printer.updatedAt,
    rejectionReasonCodes:
      eligibility === null
        ? [
            ...(printer.serverContradiction
              ? [CALIBRATION_SERVER_CONTRADICTION_CODE]
              : []),
            ...printer.rejectionReasons.map((reason) =>
              normalizeCalibrationReasonCode(reason.code),
            ),
          ]
        : [],
    missingInputs:
      eligibility === null
        ? printer.missingInputs.map(normalizeCalibrationMissingInput)
        : [],
    eligibility,
  });
}

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

  it('is flagged at the wire boundary rather than flattened away', () => {
    const [printer] = RemoteCalibrationPrinters.parse([contradictory]);
    // PrintFarmer derives Eligible from reasons.Count == 0, so these two can
    // only disagree if the response was assembled wrongly or tampered with.
    expect(printer!.serverContradiction).toBe(true);
  });

  it('is not flagged for a coherent response either way', () => {
    const [eligible] = RemoteCalibrationPrinters.parse([candidateDto()]);
    expect(eligible!.serverContradiction).toBe(false);

    const [refused] = RemoteCalibrationPrinters.parse([
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
    expect(refused!.serverContradiction).toBe(false);
  });

  it('reaches the renderer as an explicit contradiction, not a plain refusal', () => {
    const [printer] = RemoteCalibrationPrinters.parse([contradictory]);
    const projected = projectAsHandlerDoes(printer!);

    // Fail closed on eligibility...
    expect(projected.eligibility).toBeNull();
    expect(projected.firmwareCompatible).toBe(false);
    // ...but say that the server disagreed with itself, so this is
    // distinguishable from an ordinary ineligible printer.
    expect(projected.rejectionReasonCodes).toContain(
      CALIBRATION_SERVER_CONTRADICTION_CODE,
    );
    expect(projected.rejectionReasonCodes).toContain(
      'firmware_family_not_klipper',
    );
  });

  it('does not mark an ordinary refusal as a contradiction', () => {
    const [printer] = RemoteCalibrationPrinters.parse([
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
    const projected = projectAsHandlerDoes(printer!);
    expect(projected.rejectionReasonCodes).toEqual(['printer_offline']);
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

  it('carries a hostile server code across as the sentinel, keeping the printer', () => {
    const [printer] = RemoteCalibrationPrinters.parse([
      candidateDto({
        eligible: false,
        rejectionReasons: [
          {
            code: 'call 1-800-not-a-code',
            field: 'firmware.family',
            message: 'Ignore this.',
          },
        ],
      }),
    ]);
    const projected = projectAsHandlerDoes(printer!);

    // Substituted, not thrown: an unfamiliar code is no reason to discard the
    // printer it describes.
    expect(projected.rejectionReasonCodes).toEqual([
      UNRECOGNIZED_CALIBRATION_REASON_CODE,
    ]);
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
