/**
 * Result entry after print completion (L-02, L-03, L-05, L-06).
 *
 * Guides user through result selection, confidence, retest decision, and notes.
 * Queue completion alone does NOT mark the step complete — this gate must be
 * satisfied first (L-05). Shows immutable attempt→orchestration→artifact→job
 * links (L-02).
 */
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import type { CalibrationStageId } from './domain';
import type { CalibrationQueueJobState } from '@shared/ipc';

interface CalibrationResultEntryPanelProps {
  readonly stageId: CalibrationStageId;
  readonly job: CalibrationQueueJobState;
  readonly orchestrationId: string | null;
  readonly attemptId: string | null;
}

export function CalibrationResultEntryPanel({
  stageId,
  job,
  orchestrationId,
  attemptId,
}: CalibrationResultEntryPanelProps): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const project = store.activeProject;
  const workflowDraft = project?.record.workspaceState.workflowDrafts[stageId];
  const confidence = workflowDraft?.confidence ?? '';
  const notes = workflowDraft?.observation.notes ?? '';

  return (
    <section
      className="cal-step-section cal-result-entry-panel"
      aria-labelledby="result-entry-title"
    >
      <h2 id="result-entry-title">Record calibration result</h2>

      {/* L-02: Immutable attempt→orchestration→artifact→job links */}
      <div className="cal-result-links" data-testid="result-immutable-links">
        <h3>Immutable attempt chain</h3>
        <dl>
          {attemptId ? (
            <>
              <dt>Attempt ID</dt>
              <dd data-testid="result-link-attempt-id">
                <code>{attemptId.slice(0, 8)}…</code>
              </dd>
            </>
          ) : null}
          {orchestrationId ? (
            <>
              <dt>Orchestration ID</dt>
              <dd data-testid="result-link-orchestration-id">
                <code>{orchestrationId.slice(0, 8)}…</code>
              </dd>
            </>
          ) : null}
          {job.gcodeFileId ? (
            <>
              <dt>G-code artifact ID</dt>
              <dd data-testid="result-link-gcode-id">
                <code>{job.gcodeFileId.slice(0, 8)}…</code>
              </dd>
            </>
          ) : null}
          <dt>Print job ID</dt>
          <dd data-testid="result-link-job-id">
            <code>{job.jobId.slice(0, 8)}…</code>
          </dd>
        </dl>
        <p className="cal-field-help">
          These links are immutable and stored with the attempt record. Queue
          completion alone does not mark this step complete (L-05).
        </p>
      </div>

      {/* L-03: Result entry */}
      <div className="cal-result-entry" data-testid="result-entry-form">
        <p role="status" aria-live="polite" data-testid="result-entry-prompt">
          Print completed. Enter your result to complete this calibration step.
        </p>

        <fieldset
          className="cal-inline-fieldset"
          data-testid="result-outcome-fieldset"
        >
          <legend>Calibration result</legend>
          {(['pass', 'fail', 'inconclusive'] as const).map((value) => (
            <label className="cal-radio" key={value}>
              <input
                type="radio"
                name="cal-result-outcome"
                value={value}
                checked={workflowDraft?.observation.primary === value}
                onChange={() =>
                  workflowDraft &&
                  store.updateWorkflowDraft(stageId, {
                    ...workflowDraft,
                    observation: {
                      ...workflowDraft.observation,
                      primary: value,
                    },
                  })
                }
                data-testid={`result-outcome-${value}`}
              />
              {value.charAt(0).toUpperCase() + value.slice(1)}
            </label>
          ))}
        </fieldset>

        <fieldset
          className="cal-inline-fieldset"
          data-testid="result-confidence-fieldset"
        >
          <legend>Confidence in this result</legend>
          {(['low', 'medium', 'high'] as const).map((level) => (
            <label className="cal-radio" key={level}>
              <input
                type="radio"
                name="cal-result-confidence"
                value={level}
                checked={confidence === level}
                onChange={() =>
                  workflowDraft &&
                  store.updateWorkflowDraft(stageId, {
                    ...workflowDraft,
                    confidence: level,
                  })
                }
                data-testid={`result-confidence-${level}`}
              />
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </label>
          ))}
        </fieldset>

        <fieldset
          className="cal-inline-fieldset"
          data-testid="result-retest-fieldset"
        >
          <legend>Retest needed?</legend>
          {(['YES', 'NO', 'PENDING'] as const).map((decision) => (
            <label className="cal-radio" key={decision}>
              <input
                type="radio"
                name="cal-result-retest"
                value={decision}
                checked={workflowDraft?.observation.quality === decision}
                onChange={() =>
                  workflowDraft &&
                  store.updateWorkflowDraft(stageId, {
                    ...workflowDraft,
                    observation: {
                      ...workflowDraft.observation,
                      quality: decision,
                    },
                  })
                }
                data-testid={`result-retest-${decision}`}
              />
              {decision}
            </label>
          ))}
        </fieldset>

        <label>
          Observation notes
          <textarea
            value={notes}
            maxLength={4096}
            placeholder="Enter calibration result notes…"
            onChange={(event) =>
              workflowDraft &&
              store.updateWorkflowDraft(stageId, {
                ...workflowDraft,
                observation: {
                  ...workflowDraft.observation,
                  notes: event.target.value,
                },
              })
            }
            data-testid="result-notes-input"
          />
        </label>

        {/* L-05: Gate — cannot mark complete without result */}
        <p
          className="cal-field-help"
          data-testid="result-gate-notice"
          role="status"
        >
          You must enter a result and confidence before completing this step.
          Queue completion alone is not sufficient (L-05).
        </p>

        <button
          type="button"
          className="cal-button cal-button--primary"
          disabled={
            !workflowDraft?.observation.primary ||
            workflowDraft.observation.primary === '' ||
            confidence === ''
          }
          onClick={() => void store.completeAttemptWithResult(stageId)}
          data-testid="result-complete-btn"
        >
          Complete attempt with this result
        </button>
      </div>
    </section>
  );
}
