/**
 * JobBlockedReasonCode — durable calibration blocked-reason vocabulary and the
 * wire-token → enum mapping the server dispatches through
 * `DispatchSafetyGates.MapBlockedReason`.
 *
 * SOURCE-OF-TRUTH PROVENANCE
 * --------------------------
 * Repository:  OlyForge3D/PrintFarmer
 * Commit SHA:  1a200c299a176e3ebff46821fe1a0cfb012965ed
 * Enum source: src/infra/Domain/PrintJobEnums.cs
 *   Blob SHA:  e5782fcf0760715d9a6a7ad5c2169e1cab894667
 *   C# type:   Farm.Infrastructure.Domain.JobBlockedReasonCode
 * Switch src:  src/infra/Services/Queue/Dispatch/DispatchSafetyGates.cs
 *   Blob SHA:  ce6b81505697916974eead591f0383a60e34b26f
 *   C# method: Farm.Infrastructure.Services.Queue.Dispatch.DispatchSafetyGates.MapBlockedReason
 *
 * WHY THIS SNAPSHOT EXISTS
 * ------------------------
 * `MapBlockedReason` returns `null` for any wire token it does not recognise,
 * which is deliberate on the server side but silently lethal for the desktop:
 * an unrecognised token maps to nothing, so the renderer would render nothing,
 * and the operator would see no reason at all for a blocked calibration job.
 *
 * The drift check in the paired test compares this snapshot against the live
 * pfarm1 checkout and fails when:
 *   - a new enum value is added server-side without desktop wording, OR
 *   - a new wire token is added server-side that maps to an existing enum but
 *     is not on the acknowledged list here, OR
 *   - a token that used to map is removed and the desktop still assumes it.
 *
 * Dallas is building the renderer copy for these; this snapshot is the
 * regression floor that stops a new token from reaching operator eyes as
 * blank text.
 */

/**
 * The 11 durable calibration blocked-reason enum values, in the exact
 * declaration order of the server enum. Enum member names are serialised
 * verbatim through `JsonStringEnumConverter`, so these strings are what
 * appears on the wire in `PrintJob.BlockedReasonCode`.
 */
export const JOB_BLOCKED_REASON_CODE_ENUM_MEMBERS = [
  'None',
  'FirmwareFamilyMismatch',
  'GcodeDialectMismatch',
  'SlicerTupleMismatch',
  'ContentHashMismatch',
  'PrinterConfigRevisionStale',
  'HardCompatibilityFailure',
  'CalibrationRecordInvalid',
  'FilamentCheckFailed',
  'MissingRequiredCapability',
  'OperatorRecoveryRequired',
] as const satisfies readonly string[];

export type JobBlockedReasonCode =
  (typeof JOB_BLOCKED_REASON_CODE_ENUM_MEMBERS)[number];

/**
 * Every wire token the server's `DispatchSafetyGates.MapBlockedReason` maps
 * to a durable `JobBlockedReasonCode`. Any token NOT in this set maps to
 * `null` — those must never leak to the operator unrendered.
 */
export const JOB_BLOCKED_REASON_WIRE_TOKENS = [
  'firmware_family_mismatch',
  'gcode_dialect_mismatch',
  'slicer_tuple_mismatch',
  'gcode_hash_missing',
  'gcode_hash_mismatch',
  'gcode_hash_unverifiable',
  'gcode_byte_hash_mismatch',
  'gcode_size_mismatch',
  'gcode_byte_size_mismatch',
  'gcode_file_missing',
  'printer_config_revision_missing',
  'printer_config_revision_stale',
  'calibration_record_invalid',
  'calibration_record_mismatch',
  'filament_spool_missing',
  'filament_spool_unknown',
  'filament_spool_mismatch',
  'filament_material_missing',
  'filament_material_unknown',
  'filament_material_mismatch',
  'filament_insufficient',
  'capabilities_unsatisfied',
  'compatibility_incomplete',
  'printer_model_mismatch',
  'toolhead_mismatch',
  'hardware_evidence_incomplete',
  'build_volume_exceeded',
  'nozzle_unknown',
  'nozzle_mismatch',
  'gcode_metadata_mismatch',
] as const satisfies readonly string[];

export type JobBlockedReasonWireToken =
  (typeof JOB_BLOCKED_REASON_WIRE_TOKENS)[number];

/**
 * PROVENANCE — machine-checkable provenance stamp.
 * See `calibration.snapshotProvenanceGuard.test.ts` for the guard.
 */
export const PROVENANCE = {
  kind: 'csharp-source' as const,
  sourceRepo: 'OlyForge3D/PrintFarmer',
  commitSha: '1a200c299a176e3ebff46821fe1a0cfb012965ed',
  sourcePath: 'src/infra/Domain/PrintJobEnums.cs',
  blobHash: 'e5782fcf0760715d9a6a7ad5c2169e1cab894667',
  typeName: 'JobBlockedReasonCode',
  additionalSources: [
    {
      sourcePath: 'src/infra/Services/Queue/Dispatch/DispatchSafetyGates.cs',
      blobHash: 'ce6b81505697916974eead591f0383a60e34b26f',
      typeName: 'DispatchSafetyGates.MapBlockedReason',
      note: 'Wire-token to enum mapping. Returns null for unrecognised tokens.',
    },
  ],
};
