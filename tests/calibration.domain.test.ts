import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_STAGE_IDS,
  CALIBRATION_STAGES,
  CALIBRATION_BOUNDS,
  applyFlowAdjustment,
  buildWorkflowViewModel,
  calibrationReducer,
  createCalibrationState,
  decideCalibrationAction,
  isMethodAvailable,
  linearSweepValue,
  maximumVolumetricRate,
  pressureAdvanceAtHeight,
  replayCalibrationEvents,
  shrinkageCompensationPercent,
  temperatureAtBand,
  validateBaselineProfile,
  validateObservation,
  type BaselineProfile,
  type CalibrationBinding,
  type CalibrationEvent,
  type CalibrationMethod,
  type CalibrationObservation,
  type CalibrationStageId,
  type CalibrationState,
  type RuntimeCalibrationContext,
} from '../src/renderer/calibration/domain';

const baseline: BaselineProfile = {
  nozzleTemperatureC: 220,
  flowRatio: 0.98,
  pressureAdvance: 0.04,
  retractionLengthMm: 0.8,
  maximumVolumetricRateMm3S: 12,
  shrinkageCompensationXPercent: 100,
  shrinkageCompensationYPercent: 100,
  shrinkageCompensationZPercent: 100,
};

function binding(snapshotId = 'snapshot-1', revision = 4): CalibrationBinding {
  return {
    printer: {
      backendProfileId: 'profile-a',
      backendPrinterId: 'printer-a',
      printerConfigurationId: 'config-a',
      printerConfigurationRevision: revision,
    },
    snapshot: {
      snapshotId,
      snapshotRevision: revision,
      capturedAt: `2026-07-26T0${revision}:00:00.000Z`,
      configurationRevision: revision,
      toolheads: [
        {
          toolId: 'tool-0',
          toolheadId: 'head-0',
          nozzle: {
            nozzleId: 'nozzle-0',
            diameterMm: 0.4,
            material: 'hardened steel',
          },
          extruderType: 'directDrive',
        },
      ],
      safety: {
        buildVolumeMm: { x: 250, y: 250, z: 250 },
        maximumNozzleTemperatureC: 300,
        maximumBedTemperatureC: 120,
        maximumVolumetricRateMm3S: 40,
        emergencyStopAvailable: true,
        thermalProtectionConfirmed: true,
        ventilationAssessed: true,
      },
    },
    selectedToolId: 'tool-0',
    selectedToolheadId: 'head-0',
    selectedNozzleId: 'nozzle-0',
    filament: {
      filamentProjectId: 'filament-project-a',
      provider: 'Provider',
      product: 'PETG',
      sku: 'PETG-BLK',
      spoolId: 'spool-7',
    },
  };
}

function initial(mode: 'coach' | 'expert' = 'expert'): CalibrationState {
  return createCalibrationState({
    projectId: 'project-a',
    createdAt: '2026-07-26T08:00:00.000Z',
    mode,
    baseline,
    binding: binding(),
  });
}

function eventBase(id: string) {
  return {
    eventId: id,
    timestamp: '2026-07-26T08:30:00.000Z',
  };
}

function observationFor(
  stageId: CalibrationStageId,
  attemptId: string,
  observationId: string,
): CalibrationObservation {
  const common = {
    observationId,
    attemptId,
    observedAt: '2026-07-26T09:00:00.000Z',
    notes: 'Controlled physical observation.',
  };
  switch (stageId) {
    case 'temperature':
      return { ...common, stageId, temperatureC: 225, quality: 5 };
    case 'flowPass1':
      return { ...common, stageId, adjustmentPercent: 5, quality: 4 };
    case 'flowPass2':
      return { ...common, stageId, adjustmentPercent: -1, quality: 5 };
    case 'pressureAdvance':
      return { ...common, stageId, pressureAdvance: 0.045, quality: 4 };
    case 'flowVerification':
    case 'finalVerification':
      return { ...common, stageId, passed: true, defectCount: 0 };
    case 'retraction':
      return { ...common, stageId, retractionLengthMm: 0.7, quality: 4 };
    case 'maximumVolumetricSpeed':
      return {
        ...common,
        stageId,
        stableVolumetricRateMm3S: 18,
        quality: 4,
      };
    case 'shrinkage':
      return {
        ...common,
        stageId,
        nominalXmm: 100,
        nominalYmm: 100,
        nominalZmm: 100,
        measuredXmm: 99.5,
        measuredYmm: 99.7,
        measuredZmm: 100.2,
      };
  }
}

const defaultMethod: Readonly<Record<CalibrationStageId, CalibrationMethod>> = {
  temperature: 'temperatureTower',
  flowPass1: 'flowStandard',
  flowPass2: 'flowFine',
  pressureAdvance: 'pressureAdvanceTower',
  flowVerification: 'verificationPrint',
  retraction: 'retractionTower',
  maximumVolumetricSpeed: 'volumetricSpeedTower',
  shrinkage: 'dimensionalCoupon',
  finalVerification: 'verificationPrint',
};

function completeStage(
  state: CalibrationState,
  stageId: CalibrationStageId,
  sequence: number,
  method = defaultMethod[stageId],
): CalibrationState {
  const attemptId = `attempt-${sequence}`;
  const observationId = `observation-${sequence}`;
  const events: readonly CalibrationEvent[] = [
    {
      ...eventBase(`${sequence}1`),
      type: 'beginAttempt',
      attemptId,
      stageId,
      method,
    },
    {
      ...eventBase(`${sequence}2`),
      type: 'recordObservation',
      attemptId,
      observation: observationFor(stageId, attemptId, observationId),
    },
    {
      ...eventBase(`${sequence}3`),
      type: 'selectObservation',
      attemptId,
      observationId,
    },
    {
      ...eventBase(`${sequence}4`),
      type: 'completeAttempt',
      attemptId,
      confidence: 'high',
    },
  ];
  return replayCalibrationEvents(state, events);
}

function runtime(
  overrides: Partial<RuntimeCalibrationContext> = {},
): RuntimeCalibrationContext {
  return {
    online: true,
    pendingMutationCount: 0,
    unresolvedConflictCount: 0,
    currentPrinterConfigurationRevision: 4,
    currentSnapshotRevision: 4,
    physicalMatch: {
      snapshotId: 'snapshot-1',
      toolId: 'tool-0',
      toolheadId: 'head-0',
      nozzleId: 'nozzle-0',
      nozzleDiameterMm: 0.4,
      confirmedAt: '2026-07-26T08:00:00.000Z',
    },
    bedClearConfirmed: true,
    operatorPresent: true,
    serverGenerationEnabled: true,
    serverArtifactPromotionEnabled: true,
    ...overrides,
  };
}

describe('calibration workflow catalog and formulas', () => {
  it('defines the deterministic nine-stage order and every supported method', () => {
    expect(CALIBRATION_STAGES.map((stage) => stage.id)).toEqual(
      CALIBRATION_STAGE_IDS,
    );
    expect(isMethodAvailable('flowPass1', 'expert', 'flowStandard')).toBe(true);
    expect(isMethodAvailable('flowPass1', 'expert', 'flowCoarse')).toBe(true);
    expect(isMethodAvailable('flowPass1', 'expert', 'flowYolo')).toBe(true);
    expect(isMethodAvailable('flowPass1', 'coach', 'flowYolo')).toBe(false);
    expect(
      isMethodAvailable('pressureAdvance', 'expert', 'pressureAdvanceTower'),
    ).toBe(true);
    expect(
      isMethodAvailable('pressureAdvance', 'expert', 'pressureAdvanceLine'),
    ).toBe(true);
    expect(
      isMethodAvailable('pressureAdvance', 'expert', 'pressureAdvancePattern'),
    ).toBe(true);
    expect(
      new Set(
        CALIBRATION_STAGES.flatMap((stage) => [
          ...stage.coachMethods,
          ...stage.expertMethods,
        ]),
      ),
    ).toEqual(
      new Set([
        'temperatureTower',
        'flowStandard',
        'flowCoarse',
        'flowYolo',
        'flowFine',
        'pressureAdvanceTower',
        'pressureAdvanceLine',
        'pressureAdvancePattern',
        'verificationPrint',
        'retractionTower',
        'volumetricSpeedTower',
        'dimensionalCoupon',
      ]),
    );
  });

  it('uses bounded, deterministic calibration formulas', () => {
    expect(CALIBRATION_BOUNDS.flowFineAdjustmentPercent).toEqual({
      minimum: -10,
      maximum: 10,
      step: 1,
      unit: 'percent',
    });
    expect(applyFlowAdjustment(0.98, 5)).toBe(1.029);
    expect(applyFlowAdjustment(1.029, -1)).toBe(1.01871);
    expect(temperatureAtBand(250, 5, 3)).toBe(235);
    expect(linearSweepValue(0.02, 0.005, 10)).toBe(0.07);
    expect(pressureAdvanceAtHeight(0.02, 0.005, 10)).toBe(0.07);
    expect(maximumVolumetricRate(0.45, 0.2, 100)).toBe(9);
    expect(shrinkageCompensationPercent(100, 99.5)).toBe(100.5025);
    expect(
      validateBaselineProfile({
        ...baseline,
        pressureAdvance: -1,
        retractionLengthMm: 101,
        maximumVolumetricRateMm3S: 0,
        shrinkageCompensationXPercent: 101,
      }).map((diagnostic) => diagnostic.field),
    ).toEqual(
      expect.arrayContaining([
        'pressureAdvance',
        'retractionLengthMm',
        'maximumVolumetricRateMm3S',
        'shrinkageCompensationXPercent',
      ]),
    );
  });

  it('reports model errors and hardware-bound warnings without guessing', () => {
    const tooHot = {
      ...observationFor('temperature', 'attempt', 'hot'),
      temperatureC: 310,
    };
    const excessiveFlow = {
      ...observationFor('flowPass2', 'attempt', 'flow'),
      adjustmentPercent: 15,
    };
    const highRetraction = {
      ...observationFor('retraction', 'attempt', 'retract'),
      retractionLengthMm: 9,
    };
    const highPressureAdvance = {
      ...observationFor('pressureAdvance', 'attempt', 'pa'),
      pressureAdvance: 0.3,
    };
    const excessiveVolumetricRate = {
      ...observationFor('maximumVolumetricSpeed', 'attempt', 'mvs'),
      stableVolumetricRateMm3S: 50,
    };
    const excessiveShrinkage = {
      ...observationFor('shrinkage', 'attempt', 'shrink'),
      measuredXmm: 80,
    };
    const failedVerification = {
      ...observationFor('flowVerification', 'attempt', 'verify'),
      passed: false,
      defectCount: 2,
    };
    expect(validateObservation(tooHot, binding())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'TEMPERATURE_EXCEEDS_SNAPSHOT_LIMIT',
          severity: 'error',
        }),
      ]),
    );
    expect(validateObservation(excessiveFlow, binding(), 'flowFine')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'FLOW_ADJUSTMENT_OUT_OF_RANGE' }),
      ]),
    );
    expect(validateObservation(highRetraction, binding())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'HIGH_RETRACTION_LENGTH',
          severity: 'warning',
        }),
      ]),
    );
    expect(validateObservation(highPressureAdvance, binding())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNUSUALLY_HIGH_PRESSURE_ADVANCE',
          severity: 'warning',
        }),
      ]),
    );
    expect(validateObservation(excessiveVolumetricRate, binding())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'VOLUMETRIC_RATE_EXCEEDS_SNAPSHOT_LIMIT',
          severity: 'error',
        }),
      ]),
    );
    expect(validateObservation(excessiveShrinkage, binding())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SHRINKAGE_COMPENSATION_OUT_OF_RANGE',
          severity: 'error',
        }),
      ]),
    );
    expect(validateObservation(failedVerification, binding())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'VERIFICATION_REQUIRES_REVIEW',
          severity: 'warning',
        }),
      ]),
    );
  });
});

describe('printer eligibility and action gates', () => {
  it('purely blocks offline, stale, mismatched-nozzle, and unsafe print actions', () => {
    const state = initial();
    const decision = decideCalibrationAction(
      state,
      runtime({
        online: false,
        currentSnapshotRevision: 5,
        physicalMatch: {
          ...runtime().physicalMatch!,
          nozzleDiameterMm: 0.6,
        },
        bedClearConfirmed: false,
        operatorPresent: false,
      }),
      'startPrint',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining([
        'OFFLINE_ACTION_BLOCKED',
        'STALE_PRINTER_SNAPSHOT',
        'PHYSICAL_TOOLHEAD_NOZZLE_MISMATCH',
        'BED_CLEAR_CONFIRMATION_REQUIRED',
        'OPERATOR_PRESENCE_REQUIRED',
      ]),
    );
    expect(decideCalibrationAction(state, runtime(), 'generate').allowed).toBe(
      true,
    );
  });

  it('blocks generation and patch application when the server disables generation', () => {
    const state = initial();
    const offline = runtime({ serverGenerationEnabled: false });

    for (const action of ['generate', 'applyPatch'] as const) {
      const decision = decideCalibrationAction(state, offline, action);
      expect(decision.allowed).toBe(false);
      expect(decision.blockers.map((blocker) => blocker.code)).toContain(
        'SERVER_GENERATION_DISABLED',
      );
    }

    // Queuing an existing job must stay available.
    expect(
      decideCalibrationAction(state, offline, 'queue').blockers.map(
        (blocker) => blocker.code,
      ),
    ).not.toContain('SERVER_GENERATION_DISABLED');
  });

  it('blocks applyPatch alone, never generate, when slicing is operational but artifact promotion is not (#785)', () => {
    const state = initial();
    // Slicing up, promotion down — the exact split the issue names: a
    // deployment where a slicing fleet can produce G-code/profile artifacts
    // but the promotion checkpoint store or reconciler cannot accept them.
    const slicingOnlyRuntime = runtime({
      serverGenerationEnabled: true,
      serverArtifactPromotionEnabled: false,
    });

    const applyPatchDecision = decideCalibrationAction(
      state,
      slicingOnlyRuntime,
      'applyPatch',
    );
    expect(applyPatchDecision.allowed).toBe(false);
    expect(
      applyPatchDecision.blockers.map((blocker) => blocker.code),
    ).toContain('SERVER_ARTIFACT_PROMOTION_DISABLED');

    // Control: `generate` is unaffected — it is gated on slicing alone, and
    // slicing is enabled in this fixture, so it must stay allowed and must
    // never see the promotion-specific blocker.
    const generateDecision = decideCalibrationAction(
      state,
      slicingOnlyRuntime,
      'generate',
    );
    expect(generateDecision.allowed).toBe(true);
    expect(
      generateDecision.blockers.map((blocker) => blocker.code),
    ).not.toContain('SERVER_ARTIFACT_PROMOTION_DISABLED');
  });
});

describe('calibration reducer', () => {
  it('enforces dependencies and Coach/Expert method and skip policy', () => {
    let state = initial('coach');
    state = calibrationReducer(state, {
      ...eventBase('1'),
      type: 'beginAttempt',
      attemptId: 'flow-early',
      stageId: 'flowPass1',
      method: 'flowYolo',
    });
    expect(state.attempts).toHaveLength(0);
    expect(state.history).toHaveLength(0);
    expect(state.diagnostics.at(-1)?.code).toBe('METHOD_NOT_AVAILABLE');

    state = calibrationReducer(state, {
      ...eventBase('2'),
      type: 'skipStage',
      stageId: 'temperature',
      skipId: 'skip-1',
      reason: 'Operator choice',
    });
    expect(state.stages.temperature.status).toBe('notStarted');
    expect(state.history).toHaveLength(0);
    expect(state.diagnostics.at(-1)?.code).toBe('STAGE_NOT_SKIPPABLE');

    state = calibrationReducer(state, {
      ...eventBase('3'),
      type: 'setMode',
      mode: 'expert',
    });
    state = calibrationReducer(state, {
      ...eventBase('4'),
      type: 'skipStage',
      stageId: 'temperature',
      skipId: 'skip-2',
      reason: 'Existing controlled temperature result',
    });
    expect(state.stages.temperature.status).toBe('skipped');
    expect(buildWorkflowViewModel(state).nextStageId).toBe('flowPass1');
  });

  it('completes all nine stages with selected observations and recommendations', () => {
    let state = initial();
    CALIBRATION_STAGE_IDS.forEach((stageId, index) => {
      state = completeStage(state, stageId, index + 1);
    });
    const view = buildWorkflowViewModel(state);
    expect(view.completedCount).toBe(9);
    expect(view.nextStageId).toBeNull();
    expect(state.attempts).toHaveLength(9);
    expect(
      state.attempts.every(
        (attempt) =>
          attempt.selectedObservationId !== undefined &&
          attempt.recommendation !== undefined &&
          attempt.confidence === 'high',
      ),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(replayCalibrationEvents(initial(), state.history)).toEqual(state);
  });

  it('preserves old attempts and invalidates dependent history on explicit redo', () => {
    let state = initial();
    state = completeStage(state, 'temperature', 1);
    state = completeStage(state, 'flowPass1', 2, 'flowCoarse');
    state = completeStage(state, 'flowPass2', 3);
    const oldAttempt = state.attempts.find(
      (attempt) => attempt.attemptId === 'attempt-2',
    );
    state = calibrationReducer(state, {
      ...eventBase('40'),
      type: 'redoStage',
      stageId: 'flowPass1',
      attemptId: 'attempt-redo',
      method: 'flowYolo',
      reason: 'Retest after selecting a different sample range',
    });
    expect(
      state.attempts.find((attempt) => attempt.attemptId === 'attempt-2'),
    ).toEqual(oldAttempt);
    expect(state.attempts.at(-1)).toMatchObject({
      attemptId: 'attempt-redo',
      ordinal: 2,
      status: 'inProgress',
    });
    expect(state.stages.flowPass2.status).toBe('needsRetest');
    expect(state.history.at(-1)?.type).toBe('redoStage');
  });

  it('does not record or invalidate state for a rejected redo event', () => {
    const state = completeStage(initial(), 'temperature', 1);
    const rejected = calibrationReducer(state, {
      ...eventBase('rejected-redo'),
      type: 'redoStage',
      stageId: 'temperature',
      attemptId: 'rejected-attempt',
      method: 'flowYolo',
      reason: 'This method does not belong to the temperature stage',
    });

    expect(rejected.history).toEqual(state.history);
    expect(rejected.attempts).toEqual(state.attempts);
    expect(rejected.stages).toEqual(state.stages);
    expect(rejected.diagnostics.at(-1)?.code).toBe('METHOD_NOT_AVAILABLE');
  });

  it('requires explicit retests when rebasing to a new immutable snapshot', () => {
    let state = completeStage(initial(), 'temperature', 1);
    const rebasedBinding = binding('snapshot-2', 5);
    state = calibrationReducer(state, {
      ...eventBase('50'),
      type: 'rebaseSnapshot',
      binding: rebasedBinding,
      retestStages: ['temperature'],
      reason: 'Printer configuration revision changed',
    });
    expect(state.binding.snapshot.snapshotId).toBe('snapshot-2');
    expect(
      state.snapshotHistory.map((snapshot) => snapshot.snapshotId),
    ).toEqual(['snapshot-1', 'snapshot-2']);
    expect(state.stages.temperature.status).toBe('needsRetest');
    expect(state.attempts[0]?.scope.snapshotId).toBe('snapshot-1');
  });

  it.each([
    ['temperature', 'temperatureTower'],
    ['flowPass1', 'flowStandard'],
    ['flowPass1', 'flowCoarse'],
    ['flowPass1', 'flowYolo'],
    ['flowPass2', 'flowFine'],
    ['pressureAdvance', 'pressureAdvanceTower'],
    ['pressureAdvance', 'pressureAdvanceLine'],
    ['pressureAdvance', 'pressureAdvancePattern'],
    ['flowVerification', 'verificationPrint'],
    ['retraction', 'retractionTower'],
    ['maximumVolumetricSpeed', 'volumetricSpeedTower'],
    ['shrinkage', 'dimensionalCoupon'],
    ['finalVerification', 'verificationPrint'],
  ] as const)(
    'persists exact method identity and bounded sample data for %s / %s',
    (stageId, method) => {
      let state = initial();
      const stageIndex = CALIBRATION_STAGE_IDS.indexOf(stageId);
      CALIBRATION_STAGE_IDS.slice(0, stageIndex).forEach(
        (dependency, index) => {
          state = completeStage(state, dependency, index + 20);
        },
      );
      const attemptId = `method-attempt-${method}`;
      state = calibrationReducer(state, {
        ...eventBase(`begin-${method}`),
        type: 'beginAttempt',
        attemptId,
        stageId,
        method,
      });
      const sample = observationFor(
        stageId,
        attemptId,
        `method-observation-${method}`,
      );
      state = calibrationReducer(state, {
        ...eventBase(`record-${method}`),
        type: 'recordObservation',
        attemptId,
        observation: sample,
      });
      expect(state.attempts.at(-1)).toMatchObject({
        attemptId,
        stageId,
        method,
        status: 'inProgress',
        observations: [sample],
      });
      expect(
        state.attempts
          .at(-1)
          ?.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
      ).toBe(false);
    },
  );

  it('rejects snapshot rebase when selected tool, toolhead, or nozzle identity changes', () => {
    const original = initial();
    const nextBinding = binding('snapshot-2', 5);
    const alternateTool = {
      toolId: 'tool-1',
      toolheadId: 'head-1',
      nozzle: {
        nozzleId: 'nozzle-1',
        diameterMm: 0.6,
        material: 'brass',
      },
      extruderType: 'bowden' as const,
    };
    const changedBinding: CalibrationBinding = {
      ...nextBinding,
      snapshot: {
        ...nextBinding.snapshot,
        toolheads: [...nextBinding.snapshot.toolheads, alternateTool],
      },
      selectedToolId: alternateTool.toolId,
      selectedToolheadId: alternateTool.toolheadId,
      selectedNozzleId: alternateTool.nozzle.nozzleId,
    };
    const state = calibrationReducer(original, {
      ...eventBase('rebase-different-tool'),
      type: 'rebaseSnapshot',
      binding: changedBinding,
      retestStages: ['temperature'],
      reason: 'Physical tool changed',
    });
    expect(state.binding).toEqual(original.binding);
    expect(state.diagnostics.at(-1)?.code).toBe('REBASE_IDENTITY_MISMATCH');

    const changedNozzleBinding: CalibrationBinding = {
      ...nextBinding,
      snapshot: {
        ...nextBinding.snapshot,
        toolheads: nextBinding.snapshot.toolheads.map((tool) => ({
          ...tool,
          nozzle: { ...tool.nozzle, diameterMm: 0.6 },
        })),
      },
    };
    const changedNozzleState = calibrationReducer(original, {
      ...eventBase('rebase-changed-nozzle-scope'),
      type: 'rebaseSnapshot',
      binding: changedNozzleBinding,
      retestStages: ['temperature'],
      reason: 'Nozzle scope changed without a new identity',
    });
    expect(changedNozzleState.binding).toEqual(original.binding);
    expect(changedNozzleState.diagnostics.at(-1)?.code).toBe(
      'REBASE_IDENTITY_MISMATCH',
    );
  });

  it('abandons active downstream attempts and normalizes downstream stage invalidation on redo', () => {
    let state = completeStage(initial(), 'temperature', 40);
    state = calibrationReducer(state, {
      ...eventBase('begin-downstream'),
      type: 'beginAttempt',
      attemptId: 'active-flow-attempt',
      stageId: 'flowPass1',
      method: 'flowStandard',
    });
    state = calibrationReducer(state, {
      ...eventBase('redo-upstream'),
      type: 'redoStage',
      stageId: 'temperature',
      attemptId: 'temperature-redo-attempt',
      method: 'temperatureTower',
      reason: 'Nozzle maintenance invalidated downstream samples',
    });
    expect(
      state.attempts.find(
        (attempt) => attempt.attemptId === 'active-flow-attempt',
      )?.status,
    ).toBe('abandoned');
    expect(state.stages.temperature.status).toBe('inProgress');
    expect(state.stages.flowPass1.status).toBe('needsRetest');
    expect(state.stages.flowPass2.status).toBe('notStarted');
  });

  it('rechecks current dependencies and immutable attempt scope at completion', () => {
    let state = initial();
    const attemptId = 'stale-attempt';
    const selected = observationFor('temperature', attemptId, 'stale-sample');
    state = replayCalibrationEvents(state, [
      {
        ...eventBase('stale-begin'),
        type: 'beginAttempt',
        attemptId,
        stageId: 'temperature',
        method: 'temperatureTower',
      },
      {
        ...eventBase('stale-record'),
        type: 'recordObservation',
        attemptId,
        observation: selected,
      },
      {
        ...eventBase('stale-select'),
        type: 'selectObservation',
        attemptId,
        observationId: selected.observationId,
      },
    ]);
    const newBinding = binding('snapshot-2', 5);
    const externallyRefreshed: CalibrationState = {
      ...state,
      binding: newBinding,
      snapshotHistory: [...state.snapshotHistory, newBinding.snapshot],
    };
    const rejected = calibrationReducer(externallyRefreshed, {
      ...eventBase('stale-complete'),
      type: 'completeAttempt',
      attemptId,
      confidence: 'high',
    });
    expect(rejected.attempts[0]?.status).toBe('inProgress');
    expect(rejected.diagnostics.at(-1)?.code).toBe('STALE_ATTEMPT_SCOPE');
  });

  it('rejects method-specific out-of-range samples before immutable persistence', () => {
    let state = completeStage(initial(), 'temperature', 1);
    state = calibrationReducer(state, {
      ...eventBase('bounded-begin'),
      type: 'beginAttempt',
      attemptId: 'bounded-attempt',
      stageId: 'flowPass1',
      method: 'flowStandard',
    });
    const historyLength = state.history.length;
    state = calibrationReducer(state, {
      ...eventBase('bounded-observation'),
      type: 'recordObservation',
      attemptId: 'bounded-attempt',
      observation: {
        observationId: 'bounded-observation',
        attemptId: 'bounded-attempt',
        observedAt: '2026-07-26T09:00:00.000Z',
        notes: 'Out-of-range standard flow sample.',
        stageId: 'flowPass1',
        adjustmentPercent: 25,
        quality: 4,
      },
    });

    expect(state.attempts.at(-1)?.observations).toEqual([]);
    expect(state.history).toHaveLength(historyLength);
    expect(state.diagnostics.at(-1)?.code).toBe('FLOW_ADJUSTMENT_OUT_OF_RANGE');
  });

  it('retains multiple immutable observations and completes only the explicit selection', () => {
    const attemptId = 'multiple-sample-attempt';
    const first = observationFor('temperature', attemptId, 'sample-first');
    const second = {
      ...observationFor('temperature', attemptId, 'sample-second'),
      temperatureC: 230,
      notes: 'Second immutable sample.',
    };
    const state = replayCalibrationEvents(initial(), [
      {
        ...eventBase('multiple-begin'),
        type: 'beginAttempt',
        attemptId,
        stageId: 'temperature',
        method: 'temperatureTower',
      },
      {
        ...eventBase('multiple-first'),
        type: 'recordObservation',
        attemptId,
        observation: first,
      },
      {
        ...eventBase('multiple-second'),
        type: 'recordObservation',
        attemptId,
        observation: second,
      },
      {
        ...eventBase('multiple-select'),
        type: 'selectObservation',
        attemptId,
        observationId: second.observationId,
      },
      {
        ...eventBase('multiple-complete'),
        type: 'completeAttempt',
        attemptId,
        confidence: 'medium',
      },
    ]);
    expect(state.attempts[0]?.observations).toEqual([first, second]);
    expect(state.attempts[0]).toMatchObject({
      status: 'completed',
      selectedObservationId: second.observationId,
      confidence: 'medium',
    });
  });

  it('abandons an active affected attempt during authoritative snapshot rebase', () => {
    let state = completeStage(initial(), 'temperature', 60);
    state = calibrationReducer(state, {
      ...eventBase('active-flow-before-rebase'),
      type: 'beginAttempt',
      attemptId: 'active-flow-before-rebase',
      stageId: 'flowPass1',
      method: 'flowStandard',
    });
    state = calibrationReducer(state, {
      ...eventBase('authoritative-rebase'),
      type: 'rebaseSnapshot',
      binding: binding('snapshot-rebased', 6),
      retestStages: ['temperature'],
      reason: 'Authoritative configuration and snapshot revision changed',
    });
    expect(
      state.attempts.find(
        (attempt) => attempt.attemptId === 'active-flow-before-rebase',
      )?.status,
    ).toBe('abandoned');
    expect(state.stages.temperature.status).toBe('needsRetest');
    expect(state.stages.flowPass1.status).toBe('needsRetest');
    expect(state.binding.snapshot.snapshotId).toBe('snapshot-rebased');
  });
});
