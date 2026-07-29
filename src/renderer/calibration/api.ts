import type { PrintFarmerApi } from '@shared/ipc';

export type CalibrationApi = Pick<
  PrintFarmerApi,
  | 'getCalibrationAvailability'
  | 'listCalibrationPrinters'
  | 'getCalibrationPrinterContext'
  | 'listCalibrationWorkspaceStates'
  | 'getCalibrationWorkspaceState'
  | 'saveCalibrationWorkspaceState'
  | 'syncCalibrationNow'
  | 'listOrcaProfiles'
  | 'openCalibrationPhoto'
  | 'stageCalibrationPhoto'
  | 'generateOrcaProfile'
  | 'exportOrcaProfile'
  | 'installOrcaProfile'
  | 'restoreOrcaProfile'
  | 'startCalibrationGeneration'
  | 'getCalibrationOrchestrationStatus'
  | 'getCalibrationQueueState'
  | 'acknowledgeCalibrationBedClear'
  | 'openCalibrationLocalModel'
  | 'validateCalibrationLocalModel'
  | 'openCalibrationExternalUrl'
>;

/** The preload bridge is already runtime-validated; calibration only narrows it. */
export function calibrationApi(): CalibrationApi {
  return window.printFarmer;
}

export interface CalibrationEnvironment {
  readonly createId: () => string;
  readonly now: () => string;
}

export const browserCalibrationEnvironment: CalibrationEnvironment = {
  createId: () => {
    if (typeof globalThis.crypto?.randomUUID !== 'function') {
      throw new Error('Secure UUID generation is unavailable.');
    }
    return globalThis.crypto.randomUUID();
  },
  now: () => new Date().toISOString(),
};
