import type {
  ActionDecision,
  CalibrationBinding,
  CalibrationDiagnostic,
  CalibrationState,
  GuardedCalibrationAction,
  RuntimeCalibrationContext,
} from './types';

function error(
  code: string,
  message: string,
  field?: string,
): CalibrationDiagnostic {
  return {
    code,
    severity: 'error',
    message,
    ...(field === undefined ? {} : { field }),
  };
}

export function bindingDiagnostics(
  binding: CalibrationBinding,
): readonly CalibrationDiagnostic[] {
  const reasons: CalibrationDiagnostic[] = [];
  const snapshot = binding.snapshot;
  if (
    binding.printer.backendProfileId.length === 0 ||
    binding.printer.backendPrinterId.length === 0 ||
    binding.printer.printerConfigurationId.length === 0
  ) {
    reasons.push(
      error(
        'INCOMPLETE_BACKEND_IDENTITY',
        'Backend profile, printer, and configuration identities are required.',
        'printer',
      ),
    );
  }
  if (
    !Number.isInteger(binding.printer.printerConfigurationRevision) ||
    binding.printer.printerConfigurationRevision < 0 ||
    binding.printer.printerConfigurationRevision !==
      snapshot.configurationRevision
  ) {
    reasons.push(
      error(
        'CONFIGURATION_REVISION_MISMATCH',
        'The immutable snapshot must match the bound printer configuration revision.',
        'printerConfigurationRevision',
      ),
    );
  }
  if (
    snapshot.snapshotId.length === 0 ||
    !Number.isInteger(snapshot.snapshotRevision) ||
    snapshot.snapshotRevision < 0 ||
    snapshot.capturedAt.length === 0
  ) {
    reasons.push(
      error(
        'INCOMPLETE_SNAPSHOT_IDENTITY',
        'An identified, revisioned immutable snapshot is required.',
        'snapshot',
      ),
    );
  }
  if (snapshot.toolheads.length === 0) {
    reasons.push(
      error(
        'NO_TOOLHEAD_CONTEXT',
        'At least one explicit toolhead and nozzle are required.',
        'toolheads',
      ),
    );
  }
  if (binding.selectedToolId.length === 0) {
    reasons.push(
      error(
        snapshot.toolheads.length > 1
          ? 'MULTI_TOOL_SELECTION_REQUIRED'
          : 'TOOL_SELECTION_REQUIRED',
        'Select the physical tool before calibration.',
        'selectedToolId',
      ),
    );
  }
  const selectedTool = snapshot.toolheads.find(
    (tool) => tool.toolId === binding.selectedToolId,
  );
  if (
    selectedTool === undefined ||
    selectedTool.toolheadId !== binding.selectedToolheadId ||
    selectedTool.nozzle.nozzleId !== binding.selectedNozzleId
  ) {
    reasons.push(
      error(
        'TOOLHEAD_NOZZLE_BINDING_MISMATCH',
        'Selected tool, toolhead, and nozzle must match the immutable snapshot.',
        'selectedToolId',
      ),
    );
  } else if (
    !Number.isFinite(selectedTool.nozzle.diameterMm) ||
    selectedTool.nozzle.diameterMm < 0.1 ||
    selectedTool.nozzle.diameterMm > 2 ||
    selectedTool.nozzle.material.trim().length === 0
  ) {
    reasons.push(
      error(
        'INCOMPLETE_NOZZLE_CONTEXT',
        'Nozzle diameter and material must be explicit and within supported model bounds.',
        'nozzle',
      ),
    );
  }
  const filament = binding.filament;
  if (
    filament.filamentProjectId.trim().length === 0 ||
    filament.provider.trim().length === 0 ||
    filament.product.trim().length === 0 ||
    filament.sku.trim().length === 0
  ) {
    reasons.push(
      error(
        'INCOMPLETE_FILAMENT_IDENTITY',
        'Filament project, provider, product, and SKU are required.',
        'filament',
      ),
    );
  }
  return reasons;
}

function physicalMatchBlockers(
  state: CalibrationState,
  runtime: RuntimeCalibrationContext,
): CalibrationDiagnostic[] {
  const confirmation = runtime.physicalMatch;
  const selectedTool = state.binding.snapshot.toolheads.find(
    (tool) => tool.toolId === state.binding.selectedToolId,
  );
  if (confirmation === null) {
    return [
      error(
        'PHYSICAL_MATCH_CONFIRMATION_REQUIRED',
        'Confirm the physical toolhead and nozzle before this action.',
        'physicalMatch',
      ),
    ];
  }
  if (
    selectedTool === undefined ||
    confirmation.snapshotId !== state.binding.snapshot.snapshotId ||
    confirmation.toolId !== state.binding.selectedToolId ||
    confirmation.toolheadId !== state.binding.selectedToolheadId ||
    confirmation.nozzleId !== state.binding.selectedNozzleId ||
    confirmation.nozzleDiameterMm !== selectedTool.nozzle.diameterMm
  ) {
    return [
      error(
        'PHYSICAL_TOOLHEAD_NOZZLE_MISMATCH',
        'The confirmed physical toolhead and nozzle do not match the bound snapshot.',
        'physicalMatch',
      ),
    ];
  }
  return [];
}

export function decideCalibrationAction(
  state: CalibrationState,
  runtime: RuntimeCalibrationContext,
  action: GuardedCalibrationAction,
): ActionDecision {
  const blockers: CalibrationDiagnostic[] = [];
  if (!runtime.online) {
    blockers.push(
      error(
        'OFFLINE_ACTION_BLOCKED',
        'This hardware or profile action requires an online authoritative context.',
      ),
    );
  }
  if (runtime.pendingMutationCount > 0) {
    blockers.push(
      error(
        'UNSYNCED_MUTATIONS',
        'Synchronize pending calibration changes before this action.',
      ),
    );
  }
  if (runtime.unresolvedConflictCount > 0) {
    blockers.push(
      error(
        'UNRESOLVED_CONFLICTS',
        'Resolve calibration conflicts before this action.',
      ),
    );
  }
  if (
    runtime.currentPrinterConfigurationRevision === null ||
    runtime.currentSnapshotRevision === null ||
    runtime.currentPrinterConfigurationRevision !==
      state.binding.printer.printerConfigurationRevision ||
    runtime.currentSnapshotRevision !== state.binding.snapshot.snapshotRevision
  ) {
    blockers.push(
      error(
        'STALE_PRINTER_SNAPSHOT',
        'Rebase to a fresh printer snapshot and explicitly retest affected stages.',
      ),
    );
  }
  blockers.push(...physicalMatchBlockers(state, runtime));
  if (
    (action === 'generate' || action === 'applyPatch') &&
    !runtime.serverGenerationEnabled
  ) {
    blockers.push(
      error(
        'SERVER_GENERATION_DISABLED',
        'This server does not have calibration generation enabled, so G-code and profile patches cannot be produced. Measured results can still be recorded.',
      ),
    );
  }
  if (
    action === 'applyPatch' &&
    state.stages.finalVerification.status !== 'completed'
  ) {
    blockers.push(
      error(
        'WORKFLOW_NOT_VERIFIED',
        'Complete a clean final verification before applying profile changes.',
      ),
    );
  }
  if (action === 'startPrint') {
    if (!runtime.bedClearConfirmed) {
      blockers.push(
        error(
          'BED_CLEAR_CONFIRMATION_REQUIRED',
          'Confirm the bed is physically clear before starting the print.',
        ),
      );
    }
    if (!runtime.operatorPresent) {
      blockers.push(
        error(
          'OPERATOR_PRESENCE_REQUIRED',
          'An operator must be present for calibration print start.',
        ),
      );
    }
  }
  return { allowed: blockers.length === 0, blockers };
}
