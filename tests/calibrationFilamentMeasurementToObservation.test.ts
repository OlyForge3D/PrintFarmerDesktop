/**
 * `mapFilamentMeasurementToObservation` — issue #795.
 *
 * Verifies the pure mapping from a desktop `CalibrationFilamentMeasurement`
 * to the `calibrationKind`/`method`/`specification`/`measurements` shape the
 * server's `POST /api/calibration-projects/{projectId}/attempts` and
 * `POST /api/calibration-attempts/{attemptId}/observations` routes expect.
 */

import { describe, expect, it } from 'vitest';
import { mapFilamentMeasurementToObservation } from '../src/main/ipc.js';
import {
  PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C,
  type CalibrationFilamentMeasurement,
} from '@shared/ipc';

describe('mapFilamentMeasurementToObservation', () => {
  it.each([
    ['flow_rate_pass_1', 'flow'],
    ['flow_rate_pass_2', 'flow'],
    ['flow_rate_yolo_recommended', 'flow'],
    ['flow_rate_yolo_perfectionist', 'flow'],
  ] as const)(
    'maps %s to calibrationKind "%s" carrying flow_ratio only',
    (method, calibrationKind) => {
      const measurement: CalibrationFilamentMeasurement = {
        method,
        filamentFlowRatio: 0.97,
      };

      const result = mapFilamentMeasurementToObservation(measurement);

      expect(result.calibrationKind).toBe(calibrationKind);
      expect(result.method).toBe(method);
      expect(result.specification).toEqual({});
      expect(result.measurements).toEqual({ flow_ratio: 0.97 });
    },
  );

  it('maps temperature_tower to kind "temperature", submitting only the steady-state reading', () => {
    const measurement: CalibrationFilamentMeasurement = {
      method: 'temperature_tower',
      nozzleTemperature: 215,
      nozzleTemperatureInitialLayer: 220,
    };

    const result = mapFilamentMeasurementToObservation(measurement);

    expect(result.calibrationKind).toBe('temperature');
    expect(result.method).toBe('temperature_tower');
    expect(result.measurements).toEqual({ temperature_c: 215 });
    // `nozzleTemperatureInitialLayer` has no server-side calibration-kind
    // equivalent — it is deliberately absent here, and continues to feed
    // only the parallel live-clone write-back.
    expect(result.measurements).not.toHaveProperty(
      'nozzleTemperatureInitialLayer',
    );
    expect(result.specification).toEqual({
      start_temperature_c: 150,
      end_temperature_c: PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C,
    });
  });

  it('maps max_volumetric_speed to kind "max_volumetric_speed" with a sweep specification', () => {
    const measurement: CalibrationFilamentMeasurement = {
      method: 'max_volumetric_speed',
      maxVolumetricSpeed: 12.5,
    };

    const result = mapFilamentMeasurementToObservation(measurement);

    expect(result.calibrationKind).toBe('max_volumetric_speed');
    expect(result.measurements).toEqual({
      max_volumetric_speed_mm3_s: 12.5,
    });
    expect(result.specification).toEqual({
      sweep_start_mm3_s: 1,
      sweep_end_mm3_s: 60,
    });
  });

  it('maps pressure_advance_tower to kind "pressure_advance" with no specification', () => {
    const measurement: CalibrationFilamentMeasurement = {
      method: 'pressure_advance_tower',
      pressureAdvance: 0.045,
    };

    const result = mapFilamentMeasurementToObservation(measurement);

    expect(result.calibrationKind).toBe('pressure_advance');
    expect(result.measurements).toEqual({ pressure_advance: 0.045 });
    expect(result.specification).toEqual({});
  });

  it('maps retraction to kind "retraction" with no specification', () => {
    const measurement: CalibrationFilamentMeasurement = {
      method: 'retraction',
      retractionLength: 0.6,
    };

    const result = mapFilamentMeasurementToObservation(measurement);

    expect(result.calibrationKind).toBe('retraction');
    expect(result.measurements).toEqual({ retraction_length_mm: 0.6 });
    expect(result.specification).toEqual({});
  });
});
