import type {
  BaselineProfile,
  CalibrationAttempt,
  CalibrationBinding,
  CalibrationDiagnostic,
  CalibrationMethod,
  CalibrationObservation,
  CalibrationRecommendation,
  CalibrationState,
  FlowObservation,
  ShrinkageObservation,
} from './types';
import { CALIBRATION_BOUNDS } from './catalog';

const round = (value: number, digits = 6): number => {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};

export function applyFlowAdjustment(
  baseFlowRatio: number,
  adjustmentPercent: number,
): number {
  return round(baseFlowRatio * (1 + adjustmentPercent / 100));
}

export function linearSweepValue(
  start: number,
  step: number,
  zeroBasedIndex: number,
): number {
  return round(start + step * zeroBasedIndex);
}

export function temperatureAtBand(
  hottestTemperatureC: number,
  decrementC: number,
  zeroBasedBand: number,
): number {
  return round(hottestTemperatureC - decrementC * zeroBasedBand, 2);
}

export function pressureAdvanceAtHeight(
  start: number,
  changePerMm: number,
  measuredHeightMm: number,
): number {
  return round(start + changePerMm * measuredHeightMm);
}

export function maximumVolumetricRate(
  extrusionWidthMm: number,
  layerHeightMm: number,
  linearSpeedMmS: number,
): number {
  return round(extrusionWidthMm * layerHeightMm * linearSpeedMmS);
}

export function shrinkageCompensationPercent(
  nominalMm: number,
  measuredMm: number,
): number {
  return round((nominalMm / measuredMm) * 100, 4);
}

function diagnostic(
  code: string,
  severity: 'warning' | 'error',
  message: string,
  observation: CalibrationObservation,
  field?: string,
): CalibrationDiagnostic {
  return {
    code,
    severity,
    message,
    stageId: observation.stageId,
    ...(field === undefined ? {} : { field }),
  };
}

function validateQuality(
  observation: Extract<CalibrationObservation, { readonly quality: number }>,
): CalibrationDiagnostic[] {
  if (
    !Number.isInteger(observation.quality) ||
    observation.quality < CALIBRATION_BOUNDS.quality.minimum ||
    observation.quality > CALIBRATION_BOUNDS.quality.maximum
  ) {
    return [
      diagnostic(
        'QUALITY_OUT_OF_RANGE',
        'error',
        'Quality must be an integer from 1 through 5.',
        observation,
        'quality',
      ),
    ];
  }
  if (observation.quality <= 2) {
    return [
      diagnostic(
        'LOW_OBSERVATION_QUALITY',
        'warning',
        'This observation has low visual quality; consider another attempt.',
        observation,
        'quality',
      ),
    ];
  }
  return [];
}

function finitePositive(
  value: number,
  field: string,
  observation: CalibrationObservation,
): CalibrationDiagnostic[] {
  return Number.isFinite(value) && value > 0 && value <= 10_000
    ? []
    : [
        diagnostic(
          'INVALID_MEASUREMENT',
          'error',
          'Measurement must be finite, greater than zero, and no more than 10,000 mm.',
          observation,
          field,
        ),
      ];
}

export function validateObservation(
  observation: CalibrationObservation,
  binding: CalibrationBinding,
  method?: CalibrationMethod,
): readonly CalibrationDiagnostic[] {
  switch (observation.stageId) {
    case 'temperature': {
      const diagnostics = validateQuality(observation);
      if (
        !Number.isFinite(observation.temperatureC) ||
        observation.temperatureC < CALIBRATION_BOUNDS.temperatureC.minimum ||
        observation.temperatureC > CALIBRATION_BOUNDS.temperatureC.maximum
      ) {
        diagnostics.push(
          diagnostic(
            'TEMPERATURE_OUT_OF_MODEL_RANGE',
            'error',
            'Temperature must be between 150 °C and 400 °C.',
            observation,
            'temperatureC',
          ),
        );
      } else if (
        observation.temperatureC >
        binding.snapshot.safety.maximumNozzleTemperatureC
      ) {
        diagnostics.push(
          diagnostic(
            'TEMPERATURE_EXCEEDS_SNAPSHOT_LIMIT',
            'error',
            'Temperature exceeds the maximum in the immutable printer snapshot.',
            observation,
            'temperatureC',
          ),
        );
      }
      return diagnostics;
    }
    case 'flowPass1':
    case 'flowPass2': {
      const diagnostics = validateQuality(observation);
      const bounds =
        observation.stageId === 'flowPass2'
          ? CALIBRATION_BOUNDS.flowFineAdjustmentPercent
          : method === 'flowCoarse'
            ? CALIBRATION_BOUNDS.flowCoarseAdjustmentPercent
            : method === 'flowYolo'
              ? CALIBRATION_BOUNDS.flowYoloAdjustmentPercent
              : CALIBRATION_BOUNDS.flowStandardAdjustmentPercent;
      if (
        !Number.isFinite(observation.adjustmentPercent) ||
        observation.adjustmentPercent < bounds.minimum ||
        observation.adjustmentPercent > bounds.maximum
      ) {
        diagnostics.push(
          diagnostic(
            'FLOW_ADJUSTMENT_OUT_OF_RANGE',
            'error',
            `Flow adjustment for this method must be between ${bounds.minimum}% and ${bounds.maximum}%.`,
            observation,
            'adjustmentPercent',
          ),
        );
      }
      return diagnostics;
    }
    case 'pressureAdvance': {
      const diagnostics = validateQuality(observation);
      if (
        !Number.isFinite(observation.pressureAdvance) ||
        observation.pressureAdvance <
          CALIBRATION_BOUNDS.pressureAdvance.minimum ||
        observation.pressureAdvance > CALIBRATION_BOUNDS.pressureAdvance.maximum
      ) {
        diagnostics.push(
          diagnostic(
            'PRESSURE_ADVANCE_OUT_OF_RANGE',
            'error',
            'Pressure advance must be between 0 and 2 seconds.',
            observation,
            'pressureAdvance',
          ),
        );
      } else {
        const selectedTool = binding.snapshot.toolheads.find(
          (tool) => tool.toolId === binding.selectedToolId,
        );
        const conservativeLimit =
          selectedTool?.extruderType === 'bowden' ? 1 : 0.2;
        if (observation.pressureAdvance > conservativeLimit) {
          diagnostics.push(
            diagnostic(
              'UNUSUALLY_HIGH_PRESSURE_ADVANCE',
              'warning',
              'The selected value is unusually high for the bound extruder type.',
              observation,
              'pressureAdvance',
            ),
          );
        }
      }
      return diagnostics;
    }
    case 'flowVerification':
    case 'finalVerification': {
      const diagnostics: CalibrationDiagnostic[] = [];
      if (
        !Number.isInteger(observation.defectCount) ||
        observation.defectCount < 0 ||
        observation.defectCount > 999
      ) {
        diagnostics.push(
          diagnostic(
            'DEFECT_COUNT_OUT_OF_RANGE',
            'error',
            'Defect count must be a whole number from 0 through 999.',
            observation,
            'defectCount',
          ),
        );
      }
      if (!observation.passed || observation.defectCount > 0) {
        diagnostics.push(
          diagnostic(
            'VERIFICATION_REQUIRES_REVIEW',
            'warning',
            'The verification did not pass cleanly; retest before applying recommendations.',
            observation,
          ),
        );
      }
      return diagnostics;
    }
    case 'retraction': {
      const diagnostics = validateQuality(observation);
      if (
        !Number.isFinite(observation.retractionLengthMm) ||
        observation.retractionLengthMm <
          CALIBRATION_BOUNDS.retractionLengthMm.minimum ||
        observation.retractionLengthMm >
          CALIBRATION_BOUNDS.retractionLengthMm.maximum
      ) {
        diagnostics.push(
          diagnostic(
            'RETRACTION_OUT_OF_RANGE',
            'error',
            'Retraction length must be between 0 mm and 20 mm.',
            observation,
            'retractionLengthMm',
          ),
        );
      } else if (observation.retractionLengthMm > 8) {
        diagnostics.push(
          diagnostic(
            'HIGH_RETRACTION_LENGTH',
            'warning',
            'A long retraction can increase heat-creep or filament damage risk.',
            observation,
            'retractionLengthMm',
          ),
        );
      }
      return diagnostics;
    }
    case 'maximumVolumetricSpeed': {
      const diagnostics = validateQuality(observation);
      if (
        !Number.isFinite(observation.stableVolumetricRateMm3S) ||
        observation.stableVolumetricRateMm3S <
          CALIBRATION_BOUNDS.stableVolumetricRateMm3S.minimum ||
        observation.stableVolumetricRateMm3S >
          CALIBRATION_BOUNDS.stableVolumetricRateMm3S.maximum
      ) {
        diagnostics.push(
          diagnostic(
            'VOLUMETRIC_RATE_OUT_OF_MODEL_RANGE',
            'error',
            'Stable volumetric rate must be between 0.5 and 100 mm³/s.',
            observation,
            'stableVolumetricRateMm3S',
          ),
        );
      } else if (
        observation.stableVolumetricRateMm3S >
        binding.snapshot.safety.maximumVolumetricRateMm3S
      ) {
        diagnostics.push(
          diagnostic(
            'VOLUMETRIC_RATE_EXCEEDS_SNAPSHOT_LIMIT',
            'error',
            'Stable volumetric rate exceeds the immutable snapshot limit.',
            observation,
            'stableVolumetricRateMm3S',
          ),
        );
      }
      return diagnostics;
    }
    case 'shrinkage': {
      const diagnostics = [
        ...finitePositive(observation.nominalXmm, 'nominalXmm', observation),
        ...finitePositive(observation.nominalYmm, 'nominalYmm', observation),
        ...finitePositive(observation.nominalZmm, 'nominalZmm', observation),
        ...finitePositive(observation.measuredXmm, 'measuredXmm', observation),
        ...finitePositive(observation.measuredYmm, 'measuredYmm', observation),
        ...finitePositive(observation.measuredZmm, 'measuredZmm', observation),
      ];
      if (diagnostics.length === 0) {
        for (const [field, value] of shrinkageAxisValues(observation)) {
          if (
            value < CALIBRATION_BOUNDS.shrinkageCompensationPercent.minimum ||
            value > CALIBRATION_BOUNDS.shrinkageCompensationPercent.maximum
          ) {
            diagnostics.push(
              diagnostic(
                'SHRINKAGE_COMPENSATION_OUT_OF_RANGE',
                'error',
                'Computed compensation must remain between 90% and 110%.',
                observation,
                field,
              ),
            );
          } else if (value < 95 || value > 105) {
            diagnostics.push(
              diagnostic(
                'LARGE_SHRINKAGE_COMPENSATION',
                'warning',
                'Computed compensation is large; remeasure the cooled coupon.',
                observation,
                field,
              ),
            );
          }
        }
      }
      return diagnostics;
    }
  }
}

export function shrinkageValues(
  observation: ShrinkageObservation,
): readonly (readonly [string, number])[] {
  const axisValues = shrinkageAxisValues(observation);
  const x = axisValues[0]?.[1] ?? 100;
  const y = axisValues[1]?.[1] ?? 100;
  const z = axisValues[2]?.[1] ?? 100;
  return [
    ['filament_shrink', round((x + y) / 2, 4)],
    ['filament_shrinkage_compensation_z', z],
  ];
}

export function shrinkageAxisValues(
  observation: ShrinkageObservation,
): readonly (readonly [string, number])[] {
  return [
    [
      'x',
      shrinkageCompensationPercent(
        observation.nominalXmm,
        observation.measuredXmm,
      ),
    ],
    [
      'y',
      shrinkageCompensationPercent(
        observation.nominalYmm,
        observation.measuredYmm,
      ),
    ],
    [
      'z',
      shrinkageCompensationPercent(
        observation.nominalZmm,
        observation.measuredZmm,
      ),
    ],
  ];
}

function selectedAttempt(
  state: CalibrationState,
  stageId: 'flowPass1',
): CalibrationAttempt | undefined {
  const selectedAttemptId = state.stages[stageId].selectedAttemptId;
  return state.attempts.find(
    (attempt) => attempt.attemptId === selectedAttemptId,
  );
}

function flowBase(
  state: CalibrationState,
  observation: FlowObservation,
): number {
  if (observation.stageId === 'flowPass1') return state.baseline.flowRatio;
  const passOne = selectedAttempt(state, 'flowPass1');
  const value = passOne?.recommendation?.values.find(
    (candidate) => candidate.key === 'filament_flow_ratio',
  )?.value;
  return typeof value === 'number' ? value : state.baseline.flowRatio;
}

export function recommendationForObservation(
  state: CalibrationState,
  observation: CalibrationObservation,
): CalibrationRecommendation {
  switch (observation.stageId) {
    case 'temperature':
      return {
        summary: `Use ${observation.temperatureC} °C as the filament nozzle temperature.`,
        rationale: 'This was the selected bounded temperature observation.',
        values: [
          {
            key: 'nozzle_temperature',
            value: observation.temperatureC,
            unit: 'celsius',
          },
        ],
      };
    case 'flowPass1':
    case 'flowPass2': {
      const ratio = applyFlowAdjustment(
        flowBase(state, observation),
        observation.adjustmentPercent,
      );
      return {
        summary: `Use a flow ratio of ${ratio}.`,
        rationale:
          'The selected percentage is applied multiplicatively to the prior pass ratio.',
        values: [
          {
            key: 'filament_flow_ratio',
            value: ratio,
            unit: 'ratio',
          },
        ],
      };
    }
    case 'pressureAdvance':
      return {
        summary: `Use pressure advance ${observation.pressureAdvance}.`,
        rationale:
          'This value corresponds to the selected physical observation.',
        values: [
          {
            key: 'enable_pressure_advance',
            value: true,
            unit: 'boolean',
          },
          {
            key: 'pressure_advance',
            value: observation.pressureAdvance,
            unit: 'second',
          },
        ],
      };
    case 'flowVerification':
    case 'finalVerification':
      return {
        summary: observation.passed
          ? 'Verification passed.'
          : 'Verification requires a retest.',
        rationale:
          observation.defectCount === 0
            ? 'No defects were recorded.'
            : `${observation.defectCount} defect(s) were recorded.`,
        values: [
          {
            key: 'verification_passed',
            value: observation.passed && observation.defectCount === 0,
            unit: 'boolean',
          },
        ],
      };
    case 'retraction':
      return {
        summary: `Use ${observation.retractionLengthMm} mm retraction for this bound configuration and filament.`,
        rationale:
          'The shortest selected clean observation limits unnecessary retraction.',
        values: [
          {
            key: 'retraction_length',
            value: observation.retractionLengthMm,
            unit: 'millimeter',
          },
        ],
      };
    case 'maximumVolumetricSpeed':
      return {
        summary: `Use ${observation.stableVolumetricRateMm3S} mm³/s as the maximum volumetric speed.`,
        rationale:
          'This was the selected stable rate below the observed failure region.',
        values: [
          {
            key: 'filament_max_volumetric_speed',
            value: observation.stableVolumetricRateMm3S,
            unit: 'cubicMillimeterPerSecond',
          },
        ],
      };
    case 'shrinkage': {
      const values = shrinkageValues(observation);
      const axisValues = shrinkageAxisValues(observation);
      const anisotropy = Math.abs(
        (axisValues[0]?.[1] ?? 100) - (axisValues[1]?.[1] ?? 100),
      );
      return {
        summary: 'Use the measured axis-specific shrinkage compensation.',
        rationale:
          anisotropy > 1
            ? 'X and Y differ materially; the proposed Orca XY value is their average and should be verified.'
            : 'Each scale is nominal divided by cooled measured dimension; Orca uses one XY value.',
        values: values.map(([key, value]) => ({
          key,
          value,
          unit: 'percent' as const,
        })),
      };
    }
  }
}

export function validateBaselineProfile(
  baseline: BaselineProfile,
): readonly CalibrationDiagnostic[] {
  const diagnostics: CalibrationDiagnostic[] = [];
  if (
    !Number.isFinite(baseline.flowRatio) ||
    baseline.flowRatio < 0.5 ||
    baseline.flowRatio > 1.5
  ) {
    diagnostics.push({
      code: 'BASE_FLOW_RATIO_OUT_OF_RANGE',
      severity: 'error',
      message: 'Baseline flow ratio must be between 0.5 and 1.5.',
      field: 'flowRatio',
    });
  }
  if (
    !Number.isFinite(baseline.nozzleTemperatureC) ||
    baseline.nozzleTemperatureC < 150 ||
    baseline.nozzleTemperatureC > 400
  ) {
    diagnostics.push({
      code: 'BASE_TEMPERATURE_OUT_OF_RANGE',
      severity: 'error',
      message: 'Baseline nozzle temperature must be between 150 °C and 400 °C.',
      field: 'nozzleTemperatureC',
    });
  }
  if (
    !Number.isFinite(baseline.pressureAdvance) ||
    baseline.pressureAdvance < 0 ||
    baseline.pressureAdvance > 10
  ) {
    diagnostics.push({
      code: 'BASE_PRESSURE_ADVANCE_OUT_OF_RANGE',
      severity: 'error',
      message: 'Baseline pressure advance must be between 0 and 10 seconds.',
      field: 'pressureAdvance',
    });
  }
  if (baseline.retractionLengthMm < 0 || baseline.retractionLengthMm > 100) {
    diagnostics.push({
      code: 'BASE_RETRACTION_OUT_OF_RANGE',
      severity: 'error',
      message: 'Baseline retraction must be between 0 and 100 mm.',
      field: 'retractionLengthMm',
    });
  }
  if (
    !Number.isFinite(baseline.maximumVolumetricRateMm3S) ||
    baseline.maximumVolumetricRateMm3S <= 0 ||
    baseline.maximumVolumetricRateMm3S > 10_000
  ) {
    diagnostics.push({
      code: 'BASE_VOLUMETRIC_RATE_OUT_OF_RANGE',
      severity: 'error',
      message:
        'Baseline maximum volumetric rate must be greater than 0 and no more than 10,000 mm�/s.',
      field: 'maximumVolumetricRateMm3S',
    });
  }
  const shrinkageFields = [
    ['shrinkageCompensationXPercent', baseline.shrinkageCompensationXPercent],
    ['shrinkageCompensationYPercent', baseline.shrinkageCompensationYPercent],
    ['shrinkageCompensationZPercent', baseline.shrinkageCompensationZPercent],
  ] as const;
  for (const [field, value] of shrinkageFields) {
    if (!Number.isFinite(value) || value < -100 || value > 100) {
      diagnostics.push({
        code: 'BASE_SHRINKAGE_COMPENSATION_OUT_OF_RANGE',
        severity: 'error',
        message:
          'Baseline shrinkage compensation must be from -100% through 100%.',
        field,
      });
    }
  }
  return diagnostics;
}
