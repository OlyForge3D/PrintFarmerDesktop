import type { CalibrationSaveWorkspaceStateRequest } from '@shared/ipc';
import {
  doesCalibrationWorkspaceMatchContext,
  type RemoteCalibrationPrinterContext,
} from './calibrationWire.js';
import { CalibrationHttpError } from './calibrationHttp.js';

const TRANSIENT_CONTEXT_ERROR_CODES = new Set([
  'timeout',
  'transport',
  'rateLimited',
  'server',
  'workerUnavailable',
]);

export async function resolveCalibrationWorkspaceFreshness(
  request: CalibrationSaveWorkspaceStateRequest,
  existing: {
    isPrinterContextFresh: boolean;
    workspaceState: CalibrationSaveWorkspaceStateRequest['workspaceState'];
  } | null,
  loadCurrentContext: () => Promise<RemoteCalibrationPrinterContext>,
): Promise<boolean> {
  try {
    const currentContext = await loadCurrentContext();
    const fresh = doesCalibrationWorkspaceMatchContext(request, currentContext);
    if (!fresh && existing === null) {
      throw Object.assign(
        new Error(
          'A new calibration workspace must match the current authoritative printer context.',
        ),
        { code: 'CALIBRATION_PRINTER_CONTEXT_MISMATCH' },
      );
    }
    return fresh;
  } catch (error) {
    if (
      !(error instanceof CalibrationHttpError) ||
      !TRANSIENT_CONTEXT_ERROR_CODES.has(error.code)
    ) {
      throw error;
    }
    if (existing === null) {
      throw Object.assign(
        new Error(
          'A new calibration workspace cannot be created while PrintFarmer is offline.',
        ),
        { code: 'CALIBRATION_OFFLINE_CREATE_DENIED' },
      );
    }
    if (
      JSON.stringify(existing.workspaceState.domainState.binding) !==
        JSON.stringify(request.workspaceState.domainState.binding) ||
      JSON.stringify(existing.workspaceState.selectedBaseProfile) !==
        JSON.stringify(request.workspaceState.selectedBaseProfile)
    ) {
      throw Object.assign(
        new Error(
          'Printer binding changes require an authoritative online context.',
        ),
        { code: 'CALIBRATION_OFFLINE_CONTEXT_CHANGE_DENIED' },
      );
    }
    return existing.isPrinterContextFresh;
  }
}
