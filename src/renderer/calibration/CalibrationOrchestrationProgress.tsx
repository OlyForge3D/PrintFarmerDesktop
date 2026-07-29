/**
 * CalibrationOrchestrationProgress
 *
 * Displays the current orchestration stage for a calibration generation run.
 *
 * IMPORTANT CONTRACT NOTES:
 * - `status` and `currentStep` are FREE-FORM strings from the server saga,
 *   NOT enums. Never switch exhaustively on them. Never crash on an
 *   unrecognised value — always render something meaningful.
 * - This component never directly calls the preload bridge. It receives
 *   already-fetched data as props.
 */

import React from 'react';
import type { CalibrationOrchestrationStatus } from '@shared/ipc';

interface CalibrationOrchestrationProgressProps {
  /**
   * Orchestration status from the main process (Zod-validated by IPC layer).
   * null = not yet loaded.
   */
  readonly orchestration: CalibrationOrchestrationStatus | null;
  /** Whether a fetch is in progress. */
  readonly isLoading: boolean;
  /** Error from the last fetch, or null. */
  readonly fetchError: string | null;
}

/**
 * Map a free-form orchestration status string to a display label.
 * Never crashes on unrecognised values.
 */
function formatStatus(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  // Well-known values from the PrintFarmer saga
  switch (status.toLowerCase()) {
    case 'running':
      return 'Running';
    case 'completed':
    case 'complete':
      return 'Completed';
    case 'failed':
    case 'faulted':
      return 'Failed';
    case 'cancelled':
    case 'canceled':
      return 'Cancelled';
    case 'pending':
    case 'scheduled':
      return 'Pending';
    default:
      // Unknown value — render verbatim rather than hiding or crashing.
      return status;
  }
}

/**
 * Determine ARIA live region type for a status string.
 */
function statusAriaRole(status: string | null | undefined): 'status' | 'alert' {
  if (!status) return 'status';
  const lower = status.toLowerCase();
  if (lower.includes('fail') || lower.includes('fault')) return 'alert';
  return 'status';
}

export const CalibrationOrchestrationProgress: React.FC<
  CalibrationOrchestrationProgressProps
> = ({ orchestration, isLoading, fetchError }) => {
  if (isLoading) {
    return (
      <div
        className="calibration-orchestration-progress calibration-orchestration-progress--loading"
        aria-busy="true"
        aria-label="Loading orchestration status"
      >
        <span
          className="calibration-orchestration-progress__spinner"
          aria-hidden="true"
        />
        <span>Loading orchestration status…</span>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div
        className="calibration-orchestration-progress calibration-orchestration-progress--error"
        role="alert"
        aria-live="assertive"
      >
        <span
          className="calibration-orchestration-progress__error-icon"
          aria-hidden="true"
        >
          ⚠
        </span>
        <span>Failed to load orchestration status: {fetchError}</span>
      </div>
    );
  }

  if (!orchestration) {
    return (
      <div className="calibration-orchestration-progress calibration-orchestration-progress--empty">
        No orchestration data available.
      </div>
    );
  }

  const displayStatus = formatStatus(orchestration.status);
  const role = statusAriaRole(orchestration.status);

  return (
    <div
      className="calibration-orchestration-progress"
      role={role}
      aria-live="polite"
      aria-atomic="true"
    >
      <dl className="calibration-orchestration-progress__details">
        <div className="calibration-orchestration-progress__row">
          <dt>Orchestration ID</dt>
          <dd>
            <code className="calibration-orchestration-progress__id">
              {orchestration.id}
            </code>
          </dd>
        </div>
        <div className="calibration-orchestration-progress__row">
          <dt>Status</dt>
          <dd
            className={`calibration-orchestration-progress__status calibration-orchestration-progress__status--${orchestration.status.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
          >
            {displayStatus}
          </dd>
        </div>
        <div className="calibration-orchestration-progress__row">
          <dt>Current Step</dt>
          {/*
           * currentStep is a free-form string from the saga — render
           * verbatim without mapping. Never blank on an unknown value.
           */}
          <dd className="calibration-orchestration-progress__step">
            {orchestration.currentStep}
          </dd>
        </div>
        {orchestration.lastErrorCode && (
          <div className="calibration-orchestration-progress__row calibration-orchestration-progress__row--error">
            <dt>Error Code</dt>
            <dd role="alert" aria-live="assertive">
              <code>{orchestration.lastErrorCode}</code>
            </dd>
          </div>
        )}
        {orchestration.problems.length > 0 && (
          <div className="calibration-orchestration-progress__row">
            <dt>Problems</dt>
            <dd>
              <ul role="alert" aria-live="assertive">
                {orchestration.problems.map((p, i) => (
                  <li key={p.code + String(i)}>
                    <strong>{p.code}</strong>: {p.message}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {orchestration.completedAtUtc && (
          <div className="calibration-orchestration-progress__row">
            <dt>Completed At</dt>
            <dd>
              <time dateTime={orchestration.completedAtUtc}>
                {new Date(orchestration.completedAtUtc).toLocaleString()}
              </time>
            </dd>
          </div>
        )}
        {orchestration.retryCount > 0 && (
          <div className="calibration-orchestration-progress__row">
            <dt>Retry Count</dt>
            <dd>{orchestration.retryCount}</dd>
          </div>
        )}
      </dl>
    </div>
  );
};

export default CalibrationOrchestrationProgress;
