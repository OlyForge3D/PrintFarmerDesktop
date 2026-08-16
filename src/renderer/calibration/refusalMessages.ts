import type { CalibrationRejectionReasonCode } from '@shared/ipc';
import {
  UNRECOGNIZED_CALIBRATION_INPUT,
  CALIBRATION_MAX_FIELD_PATH_LENGTH,
} from '@shared/ipc';

/**
 * What each refusal code means to the operator standing in front of the
 * printer.
 *
 * PrintFarmer explains every refusal in detail — a code, a field and a message
 * per unmet precondition — and the desktop app carries the codes all the way to
 * the renderer. Until now the wizard read none of them: an ineligible printer
 * was described with a single sentence saying eligibility was incomplete, which
 * is true of *every* refusal and therefore names none of them. An operator was
 * told the printer could not be calibrated and left to guess which of a hundred
 * preconditions had failed, with nothing to act on and nothing to quote.
 *
 * Keyed exhaustively by {@link CalibrationRejectionReasonCode} on purpose: a
 * code added to the shared catalogue without wording here is a compile error,
 * so the failure mode this map exists to remove cannot quietly return one code
 * at a time.
 *
 * Each sentence names the thing to go and fix, in PrintFarmer's own vocabulary,
 * because the remedy for nearly all of these is a field on the printer record
 * rather than anything the operator can do in this app.
 */
const REASON_MESSAGES: Record<CalibrationRejectionReasonCode, string> = {
  active_toolhead_invalid:
    'The recorded active toolhead does not match any toolhead on this printer.',
  active_toolhead_missing:
    'PrintFarmer has not recorded which toolhead is currently active.',
  bed_origin_x_missing: 'The bed origin X coordinate is not recorded.',
  bed_origin_y_missing: 'The bed origin Y coordinate is not recorded.',
  build_volume_x_missing: 'The build volume X dimension is not recorded.',
  build_volume_y_missing: 'The build volume Y dimension is not recorded.',
  build_volume_z_missing: 'The build volume Z dimension is not recorded.',
  direct_drive_state_missing:
    'Whether a toolhead is direct drive is not recorded.',
  drive_type_missing: 'A toolhead does not record its extruder drive type.',
  enclosure_state_missing:
    'Whether this printer has an enclosure is not recorded.',
  excluded_regions_missing: 'The bed excluded regions are not recorded.',
  extruder_gear_ratio_missing:
    'A toolhead does not record its extruder gear ratio.',
  filament_bed_temperature_exceeds_limit:
    "The filament's bed temperature is above this printer's maximum bed temperature.",
  filament_bed_temperature_requires_heated_bed:
    'The filament needs a heated bed, which this printer does not report having.',
  filament_hotend_temperature_exceeds_limit:
    "The filament's hotend temperature is above this printer's hotend limit.",
  filament_material_missing:
    'The filament profile does not state its material.',
  filament_material_unsupported:
    'The selected toolhead does not list this filament material as supported.',
  filament_profile_missing:
    'This printer has no filament profile selected in PrintFarmer.',
  filament_profile_not_found:
    'The filament profile PrintFarmer referenced no longer exists.',
  firmware_detection_confidence_invalid:
    'The recorded firmware detection confidence is outside the valid zero-to-one range.',
  firmware_detection_confidence_missing:
    'Firmware detection confidence is not recorded.',
  firmware_detection_source_unknown:
    'How this firmware was identified — read from the printer or configured by hand — is not recorded.',
  firmware_detection_time_missing:
    'When the firmware was detected is not recorded.',
  firmware_detection_version_missing:
    'The firmware detector or configuration version is not recorded.',
  firmware_family_not_klipper:
    'Calibration currently requires Klipper firmware, and this printer reports a different family.',
  firmware_family_unknown:
    'This printer has no identified firmware family. Detect or set it in PrintFarmer.',
  firmware_identity_unverified:
    'The firmware identity has not been marked verified in PrintFarmer.',
  firmware_metadata_stale:
    'The firmware identity was detected too long ago. Re-detect it in PrintFarmer.',
  firmware_retraction_capability_missing:
    'Whether this firmware supports firmware retraction is not recorded.',
  firmware_version_missing: 'The firmware version is not recorded.',
  gcode_dialect_not_klipper:
    'Calibration currently requires the Klipper G-code dialect, and this printer reports a different one.',
  gcode_dialect_unknown:
    'This printer has no identified G-code dialect. Detect or set it in PrintFarmer.',
  geometry_json_invalid:
    'The stored bed geometry could not be read as valid JSON.',
  hardware_metadata_stale:
    'The hardware details were verified too long ago. Re-verify them in PrintFarmer.',
  hardware_verification_time_missing:
    'When the hardware details were last verified is not recorded.',
  heated_bed_state_missing:
    'Whether this printer has a heated bed is not recorded.',
  heated_chamber_state_missing:
    'Whether this printer has a heated chamber is not recorded.',
  hotend_max_temperature_missing:
    'A toolhead does not record its maximum hotend temperature.',
  machine_profile_missing:
    'This printer has no machine profile selected in PrintFarmer.',
  machine_profile_not_found:
    'The machine profile PrintFarmer referenced no longer exists.',
  max_acceleration_missing:
    'The printer does not record its maximum acceleration.',
  max_bed_temperature_missing:
    'The printer does not record its maximum bed temperature.',
  max_chamber_temperature_missing:
    'The printer does not record its maximum chamber temperature.',
  max_print_speed_missing:
    'The printer does not record its maximum print speed.',
  max_travel_acceleration_missing:
    'The printer does not record its maximum travel acceleration.',
  max_travel_speed_missing:
    'The printer does not record its maximum travel speed.',
  max_volumetric_flow_missing:
    'A toolhead does not record its maximum volumetric flow.',
  motion_type_missing: 'The printer does not record its motion system type.',
  multi_extruder_status_unsupported:
    'This printer has several toolheads, but its adapter cannot report status per toolhead.',
  nozzle_diameter_missing: 'A toolhead does not record its nozzle diameter.',
  nozzle_hardness_missing:
    'Whether a toolhead has a hardened nozzle is not recorded.',
  nozzle_material_missing: 'A toolhead does not record its nozzle material.',
  nozzle_max_temperature_missing:
    'A toolhead does not record its maximum nozzle temperature.',
  nozzle_type_missing: 'A toolhead does not record its nozzle type.',
  physical_toolhead_missing:
    'PrintFarmer has no physical toolhead recorded for this printer.',
  pressure_advance_capability_missing:
    'Whether this firmware supports pressure advance is not recorded.',
  printable_polygon_invalid:
    'The printable area polygon needs at least three points.',
  printable_polygon_missing: 'The printable area polygon is not recorded.',
  printer_configuration_changed:
    'The printer configuration changed while it was being read. Try again.',
  printer_in_maintenance:
    'The printer is in maintenance mode in PrintFarmer. Take it out of maintenance first.',
  printer_not_found: 'PrintFarmer no longer has this printer.',
  printer_offline:
    'The latest status observation reports this printer offline.',
  process_profile_missing:
    'This printer has no process profile selected in PrintFarmer.',
  process_profile_not_found:
    'The process profile PrintFarmer referenced no longer exists.',
  profile_compatibility_missing:
    'A slicer profile does not declare which printers it is compatible with.',
  profile_contains_credential:
    'A slicer profile contains something that looks like a credential, so it was refused.',
  profile_contains_filesystem_path:
    'A slicer profile contains a local filesystem path, so it was refused.',
  profile_contains_private_url:
    'A slicer profile contains a private URL, so it was refused.',
  profile_contains_unsafe_command:
    'A slicer profile contains an unsafe custom command, so it was refused.',
  profile_distribution_missing:
    'A slicer profile does not state which OrcaSlicer distribution it came from.',
  profile_distribution_unsupported:
    'A slicer profile did not come from the upstream OrcaSlicer distribution.',
  profile_format_missing:
    'This printer does not state its slicer profile format.',
  profile_format_unsupported:
    'This printer states a slicer profile format calibration does not support.',
  profile_gcode_dialect_mismatch:
    "A slicer profile's G-code flavour does not match this printer's Klipper dialect.",
  profile_gcode_dialect_missing:
    'A slicer profile does not state its G-code flavour.',
  profile_hash_mismatch:
    'A slicer profile no longer matches the hash PrintFarmer recorded for it.',
  profile_json_invalid: 'A slicer profile could not be read as valid JSON.',
  profile_json_missing: 'A slicer profile has no stored contents.',
  profile_machine_mismatch:
    'The machine profile is scoped to a different machine.',
  profile_nozzle_data_missing: 'A slicer profile carries no nozzle data.',
  profile_nozzle_material_mismatch:
    "A slicer profile's nozzle material does not match the installed nozzle.",
  profile_nozzle_mismatch:
    "A slicer profile's nozzle diameter does not match the installed nozzle.",
  profile_printer_mismatch:
    'A slicer profile is scoped to a different printer.',
  profile_printer_model_mismatch:
    'A slicer profile is scoped to a different printer model.',
  profile_revision_missing: 'A slicer profile carries no revision.',
  profile_service_unavailable:
    'PrintFarmer could not reach its profile service, so profiles could not be checked.',
  profile_slicer_mismatch: 'A slicer profile was produced by another slicer.',
  profile_version_mismatch:
    "A slicer profile's OrcaSlicer version does not match this printer's.",
  profile_version_missing:
    'A slicer profile does not state its OrcaSlicer version.',
  required_operations_unsupported:
    'This printer\u2019s adapter cannot both upload a file and start a print, which calibration needs.',
  slicer_distribution_missing:
    'This printer does not state its OrcaSlicer distribution. Set it to upstream in PrintFarmer.',
  slicer_distribution_unsupported:
    'This printer states an OrcaSlicer distribution other than upstream.',
  slicer_engine_missing:
    'This printer does not state its slicer engine. Set it to OrcaSlicer in PrintFarmer.',
  slicer_engine_unsupported:
    'This printer states a slicer engine other than OrcaSlicer.',
  slicer_version_missing: 'This printer does not state its OrcaSlicer version.',
  slicer_version_unsupported:
    "This printer's OrcaSlicer version is not in PrintFarmer's supported list.",
  status_stale: 'The latest status observation is too old to rely on.',
  status_unknown:
    'No authoritative status observation is available for this printer.',
  status_unsupported:
    'The configured adapter for this printer does not report status.',
  supported_materials_missing:
    'A toolhead does not list the materials it supports.',
  toolhead_offset_x_missing: 'A toolhead does not record its X offset.',
  toolhead_offset_y_missing: 'A toolhead does not record its Y offset.',
  toolhead_offset_z_missing: 'A toolhead does not record its Z offset.',

  // Client-authored diagnostics. They describe the *response*, not the
  // printer, so they are worded as such: an operator who cannot tell the two
  // apart will go and change hardware settings over a server defect.
  unrecognized_reason:
    'PrintFarmer gave a refusal reason this version of the app does not recognise. Updating the app may name it.',
  server_contradiction:
    'PrintFarmer called this printer ready and, in the same reply, said why it is not. Report this as a server defect.',
  server_unexplained_refusal:
    'PrintFarmer refused this printer without giving a single reason. Report this as a server defect.',
  client_eligibility_unverified:
    'PrintFarmer called this printer ready without naming the Klipper firmware, Klipper G-code dialect and upstream OrcaSlicer identities calibration requires.',
  client_explanation_truncated:
    'PrintFarmer gave more reasons than can be shown here, so this list is partial.',
};

/** The operator-facing sentence for one refusal code. */
export function describeRejectionReasonCode(
  code: CalibrationRejectionReasonCode,
): string {
  return REASON_MESSAGES[code];
}

/**
 * The one line naming the field paths PrintFarmer is still waiting on, or null
 * when it named none.
 *
 * Rendered as a single line rather than one bullet per path because the paths
 * accompany the reasons above rather than replacing them: `RejectMissing`
 * records a reason beside every missing input, so a bullet each would say the
 * same thing twice in two vocabularies. The paths are still worth showing —
 * they are exactly what someone editing the printer record, or filing a bug,
 * needs to quote.
 */
export function describeMissingInputs(
  fields: readonly string[],
): string | null {
  const named = fields.filter(
    (field) => field !== UNRECOGNIZED_CALIBRATION_INPUT,
  );
  const unnamed = fields.length - named.length;
  if (named.length === 0) {
    return unnamed === 0
      ? null
      : // Not the same as having nothing missing: the server did name inputs,
        // and this client could not carry their names. Saying nothing here
        // would present a lossy list as a complete one.
        `PrintFarmer named ${unnamed} further required field${
          unnamed === 1 ? '' : 's'
        } whose ${
          unnamed === 1 ? 'name was' : 'names were'
        } not in a form this app can show. Field paths are at most ${CALIBRATION_MAX_FIELD_PATH_LENGTH} characters.`;
  }
  const suffix =
    unnamed === 0
      ? ''
      : ` (and ${unnamed} further field${unnamed === 1 ? '' : 's'} this app could not name)`;
  return `PrintFarmer is still waiting on: ${named.join(', ')}${suffix}.`;
}
