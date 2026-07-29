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
import { resolveCalibrationWorkspaceFreshness } from '../src/main/calibrationFreshness.js';
import { CalibrationHttpError } from '../src/main/calibrationHttp.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const OBSERVATION_ID = '55555555-5555-4555-8555-555555555555';
const NOW = '2026-07-26T15:00:00.000Z';
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
    snapshotId: 'snapshot-1',
    snapshotRevision: 1,
    capturedAt: NOW,
    configurationRevision: 7,
    toolheads: [
      {
        toolId: 'tool-1',
        toolheadId: 'toolhead-1',
        nozzle: {
          nozzleId: 'nozzle-1',
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
          backendPrinterId: 'printer-1',
          printerConfigurationId: 'configuration-1',
          printerConfigurationRevision: 7,
        },
        snapshot,
        selectedToolId: 'tool-1',
        selectedToolheadId: 'toolhead-1',
        selectedNozzleId: 'nozzle-1',
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
      orcaProfileId: 'base-pla',
      displayName: 'Upstream PLA',
      source: 'printFarmer',
      upstreamVerified: true,
      printerId: 'printer-1',
      configurationRevision: 7,
      snapshotId: 'snapshot-1',
      toolId: 'tool-1',
      toolheadId: 'toolhead-1',
      nozzleId: 'nozzle-1',
      nozzleDiameterMm: 0.4,
      profileRevision: 'profile-r7',
      contentHash: null,
    },
    selectedBaseProfileId: 'base-pla',
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
    printerId: 'printer-1',
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
      printerId: 'printer-1',
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
      toolId: 'tool-1',
      toolheadId: 'toolhead-1',
      nozzleId: 'nozzle-1',
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
  const candidate = {
    printerId: 'printer-1',
    displayName: 'Any arbitrary printer name',
    printerModel: null,
    firmwareCompatible: false,
    orcaProfileId: null,
    isOnline: true,
    updatedAt: NOW,
  };
  const completeEligibility = {
    firmwareFamily: 'Klipper',
    gcodeDialect: 'Klipper',
    slicerFamily: 'OrcaSlicer',
    slicerDistribution: 'upstream',
    slicerIdentity: 'OrcaSlicer',
    hardwareContextComplete: true,
    safetyContextComplete: true,
    permissionsComplete: true,
    reasons: [],
  };

  it('maps incomplete and unknown remote assertions to null', () => {
    const old = RemoteCalibrationPrinterCandidate.parse(candidate);
    expect(projectCalibrationEligibility(old)).toBeNull();
    expect(isExplicitCalibrationEligibilityComplete(old)).toBe(false);

    const incomplete = RemoteCalibrationPrinterCandidate.parse({
      ...candidate,
      eligibility: {
        firmwareFamily: 'Klipper',
        gcodeDialect: 'Klipper',
      },
    });
    expect(projectCalibrationEligibility(incomplete)).toBeNull();
    expect(isExplicitCalibrationEligibilityComplete(incomplete)).toBe(false);

    const unknown = RemoteCalibrationPrinterCandidate.parse({
      ...candidate,
      eligibility: {
        ...completeEligibility,
        slicerDistribution: 'vendorFork',
      },
    });
    expect(projectCalibrationEligibility(unknown)).toBeNull();
    expect(isExplicitCalibrationEligibilityComplete(unknown)).toBe(false);
  });

  it('accepts only the five canonical literals independent of names', () => {
    const remote = RemoteCalibrationPrinterCandidate.parse({
      ...candidate,
      displayName: 'No Klipper hint',
      eligibility: {
        ...completeEligibility,
        futureEligibilityField: 'ignored',
      },
    });
    const eligibility = projectCalibrationEligibility(remote);
    const parsed = CalibrationPrinterCandidate.parse({
      ...candidate,
      firmwareCompatible: true,
      eligibility,
    });
    expect(parsed.eligibility).toEqual(completeEligibility);
    expect(isExplicitCalibrationEligibilityComplete(remote)).toBe(true);
  });
});

function remoteContext() {
  return {
    printerId: 'printer-1',
    displayName: 'Arbitrary',
    printerModel: null,
    firmware: {
      firmware: 'Klipper',
      gcodeDialect: 'Klipper',
      firmwareVersion: null,
      klipperConfigHash: null,
    },
    orcaProfileId: 'base-pla',
    orcaProfileDisplayName: 'Upstream PLA',
    bedWidthMm: 220,
    bedDepthMm: 220,
    nozzleDiameterMm: 0.4,
    snapshotAt: NOW,
    isCurrent: true,
    configurationId: 'configuration-1',
    configurationRevision: 7,
    snapshotId: 'snapshot-1',
    snapshotRevision: 1,
    slicerIdentity: 'OrcaSlicer',
    slicerDistribution: 'upstream',
    profileRevision: 'profile-r7',
    contentHash: null,
    toolheads: [
      {
        toolId: 'tool-1',
        toolheadId: 'toolhead-1',
        extruderType: 'directDrive',
        nozzle: { id: 'nozzle-1', diameterMm: 0.4, material: 'brass' },
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
    permissions: {
      readPrinter: true,
      writeCalibration: true,
      generateCalibration: true,
      startPrint: true,
    },
  };
}

function remoteCandidate(overrides: Record<string, unknown> = {}) {
  const eligibility = {
    firmwareFamily: 'Klipper',
    gcodeDialect: 'Klipper',
    slicerFamily: 'OrcaSlicer',
    slicerDistribution: 'upstream',
    slicerIdentity: 'OrcaSlicer',
    hardwareContextComplete: true,
    safetyContextComplete: true,
    permissionsComplete: true,
    reasons: [],
    ...(typeof overrides.eligibility === 'object' &&
    overrides.eligibility !== null
      ? overrides.eligibility
      : {}),
  };
  return RemoteCalibrationPrinterCandidate.parse({
    printerId: 'printer-1',
    displayName: 'Any arbitrary printer name',
    printerModel: null,
    firmwareCompatible: true,
    orcaProfileId: 'base-pla',
    isOnline: true,
    updatedAt: NOW,
    ...overrides,
    eligibility,
  });
}

describe('explicit printer context', () => {
  it('blocks missing and non-upstream identities', () => {
    const missing = RemoteCalibrationPrinterContext.parse({
      ...remoteContext(),
      profileRevision: null,
    });
    expect(isExplicitCalibrationContextComplete(missing)).toBe(false);

    const fork = RemoteCalibrationPrinterContext.parse({
      ...remoteContext(),
      slicerDistribution: 'vendorFork',
    });
    expect(isExplicitCalibrationContextComplete(fork)).toBe(false);
    expect(
      projectCalibrationPrinterContext(fork).slicerDistribution,
    ).toBeNull();
  });

  it('projects only strict known IPC fields from a complete remote context', () => {
    const context = RemoteCalibrationPrinterContext.parse({
      ...remoteContext(),
      futureRemoteField: { secret: 'not projected' },
    });
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
    const exact = RemoteCalibrationPrinterContext.parse({
      ...remoteContext(),
      safety: {
        ...remoteContext().safety,
        futureSafetyField: 'ignored',
      },
    });
    const mismatch = RemoteCalibrationPrinterContext.parse({
      ...remoteContext(),
      snapshotId: 'new-snapshot',
    });
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
      displayName: 'Unrelated candidate name',
      futureRemoteField: 'must not leak',
    });
    const completeContext = RemoteCalibrationPrinterContext.parse({
      ...remoteContext(),
      futureRemoteField: 'must not leak',
    });

    expect(
      projectPrintFarmerOrcaProfile(completeCandidate, completeContext),
    ).toEqual({
      orcaProfileId: 'base-pla',
      displayName: 'Upstream PLA',
      vendor: null,
      material: null,
      source: 'printFarmer',
      upstreamVerified: true,
      printerId: 'printer-1',
      configurationRevision: 7,
      snapshotId: 'snapshot-1',
      toolId: 'tool-1',
      toolheadId: 'toolhead-1',
      nozzleId: 'nozzle-1',
      nozzleDiameterMm: 0.4,
      profileRevision: 'profile-r7',
      contentHash: null,
      exportable: false,
    });
  });

  it('omits incomplete or ineligible contexts regardless of names', () => {
    const misleadingName = remoteCandidate({
      displayName: 'Klipper OrcaSlicer upstream',
      eligibility: {
        firmwareFamily: 'Marlin',
        gcodeDialect: 'Klipper',
        slicerFamily: 'OrcaSlicer',
        slicerDistribution: 'upstream',
        slicerIdentity: 'OrcaSlicer',
      },
    });
    const missingRevision = RemoteCalibrationPrinterContext.parse({
      ...remoteContext(),
      profileRevision: null,
    });
    const wrongPrinter = RemoteCalibrationPrinterContext.parse({
      ...remoteContext(),
      printerId: 'another-printer',
    });

    expect(
      projectPrintFarmerOrcaProfile(
        misleadingName,
        RemoteCalibrationPrinterContext.parse(remoteContext()),
      ),
    ).toBeNull();
    expect(
      projectPrintFarmerOrcaProfile(remoteCandidate(), missingRevision),
    ).toBeNull();
    expect(
      projectPrintFarmerOrcaProfile(remoteCandidate(), wrongPrinter),
    ).toBeNull();
  });
});

// ─── pendingGeneration workspace field (G-02, G-04) ──────────────────────────

describe('pendingGeneration workspace field — durable operation context (G-02, G-04)', () => {
  it('accepts pendingGeneration when present — operationId is preserved', () => {
    const base = validWorkspace();
    const result = CalibrationWorkspacePayload.safeParse({
      ...base,
      pendingGeneration: {
        operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        stageId: 'temperature',
        attemptId: '11111111-1111-4111-8111-111111111111',
        expectedProjectRevision: 3,
        orchestrationId: '22222222-2222-4222-8222-222222222222',
        orchestrationStep: 'SlicingClaimed',
        jobId: null,
        lastReconcileAt: '2026-07-29T00:01:00.000Z',
        createdAt: '2026-07-29T00:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingGeneration?.operationId).toBe(
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
      );
      expect(result.data.pendingGeneration?.orchestrationStep).toBe(
        'SlicingClaimed',
      );
    }
  });

  it('accepts workspace without pendingGeneration — backward compatible', () => {
    const base = validWorkspace();
    // Remove pendingGeneration to simulate old workspace
    const { pendingGeneration: _omit, ...rest } = base as typeof base & {
      pendingGeneration?: unknown;
    };
    void _omit;
    const result = CalibrationWorkspacePayload.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingGeneration).toBeUndefined();
    }
  });

  it('accepts pendingGeneration: null — operation cleared after completion', () => {
    const base = validWorkspace();
    const result = CalibrationWorkspacePayload.safeParse({
      ...base,
      pendingGeneration: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingGeneration).toBeNull();
    }
  });

  it('operationId is a stable UUID across serialize→parse roundtrip (G-04)', () => {
    const operationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const base = validWorkspace();
    const parsed = CalibrationWorkspacePayload.parse({
      ...base,
      pendingGeneration: {
        operationId,
        stageId: 'flowPass1',
        attemptId: '33333333-3333-4333-8333-333333333333',
        expectedProjectRevision: null,
        orchestrationId: null,
        orchestrationStep: null,
        jobId: null,
        lastReconcileAt: null,
        createdAt: NOW,
      },
    });
    // Serialize and re-parse to prove stable IDs
    const reparsed = CalibrationWorkspacePayload.parse(
      JSON.parse(JSON.stringify(parsed)),
    );
    expect(reparsed.pendingGeneration?.operationId).toBe(operationId);
    expect(reparsed.pendingGeneration?.stageId).toBe('flowPass1');
  });
});
