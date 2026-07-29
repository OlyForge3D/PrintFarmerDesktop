import { useEffect, useRef, useState } from 'react';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import type { CalibrationStageId } from './domain';

interface CalibrationQueuePanelProps {
  readonly stageId: CalibrationStageId;
}

/** Display a human-readable label for a CalibrationBlockedReason code (Q-05, L-06). */
function blockedReasonLabel(code: string): string {
  switch (code) {
    case 'staleTelemetry':
      return 'Stale printer telemetry — refresh or reconnect the printer';
    case 'changedFirmwareOrConfig':
      return 'Firmware or configuration changed since project was created';
    case 'materialNozzleMismatch':
      return 'Loaded material or nozzle does not match the calibration project';
    case 'maintenanceOrBusy':
      return 'Printer is in maintenance mode or currently busy';
    case 'missingGcode':
      return 'Calibration G-code file is missing from the queue job';
    case 'permissionDenied':
      return 'You do not have permission to start this print job';
    case 'offline':
      return 'Printer or server is offline';
    case 'unsynchronized':
      return 'Local calibration state is not synchronized with the server';
    case 'unauthorized':
      return 'Authentication required — sign in again';
    case 'expired':
      return 'Bed-clear acknowledgement has expired — reopen the dialog';
    case 'noKlipperPrinter':
      return 'Assigned printer does not report Klipper firmware';
    case 'staleContext':
      return 'Printer context is stale — refresh the printer context';
    default:
      return `Blocked: ${code}`;
  }
}

/** Format a UTC ISO timestamp to a local time string for expiry display (B-01). */
function formatExpiry(utcIso: string | null): string | null {
  if (!utcIso) return null;
  const ts = Date.parse(utcIso);
  if (!Number.isFinite(ts)) return null;
  const remaining = Math.floor((ts - Date.now()) / 1000);
  if (remaining <= 0) return 'Expired';
  if (remaining < 60) return `${remaining}s remaining`;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}m ${seconds}s remaining`;
}

/** Outcome display for bed-clear acknowledgement result (B-03, B-04). */
function BedClearOutcomeMessage({
  outcome,
}: {
  outcome: NonNullable<
    ReturnType<typeof useCalibrationWorkspaceStore>['bedClearDialog']['outcome']
  >;
}): React.JSX.Element {
  switch (outcome.kind) {
    case 'starting':
      return (
        <p
          className="cal-bed-clear-outcome cal-bed-clear-outcome--starting"
          role="status"
          aria-live="polite"
          data-testid="bed-clear-outcome-starting"
        >
          Job starting. The job is now in <strong>Starting</strong> state.
          Reconcile from REST if you need to confirm progress — no automatic
          retry is offered.
        </p>
      );
    case 'alreadyStarting':
      return (
        <p
          className="cal-bed-clear-outcome cal-bed-clear-outcome--starting"
          role="status"
          aria-live="polite"
          data-testid="bed-clear-outcome-already-starting"
        >
          Job was already starting (idempotent replay). No duplicate created.
        </p>
      );
    case 'conflict':
      return (
        <p
          className="cal-bed-clear-outcome cal-bed-clear-outcome--conflict"
          role="alert"
          aria-live="polite"
          data-testid="bed-clear-outcome-conflict"
        >
          Conflict ({outcome.reason}): {outcome.detail ?? 'dialog dismissed'}.
          Dialog closed. Open again only when the queue state has changed.
        </p>
      );
    case 'staleRevision':
      return (
        <p
          className="cal-bed-clear-outcome cal-bed-clear-outcome--stale"
          role="status"
          aria-live="polite"
          data-testid="bed-clear-outcome-stale"
        >
          Queue revision changed. Refetching authoritative state before you can
          try again.
        </p>
      );
    case 'printerOffline':
      return (
        <p
          className="cal-bed-clear-outcome cal-bed-clear-outcome--offline"
          role="alert"
          aria-live="polite"
          data-testid="bed-clear-outcome-offline"
        >
          Printer offline or stale telemetry:{' '}
          {outcome.detail ?? 'No detail available'}. Acknowledgement not
          consumed. No automatic retry.
        </p>
      );
    case 'preconditionRequired':
      return (
        <p
          className="cal-bed-clear-outcome cal-bed-clear-outcome--error"
          role="alert"
          aria-live="polite"
          data-testid="bed-clear-outcome-precondition"
        >
          Server requires the Idempotency-Key and ETag headers.{' '}
          {outcome.detail ?? ''}
        </p>
      );
  }
}

function BedClearDialog(): React.JSX.Element | null {
  const store = useCalibrationWorkspaceStore();
  const { bedClearDialog, queueJobState } = store;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const job = queueJobState?.job ?? null;

  /* Focus trap: restore focus to the trigger on close (accessibility). */
  const triggerFocusRef = useRef<HTMLElement | null>(null);

  /* B-06: Live countdown — tick every second so users see the expiry update. */
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!bedClearDialog.open) return;
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [bedClearDialog.open]);

  useEffect(() => {
    if (bedClearDialog.open) {
      triggerFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      dialogRef.current?.showModal?.();
      confirmBtnRef.current?.focus();
    } else {
      dialogRef.current?.close?.();
      triggerFocusRef.current?.focus();
      triggerFocusRef.current = null;
    }
  }, [bedClearDialog.open]);

  /* B-06 Tab/Shift+Tab focus trap — cycles focus among enabled focusable elements. */
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handler = (event: Event): void => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((e) => !e.closest('[inert]'));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, []);

  /* Escape key closes dialog (B-06: withheld when not safe). */
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handler = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') {
        event.preventDefault();
        store.closeBedClearDialog();
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [store]);

  if (!bedClearDialog.open) return null;

  const expiry = job ? formatExpiry(job.bedClearExpiresAtUtc) : null;
  const isExpired = expiry === 'Expired';

  const outcome = bedClearDialog.outcome;
  /* Conflict and expired outcomes: dialog is dismissed, nothing to show. */
  const isDismissed =
    outcome?.kind === 'conflict' || outcome?.kind === 'staleRevision';

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby="bed-clear-dialog-title"
      className="cal-bed-clear-dialog"
      data-testid="bed-clear-dialog"
    >
      <h2 id="bed-clear-dialog-title" tabIndex={-1}>
        Acknowledge bed clear and start print
      </h2>

      {/* B-01: exact job, printer, revision, material/nozzle, expiry */}
      <dl className="cal-bed-clear-details">
        <dt>Job ID</dt>
        <dd data-testid="bed-clear-job-id">{job?.jobId ?? 'Unknown'}</dd>

        <dt>G-code file</dt>
        <dd data-testid="bed-clear-gcode">{job?.gcodeFileName ?? '—'}</dd>

        <dt>Assigned printer</dt>
        <dd data-testid="bed-clear-printer">
          {job?.assignedPrinterName ?? 'Unknown'} (
          {job?.assignedPrinterId ?? 'No ID'})
        </dd>

        <dt>Queue revision (ETag)</dt>
        <dd data-testid="bed-clear-etag">{job?.jobEtag ?? 'Not available'}</dd>

        <dt>Dispatch state revision</dt>
        <dd data-testid="bed-clear-dispatch-revision">
          {job?.dispatchStateRevision != null
            ? String(job.dispatchStateRevision)
            : 'Not available'}
        </dd>

        <dt>Required nozzle</dt>
        <dd data-testid="bed-clear-nozzle">
          {job?.requiredNozzleDiameter != null
            ? `${job.requiredNozzleDiameter} mm`
            : '—'}
        </dd>

        <dt>Required material</dt>
        <dd data-testid="bed-clear-material">
          {job?.requiredMaterialType ?? '—'}
        </dd>

        <dt>Bed-clear expiry</dt>
        <dd data-testid="bed-clear-expiry" aria-live="polite">
          {expiry ?? 'None'}
        </dd>

        <dt>Pinned config revision</dt>
        <dd data-testid="bed-clear-config-rev">
          {job?.pinnedPrinterConfigRevision != null
            ? String(job.pinnedPrinterConfigRevision)
            : '—'}
        </dd>
      </dl>

      {isExpired ? (
        <p className="cal-alert cal-alert--warning" role="alert">
          The bed-clear acknowledgement has expired. Close this dialog and
          refresh the queue state before trying again (B-06).
        </p>
      ) : null}

      {bedClearDialog.error ? (
        <p
          className="cal-alert cal-alert--error"
          role="alert"
          aria-live="polite"
        >
          {bedClearDialog.error}
        </p>
      ) : null}

      {outcome ? <BedClearOutcomeMessage outcome={outcome} /> : null}

      <div className="cal-bed-clear-actions">
        {!isDismissed ? (
          <button
            type="button"
            className="cal-button cal-button--primary"
            ref={confirmBtnRef}
            disabled={
              bedClearDialog.acknowledging ||
              isExpired ||
              job === null ||
              bedClearDialog.operationId === null
            }
            aria-busy={bedClearDialog.acknowledging}
            onClick={() => void store.acknowledgeBedClear()}
            data-testid="bed-clear-confirm-btn"
          >
            {bedClearDialog.acknowledging
              ? 'Acknowledging…'
              : 'Acknowledge bed clear and start'}
          </button>
        ) : null}
        <button
          type="button"
          className="cal-button cal-button--secondary"
          ref={closeBtnRef}
          onClick={() => store.closeBedClearDialog()}
          data-testid="bed-clear-close-btn"
        >
          {isDismissed ? 'Close' : 'Cancel'}
        </button>
      </div>
    </dialog>
  );
}

export function CalibrationQueuePanel({
  stageId,
}: CalibrationQueuePanelProps): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const { queueJobState, bedClearDialog, profileId } = store;

  const isCurrentStage = queueJobState?.stageId === stageId;
  const loading = isCurrentStage && (queueJobState?.loading ?? false);
  const queueError = isCurrentStage ? (queueJobState?.error ?? null) : null;
  const job = isCurrentStage ? (queueJobState?.job ?? null) : null;
  const blockedReasons = isCurrentStage
    ? (queueJobState?.blockedReasons ?? [])
    : [];
  /* Show the panel controls when this is the current stage OR when no queue state
   * has been loaded yet (null state = user can initiate the first fetch). */
  const showControls = isCurrentStage || queueJobState === null;

  const jobStatus = job?.jobStatus ?? null;
  const awaitsBedClear =
    jobStatus === 'Assigned' &&
    job?.bedClearExpiresAtUtc != null &&
    job.assignedPrinterId != null;

  const handleRefreshQueue = async (): Promise<void> => {
    if (profileId === null) return;
    await store.refreshQueueState(job?.jobId ?? null);
  };

  return (
    <section
      className="cal-step-section cal-queue-panel"
      aria-labelledby="queue-panel-title"
    >
      <h2 id="queue-panel-title">Print queue status</h2>

      {/* Q-01: Authoritative REST queue/job state */}
      {job ? (
        <dl className="cal-queue-details">
          <dt>Job ID</dt>
          <dd data-testid="queue-job-id">{job.jobId}</dd>

          <dt>Status</dt>
          <dd
            data-testid="queue-job-status"
            aria-live="polite"
            aria-label={`Print lifecycle: ${jobStatus ?? 'Unknown'}`}
          >
            {jobStatus ?? 'Unknown'}
          </dd>

          <dt>Assigned printer</dt>
          <dd data-testid="queue-printer">
            {job.assignedPrinterName || '—'}{' '}
            {job.assignedPrinterId ? `(${job.assignedPrinterId})` : ''}
          </dd>

          <dt>Queue position</dt>
          <dd data-testid="queue-position">{job.queuePosition}</dd>

          <dt>Priority</dt>
          <dd data-testid="queue-priority">{job.priority}</dd>

          <dt>Required nozzle</dt>
          <dd data-testid="queue-nozzle">
            {job.requiredNozzleDiameter != null
              ? `${job.requiredNozzleDiameter} mm`
              : '—'}
          </dd>

          <dt>Required material</dt>
          <dd data-testid="queue-material">
            {job.requiredMaterialType ?? '—'}
          </dd>

          {job.bedClearExpiresAtUtc ? (
            <>
              <dt>Bed-clear expiry</dt>
              <dd data-testid="queue-bed-clear-expiry" aria-live="polite">
                {formatExpiry(job.bedClearExpiresAtUtc) ?? '—'}
              </dd>
            </>
          ) : null}

          <dt>G-code file</dt>
          <dd data-testid="queue-gcode">{job.gcodeFileName || '—'}</dd>
        </dl>
      ) : (
        !loading && (
          <p className="cal-queue-empty" data-testid="queue-no-job">
            No active print job for this stage.
          </p>
        )
      )}

      {/* Q-05: Typed blocked reasons display */}
      {blockedReasons.length > 0 ? (
        <div
          className="cal-queue-blocked"
          role="alert"
          aria-live="polite"
          data-testid="queue-blocked-reasons"
        >
          <p>Queue is blocked:</p>
          <ul>
            {blockedReasons.map((reason, i) => (
              <li
                key={i}
                data-blocked-code={reason.code}
                data-testid={`blocked-reason-${reason.code}`}
              >
                {blockedReasonLabel(reason.code)}
                {reason.detail ? ` — ${reason.detail}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {queueError ? (
        <p
          className="cal-alert cal-alert--error"
          role="alert"
          aria-live="polite"
        >
          {queueError}
        </p>
      ) : null}

      {loading ? (
        <p role="status" aria-live="polite" aria-busy="true">
          Loading queue state…
        </p>
      ) : null}

      {/* Lifecycle state (L-01 through L-07) */}
      {jobStatus ? (
        <div
          className="cal-lifecycle-state"
          data-testid="lifecycle-state"
          aria-label={`Current print lifecycle state: ${jobStatus}`}
        >
          <p>
            <strong>Print lifecycle:</strong>{' '}
            <span
              data-testid="lifecycle-status-label"
              className={`cal-lifecycle-badge cal-lifecycle-${jobStatus.toLowerCase()}`}
            >
              {jobStatus}
            </span>
          </p>

          {/* Starting state without blind retry (B-04) */}
          {jobStatus === 'Starting' ? (
            <p
              className="cal-alert cal-alert--info"
              role="status"
              aria-live="polite"
              data-testid="starting-no-retry-notice"
            >
              Job is starting. Reconcile from REST to confirm progress. No
              automatic retry is offered for uncertain starts.
            </p>
          ) : null}

          {/* Completed/Failed/Cancelled: preserve history, offer new attempt (L-04) */}
          {jobStatus === 'Completed' ||
          jobStatus === 'Failed' ||
          jobStatus === 'Cancelled' ? (
            <p
              className="cal-lifecycle-terminal"
              role="status"
              aria-live="polite"
              data-testid="lifecycle-terminal-notice"
            >
              {jobStatus === 'Completed'
                ? 'Print completed. Enter observations below to record results.'
                : `Print ${jobStatus.toLowerCase()}. History preserved. Use "Redo" to start a new attempt.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Controls */}
      <div className="cal-queue-actions">
        {showControls ? (
          <button
            type="button"
            className="cal-button"
            disabled={loading}
            aria-busy={loading}
            onClick={() => void handleRefreshQueue()}
            data-testid="refresh-queue-btn"
          >
            {loading ? 'Refreshing…' : 'Refresh queue state'}
          </button>
        ) : null}

        {/* B-01 through B-07: bed-clear dialog trigger */}
        {awaitsBedClear &&
        !bedClearDialog.open &&
        !blockedReasons.some((r) => r.code === 'noKlipperPrinter') ? (
          <button
            type="button"
            className="cal-button cal-button--primary"
            onClick={() => store.openBedClearDialog()}
            data-testid="open-bed-clear-btn"
          >
            Acknowledge bed clear and start print
          </button>
        ) : null}
        {awaitsBedClear &&
        blockedReasons.some((r) => r.code === 'noKlipperPrinter') ? (
          <p
            className="cal-alert cal-alert--warning"
            role="alert"
            data-testid="bed-clear-klipper-blocked"
          >
            {blockedReasonLabel('noKlipperPrinter')}
          </p>
        ) : null}
      </div>

      {/* Bed-clear dialog (B-01 through B-07) */}
      <BedClearDialog />
    </section>
  );
}
