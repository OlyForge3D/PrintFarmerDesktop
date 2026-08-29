/**
 * OrcaSlicer generated-profile identity (issue #55; trimmed by #791).
 *
 * `generateProfileIdentity` is UNWIRED: it has zero production callers. The
 * live calibration write-back path is `applyFilamentMeasurement` in
 * `src/main/filamentMeasurementWriteBack.ts`.
 *
 * This module used to also contain `generateOrcaProfile`, `applyPatchEntries`,
 * `canonicalJson`, `SUPPORTED_CALIBRATION_FIELDS` and the `OrcaPatchEntry`
 * schema — the full "build a standalone generated OrcaSlicer profile" path
 * from the retired printer-calibration generator (server-side, deleted by
 * PrintFarmer #1993/#1998). Those were deleted as dead code in #791: nothing
 * in `src/` called `generateOrcaProfile`, and the `CalibrationExportOrcaProfile`
 * IPC handler in `ipc.ts` that would consume its output only ever reads a
 * cache (`getCachedProfile` in `orcaProfileInstall.ts`) that nothing in `src/`
 * ever populates (`cacheGeneratedProfile` also has zero callers). That export
 * flow is itself effectively inert pending a future fix — out of scope here.
 *
 * `generateProfileIdentity` is the one exception, retained solely because
 * `tests/calibrationMaliciousInputCorpus.test.ts` exercises it directly as a
 * hostile-input source for `computeInstallPath`'s filename-safety guard. If
 * that security test is ever rewritten to stop depending on it, this function
 * should be deleted too.
 */

import { createHash } from 'node:crypto';

/**
 * Generate a collision-safe OrcaSlicer profile name and a safe filename for
 * the generated profile. The identity encodes the source project and snapshot
 * to guarantee uniqueness across concurrent or replayed generations.
 *
 * Format: "<baseName> [PFD-<shortHash>]"
 * Where shortHash is the first 8 hex chars of SHA-256(projectId|snapshotId).
 */
export function generateProfileIdentity(
  baseOrcaProfileId: string,
  projectId: string,
  snapshotId: string,
): { displayName: string; safeFilename: string } {
  const scopeHash = createHash('sha256')
    .update(`${projectId}\x00${snapshotId}`)
    .digest('hex')
    .slice(0, 8);

  // Strip trailing @<nozzle> suffix from base name for a cleaner generated name.
  const baseName = baseOrcaProfileId
    .replace(/@\s*\d+(?:\.\d+)?\s*(?:mm\s*)?nozzle\s*$/i, '')
    .trim();

  const displayName = `${baseName} [PFD-${scopeHash}]`;

  // Build a filesystem-safe filename: replace path separators and control chars.
  const safeName = displayName
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 192); // Leave room for .json suffix (total 200 chars max)

  const safeFilename = `${safeName}.json`;
  return { displayName, safeFilename };
}
