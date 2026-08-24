/**
 * Verbatim `CalibrationCandidateDto` and `CalibrationContextDto` shapes, as
 * PrintFarmer serialises them.
 *
 * Source: `CalibrationContracts.cs` and `PrinterCalibrationContextService.cs` on
 * OlyForge3D/PrintFarmer@development.
 *
 * Extracted so that tests exercising the *action* paths — generation, print
 * start, bed-clear — can drive the same real DTOs the discovery tests use.
 * Those paths now read the authoritative context before dispatching, so a test
 * that cannot serve a real context cannot exercise them honestly.
 *
 * Note what is deliberately absent: there is no `safety` member and no
 * `permissions` member, because the real DTO has neither. Discovery and profile
 * resolution must work against this shape exactly as written; anything that
 * requires those members is requiring something no server sends.
 *
 * ⚠️ PROVENANCE CLAIM IS UNENFORCED — 2026-08-21 (Hicks / test-gap audit)
 * ----------------------------------------------------------------------
 * Nothing in this repository verifies that the shapes below still match the
 * live PrintFarmer server. There is no drift check. Every test that imports
 * from here is effectively self-referential: it asserts the desktop matches
 * a shape the desktop itself defined and calls that "server parity."
 *
 * For enforced, drift-checked server contract snapshots — the ones you should
 * reach for when writing a new test — see
 * `tests/fixtures/server-contract/README.md`, which pins the exact commit and
 * blob SHAs of the C# source-of-truth and runs a diff against them at test
 * time when the sibling `D:\s\pfarm1` checkout is available.
 *
 * Do not read the header above as evidence of currency: it is a comment, not
 * a guarantee.
 */

export const CALIBRATION_FIXTURE_IDS = {
  profileId: '11111111-1111-4111-8111-111111111111',
  printerId: 'aaaaaaaa-1111-4111-8111-222222222222',
  otherPrinterId: 'bbbbbbbb-1111-4111-8111-222222222222',
  machineProfileId: 'bbbbbbbb-2222-4222-8222-333333333333',
  processProfileId: 'bbbbbbbb-3333-4333-8333-444444444444',
  filamentProfileId: 'cccccccc-1111-4111-8111-222222222222',
  toolheadId: 'dddddddd-1111-4111-8111-222222222222',
  snapshotSha: 'a'.repeat(64),
  now: '2026-07-26T15:00:00.000Z',
  configurationRevision: 7,
} as const;

/** A `CalibrationCandidateDto` shaped exactly as PrintFarmer serialises it. */
export function calibrationCandidateDto(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: CALIBRATION_FIXTURE_IDS.printerId,
    name: 'Voron 2.4 in bay three',
    enabled: true,
    inMaintenance: false,
    backend: 'Moonraker',
    configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    reachability: 'online',
    operationalState: 'idle',
    statusSource: 'moonraker',
    observedAtUtc: CALIBRATION_FIXTURE_IDS.now,
    lastSeenAtUtc: CALIBRATION_FIXTURE_IDS.now,
    isStale: false,
    toolheads: [],
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
    // Candidate listing is a basic screen and must not resolve profiles.
    profilesEvaluated: false,
    missingInputs: [],
    rejectionReasons: [],
    ...overrides,
  };
}

/** A `CalibrationContextDto`: a candidate plus the nested snapshot. */
export function calibrationContextDto(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { snapshot: snapshotOverride, ...rest } = overrides;
  return {
    ...calibrationCandidateDto(),
    // The selected context is the server's authoritative verdict: it resolved
    // profiles, so profilesEvaluated is true. The candidate list never is.
    profilesEvaluated: true,
    schemaVersion: '1.0',
    snapshotSha256: CALIBRATION_FIXTURE_IDS.snapshotSha,
    capturedAtUtc: CALIBRATION_FIXTURE_IDS.now,
    capturedBySubject: 'subject-1',
    supportsPressureAdvance: true,
    supportsFirmwareRetraction: true,
    snapshot: {
      schemaVersion: '1.0',
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
      configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
      capturedAtUtc: CALIBRATION_FIXTURE_IDS.now,
      buildVolume: { x: 220, y: 220, z: 250 },
      bedOrigin: { x: 0, y: 0 },
      toolheads: [
        {
          id: CALIBRATION_FIXTURE_IDS.toolheadId,
          index: 0,
          name: 'T0',
          isPrimary: true,
          nozzleDiameter: 0.4,
          nozzleType: 'brass',
          nozzleMaterial: 'brass',
          isDirectDrive: true,
          maxVolumetricFlow: 30,
          maxHotendTemperature: 300,
        },
      ],
      maxBedTemperature: 120,
      hasHeatedBed: true,
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
      profiles: {
        machine: {
          id: CALIBRATION_FIXTURE_IDS.machineProfileId,
          kind: 'machine',
          name: 'Voron 2.4 0.4 nozzle',
          slicerType: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerVersion: '2.4.2',
          profileFormat: 'orca-json',
          profileRevision: 'machine-r7',
          sha256: 'b'.repeat(64),
        },
        process: {
          id: CALIBRATION_FIXTURE_IDS.processProfileId,
          kind: 'process',
          name: '0.20 mm Standard',
          slicerType: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerVersion: '2.4.2',
          profileFormat: 'orca-json',
          profileRevision: 'process-r7',
          sha256: 'c'.repeat(64),
        },
        filament: {
          id: CALIBRATION_FIXTURE_IDS.filamentProfileId,
          kind: 'filament',
          name: 'Upstream PLA',
          slicerType: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerVersion: '2.4.2',
          profileFormat: 'orca-json',
          profileRevision: 'profile-r7',
          sha256: 'd'.repeat(64),
        },
      },
      baselineSettings: { activeNozzleDiameter: 0.4 },
      snapshotSha256: CALIBRATION_FIXTURE_IDS.snapshotSha,
      ...(typeof snapshotOverride === 'object' && snapshotOverride !== null
        ? snapshotOverride
        : {}),
    },
    ...rest,
  };
}

/**
 * The binding a gated action must present, matching {@link
 * calibrationContextDto} exactly.
 */
export function calibrationActionBindingFixture(
  overrides: Partial<{
    printerId: string;
    configurationRevision: number | null;
    snapshotId: string | null;
    toolId: string | null;
  }> = {},
): {
  printerId: string;
  configurationRevision: number | null;
  snapshotId: string | null;
  toolId: string | null;
} {
  return {
    printerId: CALIBRATION_FIXTURE_IDS.printerId,
    configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    snapshotId: CALIBRATION_FIXTURE_IDS.snapshotSha,
    toolId: CALIBRATION_FIXTURE_IDS.toolheadId,
    ...overrides,
  };
}
