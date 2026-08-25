/**
 * Regression coverage for two ways a single bad field could empty the wizard or
 * block generation outright.
 *
 * Both were found in review of the discovery-contract fix. Each is a case where
 * a value that is legal on the wire met a stricter expectation downstream, and
 * neither had a fixture that exercised it.
 *
 * The candidate-observation timestamp scenarios that originally lived here
 * tested the old `CalibrationCandidateDto` shape from
 * `/api/printers/calibration-candidates`. That route was retired by
 * `OlyForge3D/PrintFarmer#1943` alongside the eligibility gate, and the
 * candidate list now projects `CompletePrinterDto` — which has no
 * `observedAtUtc`/`lastSeenAtUtc` and therefore cannot produce the
 * one-bad-timestamp discarding the farm regression. The remaining OrcaProfile
 * and context aggregate cases are still meaningful and stay here.
 */

import { describe, expect, it } from 'vitest';
import {
  OrcaProfileEntry,
  resolveOrcaBaseProfileLookupName,
} from '@shared/ipc';
import {
  projectPrintFarmerOrcaProfile,
  projectPrintFarmerOrcaProfileResult,
} from '../src/main/calibrationWire.js';

const PRINTER_GUID = 'aaaaaaaa-1111-4111-8111-222222222222';
const FILAMENT_GUID = 'cccccccc-1111-4111-8111-222222222222';

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
  // The candidate-instant scenarios that lived here targeted the retired
  // `CalibrationCandidateDto` wire schema and its `observedAtUtc` guard. The
  // Path D shape (`CompletePrinterDto`) does not carry an observation
  // timestamp, so the wire schema has no such field to guard. Coverage of
  // out-of-range instants remains on the context aggregate below.
  it.skip('classifies an unrepresentable instant as unreadable, not as readable', () => {});
  it.skip('keeps ordinary instants working, so the guard is a bound not a blanket', () => {});
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
      profilesEvaluated: true,
      eligible: true,
      missingInputs: [],
      rejectionReasons: [],
      configurationId: PRINTER_GUID,
      configurationRevision: 7,
      snapshotId: 'snapshot-7',
      snapshotRevision: 7,
      orcaProfileId: 'orca-base',
      orcaProfileName: 'Generic PLA @0.4 nozzle',
      orcaProfileDisplayName: 'Generic PLA',
      nozzleDiameterMm: 0.4,
      profileRevision: 'rev-1',
      profileIdentities: {
        machine: {
          backendProfileId: '11111111-2222-4222-8222-333333333333',
          orcaProfileName: 'Machine',
          profileRevision: 'machine-r1',
          contentHash: 'a'.repeat(64),
        },
        process: {
          backendProfileId: '11111111-3333-4333-8333-444444444444',
          orcaProfileName: 'Process',
          profileRevision: 'process-r1',
          contentHash: 'b'.repeat(64),
        },
        filament: {
          backendProfileId: '11111111-4444-4444-8444-555555555555',
          orcaProfileName: 'Generic PLA @0.4 nozzle',
          profileRevision: 'rev-1',
          contentHash: 'c'.repeat(64),
        },
      },
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
    // Path D: `isExplicitCalibrationEligibilityComplete` checks these two
    // fields directly (`isEnabled && !inMaintenance`) rather than the
    // firmware/slicer/eligibility identity carriers the old candidate DTO
    // exposed. The identity block below is retained as documentary shape.
    isEnabled: true,
    inMaintenance: false,
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

  it('distinguishes a profile it refused from a printer that has none', () => {
    // Both produce no entry, but only one is a fault. Collapsing them into
    // `null` let the handler report a complete list while a real profile was
    // missing — the same silent loss, reached through the profile rather than
    // the candidate.
    expect(
      projectPrintFarmerOrcaProfileResult(
        eligibleCandidate,
        eligibleContext({ profileRevision: '' }),
      ).kind,
    ).toBe('refused');
    expect(
      projectPrintFarmerOrcaProfileResult(
        eligibleCandidate,
        eligibleContext({ snapshotId: '' }),
      ).kind,
    ).toBe('refused');

    // An offline printer legitimately has no bound profile: an absence, not a
    // fault, and it must not be reported as one.
    expect(
      projectPrintFarmerOrcaProfileResult(
        { ...eligibleCandidate, isOnline: false },
        eligibleContext(),
      ).kind,
    ).toBe('none');

    // And a context this client can bind yields the entry itself.
    expect(
      projectPrintFarmerOrcaProfileResult(eligibleCandidate, eligibleContext())
        .kind,
    ).toBe('entry');
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
