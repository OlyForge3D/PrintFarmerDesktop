/**
 * Regression coverage for two ways a single bad field could empty the wizard or
 * block generation outright.
 *
 * Both were found in review of the discovery-contract fix. Each is a case where
 * a value that is legal on the wire met a stricter expectation downstream, and
 * neither had a fixture that exercised it.
 */

import { describe, expect, it } from 'vitest';
import {
  CalibrationPrinterCandidate,
  OrcaProfileEntry,
  resolveOrcaBaseProfileLookupName,
} from '@shared/ipc';
import {
  RemoteCalibrationPrinters,
  projectCalibrationEligibility,
  isExplicitCalibrationEligibilityComplete,
  projectPrintFarmerOrcaProfile,
} from '../src/main/calibrationWire.js';

const PRINTER_GUID = 'aaaaaaaa-1111-4111-8111-222222222222';
const FILAMENT_GUID = 'cccccccc-1111-4111-8111-222222222222';

/**
 * A `CalibrationCandidateDto` for an enabled printer PrintFarmer has never
 * reached: `ObservedAtUtc` and `LastSeenAtUtc` are both `DateTime?` and both
 * absent. This is contract-legal server output.
 */
function neverObservedCandidateDto(overrides: Record<string, unknown> = {}) {
  return {
    id: PRINTER_GUID,
    name: 'Never observed printer',
    enabled: true,
    inMaintenance: false,
    configurationRevision: 1,
    reachability: 'unknown',
    operationalState: 'unknown',
    isStale: false,
    firmware: {
      family: 'Klipper',
      gcodeDialect: 'Klipper',
      detectionSource: 'moonraker',
      version: null,
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

describe('a printer with no observation timestamps', () => {
  it('normalises to a null updatedAt rather than failing to parse', () => {
    const { printers } = RemoteCalibrationPrinters.parse([
      neverObservedCandidateDto(),
    ]);
    expect(printers).toHaveLength(1);
    expect(printers[0]!.updatedAt).toBeNull();
  });

  it('survives the IPC boundary instead of failing the whole list', () => {
    // This is the actual regression: the renderer response is parsed as a
    // unit, so one unparseable candidate threw and discarded every printer —
    // the same empty-discovery symptom this contract fix exists to remove,
    // arriving through a different field.
    const { printers } = RemoteCalibrationPrinters.parse([
      neverObservedCandidateDto(),
      neverObservedCandidateDto({
        id: 'bbbbbbbb-1111-4111-8111-222222222222',
        name: 'Recently seen printer',
        reachability: 'online',
        observedAtUtc: '2026-08-11T12:00:00Z',
      }),
    ]);

    const projected = printers.map((printer) => ({
      printerId: printer.printerId,
      displayName: printer.displayName,
      printerModel: printer.printerModel,
      firmwareCompatible: isExplicitCalibrationEligibilityComplete(printer),
      orcaProfileId: printer.orcaProfileId,
      isOnline: printer.isOnline,
      updatedAt: printer.updatedAt,
      rejectionReasonCodes: [],
      missingInputs: [],
      eligibility: projectCalibrationEligibility(printer),
    }));

    const parsed = projected.map((candidate) =>
      CalibrationPrinterCandidate.parse(candidate),
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.updatedAt).toBeNull();
    expect(parsed[1]!.updatedAt).toBe('2026-08-11T12:00:00.000Z');
  });

  it('still refuses a timestamp that is present but not an instant', () => {
    // Accepting absence must not become accepting nonsense. The candidate is
    // still refused — it is simply refused on its own now, rather than taking
    // the rest of the farm with it, so the assertion is that it does not
    // appear rather than that everything threw.
    const { printers, unreadable } = RemoteCalibrationPrinters.parse([
      neverObservedCandidateDto({ observedAtUtc: 'yesterday' }),
      neverObservedCandidateDto({
        id: 'cccccccc-1111-4111-8111-222222222222',
      }),
    ]);

    expect(printers).toHaveLength(1);
    expect(printers[0]!.printerId).toBe('cccccccc-1111-4111-8111-222222222222');
    expect(unreadable).toBe(1);
  });
});

describe('base profile lookup name resolution', () => {
  it('uses the Orca name for a PrintFarmer profile, never its server GUID', () => {
    // Generation searches local OrcaSlicer files by name. The GUID appears in
    // no such file, so resolving to it always reported the base profile
    // missing for a PrintFarmer-derived selection.
    const name = resolveOrcaBaseProfileLookupName({
      orcaProfileId: FILAMENT_GUID,
      orcaProfileName: 'Generic PLA @0.4 nozzle',
      source: 'printFarmer',
    });
    expect(name).toBe('Generic PLA @0.4 nozzle');
    expect(name).not.toBe(FILAMENT_GUID);
  });

  it('falls back to the id for a locally discovered profile, where they coincide', () => {
    expect(
      resolveOrcaBaseProfileLookupName({
        orcaProfileId: 'Generic PETG @0.4 nozzle',
        source: 'systemInstall',
      }),
    ).toBe('Generic PETG @0.4 nozzle');
  });

  it('refuses to guess for a legacy PrintFarmer profile with no recorded name', () => {
    // A workspace persisted before the split holds only the GUID. Falling back
    // to it would search for a name that cannot exist and blame the user's
    // OrcaSlicer install; returning null lets the caller say what is actually
    // wrong and how to repair it.
    expect(
      resolveOrcaBaseProfileLookupName({
        orcaProfileId: FILAMENT_GUID,
        source: 'printFarmer',
      }),
    ).toBeNull();
  });
});

describe('OrcaProfileEntry carries both identities', () => {
  const base = {
    displayName: 'Generic PLA @0.4 nozzle',
    vendor: null,
    material: 'PLA',
    upstreamVerified: true,
    printerId: PRINTER_GUID,
    configurationRevision: 7,
    snapshotId: 'a'.repeat(64),
    toolId: 'dddddddd-1111-4111-8111-222222222222',
    toolheadId: 'dddddddd-1111-4111-8111-222222222222',
    nozzleId: 'dddddddd-1111-4111-8111-222222222222',
    nozzleDiameterMm: 0.4,
    profileRevision: 'rev-7',
    contentHash: null,
    exportable: false,
  };

  it('keeps a PrintFarmer entry addressable by both id and name', () => {
    const entry = OrcaProfileEntry.parse({
      ...base,
      orcaProfileId: FILAMENT_GUID,
      orcaProfileName: 'Generic PLA @0.4 nozzle',
      source: 'printFarmer',
    });
    expect(entry.orcaProfileId).toBe(FILAMENT_GUID);
    expect(resolveOrcaBaseProfileLookupName(entry)).toBe(
      'Generic PLA @0.4 nozzle',
    );
  });

  it('still accepts an entry persisted before the name existed', () => {
    const entry = OrcaProfileEntry.parse({
      ...base,
      orcaProfileId: 'Generic PLA @0.4 nozzle',
      source: 'systemInstall',
    });
    expect(entry.orcaProfileName).toBeUndefined();
    expect(resolveOrcaBaseProfileLookupName(entry)).toBe(
      'Generic PLA @0.4 nozzle',
    );
  });
});

describe('a value the wire accepts but the renderer contract refuses', () => {
  it('classifies an unrepresentable instant as unreadable, not as readable', () => {
    // `ServerInstant` accepts anything Date.parse finds finite, and an
    // out-of-range instant renders as an ECMAScript expanded year
    // (`+010000-01-01T00:00:00.000Z`). That is a real instant but not one
    // `z.string().datetime()` accepts, so the record used to be classified
    // readable here and then fail the IPC boundary, where the response is one
    // parsed value — emptying the farm while reporting nothing lost.
    for (const instant of [
      '+010000-01-01T00:00:00.000Z',
      '10000-01-01',
      'January 1, 12345',
    ]) {
      const { printers, unreadable } = RemoteCalibrationPrinters.parse([
        neverObservedCandidateDto({ observedAtUtc: instant }),
        neverObservedCandidateDto({
          id: 'dddddddd-1111-4111-8111-222222222222',
        }),
      ]);

      expect(printers, instant).toHaveLength(1);
      expect(printers[0]!.printerId, instant).toBe(
        'dddddddd-1111-4111-8111-222222222222',
      );
      expect(unreadable, instant).toBe(1);
    }
  });

  it('keeps ordinary instants working, so the guard is a bound not a blanket', () => {
    const { printers, unreadable } = RemoteCalibrationPrinters.parse([
      neverObservedCandidateDto({ observedAtUtc: '2026-08-11T12:00:00Z' }),
    ]);

    expect(unreadable).toBe(0);
    expect(printers[0]!.updatedAt).toBe('2026-08-11T12:00:00.000Z');
  });
});

describe('one printer context cannot reject the whole profiles request', () => {
  /**
   * The wire bounds are looser than the renderer contract in places:
   * `profileRevision` and `snapshotSha256` admit `""` upstream but are
   * `.min(1)` on `OrcaProfileEntry`. A bare throwing `.parse` here escaped the
   * per-printer catch in the profiles handler, rejected the `Promise.all` it
   * ran inside, and discarded every other printer's profiles *and* the local
   * OrcaSlicer scan the handler deliberately performs outside the server path.
   */
  function eligibleContext(overrides: Record<string, unknown> = {}) {
    return {
      printerId: PRINTER_GUID,
      displayName: 'Rack A cell 3',
      isCurrent: true,
      configurationRevision: 7,
      snapshotId: 'snapshot-7',
      orcaProfileId: 'orca-base',
      orcaProfileName: 'Generic PLA @0.4 nozzle',
      orcaProfileDisplayName: 'Generic PLA',
      nozzleDiameterMm: 0.4,
      profileRevision: 'rev-1',
      contentHash: null,
      firmwareFamily: 'Klipper',
      gcodeDialect: 'Klipper',
      slicerFamily: 'OrcaSlicer',
      slicerDistribution: 'upstream',
      slicerIdentity: 'OrcaSlicer',
      hardwareContextComplete: true,
      safetyContextComplete: true,
      permissionsComplete: true,
      toolheads: [
        {
          toolId: 'tool-a',
          toolheadId: 'head-a',
          nozzle: { id: 'nozzle-a', diameterMm: 0.4 },
        },
      ],
      ...overrides,
    } as unknown as Parameters<typeof projectPrintFarmerOrcaProfile>[1];
  }

  const eligibleCandidate = {
    printerId: PRINTER_GUID,
    isOnline: true,
    eligibility: {
      firmwareFamily: 'Klipper',
      gcodeDialect: 'Klipper',
      slicerFamily: 'OrcaSlicer',
      slicerDistribution: 'upstream',
      slicerIdentity: 'OrcaSlicer',
      hardwareContextComplete: true,
      safetyContextComplete: true,
      permissionsComplete: true,
      reasons: [],
    },
  } as unknown as Parameters<typeof projectPrintFarmerOrcaProfile>[0];

  it('returns null for a revision the renderer contract refuses, rather than throwing', () => {
    expect(() =>
      projectPrintFarmerOrcaProfile(
        eligibleCandidate,
        eligibleContext({ profileRevision: '' }),
      ),
    ).not.toThrow();
    expect(
      projectPrintFarmerOrcaProfile(
        eligibleCandidate,
        eligibleContext({ profileRevision: '' }),
      ),
    ).toBeNull();
  });

  it('returns null for an empty snapshot id, rather than throwing', () => {
    expect(() =>
      projectPrintFarmerOrcaProfile(
        eligibleCandidate,
        eligibleContext({ snapshotId: '' }),
      ),
    ).not.toThrow();
  });
});
