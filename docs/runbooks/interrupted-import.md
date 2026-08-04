# Runbook — interrupted import

A legacy calibration backup (schema v4) import stopped part-way — the app was
closed, the network dropped, or the request timed out — and it is unclear
whether anything was imported.

## Trigger

- The import dialog reported an error, or the app closed during an import.
- The user is unsure whether to run the import again and is worried about
  duplicates.
- The import failed with `errorCode` `idempotencyPayloadChanged`.

## Diagnose

1. Establish what the import already did. The import is a single request on the
   IPC channel `calibration:importLegacyBackupV4`, so it either reached the
   server or it did not; there is no partially-committed desktop state to unwind.
2. Read diagnostics on `calibration:getDiagnostics`. `outbox`
   `pendingOperationCount` and `unresolvedConflictCount` tell you whether local
   work is queued, and `lastSync` reports the `outcome` and the `correlationId`
   of the last synchronisation.
3. Check the destination for the imported projects before re-running. Because
   target IDs are **derived deterministically** from the legacy IDs (see below),
   the same backup always lands on the same `projectId` values — so their
   presence is a reliable answer to "did this already import?".
4. If the failure was `idempotencyPayloadChanged`, the same operation key was
   re-sent with a **different** payload. That is a refusal that protected the
   data: it means the mappings or the file changed between attempts.

## Recover

**The guarantee: replay does not duplicate projects, attempts or photos.**

Every target identifier is derived by hashing the legacy identifier under a fixed
namespace, so the same legacy project, step, attempt and photo always map to the
same target ID no matter how many times the backup is imported. Re-importing the
same file therefore addresses the same rows rather than creating new ones. On top
of that, the request carries the import operation key as its idempotency key and
a hash of the canonical payload — the operation key, the file hash, the project
count and the sorted printer mappings — so the server can recognise an exact
replay and refuse a key reused with different content.

To resume:

1. Re-open the import dialog and pick the **same backup file**. The file approval
   is single-use, so a retry always requires re-selecting the file; this is not a
   sign that the earlier attempt did something unusual.
2. Supply the **same printer mappings**. Different mappings are a different
   payload.
3. Run the import again.

**A limitation to state plainly.** The import operation key is stable _within_
one attempt — it is what makes the server able to collapse an exact replay of
that request. It is **not** persisted across attempts: the renderer mints a fresh
key each time the user runs the import. So a second attempt is a new operation to
the server, and non-duplication on that second attempt rests on the deterministic
target IDs described above, not on the key. In practice the effect an operator
cares about is the same, but the mechanism is different and it is worth knowing
which one is doing the work.

If the file itself is at fault — over the 50 MB read cap, wrong schema version,
or structurally corrupt — the import is refused during local preflight, before
any network call and before anything is mutated. Nothing needs undoing.

## Verify

1. Confirm the import reports its imported project count and per-project results.
2. Confirm the project count in the destination equals the count in the backup
   summary — **not** the sum across attempts. An equal count after two attempts
   is the non-duplication guarantee holding.
3. Spot-check one project's attempts and photos against the summary's attempt and
   photo counts.
4. Run a sync and confirm a `sync.completed` record for the profile, then re-read
   diagnostics and confirm `pendingOperationCount` has drained.

## If this fails

Escalate with the backup file's hash, the number of projects it contains, the
`correlationId` of the sync that followed, and the per-project results from the
import response. If duplicates **did** appear, that contradicts the deterministic
identifier derivation and is a defect worth filing with the two conflicting
`projectId` values, since it means either the derivation or the server-side
upsert did not hold.
