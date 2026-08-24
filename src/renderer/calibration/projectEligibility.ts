import type {
  CalibrationPrinterCandidate,
  CalibrationPrinterContext,
  CalibrationSelectedBaseProfile,
  OrcaProfileEntry,
} from '@shared/ipc';
import type { CalibrationBinding } from './domain';
import {
  describeMissingInputs,
  describeRejectionReasonCode,
} from './refusalMessages';

/**
 * Why this printer cannot be calibrated, in the server's own terms.
 *
 * PrintFarmer refuses a printer by naming every unmet precondition, and those
 * codes reach the renderer intact. They used to stop here: an ineligible
 * candidate produced one sentence saying canonical eligibility was incomplete,
 * which is equally true of a printer that is merely offline, one whose firmware
 * was never identified and one whose slicer engine was never set. The operator
 * saw a refusal with no field to go and populate, and support saw a report with
 * nothing in it. The codes are read out instead, and the generic sentence is
 * kept only for the case that produces none — a candidate that was never
 * selected.
 */
export function candidateEligibilityBlockers(
  candidate: CalibrationPrinterCandidate | undefined,
): readonly string[] {
  if (candidate === undefined) {
    return ['Select a printer returned by PrintFarmer.'];
  }
  if (candidate.eligibility !== null) {
    // Eligibility and refusal are mutually exclusive by schema, so an eligible
    // candidate has no reasons to read out. Offline is still checked: the
    // candidate screen can pass before the printer is reachable.
    return candidate.isOnline
      ? []
      : ['The printer is offline, so current context cannot be verified.'];
  }
  const blockers = candidate.rejectionReasonCodes.map(
    describeRejectionReasonCode,
  );
  const missing = describeMissingInputs(candidate.missingInputs);
  if (missing !== null) blockers.push(missing);
  if (blockers.length === 0) {
    // Unreachable through the IPC handler, which guarantees at least one code
    // for every refused printer. Retained because this function is also given
    // candidates by tests and by any future caller that builds one by hand, and
    // an empty blocker list would read as "eligible" — the one meaning it must
    // never have.
    blockers.push(
      'PrintFarmer did not provide complete canonical Klipper, OrcaSlicer, upstream eligibility for this printer.',
    );
  }
  if (!candidate.isOnline) {
    blockers.push(
      'The printer is offline, so current context cannot be verified.',
    );
  }
  return [...new Set(blockers)];
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
  // The server's own reasons come first: they name what is actually wrong —
  // "the machine profile is scoped to a different printer" — where the
  // structural checks below can only report the shape of what is missing. Both
  // are shown, because each catches refusals the other cannot see.
  //
  // Read through a default despite the schema supplying one. This function runs
  // inside the wizard's render, so an absent array here is not a missing
  // sentence but a thrown `TypeError` that blanks the whole step — trading a
  // printer that cannot explain itself for a wizard that cannot be used at all.
  // Both members are additive, and a context assembled anywhere other than the
  // parsed IPC boundary will not carry them.
  blockers.push(
    ...(context.rejectionReasonCodes ?? []).map(describeRejectionReasonCode),
  );
  const missing = describeMissingInputs(context.missingInputs ?? []);
  if (missing !== null) blockers.push(missing);
  if (candidate.eligibility === null) {
    blockers.push('Canonical PrintFarmer printer eligibility is missing.');
  }
  if (!candidate.isOnline) {
    blockers.push('The selected printer is offline.');
  }
  if (context.evaluationScope !== 'full') {
    // Stated separately from staleness because the remedy differs: a stale
    // snapshot is refreshed, whereas this one means PrintFarmer has not
    // resolved the printer's profiles or has refused it outright.
    blockers.push(
      'PrintFarmer has not fully evaluated this printer, so a project cannot be bound to it.',
    );
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
  if (
    context.profileIdentities === null ||
    context.profileIdentities === undefined
  ) {
    blockers.push(
      'Current context is missing exact machine, process, or filament profile identity.',
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
    blockers.push('Authoritative printer limits are missing.');
  }
  // The interlock booleans inside `safety` and the whole `permissions` block are
  // deliberately not checked here. PrintFarmer's context DTO carries neither, so
  // requiring them refused every real printer — the operator was told the
  // machine lacked an emergency stop when the server had simply never been asked
  // about one. Authorisation and machine-movement safety are enforced by the
  // action interlock, against the capability payload's effective permissions and
  // a recorded operator acknowledgement.
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
  // Accept printFarmer-verified profiles and locally-verified systemInstall profiles.
  const isEligibleSource =
    (profile.source === 'printFarmer' && profile.upstreamVerified) ||
    (profile.source === 'systemInstall' && profile.upstreamVerified);
  if (!isEligibleSource) {
    blockers.push(
      'The base profile must be PrintFarmer-supplied or a locally verified upstream system install.',
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
  const isEligible =
    (profile.source === 'printFarmer' || profile.source === 'systemInstall') &&
    profile.upstreamVerified;
  if (!isEligible) return null;
  return {
    orcaProfileId: profile.orcaProfileId,
    displayName: profile.displayName,
    source: profile.source as 'printFarmer' | 'systemInstall',
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
  const isEligibleSource =
    (profile.source === 'printFarmer' || profile.source === 'systemInstall') &&
    profile.upstreamVerified;
  return (
    tool !== undefined &&
    profile.orcaProfileId === selectedProfile.orcaProfileId &&
    isEligibleSource &&
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
    // Only the server's authoritative verdict may be bound. A preliminary
    // context — profiles not evaluated, or an older build that says nothing —
    // describes the printer without agreeing to calibrate it, and binding a
    // project to that would rest on the candidate list's basic screen.
    context.evaluationScope !== 'full' ||
    !context.configurationId ||
    context.configurationRevision === null ||
    !context.snapshotId ||
    context.snapshotRevision === null ||
    context.slicerIdentity !== 'OrcaSlicer' ||
    context.slicerDistribution !== 'upstream' ||
    context.profileIdentities === null ||
    context.profileIdentities === undefined ||
    // Machine limits (bed volume, temperatures, flow) are required because the
    // snapshot records them; those come from the server. `permissions` is not
    // required at all: `CalibrationContextDto` has no such member, so
    // requiring it made every real context unbindable and blocked project
    // creation outright rather than gating anything. Authorisation is
    // enforced by the action interlock against the capability payload's
    // effective permissions.
    context.safety === null
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
    profileIdentities: context.profileIdentities,
    filament,
  };
}
