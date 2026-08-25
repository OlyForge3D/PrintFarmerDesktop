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
  | 'exportOrcaProfile'
  // --- Calibration generation, queue, and bed-clear (issue #54) ------------
  // --- Queue reconciliation (issue #54) ------------------------------------
  | 'pollCalibrationQueueChanges'
  | 'getCalibrationSubscriptionResources'
  // --- Machine → process → filament profile cascade -----------------------
  //
  // Consumed by the profile-selection cascade in `NewCalibrationProject`.
  // Step 1 of the filament calibration workflow: pick machine profile, then
  // a process profile applicable to that machine, then a base filament
  // profile.
  | 'listCalibrationExtendedProfiles'
  | 'listCalibrationMachineProfilesForModel'
  | 'listCalibrationProcessProfilesForMachines'
  | 'listCalibrationFilamentProfilesForMachines'
  | 'listCalibrationCustomProfiles'
  // --- On-demand system profile identity resolution (issue #766) ----------
  //
  // A never-imported catalog profile lists with `guid: null` (list endpoints
  // are unchanged upstream); this resolves-or-imports it by name on demand,
  // at the point a Guid is actually required (today: the filament clone
  // step in `FilamentCalibrationWizard`).
  | 'resolveSystemProfile'
  // --- Filament calibration slice pipeline (Bishop PR #752, PR #1952) -----
  //
  // Consumed by the filament calibration wizard. `submitCalibrationSlice`
  // starts a slice job; `getCalibrationSliceJobStatus` polls it;
  // `sendCalibrationSliceToPrinter` hands the sliced gcode to the printer
  // (with `startPrint: true` guarded by an explicit operator ack); and
  // `updateCalibrationFilamentProfileMeasurement` writes the measured value
  // back onto the clone.
  | 'cloneCalibrationFilamentProfile'
  | 'submitCalibrationSlice'
  | 'getCalibrationSliceJobStatus'
  | 'sendCalibrationSliceToPrinter'
  | 'updateCalibrationFilamentProfileMeasurement'
  // --- Filament calibration wizard restart resilience (issue #754) --------
  //
  // Persists which method/step/in-flight slice job the wizard is on so a
  // restart mid-calibration can resume instead of starting over. See
  // `filamentWizardState.ts` for the working-state <-> persisted-record
  // mapping and `calibrationFilamentWizardState.ts` for the store.
  | 'saveFilamentCalibrationWizardState'
  | 'getFilamentCalibrationWizardState'
  | 'clearFilamentCalibrationWizardState'
  // --- Conflict resolution (issue #762) -------------------------------------
  //
  // Consumed by `CalibrationConflictsDialog`, the renderer-facing conflict
  // resolution surface restored after PR #757 removed the old saga
  // dashboard's equivalent channels.
  | 'resolveCalibrationConflict'
  | 'listCalibrationConflicts'
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
