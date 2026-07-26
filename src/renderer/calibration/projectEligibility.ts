import type {
  CalibrationPrinterCandidate,
  CalibrationPrinterContext,
  CalibrationSelectedBaseProfile,
  OrcaProfileEntry,
} from '@shared/ipc';
import type { CalibrationBinding } from './domain';

export function candidateEligibilityBlockers(
  candidate: CalibrationPrinterCandidate | undefined,
): readonly string[] {
  if (candidate === undefined) {
    return ['Select a printer returned by PrintFarmer.'];
  }
  if (candidate.eligibility === null) {
    return [
      'PrintFarmer did not provide complete canonical Klipper, OrcaSlicer, upstream eligibility for this printer.',
    ];
  }
  if (!candidate.isOnline) {
    return ['The printer is offline, so current context cannot be verified.'];
  }
  return [];
}

export function contextEligibilityBlockers(
  context: CalibrationPrinterContext | null,
  candidate: CalibrationPrinterCandidate | undefined,
): readonly string[] {
  if (
    context === null ||
    candidate === undefined ||
    context.printerId !== candidate.printerId
  ) {
    return ['Load current context for this exact printer.'];
  }
  const blockers: string[] = [];
  if (candidate.eligibility === null) {
    blockers.push('Canonical PrintFarmer printer eligibility is missing.');
  }
  if (!candidate.isOnline) {
    blockers.push('The selected printer is offline.');
  }
  if (!context.isCurrent) {
    blockers.push('The printer context is stale. Refresh it before creation.');
  }
  if (!context.configurationId) {
    blockers.push('Printer configuration identity is missing.');
  }
  if (context.configurationRevision === null) {
    blockers.push('Printer configuration revision is missing.');
  }
  if (!context.snapshotId) {
    blockers.push('Immutable snapshot identity is missing.');
  }
  if (context.snapshotRevision === null) {
    blockers.push('Immutable snapshot revision is missing.');
  }
  if (context.slicerIdentity !== 'OrcaSlicer') {
    blockers.push('Current context does not identify OrcaSlicer explicitly.');
  }
  if (context.slicerDistribution !== 'upstream') {
    blockers.push(
      'Current context does not identify upstream OrcaSlicer explicitly.',
    );
  }
  if (!context.orcaProfileId || !context.orcaProfileDisplayName) {
    blockers.push(
      'Current context is missing its OrcaSlicer profile identity.',
    );
  }
  if (!context.bedWidthMm || !context.bedDepthMm || !context.nozzleDiameterMm) {
    blockers.push('Current bed or nozzle dimensions are incomplete.');
  }
  if (context.toolheads.length === 0) {
    blockers.push(
      'No explicit physical tool, toolhead, and nozzle were returned.',
    );
  }
  const safety = context.safety;
  if (safety === null) {
    blockers.push('Authoritative printer safety limits are missing.');
  } else {
    if (!safety.emergencyStopAvailable) {
      blockers.push('PrintFarmer has not confirmed an emergency stop.');
    }
    if (!safety.thermalProtectionConfirmed) {
      blockers.push('PrintFarmer has not confirmed thermal protection.');
    }
    if (!safety.ventilationAssessed) {
      blockers.push('PrintFarmer has not confirmed a ventilation assessment.');
    }
  }
  const permissions = context.permissions;
  if (permissions === null) {
    blockers.push('Calibration permissions are missing.');
  } else {
    if (!permissions.readPrinter) {
      blockers.push('Permission denied: printer read is required.');
    }
    if (!permissions.writeCalibration) {
      blockers.push('Permission denied: calibration write is required.');
    }
    if (!permissions.generateCalibration) {
      blockers.push('Permission denied: calibration generation is required.');
    }
    if (!permissions.startPrint) {
      blockers.push('Permission denied: print start is required.');
    }
  }
  return blockers;
}

export function orcaProfileScopeBlockers(
  profile: OrcaProfileEntry | undefined,
  context: CalibrationPrinterContext | null,
  selectedToolId: string,
): readonly string[] {
  if (profile === undefined) {
    return ['Select a profile returned by PrintFarmer profile discovery.'];
  }
  if (context === null) {
    return ['Load current printer context before selecting a base profile.'];
  }
  const tool = context.toolheads.find((item) => item.toolId === selectedToolId);
  if (tool === undefined) {
    return ['Select a physical tool from the current printer snapshot.'];
  }
  const blockers: string[] = [];
  if (profile.source !== 'printFarmer' || !profile.upstreamVerified) {
    blockers.push(
      'The base profile must be PrintFarmer-supplied and upstream verified.',
    );
  }
  if (profile.printerId !== context.printerId) {
    blockers.push('The base profile is scoped to a different printer.');
  }
  if (profile.configurationRevision !== context.configurationRevision) {
    blockers.push(
      'The base profile is scoped to a different configuration revision.',
    );
  }
  if (profile.snapshotId !== context.snapshotId) {
    blockers.push('The base profile is scoped to a different snapshot.');
  }
  if (
    profile.toolId !== tool.toolId ||
    profile.toolheadId !== tool.toolheadId ||
    profile.nozzleId !== tool.nozzle.id ||
    profile.nozzleDiameterMm !== tool.nozzle.diameterMm
  ) {
    blockers.push(
      'The base profile is scoped to a different toolhead or nozzle.',
    );
  }
  return blockers;
}

export function selectedBaseProfileFromEntry(
  profile: OrcaProfileEntry,
): CalibrationSelectedBaseProfile | null {
  if (profile.source !== 'printFarmer' || !profile.upstreamVerified)
    return null;
  return {
    orcaProfileId: profile.orcaProfileId,
    displayName: profile.displayName,
    source: 'printFarmer',
    upstreamVerified: true,
    printerId: profile.printerId,
    configurationRevision: profile.configurationRevision,
    snapshotId: profile.snapshotId,
    toolId: profile.toolId,
    toolheadId: profile.toolheadId,
    nozzleId: profile.nozzleId,
    nozzleDiameterMm: profile.nozzleDiameterMm,
    profileRevision: profile.profileRevision,
    contentHash: profile.contentHash,
  };
}

export function profileMatchesProject(
  profile: OrcaProfileEntry,
  binding: CalibrationBinding,
  selectedProfile: {
    readonly orcaProfileId: string;
    readonly profileRevision: string | null;
    readonly contentHash: string | null;
  },
): boolean {
  const tool = binding.snapshot.toolheads.find(
    (item) => item.toolId === binding.selectedToolId,
  );
  return (
    tool !== undefined &&
    profile.orcaProfileId === selectedProfile.orcaProfileId &&
    profile.source === 'printFarmer' &&
    profile.upstreamVerified &&
    profile.printerId === binding.printer.backendPrinterId &&
    profile.configurationRevision ===
      binding.printer.printerConfigurationRevision &&
    profile.snapshotId === binding.snapshot.snapshotId &&
    profile.toolId === binding.selectedToolId &&
    profile.toolheadId === binding.selectedToolheadId &&
    profile.nozzleId === binding.selectedNozzleId &&
    profile.nozzleDiameterMm === tool.nozzle.diameterMm &&
    profile.profileRevision === selectedProfile.profileRevision &&
    profile.contentHash === selectedProfile.contentHash
  );
}

export function bindingFromContext(
  profileId: string,
  context: CalibrationPrinterContext,
  selectedToolId: string,
  filament: CalibrationBinding['filament'],
): CalibrationBinding | null {
  if (
    !context.isCurrent ||
    !context.configurationId ||
    context.configurationRevision === null ||
    !context.snapshotId ||
    context.snapshotRevision === null ||
    context.slicerIdentity !== 'OrcaSlicer' ||
    context.slicerDistribution !== 'upstream' ||
    context.safety === null ||
    context.permissions === null
  ) {
    return null;
  }
  const selected = context.toolheads.find(
    (tool) => tool.toolId === selectedToolId,
  );
  if (selected === undefined) return null;
  return {
    printer: {
      backendProfileId: profileId,
      backendPrinterId: context.printerId,
      printerConfigurationId: context.configurationId,
      printerConfigurationRevision: context.configurationRevision,
    },
    snapshot: {
      snapshotId: context.snapshotId,
      snapshotRevision: context.snapshotRevision,
      capturedAt: context.snapshotAt,
      configurationRevision: context.configurationRevision,
      toolheads: context.toolheads.map((tool) => ({
        toolId: tool.toolId,
        toolheadId: tool.toolheadId,
        extruderType: tool.extruderType,
        nozzle: {
          nozzleId: tool.nozzle.id,
          diameterMm: tool.nozzle.diameterMm,
          material: tool.nozzle.material,
        },
      })),
      safety: context.safety,
    },
    selectedToolId: selected.toolId,
    selectedToolheadId: selected.toolheadId,
    selectedNozzleId: selected.nozzle.id,
    filament,
  };
}
