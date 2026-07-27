import type {
  CalibrationFieldBound,
  CalibrationMethod,
  CalibrationMode,
  CalibrationStageId,
  StageDefinition,
} from './types';

export type CalibrationBoundKey =
  | 'temperatureC'
  | 'flowStandardAdjustmentPercent'
  | 'flowCoarseAdjustmentPercent'
  | 'flowYoloAdjustmentPercent'
  | 'flowFineAdjustmentPercent'
  | 'pressureAdvance'
  | 'retractionLengthMm'
  | 'stableVolumetricRateMm3S'
  | 'shrinkageCompensationPercent'
  | 'quality';

export const CALIBRATION_BOUNDS: Readonly<
  Record<CalibrationBoundKey, CalibrationFieldBound>
> = {
  temperatureC: {
    minimum: 150,
    maximum: 400,
    step: 1,
    unit: 'celsius',
  },
  flowStandardAdjustmentPercent: {
    minimum: -20,
    maximum: 20,
    step: 5,
    unit: 'percent',
  },
  flowCoarseAdjustmentPercent: {
    minimum: -30,
    maximum: 30,
    step: 5,
    unit: 'percent',
  },
  flowYoloAdjustmentPercent: {
    minimum: -30,
    maximum: 30,
    step: 1,
    unit: 'percent',
  },
  flowFineAdjustmentPercent: {
    minimum: -10,
    maximum: 10,
    step: 1,
    unit: 'percent',
  },
  pressureAdvance: {
    minimum: 0,
    maximum: 2,
    step: 0.001,
    unit: 'second',
  },
  retractionLengthMm: {
    minimum: 0,
    maximum: 20,
    step: 0.1,
    unit: 'millimeter',
  },
  stableVolumetricRateMm3S: {
    minimum: 0.5,
    maximum: 100,
    step: 0.1,
    unit: 'cubicMillimeterPerSecond',
  },
  shrinkageCompensationPercent: {
    minimum: 90,
    maximum: 110,
    step: 0.01,
    unit: 'percent',
  },
  quality: {
    minimum: 1,
    maximum: 5,
    step: 1,
    unit: 'count',
  },
};

export const CALIBRATION_STAGES = [
  {
    id: 'temperature',
    title: 'Temperature',
    order: 0,
    dependencies: [],
    coachMethods: ['temperatureTower'],
    expertMethods: ['temperatureTower'],
    coachSkippable: false,
    expertSkippable: true,
    guidance: {
      coach:
        'Print a bounded temperature tower and select the cleanest band after it cools.',
      expert:
        'Choose a temperature from a controlled sweep without exceeding the bound snapshot.',
    },
  },
  {
    id: 'flowPass1',
    title: 'Flow pass 1',
    order: 1,
    dependencies: ['temperature'],
    coachMethods: ['flowStandard'],
    expertMethods: ['flowStandard', 'flowCoarse', 'flowYolo'],
    coachSkippable: false,
    expertSkippable: true,
    guidance: {
      coach:
        'Use the standard first pass and compare neighboring surfaces under the same light.',
      expert:
        'Select standard, coarse, or YOLO sampling and record the chosen percentage.',
    },
  },
  {
    id: 'flowPass2',
    title: 'Flow pass 2',
    order: 2,
    dependencies: ['flowPass1'],
    coachMethods: ['flowFine'],
    expertMethods: ['flowFine'],
    coachSkippable: false,
    expertSkippable: true,
    guidance: {
      coach: 'Refine the first-pass result with the smaller second-pass steps.',
      expert:
        'Apply a fine percentage correction to the selected first-pass ratio.',
    },
  },
  {
    id: 'pressureAdvance',
    title: 'Pressure advance',
    order: 3,
    dependencies: ['flowPass2'],
    coachMethods: ['pressureAdvanceTower'],
    expertMethods: [
      'pressureAdvanceTower',
      'pressureAdvanceLine',
      'pressureAdvancePattern',
    ],
    coachSkippable: false,
    expertSkippable: true,
    guidance: {
      coach:
        'Inspect the tower transitions and select the lowest value that keeps corners controlled.',
      expert:
        'Use tower, line, or pattern sampling and retain the method with the observation.',
    },
  },
  {
    id: 'flowVerification',
    title: 'Flow verification',
    order: 4,
    dependencies: ['flowPass2', 'pressureAdvance'],
    coachMethods: ['verificationPrint'],
    expertMethods: ['verificationPrint'],
    coachSkippable: false,
    expertSkippable: true,
    guidance: {
      coach:
        'Verify flow and corner behavior together before tuning later stages.',
      expert:
        'Record a pass only when the selected flow and pressure advance coexist cleanly.',
    },
  },
  {
    id: 'retraction',
    title: 'Retraction',
    order: 5,
    dependencies: ['flowVerification'],
    coachMethods: ['retractionTower'],
    expertMethods: ['retractionTower'],
    coachSkippable: true,
    expertSkippable: true,
    guidance: {
      coach:
        'Choose the shortest retraction that controls stringing for this exact tool and filament.',
      expert:
        'Retraction remains scoped to the bound printer configuration and filament project.',
    },
  },
  {
    id: 'maximumVolumetricSpeed',
    title: 'Maximum volumetric speed',
    order: 6,
    dependencies: ['flowVerification'],
    coachMethods: ['volumetricSpeedTower'],
    expertMethods: ['volumetricSpeedTower'],
    coachSkippable: false,
    expertSkippable: true,
    guidance: {
      coach:
        'Select the highest stable rate before visible under-extrusion, then verify it.',
      expert:
        'Record the stable volumetric boundary without exceeding snapshot hardware limits.',
    },
  },
  {
    id: 'shrinkage',
    title: 'Shrinkage',
    order: 7,
    dependencies: ['maximumVolumetricSpeed'],
    coachMethods: ['dimensionalCoupon'],
    expertMethods: ['dimensionalCoupon'],
    coachSkippable: true,
    expertSkippable: true,
    guidance: {
      coach:
        'Measure a cooled coupon on each axis and enter nominal and measured dimensions.',
      expert:
        'Use axis-specific nominal-to-measured scale factors from a cooled coupon.',
    },
  },
  {
    id: 'finalVerification',
    title: 'Final verification',
    order: 8,
    dependencies: ['retraction', 'maximumVolumetricSpeed', 'shrinkage'],
    coachMethods: ['verificationPrint'],
    expertMethods: ['verificationPrint'],
    coachSkippable: false,
    expertSkippable: false,
    guidance: {
      coach:
        'Print a final verification piece and record visible defects before applying changes.',
      expert:
        'Validate the combined recommendations; a failed verification requires a retest.',
    },
  },
] as const satisfies readonly StageDefinition[];

export const CALIBRATION_STAGE_BY_ID: Readonly<
  Record<CalibrationStageId, StageDefinition>
> = {
  temperature: CALIBRATION_STAGES[0],
  flowPass1: CALIBRATION_STAGES[1],
  flowPass2: CALIBRATION_STAGES[2],
  pressureAdvance: CALIBRATION_STAGES[3],
  flowVerification: CALIBRATION_STAGES[4],
  retraction: CALIBRATION_STAGES[5],
  maximumVolumetricSpeed: CALIBRATION_STAGES[6],
  shrinkage: CALIBRATION_STAGES[7],
  finalVerification: CALIBRATION_STAGES[8],
};

export function methodsForStage(
  stageId: CalibrationStageId,
  mode: CalibrationMode,
): readonly CalibrationMethod[] {
  const definition = CALIBRATION_STAGE_BY_ID[stageId];
  return mode === 'coach' ? definition.coachMethods : definition.expertMethods;
}

export function isMethodAvailable(
  stageId: CalibrationStageId,
  mode: CalibrationMode,
  method: CalibrationMethod,
): boolean {
  return methodsForStage(stageId, mode).includes(method);
}

export function isStageSkippable(
  stageId: CalibrationStageId,
  mode: CalibrationMode,
): boolean {
  const definition = CALIBRATION_STAGE_BY_ID[stageId];
  return mode === 'coach'
    ? definition.coachSkippable
    : definition.expertSkippable;
}
