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
 * ## Which categories are here, and why
 *
 * Two of the guide's eight categories: temperature (1) and flow (4). Within
 * flow, upstream offers four entries and all four are now present — YOLO
 * (Recommended), YOLO (Perfectionist), Pass 1, Pass 2 (#775, #776).
 *
 * Max volumetric speed (2), pressure advance (3) and retraction (5) are
 * implemented server-side and are being adopted separately (#777, #778, #779).
 *
 * Cornering (6), input shaping (7) and VFA (8) are excluded on purpose and are
 * not coming: they are *machine* calibrations whose results are firmware motion
 * settings, and the only thing this wizard writes is a filament profile. See
 * #786 and OlyForge3D/PrintFarmer#2162.
 *
 * The server no longer gates any catalogued method — `IsSlicerSupported`
 * returns `true` for all of them — so the boundary this suite asserts is now
 * the desktop's own adoption state rather than a server capability limit.
 */

import { describe, expect, it } from 'vitest';
import {
  CalibrationFilamentMeasurement,
  CalibrationSliceMethod,
  FilamentWizardStateRecord,
} from '@shared/ipc';
import type { FilamentWizardStateRecord as FilamentWizardStateRecordType } from '@shared/ipc';
import {
  FILAMENT_METHOD_META,
  FILAMENT_WIZARD_METHODS,
  SCALAR_MEASUREMENT_SPECS,
  deriveGuidedMethodStates,
  isFlowRatioMethod,
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
    expect(
      FILAMENT_METHOD_META.flow_rate_yolo_recommended.measurementSchema,
    ).toBe('flowRatio');
    expect(
      FILAMENT_METHOD_META.flow_rate_yolo_perfectionist.measurementSchema,
    ).toBe('flowRatio');
  });

  it('offers YOLO (Recommended) before the legacy two-pass method', () => {
    // Recommended is the default choice; listing it after the legacy pair
    // implies the passes are the primary route, which is the opposite of the
    // guidance in the summaries.
    const recommended = FILAMENT_WIZARD_METHODS.indexOf(
      'flow_rate_yolo_recommended',
    );
    const pass1 = FILAMENT_WIZARD_METHODS.indexOf('flow_rate_pass_1');
    expect(recommended).toBeGreaterThanOrEqual(0);
    expect(recommended).toBeLessThan(pass1);
  });

  it('offers YOLO (Recommended) before YOLO (Perfectionist)', () => {
    // Perfectionist refines whatever Recommended landed on, so the reverse
    // order has nothing to refine — the same dependency the two legacy passes
    // have between them.
    expect(
      FILAMENT_WIZARD_METHODS.indexOf('flow_rate_yolo_recommended'),
    ).toBeLessThan(
      FILAMENT_WIZARD_METHODS.indexOf('flow_rate_yolo_perfectionist'),
    );
  });

  it('gives all four flow methods distinguishable summaries', () => {
    // Four near-identical flow entries with copy-pasted metadata is worse for
    // the operator than the two we shipped before. Distinct summaries are what
    // make the choice possible at all.
    const flowMethods = FILAMENT_WIZARD_METHODS.filter((method) =>
      isFlowRatioMethod(method),
    );
    expect(flowMethods.length).toBe(4);

    const summaries = flowMethods.map(
      (method) => FILAMENT_METHOD_META[method].summary,
    );
    expect(new Set(summaries).size).toBe(summaries.length);

    // Control: the check above only proves the strings differ, which two
    // typo-divergent copies would also satisfy. Each summary must actually
    // name its own role in the choice.
    expect(
      FILAMENT_METHOD_META.flow_rate_yolo_recommended.summary.toLowerCase(),
    ).toContain('default');
    expect(
      FILAMENT_METHOD_META.flow_rate_yolo_perfectionist.summary.toLowerCase(),
    ).toContain('after recommended');
    expect(
      FILAMENT_METHOD_META.flow_rate_pass_1.summary.toLowerCase(),
    ).toContain('legacy');
    expect(
      FILAMENT_METHOD_META.flow_rate_pass_2.summary.toLowerCase(),
    ).toContain('legacy');
  });

  it('agrees with the wire measurement union about which methods are flow ratios', () => {
    // `isFlowRatioMethod` answers at runtime from the metadata catalogue but is
    // *typed* from the wire union, so the two are independent sources that must
    // agree. If they drift, the measurement step renders a flow-ratio input for
    // a method whose IPC payload expects temperatures — which typechecks,
    // because the predicate asserts the narrowing rather than proving it.
    const flowFromCatalogue = CalibrationSliceMethod.options
      .filter((method) => isFlowRatioMethod(method))
      .sort();

    const flowFromWireUnion = CalibrationFilamentMeasurement.options
      .filter((branch) => 'filamentFlowRatio' in branch.shape)
      .map((branch) => branch.shape.method.value as string)
      .sort();

    expect(flowFromCatalogue).toStrictEqual(flowFromWireUnion);

    // Control: the comparison must be capable of failing. Temperature tower is
    // in neither list, and a predicate that returned true for everything would
    // put it in the first.
    expect(flowFromCatalogue).not.toContain('temperature_tower');
    expect(flowFromWireUnion).not.toContain('temperature_tower');
    expect(flowFromCatalogue.length).toBeGreaterThan(0);
  });

  it('follows the guide order across all five adopted categories', () => {
    // Guide order is Temperature (1) → Max volumetric speed (2) → Pressure
    // advance (3) → Flow (4) → Retraction (5). Appending a method rather than
    // slotting it by guide position silently inverts the recommended sequence,
    // which is the whole reason this file exists.
    const at = (method: string): number =>
      FILAMENT_WIZARD_METHODS.indexOf(method as never);

    expect(at('temperature_tower')).toBeLessThan(at('max_volumetric_speed'));
    expect(at('max_volumetric_speed')).toBeLessThan(
      at('pressure_advance_tower'),
    );
    expect(at('pressure_advance_tower')).toBeLessThan(
      at('flow_rate_yolo_recommended'),
    );
    expect(at('flow_rate_pass_2')).toBeLessThan(at('retraction'));

    // Control: every method named above is actually in the list. `indexOf`
    // returns -1 for an absent method, and -1 < anything, so the assertions
    // above would pass vacuously against a list that had lost an entry.
    for (const method of [
      'temperature_tower',
      'max_volumetric_speed',
      'pressure_advance_tower',
      'flow_rate_yolo_recommended',
      'flow_rate_pass_2',
      'retraction',
    ]) {
      expect(
        at(method),
        `${method} missing from the wizard list`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it('labels each scalar measurement with the band the wire schema actually enforces', () => {
    // The spec's min/max are presentation only — the measurement step validates
    // by parsing `CalibrationFilamentMeasurement`. If the label and the schema
    // disagree, the operator is told one band and rejected against another.
    // Probing both edges is what makes this an agreement test rather than a
    // restatement of the spec.
    const methodForSchema = new Map<string, string>();
    for (const method of CalibrationSliceMethod.options) {
      methodForSchema.set(
        FILAMENT_METHOD_META[method].measurementSchema,
        method,
      );
    }

    for (const [schema, spec] of Object.entries(SCALAR_MEASUREMENT_SPECS)) {
      const method = methodForSchema.get(schema);
      expect(method, `no method uses the ${schema} schema`).toBeDefined();
      if (method === undefined) continue;

      const parse = (value: number): boolean =>
        CalibrationFilamentMeasurement.safeParse({
          method,
          [spec.field]: value,
        }).success;

      // Inside the advertised band, at both edges.
      expect(parse(spec.min), `${schema}: min ${spec.min} rejected`).toBe(true);
      expect(parse(spec.max), `${schema}: max ${spec.max} rejected`).toBe(true);

      // Outside it — the control. A schema with no bounds at all would pass
      // the two assertions above and fail these.
      const outside = Math.max(Math.abs(spec.max - spec.min) * 0.5, 0.001);
      expect(
        parse(spec.min - outside),
        `${schema}: below-band value accepted`,
      ).toBe(false);
      expect(
        parse(spec.max + outside),
        `${schema}: above-band value accepted`,
      ).toBe(false);
    }
  });

  it('gives the three new-quantity methods their own measurement schemas', () => {
    expect(FILAMENT_METHOD_META.max_volumetric_speed.measurementSchema).toBe(
      'maxVolumetricSpeed',
    );
    expect(FILAMENT_METHOD_META.pressure_advance_tower.measurementSchema).toBe(
      'pressureAdvance',
    );
    expect(FILAMENT_METHOD_META.retraction.measurementSchema).toBe(
      'retractionLength',
    );

    // Control: these must not be flow ratios. Reusing `flowRatio` would render
    // a flow-ratio input and submit a payload the IPC boundary rejects.
    expect(isFlowRatioMethod('max_volumetric_speed')).toBe(false);
    expect(isFlowRatioMethod('pressure_advance_tower')).toBe(false);
    expect(isFlowRatioMethod('retraction')).toBe(false);
    expect(isFlowRatioMethod('flow_rate_yolo_recommended')).toBe(true);
  });
});

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function sampleRecord(
  completedMethods: FilamentWizardStateRecordType['completedMethods'],
): FilamentWizardStateRecordType {
  return {
    schemaVersion: 1,
    printerId: 'printer-1',
    printerModelId: null,
    machineName: 'Voron 2.4 350',
    processName: '0.20mm Standard @Voron 2.4',
    baseFilamentName: 'PolyLite PLA Blue',
    baseFilamentGuid: PROFILE_ID,
    cloneId: '33333333-3333-4333-8333-333333333333',
    cloneName: 'PolyLite PLA Blue (calibration)',
    calibrationProjectId: null,
    completedMethods,
    currentMethod: null,
    inFlightJob: null,
    phase: 'methodPicker',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('FilamentWizardStateRecord.completedMethods ceiling', () => {
  // Regression guard for issue #771: `completedMethods` previously carried a
  // hard-coded `.max(3)` that could silently drift from the
  // `CalibrationSliceMethod` catalogue. These tests derive their fixtures
  // from `CalibrationSliceMethod.options.length` rather than a literal, so
  // they only keep passing if the schema's ceiling tracks the enum too --
  // adding or removing a method changes both sides together.
  //
  // Merged here from #772, which landed on `development` while this branch
  // was open and independently created a file of the same name. The two
  // suites are complementary rather than competing: the catalogue tests above
  // pin which methods exist and in what order, these pin how many the
  // persisted record will accept. Keeping them in one file means a method
  // added to the enum fails both halves together, which is the point.
  it('accepts a completedMethods list equal to the full method catalogue', () => {
    const record = sampleRecord([...CalibrationSliceMethod.options]);
    expect(() => FilamentWizardStateRecord.parse(record)).not.toThrow();
  });

  it('rejects a completedMethods list longer than the method catalogue', () => {
    const tooMany = [
      ...CalibrationSliceMethod.options,
      CalibrationSliceMethod.options[0],
    ];
    const record = sampleRecord(tooMany);
    expect(() => FilamentWizardStateRecord.parse(record)).toThrow();
  });
});

describe('deriveGuidedMethodStates (issue #794)', () => {
  // A synthetic two-method list — temperature_tower then flow_rate_pass_1,
  // in that relative order, though flow_rate_pass_1 sits much later (index
  // 5) in the real `FILAMENT_WIZARD_METHODS` — so "jump ahead" has a single,
  // unambiguous meaning for these tests: starting flow_rate_pass_1 before
  // temperature_tower resolves. `deriveGuidedMethodStates` only cares about
  // the order of whatever `methods` array it is given, not the full guided
  // catalogue, so this slice is sufficient to exercise its locking logic.
  const methods: readonly (typeof FILAMENT_WIZARD_METHODS)[number][] = [
    'temperature_tower',
    'flow_rate_pass_1',
  ];

  const noneCompleted = (): readonly never[] => [];
  const allPending = () => null;

  it('gating unavailable: returns null so nothing is locked (no project yet, or a failed/loading progress read)', () => {
    // Regression control for "existing local-state behavior for methods not
    // yet migrated continues to function" — a caller with no trustworthy
    // server state must get back "don't gate", not a guess.
    const result = deriveGuidedMethodStates([...methods], {
      completedMethods: noneCompleted(),
      dispositionFor: allPending,
      gatingAvailable: false,
    });
    expect(result).toBeNull();
  });

  it('blocks jumping ahead: the second method locks while the first is still unresolved', () => {
    const result = deriveGuidedMethodStates([...methods], {
      completedMethods: noneCompleted(),
      dispositionFor: allPending,
      gatingAvailable: true,
    });
    expect(result).not.toBeNull();
    const states = result ?? [];
    const temperature = states.find((s) => s.method === 'temperature_tower');
    const flow = states.find((s) => s.method === 'flow_rate_pass_1');
    expect(temperature?.status).toBe('next');
    expect(temperature?.locked).toBe(false);
    // The negative case this issue's acceptance criteria require: jumping
    // ahead to the second step is blocked while the first is unresolved.
    expect(flow?.status).toBe('pending');
    expect(flow?.locked).toBe(true);
  });

  it('control: allows the legitimately-next method once the prior one is done', () => {
    // Paired positive control for the test above, proving the lock is
    // order-sensitive rather than a blanket "everything after index 0 is
    // locked" bug — resolving the first method unlocks the second as `next`.
    const result = deriveGuidedMethodStates([...methods], {
      completedMethods: ['temperature_tower'],
      dispositionFor: allPending,
      gatingAvailable: true,
    });
    expect(result).not.toBeNull();
    const states = result ?? [];
    const temperature = states.find((s) => s.method === 'temperature_tower');
    const flow = states.find((s) => s.method === 'flow_rate_pass_1');
    expect(temperature?.status).toBe('done');
    expect(temperature?.locked).toBe(false);
    expect(flow?.status).toBe('next');
    expect(flow?.locked).toBe(false);
  });

  it('control: a server-Completed disposition also resolves a step, independent of local completedMethods', () => {
    // Completed is server-derived only (issue #797) — the desktop client
    // never writes it locally, so this exercises the other half of the
    // "done" union that `completedMethods` above does not cover.
    const result = deriveGuidedMethodStates([...methods], {
      completedMethods: noneCompleted(),
      dispositionFor: (method) =>
        method === 'temperature_tower' ? 'Completed' : null,
      gatingAvailable: true,
    });
    const states = result ?? [];
    const flow = states.find((s) => s.method === 'flow_rate_pass_1');
    expect(flow?.status).toBe('next');
    expect(flow?.locked).toBe(false);
  });

  it('never locks a done or skipped method, regardless of its position in the order', () => {
    // "Skip never blocks completion" (#797) and "a completed step stays
    // reachable to rerun" both mean done/skipped must never be `locked`,
    // even though they are not the `next` recommendation either.
    const result = deriveGuidedMethodStates([...methods], {
      completedMethods: [],
      dispositionFor: (method) =>
        method === 'temperature_tower' ? 'Skipped' : null,
      gatingAvailable: true,
    });
    const states = result ?? [];
    const temperature = states.find((s) => s.method === 'temperature_tower');
    const flow = states.find((s) => s.method === 'flow_rate_pass_1');
    expect(temperature?.status).toBe('skipped');
    expect(temperature?.locked).toBe(false);
    // Skipping the first step still promotes the second to `next`.
    expect(flow?.status).toBe('next');
    expect(flow?.locked).toBe(false);
  });

  it('prefers a server-authoritative Skipped disposition over a stale local completedMethods entry', () => {
    // Regression: server disposition must win when it disagrees with the
    // legacy local set — e.g. the method was marked done locally before
    // this project existed, then explicitly skipped server-side afterwards
    // (from this device or another one). Reporting it as `done` here would
    // silently discard that skip and mismatch the disposition label the
    // picker renders alongside it ("Skipped").
    const result = deriveGuidedMethodStates([...methods], {
      completedMethods: ['temperature_tower'],
      dispositionFor: (method) =>
        method === 'temperature_tower' ? 'Skipped' : null,
      gatingAvailable: true,
    });
    const states = result ?? [];
    const temperature = states.find((s) => s.method === 'temperature_tower');
    expect(temperature?.status).toBe('skipped');
    expect(temperature?.locked).toBe(false);
  });

  it('prefers a server-authoritative Pending disposition over a stale local completedMethods entry', () => {
    // Regression: the local fallback must only fire when the server has NO
    // recorded disposition at all (`null`), not merely when it isn't
    // `Completed`/`Skipped`. An earlier fix pass only special-cased
    // `Skipped`, leaving an explicit server `Pending` disposition to still
    // fall through to the legacy local set and incorrectly report `done` —
    // the same server-authority violation the Skipped case guards against.
    const result = deriveGuidedMethodStates([...methods], {
      completedMethods: ['temperature_tower'],
      dispositionFor: (method) =>
        method === 'temperature_tower' ? 'Pending' : null,
      gatingAvailable: true,
    });
    const states = result ?? [];
    const temperature = states.find((s) => s.method === 'temperature_tower');
    expect(temperature?.status).not.toBe('done');
    // Pending and first in order, so it becomes the recommended next step.
    expect(temperature?.status).toBe('next');
    expect(temperature?.locked).toBe(false);
  });

  it('assigns `next` to exactly one method across the full guided order', () => {
    // Control against a broken implementation that marks every unresolved
    // method as `next` (which would defeat locking entirely) or none at all.
    const result = deriveGuidedMethodStates([...FILAMENT_WIZARD_METHODS], {
      completedMethods: [],
      dispositionFor: () => null,
      gatingAvailable: true,
    });
    const states = result ?? [];
    const nextCount = states.filter((s) => s.status === 'next').length;
    expect(nextCount).toBe(1);
    expect(states[0]?.status).toBe('next');
    for (const state of states.slice(1)) {
      expect(state.status).toBe('pending');
      expect(state.locked).toBe(true);
    }
  });
});
