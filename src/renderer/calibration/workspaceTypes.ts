import type {
  CalibrationAvailability,
  CalibrationBedClearAckOutcome,
  CalibrationBlockedReason,
  CalibrationExternalLinkId,
  CalibrationOrchestrationStatus,
  CalibrationPrinterCandidate,
  CalibrationPrinterContext,
  CalibrationQueueJobState,
  CalibrationSelectedBaseProfile,
  CalibrationUnhydratedProject,
  CalibrationWorkspacePayload,
  CalibrationWorkspaceStateRecord,
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

export interface CreationDataState {
  readonly printers: readonly CalibrationPrinterCandidate[];
  readonly profiles: readonly OrcaProfileEntry[];
  readonly context: CalibrationPrinterContext | null;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly contextLoading: boolean;
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
  readonly loadPrinterContext: (printerId: string) => Promise<void>;
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
  /** Start backend generation for the given stage and method (G-03, G-04). */
  readonly startGeneration: (params: GenerationStartParams) => Promise<void>;
  /**
   * L-04: Reconcile an existing failed/uncertain operation without a new UUID.
   * Same operationId is replayed idempotently; old attempt history is preserved.
   */
  readonly retryGeneration: (params: GenerationStartParams) => Promise<void>;
  /**
   * L-04: Create a NEW attempt+operation for a true retry. Fresh operationId;
   * old attempt/generation/job/lifecycle history is preserved intact.
   */
  readonly retryWithNewAttempt: (
    params: GenerationStartParams,
  ) => Promise<void>;
  /** Poll orchestration status from REST (G-06). */
  readonly pollOrchestrationStatus: (orchestrationId: string) => Promise<void>;
  /** Refresh queue job state from REST (Q-01). */
  readonly refreshQueueState: (jobId: string | null) => Promise<void>;
  /** Open the bed-clear safety dialog for the current job (B-01). */
  readonly openBedClearDialog: () => void;
  /** Close the bed-clear safety dialog without acknowledging. */
  readonly closeBedClearDialog: () => void;
  /** Acknowledge bed clear and start the job (B-02). */
  readonly acknowledgeBedClear: () => Promise<void>;
  /** Clear all generation/queue/lifecycle state for this stage. */
  readonly clearGenerationState: (stageId: CalibrationStageId) => void;
  /** Open a reviewed allowlisted calibration external link via IPC (A-02, S-04). */
  readonly openExternalUrl: (linkId: CalibrationExternalLinkId) => void;
  /** Complete the active attempt with the current workflow result (L-05). */
  readonly completeAttemptWithResult: (
    stageId: CalibrationStageId,
  ) => Promise<void>;
  /** Current generation operation state (null = none started). */
  readonly generationState: CalibrationGenerationState | null;
  /** Current queue job state (null = no job or not fetched). */
  readonly queueJobState: CalibrationQueueJobDisplayState | null;
  /** Bed-clear dialog state. */
  readonly bedClearDialog: BedClearDialogState;
}

/** State of a generated OrcaSlicer profile (from CalibrationGenerateOrcaProfile). */
export interface GeneratedProfileState {
  /** Client-generated operation ID used to correlate generate → export/install. */
  readonly operationId: string;
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

/** Parameters required to start backend generation (G-04). */
export interface GenerationStartParams {
  readonly profileId: string;
  readonly projectId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly stageId: CalibrationStageId;
  readonly method: string;
  readonly definitionVersion: string;
  readonly baseRevision: number | null;
}

/** State of the current backend generation operation for a stage. */
export interface CalibrationGenerationState {
  /** The stage this generation is for. */
  readonly stageId: CalibrationStageId;
  /** Client-generated stable operation ID (idempotency key). */
  readonly operationId: string;
  /** Whether a generation request has been submitted. */
  readonly submitted: boolean;
  /** Whether submission is in progress (request in flight). */
  readonly submitting: boolean;
  /** The orchestration returned after submission or last poll. */
  readonly orchestration: CalibrationOrchestrationStatus | null;
  /** Whether we are currently polling orchestration status. */
  readonly polling: boolean;
  /** User-visible error if generation or polling failed. */
  readonly error: string | null;
}

/** Typed blocked reason for display in the UI (Q-05, L-06). */
export interface BlockedReasonDisplay {
  readonly code: CalibrationBlockedReason['code'];
  readonly detail: string | null;
}

/** State of the current queue job for display (Q-01). */
export interface CalibrationQueueJobDisplayState {
  /** The stage this queue job is associated with. */
  readonly stageId: CalibrationStageId;
  /** Whether queue state is being fetched. */
  readonly loading: boolean;
  /** User-visible error if queue state fetch failed. */
  readonly error: string | null;
  /** The authoritative job state from REST. */
  readonly job: CalibrationQueueJobState | null;
  /** Typed blocked reasons from REST (Q-05). */
  readonly blockedReasons: readonly BlockedReasonDisplay[];
  /** When the bed-clear expiry last ticked for countdown display. */
  readonly lastRefreshedAt: string | null;
}

/** State of the bed-clear acknowledgement dialog (B-01 through B-07). */
export interface BedClearDialogState {
  /** Whether the dialog is open. */
  readonly open: boolean;
  /** Whether acknowledgement is in progress. */
  readonly acknowledging: boolean;
  /** The stable UUID for this dialog invocation (B-05). */
  readonly operationId: string | null;
  /** The outcome of the most recent acknowledgement attempt. */
  readonly outcome: CalibrationBedClearAckOutcome | null;
  /** User-visible error from acknowledgement. */
  readonly error: string | null;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : fallback;
}

export function formatTimestamp(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}
