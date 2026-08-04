# Runbook — unhealthy worker

The PrintFarmer server accepts calibration generation requests but no worker
completes them.

> **Not rehearsed live.** This procedure is performed against a running
> PrintFarmer server. It has been written and reviewed against the desktop
> contract and the emitted log records; its live rehearsal belongs to #138. Treat
> the server-side steps as reviewed, not exercised.

## Trigger

- Generation requests are accepted and then never finish.
- A `generation.requested` record with `outcome` failed and `errorCode`
  `workerUnavailable`.
- Availability reports calibration as available — the capability flags are all
  true — but generation fails anyway.

## Diagnose

1. Read diagnostics on `calibration:getDiagnostics`. Confirm `capability` is
   non-null and that `calibrationGenerationEnabled` is true in its `flags`. If
   `capability` is null, nothing has negotiated since the app started; that is
   not a worker problem — reconnect first.
2. Search the structured log for the failing flow's `correlationId`, then read
   the `generation.requested` record. `errorCode` `workerUnavailable` means the
   **server** reported that no generation worker is available. `httpStatus`
   records what it answered with.
3. If generation was accepted, follow `orchestration.polled` records for the same
   `correlationId`. `workerId` names the worker the server assigned; a null
   `workerId` on an orchestration that is not queued means nothing has picked it
   up.
4. Note the `operationId` from the failing record. That is the backend
   idempotency key and the value to hand the server team — it deliberately
   differs per stage, so quote the one from the record you are investigating, not
   from another stage of the same flow.
5. Distinguish this from a **split deployment reporting configuration rather
   than capability**: an API host advertising generation while its worker tier is
   down produces exactly this symptom. See section 7 of the administrator guide.

## Recover

This is a server-side recovery; PFD has no control over worker lifecycle.

1. Confirm the worker tier is running and connected to the same deployment the
   API host advertises.
2. Restart the worker tier if it is running but idle.
3. If the worker tier is intentionally down, disable calibration generation on
   the server so its capability report becomes truthful. PFD will then report
   `missingCapabilityFlags` at availability instead of offering generation that
   cannot succeed — a refusal the user can act on, rather than a failure they
   cannot.
4. In PFD, no action is needed beyond re-running the operation. Generation is
   idempotent on `operationId`; retrying with the same key is safe.

## Verify

1. Re-run generation and confirm a `generation.submitted` record appears with
   `outcome` ok and a non-null `orchestrationId`.
2. Poll and confirm `orchestration.polled` records show `currentStep` advancing
   and a non-null `workerId`.
3. Re-read diagnostics and confirm `lastSync` shows a successful `outcome`.

## If this fails

Escalate to the server team with the `operationId` and `correlationId` from the
failing records, the `httpStatus`, the `negotiatedApiVersion` and
`apiContractVersion` from diagnostics, and the deployment shape (split or
monolith). **Do not expect the server's error text in the desktop log** —
`message` comes from a fixed catalog and never carries a backend body, by design.
The server-side detail must be retrieved server-side using the `operationId`.
