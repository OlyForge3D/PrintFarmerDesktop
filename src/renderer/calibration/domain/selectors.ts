import {
  CALIBRATION_STAGE_BY_ID,
  CALIBRATION_STAGES,
  isStageSkippable,
  methodsForStage,
} from './catalog';
import { unmetDependencies } from './reducer';
import type {
  CalibrationAttempt,
  CalibrationDiagnostic,
  CalibrationStageId,
  CalibrationStageViewModel,
  CalibrationState,
  CalibrationWorkflowViewModel,
} from './types';

export function selectedAttemptForStage(
  state: CalibrationState,
  stageId: CalibrationStageId,
): CalibrationAttempt | undefined {
  const attemptId = state.stages[stageId].selectedAttemptId;
  return state.attempts.find((attempt) => attempt.attemptId === attemptId);
}

export function nextWorkflowStage(
  state: CalibrationState,
): CalibrationStageId | null {
  const next = CALIBRATION_STAGES.find((stage) => {
    const status = state.stages[stage.id].status;
    return (
      status !== 'completed' &&
      status !== 'skipped' &&
      unmetDependencies(state, stage.id).length === 0
    );
  });
  return next?.id ?? null;
}

function dependencyBlockers(
  state: CalibrationState,
  stageId: CalibrationStageId,
): readonly CalibrationDiagnostic[] {
  return unmetDependencies(state, stageId).map((dependency) => ({
    code: 'UNMET_STAGE_DEPENDENCY',
    severity: 'error' as const,
    message: `Resolve ${CALIBRATION_STAGE_BY_ID[dependency].title} first.`,
    stageId,
    field: dependency,
  }));
}

export function buildStageViewModel(
  state: CalibrationState,
  stageId: CalibrationStageId,
): CalibrationStageViewModel {
  const definition = CALIBRATION_STAGE_BY_ID[stageId];
  const progress = state.stages[stageId];
  const blockers = dependencyBlockers(state, stageId);
  const canStart =
    blockers.length === 0 &&
    (progress.status === 'notStarted' || progress.status === 'needsRetest');
  const selectedAttempt = selectedAttemptForStage(state, stageId);
  return {
    id: stageId,
    title: definition.title,
    order: definition.order,
    status: progress.status,
    isCurrent: state.currentStageId === stageId,
    canNavigate: true,
    canStart,
    canSkip:
      blockers.length === 0 &&
      progress.status !== 'completed' &&
      isStageSkippable(stageId, state.mode),
    availableMethods: methodsForStage(stageId, state.mode),
    dependencies: definition.dependencies,
    attemptCount: progress.attemptIds.length,
    ...(selectedAttempt === undefined ? {} : { selectedAttempt }),
    guidance:
      state.mode === 'coach'
        ? definition.guidance.coach
        : definition.guidance.expert,
    blockers,
  };
}

export function buildWorkflowViewModel(
  state: CalibrationState,
): CalibrationWorkflowViewModel {
  const stages = CALIBRATION_STAGES.map((stage) =>
    buildStageViewModel(state, stage.id),
  );
  const completedCount = stages.filter(
    (stage) => stage.status === 'completed',
  ).length;
  const resolvedCount = stages.filter(
    (stage) => stage.status === 'completed' || stage.status === 'skipped',
  ).length;
  return {
    projectId: state.projectId,
    mode: state.mode,
    currentStageId: state.currentStageId,
    nextStageId: nextWorkflowStage(state),
    completedCount,
    resolvedCount,
    totalCount: stages.length,
    stages,
    diagnostics: state.diagnostics,
  };
}
