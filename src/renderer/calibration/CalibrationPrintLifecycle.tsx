/**
 * CalibrationPrintLifecycle
 *
 * Print lifecycle panel with append-only observation history (criterion 13).
 *
 * Reconciles job status: Queued|Assigned|Starting|Printing|Paused|Completed|
 * Failed|Cancelled. Once the print is terminal, allows appending observations.
 *
 * APPEND-ONLY: earlier observations are never mutated or deleted. Each new
 * observation is appended with a generated ID and the current timestamp.
 */

import React, { useState, useCallback } from 'react';
import type { CalibrationPrintObservation } from '@shared/ipc';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PrintJobStatus =
  | 'Queued'
  | 'Assigned'
  | 'Starting'
  | 'Printing'
  | 'Paused'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

interface CalibrationPrintLifecycleProps {
  readonly jobId: string;
  readonly attemptId: string;
  /** Current job status string (from server — treated as opaque, not enum). */
  readonly jobStatus: string;
  /** Existing observations (append-only; never mutated here). */
  readonly observations: readonly CalibrationPrintObservation[];
  /** Called when the user adds a new observation. */
  readonly onAddObservation: (
    observation: Omit<
      CalibrationPrintObservation,
      'observationId' | 'recordedAt'
    >,
  ) => void;
  /** Whether an observation submission is in progress. */
  readonly isAddingObservation: boolean;
  /** Error from the last observation attempt, or null. */
  readonly observationError: string | null;
  /** Function to generate a new UUID. */
  readonly createId: () => string;
  /** Function to get the current ISO timestamp. */
  readonly now: () => string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusLabel(status: string): string {
  switch (status as PrintJobStatus) {
    case 'Queued':
      return 'Queued';
    case 'Assigned':
      return 'Assigned';
    case 'Starting':
      return 'Starting…';
    case 'Printing':
      return 'Printing';
    case 'Paused':
      return 'Paused';
    case 'Completed':
      return '✓ Completed';
    case 'Failed':
      return '✗ Failed';
    case 'Cancelled':
      return '⊘ Cancelled';
    default:
      return status;
  }
}

function isTerminalStatus(status: string): boolean {
  return ['Completed', 'Failed', 'Cancelled'].includes(status);
}

// ---------------------------------------------------------------------------
// Add Observation Form
// ---------------------------------------------------------------------------

interface AddObservationFormProps {
  readonly jobId: string;
  readonly attemptId: string;
  readonly onSubmit: (
    obs: Omit<CalibrationPrintObservation, 'observationId' | 'recordedAt'>,
  ) => void;
  readonly isSubmitting: boolean;
  readonly error: string | null;
}

const AddObservationForm: React.FC<AddObservationFormProps> = ({
  jobId,
  attemptId,
  onSubmit,
  isSubmitting,
  error,
}) => {
  const [selectedResult, setSelectedResult] = useState<
    'accepted' | 'rejected' | 'inconclusive' | ''
  >('');
  const [confidence, setConfidence] = useState<'low' | 'medium' | 'high' | ''>(
    '',
  );
  const [retestRequired, setRetestRequired] = useState(false);
  const [notes, setNotes] = useState('');

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      onSubmit({
        attemptId,
        jobId,
        selectedResult: selectedResult || null,
        confidence: confidence || null,
        retestRequired,
        notes,
        photoIds: [],
      });
    },
    [
      jobId,
      attemptId,
      selectedResult,
      confidence,
      retestRequired,
      notes,
      onSubmit,
    ],
  );

  return (
    <form
      className="calibration-print-lifecycle__add-observation"
      onSubmit={handleSubmit}
      aria-label="Add print observation"
    >
      <fieldset disabled={isSubmitting}>
        <legend>Add Observation</legend>

        <div className="calibration-print-lifecycle__field">
          <label htmlFor="obs-result">Result</label>
          <select
            id="obs-result"
            value={selectedResult}
            onChange={(e) =>
              setSelectedResult(e.target.value as typeof selectedResult)
            }
          >
            <option value="">— select result —</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="inconclusive">Inconclusive</option>
          </select>
        </div>

        <div className="calibration-print-lifecycle__field">
          <label htmlFor="obs-confidence">Confidence</label>
          <select
            id="obs-confidence"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value as typeof confidence)}
          >
            <option value="">— select confidence —</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        <div className="calibration-print-lifecycle__field">
          <label htmlFor="obs-retest">
            <input
              id="obs-retest"
              type="checkbox"
              checked={retestRequired}
              onChange={(e) => setRetestRequired(e.target.checked)}
            />{' '}
            Retest required
          </label>
        </div>

        <div className="calibration-print-lifecycle__field">
          <label htmlFor="obs-notes">Notes</label>
          <textarea
            id="obs-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={4096}
            rows={4}
            placeholder="Optional notes about this print result…"
          />
        </div>

        {error && (
          <div
            className="calibration-print-lifecycle__error"
            role="alert"
            aria-live="assertive"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          className="calibration-print-lifecycle__submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Saving…' : 'Add Observation'}
        </button>
      </fieldset>
    </form>
  );
};

// ---------------------------------------------------------------------------
// Observation history
// ---------------------------------------------------------------------------

function ObservationHistoryItem({
  observation,
  index,
}: {
  readonly observation: CalibrationPrintObservation;
  readonly index: number;
}): React.ReactNode {
  return (
    <li
      className="calibration-print-lifecycle__observation"
      aria-label={`Observation ${index + 1}`}
    >
      <dl>
        <div>
          <dt>Recorded</dt>
          <dd>
            <time dateTime={observation.recordedAt}>
              {new Date(observation.recordedAt).toLocaleString()}
            </time>
          </dd>
        </div>
        {observation.selectedResult && (
          <div>
            <dt>Result</dt>
            <dd>{observation.selectedResult}</dd>
          </div>
        )}
        {observation.confidence && (
          <div>
            <dt>Confidence</dt>
            <dd>{observation.confidence}</dd>
          </div>
        )}
        <div>
          <dt>Retest Required</dt>
          <dd>{observation.retestRequired ? 'Yes' : 'No'}</dd>
        </div>
        {observation.notes && (
          <div>
            <dt>Notes</dt>
            <dd>{observation.notes}</dd>
          </div>
        )}
        {observation.photoIds.length > 0 && (
          <div>
            <dt>Photos</dt>
            <dd>{observation.photoIds.length} attached</dd>
          </div>
        )}
      </dl>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const CalibrationPrintLifecycle: React.FC<
  CalibrationPrintLifecycleProps
> = ({
  jobId,
  attemptId,
  jobStatus,
  observations,
  onAddObservation,
  isAddingObservation,
  observationError,
}) => {
  const terminal = isTerminalStatus(jobStatus);

  return (
    <section
      className="calibration-print-lifecycle"
      aria-label="Print lifecycle"
    >
      <h3 className="calibration-print-lifecycle__heading">Print Status</h3>

      <div
        className={`calibration-print-lifecycle__status calibration-print-lifecycle__status--${jobStatus.toLowerCase()}`}
        aria-live="polite"
        aria-atomic="true"
      >
        {statusLabel(jobStatus)}
      </div>

      {/* Observation history (append-only — never mutated) */}
      <div className="calibration-print-lifecycle__history">
        <h4 className="calibration-print-lifecycle__history-heading">
          Observations
          <span
            className="calibration-print-lifecycle__count"
            aria-label="observation count"
          >
            {' '}
            ({observations.length})
          </span>
        </h4>

        {observations.length === 0 ? (
          <p className="calibration-print-lifecycle__empty">
            No observations recorded yet.
            {!terminal &&
              ' Observations can be added once the print completes.'}
          </p>
        ) : (
          <ol
            className="calibration-print-lifecycle__observations"
            aria-label="Print observation history"
          >
            {observations.map((obs, i) => (
              <ObservationHistoryItem
                key={obs.observationId}
                observation={obs}
                index={i}
              />
            ))}
          </ol>
        )}
      </div>

      {/* Add observation — only available after terminal status */}
      {terminal && (
        <AddObservationForm
          jobId={jobId}
          attemptId={attemptId}
          onSubmit={onAddObservation}
          isSubmitting={isAddingObservation}
          error={observationError}
        />
      )}
      {!terminal && (
        <p
          className="calibration-print-lifecycle__not-terminal"
          aria-live="polite"
        >
          Observations can be added once the print completes, fails, or is
          cancelled.
        </p>
      )}
    </section>
  );
};

export default CalibrationPrintLifecycle;
