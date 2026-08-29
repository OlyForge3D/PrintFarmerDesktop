/**
 * The filament-calibration write-back, asserted on the emitted profile.
 *
 * ## Why this file exists
 *
 * `applyFilamentMeasurement` is the only live path by which a calibration
 * measurement reaches a filament profile. Two other modules used to look
 * like they did this job and did not — both were deleted in #791 because
 * neither ever had a production caller:
 *
 *   - `renderer/calibration/domain/patches.ts` (`buildOrcaProfilePatch`).
 *   - the bulk of `main/orcaProfileGenerator.ts` (`generateOrcaProfile`).
 *
 * Both were residue of the retired printer-calibration saga.
 *
 * `filamentCalibration.acceptance.test.ts` now delegates to this same
 * production function rather than reimplementing the merge, so a production
 * bug and a matching test bug can no longer coexist indefinitely without
 * either being visible. These tests call the real function directly.
 */

import { describe, expect, it } from 'vitest';

import { CalibrationFilamentMeasurement } from '@shared/ipc';
import { applyFilamentMeasurement } from '../src/main/filamentMeasurementWriteBack';

/** A minimal but realistic OrcaSlicer filament profile. */
function baseProfile(): Record<string, unknown> {
  return {
    name: 'PolyLite PLA Blue (calibration)',
    type: 'filament',
    inherits: 'PolyLite PLA',
    filament_type: ['PLA'],
    nozzle_temperature: ['210'],
    filament_flow_ratio: ['0.980'],
  };
}

/** Parse through the wire schema so fixtures cannot drift from the contract. */
function measurement(input: unknown): CalibrationFilamentMeasurement {
  return CalibrationFilamentMeasurement.parse(input);
}

describe('applyFilamentMeasurement — every measurement lands on its own key', () => {
  it('writes a flow ratio to filament_flow_ratio as a stringified array', () => {
    const result = applyFilamentMeasurement(
      baseProfile(),
      measurement({ method: 'flow_rate_pass_1', filamentFlowRatio: 1.0234 }),
    );
    expect(result.filament_flow_ratio).toStrictEqual(['1.023']);
  });

  it('routes all four flow methods to the same key', () => {
    // The regression this guards: the write-back used to branch on two method
    // literals with an `else` that assumed temperature, so YOLO measurements
    // would have been written back as nozzle temperatures.
    for (const method of [
      'flow_rate_pass_1',
      'flow_rate_pass_2',
      'flow_rate_yolo_recommended',
      'flow_rate_yolo_perfectionist',
    ]) {
      const result = applyFilamentMeasurement(
        baseProfile(),
        measurement({ method, filamentFlowRatio: 1.05 }),
      );
      expect(result.filament_flow_ratio, `${method} flow ratio`).toStrictEqual([
        '1.050',
      ]);
      // Control: it must NOT have taken the temperature branch. The old code
      // would have written nozzle_temperature from an undefined field.
      expect(result.nozzle_temperature, `${method} temperature`).toStrictEqual([
        '210',
      ]);
      expect(result.nozzle_temperature_initial_layer).toBeUndefined();
    }
  });

  it('writes max volumetric speed to filament_max_volumetric_speed', () => {
    const result = applyFilamentMeasurement(
      baseProfile(),
      measurement({ method: 'max_volumetric_speed', maxVolumetricSpeed: 14.5 }),
    );
    expect(result.filament_max_volumetric_speed).toStrictEqual(['14.50']);
    // Control: it did not fall through to another branch.
    expect(result.filament_flow_ratio).toStrictEqual(['0.980']);
  });

  it('writes pressure advance AND enables it', () => {
    // Writing the coefficient without the flag produces a profile that reads
    // as calibrated and prints as though it were not — invisible in the JSON
    // unless something asserts on both keys.
    const result = applyFilamentMeasurement(
      baseProfile(),
      measurement({ method: 'pressure_advance_tower', pressureAdvance: 0.042 }),
    );
    expect(result.pressure_advance).toStrictEqual(['0.042']);
    expect(result.enable_pressure_advance).toStrictEqual(['1']);
  });

  it('writes retraction to the filament override, not the machine key', () => {
    const result = applyFilamentMeasurement(
      baseProfile(),
      measurement({ method: 'retraction', retractionLength: 0.8 }),
    );
    expect(result.filament_retraction_length).toStrictEqual(['0.80']);
    // Control: the machine-scoped key must be untouched. A value written there
    // would look correct in the profile and silently not apply to the print,
    // because the wizard's output is a filament clone.
    expect(result.retraction_length).toBeUndefined();
  });

  it('writes both temperatures and preserves multi-tool tail indices', () => {
    const profile = { ...baseProfile(), nozzle_temperature: ['210', '225'] };
    const result = applyFilamentMeasurement(
      profile,
      measurement({
        method: 'temperature_tower',
        nozzleTemperature: 205,
        nozzleTemperatureInitialLayer: 215,
      }),
    );
    expect(result.nozzle_temperature).toStrictEqual(['205', '225']);
    expect(result.nozzle_temperature_initial_layer).toStrictEqual(['215']);
  });

  it('never mutates the profile it was given', () => {
    const profile = baseProfile();
    const snapshot = JSON.stringify(profile);
    applyFilamentMeasurement(
      profile,
      measurement({ method: 'retraction', retractionLength: 1.2 }),
    );
    expect(JSON.stringify(profile)).toBe(snapshot);
  });

  it('leaves every key it does not own untouched', () => {
    // A merge that rebuilt the object rather than spreading it would drop the
    // rest of the profile — which OrcaSlicer would accept, producing a profile
    // silently stripped of its inheritance and type.
    const result = applyFilamentMeasurement(
      baseProfile(),
      measurement({ method: 'max_volumetric_speed', maxVolumetricSpeed: 20 }),
    );
    expect(result.name).toBe('PolyLite PLA Blue (calibration)');
    expect(result.type).toBe('filament');
    expect(result.inherits).toBe('PolyLite PLA');
    expect(result.filament_type).toStrictEqual(['PLA']);
  });

  it('covers every branch of the measurement union', () => {
    // Structural control: if a new measurement branch is added to the wire
    // union and the write-back is not extended, that branch silently falls
    // through to the temperature tail below. Assert every declared branch
    // writes at least one key that the base profile did not already carry.
    const base = baseProfile();
    const samples: Record<string, unknown>[] = [
      { method: 'flow_rate_pass_1', filamentFlowRatio: 1.01 },
      { method: 'flow_rate_pass_2', filamentFlowRatio: 1.01 },
      { method: 'flow_rate_yolo_recommended', filamentFlowRatio: 1.01 },
      { method: 'flow_rate_yolo_perfectionist', filamentFlowRatio: 1.01 },
      { method: 'max_volumetric_speed', maxVolumetricSpeed: 12 },
      { method: 'pressure_advance_tower', pressureAdvance: 0.05 },
      { method: 'retraction', retractionLength: 0.9 },
      {
        method: 'temperature_tower',
        nozzleTemperature: 200,
        nozzleTemperatureInitialLayer: 210,
      },
    ];

    // The samples must cover the union exactly — no branch untested, none
    // invented.
    const declared = CalibrationFilamentMeasurement.options
      .map((branch) => branch.shape.method.value as string)
      .sort();
    const covered = samples.map((s) => s.method as string).sort();
    expect(covered).toStrictEqual(declared);

    for (const sample of samples) {
      const result = applyFilamentMeasurement(base, measurement(sample));
      const changed = Object.keys(result).filter(
        (key) => JSON.stringify(result[key]) !== JSON.stringify(base[key]),
      );
      expect(
        changed.length,
        `${String(sample.method)} wrote nothing`,
      ).toBeGreaterThan(0);
    }
  });
});
