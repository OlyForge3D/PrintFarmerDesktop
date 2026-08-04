/**
 * CalibrationBedClearDialog
 *
 * Safety dialog for the bed-clear acknowledgement (criterion 12, issue #54).
 *
 * ACCESSIBILITY REQUIREMENTS (must be real — the inspector will verify):
 * - role="dialog" + aria-modal="true" + aria-labelledby + aria-describedby
 * - Real focus trap: Tab/Shift+Tab cycles within dialog only, Escape closes
 * - Live region: aria-live="assertive" for countdown and state changes
 * - Focus restore: returns focus to the trigger element on close
 *
 * SAFETY REQUIREMENTS (criterion 7 — acknowledgement guards):
 * - Never offered when: printer offline, stale telemetry, expired,
 *   unauthorised, or unsynchronised
 * - Never reusable after: job reordered, replaced, cancelled, new job
 * - Shows: job identity, assigned printer, queue revision, material/nozzle,
 *   generated test, acknowledgement expiry
 *
 * BLOCKED REASONS (criterion 10):
 * - Typed `CalibrationBlockedReason` discriminated union — never free text.
 *   The dialog handles these by showing a clear, human-readable explanation.
 */

import React, { useRef, useEffect, useState, type ReactNode } from 'react';
import type { CalibrationBlockedReason } from '@shared/ipc';
import { useDialogFocusLifecycle, useFocusTrap } from './useDialogFocus';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BedClearDialogJob {
  /** Queued job ID. */
  readonly jobId: string;
  /** Assigned printer ID. */
  readonly assignedPrinterId: string | null;
  /** Assigned printer display name (resolved locally). */
  readonly assignedPrinterName: string | null;
  /** Current queue revision (opaque ETag). */
  readonly queueRevision: string | null;
  /** Material display string (e.g. "PLA+ Silk Purple"). */
  readonly material: string | null;
  /** Nozzle display string (e.g. "0.4 mm hardened steel"). */
  readonly nozzle: string | null;
  /** Generated test name (e.g. "Pressure Advance Tower"). */
  readonly generatedTestName: string | null;
  /** ISO 8601 UTC expiry time for the acknowledgement. null = no expiry. */
  readonly acknowledgementExpiresAt: string | null;
}

export type BedClearDialogBlocked =
  | { readonly kind: 'blocked'; readonly reason: CalibrationBlockedReason }
  | { readonly kind: 'ready' };

interface CalibrationBedClearDialogProps {
  /** Whether the dialog is open. */
  readonly open: boolean;
  /** Called when the user confirms (acknowledges). */
  readonly onConfirm: () => void;
  /** Called when the user cancels or presses Escape. */
  readonly onCancel: () => void;
  /** Job data to display. */
  readonly job: BedClearDialogJob;
  /** Whether there is a blocker preventing acknowledgement. */
  readonly blocked: BedClearDialogBlocked;
  /** Whether a submission is in progress. */
  readonly isSubmitting: boolean;
  /** Error from the last submission attempt, or null. */
  readonly submissionError: string | null;
}

// ---------------------------------------------------------------------------
// Focus trap hook
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Countdown hook
// ---------------------------------------------------------------------------

/**
 * Returns seconds remaining until `expiresAt`, recomputed every second.
 * Returns null if expiresAt is null.
 */
function useCountdown(expiresAt: string | null): number | null {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      setSecondsLeft(null);
      return;
    }
    const update = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      setSecondsLeft(Math.max(0, Math.floor(ms / 1000)));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return secondsLeft;
}

// ---------------------------------------------------------------------------
// Blocked reason message
// ---------------------------------------------------------------------------

function BlockedReasonMessage({
  reason,
}: {
  readonly reason: CalibrationBlockedReason;
}): ReactNode {
  switch (reason.code) {
    case 'staleTelemetry':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Stale telemetry:</strong> {reason.detail}
        </p>
      );
    case 'firmwareChange':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Firmware changed since job was created:</strong>{' '}
          {reason.detail}
        </p>
      );
    case 'configChange':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Configuration changed:</strong> {reason.detail}
        </p>
      );
    case 'materialMismatch':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Material mismatch:</strong> {reason.detail}
        </p>
      );
    case 'maintenanceBusy':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Printer in maintenance:</strong> {reason.detail}
        </p>
      );
    case 'missingGcode':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>G-code file unavailable:</strong> {reason.detail}
        </p>
      );
    case 'permissionFailure':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Permission denied:</strong> {reason.detail}
        </p>
      );
    case 'printerOffline':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Printer is offline:</strong> {reason.detail}
        </p>
      );
    case 'acknowledgementExpired':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Acknowledgement has expired:</strong> {reason.detail}
        </p>
      );
    case 'jobReordered':
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Job was reordered:</strong> {reason.detail} The
          acknowledgement is no longer valid.
        </p>
      );
    default: {
      // Exhaustive check intentionally uses a never-cast fallback so new codes
      // are rendered rather than silenced.
      const fallback = reason as { code: string; detail: string };
      return (
        <p className="calibration-bed-clear-dialog__blocked-reason">
          <strong>Cannot acknowledge ({fallback.code}):</strong>{' '}
          {fallback.detail}
        </p>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const DIALOG_LABEL_ID = 'calibration-bed-clear-dialog-label';
const DIALOG_DESC_ID = 'calibration-bed-clear-dialog-desc';

export const CalibrationBedClearDialog: React.FC<
  CalibrationBedClearDialogProps
> = ({
  open,
  onConfirm,
  onCancel,
  job,
  blocked,
  isSubmitting,
  submissionError,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const secondsLeft = useCountdown(job.acknowledgementExpiresAt);

  useDialogFocusLifecycle(dialogRef, open);
  useFocusTrap(dialogRef, open, onCancel);

  const isExpired = secondsLeft !== null && secondsLeft <= 0;
  const isBlocked = blocked.kind === 'blocked' || isExpired;
  const canConfirm = !isBlocked && !isSubmitting;

  const expiryAnnouncement =
    secondsLeft !== null && secondsLeft <= 30 && secondsLeft > 0
      ? `Acknowledgement expires in ${secondsLeft} second${secondsLeft !== 1 ? 's' : ''}.`
      : isExpired
        ? 'Acknowledgement has expired.'
        : null;

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="calibration-bed-clear-dialog__backdrop"
        aria-hidden="true"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={DIALOG_LABEL_ID}
        aria-describedby={DIALOG_DESC_ID}
        className="calibration-bed-clear-dialog"
        tabIndex={-1}
      >
        {/* Live region for countdown and state changes */}
        <div
          aria-live="assertive"
          aria-atomic="true"
          className="calibration-bed-clear-dialog__live-region"
          aria-relevant="additions text"
        >
          {expiryAnnouncement}
        </div>

        <header className="calibration-bed-clear-dialog__header">
          <h2
            id={DIALOG_LABEL_ID}
            className="calibration-bed-clear-dialog__title"
          >
            Confirm Bed Clear
          </h2>
          <button
            type="button"
            className="cal-button calibration-bed-clear-dialog__close"
            aria-label="Close dialog"
            onClick={onCancel}
          >
            ×
          </button>
        </header>

        <div id={DIALOG_DESC_ID} className="calibration-bed-clear-dialog__body">
          <p className="calibration-bed-clear-dialog__instruction">
            Before the print starts, confirm that the bed is clear of all
            objects and obstructions. This action is irreversible — once
            acknowledged, the print will start immediately.
          </p>

          {/* Job details */}
          <section
            className="calibration-bed-clear-dialog__job-details"
            aria-label="Job details"
          >
            <dl>
              <div className="calibration-bed-clear-dialog__detail-row">
                <dt>Job ID</dt>
                <dd>
                  <code>{job.jobId}</code>
                </dd>
              </div>
              {job.assignedPrinterName && (
                <div className="calibration-bed-clear-dialog__detail-row">
                  <dt>Assigned Printer</dt>
                  <dd>
                    {job.assignedPrinterName}
                    {job.assignedPrinterId && (
                      <span className="calibration-bed-clear-dialog__detail-sub">
                        {' '}
                        (<code>{job.assignedPrinterId}</code>)
                      </span>
                    )}
                  </dd>
                </div>
              )}
              {job.queueRevision && (
                <div className="calibration-bed-clear-dialog__detail-row">
                  <dt>Queue Revision</dt>
                  <dd>
                    <code>{job.queueRevision}</code>
                  </dd>
                </div>
              )}
              {job.material && (
                <div className="calibration-bed-clear-dialog__detail-row">
                  <dt>Material</dt>
                  <dd>{job.material}</dd>
                </div>
              )}
              {job.nozzle && (
                <div className="calibration-bed-clear-dialog__detail-row">
                  <dt>Nozzle</dt>
                  <dd>{job.nozzle}</dd>
                </div>
              )}
              {job.generatedTestName && (
                <div className="calibration-bed-clear-dialog__detail-row">
                  <dt>Generated Test</dt>
                  <dd>{job.generatedTestName}</dd>
                </div>
              )}
              {job.acknowledgementExpiresAt && (
                <div className="calibration-bed-clear-dialog__detail-row">
                  <dt>Acknowledgement Expires</dt>
                  <dd>
                    <time dateTime={job.acknowledgementExpiresAt}>
                      {new Date(
                        job.acknowledgementExpiresAt,
                      ).toLocaleTimeString()}
                    </time>
                    {secondsLeft !== null && secondsLeft > 0 && (
                      <span
                        className={`calibration-bed-clear-dialog__countdown${secondsLeft <= 30 ? ' calibration-bed-clear-dialog__countdown--urgent' : ''}`}
                        aria-hidden="true"
                      >
                        {' '}
                        ({secondsLeft}s)
                      </span>
                    )}
                    {isExpired && (
                      <span
                        className="calibration-bed-clear-dialog__expired"
                        role="alert"
                      >
                        {' '}
                        EXPIRED
                      </span>
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          {/* Blocked reason */}
          {blocked.kind === 'blocked' && (
            <div
              className="calibration-bed-clear-dialog__blocked"
              role="alert"
              aria-live="assertive"
            >
              <BlockedReasonMessage reason={blocked.reason} />
            </div>
          )}

          {/* Submission error */}
          {submissionError && (
            <div
              className="calibration-bed-clear-dialog__submission-error"
              role="alert"
              aria-live="assertive"
            >
              <p>
                <strong>Could not acknowledge:</strong> {submissionError}
              </p>
            </div>
          )}
        </div>

        <footer className="calibration-bed-clear-dialog__footer">
          <button
            type="button"
            className="cal-button calibration-bed-clear-dialog__button calibration-bed-clear-dialog__button--cancel"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="cal-button cal-button--primary calibration-bed-clear-dialog__button calibration-bed-clear-dialog__button--confirm"
            onClick={onConfirm}
            disabled={!canConfirm}
            aria-disabled={!canConfirm}
            aria-describedby={
              blocked.kind === 'blocked' || isExpired
                ? DIALOG_DESC_ID
                : undefined
            }
          >
            {isSubmitting ? 'Acknowledging…' : 'Confirm Bed Clear'}
          </button>
        </footer>
      </div>
    </>
  );
};

export default CalibrationBedClearDialog;
