import { describe, expect, it } from 'vitest';

import {
  buildOrcaProfilePatch,
  calibrationReducer,
  createCalibrationState,
  replayCalibrationEvents,
  type BaselineProfile,
  type CalibrationBinding,
  type CalibrationEvent,
  type CalibrationObservation,
  type CalibrationStageId,
  type CalibrationState,
} from '../src/renderer/calibration/domain';

const baseline: BaselineProfile = {
  nozzleTemperatureC: 220,
  flowRatio: 1,
  pressureAdvance: 0.03,
  retractionLengthMm: 0.6,
  maximumVolumetricRateMm3S: 10,
  shrinkageCompensationXPercent: 100,
  shrinkageCompensationYPercent: 100,
  shrinkageCompensationZPercent: 100,
};

const binding: CalibrationBinding = {
  printer: {
    backendProfileId: 'profile',
    backendPrinterId: 'printer',
    printerConfigurationId: 'configuration',
    printerConfigurationRevision: 7,
  },
  snapshot: {
    snapshotId: 'snapshot',
    snapshotRevision: 11,
    capturedAt: '2026-07-26T08:00:00.000Z',
    configurationRevision: 7,
    toolheads: [
      {
        toolId: 'tool',
        toolheadId: 'toolhead',
        nozzle: {
          nozzleId: 'nozzle',
          diameterMm: 0.4,
          material: 'brass',
        },
        extruderType: 'directDrive',
      },
    ],
    safety: {
      buildVolumeMm: { x: 200, y: 200, z: 200 },
      maximumNozzleTemperatureC: 300,
      maximumBedTemperatureC: 110,
      maximumVolumetricRateMm3S: 30,
      emergencyStopAvailable: true,
      thermalProtectionConfirmed: true,
      ventilationAssessed: true,
    },
  },
  selectedToolId: 'tool',
  selectedToolheadId: 'toolhead',
  selectedNozzleId: 'nozzle',
  filament: {
    filamentProjectId: 'filament-project',
    provider: 'Provider',
    product: 'PLA',
    sku: 'PLA-RED',
    spoolId: 'spool',
  },
};

const methods = {
  temperature: 'temperatureTower',
  flowPass1: 'flowStandard',
  flowPass2: 'flowFine',
  pressureAdvance: 'pressureAdvancePattern',
  flowVerification: 'verificationPrint',
  retraction: 'retractionTower',
  maximumVolumetricSpeed: 'volumetricSpeedTower',
  shrinkage: 'dimensionalCoupon',
  finalVerification: 'verificationPrint',
} as const;

function initial(): CalibrationState {
  return createCalibrationState({
    projectId: 'project',
    createdAt: '2026-07-26T08:00:00.000Z',
    mode: 'expert',
    baseline,
    binding,
  });
}

function observation(
  stageId: CalibrationStageId,
  attemptId: string,
): CalibrationObservation {
  const common = {
    attemptId,
    observationId: `observation-${stageId}`,
    observedAt: '2026-07-26T09:00:00.000Z',
    notes: '',
  };
  switch (stageId) {
    case 'temperature':
      return { ...common, stageId, temperatureC: 215, quality: 5 };
    case 'flowPass1':
      return { ...common, stageId, adjustmentPercent: 5, quality: 5 };
    case 'flowPass2':
      return { ...common, stageId, adjustmentPercent: -2, quality: 5 };
    case 'pressureAdvance':
      return { ...common, stageId, pressureAdvance: 0.04, quality: 5 };
    case 'flowVerification':
    case 'finalVerification':
      return { ...common, stageId, passed: true, defectCount: 0 };
    case 'retraction':
      return { ...common, stageId, retractionLengthMm: 0.8, quality: 5 };
    case 'maximumVolumetricSpeed':
      return {
        ...common,
        stageId,
        stableVolumetricRateMm3S: 16,
        quality: 5,
      };
    case 'shrinkage':
      return {
        ...common,
        stageId,
        nominalXmm: 100,
        nominalYmm: 100,
        nominalZmm: 100,
        measuredXmm: 99,
        measuredYmm: 100,
        measuredZmm: 101,
      };
  }
}

function complete(
  state: CalibrationState,
  stageId: CalibrationStageId,
  index: number,
): CalibrationState {
  const attemptId = `attempt-${stageId}`;
  const selected = observation(stageId, attemptId);
  const base = {
    timestamp: `2026-07-26T10:${index.toString().padStart(2, '0')}:00.000Z`,
  };
  const events: readonly CalibrationEvent[] = [
    {
      ...base,
      eventId: `begin-${stageId}`,
      type: 'beginAttempt',
      stageId,
      attemptId,
      method: methods[stageId],
    },
    {
      ...base,
      eventId: `record-${stageId}`,
      type: 'recordObservation',
      attemptId,
      observation: selected,
    },
    {
      ...base,
      eventId: `select-${stageId}`,
      type: 'selectObservation',
      attemptId,
      observationId: selected.observationId,
    },
    {
      ...base,
      eventId: `complete-${stageId}`,
      type: 'completeAttempt',
      attemptId,
      confidence: 'high',
    },
  ];
  return replayCalibrationEvents(state, events);
}

describe('Orca profile patch mapping', () => {
  it('returns pure proposed key/value data with immutable physical scope', () => {
    let state = initial();
    (
      [
        'temperature',
        'flowPass1',
        'flowPass2',
        'pressureAdvance',
        'flowVerification',
        'retraction',
        'maximumVolumetricSpeed',
        'shrinkage',
        'finalVerification',
      ] as const
    ).forEach((stageId, index) => {
      state = complete(state, stageId, index);
    });

    const patch = buildOrcaProfilePatch(state);
    expect(patch.diagnostics).toEqual([]);
    expect(patch.entries.map((entry) => entry.key)).toEqual([
      'nozzle_temperature',
      'filament_flow_ratio',
      'enable_pressure_advance',
      'pressure_advance',
      'filament_retraction_length',
      'filament_max_volumetric_speed',
      'filament_shrink',
      'filament_shrinkage_compensation_z',
    ]);
    expect(
      patch.entries.find((entry) => entry.key === 'filament_flow_ratio')?.value,
    ).toBe(1.029);
    expect(
      patch.entries.find((entry) => entry.key === 'filament_retraction_length'),
    ).toMatchObject({
      target: 'filament',
      scope: {
        printerConfigurationId: 'configuration',
        printerConfigurationRevision: 7,
        filamentProjectId: 'filament-project',
        toolheadId: 'toolhead',
        nozzleId: 'nozzle',
        spoolId: 'spool',
      },
    });
    expect(JSON.parse(JSON.stringify(patch))).toEqual(patch);
  });

  it('does not authorize a patch without clean final verification', () => {
    let state = initial();
    state = complete(state, 'temperature', 0);
    let patch = buildOrcaProfilePatch(state);
    expect(patch.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'FINAL_VERIFICATION_REQUIRED',
          severity: 'error',
        }),
      ]),
    );

    state = calibrationReducer(state, {
      eventId: 'duplicate-event',
      timestamp: '2026-07-26T10:00:00.000Z',
      type: 'navigate',
      stageId: 'temperature',
    });
    const same = calibrationReducer(state, {
      eventId: 'duplicate-event',
      timestamp: 'changed-but-ignored',
      type: 'navigate',
      stageId: 'flowPass1',
    });
    expect(same).toBe(state);
    patch = buildOrcaProfilePatch(same);
    expect(patch.entries).toHaveLength(1);
  });
});
