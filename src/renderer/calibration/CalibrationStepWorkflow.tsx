import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  OpenCalibrationPhotoResponse,
  type CalibrationOrchestrationStatus,
  type CalibrationQueueJobState,
  type CalibrationJobProvenance,
  type CalibrationPrintObservation,
} from '@shared/ipc';
import {
  CALIBRATION_BOUNDS,
  CALIBRATION_STAGE_BY_ID,
  buildStageViewModel,
  decideCalibrationAction,
  methodsForStage,
  validateObservation,
  type CalibrationAttempt,
  type CalibrationDiagnostic,
  type CalibrationMethod,
  type CalibrationObservation,
  type CalibrationStageId,
  type RuntimeCalibrationContext,
} from './domain';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import { isCurrentPhysicalMatch } from './parseDomainState';
import { calibrationApi } from './api';
import {
  errorMessage,
  formatTimestamp,
  type WorkspaceWorkflowDraft,
} from './workspaceTypes';
import { CalibrationOrchestrationProgress } from './CalibrationOrchestrationProgress';
import { CalibrationQueueDispatchPanel } from './CalibrationQueueDispatchPanel';
import {
  CalibrationBedClearDialog,
  type BedClearDialogJob,
} from './CalibrationBedClearDialog';
import { CalibrationPrintLifecycle } from './CalibrationPrintLifecycle';
import { CalibrationProvenance } from './CalibrationProvenance';

interface CalibrationStepWorkflowProps {
  readonly stageId: CalibrationStageId;
}

type ObservationDraft = WorkspaceWorkflowDraft['observation'];

function methodLabel(method: CalibrationMethod): string {
  return method
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (letter) => letter.toUpperCase())
    .replace('Yolo', 'YOLO');
}

function finite(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface PrimaryObservationField {
  readonly field: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
}

function boundedField(
  field: string,
  label: string,
  bounds: {
    readonly minimum: number;
    readonly maximum: number;
    readonly step: number;
  },
  unit: string,
): PrimaryObservationField {
  return {
    field,
    label,
    min: bounds.minimum,
    max: bounds.maximum,
    step: bounds.step,
    unit,
  };
}

function primaryField(
  stageId: CalibrationStageId,
  method: CalibrationMethod | undefined,
): PrimaryObservationField | null {
  switch (stageId) {
    case 'temperature':
      return boundedField(
        'temperatureC',
        'Temperature',
        CALIBRATION_BOUNDS.temperatureC,
        'C',
      );
    case 'flowPass1': {
      const bounds =
        method === 'flowCoarse'
          ? CALIBRATION_BOUNDS.flowCoarseAdjustmentPercent
          : method === 'flowYolo'
            ? CALIBRATION_BOUNDS.flowYoloAdjustmentPercent
            : CALIBRATION_BOUNDS.flowStandardAdjustmentPercent;
      return boundedField('adjustmentPercent', 'Flow adjustment', bounds, '%');
    }
    case 'flowPass2':
      return boundedField(
        'adjustmentPercent',
        'Fine flow adjustment',
        CALIBRATION_BOUNDS.flowFineAdjustmentPercent,
        '%',
      );
    case 'pressureAdvance':
      return boundedField(
        'pressureAdvance',
        'Pressure advance',
        CALIBRATION_BOUNDS.pressureAdvance,
        's',
      );
    case 'flowVerification':
    case 'finalVerification':
      return {
        field: 'defectCount',
        label: 'Defect count',
        min: 0,
        max: 999,
        step: 1,
        unit: 'defects',
      };
    case 'retraction':
      return boundedField(
        'retractionLengthMm',
        'Retraction length',
        CALIBRATION_BOUNDS.retractionLengthMm,
        'mm',
      );
    case 'maximumVolumetricSpeed':
      return boundedField(
        'stableVolumetricRateMm3S',
        'Stable volumetric rate',
        CALIBRATION_BOUNDS.stableVolumetricRateMm3S,
        'mm3/s',
      );
    case 'shrinkage':
      return null;
  }
}

function usesQuality(stageId: CalibrationStageId): boolean {
  return !['flowVerification', 'finalVerification', 'shrinkage'].includes(
    stageId,
  );
}

function observationFor(
  stageId: CalibrationStageId,
  attemptId: string,
  observationId: string,
  observedAt: string,
  draft: ObservationDraft,
): CalibrationObservation | null {
  const common = { observationId, attemptId, observedAt, notes: draft.notes };
  const primary = finite(draft.primary);
  const quality = finite(draft.quality);
  switch (stageId) {
    case 'temperature':
      return primary === null || quality === null
        ? null
        : { ...common, stageId, temperatureC: primary, quality };
    case 'flowPass1':
    case 'flowPass2':
      return primary === null || quality === null
        ? null
        : { ...common, stageId, adjustmentPercent: primary, quality };
    case 'pressureAdvance':
      return primary === null || quality === null
        ? null
        : { ...common, stageId, pressureAdvance: primary, quality };
    case 'flowVerification':
    case 'finalVerification':
      return primary === null
        ? null
        : { ...common, stageId, passed: draft.passed, defectCount: primary };
    case 'retraction':
      return primary === null || quality === null
        ? null
        : { ...common, stageId, retractionLengthMm: primary, quality };
    case 'maximumVolumetricSpeed':
      return primary === null || quality === null
        ? null
        : { ...common, stageId, stableVolumetricRateMm3S: primary, quality };
    case 'shrinkage': {
      const values = {
        nominalXmm: finite(draft.nominalXmm),
        nominalYmm: finite(draft.nominalYmm),
        nominalZmm: finite(draft.nominalZmm),
        measuredXmm: finite(draft.measuredXmm),
        measuredYmm: finite(draft.measuredYmm),
        measuredZmm: finite(draft.measuredZmm),
      };
      if (Object.values(values).some((value) => value === null)) return null;
      return {
        ...common,
        stageId,
        nominalXmm: values.nominalXmm!,
        nominalYmm: values.nominalYmm!,
        nominalZmm: values.nominalZmm!,
        measuredXmm: values.measuredXmm!,
        measuredYmm: values.measuredYmm!,
        measuredZmm: values.measuredZmm!,
      };
    }
  }
}

function observationSummary(observation: CalibrationObservation): string {
  switch (observation.stageId) {
    case 'temperature':
      return `${observation.temperatureC} C; quality ${observation.quality}`;
    case 'flowPass1':
    case 'flowPass2':
      return `${observation.adjustmentPercent}% adjustment; quality ${observation.quality}`;
    case 'pressureAdvance':
      return `${observation.pressureAdvance} s; quality ${observation.quality}`;
    case 'flowVerification':
    case 'finalVerification':
      return `${observation.passed ? 'passed' : 'did not pass'}; ${observation.defectCount} defects`;
    case 'retraction':
      return `${observation.retractionLengthMm} mm; quality ${observation.quality}`;
    case 'maximumVolumetricSpeed':
      return `${observation.stableVolumetricRateMm3S} mm3/s; quality ${observation.quality}`;
    case 'shrinkage':
      return `nominal ${observation.nominalXmm}/${observation.nominalYmm}/${observation.nominalZmm} mm; measured ${observation.measuredXmm}/${observation.measuredYmm}/${observation.measuredZmm} mm`;
  }
}

export function CalibrationStepWorkflow({
  stageId,
}: CalibrationStepWorkflowProps): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const project = store.activeProject!;
  const state = project.domainState;
  const progress = state.stages[stageId];
  const definition = CALIBRATION_STAGE_BY_ID[stageId];
  const view = buildStageViewModel(state, stageId);
  const workflowDraft = project.record.workspaceState.workflowDrafts[stageId];
  const method = workflowDraft.method ?? '';
  const observationDraft = workflowDraft.observation;
  const confidence = workflowDraft.confidence ?? '';
  const reason = workflowDraft.reason;
  const photoAttemptId = workflowDraft.photoAttemptId ?? '';
  const photoCaption = workflowDraft.photoCaption;
  const photoOrder = String(workflowDraft.photoOrder);
  const [observationErrors, setObservationErrors] = useState<
    readonly CalibrationDiagnostic[]
  >([]);
  const [photoStatus, setPhotoStatus] = useState('');
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);

  // ---------------------------------------------------------------------------
  // Handoff section state (generation → queue → bed-clear → lifecycle)
  // ---------------------------------------------------------------------------
  const [orchId, setOrchId] = useState<string | null>(null);
  const [orchStatus, setOrchStatus] =
    useState<CalibrationOrchestrationStatus | null>(null);
  const [orchLoading, setOrchLoading] = useState(false);
  const [orchError, setOrchError] = useState<string | null>(null);

  const [queueJobId, setQueueJobId] = useState<string | null>(null);
  const [queueJob, setQueueJob] = useState<CalibrationQueueJobState | null>(
    null,
  );

  const [bedClearOpen, setBedClearOpen] = useState(false);
  const [bedClearSubmitting, setBedClearSubmitting] = useState(false);
  const [bedClearError, setBedClearError] = useState<string | null>(null);
  const bedClearTriggerRef = useRef<HTMLButtonElement>(null);

  const [handoffProvenance, setHandoffProvenance] =
    useState<CalibrationJobProvenance | null>(null);

  const [printStatus, setPrintStatus] = useState<string | null>(null);
  const [printObservations, setPrintObservations] = useState<
    CalibrationPrintObservation[]
  >([]);
  const [isAddingObservation, setIsAddingObservation] = useState(false);
  const [observationError, setObservationError] = useState<string | null>(null);

  // On mount, load any existing queue job for this project/stage attempt.
  useEffect(() => {
    if (!store.profileId) return;
    const profileId = store.profileId;
    const projectId = state.projectId;
    let cancelled = false;
    void calibrationApi()
      .getCalibrationQueueState({ profileId, projectId })
      .then((res) => {
        if (cancelled) return;
        if (res.status === 'ok') {
          setQueueJobId(res.job.jobId);
          setQueueJob(res.job);
          if (res.job.status) setPrintStatus(res.job.status);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [store.profileId, state.projectId]);

  const handleGenerate = useCallback(async () => {
    if (!store.profileId || orchLoading) return;
    const attempt = [...state.attempts]
      .reverse()
      .find((a) => a.stageId === stageId && a.status === 'inProgress');
    if (!attempt) return;
    setOrchLoading(true);
    setOrchError(null);
    try {
      const res = await calibrationApi().startCalibrationGeneration({
        profileId: store.profileId,
        projectId: state.projectId,
        attemptId: attempt.attemptId,
        method: attempt.method,
        operationId: store.environment.createId(),
        baseRevision: null,
      });
      if (res.status === 'submitted') {
        setOrchId(res.orchestrationId);
        const statusRes =
          await calibrationApi().getCalibrationOrchestrationStatus({
            profileId: store.profileId,
            orchestrationId: res.orchestrationId,
          });
        if (statusRes.status === 'ok') {
          setOrchStatus(statusRes.orchestration);
        } else {
          setOrchError(statusRes.error.message);
        }
      } else {
        setOrchError(res.error.message);
      }
    } catch (err) {
      setOrchError(err instanceof Error ? err.message : String(err));
    } finally {
      setOrchLoading(false);
    }
  }, [
    store.profileId,
    store.environment,
    orchLoading,
    state.attempts,
    state.projectId,
    stageId,
  ]);

  const handleQueuePrint = useCallback(async () => {
    if (!store.profileId || !orchStatus?.gcodeFileId) return;
    const attempt = state.attempts.find(
      (a) => a.attemptId === orchStatus.attemptId,
    );
    if (!attempt) return;
    const printerId = state.binding.printer.backendPrinterId;
    try {
      const res = await calibrationApi().startCalibrationPrint({
        profileId: store.profileId,
        projectId: state.projectId,
        attemptId: orchStatus.attemptId,
        orchestrationId: orchStatus.id,
        gcodeFileId: orchStatus.gcodeFileId,
        assignedPrinterId: printerId,
        operationId: store.environment.createId(),
        pinnedPrinterConfigRevision:
          state.binding.printer.printerConfigurationRevision,
        gcodeContentSha256: orchStatus.gcodeSha256 ?? null,
        specificationSha256: orchStatus.specificationSha256 ?? null,
        machineProfileSha256: null,
        processProfileSha256: null,
        filamentProfileSha256: null,
        printerConfigSnapshotSha256: null,
        requiredFirmwareFamily: null,
        requiredGcodeDialect: null,
        requiredSlicerEngine: null,
        requiredSlicerDistribution: null,
        requiredSlicerVersion: orchStatus.generatorVersion ?? null,
        requiredSlicerContainerDigest: orchStatus.slicerContainerDigest ?? null,
      });
      if (res.status === 'ok') {
        setQueueJobId(res.jobId);
        const jobRes = await calibrationApi().getCalibrationQueueState({
          profileId: store.profileId,
          projectId: state.projectId,
          jobId: res.jobId,
        });
        if (jobRes.status === 'ok') {
          setQueueJob(jobRes.job);
          setPrintStatus(jobRes.job.status);
          // Construct provenance from what we know
          setHandoffProvenance({
            requiredSlicerVersion: orchStatus.generatorVersion ?? null,
            requiredGcodeDialect: null,
            requiredFirmwareFamily: null,
            requiredSlicerContainerDigest:
              orchStatus.slicerContainerDigest ?? null,
            pinnedPrinterConfigRevision:
              state.binding.printer.printerConfigurationRevision,
            jobId: res.jobId,
            assignedPrinterId: printerId,
            gcodeFileId: orchStatus.gcodeFileId,
            gcodeContentSha256: orchStatus.gcodeSha256 ?? null,
            specificationSha256: orchStatus.specificationSha256 ?? null,
            machineProfileSha256: null,
            processProfileSha256: null,
            filamentProfileSha256: null,
            printerConfigSnapshotSha256: null,
            rowVersion: res.rowVersion ?? null,
          });
        }
      }
    } catch {
      // Queue errors surface via the dispatch panel's own polling
    }
  }, [
    store.profileId,
    store.environment,
    orchStatus,
    state.attempts,
    state.binding.printer,
    state.projectId,
  ]);

  const handleJobInvalidated = useCallback((reason: string) => {
    setQueueJobId(null);
    setQueueJob(null);
    setHandoffProvenance(null);
    void reason; // Acknowledged
  }, []);

  const handleBedClearConfirm = useCallback(async () => {
    if (!store.profileId || !queueJob) return;
    setBedClearSubmitting(true);
    setBedClearError(null);
    try {
      const printerId = queueJob.assignedPrinterId ?? '';
      const res = await calibrationApi().acknowledgeCalibrationBedClear({
        profileId: store.profileId,
        jobId: queueJob.jobId,
        printerId,
        operationId: store.environment.createId(),
        rowVersion: queueJob.rowVersion ?? '',
        dispatchStateRowVersion: queueJob.dispatchStateRowVersion ?? '',
        expectedPrinterConfigRevision: null,
      });
      if (res.status === 'ok') {
        setBedClearOpen(false);
        setQueueJob((prev) =>
          prev ? { ...prev, bedClearState: 'Acknowledged' } : null,
        );
      } else {
        setBedClearError(
          res.status === 'error' ? res.error.message : 'Revision conflict.',
        );
      }
    } catch (err) {
      setBedClearError(err instanceof Error ? err.message : String(err));
    } finally {
      setBedClearSubmitting(false);
    }
  }, [store.profileId, store.environment, queueJob]);

  const handleAddObservation = useCallback(
    (
      obs: Omit<CalibrationPrintObservation, 'observationId' | 'recordedAt'>,
    ) => {
      setIsAddingObservation(true);
      setObservationError(null);
      try {
        const newObs = {
          ...obs,
          observationId: store.environment.createId(),
          recordedAt: store.environment.now(),
        } as CalibrationPrintObservation;
        setPrintObservations((prev) => [...prev, newObs]);
      } catch (err) {
        setObservationError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsAddingObservation(false);
      }
    },
    [store.environment],
  );

  const bedClearDialogJob: BedClearDialogJob | null = queueJob
    ? {
        jobId: queueJob.jobId,
        assignedPrinterId: queueJob.assignedPrinterId,
        assignedPrinterName: null,
        queueRevision: queueJob.rowVersion,
        material: null,
        nozzle: null,
        generatedTestName: null,
        acknowledgementExpiresAt: null,
      }
    : null;

  const stageAttempts = state.attempts.filter(
    (attempt) => attempt.stageId === stageId,
  );
  const activeAttempt = [...stageAttempts]
    .reverse()
    .find((attempt) => attempt.status === 'inProgress');
  const selectedAttempt = state.attempts.find(
    (attempt) => attempt.attemptId === progress.selectedAttemptId,
  );
  const photoAttempts = [
    ...new Map(
      [activeAttempt, selectedAttempt]
        .filter(
          (attempt): attempt is CalibrationAttempt => attempt !== undefined,
        )
        .map((attempt) => [attempt.attemptId, attempt]),
    ).values(),
  ];

  const availableMethods = methodsForStage(stageId, state.mode);
  useEffect(() => {
    if (method !== '' && !availableMethods.includes(method)) {
      store.updateWorkflowDraft(stageId, { ...workflowDraft, method: null });
    }
  }, [availableMethods, method, stageId, store, workflowDraft]);
  const selectedTool = state.binding.snapshot.toolheads.find(
    (tool) => tool.toolId === state.binding.selectedToolId,
  );
  const currentPhysicalMatch = isCurrentPhysicalMatch(
    state,
    project.record.workspaceState.physicalMatch,
  )
    ? project.record.workspaceState.physicalMatch
    : null;
  const runtime: RuntimeCalibrationContext = {
    online: !store.offline && store.availability?.available === true,
    pendingMutationCount: project.record.isSynced ? 0 : 1,
    unresolvedConflictCount: project.record.hasConflicts ? 1 : 0,
    currentPrinterConfigurationRevision: project.record.isPrinterContextFresh
      ? state.binding.printer.printerConfigurationRevision
      : null,
    currentSnapshotRevision: project.record.isPrinterContextFresh
      ? state.binding.snapshot.snapshotRevision
      : null,
    physicalMatch: currentPhysicalMatch,
    bedClearConfirmed: false,
    operatorPresent: false,
  };
  const generationDecision = decideCalibrationAction(
    state,
    runtime,
    'generate',
  );
  const queueDecision = decideCalibrationAction(state, runtime, 'queue');
  const startDecision = decideCalibrationAction(state, runtime, 'startPrint');
  const stepDraft = project.record.workspaceState.stepDrafts[stageId] ?? {
    prerequisites: '',
    methodNotes: '',
    expectedResult: '',
  };
  const input = primaryField(
    stageId,
    activeAttempt?.method ?? (method || undefined),
  );
  const fieldErrors = useMemo(() => {
    const grouped: Record<string, string> = {};
    for (const diagnostic of observationErrors) {
      if (diagnostic.severity === 'error')
        grouped[diagnostic.field ?? 'observation'] = diagnostic.message;
    }
    return grouped;
  }, [observationErrors]);

  const updateWorkflowDraft = (
    update: Partial<WorkspaceWorkflowDraft>,
  ): void => {
    store.updateWorkflowDraft(stageId, { ...workflowDraft, ...update });
  };
  const updateObservationDraft = (update: Partial<ObservationDraft>): void => {
    updateWorkflowDraft({
      observation: { ...workflowDraft.observation, ...update },
    });
  };
  const methodFromValue = (value: string): CalibrationMethod | null =>
    availableMethods.find((candidate) => candidate === value) ?? null;

  const begin = async (): Promise<void> => {
    if (method === '' || !availableMethods.includes(method) || !view.canStart)
      return;
    const attemptId = store.environment.createId();
    const accepted = await store.dispatchEvent({
      eventId: store.environment.createId(),
      timestamp: store.environment.now(),
      type: 'beginAttempt',
      attemptId,
      stageId,
      method,
    });
    if (accepted) {
      updateWorkflowDraft({ photoAttemptId: attemptId });
      setObservationErrors([]);
    }
  };

  const recordObservation = async (): Promise<void> => {
    if (activeAttempt === undefined) return;
    const timestamp = store.environment.now();
    const observation = observationFor(
      stageId,
      activeAttempt.attemptId,
      store.environment.createId(),
      timestamp,
      observationDraft,
    );
    if (observation === null) {
      setObservationErrors([
        {
          code: 'REQUIRED_OBSERVATION_FIELDS',
          severity: 'error',
          message: 'Enter every numeric observation field.',
          stageId,
          field: 'observation',
        },
      ]);
      window.setTimeout(
        () => document.getElementById('observation-error-summary')?.focus(),
        0,
      );
      return;
    }
    const diagnostics = validateObservation(
      observation,
      state.binding,
      activeAttempt.method,
    );
    setObservationErrors(diagnostics);
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      window.setTimeout(
        () => document.getElementById('observation-error-summary')?.focus(),
        0,
      );
      return;
    }
    const accepted = await store.dispatchEvent({
      eventId: store.environment.createId(),
      timestamp,
      type: 'recordObservation',
      attemptId: activeAttempt.attemptId,
      observation,
    });
    if (accepted) {
      updateWorkflowDraft({
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
      });
      store.announce(
        'Observation recorded in immutable attempt history. Select the result to use.',
      );
    }
  };

  const selectObservation = async (
    attemptId: string,
    observationId: string,
  ): Promise<void> => {
    await store.dispatchEvent({
      eventId: store.environment.createId(),
      timestamp: store.environment.now(),
      type: 'selectObservation',
      attemptId,
      observationId,
    });
  };

  const complete = async (): Promise<void> => {
    if (activeAttempt === undefined || confidence === '') return;
    const accepted = await store.dispatchEvent({
      eventId: store.environment.createId(),
      timestamp: store.environment.now(),
      type: 'completeAttempt',
      attemptId: activeAttempt.attemptId,
      confidence,
    });
    if (accepted) updateWorkflowDraft({ confidence: null });
  };

  const skip = async (): Promise<void> => {
    if (!view.canSkip || reason.trim() === '') return;
    const accepted = await store.dispatchEvent({
      eventId: store.environment.createId(),
      timestamp: store.environment.now(),
      type: 'skipStage',
      stageId,
      skipId: store.environment.createId(),
      reason: reason.trim(),
    });
    if (accepted) updateWorkflowDraft({ reason: '' });
  };

  const redo = async (): Promise<void> => {
    if (
      method === '' ||
      !availableMethods.includes(method) ||
      reason.trim() === ''
    )
      return;
    const attemptId = store.environment.createId();
    const accepted = await store.dispatchEvent({
      eventId: store.environment.createId(),
      timestamp: store.environment.now(),
      type: 'redoStage',
      stageId,
      attemptId,
      method,
      reason: reason.trim(),
    });
    if (accepted)
      updateWorkflowDraft({ reason: '', photoAttemptId: attemptId });
  };

  const attachPhoto = async (): Promise<void> => {
    setPhotoError(null);
    const target = photoAttempts.find(
      (attempt) => attempt.attemptId === photoAttemptId,
    );
    const order = workflowDraft.photoOrder;
    if (target === undefined) {
      setPhotoError('Select the active or selected attempt for this photo.');
      return;
    }
    if (photoCaption.trim() === '') {
      setPhotoError('Enter an accessible photo caption.');
      return;
    }
    if (!Number.isInteger(order) || order < 1 || order > 1_000) {
      setPhotoError('Photo order must be a whole number from 1 through 1000.');
      return;
    }
    setPhotoBusy(true);
    setPhotoStatus('Waiting for an approved image selection.');
    try {
      const approval = OpenCalibrationPhotoResponse.safeParse(
        await calibrationApi().openCalibrationPhoto(),
      );
      if (!approval.success) {
        setPhotoError(
          'The photo approval response was invalid. Choose the image again.',
        );
        setPhotoStatus('Photo was not staged.');
        return;
      }
      if (approval.data === null) {
        setPhotoStatus('Photo selection canceled. Nothing was staged.');
        return;
      }
      if (store.profileId === null) return;
      const photoId = store.environment.createId();
      const caption = photoCaption.trim();
      setPhotoStatus('Validating and staging approved image metadata.');
      const staged = await calibrationApi().stageCalibrationPhoto({
        profileId: store.profileId,
        projectId: state.projectId,
        attemptId: target.attemptId,
        stageId,
        photoId,
        approvalId: approval.data.approvalId,
        caption,
        order,
      });
      if (
        staged.photoId !== photoId ||
        staged.attemptId !== target.attemptId ||
        staged.stageId !== stageId ||
        staged.projectId !== state.projectId ||
        staged.profileId !== store.profileId ||
        staged.caption !== caption ||
        staged.order !== order
      ) {
        throw new Error(
          'Staged photo metadata did not match the requested project, stage, attempt, caption, and order.',
        );
      }
      await store.addPhoto(
        {
          photoId: staged.photoId,
          attemptId: staged.attemptId,
          stageId: staged.stageId,
          contentHash: staged.contentHash,
          mimeType: staged.mimeType,
          byteSize: staged.byteSize,
          status: staged.status,
          caption: staged.caption,
          order: staged.order,
          stagedAt: staged.stagedAt,
        },
        stageId,
      );
      setPhotoStatus(
        'Photo metadata staged locally; synchronization is queued.',
      );
    } catch (cause) {
      const raw = errorMessage(
        cause,
        'The approved photo could not be staged.',
      );
      const lower = raw.toLowerCase();
      const message =
        lower.includes('size') || lower.includes('20')
          ? `Photo is too large. Use an image no larger than 20 MB. ${raw}`
          : lower.includes('format') ||
              lower.includes('jpeg') ||
              lower.includes('png') ||
              lower.includes('webp')
            ? `Photo format is invalid. Use JPEG, PNG, or WebP. ${raw}`
            : lower.includes('approval') ||
                lower.includes('consum') ||
                lower.includes('reused') ||
                lower.includes('expired')
              ? `Photo approval is missing, invalid, expired, or already used. ${raw}`
              : raw;
      setPhotoError(message);
      setPhotoStatus('Photo was not staged.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const hasPersistedDraft =
    workflowDraft.method !== null ||
    Object.values(workflowDraft.observation).some(
      (value) => value !== '' && value !== false,
    ) ||
    workflowDraft.confidence !== null ||
    workflowDraft.reason !== '' ||
    workflowDraft.photoAttemptId !== null ||
    workflowDraft.photoCaption !== '' ||
    workflowDraft.photoOrder !== 1;

  const photos = project.record.workspaceState.photos.filter(
    (photo) => photo.stageId === stageId,
  );
  const canRedo = ['completed', 'skipped', 'needsRetest'].includes(
    progress.status,
  );
  const selectedCurrentObservation = selectedAttempt?.observations.find(
    (observation) =>
      observation.observationId === selectedAttempt.selectedObservationId,
  );

  return (
    <section className="cal-view" aria-labelledby="step-workflow-title">
      <header className="cal-view-heading">
        <div>
          <p className="cal-stage-position">
            Stage {definition.order + 1} of 9; {state.mode} mode
          </p>
          <h1 id="step-workflow-title" data-cal-heading tabIndex={-1}>
            {definition.title}
          </h1>
          <p className="cal-subtitle">{view.guidance}</p>
        </div>
        <div className="cal-actions">
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.navigate('overview')}
          >
            Project overview
          </button>
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.navigate('report')}
          >
            Calibration card
          </button>
        </div>
      </header>

      <p className="cal-tool-banner">
        Bound physical scope: tool{' '}
        <strong>{state.binding.selectedToolId}</strong>, toolhead{' '}
        <strong>{state.binding.selectedToolheadId}</strong>, nozzle{' '}
        <strong>{state.binding.selectedNozzleId}</strong> (
        {selectedTool?.nozzle.diameterMm} mm,{' '}
        {selectedTool?.extruderType === 'bowden' ? 'Bowden' : 'direct drive'}).
      </p>
      {!currentPhysicalMatch ? (
        <p className="cal-alert cal-alert--warning" role="alert">
          Physical tool confirmation is missing or expired. Hardware and profile
          actions are blocked.
        </p>
      ) : null}
      {view.blockers.length ? (
        <div className="cal-alert" role="alert">
          <p>This stage has unresolved dependencies:</p>
          <ul>
            {view.blockers.map((blocker) => (
              <li key={blocker.code + blocker.field}>{blocker.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="cal-step-layout">
        <div className="cal-step-main">
          <section className="cal-step-section" aria-labelledby="setup-title">
            <h2 id="setup-title">Setup notes</h2>
            <p>{view.guidance}</p>
            <p>
              <strong>Dependencies:</strong>{' '}
              {definition.dependencies.length
                ? definition.dependencies
                    .map((id) => CALIBRATION_STAGE_BY_ID[id].title)
                    .join(', ')
                : 'None'}
            </p>
            <label>
              Prerequisites and setup
              <textarea
                value={stepDraft.prerequisites}
                maxLength={2048}
                onChange={(event) =>
                  store.updateStepDraft(
                    stageId,
                    'prerequisites',
                    event.target.value,
                  )
                }
              />
            </label>
            <label>
              Method notes
              <textarea
                value={stepDraft.methodNotes}
                maxLength={4096}
                onChange={(event) =>
                  store.updateStepDraft(
                    stageId,
                    'methodNotes',
                    event.target.value,
                  )
                }
              />
            </label>
            <label>
              Expected result
              <textarea
                value={stepDraft.expectedResult}
                maxLength={2048}
                onChange={(event) =>
                  store.updateStepDraft(
                    stageId,
                    'expectedResult',
                    event.target.value,
                  )
                }
              />
            </label>
            <p className="cal-field-help">
              Setup text saves locally after a short pause.
            </p>
          </section>

          <section className="cal-step-section" aria-labelledby="method-title">
            <h2 id="method-title">Mode, method, and attempt</h2>
            <fieldset className="cal-inline-fieldset">
              <legend>Guidance mode</legend>
              {(['coach', 'expert'] as const).map((mode) => (
                <label className="cal-radio" key={mode}>
                  <input
                    type="radio"
                    name="workflow-mode"
                    checked={state.mode === mode}
                    onChange={() =>
                      void store.dispatchEvent({
                        eventId: store.environment.createId(),
                        timestamp: store.environment.now(),
                        type: 'setMode',
                        mode,
                      })
                    }
                  />
                  {mode === 'coach' ? 'Coach' : 'Expert'}
                </label>
              ))}
            </fieldset>
            {activeAttempt === undefined && hasPersistedDraft ? (
              <p className="cal-field-help" role="status">
                Draft in progress and saved locally; no immutable attempt exists
                until you choose Begin attempt.
              </p>
            ) : null}
            <label>
              Calibration method
              <select
                value={method}
                onChange={(event) =>
                  updateWorkflowDraft({
                    method: methodFromValue(event.target.value),
                  })
                }
                disabled={activeAttempt !== undefined}
              >
                <option value="">Select a method</option>
                {availableMethods.map((item) => (
                  <option key={item} value={item}>
                    {methodLabel(item)}
                  </option>
                ))}
              </select>
            </label>
            {stageId === 'pressureAdvance' ? (
              <p className="cal-field-help">
                Expert mode supports tower, line, and pattern methods. Coach
                mode uses the bounded tower method.
              </p>
            ) : null}
            {stageId === 'flowPass1' ? (
              <p className="cal-field-help">
                Expert mode supports standard, coarse, and YOLO first-pass
                methods. Coach mode uses standard.
              </p>
            ) : null}
            <button
              type="button"
              className="cal-button cal-button--primary"
              onClick={() => void begin()}
              disabled={
                !view.canStart ||
                method === '' ||
                !availableMethods.includes(method) ||
                activeAttempt !== undefined
              }
            >
              Begin attempt
            </button>
            {!view.canStart ? (
              <p className="cal-field-help">
                Resolve dependencies or use explicit redo for a resolved stage.
              </p>
            ) : null}
          </section>

          <section className="cal-step-section" aria-labelledby="handoff-title">
            <h2 id="handoff-title">Generation, queue, and print handoff</h2>
            <p>
              These controls are gated entry surfaces for the connected
              generation and printer workflows. This renderer does not implement
              those operations or claim success.
            </p>
            <div className="cal-actions">
              <button
                type="button"
                className="cal-button"
                disabled={
                  !generationDecision.allowed || orchLoading || orchId !== null
                }
                aria-describedby="generation-gate"
                onClick={() => void handleGenerate()}
              >
                Generate calibration model
              </button>
              <button
                type="button"
                className="cal-button"
                disabled={
                  !queueDecision.allowed ||
                  orchStatus?.gcodeFileId == null ||
                  queueJobId !== null
                }
                aria-describedby="queue-gate"
                onClick={() => void handleQueuePrint()}
              >
                Queue calibration print
              </button>
              <button
                ref={bedClearTriggerRef}
                type="button"
                className="cal-button"
                disabled={!queueJob || queueJob.bedClearState !== 'None'}
                aria-describedby="start-gate"
                onClick={() => setBedClearOpen(true)}
              >
                Confirm bed clear
              </button>
              <button
                type="button"
                className="cal-button"
                disabled={
                  !startDecision.allowed ||
                  queueJob?.bedClearState !== 'Acknowledged'
                }
                aria-describedby="start-gate"
              >
                Start calibration print
              </button>
            </div>
            <div className="cal-gate-list">
              <p id="generation-gate">
                <strong>Generation gate:</strong>{' '}
                {generationDecision.allowed
                  ? 'Runtime safety gates pass; complete the generation workflow when available.'
                  : generationDecision.blockers
                      .map((item) => item.message)
                      .join(' ')}
              </p>
              <p id="queue-gate">
                <strong>Queue gate:</strong>{' '}
                {queueDecision.allowed
                  ? 'Runtime safety gates pass; connected queue handoff is not implemented here.'
                  : queueDecision.blockers
                      .map((item) => item.message)
                      .join(' ')}
              </p>
              <p id="start-gate">
                <strong>Print-start gate:</strong>{' '}
                {startDecision.blockers.map((item) => item.message).join(' ')}
              </p>
            </div>

            {/* Orchestration progress — criterion 4 */}
            {orchId !== null && (
              <CalibrationOrchestrationProgress
                orchestration={orchStatus}
                isLoading={orchLoading}
                fetchError={orchError}
              />
            )}

            {/* Queue/dispatch panel — criteria 7, 8, 9, 10 */}
            {queueJobId !== null && (
              <CalibrationQueueDispatchPanel
                profileId={store.profileId ?? ''}
                projectId={state.projectId}
                jobId={queueJobId}
                api={calibrationApi()}
                printerOffline={
                  store.offline || store.availability?.available !== true
                }
                blockedReason={null}
                onJobInvalidated={handleJobInvalidated}
              />
            )}

            {/* Immutable provenance — criterion 11 */}
            {handoffProvenance !== null && (
              <CalibrationProvenance provenance={handoffProvenance} />
            )}

            {/* Print lifecycle and result entry — criterion 13 */}
            {queueJobId !== null && printStatus !== null && (
              <CalibrationPrintLifecycle
                jobId={queueJobId}
                attemptId={orchId ?? ''}
                jobStatus={printStatus}
                observations={printObservations}
                onAddObservation={handleAddObservation}
                isAddingObservation={isAddingObservation}
                observationError={observationError}
                createId={store.environment.createId}
                now={store.environment.now}
              />
            )}

            {/* Bed-clear safety dialog — criteria 7, 12 */}
            {bedClearDialogJob !== null && (
              <CalibrationBedClearDialog
                open={bedClearOpen}
                onConfirm={() => void handleBedClearConfirm()}
                onCancel={() => setBedClearOpen(false)}
                job={bedClearDialogJob}
                blocked={{ kind: 'ready' }}
                isSubmitting={bedClearSubmitting}
                submissionError={bedClearError}
              />
            )}
          </section>

          <section
            className="cal-step-section"
            aria-labelledby="observations-title"
          >
            <h2 id="observations-title">Observations</h2>
            {activeAttempt ? (
              <p role="status">
                Attempt {activeAttempt.ordinal} is in progress using{' '}
                {methodLabel(activeAttempt.method)}.
              </p>
            ) : (
              <p>
                No active attempt. You may prepare and save observation fields,
                but Begin or redo is required before recording an immutable row.
              </p>
            )}
            {observationErrors.length ? (
              <div
                id="observation-error-summary"
                className="cal-error-summary"
                role="alert"
                tabIndex={-1}
              >
                <h3>Observation needs attention</h3>
                <ul>
                  {observationErrors.map((diagnostic, index) => (
                    <li key={`${diagnostic.code}-${index}`}>
                      {diagnostic.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {input ? (
              <label>
                {input.label} ({input.unit})
                <input
                  type="number"
                  min={input.min}
                  max={input.max}
                  step={input.step}
                  value={observationDraft.primary}
                  onChange={(event) =>
                    updateObservationDraft({ primary: event.target.value })
                  }
                  aria-invalid={Boolean(
                    fieldErrors[input.field] || fieldErrors.observation,
                  )}
                  aria-describedby={
                    fieldErrors[input.field]
                      ? `observation-${input.field}-error`
                      : fieldErrors.observation
                        ? 'observation-general-error'
                        : undefined
                  }
                />
                {fieldErrors[input.field] ? (
                  <span
                    id={`observation-${input.field}-error`}
                    className="cal-field-error"
                  >
                    {fieldErrors[input.field]}
                  </span>
                ) : null}
              </label>
            ) : (
              <fieldset className="cal-measurement-grid">
                <legend>
                  Nominal and measured cooled coupon dimensions (mm)
                </legend>
                {(
                  [
                    ['nominalXmm', 'Nominal X'],
                    ['measuredXmm', 'Measured X'],
                    ['nominalYmm', 'Nominal Y'],
                    ['measuredYmm', 'Measured Y'],
                    ['nominalZmm', 'Nominal Z'],
                    ['measuredZmm', 'Measured Z'],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field}>
                    {label}
                    <input
                      type="number"
                      min="0.001"
                      step="0.001"
                      value={observationDraft[field]}
                      onChange={(event) =>
                        updateObservationDraft({ [field]: event.target.value })
                      }
                      aria-invalid={Boolean(
                        fieldErrors[field] || fieldErrors.observation,
                      )}
                      aria-describedby={
                        fieldErrors[field]
                          ? `observation-${field}-error`
                          : undefined
                      }
                    />
                    {fieldErrors[field] ? (
                      <span
                        id={`observation-${field}-error`}
                        className="cal-field-error"
                      >
                        {fieldErrors[field]}
                      </span>
                    ) : null}
                  </label>
                ))}
              </fieldset>
            )}
            {usesQuality(stageId) ? (
              <label>
                Visual quality (1 to 5)
                <input
                  type="number"
                  min={CALIBRATION_BOUNDS.quality.minimum}
                  max={CALIBRATION_BOUNDS.quality.maximum}
                  step={1}
                  value={observationDraft.quality}
                  onChange={(event) =>
                    updateObservationDraft({ quality: event.target.value })
                  }
                  aria-invalid={Boolean(
                    fieldErrors.quality || fieldErrors.observation,
                  )}
                  aria-describedby={
                    fieldErrors.quality
                      ? 'observation-quality-error'
                      : fieldErrors.observation
                        ? 'observation-general-error'
                        : undefined
                  }
                />
                {fieldErrors.quality ? (
                  <span
                    id="observation-quality-error"
                    className="cal-field-error"
                  >
                    {fieldErrors.quality}
                  </span>
                ) : null}
              </label>
            ) : null}
            {stageId === 'flowVerification' ||
            stageId === 'finalVerification' ? (
              <label className="cal-checkbox">
                <input
                  type="checkbox"
                  checked={observationDraft.passed}
                  onChange={(event) =>
                    updateObservationDraft({ passed: event.target.checked })
                  }
                />
                Verification passed cleanly
              </label>
            ) : null}
            <label>
              Observation notes
              <textarea
                value={observationDraft.notes}
                maxLength={4_096}
                onChange={(event) =>
                  updateObservationDraft({ notes: event.target.value })
                }
              />
            </label>
            {fieldErrors.observation ? (
              <p id="observation-general-error" className="cal-field-error">
                {fieldErrors.observation}
              </p>
            ) : null}
            <button
              type="button"
              className="cal-button"
              onClick={() => void recordObservation()}
              disabled={!activeAttempt}
            >
              Add observation row
            </button>

            {activeAttempt?.observations.length ? (
              <fieldset className="cal-observation-list">
                <legend>Select the observation to use</legend>
                {activeAttempt.observations.map((observation) => (
                  <label
                    className="cal-choice-row"
                    key={observation.observationId}
                  >
                    <input
                      type="radio"
                      name="selected-observation"
                      checked={
                        activeAttempt.selectedObservationId ===
                        observation.observationId
                      }
                      onChange={() =>
                        void selectObservation(
                          activeAttempt.attemptId,
                          observation.observationId,
                        )
                      }
                    />
                    <span>
                      <strong>{observationSummary(observation)}</strong>
                      <small>
                        {observation.notes || 'No notes'};{' '}
                        {formatTimestamp(observation.observedAt)}
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </section>

          <section
            className="cal-step-section"
            aria-labelledby="completion-title"
          >
            <h2 id="completion-title">Complete, skip, or redo</h2>
            <fieldset className="cal-inline-fieldset">
              <legend>Confidence in selected result</legend>
              {(['low', 'medium', 'high'] as const).map((item) => (
                <label className="cal-radio" key={item}>
                  <input
                    type="radio"
                    name="confidence"
                    checked={confidence === item}
                    onChange={() => updateWorkflowDraft({ confidence: item })}
                  />
                  {item}
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className="cal-button cal-button--primary"
              onClick={() => void complete()}
              disabled={
                !activeAttempt?.selectedObservationId || confidence === ''
              }
            >
              Complete attempt with selected result
            </button>
            <label>
              Skip or redo reason
              <input
                value={reason}
                onChange={(event) =>
                  updateWorkflowDraft({ reason: event.target.value })
                }
              />
            </label>
            <div className="cal-actions">
              <button
                type="button"
                className="cal-button"
                onClick={() => void skip()}
                disabled={!view.canSkip || reason.trim() === ''}
              >
                Skip stage with reason
              </button>
              <button
                type="button"
                className="cal-button"
                onClick={() => void redo()}
                disabled={
                  !canRedo ||
                  reason.trim() === '' ||
                  method === '' ||
                  !availableMethods.includes(method)
                }
              >
                Redo as new immutable attempt
              </button>
            </div>
            {!view.canSkip ? (
              <p className="cal-field-help">
                This stage cannot be skipped in the current mode or while
                dependencies are unresolved.
              </p>
            ) : null}
          </section>

          <section className="cal-step-section" aria-labelledby="photos-title">
            <h2 id="photos-title">Photo evidence</h2>
            <p>
              Photos are represented by safe metadata and captions only. Image
              paths and thumbnails are never exposed to this renderer.
            </p>
            <label>
              Attempt
              <select
                value={photoAttemptId}
                onChange={(event) =>
                  updateWorkflowDraft({
                    photoAttemptId: event.target.value || null,
                  })
                }
                aria-invalid={Boolean(photoError)}
                aria-describedby={
                  photoError ? 'photo-attachment-error' : undefined
                }
              >
                <option value="">Select active or selected attempt</option>
                {photoAttempts.map((attempt) => (
                  <option key={attempt.attemptId} value={attempt.attemptId}>
                    Attempt {attempt.ordinal}; {attempt.status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Accessible caption
              <input
                value={photoCaption}
                maxLength={512}
                onChange={(event) =>
                  updateWorkflowDraft({ photoCaption: event.target.value })
                }
                aria-invalid={Boolean(photoError)}
                aria-describedby={
                  photoError ? 'photo-attachment-error' : undefined
                }
              />
            </label>
            <label>
              Reading order
              <input
                type="number"
                min="1"
                max="1000"
                step="1"
                value={photoOrder}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  updateWorkflowDraft({
                    photoOrder:
                      Number.isInteger(value) && value >= 1 && value <= 1_000
                        ? value
                        : 1,
                  });
                }}
                aria-invalid={Boolean(photoError)}
                aria-describedby={
                  photoError ? 'photo-attachment-error' : undefined
                }
              />
            </label>
            <button
              type="button"
              className="cal-button"
              onClick={() => void attachPhoto()}
              disabled={photoAttempts.length === 0 || photoBusy}
            >
              {photoBusy
                ? 'Staging approved photo'
                : 'Choose and stage approved photo'}
            </button>
            {photoAttempts.length === 0 ? (
              <p className="cal-field-help">
                Photo attachment is available only for the active or selected
                attempt.
              </p>
            ) : null}
            {photoStatus ? <p role="status">{photoStatus}</p> : null}
            {photoError ? (
              <p
                id="photo-attachment-error"
                className="cal-field-error"
                role="alert"
              >
                {photoError}
              </p>
            ) : null}
            {photos.length ? (
              <ol className="cal-photo-list">
                {photos.map((photo) => (
                  <li
                    key={photo.photoId}
                    aria-label={`Photo evidence: ${photo.caption}; ${photo.mimeType}; ${photo.byteSize} bytes; ${photo.status}`}
                  >
                    <strong>{photo.caption}</strong>
                    <span>
                      {photo.mimeType}; {photo.byteSize} bytes; {photo.status};
                      content {photo.contentHash.slice(0, 12)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No photo metadata is attached to this stage.</p>
            )}
          </section>
        </div>

        <aside
          className="cal-step-aside"
          aria-label="Attempt history and recommendations"
        >
          <section className="cal-pane cal-detail-pane">
            <h2>Stage state</h2>
            <dl className="cal-definition-list">
              <div>
                <dt>Status</dt>
                <dd>{progress.status}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{state.mode}</dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>{stageAttempts.length}</dd>
              </div>
              <div>
                <dt>Selected tool</dt>
                <dd>{state.binding.selectedToolId}</dd>
              </div>
            </dl>
            {progress.skip ? (
              <p>
                <strong>Skip reason:</strong> {progress.skip.reason}
              </p>
            ) : null}
            {progress.retestReason ? (
              <p>
                <strong>Retest reason:</strong> {progress.retestReason}
              </p>
            ) : null}
          </section>
          <section className="cal-pane cal-detail-pane">
            <h2>Immutable attempts</h2>
            {stageAttempts.length ? (
              <ol className="cal-attempt-list">
                {stageAttempts.map((attempt) => (
                  <li key={attempt.attemptId}>
                    <strong>
                      Attempt {attempt.ordinal}; {attempt.status}
                      {progress.selectedAttemptId === attempt.attemptId
                        ? '; selected'
                        : ''}
                    </strong>
                    <span>
                      {methodLabel(attempt.method)}; started{' '}
                      {formatTimestamp(attempt.startedAt)}
                    </span>
                    <span>
                      {attempt.observations.length} observation rows
                      {attempt.confidence
                        ? `; ${attempt.confidence} confidence`
                        : ''}
                    </span>
                    {attempt.observations.length ? (
                      <ol>
                        {attempt.observations.map((observation) => (
                          <li key={observation.observationId}>
                            {observationSummary(observation)}
                            {attempt.selectedObservationId ===
                            observation.observationId
                              ? '; selected result'
                              : ''}
                            {observation.notes ? `; ${observation.notes}` : ''}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {attempt.recommendation ? (
                      <p>
                        {attempt.recommendation.summary}{' '}
                        {attempt.recommendation.rationale}
                      </p>
                    ) : null}
                    {attempt.diagnostics.length ? (
                      <ul>
                        {attempt.diagnostics.map((diagnostic, index) => (
                          <li key={`${diagnostic.code}-${index}`}>
                            {diagnostic.severity}: {diagnostic.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : (
              <p>No attempts recorded.</p>
            )}
          </section>
          {selectedCurrentObservation && selectedAttempt?.recommendation ? (
            <section className="cal-pane cal-detail-pane">
              <h2>Selected recommendation</h2>
              <p>{observationSummary(selectedCurrentObservation)}</p>
              <p>
                <strong>{selectedAttempt.recommendation.summary}</strong>
              </p>
              <p>{selectedAttempt.recommendation.rationale}</p>
            </section>
          ) : null}
          {state.diagnostics.filter(
            (diagnostic) => diagnostic.stageId === stageId,
          ).length ? (
            <section className="cal-pane cal-detail-pane">
              <h2>Workflow diagnostics</h2>
              <ul className="cal-blocker-list">
                {state.diagnostics
                  .filter((diagnostic) => diagnostic.stageId === stageId)
                  .map((diagnostic, index) => (
                    <li key={`${diagnostic.code}-${index}`}>
                      {diagnostic.message}
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
