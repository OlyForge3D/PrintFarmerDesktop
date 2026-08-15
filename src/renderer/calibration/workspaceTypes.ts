import type {
  CalibrationAvailability,
  CalibrationPrinterCandidate,
  CalibrationPrinterContext,
  CalibrationPrintObservation,
  CalibrationProfileDiscoveryDiagnostic,
  CalibrationSelectedBaseProfile,
  CalibrationUnhydratedProject,
  CalibrationWorkspacePayload,
  CalibrationWorkspaceStateRecord,
  LocalOrcaDiscoveryDiagnostic,
  LocalOrcaProfileSummary,
  OrcaProfileEntry,
} from '@shared/ipc';
import type { CalibrationEnvironment } from './api';
import type {
  CalibrationEvent,
  CalibrationStageId,
  CalibrationState,
  PhysicalMatchConfirmation,
} from './domain';

export type CalibrationWorkspaceFlush = () => Promise<void>;

export interface CalibrationWorkspaceProps {
  readonly selectedProfileId: string | null;
  readonly selectedProfileName?: string;
  readonly selectedServerDisplayName?: string;
  readonly disabled?: boolean;
  readonly onManageProfiles?: () => void;
  readonly onManageServerProfiles?: () => void;
  readonly onReportError?: (message: string) => void;
  readonly onFlushReady?: (flush: CalibrationWorkspaceFlush | null) => void;
  readonly environment?: CalibrationEnvironment;
}

export type CalibrationWorkspaceView =
  'dashboard' | 'newProject' | 'overview' | 'step' | 'report' | 'profile';

export type WorkspacePhoto = CalibrationWorkspacePayload['photos'][number];
export type WorkspaceStepDraft = NonNullable<
  CalibrationWorkspacePayload['stepDrafts'][CalibrationStageId]
>;
export type WorkspaceWorkflowDraft =
  CalibrationWorkspacePayload['workflowDrafts'][CalibrationStageId];
export type WorkspaceWorkflowDrafts =
  CalibrationWorkspacePayload['workflowDrafts'];

export const EMPTY_WORKFLOW_DRAFT: WorkspaceWorkflowDraft = {
  method: null,
  observation: {
    primary: '',
    quality: '',
    notes: '',
    passed: false,
    nominalXmm: '',
    nominalYmm: '',
    nominalZmm: '',
    measuredXmm: '',
    measuredYmm: '',
    measuredZmm: '',
  },
  confidence: null,
  reason: '',
  photoAttemptId: null,
  photoCaption: '',
  photoOrder: 1,
};

function freshWorkflowDraft(): WorkspaceWorkflowDraft {
  return {
    ...EMPTY_WORKFLOW_DRAFT,
    observation: { ...EMPTY_WORKFLOW_DRAFT.observation },
  };
}

export function emptyWorkflowDrafts(): WorkspaceWorkflowDrafts {
  return {
    temperature: freshWorkflowDraft(),
    flowPass1: freshWorkflowDraft(),
    flowPass2: freshWorkflowDraft(),
    pressureAdvance: freshWorkflowDraft(),
    flowVerification: freshWorkflowDraft(),
    retraction: freshWorkflowDraft(),
    maximumVolumetricSpeed: freshWorkflowDraft(),
    shrinkage: freshWorkflowDraft(),
    finalVerification: freshWorkflowDraft(),
  };
}

export interface OpenCalibrationProject {
  readonly record: CalibrationWorkspaceStateRecord;
  readonly domainState: CalibrationState;
}

/**
 * State of the printer-first project creation flow.
 *
 * The shape enforces the sequence. `printers` is the only thing loaded before
 * the operator chooses; `selectedPrinterId` is null until they do, and every
 * per-printer field below it stays empty while it is null. Nothing here can be
 * populated by a response for a printer other than `selectedPrinterId`.
 */
export interface CreationDataState {
  readonly printers: readonly CalibrationPrinterCandidate[];
  /**
   * Whether the server offered more printers than `printers` carries.
   *
   * Client-derived in the main process from the raw response length, so a
   * server can neither hide a cut nor invent one. Surfaced because announcing
   * "500 printer candidates loaded" for a farm of 540 would send an operator
   * looking for a printer that is simply off the end.
   */
  readonly printersTruncated: boolean;
  /**
   * How many candidates the server sent that could not be read.
   *
   * A malformed record is dropped on its own rather than failing the whole
   * farm, so this is the difference between the list shown and the list the
   * server actually offered.
   */
  readonly printersUnreadable: number;
  /** Why the candidate list looks the way it does. Null before the first load. */
  readonly candidateDiagnostic: CalibrationProfileDiscoveryDiagnostic | null;
  /**
   * The printer the operator explicitly selected. Never auto-populated: an
   * automatically selected first printer would make the wizard fetch a context
   * nobody asked for and silently bias which machine gets calibrated.
   */
  readonly selectedPrinterId: string | null;
  readonly profiles: readonly OrcaProfileEntry[];
  readonly context: CalibrationPrinterContext | null;
  /** Server-side profile resolution outcome for the selected printer. */
  readonly profileDiagnostic: CalibrationProfileDiscoveryDiagnostic | null;
  /** Local OrcaSlicer lookup outcome for the selected printer. */
  readonly localDiagnostic: LocalOrcaDiscoveryDiagnostic | null;
  readonly localProfiles: readonly LocalOrcaProfileSummary[];
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly contextLoading: boolean;
  /** Failure loading the candidate list. Never cleared by a per-printer error. */
  readonly listError: string | null;
  /** Failure loading the selected printer's context or profiles. */
  readonly error: string | null;
}

export interface NewProjectInput {
  readonly domainState: CalibrationState;
  readonly displayName: string;
  readonly description: string;
  readonly printerId: string;
  readonly selectedBaseProfile: CalibrationSelectedBaseProfile;
  readonly physicalMatch: PhysicalMatchConfirmation;
}

export interface MetadataDraft {
  readonly displayName: string;
  readonly description: string;
}

export interface CalibrationWorkspaceStoreValue {
  readonly profileId: string | null;
  readonly profileName: string;
  readonly disabled: boolean;
  readonly environment: CalibrationEnvironment;
  readonly view: CalibrationWorkspaceView;
  readonly selectedStageId: CalibrationStageId;
  readonly availability: CalibrationAvailability | null;
  readonly records: readonly CalibrationWorkspaceStateRecord[];
  readonly unhydratedProjects: readonly CalibrationUnhydratedProject[];
  readonly recoveryByProject: Readonly<Record<string, string>>;
  readonly loading: boolean;
  readonly offline: boolean;
  readonly error: string | null;
  readonly activeProject: OpenCalibrationProject | null;
  readonly metadataDraft: MetadataDraft;
  readonly metadataError: string | null;
  readonly creation: CreationDataState;
  readonly orcaProfiles: readonly OrcaProfileEntry[];
  readonly liveMessage: string;
  readonly alertMessage: string | null;
  /** State of the most recent profile generation operation. */
  readonly generatedProfile: GeneratedProfileState | null;
  readonly manageProfiles: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly sync: (projectId?: string) => Promise<void>;
  readonly flush: CalibrationWorkspaceFlush;
  readonly navigate: (view: CalibrationWorkspaceView) => Promise<void>;
  readonly openProject: (projectId: string) => Promise<void>;
  readonly openStage: (stageId: CalibrationStageId) => Promise<void>;
  readonly loadCreationData: () => Promise<void>;
  /**
   * Select one printer and load only that printer's context and profiles.
   *
   * Passing null clears the selection and every derived result. Both directions
   * cancel whatever the previous selection had in flight.
   */
  readonly selectPrinter: (printerId: string | null) => Promise<void>;
  /**
   * Resolve OrcaSlicer profiles for the open project's own printer, scoped to
   * the printer and configuration revision that project is bound to.
   */
  readonly loadProjectProfiles: () => Promise<void>;
  readonly createProject: (input: NewProjectInput) => Promise<boolean>;
  readonly dispatchEvent: (event: CalibrationEvent) => Promise<boolean>;
  readonly updateMetadata: (
    field: 'displayName' | 'description',
    value: string,
  ) => void;
  readonly updateStepDraft: (
    stageId: CalibrationStageId,
    field: keyof WorkspaceStepDraft,
    value: string,
  ) => void;
  readonly updateWorkflowDraft: (
    stageId: CalibrationStageId,
    draft: WorkspaceWorkflowDraft,
  ) => void;
  readonly setPhysicalMatch: (
    confirmation: PhysicalMatchConfirmation | null,
  ) => Promise<void>;
  readonly addPhoto: (
    photo: WorkspacePhoto,
    stageId: CalibrationStageId,
  ) => Promise<void>;
  /**
   * Append a print lifecycle observation to durable workspace state (criterion
   * 13). Idempotent: a second call with the same observationId is a no-op.
   */
  readonly storePrintObservation: (
    observation: CalibrationPrintObservation,
  ) => Promise<void>;
  /**
   * Associate a validated asset SHA-256 checksum with a domain attempt ID
   * (criterion 14a). Persisted so provenance survives a workspace reload.
   */
  readonly storeAttemptAssetSha256: (
    attemptId: string,
    sha256: string,
  ) => Promise<void>;
  readonly refreshProjectContext: () => Promise<CalibrationPrinterContext | null>;
  readonly announce: (message: string) => void;
  readonly reportError: (message: string) => void;
  /** Generate an OrcaSlicer profile from the current project's calibration data. */
  readonly generateProfile: () => Promise<void>;
  /** Export the generated profile to a user-chosen location (macOS/Linux). */
  readonly exportProfile: () => Promise<void>;
  /** Install the generated profile transactionally (Windows). */
  readonly installProfile: () => Promise<void>;
  /** Restore from a prior install backup (Windows). */
  readonly restoreProfile: () => Promise<void>;
}

/** State of a generated OrcaSlicer profile (from CalibrationGenerateOrcaProfile). */
export interface GeneratedProfileState {
  /** Client-generated operation ID used to correlate generate → export/install. */
  readonly operationId: string;
  readonly profileId: string;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly displayName: string;
  readonly safeFilename: string;
  readonly profileJsonHash: string;
  readonly patchedFieldCount: number;
  readonly warnings: readonly string[];
  /** Install outcome (Windows). Set after a successful installProfile call. */
  readonly installedHash: string | null;
  readonly backupHash: string | null;
  /** Export outcome. Set after a successful exportProfile call. */
  readonly exportedHash: string | null;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}

/**
 * Renders a calibration IPC error as operator-facing text (#177).
 *
 * `message` is catalogued in the main process -- it is chosen from fixed
 * literals keyed by the error code, never copied from the backend. That closes
 * the ProblemDetails leak but removes the only actionable string some failures
 * had. `reference` is what replaces it: an opaque correlation id the operator
 * can quote, which resolves to the main-process log record where the backend's
 * raw detail was retained.
 *
 * Appended rather than shown separately because every existing calibration
 * surface renders a single string, and a reference the operator cannot see is
 * a field that satisfies the ruling in the payload and fails it at the screen.
 */
export function calibrationErrorText(error: {
  readonly message: string;
  readonly reference: string | null;
}): string {
  return error.reference === null
    ? error.message
    : `${error.message} Reference ${error.reference}.`;
}

export function formatTimestamp(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}
