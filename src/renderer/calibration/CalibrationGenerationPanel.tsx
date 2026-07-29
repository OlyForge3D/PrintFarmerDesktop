import { useRef } from 'react';
import type { CalibrationOrchestrationStatus } from '@shared/ipc';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import type { CalibrationStageId } from './domain';
import type { GenerationStartParams } from './workspaceTypes';

interface CalibrationGenerationPanelProps {
  readonly stageId: CalibrationStageId;
  readonly method: string;
  readonly attemptId: string;
}

/** Ordered durable stage names per the PrintFarmer orchestration saga (G-05). */
const ORCHESTRATION_STAGES = [
  'ModelAccepted',
  'SlicingQueued',
  'SlicingClaimed',
  'SlicingProgress',
  'ArtifactValidated',
  'Promoted',
  'QueueJobCreated',
] as const;

type OrchestrationStageName = (typeof ORCHESTRATION_STAGES)[number];

function stageLabel(stage: OrchestrationStageName): string {
  switch (stage) {
    case 'ModelAccepted':
      return 'Model accepted';
    case 'SlicingQueued':
      return 'Slicing queued';
    case 'SlicingClaimed':
      return 'Slicing claimed';
    case 'SlicingProgress':
      return 'Slicing in progress';
    case 'ArtifactValidated':
      return 'Artifact validated';
    case 'Promoted':
      return 'G-code promoted';
    case 'QueueJobCreated':
      return 'Print job created in queue';
  }
}

function stageStatus(
  stageName: OrchestrationStageName,
  orchestration: CalibrationOrchestrationStatus | null,
): 'pending' | 'current' | 'complete' | 'failed' {
  if (orchestration === null) return 'pending';
  const step = orchestration.currentStep ?? '';
  const status = orchestration.status ?? '';
  if (
    status === 'Failed' &&
    ORCHESTRATION_STAGES.indexOf(stageName) <=
      ORCHESTRATION_STAGES.indexOf(step as OrchestrationStageName)
  ) {
    return 'failed';
  }
  const currentIndex = ORCHESTRATION_STAGES.indexOf(
    step as OrchestrationStageName,
  );
  const stageIndex = ORCHESTRATION_STAGES.indexOf(stageName);
  if (currentIndex === -1) return stageIndex === 0 ? 'current' : 'pending';
  if (stageIndex < currentIndex) return 'complete';
  if (stageIndex === currentIndex) return 'current';
  return 'pending';
}

/** Render a truncated hash for display (G-07). */
function shortHash(hash: string | null): string | null {
  return hash ? hash.slice(0, 12) + '…' : null;
}

export function CalibrationGenerationPanel({
  stageId,
  method,
  attemptId,
}: CalibrationGenerationPanelProps): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const { generationState, profileId, activeProject } = store;
  const startBtnRef = useRef<HTMLButtonElement>(null);

  const isCurrentStage = generationState?.stageId === stageId;
  const orchestration = isCurrentStage ? generationState?.orchestration : null;
  const isSubmitting = isCurrentStage && (generationState?.submitting ?? false);
  const isPolling = isCurrentStage && (generationState?.polling ?? false);
  const genError = isCurrentStage ? (generationState?.error ?? null) : null;

  const projectId = activeProject?.record.projectId ?? null;

  const isFailed =
    isCurrentStage && (orchestration?.status === 'Failed' || genError !== null);

  /** Existing operationId if a failed generation is in state (for retry same). */
  const existingOperationId = isCurrentStage
    ? (generationState?.operationId ?? null)
    : null;

  const buildParams = (operationId: string): GenerationStartParams => ({
    profileId: profileId ?? '',
    projectId: projectId ?? '',
    attemptId,
    operationId,
    stageId,
    method,
    definitionVersion: '1',
    baseRevision:
      orchestration?.revision != null ? orchestration.revision : null,
    /* methodOptions: null = server default. When the UI exposes per-method
     * options, derive them from the stage/method definition and pass here. */
    methodOptions: null,
  });

  const handleStartGeneration = async (): Promise<void> => {
    if (
      profileId === null ||
      projectId === null ||
      method === '' ||
      isSubmitting
    )
      return;
    await store.startGeneration(buildParams(store.environment.createId()));
  };

  /**
   * L-04: Reconcile existing operation (same operationId — idempotent replay).
   * Does NOT create a new UUID; the server deduplicates.
   */
  const handleRetryGeneration = async (): Promise<void> => {
    if (
      profileId === null ||
      projectId === null ||
      method === '' ||
      isSubmitting ||
      existingOperationId === null
    )
      return;
    await store.retryGeneration(buildParams(existingOperationId));
  };

  /**
   * L-04: Start a new calibration attempt with a fresh operationId.
   * Old attempt/generation/job history is preserved intact.
   */
  const handleNewAttempt = async (): Promise<void> => {
    if (
      profileId === null ||
      projectId === null ||
      method === '' ||
      isSubmitting
    )
      return;
    await store.retryWithNewAttempt(buildParams(store.environment.createId()));
  };

  const handlePollStatus = async (): Promise<void> => {
    if (!isCurrentStage || orchestration === null || isPolling) return;
    await store.pollOrchestrationStatus(orchestration.orchestrationId);
  };

  const hasJobCreated =
    orchestration?.currentStep === 'QueueJobCreated' ||
    orchestration?.status === 'Completed';

  return (
    <section
      className="cal-step-section cal-generation-panel"
      aria-labelledby="generation-panel-title"
    >
      <h2 id="generation-panel-title">PrintFarmer generation</h2>

      {/* G-03: Method/specification preview before POST */}
      <div className="cal-generation-preview">
        <p>
          <strong>Method:</strong> {method || <em>No method selected</em>}
        </p>
        <p>
          <strong>Stage:</strong> {stageId}
        </p>
        <p>
          <strong>Project:</strong> {projectId ?? 'Not available'}
        </p>
        {orchestration?.specificationSha256 ? (
          <p>
            <strong>Specification SHA-256:</strong>{' '}
            <code data-testid="spec-sha256">
              {shortHash(orchestration.specificationSha256)}
            </code>
          </p>
        ) : null}
        {orchestration?.generatorVersion ? (
          <p>
            <strong>Generator version:</strong>{' '}
            <code data-testid="generator-version">
              {orchestration.generatorVersion}
            </code>
          </p>
        ) : null}
        {orchestration?.slicerContainerDigest ? (
          <p>
            <strong>Slicer container digest:</strong>{' '}
            <code data-testid="slicer-digest">
              {shortHash(orchestration.slicerContainerDigest)}
            </code>
          </p>
        ) : null}
      </div>

      {/* G-07: Promoted G-code hashes after completion */}
      {orchestration &&
      (orchestration.planManifestSha256 || orchestration.gcodeSha256) ? (
        <div className="cal-generation-hashes" data-testid="generation-hashes">
          <h3>Provenance hashes</h3>
          {orchestration.planManifestSha256 ? (
            <p>
              <strong>Plan manifest SHA-256:</strong>{' '}
              <code data-testid="plan-sha256">
                {shortHash(orchestration.planManifestSha256)}
              </code>
            </p>
          ) : null}
          {orchestration.gcodeSha256 ? (
            <p>
              <strong>G-code SHA-256:</strong>{' '}
              <code data-testid="gcode-sha256">
                {shortHash(orchestration.gcodeSha256)}
              </code>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* G-05: Durable orchestration stage progress */}
      <div
        className="cal-orchestration-stages"
        aria-label="Orchestration stage progress"
        data-testid="orchestration-stages"
      >
        <ol>
          {ORCHESTRATION_STAGES.map((stage) => {
            const status = stageStatus(stage, orchestration ?? null);
            return (
              <li
                key={stage}
                data-stage={stage}
                data-stage-status={status}
                aria-label={`${stageLabel(stage)}: ${status}`}
              >
                <span className={`cal-stage-indicator cal-stage-${status}`}>
                  {status === 'complete'
                    ? '✓'
                    : status === 'current'
                      ? '→'
                      : status === 'failed'
                        ? '✗'
                        : '○'}
                </span>{' '}
                {stageLabel(stage)}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Error display */}
      {genError ? (
        <p
          className="cal-alert cal-alert--error"
          role="alert"
          aria-live="polite"
        >
          {genError}
        </p>
      ) : null}

      {/* Structured failure problems (G-09) */}
      {orchestration?.problems && orchestration.problems.length > 0 ? (
        <div
          className="cal-generation-problems"
          role="alert"
          aria-live="polite"
        >
          <p>Generation encountered problems:</p>
          <ul>
            {orchestration.problems.map((problem, i) => (
              <li key={i}>
                <strong>[{problem.code}]</strong>{' '}
                {problem.field ? `${problem.field}: ` : ''}
                {problem.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Controls */}
      <div className="cal-generation-actions">
        {!isCurrentStage || generationState?.error != null ? (
          <button
            type="button"
            className="cal-button cal-button--primary"
            ref={startBtnRef}
            disabled={
              isSubmitting ||
              method === '' ||
              profileId === null ||
              projectId === null
            }
            aria-busy={isSubmitting}
            onClick={() => void handleStartGeneration()}
            data-testid="start-generation-btn"
          >
            {isSubmitting
              ? 'Submitting to PrintFarmer…'
              : 'Start generation on PrintFarmer'}
          </button>
        ) : null}

        {/* L-04: Retry same operation (reconcile existing — no new UUID) */}
        {isFailed && existingOperationId !== null ? (
          <button
            type="button"
            className="cal-button cal-button--secondary"
            disabled={isSubmitting || method === '' || profileId === null}
            aria-busy={isSubmitting}
            onClick={() => void handleRetryGeneration()}
            data-testid="retry-generation-btn"
            title="Reconcile the existing operation using the same idempotency ID"
          >
            {isSubmitting ? 'Reconciling…' : 'Reconcile operation'}
          </button>
        ) : null}

        {/* L-04: New attempt (fresh operationId, preserves old history) */}
        {isFailed ? (
          <button
            type="button"
            className="cal-button cal-button--secondary"
            disabled={isSubmitting || method === '' || profileId === null}
            aria-busy={isSubmitting}
            onClick={() => void handleNewAttempt()}
            data-testid="new-attempt-btn"
            title="Start a new calibration attempt; the old attempt history is preserved"
          >
            {isSubmitting ? 'Starting…' : 'New attempt'}
          </button>
        ) : null}

        {isCurrentStage &&
        orchestration !== null &&
        !hasJobCreated &&
        orchestration.status !== 'Failed' ? (
          <button
            type="button"
            className="cal-button"
            disabled={isPolling}
            aria-busy={isPolling}
            onClick={() => void handlePollStatus()}
            data-testid="poll-orchestration-btn"
          >
            {isPolling ? 'Refreshing…' : 'Refresh status'}
          </button>
        ) : null}

        {isCurrentStage && !hasJobCreated ? (
          <button
            type="button"
            className="cal-button cal-button--secondary"
            onClick={() => store.clearGenerationState(stageId)}
            data-testid="clear-generation-btn"
          >
            Clear generation state
          </button>
        ) : null}
      </div>

      {hasJobCreated ? (
        <p className="cal-generation-success" role="status" aria-live="polite">
          Print job created in queue. See print queue panel below.
        </p>
      ) : null}
    </section>
  );
}
