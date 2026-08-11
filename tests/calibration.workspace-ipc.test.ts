import { describe, expect, it } from 'vitest';

import {
  CalibrationPrinterCandidate,
  CalibrationSaveWorkspaceStateRequest,
  CalibrationWorkspacePayload,
  deriveCalibrationWorkspaceProjection,
  type CalibrationWorkspacePayload as CalibrationWorkspacePayloadType,
} from '@shared/ipc';
import {
  isExplicitCalibrationContextComplete,
  isExplicitCalibrationEligibilityComplete,
  prepareCalibrationWorkspaceSave,
  projectCalibrationEligibility,
  projectCalibrationPrinterContext,
  projectPrintFarmerOrcaProfile,
  RemoteCalibrationProject,
  RemoteCalibrationPrinterCandidate,
  RemoteCalibrationPrinterContext,
} from '../src/main/calibrationWire.js';
import { evaluateCalibrationActionGate } from '../src/main/calibrationActionGate.js';
import { resolveCalibrationWorkspaceFreshness } from '../src/main/calibrationFreshness.js';
import { CalibrationHttpError } from '../src/main/calibrationHttp.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const OBSERVATION_ID = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-07-26T15:00:00.000Z';
// Identities shaped like the server's: PrintFarmer keys printers, toolheads and
// profiles by Guid, and identifies a snapshot by its content hash.
const PRINTER_GUID = 'aaaaaaaa-1111-4111-8111-222222222222';
const OTHER_PRINTER_GUID = 'bbbbbbbb-1111-4111-8111-222222222222';
const FILAMENT_PROFILE_GUID = 'cccccccc-1111-4111-8111-222222222222';
const TOOLHEAD_GUID = 'dddddddd-1111-4111-8111-222222222222';
const SNAPSHOT_SHA = 'a'.repeat(64);
const STAGE_IDS = [
  'temperature',
  'flowPass1',
  'flowPass2',
  'pressureAdvance',
  'flowVerification',
  'retraction',
  'maximumVolumetricSpeed',
  'shrinkage',
  'finalVerification',
] as const;

function blankWorkflowDraft() {
  return {
    method: null,
    observation: {
      primary: '',
      quality: '',
      notes: '',
      passed: false,
      nominalXmm: '',
      nominalYmm: '',
      nominalZmm: '',
      measuredXmm: '',
      measuredYmm: '',
      measuredZmm: '',
    },
    confidence: null,
    reason: '',
    photoAttemptId: null,
    photoCaption: '',
    photoOrder: 1,
  };
}

function validWorkspace(): CalibrationWorkspacePayloadType {
  const stages = Object.fromEntries(
    STAGE_IDS.map((stageId) => [
      stageId,
      { stageId, status: 'notStarted', attemptIds: [] },
    ]),
  );
  const workflowDrafts = Object.fromEntries(
    STAGE_IDS.map((stageId) => [stageId, blankWorkflowDraft()]),
  );
  const snapshot = {
    snapshotId: SNAPSHOT_SHA,
    snapshotRevision: 7,
    capturedAt: NOW,
    configurationRevision: 7,
    toolheads: [
      {
        toolId: TOOLHEAD_GUID,
        toolheadId: TOOLHEAD_GUID,
        nozzle: {
          nozzleId: TOOLHEAD_GUID,
          diameterMm: 0.4,
          material: 'brass',
        },
        extruderType: 'directDrive',
      },
    ],
    safety: {
      buildVolumeMm: { x: 220, y: 220, z: 250 },
      maximumNozzleTemperatureC: 300,
      maximumBedTemperatureC: 120,
      maximumVolumetricRateMm3S: 30,
      emergencyStopAvailable: true,
      thermalProtectionConfirmed: true,
      ventilationAssessed: true,
    },
  };
  return CalibrationWorkspacePayload.parse({
    schemaVersion: 1,
    domainState: {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      createdAt: NOW,
      mode: 'coach',
      baseline: {
        nozzleTemperatureC: 210,
        flowRatio: 1,
        pressureAdvance: 0.04,
        retractionLengthMm: 0.7,
        maximumVolumetricRateMm3S: 20,
        shrinkageCompensationXPercent: 0,
        shrinkageCompensationYPercent: 0,
        shrinkageCompensationZPercent: 0,
      },
      binding: {
        printer: {
          backendProfileId: PROFILE_ID,
          backendPrinterId: PRINTER_GUID,
          printerConfigurationId: PRINTER_GUID,
          printerConfigurationRevision: 7,
        },
        snapshot,
        selectedToolId: TOOLHEAD_GUID,
        selectedToolheadId: TOOLHEAD_GUID,
        selectedNozzleId: TOOLHEAD_GUID,
        filament: {
          filamentProjectId: 'filament-1',
          provider: 'PrintFarmer',
          product: 'PLA',
          sku: 'PLA-BLACK',
          spoolId: 'spool-1',
        },
      },
      snapshotHistory: [snapshot],
      currentStageId: 'temperature',
      stages,
      attempts: [],
      history: [],
      diagnostics: [],
    },
    metadata: { displayName: 'PLA calibration', description: '' },
    stepDrafts: {},
    workflowDrafts,
    photos: [],
    physicalMatch: null,
    selectedBaseProfile: {
      orcaProfileId: FILAMENT_PROFILE_GUID,
      displayName: 'Upstream PLA',
      source: 'printFarmer',
      upstreamVerified: true,
      printerId: PRINTER_GUID,
      configurationRevision: 7,
      snapshotId: SNAPSHOT_SHA,
      toolId: TOOLHEAD_GUID,
      toolheadId: TOOLHEAD_GUID,
      nozzleId: TOOLHEAD_GUID,
      nozzleDiameterMm: 0.4,
      profileRevision: 'profile-r7',
      contentHash: null,
    },
    selectedBaseProfileId: FILAMENT_PROFILE_GUID,
    autosaveRevision: 0,
  });
}

function completedTemperatureAttempt(
  workspace: CalibrationWorkspacePayloadType,
) {
  const binding = workspace.domainState.binding;
  return {
    attemptId: ATTEMPT_ID,
    stageId: 'temperature' as const,
    method: 'temperatureTower' as const,
    scope: {
      backendProfileId: binding.printer.backendProfileId,
      backendPrinterId: binding.printer.backendPrinterId,
      printerConfigurationId: binding.printer.printerConfigurationId,
      printerConfigurationRevision:
        binding.printer.printerConfigurationRevision,
      snapshotId: binding.snapshot.snapshotId,
      snapshotRevision: binding.snapshot.snapshotRevision,
      toolId: binding.selectedToolId,
      toolheadId: binding.selectedToolheadId,
      nozzleId: binding.selectedNozzleId,
      filamentProjectId: binding.filament.filamentProjectId,
      filamentProvider: binding.filament.provider,
      filamentProduct: binding.filament.product,
      filamentSku: binding.filament.sku,
      spoolId: binding.filament.spoolId,
    },
    ordinal: 1,
    status: 'completed' as const,
    startedAt: NOW,
    completedAt: NOW,
    selectedObservationId: OBSERVATION_ID,
    confidence: 'high' as const,
    recommendation: {
      summary: 'Use 210 C',
      rationale: 'Best surface quality',
      values: [],
    },
    diagnostics: [],
    observations: [
      {
        observationId: OBSERVATION_ID,
        attemptId: ATTEMPT_ID,
        stageId: 'temperature' as const,
        observedAt: NOW,
        notes: 'clean',
        temperatureC: 210,
        quality: 95,
      },
    ],
  };
}

function workspaceWithCompletedAttempt(): CalibrationWorkspacePayloadType {
  const workspace = validWorkspace();
  workspace.domainState.attempts.push(completedTemperatureAttempt(workspace));
  workspace.domainState.stages.temperature = {
    stageId: 'temperature',
    status: 'completed',
    attemptIds: [ATTEMPT_ID],
    selectedAttemptId: ATTEMPT_ID,
  };
  return CalibrationWorkspacePayload.parse(workspace);
}

function request(workspace = validWorkspace()) {
  const projection = deriveCalibrationWorkspaceProjection(
    workspace.domainState,
  );
  return CalibrationSaveWorkspaceStateRequest.parse({
    profileId: PROFILE_ID,
    projectId: PROJECT_ID,
    displayName: workspace.metadata.displayName,
    description: workspace.metadata.description || null,
    printerId: PRINTER_GUID,
    status: projection.status,
    completedStepCount: projection.completedStepCount,
    totalStepCount: projection.totalStepCount,
    baseRevision: null,
    operationId: OPERATION_ID,
    workspaceState: workspace,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('calibration workspace IPC', () => {
  it('persists all nine exact workflow drafts without schema defaults', () => {
    const workspace = validWorkspace();
    workspace.workflowDrafts.temperature.observation.notes = 'keep exactly';
    workspace.workflowDrafts.temperature.photoCaption = 'tower';

    const parsed = CalibrationWorkspacePayload.parse(workspace);

    expect(Object.keys(parsed.workflowDrafts)).toEqual(STAGE_IDS);
    expect(parsed.workflowDrafts.temperature.observation.notes).toBe(
      'keep exactly',
    );
    const missing = structuredClone(workspace);
    delete (missing.workflowDrafts as Partial<typeof missing.workflowDrafts>)
      .temperature;
    expect(() => CalibrationWorkspacePayload.parse(missing)).toThrow();
  });

  it('keeps oversized and legacy remote workspaces recoverable but unhydrated', () => {
    const oversized = validWorkspace();
    oversized.domainState.diagnostics = Array.from(
      { length: 140 },
      (_, index) => ({
        code: `oversized-${index}`,
        severity: 'warning',
        message: 'x'.repeat(4_096),
      }),
    );
    expect(
      Buffer.byteLength(JSON.stringify(oversized), 'utf8'),
    ).toBeGreaterThan(512 * 1_024);
    const remoteProject = {
      id: PROJECT_ID,
      displayName: 'Remote calibration',
      description: null,
      status: 'draft',
      printerId: PRINTER_GUID,
      revision: 1,
      concurrencyToken: 'revision-1',
      createdAt: NOW,
      updatedAt: NOW,
    };

    expect(
      RemoteCalibrationProject.parse({
        ...remoteProject,
        workspaceState: oversized,
      }).workspaceState,
    ).toBeNull();
    expect(
      RemoteCalibrationProject.parse({
        ...remoteProject,
        workspaceState: { legacyVersion: 4 },
      }).workspaceState,
    ).toBeNull();
  });

  it('computes a canonical idempotency key and native freshness input', () => {
    const first = request();
    const reordered = request();
    const baseline = reordered.workspaceState.domainState.baseline;
    reordered.workspaceState.domainState.baseline = {
      flowRatio: baseline.flowRatio,
      pressureAdvance: baseline.pressureAdvance,
      nozzleTemperatureC: baseline.nozzleTemperatureC,
      maximumVolumetricRateMm3S: baseline.maximumVolumetricRateMm3S,
      retractionLengthMm: baseline.retractionLengthMm,
      shrinkageCompensationZPercent: baseline.shrinkageCompensationZPercent,
      shrinkageCompensationYPercent: baseline.shrinkageCompensationYPercent,
      shrinkageCompensationXPercent: baseline.shrinkageCompensationXPercent,
    };

    const firstSave = prepareCalibrationWorkspaceSave(first, PROFILE_ID, true);
    const secondSave = prepareCalibrationWorkspaceSave(
      reordered,
      PROFILE_ID,
      true,
    );
    expect(firstSave.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secondSave.idempotencyKey).toBe(firstSave.idempotencyKey);
    expect(firstSave.printerContextFresh).toBe(true);
  });

  it('fences request, domain profile, project, and printer identities', () => {
    expect(() =>
      prepareCalibrationWorkspaceSave(
        request(),
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        false,
      ),
    ).toThrow(/selected profile/i);

    for (const mutate of [
      (workspace: CalibrationWorkspacePayloadType) => {
        workspace.domainState.projectId =
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      },
      (workspace: CalibrationWorkspacePayloadType) => {
        workspace.domainState.binding.printer.backendProfileId =
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      },
      (workspace: CalibrationWorkspacePayloadType) => {
        workspace.domainState.binding.printer.backendPrinterId = 'other';
      },
    ]) {
      const workspace = validWorkspace();
      mutate(workspace);
      expect(() =>
        CalibrationSaveWorkspaceStateRequest.parse({
          ...request(),
          workspaceState: workspace,
        }),
      ).toThrow();
    }
  });

  it('rejects forged progress counts and status', () => {
    const completed = request(workspaceWithCompletedAttempt());
    expect(completed.completedStepCount).toBe(1);
    expect(completed.status).toBe('inProgress');
    expect(() =>
      CalibrationSaveWorkspaceStateRequest.parse({
        ...completed,
        completedStepCount: 0,
      }),
    ).toThrow(/derived/);
    expect(() =>
      CalibrationSaveWorkspaceStateRequest.parse({
        ...completed,
        status: 'draft',
      }),
    ).toThrow(/derived/);
  });

  it('requires exactly nine matching stage records', () => {
    const workspace = validWorkspace();
    expect(() =>
      CalibrationWorkspacePayload.parse({
        ...workspace,
        domainState: {
          ...workspace.domainState,
          stages: {
            ...workspace.domainState.stages,
            rogue: {
              stageId: 'temperature',
              status: 'notStarted',
              attemptIds: [],
            },
          },
        },
      }),
    ).toThrow();
    const mismatched = validWorkspace();
    mismatched.domainState.stages.temperature.stageId = 'flowPass1';
    expect(() => CalibrationWorkspacePayload.parse(mismatched)).toThrow(
      /Stage key/,
    );
  });

  it('requires unique attempts, observations, events, and exact stage links', () => {
    const duplicateAttempt = workspaceWithCompletedAttempt();
    duplicateAttempt.domainState.attempts.push(
      structuredClone(duplicateAttempt.domainState.attempts[0]!),
    );
    expect(() => CalibrationWorkspacePayload.parse(duplicateAttempt)).toThrow(
      /Attempt identities/,
    );

    const badStageLinks = workspaceWithCompletedAttempt();
    badStageLinks.domainState.stages.temperature.attemptIds.push(ATTEMPT_ID);
    expect(() => CalibrationWorkspacePayload.parse(badStageLinks)).toThrow(
      /exact and unique/,
    );

    const badObservation = workspaceWithCompletedAttempt();
    badObservation.domainState.attempts[0]!.observations[0]!.attemptId =
      'other-attempt';
    expect(() => CalibrationWorkspacePayload.parse(badObservation)).toThrow(
      /Observation identity/,
    );

    const duplicateEvents = validWorkspace();
    duplicateEvents.domainState.history.push(
      {
        eventId: 'event-1',
        timestamp: NOW,
        type: 'navigate',
        stageId: 'temperature',
      },
      {
        eventId: 'event-1',
        timestamp: NOW,
        type: 'navigate',
        stageId: 'flowPass1',
      },
    );
    expect(() => CalibrationWorkspacePayload.parse(duplicateEvents)).toThrow(
      /Event identities/,
    );
  });

  it('requires selected and completed stage state to agree', () => {
    const missingSelection = workspaceWithCompletedAttempt();
    delete missingSelection.domainState.stages.temperature.selectedAttemptId;
    expect(() => CalibrationWorkspacePayload.parse(missingSelection)).toThrow(
      /Completed stages require/,
    );

    const activeSelection = workspaceWithCompletedAttempt();
    activeSelection.domainState.attempts[0]!.status = 'inProgress';
    delete activeSelection.domainState.attempts[0]!.completedAt;
    delete activeSelection.domainState.attempts[0]!.confidence;
    delete activeSelection.domainState.attempts[0]!.recommendation;
    expect(() => CalibrationWorkspacePayload.parse(activeSelection)).toThrow(
      /Selected attempt must be a completed/,
    );
  });

  it('validates history references and physical/base-profile scope', () => {
    const history = validWorkspace();
    history.domainState.history.push({
      eventId: 'event-1',
      timestamp: NOW,
      type: 'completeAttempt',
      attemptId: ATTEMPT_ID,
      confidence: 'high',
    });
    expect(() => CalibrationWorkspacePayload.parse(history)).toThrow(
      /History attempt reference/,
    );

    const physical = validWorkspace();
    physical.physicalMatch = {
      snapshotId: 'wrong',
      toolId: TOOLHEAD_GUID,
      toolheadId: TOOLHEAD_GUID,
      nozzleId: TOOLHEAD_GUID,
      nozzleDiameterMm: 0.4,
      confirmedAt: NOW,
    };
    expect(() => CalibrationWorkspacePayload.parse(physical)).toThrow(
      /Physical match/,
    );

    const profile = validWorkspace();
    profile.selectedBaseProfile.nozzleId = 'wrong';
    expect(() => CalibrationWorkspacePayload.parse(profile)).toThrow(
      /Selected base profile/,
    );

    const snapshot = validWorkspace();
    snapshot.domainState.binding.snapshot.safety.maximumBedTemperatureC += 1;
    expect(() => CalibrationWorkspacePayload.parse(snapshot)).toThrow(
      /latest snapshot/,
    );
  });

  it('requires photo and workflow drafts to reference attempts in their stage', () => {
    const workspace = workspaceWithCompletedAttempt();
    workspace.workflowDrafts.flowPass1.photoAttemptId = ATTEMPT_ID;
    expect(() => CalibrationWorkspacePayload.parse(workspace)).toThrow(
      /Photo draft attempt/,
    );
  });

  it('keeps the 512 KiB native-boundary cap', () => {
    const oversized = validWorkspace();
    oversized.domainState.diagnostics = Array.from(
      { length: 130 },
      (_, index) => ({
        code: `diagnostic-${index}`,
        severity: 'warning' as const,
        message: 'x'.repeat(4_096),
      }),
    );
    const oversizedRequest = request(
      CalibrationWorkspacePayload.parse(oversized),
    );
    expect(() =>
      prepareCalibrationWorkspaceSave(oversizedRequest, PROFILE_ID, false),
    ).toThrow(/512 KiB/i);
  });

  it('rejects renderer hash, path, URL, and credential injection', () => {
    for (const [key, value] of Object.entries({
      idempotencyKey: 'a'.repeat(64),
      path: 'C:\\private\\photo.png',
      url: 'https://attacker.invalid',
      credentials: { token: 'secret' },
    })) {
      expect(() =>
        CalibrationSaveWorkspaceStateRequest.parse({
          ...request(),
          [key]: value,
        }),
      ).toThrow();
    }
  });
});

describe('explicit printer eligibility', () => {
  it('maps incomplete and unknown remote assertions to null', () => {
    // A printer the server explicitly refuses.
    const refused = RemoteCalibrationPrinterCandidate.parse(
      candidateDto({
        eligible: false,
        rejectionReasons: [
          {
            code: 'firmware_family_not_klipper',
            field: 'firmware.family',
            message: 'Firmware family is not Klipper.',
          },
        ],
      }),
    );
    expect(projectCalibrationEligibility(refused)).toBeNull();
    expect(isExplicitCalibrationEligibilityComplete(refused)).toBe(false);

    // Firmware identity the server could not determine.
    const incomplete = RemoteCalibrationPrinterCandidate.parse(
      candidateDto({
        firmware: {
          family: 'Unknown',
          gcodeDialect: 'Unknown',
          detectionSource: 'unknown',
          version: null,
          verified: false,
        },
      }),
    );
    expect(projectCalibrationEligibility(incomplete)).toBeNull();
    expect(isExplicitCalibrationEligibilityComplete(incomplete)).toBe(false);

    // A slicer distribution outside the upstream allow-list.
    const fork = RemoteCalibrationPrinterCandidate.parse(
      candidateDto({
        slicer: {
          engine: 'OrcaSlicer',
          distribution: 'vendorFork',
          version: '2.4.2',
          profileFormat: 'orca-json',
        },
      }),
    );
    expect(projectCalibrationEligibility(fork)).toBeNull();
    expect(isExplicitCalibrationEligibilityComplete(fork)).toBe(false);
  });

  it('accepts only the five canonical literals independent of names', () => {
    const remote = RemoteCalibrationPrinterCandidate.parse(
      candidateDto({
        name: 'No Klipper hint',
        futureRemoteField: 'ignored',
      }),
    );
    const eligibility = projectCalibrationEligibility(remote);
    const parsed = CalibrationPrinterCandidate.parse({
      printerId: remote.printerId,
      displayName: remote.displayName,
      printerModel: null,
      firmwareCompatible: true,
      orcaProfileId: null,
      isOnline: true,
      updatedAt: NOW,
      eligibility,
    });
    expect(parsed.eligibility).toEqual({
      firmwareFamily: 'Klipper',
      gcodeDialect: 'Klipper',
      slicerFamily: 'OrcaSlicer',
      slicerDistribution: 'upstream',
      slicerIdentity: 'OrcaSlicer',
      hardwareContextComplete: true,
      safetyContextComplete: true,
      permissionsComplete: true,
      reasons: [],
    });
    expect(isExplicitCalibrationEligibilityComplete(remote)).toBe(true);
  });

  it('never grants eligibility the server withheld, whatever the name says', () => {
    // Every identity field reads as compatible, but PrintFarmer's own verdict
    // is false. The client must follow the server, not re-derive a verdict.
    const misleading = RemoteCalibrationPrinterCandidate.parse(
      candidateDto({
        name: 'Klipper OrcaSlicer upstream',
        eligible: false,
      }),
    );
    expect(projectCalibrationEligibility(misleading)).toBeNull();
  });
});

/**
 * A `CalibrationCandidateDto` shaped exactly as PrintFarmer serialises it.
 * Source: `CalibrationContracts.cs` on OlyForge3D/PrintFarmer@development.
 */
function candidateDto(overrides: Record<string, unknown> = {}) {
  return {
    id: PRINTER_GUID,
    name: 'Any arbitrary printer name',
    enabled: true,
    inMaintenance: false,
    backend: 'Moonraker',
    configurationRevision: 7,
    reachability: 'online',
    operationalState: 'idle',
    statusSource: 'moonraker',
    observedAtUtc: NOW,
    lastSeenAtUtc: NOW,
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
    missingInputs: [],
    rejectionReasons: [],
    ...overrides,
  };
}

/** A `CalibrationContextDto`, i.e. a candidate plus the nested snapshot. */
function contextDto(overrides: Record<string, unknown> = {}) {
  const { snapshot: snapshotOverride, ...rest } = overrides;
  return {
    ...candidateDto(),
    schemaVersion: '1.0',
    snapshotSha256: SNAPSHOT_SHA,
    capturedAtUtc: NOW,
    capturedBySubject: 'subject-1',
    supportsPressureAdvance: true,
    supportsFirmwareRetraction: true,
    snapshot: {
      schemaVersion: '1.0',
      printerId: PRINTER_GUID,
      configurationRevision: 7,
      capturedAtUtc: NOW,
      buildVolume: { x: 220, y: 220, z: 250 },
      bedOrigin: { x: 0, y: 0 },
      toolheads: [
        {
          id: TOOLHEAD_GUID,
          index: 0,
          name: 'T0',
          isPrimary: true,
          nozzleDiameter: 0.4,
          nozzleType: 'brass',
          nozzleMaterial: 'brass',
          isDirectDrive: true,
          maxVolumetricFlow: 30,
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
        machine: null,
        process: null,
        filament: {
          id: FILAMENT_PROFILE_GUID,
          kind: 'filament',
          name: 'Upstream PLA',
          slicerType: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerVersion: '2.4.2',
          profileFormat: 'orca-json',
          profileRevision: 'profile-r7',
          sha256: null,
        },
      },
      baselineSettings: { activeNozzleDiameter: 0.4 },
      snapshotSha256: SNAPSHOT_SHA,
      ...(typeof snapshotOverride === 'object' && snapshotOverride !== null
        ? snapshotOverride
        : {}),
    },
    ...rest,
  };
}

function remoteCandidate(overrides: Record<string, unknown> = {}) {
  return RemoteCalibrationPrinterCandidate.parse(candidateDto(overrides));
}

describe('explicit printer context', () => {
  it('blocks missing and non-upstream identities', () => {
    // A filament profile with no revision cannot be pinned.
    const missing = RemoteCalibrationPrinterContext.parse(
      contextDto({
        snapshot: {
          profiles: {
            machine: null,
            process: null,
            filament: {
              id: FILAMENT_PROFILE_GUID,
              kind: 'filament',
              name: 'Upstream PLA',
              slicerType: 'OrcaSlicer',
              slicerDistribution: 'upstream',
              slicerVersion: '2.4.2',
              profileFormat: 'orca-json',
              profileRevision: null,
              sha256: null,
            },
          },
        },
      }),
    );
    expect(isExplicitCalibrationContextComplete(missing)).toBe(false);

    const fork = RemoteCalibrationPrinterContext.parse(
      contextDto({
        slicer: {
          engine: 'OrcaSlicer',
          distribution: 'vendorFork',
          version: '2.4.2',
          profileFormat: 'orca-json',
        },
      }),
    );
    expect(isExplicitCalibrationContextComplete(fork)).toBe(false);
    expect(
      projectCalibrationPrinterContext(fork).slicerDistribution,
    ).toBeNull();
  });

  it('projects only strict known IPC fields from a complete remote context', () => {
    const context = RemoteCalibrationPrinterContext.parse(
      contextDto({ futureRemoteField: { secret: 'not projected' } }),
    );
    expect(isExplicitCalibrationContextComplete(context)).toBe(true);
    const projected = projectCalibrationPrinterContext(context);
    expect(projected.isCurrent).toBe(true);
    expect(projected).not.toHaveProperty('futureRemoteField');
  });
});

describe('printer-context freshness policy', () => {
  it('retains existing freshness offline and denies new offline creation', async () => {
    const offline = new CalibrationHttpError('transport', 'offline');
    await expect(
      resolveCalibrationWorkspaceFreshness(
        request(),
        {
          isPrinterContextFresh: true,
          workspaceState: validWorkspace(),
        },
        () => Promise.reject(offline),
      ),
    ).resolves.toBe(true);
    await expect(
      resolveCalibrationWorkspaceFreshness(
        request(),
        {
          isPrinterContextFresh: false,
          workspaceState: validWorkspace(),
        },
        () => Promise.reject(offline),
      ),
    ).resolves.toBe(false);
    await expect(
      resolveCalibrationWorkspaceFreshness(request(), null, () =>
        Promise.reject(offline),
      ),
    ).rejects.toMatchObject({ code: 'CALIBRATION_OFFLINE_CREATE_DENIED' });

    const changedBinding = request();
    changedBinding.workspaceState.domainState.binding.filament.product =
      'forged offline product';
    await expect(
      resolveCalibrationWorkspaceFreshness(
        changedBinding,
        {
          isPrinterContextFresh: true,
          workspaceState: validWorkspace(),
        },
        () => Promise.reject(offline),
      ),
    ).rejects.toMatchObject({
      code: 'CALIBRATION_OFFLINE_CONTEXT_CHANGE_DENIED',
    });
  });

  it('marks authoritative mismatches stale and exact rebases fresh', async () => {
    const exact = RemoteCalibrationPrinterContext.parse(contextDto());
    const mismatch = RemoteCalibrationPrinterContext.parse(
      contextDto({ snapshotSha256: 'b'.repeat(64) }),
    );
    await expect(
      resolveCalibrationWorkspaceFreshness(
        request(),
        {
          isPrinterContextFresh: true,
          workspaceState: validWorkspace(),
        },
        () => Promise.resolve(mismatch),
      ),
    ).resolves.toBe(false);
    await expect(
      resolveCalibrationWorkspaceFreshness(request(), null, () =>
        Promise.resolve(mismatch),
      ),
    ).rejects.toMatchObject({
      code: 'CALIBRATION_PRINTER_CONTEXT_MISMATCH',
    });
    await expect(
      resolveCalibrationWorkspaceFreshness(request(), null, () =>
        Promise.resolve(exact),
      ),
    ).resolves.toBe(true);
  });
});

describe('PrintFarmer Orca profile discovery projection', () => {
  it('projects a complete eligible current context without remote extras', () => {
    const completeCandidate = remoteCandidate({
      name: 'Unrelated candidate name',
      futureRemoteField: 'must not leak',
    });
    const completeContext = RemoteCalibrationPrinterContext.parse(
      contextDto({ futureRemoteField: 'must not leak' }),
    );

    expect(
      projectPrintFarmerOrcaProfile(completeCandidate, completeContext),
    ).toEqual({
      // The immutable server identity, not the display name.
      orcaProfileId: FILAMENT_PROFILE_GUID,
      // The OrcaSlicer-facing name, carried separately so local file lookup
      // has something it can actually match.
      orcaProfileName: 'Upstream PLA',
      displayName: 'Upstream PLA',
      vendor: null,
      material: null,
      source: 'printFarmer',
      upstreamVerified: true,
      printerId: PRINTER_GUID,
      configurationRevision: 7,
      snapshotId: SNAPSHOT_SHA,
      toolId: TOOLHEAD_GUID,
      toolheadId: TOOLHEAD_GUID,
      nozzleId: TOOLHEAD_GUID,
      nozzleDiameterMm: 0.4,
      profileRevision: 'profile-r7',
      contentHash: null,
      exportable: false,
    });
  });

  it('omits incomplete or ineligible contexts regardless of names', () => {
    // Reads as fully compatible; the server's verdict says otherwise.
    const misleadingName = remoteCandidate({
      name: 'Klipper OrcaSlicer upstream',
      eligible: false,
    });
    const missingRevision = RemoteCalibrationPrinterContext.parse(
      contextDto({
        snapshot: {
          profiles: {
            machine: null,
            process: null,
            filament: {
              id: FILAMENT_PROFILE_GUID,
              kind: 'filament',
              name: 'Upstream PLA',
              slicerType: 'OrcaSlicer',
              slicerDistribution: 'upstream',
              slicerVersion: '2.4.2',
              profileFormat: 'orca-json',
              profileRevision: null,
              sha256: null,
            },
          },
        },
      }),
    );
    const wrongPrinter = RemoteCalibrationPrinterContext.parse(
      contextDto({ id: OTHER_PRINTER_GUID }),
    );

    expect(
      projectPrintFarmerOrcaProfile(
        misleadingName,
        RemoteCalibrationPrinterContext.parse(contextDto()),
      ),
    ).toBeNull();
    expect(
      projectPrintFarmerOrcaProfile(remoteCandidate(), missingRevision),
    ).toBeNull();
    expect(
      projectPrintFarmerOrcaProfile(remoteCandidate(), wrongPrinter),
    ).toBeNull();
  });

  it('keeps discovery satisfiable while machine movement stays fail-closed', () => {
    // PrintFarmer's context DTO carries no safety or permission members, so any
    // predicate requiring them is unsatisfiable. Listing a profile must still
    // work against the real DTO, and anything that would move the machine must
    // still refuse — but for a reason that exists, not one that cannot.
    const context = RemoteCalibrationPrinterContext.parse(contextDto());
    expect(isExplicitCalibrationContextComplete(context)).toBe(true);
    expect(context.safety).toBeNull();
    expect(context.permissions).toBeNull();

    const capability = {
      grantedScopes: [
        'calibration:read',
        'calibration:create',
        'calibration:update',
        'calibration:generate',
      ],
      flags: {
        calibrationApiEnabled: true,
        calibrationGenerationEnabled: true,
      },
    };
    const binding = {
      printerId: context.printerId,
      configurationRevision: context.configurationRevision,
      snapshotId: context.snapshotId,
      toolId: context.toolheads[0]?.toolId ?? null,
    };

    // Generation moves nothing, so a complete context plus the exact permission
    // is enough. This is the case the old predicate blocked outright.
    expect(
      evaluateCalibrationActionGate({
        action: 'generate',
        capability,
        context,
        binding,
      }).allowed,
    ).toBe(true);

    // Dispatch refuses without a ledger-backed operator acknowledgement.
    const withoutAcknowledgement = evaluateCalibrationActionGate({
      action: 'acknowledgeBedClear',
      capability,
      context,
      binding,
    });
    expect(withoutAcknowledgement.allowed).toBe(false);
    expect(withoutAcknowledgement.code).toBe('safetyNotAssured');

    // And permits it with one, so the refusal above is a real gate rather than
    // an unsatisfiable condition wearing a gate's name.
    expect(
      evaluateCalibrationActionGate({
        action: 'acknowledgeBedClear',
        capability,
        context,
        binding,
        operatorAcknowledgement: true,
      }).allowed,
    ).toBe(true);
  });
});
