/**
 * Renderer-side translation of PrintFarmer's dispatch-safety blocked-reason
 * codes into operator-facing sentences.
 *
 * Bishop's diagnosis of #740: when PrintFarmer's dispatch-safety gates refuse
 * a print, the server returns a ProblemDetails with a machine-readable
 * `errorCode` drawn from `DispatchSafetyGates.MapBlockedReason`
 * (`D:\s\pfarm1\src\infra\Services\Queue\Dispatch\DispatchSafetyGates.cs:19-53`,
 * verified verbatim). The desktop carried the code as far as
 * `CalibrationHttpError.serverErrorCode`, then dropped it at the IPC boundary
 * because that field was in-process-only under #177's disposition. The
 * operator saw `"Bed-clear conflict: firmware_family_mismatch"` at best (raw
 * code in a code-y English wrapper) and `"Calibration data is invalid or
 * unsafe."` at worst (the raw code stripped, the wrapper alone). The gate
 * that closed was not named.
 *
 * `CalibrationApiError.blockedReasonCode` now carries the code across the
 * boundary — see the docblocks on that field and on
 * `CalibrationHttpError.serverErrorCode` for why passing an enum-shaped,
 * curated-vocabulary, 64-char-bounded code is safe under #177 while
 * `serverDetail` is not. This module is what turns that code into a sentence
 * the operator can act on.
 *
 * The exhaustiveness property matches `refusalMessages.ts`. `Record<TypedCode,
 * string>` is compile-checked, so a new server-side gate must add a wording
 * here or `tsc` fails at the map. The union `KnownBlockedReasonCode` is
 * derived from a `const` array so the runtime and the type cannot drift —
 * adding a code to the array *is* extending the type.
 *
 * An unrecognised code is not swallowed: `describeBlockedReasonCode` returns
 * a message that quotes the raw token, so a server that ships a new gate
 * without a matching client update produces a visible, debuggable message
 * instead of a generic one.
 */

/**
 * Every dispatch-safety refusal code PrintFarmer emits today, verbatim from
 * `DispatchSafetyGates.MapBlockedReason`. Adding one to the server without
 * adding it here still shows the operator something actionable (the raw
 * token, quoted), so a server-only change is not a silent regression.
 */
export const KNOWN_BLOCKED_REASON_CODES = [
  // ---- 422 codes (dispatch-safety refusals; DispatchSafetyGates.cs:19-53) --
  'firmware_family_mismatch',
  'gcode_dialect_mismatch',
  'slicer_tuple_mismatch',
  'gcode_file_missing',
  'printer_config_revision_stale',
  'calibration_record_mismatch',
  'filament_insufficient',
  'capabilities_unsatisfied',
  'gcode_metadata_mismatch',
  // ---- 422 codes surfaced through 422 mapping in calibrationHttp.ts -------
  'calibration_job_incompatible',
  'filament_check_failed',
  // ---- 409 codes (bed-clear conflict; calibrationHttp.ts:583-595) --------
  'wrong_job',
  'printer_busy',
  'job_not_dispatchable',
  'idempotency_payload_mismatch',
  // ---- 503 codes (calibration discovery; calibrationHttp.ts:1740-1757) ---
  'profile_service_unavailable',
  'status_unavailable',
] as const;

export type KnownBlockedReasonCode =
  (typeof KNOWN_BLOCKED_REASON_CODES)[number];

/**
 * The operator-facing sentence for one blocked-reason code.
 *
 * Each sentence names the specific dispatch gate PrintFarmer refused to open
 * and, where the operator can act on it, points at the field or configuration
 * to correct. The sentences are deliberately printer-first and PrintFarmer's
 * vocabulary rather than the desktop's: nearly every remedy is a change in
 * PrintFarmer, not this app.
 *
 * Keyed exhaustively by `KnownBlockedReasonCode`: adding a value to the union
 * without adding wording is a compile error. That property, and the
 * pinning-by-catalogue test `calibrationBlockedReasonMessages.test.ts`, is
 * what prevents a future server code from silently degrading to the generic
 * "the server refused" wording this module exists to remove.
 */
const BLOCKED_REASON_MESSAGES: Record<KnownBlockedReasonCode, string> = {
  firmware_family_mismatch:
    "PrintFarmer refused this print because the printer's current firmware family no longer matches the family this calibration job was created against. Verify the printer's firmware identity in PrintFarmer and re-generate this stage.",
  gcode_dialect_mismatch:
    "PrintFarmer refused this print because the printer's current G-code dialect no longer matches the dialect this calibration job was sliced for. Re-generate this stage against the printer's current dialect.",
  slicer_tuple_mismatch:
    'PrintFarmer refused this print because the slicer engine, distribution or version pinned in this calibration job no longer matches what PrintFarmer will now dispatch with. Re-generate this stage.',
  gcode_file_missing:
    "PrintFarmer refused this print because the G-code file this job was created against is no longer present in PrintFarmer's library. Re-generate this stage to rebuild it.",
  printer_config_revision_stale:
    "PrintFarmer refused this print because the printer's configuration has changed since this calibration job was queued. Re-generate this stage against the current printer configuration.",
  calibration_record_mismatch:
    'PrintFarmer refused this print because the calibration record this job references no longer matches what PrintFarmer has on the printer. Re-generate this stage.',
  filament_insufficient:
    'PrintFarmer refused this print because the assigned printer no longer has the filament this calibration job requires loaded or reports insufficient filament for the estimated usage. Load the required filament in PrintFarmer and try again.',
  capabilities_unsatisfied:
    'PrintFarmer refused this print because the assigned printer no longer reports every capability this calibration job requires. Verify the printer capability record in PrintFarmer.',
  gcode_metadata_mismatch:
    'PrintFarmer refused this print because the G-code metadata attached to this job (content hash, tool requirements or nozzle diameter) no longer matches what the printer will dispatch. Re-generate this stage.',
  calibration_job_incompatible:
    'PrintFarmer refused this print because the calibration job is incompatible with the assigned printer as it now looks. Re-check the printer selection and re-generate this stage.',
  filament_check_failed:
    'PrintFarmer refused this print because the filament material or nozzle diameter no longer passes the printer-side check. Verify the loaded filament and toolhead in PrintFarmer.',
  wrong_job:
    'PrintFarmer refused this bed-clear acknowledgement because it named a different job than the one PrintFarmer is currently offering. Re-open the calibration workspace to pick up the current job.',
  printer_busy:
    'PrintFarmer refused this print because the assigned printer already has an active job. Wait for the printer to finish, then try again.',
  job_not_dispatchable:
    'PrintFarmer refused this print because the job is not in a dispatchable state (it may already have been started, cancelled or invalidated). Refresh this workspace to pick up the current job.',
  idempotency_payload_mismatch:
    'PrintFarmer refused this bed-clear acknowledgement because a request with the same idempotency key carried different content. This is a client-side inconsistency — refresh this workspace and try again.',
  profile_service_unavailable:
    "PrintFarmer refused this print because its upstream OrcaSlicer profile resolver is unreachable, so PrintFarmer cannot re-check this calibration job's slicer identity. Check the OrcaSlicer service and try again.",
  status_unavailable:
    'PrintFarmer refused this print because it could not read live printer status. Check the printer connection in PrintFarmer and try again.',
};

/**
 * The operator-facing sentence for one blocked-reason code.
 *
 * Returns `null` when there is no code to describe, so callers can express the
 * "no code" case at the call site instead of hunting for a placeholder
 * sentence. An unrecognised code returns a sentence that quotes the raw
 * token, so a server that shipped a new code without a matching client
 * update produces a visible, debuggable message rather than a swallowed one.
 */
export function describeBlockedReasonCode(
  code: string | null | undefined,
): string | null {
  if (code === null || code === undefined || code === '') return null;
  if ((KNOWN_BLOCKED_REASON_CODES as readonly string[]).includes(code)) {
    return BLOCKED_REASON_MESSAGES[code as KnownBlockedReasonCode];
  }
  // A future server code lands here. Quoting the raw token in an English
  // sentence is the honest treatment: an operator sees exactly the string
  // PrintFarmer named and can quote it to support. Swallowing it would put
  // this call site back in the generic "the server refused" state the module
  // exists to remove.
  return `PrintFarmer refused this print with an unrecognised reason code (${code}). This desktop build may be older than the server; report the code above to support.`;
}
