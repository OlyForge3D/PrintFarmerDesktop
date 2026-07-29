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
  // --- Calibration generation, queue, and bed-clear (issue #54) ------------
  | 'startCalibrationGeneration'
  | 'getCalibrationOrchestrationStatus'
  | 'getCalibrationQueueState'
  | 'acknowledgeCalibrationBedClear'
  | 'startCalibrationPrint'
  // --- Queue reconciliation (issue #54) ------------------------------------
  | 'pollCalibrationQueueChanges'
  | 'getCalibrationSubscriptionResources'
  // --- External calibration asset manifest (issue #54) ---------------------
  | 'getCalibrationAssetManifest'
  | 'pickCalibrationAssetFile'
  | 'validateCalibrationAssetFile'
  // --- Print observation persistence (criterion 13, issue #54) -------------
  | 'persistCalibrationPrintObservation'
  // --- Allowlisted external navigation for manifest URLs (criterion 14) ----
  | 'openCalibrationManifestUrl'
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
