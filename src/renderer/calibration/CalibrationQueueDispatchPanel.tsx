/**
 * CalibrationQueueDispatchPanel
 *
 * Queue state and dispatch outcome panel (criteria 7, 9, 10, issue #54).
 *
 * Key requirements:
 * - Shows queue state and dispatch outcome for a calibration job.
 * - UNKNOWN dispatch outcome stays displayed as "Starting", with
 *   reconciliation guidance and NO blind-retry affordance (criterion 9).
 * - Typed blocked reasons (criterion 10): never free text; uses
 *   CalibrationBlockedReason discriminated union.
 * - Reconciliation loop: polls GET /api/job-queue/changes via
 *   `pollCalibrationQueueChanges` IPC, detects gaps, refetches.
 * - Printer-group envelopes are REDACTED — never treated as job state.
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import type {
  CalibrationQueueJobState,
  CalibrationBlockedReason,
  CalibrationPollQueueChangesRequest,
  CalibrationQueueEventEnvelope,
} from '@shared/ipc';
import type { CalibrationApi } from './api.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DispatchOutcome =
  'InProgress' | 'Accepted' | 'Rejected' | 'FailedBeforeStart' | 'Unknown';

type PrintJobStatus =
  | 'Queued'
  | 'Assigned'
  | 'Starting'
  | 'Printing'
  | 'Paused'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

interface CalibrationQueueDispatchPanelProps {
  readonly profileId: string;
  readonly projectId: string;
  readonly jobId: string | null;
  readonly api: CalibrationApi;
  /** Whether we know the printer is offline (from telemetry). */
  readonly printerOffline: boolean;
  /** Typed blocked reason, if any. */
  readonly blockedReason: CalibrationBlockedReason | null;
  /** Called when the panel detects the job has been reordered/replaced/cancelled. */
  readonly onJobInvalidated: (reason: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a job status. */
function statusLabel(status: string | null): string {
  if (!status) return 'Unknown';
  switch (status as PrintJobStatus) {
    case 'Queued':
      return 'Queued — waiting for printer';
    case 'Assigned':
      return 'Assigned to printer';
    case 'Starting':
      return 'Starting…';
    case 'Printing':
      return 'Printing';
    case 'Paused':
      return 'Paused';
    case 'Completed':
      return 'Completed';
    case 'Failed':
      return 'Failed';
    case 'Cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

/** Human-readable label for a dispatch outcome. */
function outcomeLabel(outcome: string | null): string {
  if (!outcome) return 'Unknown';
  switch (outcome as DispatchOutcome) {
    case 'InProgress':
      return 'Dispatch in progress…';
    case 'Accepted':
      return 'Accepted';
    case 'Rejected':
      return 'Rejected';
    case 'FailedBeforeStart':
      return 'Failed before start';
    case 'Unknown':
      // criterion 9: Unknown stays displayed as "Starting", no blind-retry.
      return 'Starting';
    default:
      return outcome;
  }
}

/** Whether this status is terminal. */
function isTerminal(status: string | null): boolean {
  if (!status) return false;
  return ['Completed', 'Failed', 'Cancelled'].includes(status);
}

/** Whether this status or outcome indicates the job is invalidated. */
function isJobInvalidated(status: string | null): boolean {
  return status === 'Cancelled';
}

// ---------------------------------------------------------------------------
// Reconciliation loop
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;
const POLL_LIMIT = 200;

/**
 * Reconciliation hook: polls the queue change feed, detects gaps,
 * and calls `onEvent` for each relevant event for this job.
 *
 * On gap detection, calls `onGapDetected` so the parent can refetch
 * the full job state over REST.
 *
 * Stops polling once `active` becomes false or the component unmounts.
 */
function useQueueReconciliation(
  profileId: string,
  jobId: string | null,
  api: CalibrationApi,
  active: boolean,
  onEvent: (event: CalibrationQueueEventEnvelope) => void,
  onGapDetected: () => void,
) {
  const cursorRef = useRef<number>(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!jobId || !active) return;

    let cancelled = false;
    let timeoutHandle: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (cancelled || !activeRef.current) return;
      try {
        const req: CalibrationPollQueueChangesRequest = {
          profileId,
          afterSequence: cursorRef.current,
          limit: POLL_LIMIT,
        };
        const result = await api.pollCalibrationQueueChanges(req);
        if (cancelled) return;
        if (result.status === 'ok') {
          if (result.gapDetected) {
            onGapDetected();
          }
          // Process events relevant to this job.
          // CRITICAL: Printer-group envelopes are REDACTED — skip them.
          // Only process envelopes that have a matching jobId.
          for (const evt of result.events) {
            if (evt.jobId === jobId) {
              onEvent(evt);
            }
          }
          cursorRef.current = result.nextSequence;
        }
      } catch {
        // Log but never surface a reconciliation polling error as a fatal.
        console.warn('[CalibrationQueueDispatchPanel] poll error (retrying)');
      }

      if (!cancelled && activeRef.current) {
        timeoutHandle = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    // First poll immediately, then on interval.
    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timeoutHandle);
    };
  }, [profileId, jobId, active, api, onEvent, onGapDetected]);
}

// ---------------------------------------------------------------------------
// Blocked reason display
// ---------------------------------------------------------------------------

function BlockedReasonDisplay({
  reason,
}: {
  readonly reason: CalibrationBlockedReason;
}): React.ReactNode {
  const messages: Record<string, string> = {
    staleTelemetry: 'Stale telemetry',
    firmwareChange: 'Firmware changed since job creation',
    configChange: 'Configuration changed',
    materialMismatch: 'Material mismatch',
    maintenanceBusy: 'Printer in maintenance',
    missingGcode: 'G-code file unavailable',
    permissionFailure: 'Permission denied',
    printerOffline: 'Printer is offline',
    acknowledgementExpired: 'Acknowledgement has expired',
    jobReordered: 'Job was reordered — acknowledgement invalid',
  };
  return (
    <div
      className="calibration-queue-dispatch__blocked"
      role="alert"
      aria-live="assertive"
    >
      <strong>{messages[reason.code] ?? reason.code}:</strong> {reason.detail}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CalibrationQueueDispatchPanel: React.FC<
  CalibrationQueueDispatchPanelProps
> = ({
  profileId,
  projectId,
  jobId,
  api,
  printerOffline,
  blockedReason,
  onJobInvalidated,
}) => {
  const [queueState, setQueueState] = useState<CalibrationQueueJobState | null>(
    null,
  );
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isRefetching, setIsRefetching] = useState(false);

  // Fetch the full job state over REST (used on gap detection and mount).
  const refetchJobState = useCallback(async () => {
    if (!jobId) return;
    setIsRefetching(true);
    try {
      const result = await api.getCalibrationQueueState({
        profileId,
        projectId,
        jobId,
      });
      if (result.status === 'ok') {
        setQueueState(result.job);
        setFetchError(null);
        if (isJobInvalidated(result.job?.status ?? null)) {
          onJobInvalidated('Job was cancelled or replaced.');
        }
      } else {
        setFetchError(result.error.message ?? 'Failed to fetch job state.');
      }
    } catch (error) {
      setFetchError(
        error instanceof Error ? error.message : 'Unknown fetch error.',
      );
    } finally {
      setIsRefetching(false);
    }
  }, [api, jobId, profileId, projectId, onJobInvalidated]);

  // Initial fetch
  useEffect(() => {
    void refetchJobState();
  }, [refetchJobState]);

  // Handle an event from the reconciliation loop.
  const handleEvent = useCallback(
    (event: CalibrationQueueEventEnvelope) => {
      // Update local state from the event (optimistic update).
      // On gap, we rely on refetchJobState for correctness.
      setQueueState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: event.jobStatus ?? prev.status,
          dispatchAttemptOutcome:
            event.attemptOutcome ?? prev.dispatchAttemptOutcome,
          bedClearState: event.bedClearState ?? prev.bedClearState,
          rowVersion: event.jobRevision ?? prev.rowVersion,
        };
      });
      if (isJobInvalidated(event.jobStatus)) {
        onJobInvalidated('Job was cancelled.');
      }
    },
    [onJobInvalidated],
  );

  // Reconciliation loop — stop once job is terminal.
  const isActive = !isTerminal(queueState?.status ?? null);
  useQueueReconciliation(
    profileId,
    jobId,
    api,
    isActive,
    handleEvent,
    () => void refetchJobState(),
  );

  // Offline guard: never offer acknowledgement when printer is offline.
  const canAcknowledge =
    !printerOffline &&
    !blockedReason &&
    queueState?.bedClearState === 'None' &&
    !isTerminal(queueState?.status ?? null);

  if (!jobId) {
    return (
      <div className="calibration-queue-dispatch calibration-queue-dispatch--no-job">
        No calibration print job is queued.
      </div>
    );
  }

  return (
    <div
      className="calibration-queue-dispatch"
      aria-label="Queue and dispatch status"
    >
      <h3 className="calibration-queue-dispatch__heading">Queue State</h3>

      {fetchError && (
        <div
          className="calibration-queue-dispatch__error"
          role="alert"
          aria-live="assertive"
        >
          {fetchError}
          <button
            type="button"
            className="calibration-queue-dispatch__retry"
            onClick={() => void refetchJobState()}
          >
            Retry
          </button>
        </div>
      )}

      {isRefetching && (
        <div
          className="calibration-queue-dispatch__loading"
          aria-busy="true"
          aria-live="polite"
        >
          Refreshing job state…
        </div>
      )}

      {printerOffline && (
        <div
          className="calibration-queue-dispatch__offline"
          role="alert"
          aria-live="assertive"
        >
          Printer is offline. Acknowledgement is not available.
        </div>
      )}

      {blockedReason && <BlockedReasonDisplay reason={blockedReason} />}

      {queueState && (
        <dl className="calibration-queue-dispatch__details">
          <div className="calibration-queue-dispatch__row">
            <dt>Job ID</dt>
            <dd>
              <code>{queueState.jobId}</code>
            </dd>
          </div>
          <div className="calibration-queue-dispatch__row">
            <dt>Status</dt>
            <dd
              className={`calibration-queue-dispatch__status calibration-queue-dispatch__status--${(queueState.status ?? 'unknown').toLowerCase()}`}
              aria-live="polite"
              aria-atomic="true"
            >
              {statusLabel(queueState.status ?? null)}
            </dd>
          </div>
          {queueState.dispatchAttemptOutcome != null && (
            <div className="calibration-queue-dispatch__row">
              <dt>Dispatch Outcome</dt>
              <dd aria-live="polite" aria-atomic="true">
                {outcomeLabel(queueState.dispatchAttemptOutcome)}
                {/*
                 * criterion 9: Unknown outcome stays "Starting".
                 * No blind-retry affordance — only show reconciliation guidance.
                 */}
                {queueState.dispatchAttemptOutcome === 'Unknown' && (
                  <p
                    className="calibration-queue-dispatch__unknown-guidance"
                    role="note"
                  >
                    The server has not yet confirmed whether the print started.
                    The status will update automatically when the result is
                    known. Do not retry — a duplicate print may result.
                  </p>
                )}
              </dd>
            </div>
          )}
          {queueState.bedClearState != null && (
            <div className="calibration-queue-dispatch__row">
              <dt>Bed Clear State</dt>
              <dd aria-live="polite" aria-atomic="true">
                {queueState.bedClearState}
              </dd>
            </div>
          )}
          {queueState.rowVersion && (
            <div className="calibration-queue-dispatch__row">
              <dt>Queue Revision</dt>
              <dd>
                <code>{queueState.rowVersion}</code>
              </dd>
            </div>
          )}
        </dl>
      )}

      {canAcknowledge && (
        <p
          className="calibration-queue-dispatch__ack-available"
          aria-live="polite"
        >
          Bed-clear acknowledgement is available. Use the Confirm Bed Clear
          button when the bed is ready.
        </p>
      )}
    </div>
  );
};

export default CalibrationQueueDispatchPanel;
