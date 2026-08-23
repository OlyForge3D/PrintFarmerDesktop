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
  | 'listCalibrationConflicts'
  | 'resolveCalibrationConflict'
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
  // --- Allowlisted external navigation for manifest URLs (criterion 14) ----
  | 'openCalibrationManifestUrl'
  // --- Path C: cascading profile-selection + calibration-setup PUT --------
  //
  // Consumed by the profile-selection cascade in `NewCalibrationProject`.
  // Bishop landed the six channels as IPC contract v3 (commit 54e0d022);
  // the renderer needs them to build the machine → process → filament flow
  // that fixes the NULL `CalibrationMachineProfileId` /
  // `CalibrationProcessProfileId` / `CalibrationFilamentProfileId` columns
  // on the printer row (Path C in the API contract).
  | 'listCalibrationExtendedProfiles'
  | 'listCalibrationMachineProfilesForModel'
  | 'listCalibrationProcessProfilesForMachines'
  | 'listCalibrationFilamentProfilesForMachines'
  | 'listCalibrationCustomProfiles'
  | 'setupCalibrationPrinter'
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
