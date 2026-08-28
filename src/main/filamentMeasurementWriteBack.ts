/**
 * Merging a calibration measurement into an OrcaSlicer filament profile.
 *
 * This is the *only* live write-back path for the filament calibration wizard.
 * `domain/patches.ts` (`buildOrcaProfilePatch`) and `orcaProfileGenerator.ts`
 * (`generateOrcaProfile`) both look like they do this job, but neither has a
 * production caller — they are residue of the retired printer-calibration saga.
 * A change made there does not affect what the wizard writes.
 *
 * Extracted from the IPC handler so the merge can be asserted directly on the
 * emitted profile. Before this, the only coverage reimplemented the merge in
 * the test rather than calling it, so a bug here would not have been caught by
 * anything: the test and the production code could disagree indefinitely.
 *
 * ## Wire shape
 *
 * OrcaSlicer stores per-key vectors as arrays of strings — even single-extruder
 * profiles carry a 1-element array. Writing a bare number is silent wire drift
 * that OrcaSlicer accepts and mis-interprets, so every value written here is
 * stringified into an array.
 */

import type { CalibrationFilamentMeasurement } from '@shared/ipc';

/**
 * Apply a measurement to a parsed filament-profile JSON object.
 *
 * Returns a new object; the input is not mutated.
 *
 * Branches on the measurement *shape* rather than a list of method literals.
 * The literal form is what broke this once already: it read
 * `method === 'flow_rate_pass_1' || method === 'flow_rate_pass_2'` with an
 * `else` that assumed temperature, so every flow method added afterwards would
 * have been written back as nozzle temperatures. Shape-branching means a new
 * method carrying an existing measurement field is routed correctly without
 * this function being edited at all.
 */
export function applyFilamentMeasurement(
  profile: Readonly<Record<string, unknown>>,
  measurement: CalibrationFilamentMeasurement,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...profile };

  if ('filamentFlowRatio' in measurement) {
    next.filament_flow_ratio = [measurement.filamentFlowRatio.toFixed(3)];
    return next;
  }

  if ('maxVolumetricSpeed' in measurement) {
    next.filament_max_volumetric_speed = [
      measurement.maxVolumetricSpeed.toFixed(2),
    ];
    return next;
  }

  if ('pressureAdvance' in measurement) {
    // Both keys, deliberately. A coefficient written while
    // `enable_pressure_advance` stays off produces a profile that reads as
    // calibrated and prints as though it were not — a failure mode invisible
    // in the profile JSON, which is why the flag is set here rather than left
    // to the operator to notice.
    next.pressure_advance = [measurement.pressureAdvance.toFixed(3)];
    next.enable_pressure_advance = ['1'];
    return next;
  }

  if ('retractionLength' in measurement) {
    // The `filament_`-prefixed per-filament override, not the machine-level
    // `retraction_length`. The wizard's output is a filament clone, so a
    // machine-scoped value would look correct in the profile and silently not
    // apply to the print. The server leaves this write-back to the client
    // precisely so it lands in the consumer's own scope.
    next.filament_retraction_length = [measurement.retractionLength.toFixed(2)];
    return next;
  }

  // temperature_tower — preserve any tail extruder indices already present on
  // the profile, so a multi-tool profile is not truncated by a measurement
  // taken on tool 0.
  const existingNozzle = next.nozzle_temperature;
  const tail = Array.isArray(existingNozzle)
    ? existingNozzle.slice(1).map((value) => String(value))
    : [];
  const nozzleHead = String(measurement.nozzleTemperature);
  next.nozzle_temperature =
    tail.length > 0 ? [nozzleHead, ...tail] : [nozzleHead];
  next.nozzle_temperature_initial_layer = [
    String(measurement.nozzleTemperatureInitialLayer),
  ];
  return next;
}
