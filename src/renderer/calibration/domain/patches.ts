import { selectedAttemptForStage } from './selectors';
import type {
  CalibrationAttempt,
  CalibrationAttemptScope,
  CalibrationDiagnostic,
  CalibrationObservation,
  CalibrationStageId,
  CalibrationState,
  OrcaPatchScope,
  OrcaProfilePatch,
  OrcaProfilePatchEntry,
  OrcaPatchTarget,
} from './types';

function patchScope(scope: CalibrationAttemptScope): OrcaPatchScope {
  return {
    backendPrinterId: scope.backendPrinterId,
    printerConfigurationId: scope.printerConfigurationId,
    printerConfigurationRevision: scope.printerConfigurationRevision,
    snapshotId: scope.snapshotId,
    toolId: scope.toolId,
    toolheadId: scope.toolheadId,
    nozzleId: scope.nozzleId,
    filamentProjectId: scope.filamentProjectId,
    filamentSku: scope.filamentSku,
    ...(scope.spoolId === undefined ? {} : { spoolId: scope.spoolId }),
  };
}

function selectedObservation(
  attempt: CalibrationAttempt,
): CalibrationObservation | undefined {
  return attempt.observations.find(
    (observation) =>
      observation.observationId === attempt.selectedObservationId,
  );
}

interface PatchMapping {
  readonly key: string;
  readonly target: OrcaPatchTarget;
}

const PATCH_MAPPINGS: Readonly<Record<string, PatchMapping>> = {
  nozzle_temperature: { key: 'nozzle_temperature', target: 'filament' },
  filament_flow_ratio: { key: 'filament_flow_ratio', target: 'filament' },
  enable_pressure_advance: {
    key: 'enable_pressure_advance',
    target: 'filament',
  },
  pressure_advance: { key: 'pressure_advance', target: 'filament' },
  retraction_length: {
    key: 'filament_retraction_length',
    target: 'filament',
  },
  filament_max_volumetric_speed: {
    key: 'filament_max_volumetric_speed',
    target: 'filament',
  },
  filament_shrink: {
    key: 'filament_shrink',
    target: 'filament',
  },
  filament_shrinkage_compensation_z: {
    key: 'filament_shrinkage_compensation_z',
    target: 'filament',
  },
};

function entriesForAttempt(
  attempt: CalibrationAttempt,
): readonly OrcaProfilePatchEntry[] {
  const observation = selectedObservation(attempt);
  if (observation === undefined || attempt.recommendation === undefined) {
    return [];
  }
  const entries: OrcaProfilePatchEntry[] = [];
  for (const value of attempt.recommendation.values) {
    const mapping = PATCH_MAPPINGS[value.key];
    if (mapping === undefined) continue;
    entries.push({
      target: mapping.target,
      key: mapping.key,
      value: value.value,
      unit: value.unit,
      sourceStageId: attempt.stageId,
      sourceAttemptId: attempt.attemptId,
      sourceObservationId: observation.observationId,
      scope: patchScope(attempt.scope),
    });
  }
  return entries;
}

function patchAttemptForStage(
  state: CalibrationState,
  stageId: CalibrationStageId,
): CalibrationAttempt | undefined {
  const attempt = selectedAttemptForStage(state, stageId);
  return attempt?.status === 'completed' ? attempt : undefined;
}

export function buildOrcaProfilePatch(
  state: CalibrationState,
): OrcaProfilePatch {
  const diagnostics: CalibrationDiagnostic[] = [];
  const finalAttempt = patchAttemptForStage(state, 'finalVerification');
  const finalObservation =
    finalAttempt === undefined ? undefined : selectedObservation(finalAttempt);
  if (
    finalObservation === undefined ||
    finalObservation.stageId !== 'finalVerification' ||
    !finalObservation.passed ||
    finalObservation.defectCount > 0 ||
    state.stages.finalVerification.status !== 'completed'
  ) {
    diagnostics.push({
      code: 'FINAL_VERIFICATION_REQUIRED',
      severity: 'error',
      message:
        'A clean completed final verification is required before applying this patch.',
      stageId: 'finalVerification',
    });
  }

  const needsRetest = Object.values(state.stages).filter(
    (stage) => stage.status === 'needsRetest',
  );
  if (needsRetest.length > 0) {
    diagnostics.push({
      code: 'RETESTS_REQUIRED',
      severity: 'error',
      message: `Complete required retests: ${needsRetest
        .map((stage) => stage.stageId)
        .join(', ')}.`,
    });
  }
  for (const progress of Object.values(state.stages)) {
    if (progress.status === 'skipped') {
      diagnostics.push({
        code: 'STAGE_SKIPPED',
        severity: 'warning',
        message: `${progress.stageId} was explicitly skipped; no patch value will be proposed for it.`,
        stageId: progress.stageId,
      });
    }
  }

  const orderedAttempts: CalibrationAttempt[] = [];
  const temperature = patchAttemptForStage(state, 'temperature');
  const preferredFlow =
    patchAttemptForStage(state, 'flowPass2') ??
    patchAttemptForStage(state, 'flowPass1');
  const pressureAdvance = patchAttemptForStage(state, 'pressureAdvance');
  const retraction = patchAttemptForStage(state, 'retraction');
  const volumetric = patchAttemptForStage(state, 'maximumVolumetricSpeed');
  const shrinkage = patchAttemptForStage(state, 'shrinkage');
  for (const attempt of [
    temperature,
    preferredFlow,
    pressureAdvance,
    retraction,
    volumetric,
    shrinkage,
  ]) {
    if (attempt !== undefined) orderedAttempts.push(attempt);
  }
  for (const attempt of orderedAttempts) {
    if (
      attempt.scope.snapshotId !== state.binding.snapshot.snapshotId ||
      attempt.scope.snapshotRevision !==
        state.binding.snapshot.snapshotRevision ||
      attempt.scope.printerConfigurationRevision !==
        state.binding.printer.printerConfigurationRevision ||
      attempt.scope.toolId !== state.binding.selectedToolId ||
      attempt.scope.toolheadId !== state.binding.selectedToolheadId ||
      attempt.scope.nozzleId !== state.binding.selectedNozzleId
    ) {
      diagnostics.push({
        code: 'STALE_ATTEMPT_SCOPE',
        severity: 'error',
        message: `${attempt.stageId} was measured against a different snapshot or physical tool; explicitly retest it.`,
        stageId: attempt.stageId,
      });
    }
    if (attempt.confidence === 'low') {
      diagnostics.push({
        code: 'LOW_PATCH_VALUE_CONFIDENCE',
        severity: 'warning',
        message: `${attempt.stageId} has low confidence; consider a retest before applying its value.`,
        stageId: attempt.stageId,
      });
    }
  }

  return {
    projectId: state.projectId,
    basePrinterConfigurationRevision:
      state.binding.printer.printerConfigurationRevision,
    snapshotId: state.binding.snapshot.snapshotId,
    entries: orderedAttempts.flatMap(entriesForAttempt),
    diagnostics,
  };
}
