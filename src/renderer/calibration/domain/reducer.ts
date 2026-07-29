import {
  CALIBRATION_STAGE_BY_ID,
  CALIBRATION_STAGES,
  isMethodAvailable,
  isStageSkippable,
} from './catalog';
import {
  recommendationForObservation,
  validateBaselineProfile,
  validateObservation,
} from './formulas';
import { bindingDiagnostics } from './eligibility';
import type {
  CalibrationAttempt,
  CalibrationAttemptScope,
  CalibrationDiagnostic,
  CalibrationEvent,
  CalibrationStageId,
  CalibrationState,
  CreateCalibrationStateInput,
  StageProgress,
  StageProgressMap,
} from './types';

function attemptScope(
  binding: CreateCalibrationStateInput['binding'],
): CalibrationAttemptScope {
  return {
    backendProfileId: binding.printer.backendProfileId,
    backendPrinterId: binding.printer.backendPrinterId,
    printerConfigurationId: binding.printer.printerConfigurationId,
    printerConfigurationRevision: binding.printer.printerConfigurationRevision,
    snapshotId: binding.snapshot.snapshotId,
    snapshotRevision: binding.snapshot.snapshotRevision,
    toolId: binding.selectedToolId,
    toolheadId: binding.selectedToolheadId,
    nozzleId: binding.selectedNozzleId,
    filamentProjectId: binding.filament.filamentProjectId,
    filamentProvider: binding.filament.provider,
    filamentProduct: binding.filament.product,
    filamentSku: binding.filament.sku,
    ...(binding.filament.spoolId === undefined
      ? {}
      : { spoolId: binding.filament.spoolId }),
  };
}

function initialStages(): StageProgressMap {
  return {
    temperature: {
      stageId: 'temperature',
      status: 'notStarted',
      attemptIds: [],
    },
    flowPass1: {
      stageId: 'flowPass1',
      status: 'notStarted',
      attemptIds: [],
    },
    flowPass2: {
      stageId: 'flowPass2',
      status: 'notStarted',
      attemptIds: [],
    },
    pressureAdvance: {
      stageId: 'pressureAdvance',
      status: 'notStarted',
      attemptIds: [],
    },
    flowVerification: {
      stageId: 'flowVerification',
      status: 'notStarted',
      attemptIds: [],
    },
    retraction: {
      stageId: 'retraction',
      status: 'notStarted',
      attemptIds: [],
    },
    maximumVolumetricSpeed: {
      stageId: 'maximumVolumetricSpeed',
      status: 'notStarted',
      attemptIds: [],
    },
    shrinkage: {
      stageId: 'shrinkage',
      status: 'notStarted',
      attemptIds: [],
    },
    finalVerification: {
      stageId: 'finalVerification',
      status: 'notStarted',
      attemptIds: [],
    },
  };
}

export function createCalibrationState(
  input: CreateCalibrationStateInput,
): CalibrationState {
  return {
    schemaVersion: 1,
    projectId: input.projectId,
    createdAt: input.createdAt,
    mode: input.mode,
    baseline: input.baseline,
    binding: input.binding,
    snapshotHistory: [input.binding.snapshot],
    currentStageId: 'temperature',
    stages: initialStages(),
    attempts: [],
    history: [],
    diagnostics: [
      ...validateBaselineProfile(input.baseline),
      ...bindingDiagnostics(input.binding),
    ],
  };
}

function resolved(progress: StageProgress): boolean {
  return progress.status === 'completed' || progress.status === 'skipped';
}

export function unmetDependencies(
  state: CalibrationState,
  stageId: CalibrationStageId,
): readonly CalibrationStageId[] {
  return CALIBRATION_STAGE_BY_ID[stageId].dependencies.filter(
    (dependency) => !resolved(state.stages[dependency]),
  );
}

function downstreamStages(
  stageIds: readonly CalibrationStageId[],
): readonly CalibrationStageId[] {
  const affected = new Set<CalibrationStageId>(stageIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of CALIBRATION_STAGES) {
      if (
        !affected.has(stage.id) &&
        stage.dependencies.some((dependency) => affected.has(dependency))
      ) {
        affected.add(stage.id);
        changed = true;
      }
    }
  }
  return CALIBRATION_STAGES.filter((stage) => affected.has(stage.id)).map(
    (stage) => stage.id,
  );
}

function appendEvent(
  state: CalibrationState,
  event: CalibrationEvent,
): CalibrationState {
  return { ...state, history: [...state.history, event] };
}

function rejectEvent(
  state: CalibrationState,
  event: CalibrationEvent,
  code: string,
  message: string,
  stageId?: CalibrationStageId,
): CalibrationState {
  const diagnostic: CalibrationDiagnostic = {
    code,
    severity: 'error',
    message,
    ...(stageId === undefined ? {} : { stageId }),
  };
  return { ...state, diagnostics: [...state.diagnostics, diagnostic] };
}

function replaceAttempt(
  state: CalibrationState,
  replacement: CalibrationAttempt,
): CalibrationState {
  return {
    ...state,
    attempts: state.attempts.map((attempt) =>
      attempt.attemptId === replacement.attemptId ? replacement : attempt,
    ),
  };
}

function progressNeedingRetest(
  progress: StageProgress,
  reason: string,
): StageProgress {
  return {
    stageId: progress.stageId,
    status: 'needsRetest',
    attemptIds: progress.attemptIds,
    ...(progress.selectedAttemptId === undefined
      ? {}
      : { selectedAttemptId: progress.selectedAttemptId }),
    retestReason: reason,
  };
}

function invalidateStages(
  state: CalibrationState,
  sourceStages: readonly CalibrationStageId[],
  reason: string,
  preservedActiveAttemptIds: ReadonlySet<string> = new Set(),
): CalibrationState {
  const affected = new Set(downstreamStages(sourceStages));
  const attempts = state.attempts.map((attempt) =>
    affected.has(attempt.stageId) &&
    attempt.status === 'inProgress' &&
    !preservedActiveAttemptIds.has(attempt.attemptId)
      ? { ...attempt, status: 'abandoned' as const }
      : attempt,
  );
  let stages = state.stages;
  for (const stageId of affected) {
    const progress = stages[stageId];
    const hasPreservedActive = attempts.some(
      (attempt) =>
        attempt.stageId === stageId && attempt.status === 'inProgress',
    );
    if (hasPreservedActive) continue;
    if (progress.status === 'notStarted' && progress.attemptIds.length === 0) {
      continue;
    }
    stages = {
      ...stages,
      [stageId]: progressNeedingRetest(progress, reason),
    };
  }
  return { ...state, attempts, stages };
}

function attemptMatchesCurrentBinding(
  attempt: CalibrationAttempt,
  state: CalibrationState,
): boolean {
  const scope = attempt.scope;
  const binding = state.binding;
  return (
    scope.backendProfileId === binding.printer.backendProfileId &&
    scope.backendPrinterId === binding.printer.backendPrinterId &&
    scope.printerConfigurationId === binding.printer.printerConfigurationId &&
    scope.printerConfigurationRevision ===
      binding.printer.printerConfigurationRevision &&
    scope.snapshotId === binding.snapshot.snapshotId &&
    scope.snapshotRevision === binding.snapshot.snapshotRevision &&
    scope.toolId === binding.selectedToolId &&
    scope.toolheadId === binding.selectedToolheadId &&
    scope.nozzleId === binding.selectedNozzleId &&
    scope.filamentProjectId === binding.filament.filamentProjectId &&
    scope.filamentProvider === binding.filament.provider &&
    scope.filamentProduct === binding.filament.product &&
    scope.filamentSku === binding.filament.sku &&
    scope.spoolId === binding.filament.spoolId
  );
}

function attemptOrdinal(
  state: CalibrationState,
  stageId: CalibrationStageId,
): number {
  return (
    state.attempts.filter((attempt) => attempt.stageId === stageId).length + 1
  );
}

function beginAttempt(
  state: CalibrationState,
  event: Extract<
    CalibrationEvent,
    { readonly type: 'beginAttempt' | 'redoStage' }
  >,
): CalibrationState {
  if (state.attempts.some((attempt) => attempt.attemptId === event.attemptId)) {
    return rejectEvent(
      state,
      event,
      'DUPLICATE_ATTEMPT_ID',
      'Attempt IDs must be unique and supplied by the caller.',
      event.stageId,
    );
  }
  if (!isMethodAvailable(event.stageId, state.mode, event.method)) {
    return rejectEvent(
      state,
      event,
      'METHOD_NOT_AVAILABLE',
      'The selected method is not available for this stage and mode.',
      event.stageId,
    );
  }
  const dependencies = unmetDependencies(state, event.stageId);
  if (dependencies.length > 0) {
    return rejectEvent(
      state,
      event,
      'UNMET_STAGE_DEPENDENCIES',
      `Resolve dependencies first: ${dependencies.join(', ')}.`,
      event.stageId,
    );
  }
  const progress = state.stages[event.stageId];
  if (progress.status === 'inProgress') {
    return rejectEvent(
      state,
      event,
      'ATTEMPT_ALREADY_IN_PROGRESS',
      'Finish or explicitly skip the current stage attempt first.',
      event.stageId,
    );
  }
  const attempt: CalibrationAttempt = {
    attemptId: event.attemptId,
    stageId: event.stageId,
    method: event.method,
    scope: attemptScope(state.binding),
    ordinal: attemptOrdinal(state, event.stageId),
    status: 'inProgress',
    startedAt: event.timestamp,
    observations: [],
    diagnostics: [],
  };
  return {
    ...state,
    currentStageId: event.stageId,
    attempts: [...state.attempts, attempt],
    stages: {
      ...state.stages,
      [event.stageId]: {
        stageId: event.stageId,
        status: 'inProgress',
        attemptIds: [...progress.attemptIds, event.attemptId],
      },
    },
  };
}

function sameProjectBinding(
  state: CalibrationState,
  event: Extract<CalibrationEvent, { readonly type: 'rebaseSnapshot' }>,
): boolean {
  const previous = state.binding;
  const next = event.binding;
  const previousTool = previous.snapshot.toolheads.find(
    (tool) => tool.toolId === previous.selectedToolId,
  );
  const nextTool = next.snapshot.toolheads.find(
    (tool) => tool.toolId === next.selectedToolId,
  );
  return (
    previousTool !== undefined &&
    nextTool !== undefined &&
    previousTool.toolheadId === nextTool.toolheadId &&
    previousTool.extruderType === nextTool.extruderType &&
    previousTool.nozzle.nozzleId === nextTool.nozzle.nozzleId &&
    previousTool.nozzle.diameterMm === nextTool.nozzle.diameterMm &&
    previousTool.nozzle.material === nextTool.nozzle.material &&
    previous.printer.backendProfileId === next.printer.backendProfileId &&
    previous.printer.backendPrinterId === next.printer.backendPrinterId &&
    previous.printer.printerConfigurationId ===
      next.printer.printerConfigurationId &&
    previous.selectedToolId === next.selectedToolId &&
    previous.selectedToolheadId === next.selectedToolheadId &&
    previous.selectedNozzleId === next.selectedNozzleId &&
    previous.filament.filamentProjectId === next.filament.filamentProjectId &&
    previous.filament.provider === next.filament.provider &&
    previous.filament.product === next.filament.product &&
    previous.filament.sku === next.filament.sku &&
    previous.filament.spoolId === next.filament.spoolId
  );
}

export function calibrationReducer(
  state: CalibrationState,
  event: CalibrationEvent,
): CalibrationState {
  if (state.history.some((entry) => entry.eventId === event.eventId)) {
    return state;
  }

  switch (event.type) {
    case 'setMode': {
      const incompatibleAttempt = state.attempts.find(
        (attempt) =>
          attempt.status === 'inProgress' &&
          !isMethodAvailable(attempt.stageId, event.mode, attempt.method),
      );
      if (incompatibleAttempt !== undefined) {
        return rejectEvent(
          state,
          event,
          'MODE_INCOMPATIBLE_WITH_ACTIVE_METHOD',
          'Finish or abandon the active Expert-only method before entering Coach mode.',
          incompatibleAttempt.stageId,
        );
      }
      return appendEvent({ ...state, mode: event.mode }, event);
    }
    case 'navigate':
      return appendEvent({ ...state, currentStageId: event.stageId }, event);
    case 'beginAttempt': {
      if (
        state.stages[event.stageId].status === 'completed' ||
        state.stages[event.stageId].status === 'skipped'
      ) {
        return rejectEvent(
          state,
          event,
          'REDO_EVENT_REQUIRED',
          'Use an explicit redo event to preserve completed stage history.',
          event.stageId,
        );
      }
      const started = beginAttempt(state, event);
      return started.attempts.length === state.attempts.length
        ? started
        : appendEvent(started, event);
    }
    case 'recordObservation': {
      if (
        state.attempts.some((attempt) =>
          attempt.observations.some(
            (observation) =>
              observation.observationId === event.observation.observationId,
          ),
        )
      ) {
        return rejectEvent(
          state,
          event,
          'DUPLICATE_OBSERVATION_ID',
          'Observation IDs must be unique and supplied by the caller.',
          event.observation.stageId,
        );
      }
      const attempt = state.attempts.find(
        (candidate) => candidate.attemptId === event.attemptId,
      );
      if (
        attempt === undefined ||
        attempt.status !== 'inProgress' ||
        event.observation.attemptId !== event.attemptId ||
        event.observation.stageId !== attempt.stageId
      ) {
        return rejectEvent(
          state,
          event,
          'OBSERVATION_ATTEMPT_MISMATCH',
          'Observation must match an in-progress attempt and stage.',
          event.observation.stageId,
        );
      }
      if (event.observation.notes.length > 4_096) {
        return rejectEvent(
          state,
          event,
          'OBSERVATION_NOTES_TOO_LONG',
          'Observation notes cannot exceed 4,096 characters.',
          attempt.stageId,
        );
      }
      const diagnostics = validateObservation(
        event.observation,
        state.binding,
        attempt.method,
      );
      if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        return {
          ...state,
          diagnostics: [...state.diagnostics, ...diagnostics],
        };
      }
      const next = replaceAttempt(state, {
        ...attempt,
        observations: [...attempt.observations, event.observation],
        diagnostics: [...attempt.diagnostics, ...diagnostics],
      });
      return appendEvent(next, event);
    }
    case 'selectObservation': {
      const attempt = state.attempts.find(
        (candidate) => candidate.attemptId === event.attemptId,
      );
      const observation = attempt?.observations.find(
        (candidate) => candidate.observationId === event.observationId,
      );
      if (
        attempt === undefined ||
        attempt.status !== 'inProgress' ||
        observation === undefined
      ) {
        return rejectEvent(
          state,
          event,
          'OBSERVATION_NOT_SELECTABLE',
          'Select an observation from the in-progress attempt.',
          attempt?.stageId,
        );
      }
      return appendEvent(
        replaceAttempt(state, {
          ...attempt,
          selectedObservationId: observation.observationId,
        }),
        event,
      );
    }
    case 'completeAttempt': {
      const attempt = state.attempts.find(
        (candidate) => candidate.attemptId === event.attemptId,
      );
      const selected = attempt?.observations.find(
        (observation) =>
          observation.observationId === attempt.selectedObservationId,
      );
      if (
        attempt === undefined ||
        attempt.status !== 'inProgress' ||
        selected === undefined
      ) {
        return rejectEvent(
          state,
          event,
          'SELECTED_OBSERVATION_REQUIRED',
          'Select an observation from the in-progress attempt before completion.',
          attempt?.stageId,
        );
      }
      const dependencies = unmetDependencies(state, attempt.stageId);
      if (dependencies.length > 0) {
        return rejectEvent(
          state,
          event,
          'CURRENT_DEPENDENCIES_INVALID',
          `Attempt completion is stale because dependencies require resolution: ${dependencies.join(', ')}.`,
          attempt.stageId,
        );
      }
      if (!attemptMatchesCurrentBinding(attempt, state)) {
        return rejectEvent(
          state,
          event,
          'STALE_ATTEMPT_SCOPE',
          'Attempt scope no longer matches the current snapshot, tool, nozzle, and filament binding.',
          attempt.stageId,
        );
      }
      const selectedDiagnostics = validateObservation(
        selected,
        state.binding,
        attempt.method,
      );
      if (
        selectedDiagnostics.some(
          (diagnostic) => diagnostic.severity === 'error',
        )
      ) {
        return rejectEvent(
          state,
          event,
          'SELECTED_OBSERVATION_INVALID',
          'The selected observation has validation errors.',
          attempt.stageId,
        );
      }
      const recommendation = recommendationForObservation(state, selected);
      const verificationFailed =
        (selected.stageId === 'flowVerification' ||
          selected.stageId === 'finalVerification') &&
        (!selected.passed || selected.defectCount > 0);
      const lowConfidenceDiagnostic: CalibrationDiagnostic[] =
        event.confidence === 'low'
          ? [
              {
                code: 'LOW_RESULT_CONFIDENCE',
                severity: 'warning',
                message: 'Low confidence is recorded; a retest is recommended.',
                stageId: attempt.stageId,
                eventId: event.eventId,
              },
            ]
          : [];
      const completedAttempt: CalibrationAttempt = {
        ...attempt,
        status: 'completed',
        completedAt: event.timestamp,
        confidence: event.confidence,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.retest !== undefined ? { retest: event.retest } : {}),
        ...(event.completionNotes !== undefined
          ? { completionNotes: event.completionNotes }
          : {}),
        recommendation,
        diagnostics: [...attempt.diagnostics, ...lowConfidenceDiagnostic],
      };
      let next = replaceAttempt(state, completedAttempt);
      next = {
        ...next,
        stages: {
          ...next.stages,
          [attempt.stageId]: {
            ...next.stages[attempt.stageId],
            status: verificationFailed ? 'needsRetest' : 'completed',
            selectedAttemptId: attempt.attemptId,
            ...(verificationFailed
              ? { retestReason: 'Selected verification did not pass cleanly.' }
              : {}),
          },
        },
        diagnostics: [...next.diagnostics, ...lowConfidenceDiagnostic],
      };
      return appendEvent(next, event);
    }
    case 'completePrintedAttempt': {
      /* Authoritative domain-layer enforcement (L-05): result is required at
       * schema level. This case handles the printed-result workflow with
       * append-only evidence (photos, provenance links). */
      const attempt = state.attempts.find(
        (candidate) => candidate.attemptId === event.attemptId,
      );
      const selected = attempt?.observations.find(
        (observation) =>
          observation.observationId === attempt.selectedObservationId,
      );
      if (attempt === undefined || attempt.status !== 'inProgress') {
        return rejectEvent(
          state,
          event,
          'ATTEMPT_NOT_IN_PROGRESS',
          'completePrintedAttempt requires an in-progress attempt.',
          attempt?.stageId,
        );
      }
      if (selected === undefined) {
        return rejectEvent(
          state,
          event,
          'SELECTED_OBSERVATION_REQUIRED',
          'Select an observation from the in-progress attempt before completion.',
          attempt.stageId,
        );
      }
      const dependencies = unmetDependencies(state, attempt.stageId);
      if (dependencies.length > 0) {
        return rejectEvent(
          state,
          event,
          'CURRENT_DEPENDENCIES_INVALID',
          `Attempt completion is stale because dependencies require resolution: ${dependencies.join(', ')}.`,
          attempt.stageId,
        );
      }
      if (!attemptMatchesCurrentBinding(attempt, state)) {
        return rejectEvent(
          state,
          event,
          'STALE_ATTEMPT_SCOPE',
          'Attempt scope no longer matches the current snapshot, tool, nozzle, and filament binding.',
          attempt.stageId,
        );
      }
      const selectedDiagnostics = validateObservation(
        selected,
        state.binding,
        attempt.method,
      );
      if (
        selectedDiagnostics.some(
          (diagnostic) => diagnostic.severity === 'error',
        )
      ) {
        return rejectEvent(
          state,
          event,
          'SELECTED_OBSERVATION_INVALID',
          'The selected observation has validation errors.',
          attempt.stageId,
        );
      }
      const recommendation = recommendationForObservation(state, selected);
      const verificationFailed =
        (selected.stageId === 'flowVerification' ||
          selected.stageId === 'finalVerification') &&
        (!selected.passed || selected.defectCount > 0);
      const lowConfidenceDiagnostic: CalibrationDiagnostic[] =
        event.confidence === 'low'
          ? [
              {
                code: 'LOW_RESULT_CONFIDENCE',
                severity: 'warning',
                message: 'Low confidence is recorded; a retest is recommended.',
                stageId: attempt.stageId,
                eventId: event.eventId,
              },
            ]
          : [];
      /* Append immutable evidence: result, retest, photos, provenance links.
       * None of these fields can be overwritten after this point (L-03). */
      const completedAttempt: CalibrationAttempt = {
        ...attempt,
        status: 'completed',
        completedAt: event.timestamp,
        confidence: event.confidence,
        result: event.result,
        retest: event.retest,
        ...(event.completionNotes !== undefined
          ? { completionNotes: event.completionNotes }
          : {}),
        photos: event.photos,
        orchestrationId: event.orchestrationId,
        jobId: event.jobId,
        assetContentHash: event.assetContentHash,
        recommendation,
        diagnostics: [...attempt.diagnostics, ...lowConfidenceDiagnostic],
      };
      let next = replaceAttempt(state, completedAttempt);
      next = {
        ...next,
        stages: {
          ...next.stages,
          [attempt.stageId]: {
            ...next.stages[attempt.stageId],
            status: verificationFailed ? 'needsRetest' : 'completed',
            selectedAttemptId: attempt.attemptId,
            ...(verificationFailed
              ? { retestReason: 'Selected verification did not pass cleanly.' }
              : {}),
          },
        },
        diagnostics: [...next.diagnostics, ...lowConfidenceDiagnostic],
      };
      return appendEvent(next, event);
    }
    case 'skipStage': {
      const reason = event.reason.trim();
      const progress = state.stages[event.stageId];
      if (progress.status === 'completed' || progress.status === 'skipped') {
        return rejectEvent(
          state,
          event,
          'STAGE_ALREADY_RESOLVED',
          'A completed or skipped stage cannot be overwritten by another skip.',
          event.stageId,
        );
      }
      if (!isStageSkippable(event.stageId, state.mode)) {
        return rejectEvent(
          state,
          event,
          'STAGE_NOT_SKIPPABLE',
          'This stage cannot be skipped in the selected mode.',
          event.stageId,
        );
      }
      const dependencies = unmetDependencies(state, event.stageId);
      if (dependencies.length > 0) {
        return rejectEvent(
          state,
          event,
          'UNMET_STAGE_DEPENDENCIES',
          `Resolve dependencies first: ${dependencies.join(', ')}.`,
          event.stageId,
        );
      }
      if (reason.length === 0 || reason.length > 4_096) {
        return rejectEvent(
          state,
          event,
          'SKIP_REASON_REQUIRED',
          'An explicit skip reason from 1 through 4,096 characters is required.',
          event.stageId,
        );
      }
      const attempts = state.attempts.map((attempt) =>
        attempt.stageId === event.stageId && attempt.status === 'inProgress'
          ? { ...attempt, status: 'abandoned' as const }
          : attempt,
      );
      return appendEvent(
        {
          ...state,
          attempts,
          stages: {
            ...state.stages,
            [event.stageId]: {
              stageId: event.stageId,
              status: 'skipped',
              attemptIds: progress.attemptIds,
              skip: {
                skipId: event.skipId,
                reason,
                skippedAt: event.timestamp,
              },
            },
          },
        },
        { ...event, reason },
      );
    }
    case 'redoStage': {
      const reason = event.reason.trim();
      if (reason.length === 0 || reason.length > 4_096) {
        return rejectEvent(
          state,
          event,
          'RETEST_REASON_REQUIRED',
          'An explicit retest reason from 1 through 4,096 characters is required.',
          event.stageId,
        );
      }
      const status = state.stages[event.stageId].status;
      if (
        status !== 'completed' &&
        status !== 'skipped' &&
        status !== 'needsRetest'
      ) {
        return rejectEvent(
          state,
          event,
          'STAGE_NOT_READY_FOR_REDO',
          'Redo requires a completed, skipped, or needs-retest stage.',
          event.stageId,
        );
      }
      const normalizedEvent = { ...event, reason };
      const started = beginAttempt(state, normalizedEvent);
      if (started.attempts.length === state.attempts.length) return started;
      const invalidated = invalidateStages(
        started,
        [event.stageId],
        reason,
        new Set([event.attemptId]),
      );
      return appendEvent(invalidated, normalizedEvent);
    }
    case 'rebaseSnapshot': {
      const reason = event.reason.trim();
      if (!sameProjectBinding(state, event)) {
        return rejectEvent(
          state,
          event,
          'REBASE_IDENTITY_MISMATCH',
          'A rebase cannot change backend printer/configuration, selected tool/toolhead/nozzle, or filament identity.',
        );
      }
      const bindingErrors = bindingDiagnostics(event.binding);
      if (bindingErrors.length > 0) {
        return {
          ...state,
          diagnostics: [...state.diagnostics, ...bindingErrors],
        };
      }
      if (
        event.binding.snapshot.snapshotId ===
          state.binding.snapshot.snapshotId ||
        event.binding.snapshot.snapshotRevision <=
          state.binding.snapshot.snapshotRevision ||
        event.binding.printer.printerConfigurationRevision <=
          state.binding.printer.printerConfigurationRevision ||
        event.retestStages.length === 0 ||
        reason.length === 0 ||
        reason.length > 4_096
      ) {
        return rejectEvent(
          state,
          event,
          'EXPLICIT_REBASE_RETEST_REQUIRED',
          'A newer configuration and snapshot, a reason from 1 through 4,096 characters, and at least one explicit retest stage are required.',
        );
      }
      const activeAttemptStages = state.attempts
        .filter((attempt) => attempt.status === 'inProgress')
        .map((attempt) => attempt.stageId);
      const retestStages = [
        ...new Set([...event.retestStages, ...activeAttemptStages]),
      ];
      const rebased = invalidateStages(
        {
          ...state,
          binding: event.binding,
          snapshotHistory: [...state.snapshotHistory, event.binding.snapshot],
        },
        retestStages,
        reason,
      );
      return appendEvent(rebased, { ...event, reason });
    }
  }
}

export function replayCalibrationEvents(
  initial: CalibrationState,
  events: readonly CalibrationEvent[],
): CalibrationState {
  return events.reduce(calibrationReducer, initial);
}
