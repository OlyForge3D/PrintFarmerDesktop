# Runbook — stale dispatch lease

A bed-clear acknowledgement is being rejected, or has silently stopped being
valid, because the dispatch state on the server moved after PFD read it.

The "lease" here is the pair of opaque revisions PFD must send back byte-for-byte
— the job `rowVersion` and the `dispatchStateRowVersion` — together with the
acknowledgement window the server grants.

## Trigger

- A `bedClear.revisionConflict` record with `errorCode`
  `dispatchRevisionConflict`.
- A start blocked with `printStartAllowed` false and a `printStartBlockedReason`
  naming a stale context.
- `bedClearState` reverting from Acknowledged to None or Invalidated without the
  user doing anything.
- An acknowledgement accepted earlier that no longer permits a start.

## Diagnose

1. Read the job on `calibration:getQueueState` and take the **current**
   `rowVersion` and `dispatchStateRowVersion`. The `queue.stateRead` record
   carries `dispatchId` and, on success, `dispatchRevision` — compare that value
   with the one the failing acknowledgement sent.
2. Read `acknowledgementExpiresAt`. A non-null value in the past means the
   acknowledgement window elapsed; the lease was not stolen, it expired.
3. Read `bedClearState`:
   - Acknowledged — a live acknowledgement exists.
   - Consumed — it was spent on a dispatch. Do not re-acknowledge; see the
     [uncertain printer start](./uncertain-printer-start.md) runbook.
   - Invalidated — the server withdrew it, typically because the job or printer
     configuration changed.
4. Check whether the printer configuration moved underneath the job:
   `pinnedPrinterConfigRevision` on the job against `configurationRevision` on
   the current printer context. A difference means the snapshot the calibration
   was bound to is no longer current, and re-acknowledging alone will not fix it.
5. If `dispatchRevision` reads `[unsafe-revision-dropped]` in the log, the
   record withheld a server value that did not match the expected base-64 shape.
   The operation was unaffected — that literal only ever appears in the log, never
   on the wire — so read the live value from the job rather than from the record.

## Recover

1. **Re-read, then re-send.** Acknowledge bed clear again using the `rowVersion`
   and `dispatchStateRowVersion` just read, unmodified. These are opaque strings:
   do not normalise, trim, re-encode or treat them as integers.
2. If `acknowledgementExpiresAt` had passed, re-acknowledge and start promptly;
   the window is short by design because it asserts a physical fact about the
   bed.
3. If `bedClearState` is Invalidated because the printer configuration advanced,
   the calibration workspace must be re-bound to the current context before the
   job can proceed. A workspace whose binding no longer matches the authoritative
   context is not fresh, and PFD refuses to advance it rather than printing
   against a stale machine description.
4. If the job is no longer dispatchable at all, `errorCode`
   `jobNotDispatchable` says so. Requeue from the attempt rather than retrying
   the acknowledgement.

## Verify

1. Confirm a `bedClear.acknowledged` record with `outcome` ok and a
   `dispatchRevision` that differs from the value that was conflicting.
2. Re-read the job and confirm `bedClearState` is Acknowledged with a future
   `acknowledgementExpiresAt`, or Consumed if the dispatch has already proceeded.
3. Confirm `printStartAllowed` is true and `printStartBlockedReason` is null.

## If this fails

Escalate with the `dispatchId`, the `correlationId`, the `operationId` of the
failing acknowledgement, the `dispatchRevision` PFD sent and the one the server
returned, `bedClearState`, `acknowledgementExpiresAt`, and both
`pinnedPrinterConfigRevision` and the current `configurationRevision`. A
persistent conflict where PFD demonstrably sent the freshest revision it could
read is a server-side concurrency issue, not an operator error.
