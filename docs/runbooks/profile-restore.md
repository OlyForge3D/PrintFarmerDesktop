# Runbook — profile restore

A generated OrcaSlicer filament profile must be rolled back to the version that
was in place before a calibration install.

Direct installation is **Windows only**. On macOS the generated profile is
exported to a location the user chooses through a save dialog; there is no
install to roll back, and this runbook does not apply.

## Trigger

- The user reports OrcaSlicer behaving differently after installing a calibrated
  profile.
- An install reported an error and the user is unsure what state the file is in.
- A profile install must be reverted for any reason.

## Diagnose

1. Establish that an install actually happened. Installs are performed over the
   IPC channel `calibration:installOrcaProfile`; the restore counterpart is
   `calibration:restoreOrcaProfile`.
2. **Where the backup is recorded.** When the destination file already existed,
   the install wrote a durable copy of the prior bytes beside the target in the
   canonical OrcaSlicer user-data filament directory, named
   `<profile>.json.bak-<timestamp>` with the colons and dots of the ISO timestamp
   replaced by hyphens. It was created with an exclusive create, so an install
   never overwrites an existing backup. The install result reports that path
   together with the SHA-256 of the backed-up bytes and of the installed bytes.
3. **If the destination did not previously exist**, there is nothing to restore
   to: the install result reports the installed path and the installed hash in
   the backup fields. Restoring in that situation reinstalls the same content.
   The correct rollback is to delete the installed file.
4. List the candidate backups:

   ```powershell
   Get-ChildItem "$env:APPDATA\OrcaSlicer" -Recurse -Filter '*.bak-*'
   ```

## Recover

**The guarantee to rely on: a failed install leaves the prior profile intact.**
That is structural, not best-effort. The install refuses to start while
OrcaSlicer is running; it verifies the generated content hash before touching
anything; it writes to a temporary file in the **same directory**, reads it back,
verifies the hash and that it parses as JSON, and only then renames it over the
destination. A rename within one directory is atomic, so the destination is
either the old file or the fully verified new one — never a partial write. Any
failure before the rename leaves the original untouched, and the backup remains
on disk regardless.

To restore:

1. Close OrcaSlicer. The restore path rejects the operation while it is running,
   for the same reason the install does.
2. Invoke restore on `calibration:restoreOrcaProfile` with the `operationId` of
   the install being reverted and the backup hash the install reported. The
   handler locates the backup by scanning the canonical directory for a file
   whose contents hash to that value — the renderer never supplies a path.
3. The restore verifies the backup's hash **before** overwriting anything and
   aborts if it does not match, then writes through the same temporary-file and
   atomic-rename sequence.

**Two constraints that decide whether this works:**

- The `operationId` must be one this app run performed the install under. The
  install cache that maps it to the target filename is in memory, so **after a
  restart the restore channel cannot locate the backup** and answers with a
  not-ready error. Restore manually in that case: the backup file is still on
  disk, and copying it back over the target is the same operation.
- If no backup file hashes to the supplied value, restore refuses rather than
  guessing. That is deliberate — a restore that picked the nearest-looking file
  would be worse than no restore.

## Verify

1. Confirm the restore reported the restored hash and that it equals the backup
   hash you supplied.
2. Confirm the target file's SHA-256 matches:

   ```powershell
   Get-FileHash "$env:APPDATA\OrcaSlicer\...\<profile>.json" -Algorithm SHA256
   ```

3. Start OrcaSlicer and confirm the profile reads as it did before the install.
4. Confirm the backup file is still present — restore does not consume it.

## If this fails

Escalate with the `operationId`, the backup hash, the directory listing of
`*.bak-*` files, and whether OrcaSlicer was running. Never hand over the profile
file contents without review. If the target file is missing entirely and no
backup matches, stop and escalate rather than reinstalling: at that point the
question is what removed it, and reinstalling destroys the evidence.
