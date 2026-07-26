import type {
  CalibrationAvailability,
  CalibrationPrinterCandidate,
  CalibrationPrinterContext,
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
