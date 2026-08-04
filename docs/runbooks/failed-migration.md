# Runbook — failed migration

The sidecar's SQLite catalog failed to open or failed to migrate. Calibration
data is local-first, so this blocks the whole feature on the affected machine.

Applies to the model catalog managed by `native/model-core`, whose current
schema version is 14.

## Trigger

- PFD starts and calibration is unusable: project lists are empty, saving fails,
  or the sidecar is not answering.
- A `sidecar.processFailed` record on component `calibration.sidecar` appears on
  stdout at or shortly after startup.
- The user has just downgraded PFD, restored a machine from a backup, or copied a
  profile directory from another machine.

## Diagnose

1. Capture the structured log from stdout and look for `sidecar.processFailed`.
   The record carries no flow identifiers — the sidecar has no calibration
   operation in hand when it dies — so `timestamp` and `message` are what tie it
   to the startup attempt.
2. Distinguish the two failure shapes, because the recovery differs:
   - **Schema is ahead of this build.** The catalog opener reads the database's
     `user_version` pragma and, when it is **greater than** the build's schema
     version, **refuses to open the database at all**. It does not attempt a
     downgrade and it does not modify the file. This is the signature of running
     an older PFD against a database written by a newer one.
   - **A migration step failed.** The migration runs inside a single
     `BEGIN IMMEDIATE` transaction and rolls back as a unit on any error, so the
     file is left at its original `user_version` rather than half-migrated.
3. Read the version directly to tell them apart:

   ```sh
   sqlite3 <catalog>.sqlite3 "PRAGMA user_version;"
   ```

   A value **above 14** is the downgrade guard. A value **at or below 14** with a
   failing start is a migration error.

## Recover

**If `user_version` is above the build's schema version (the downgrade guard):**

There is no supported downgrade path. The guard exists precisely because a newer
schema may hold data this build cannot represent, and opening it would risk
silent loss. Do one of:

1. **Reinstall the newer PFD build** and let it open its own database. This is
   the correct action in almost every case.
2. If the newer build is unavailable, move the database aside and let this build
   create a fresh one:

   ```sh
   mv <catalog>.sqlite3 <catalog>.sqlite3.too-new-<date>
   ```

   Do **not** delete it. The moved file is the only copy of that data and a newer
   build can still open it.

**If a migration step failed:**

1. Copy the database aside before anything else — the rollback preserved it, and
   the next start will try the same migration again.
2. Restart PFD. A transient cause (a locked file, an antivirus scan, a full disk)
   often clears.
3. If it fails repeatedly, capture the sidecar's own stderr, which PFD forwards
   unchanged, and attach it with the copy of the database.

## Verify

1. Restart PFD and confirm no `sidecar.processFailed` record is emitted.
2. Confirm the schema version now matches the build:

   ```sh
   sqlite3 <catalog>.sqlite3 "PRAGMA user_version;"
   ```

3. Open the calibration dashboard and confirm previously saved projects list.
4. Read diagnostics on `calibration:getDiagnostics` and confirm `outbox` is
   non-null — a null outbox means the counts could not be read from the sidecar,
   which is the same underlying fault presenting differently.

## If this fails

Escalate with: the `user_version` value, the copied database file, the full
stdout log including every `sidecar.processFailed` record, the PFD version that
last worked, and the PFD version now failing. The migration matrix
(v1, v2, v3, v5, v6, v9 and v12 to current) is covered by tests in
`native/model-core`; a failure at one of those steps is a defect, not a
configuration problem, and should be filed as such.
