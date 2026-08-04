# Runbook — uncertain printer start

A calibration print was submitted and PFD cannot tell whether the printer
started it. This is the case where guessing is expensive: assume it failed and
you may start a duplicate print on live hardware.

## Trigger

- A start-print or bed-clear acknowledgement request timed out or lost its
  connection before a response arrived.
- A queue job reports `dispatchAttemptOutcome` of `Unknown` or `InProgress` and
  does not settle.
- The user reports "I pressed start and nothing happened", or "I pressed start
  twice".

## Diagnose

1. **Do not retry first.** Read the queue job state before taking any action.
2. Read the job on `calibration:getQueueState`. The `queue.stateRead` record
   carries `dispatchId` (the queue job ID), `dispatchRevision`, `projectId` and
   `attemptId`, and on success `correlationOrigin` shows whether the desktop
   still recognised the flow.
3. Read these fields from the job:
   - `status` — the job status: Queued, Assigned, Starting, Printing, Paused,
     Completed, Failed or Cancelled. Anything at Starting or beyond means the
     dispatch **did** reach the printer.
   - `dispatchAttemptOutcome` — InProgress, Accepted, Rejected, FailedBeforeStart
     or Unknown. `Unknown` is the genuinely uncertain case; the others are
     answers.
   - `bedClearState` — None, Acknowledged, Consumed or Invalidated. `Consumed`
     means an acknowledgement was spent, which only happens when dispatch
     proceeded.
   - `assignedPrinterId` and `assignedPrinterName` — which machine to look at.
4. If `queue.stateRead` itself failed, its record carries `errorCode`. A
   `jobNotFound` means the server has no such job, which is an answer: nothing
   was queued.
5. **Look at the printer.** The queue job is authoritative for what the server
   dispatched; the machine is authoritative for what is on the bed. For an
   `Unknown` outcome these are the only two sources, and they must agree before
   you act.

## Recover

- **Job at Starting or beyond, or `bedClearState` is Consumed:** the print
  started. Do not resubmit. Let it run or stop it at the printer.
- **Job at Queued or Assigned with `dispatchAttemptOutcome` `Unknown`:** the
  dispatch attempt is unresolved server-side. Wait for it to settle rather than
  acting; the server owns the transition.
- **`dispatchAttemptOutcome` Rejected or FailedBeforeStart:** nothing printed.
  Re-acknowledge bed clear with the **current** `rowVersion` and
  `dispatchStateRowVersion` read in the step above. Sending a stale revision
  produces `bedClear.revisionConflict` with `errorCode`
  `dispatchRevisionConflict`, which is a refusal, not a failure — re-read and
  retry.
- **`jobNotFound`:** nothing was queued. Start the print again from the
  attempt.
- If the operation is retried through the same desktop action, the `operationId`
  is the idempotency key: an exact replay is collapsed server-side rather than
  duplicated. Changing the payload under the same key is refused with
  `idempotencyPayloadChanged` — that refusal is protecting you, not obstructing
  you.

## Verify

1. Re-read the job and confirm `dispatchAttemptOutcome` has left `Unknown`.
2. Confirm exactly one job exists for the `attemptId` — a second job for the same
   attempt is the duplicate this runbook exists to prevent.
3. Confirm `bedClear.acknowledged` appears with `outcome` ok and a
   `dispatchRevision` that is not `[unsafe-revision-dropped]`. That literal means
   the server's ETag did not match the expected shape; the operation still
   succeeded, but report the server build.
4. Confirm the printer is running the expected job and no second print was
   started.

## If this fails

Escalate with the `dispatchId`, `correlationId`, the `operationId` from each
attempt (they differ per call — quote all of them), the observed
`dispatchAttemptOutcome`, `bedClearState`, `status`, and the physical state of
the printer. If two prints did start, say so explicitly and immediately: that is
a hardware-affecting incident, and the desktop log alone cannot establish it.
