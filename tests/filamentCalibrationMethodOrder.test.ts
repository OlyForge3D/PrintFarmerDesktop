/**
 * The calibration methods the wizard offers, and the order it offers them in.
 *
 * ## Why this is pinned
 *
 * `FILAMENT_WIZARD_METHODS` is a bare array, so nothing except a test stops it
 * being reordered by a careless edit — and a wrong order here is silently
 * wrong. It shipped as `[flow_rate_pass_1, temperature_tower,
 * flow_rate_pass_2]` under a comment claiming "the recommended wiki order",
 * which it was not.
 *
 * The dependency is one-way and physical: nozzle temperature changes filament
 * viscosity and therefore how it flows, so a flow ratio measured before the
 * temperature is settled has to be measured again afterwards. Running flow
 * first throws away its own result.
 *
 * The OrcaSlicer calibration guide's full recommended order is Temperature →
 * Max volumetric speed → Pressure advance → Flow → Retraction → Cornering →
 * Input shaping → VFA (plus Tolerance, outside the numbered sequence):
 * https://www.orcaslicer.com/wiki/guides/calibration_guide
 *
 * Note that Flow is fourth, not second — max volumetric speed and pressure
 * advance sit between it and temperature. This suite therefore asserts the
 * *relative* order of the methods that exist rather than adjacency, because
 * the two categories the pipeline implements are not neighbours upstream.
 *
 * ## Why only three
 *
 * Of the guide's eight categories the pipeline implements two: temperature and
 * flow. Within flow, upstream offers four entries — YOLO (Recommended), YOLO
 * (Perfectionist), Pass 1, Pass 2 — and only the legacy two-pass pair is here.
 * `Farm.Slicer.Module.Models.CalibrationMethod` declares `FlowRatePass1`,
 * `FlowRatePass2`, `TemperatureTower`, and `CalibrationMethods.TryParse`
 * rejects every other wire name so the request fails fast rather than dying on
 * the worker.
 *
 * That is a server capability boundary, not a desktop omission, so this suite
 * asserts the boundary rather than a wished-for list. Tracked in
 * PrintFarmer#2051; when the pipeline gains a method, this test should fail and
 * be updated deliberately — including `CalibrationSliceMethod` in
 * `src/shared/ipc.ts` and the `.max(3)` ceiling on `completedMethods`, which
 * both hard-code the current count.
 */

import { describe, expect, it } from 'vitest';
import { CalibrationSliceMethod } from '@shared/ipc';
import {
  FILAMENT_METHOD_META,
  FILAMENT_WIZARD_METHODS,
} from '../src/renderer/calibration/filamentWizardState';

describe('filament calibration method catalogue', () => {
  it('offers temperature before either flow-rate pass', () => {
    const temperature = FILAMENT_WIZARD_METHODS.indexOf('temperature_tower');
    const pass1 = FILAMENT_WIZARD_METHODS.indexOf('flow_rate_pass_1');
    const pass2 = FILAMENT_WIZARD_METHODS.indexOf('flow_rate_pass_2');

    expect(temperature).toBeGreaterThanOrEqual(0);
    // The assertion that actually matters: flow measured at an uncalibrated
    // temperature has to be redone, so temperature cannot come second.
    expect(temperature).toBeLessThan(pass1);
    expect(temperature).toBeLessThan(pass2);
  });

  it('runs the coarse flow pass before the fine one', () => {
    // Pass 2 sweeps a narrow band around whatever pass 1 landed on, so the
    // reverse order has nothing to centre on.
    expect(FILAMENT_WIZARD_METHODS.indexOf('flow_rate_pass_1')).toBeLessThan(
      FILAMENT_WIZARD_METHODS.indexOf('flow_rate_pass_2'),
    );
  });

  it('offers exactly the methods the slice pipeline accepts — no more, no fewer', () => {
    // Control on both sides. Offering a method the server rejects strands the
    // operator at submit; omitting one the server supports hides a feature.
    expect([...FILAMENT_WIZARD_METHODS].sort()).toStrictEqual(
      [...CalibrationSliceMethod.options].sort(),
    );
  });

  it('gives every offered method the metadata the wizard renders', () => {
    // A method present in the list but absent from the meta map renders an
    // undefined title and throws on `meta.measurementSchema`.
    for (const method of FILAMENT_WIZARD_METHODS) {
      const meta = FILAMENT_METHOD_META[method];
      expect(meta, `no metadata for ${method}`).toBeDefined();
      expect(meta.title.length).toBeGreaterThan(0);
      expect(meta.summary.length).toBeGreaterThan(0);
      expect(meta.measurementPrompt.length).toBeGreaterThan(0);
    }
  });

  it('measures a temperature for the tower and a flow ratio for each flow pass', () => {
    // The schema drives which input the measurement step renders, so a wrong
    // pairing asks the operator for the wrong physical quantity.
    expect(FILAMENT_METHOD_META.temperature_tower.measurementSchema).toBe(
      'temperature',
    );
    expect(FILAMENT_METHOD_META.flow_rate_pass_1.measurementSchema).toBe(
      'flowRatio',
    );
    expect(FILAMENT_METHOD_META.flow_rate_pass_2.measurementSchema).toBe(
      'flowRatio',
    );
  });
});
