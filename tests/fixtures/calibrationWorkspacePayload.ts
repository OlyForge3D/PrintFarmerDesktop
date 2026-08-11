/**
 * A complete, schema-valid calibration workspace payload.
 *
 * Shared so that handler-level suites can drive the real generation, export and
 * install handlers against a workspace the production schemas accept, instead
 * of each one assembling its own near-miss and discovering the difference as a
 * parse error.
 */

import {
  CalibrationWorkspacePayload,
  type CalibrationWorkspacePayload as CalibrationWorkspacePayloadType,
} from '@shared/ipc';

export const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
export const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
export const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
export const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
export const OBSERVATION_ID = '55555555-5555-4555-8555-555555555555';
export const NOW = '2026-07-26T15:00:00.000Z';
// Identities shaped like the server's: PrintFarmer keys printers, toolheads and
// profiles by Guid, and identifies a snapshot by its content hash.
export const PRINTER_GUID = 'aaaaaaaa-1111-4111-8111-222222222222';
export const OTHER_PRINTER_GUID = 'bbbbbbbb-1111-4111-8111-222222222222';
export const FILAMENT_PROFILE_GUID = 'cccccccc-1111-4111-8111-222222222222';
export const TOOLHEAD_GUID = 'dddddddd-1111-4111-8111-222222222222';
export const SNAPSHOT_SHA = 'a'.repeat(64);
export const STAGE_IDS = [
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

export function blankWorkflowDraft() {
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

export function validWorkspace(): CalibrationWorkspacePayloadType {
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
      // False, matching what a real context reports: PrintFarmer publishes no
      // interlock assertions, so a workspace that recorded `true` would claim
      // the server confirmed something it was never asked about — and would
      // then read as drifted against every context it is compared with.
      emergencyStopAvailable: false,
      thermalProtectionConfirmed: false,
      ventilationAssessed: false,
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

export function completedTemperatureAttempt(
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

export function workspaceWithCompletedAttempt(): CalibrationWorkspacePayloadType {
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
