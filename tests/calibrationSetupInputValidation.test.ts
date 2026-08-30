// @vitest-environment node
/**
 * `validateSetupInputs` — issue #797.
 *
 * A client-side mirror of
 * `CalibrationMethodGuidanceCatalog.ValidateSetupInputs`
 * (`Farm.Modules.Calibration.Services.Calibration.CalibrationMethodClassification`,
 * verified at PrintFarmer commit `b6a754c989e76edd71891e632bd940f1a81f3918`).
 * Only `TemperatureTower` (`start_temperature_c` / `end_temperature_c`,
 * 150–320 °C) and `MaximumVolumetricSpeed` (`sweep_start_mm3_s` /
 * `sweep_end_mm3_s`, 1–60 mm³/s) declare any setup inputs server-side; every
 * other method declares none — these tests use realistic fixtures for both
 * shapes plus the no-setup-inputs case.
 */
import { describe, expect, it } from 'vitest';
import {
  validateSetupInputs,
  type CalibrationGuidanceSetupInput,
} from '../src/renderer/calibration/filamentWizardState';

const START_TEMPERATURE: CalibrationGuidanceSetupInput = {
  key: 'start_temperature_c',
  label: 'Start temperature',
  unit: '°C',
  minimum: 150,
  maximum: 320,
};

const END_TEMPERATURE: CalibrationGuidanceSetupInput = {
  key: 'end_temperature_c',
  label: 'End temperature',
  unit: '°C',
  minimum: 150,
  maximum: 320,
};

const TEMPERATURE_TOWER_INPUTS = [START_TEMPERATURE, END_TEMPERATURE];

describe('validateSetupInputs', () => {
  it('returns null (valid) when a method declares no setup inputs', () => {
    // Every method other than TemperatureTower / MaximumVolumetricSpeed hits
    // this path server-side — the empty-array short circuit at the top of
    // the real algorithm.
    expect(validateSetupInputs([], {})).toBeNull();
    expect(validateSetupInputs([], { anything: 'ignored' })).toBeNull();
  });

  it('returns null (valid) when every declared input is present, numeric, and in range', () => {
    expect(
      validateSetupInputs(TEMPERATURE_TOWER_INPUTS, {
        start_temperature_c: 200,
        end_temperature_c: 240,
      }),
    ).toBeNull();
  });

  it('accepts the inclusive boundary values', () => {
    expect(
      validateSetupInputs(TEMPERATURE_TOWER_INPUTS, {
        start_temperature_c: 150,
        end_temperature_c: 320,
      }),
    ).toBeNull();
  });

  it('reports setup_input_missing for a key absent from the specification', () => {
    const result = validateSetupInputs(TEMPERATURE_TOWER_INPUTS, {
      end_temperature_c: 240,
    });
    expect(result).toEqual({
      code: 'setup_input_missing',
      input: START_TEMPERATURE,
    });
  });

  it('reports setup_input_invalid for a non-numeric value', () => {
    const result = validateSetupInputs(TEMPERATURE_TOWER_INPUTS, {
      start_temperature_c: '200',
      end_temperature_c: 240,
    });
    expect(result).toEqual({
      code: 'setup_input_invalid',
      input: START_TEMPERATURE,
    });
  });

  it('reports setup_input_invalid for a non-finite value (NaN/Infinity)', () => {
    expect(
      validateSetupInputs(TEMPERATURE_TOWER_INPUTS, {
        start_temperature_c: Number.NaN,
        end_temperature_c: 240,
      }),
    ).toEqual({ code: 'setup_input_invalid', input: START_TEMPERATURE });
    expect(
      validateSetupInputs(TEMPERATURE_TOWER_INPUTS, {
        start_temperature_c: 200,
        end_temperature_c: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ code: 'setup_input_invalid', input: END_TEMPERATURE });
  });

  it('reports setup_input_out_of_range for a value below minimum', () => {
    const result = validateSetupInputs(TEMPERATURE_TOWER_INPUTS, {
      start_temperature_c: 149,
      end_temperature_c: 240,
    });
    expect(result).toEqual({
      code: 'setup_input_out_of_range',
      input: START_TEMPERATURE,
    });
  });

  it('reports setup_input_out_of_range for a value above maximum', () => {
    const result = validateSetupInputs(TEMPERATURE_TOWER_INPUTS, {
      start_temperature_c: 200,
      end_temperature_c: 321,
    });
    expect(result).toEqual({
      code: 'setup_input_out_of_range',
      input: END_TEMPERATURE,
    });
  });

  it('evaluates declared inputs in order and returns the first failure', () => {
    // Both inputs fail here (missing AND out of range) — declaration order
    // means start_temperature_c's failure wins, matching the server's
    // first-failure-wins semantics exactly.
    const result = validateSetupInputs(TEMPERATURE_TOWER_INPUTS, {
      end_temperature_c: 999,
    });
    expect(result).toEqual({
      code: 'setup_input_missing',
      input: START_TEMPERATURE,
    });
  });

  it('validates the MaximumVolumetricSpeed shape (1–60 mm³/s) as a control against a different method', () => {
    const sweepStart: CalibrationGuidanceSetupInput = {
      key: 'sweep_start_mm3_s',
      label: 'Sweep start',
      unit: 'mm³/s',
      minimum: 1,
      maximum: 60,
    };
    const sweepEnd: CalibrationGuidanceSetupInput = {
      key: 'sweep_end_mm3_s',
      label: 'Sweep end',
      unit: 'mm³/s',
      minimum: 1,
      maximum: 60,
    };
    expect(
      validateSetupInputs([sweepStart, sweepEnd], {
        sweep_start_mm3_s: 5,
        sweep_end_mm3_s: 55,
      }),
    ).toBeNull();
    expect(
      validateSetupInputs([sweepStart, sweepEnd], {
        sweep_start_mm3_s: 0,
        sweep_end_mm3_s: 55,
      }),
    ).toEqual({ code: 'setup_input_out_of_range', input: sweepStart });
  });
});
