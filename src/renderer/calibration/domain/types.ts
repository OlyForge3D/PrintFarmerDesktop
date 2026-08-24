export const CALIBRATION_STAGE_IDS = [
  'temperature',
  'flowPass1',
  'flowPass2',
  'pressureAdvance',
  'flowVerification',
  'retraction',
  'maximumVolumetricSpeed',
  'shrinkage',
  'finalVerification',
] as const;

export type CalibrationStageId = (typeof CALIBRATION_STAGE_IDS)[number];
export type CalibrationMode = 'coach' | 'expert';
export type Confidence = 'low' | 'medium' | 'high';
export type DiagnosticSeverity = 'warning' | 'error';
export type StageStatus =
  'notStarted' | 'inProgress' | 'completed' | 'skipped' | 'needsRetest';

export type CalibrationUnit =
  | 'celsius'
  | 'millimeter'
  | 'millimeterPerSecond'
  | 'cubicMillimeterPerSecond'
  | 'second'
  | 'percent'
  | 'ratio'
  | 'count'
  | 'boolean';

export type CalibrationMethod =
  | 'temperatureTower'
  | 'flowStandard'
  | 'flowCoarse'
  | 'flowYolo'
  | 'flowFine'
  | 'pressureAdvanceTower'
  | 'pressureAdvanceLine'
  | 'pressureAdvancePattern'
  | 'verificationPrint'
  | 'retractionTower'
  | 'volumetricSpeedTower'
  | 'dimensionalCoupon';

export interface CalibrationDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly field?: string | undefined;
  readonly stageId?: CalibrationStageId | undefined;
  readonly eventId?: string | undefined;
}

export interface BackendPrinterIdentity {
  readonly backendProfileId: string;
  readonly backendPrinterId: string;
  readonly printerConfigurationId: string;
  readonly printerConfigurationRevision: number;
}

export interface NozzleIdentity {
  readonly nozzleId: string;
  readonly diameterMm: number;
  readonly material: string;
}

export interface ToolheadIdentity {
  readonly toolId: string;
  readonly toolheadId: string;
  readonly nozzle: NozzleIdentity;
  readonly extruderType: 'directDrive' | 'bowden';
}

export interface PrinterSafetyContext {
  readonly buildVolumeMm: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly maximumNozzleTemperatureC: number;
  readonly maximumBedTemperatureC: number;
  readonly maximumVolumetricRateMm3S: number;
  readonly emergencyStopAvailable: boolean;
  readonly thermalProtectionConfirmed: boolean;
  readonly ventilationAssessed: boolean;
}

export interface PrinterSnapshot {
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly capturedAt: string;
  readonly configurationRevision: number;
  readonly toolheads: readonly ToolheadIdentity[];
  readonly safety: PrinterSafetyContext;
}

export interface FilamentIdentity {
  readonly filamentProjectId: string;
  readonly provider: string;
  readonly product: string;
  readonly sku: string;
  readonly spoolId?: string | undefined;
}

export interface CalibrationBinding {
  readonly printer: BackendPrinterIdentity;
  readonly snapshot: PrinterSnapshot;
  readonly selectedToolId: string;
  readonly selectedToolheadId: string;
  readonly selectedNozzleId: string;
  readonly profileIdentities?:
    | {
        readonly machine: CalibrationProfileIdentity;
        readonly process: CalibrationProfileIdentity;
        readonly filament: CalibrationProfileIdentity;
      }
    | undefined;
  readonly filament: FilamentIdentity;
}

export interface CalibrationProfileIdentity {
  readonly backendProfileId: string;
  readonly orcaProfileName: string;
  readonly profileRevision: string;
  readonly contentHash: string;
}

export interface BaselineProfile {
  readonly nozzleTemperatureC: number;
  readonly flowRatio: number;
  readonly pressureAdvance: number;
  readonly retractionLengthMm: number;
  readonly maximumVolumetricRateMm3S: number;
  readonly shrinkageCompensationXPercent: number;
  readonly shrinkageCompensationYPercent: number;
  readonly shrinkageCompensationZPercent: number;
}

interface ObservationBase {
  readonly observationId: string;
  readonly attemptId: string;
  readonly observedAt: string;
  readonly notes: string;
}

export interface TemperatureObservation extends ObservationBase {
  readonly stageId: 'temperature';
  readonly temperatureC: number;
  readonly quality: number;
}

export interface FlowObservation extends ObservationBase {
  readonly stageId: 'flowPass1' | 'flowPass2';
  readonly adjustmentPercent: number;
  readonly quality: number;
}

export interface PressureAdvanceObservation extends ObservationBase {
  readonly stageId: 'pressureAdvance';
  readonly pressureAdvance: number;
  readonly quality: number;
}

export interface VerificationObservation extends ObservationBase {
  readonly stageId: 'flowVerification' | 'finalVerification';
  readonly passed: boolean;
  readonly defectCount: number;
}

export interface RetractionObservation extends ObservationBase {
  readonly stageId: 'retraction';
  readonly retractionLengthMm: number;
  readonly quality: number;
}

export interface VolumetricSpeedObservation extends ObservationBase {
  readonly stageId: 'maximumVolumetricSpeed';
  readonly stableVolumetricRateMm3S: number;
  readonly quality: number;
}

export interface ShrinkageObservation extends ObservationBase {
  readonly stageId: 'shrinkage';
  readonly nominalXmm: number;
  readonly nominalYmm: number;
  readonly nominalZmm: number;
  readonly measuredXmm: number;
  readonly measuredYmm: number;
  readonly measuredZmm: number;
}

export type CalibrationObservation =
  | TemperatureObservation
  | FlowObservation
  | PressureAdvanceObservation
  | VerificationObservation
  | RetractionObservation
  | VolumetricSpeedObservation
  | ShrinkageObservation;

export interface CalibrationRecommendation {
  readonly summary: string;
  readonly rationale: string;
  readonly values: readonly {
    readonly key: string;
    readonly value: number | boolean;
    readonly unit: CalibrationUnit;
  }[];
}

export interface CalibrationAttemptScope {
  readonly backendProfileId: string;
  readonly backendPrinterId: string;
  readonly printerConfigurationId: string;
  readonly printerConfigurationRevision: number;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
  readonly toolId: string;
  readonly toolheadId: string;
  readonly nozzleId: string;
  readonly filamentProjectId: string;
  readonly filamentProvider: string;
  readonly filamentProduct: string;
  readonly filamentSku: string;
  readonly spoolId?: string | undefined;
}

export interface CalibrationAttempt {
  readonly attemptId: string;
  readonly stageId: CalibrationStageId;
  readonly method: CalibrationMethod;
  readonly scope: CalibrationAttemptScope;
  readonly ordinal: number;
  readonly status: 'inProgress' | 'completed' | 'abandoned';
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly observations: readonly CalibrationObservation[];
  readonly selectedObservationId?: string | undefined;
  readonly confidence?: Confidence | undefined;
  readonly recommendation?: CalibrationRecommendation | undefined;
  readonly diagnostics: readonly CalibrationDiagnostic[];
}

export interface StageSkip {
  readonly skipId: string;
  readonly reason: string;
  readonly skippedAt: string;
}

export interface StageProgress {
  readonly stageId: CalibrationStageId;
  readonly status: StageStatus;
  readonly attemptIds: readonly string[];
  readonly selectedAttemptId?: string | undefined;
  readonly skip?: StageSkip | undefined;
  readonly retestReason?: string | undefined;
}

export type StageProgressMap = {
  readonly [Stage in CalibrationStageId]: StageProgress;
};

interface CalibrationEventBase {
  readonly eventId: string;
  readonly timestamp: string;
}

export type CalibrationEvent =
  | (CalibrationEventBase & {
      readonly type: 'setMode';
      readonly mode: CalibrationMode;
    })
  | (CalibrationEventBase & {
      readonly type: 'navigate';
      readonly stageId: CalibrationStageId;
    })
  | (CalibrationEventBase & {
      readonly type: 'beginAttempt';
      readonly attemptId: string;
      readonly stageId: CalibrationStageId;
      readonly method: CalibrationMethod;
    })
  | (CalibrationEventBase & {
      readonly type: 'recordObservation';
      readonly attemptId: string;
      readonly observation: CalibrationObservation;
    })
  | (CalibrationEventBase & {
      readonly type: 'selectObservation';
      readonly attemptId: string;
      readonly observationId: string;
    })
  | (CalibrationEventBase & {
      readonly type: 'completeAttempt';
      readonly attemptId: string;
      readonly confidence: Confidence;
    })
  | (CalibrationEventBase & {
      readonly type: 'skipStage';
      readonly stageId: CalibrationStageId;
      readonly skipId: string;
      readonly reason: string;
    })
  | (CalibrationEventBase & {
      readonly type: 'redoStage';
      readonly stageId: CalibrationStageId;
      readonly attemptId: string;
      readonly method: CalibrationMethod;
      readonly reason: string;
    })
  | (CalibrationEventBase & {
      readonly type: 'rebaseSnapshot';
      readonly binding: CalibrationBinding;
      readonly retestStages: readonly CalibrationStageId[];
      readonly reason: string;
    });

export interface CalibrationState {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly createdAt: string;
  readonly mode: CalibrationMode;
  readonly baseline: BaselineProfile;
  readonly binding: CalibrationBinding;
  readonly snapshotHistory: readonly PrinterSnapshot[];
  readonly currentStageId: CalibrationStageId;
  readonly stages: StageProgressMap;
  readonly attempts: readonly CalibrationAttempt[];
  readonly history: readonly CalibrationEvent[];
  readonly diagnostics: readonly CalibrationDiagnostic[];
}

export interface CreateCalibrationStateInput {
  readonly projectId: string;
  readonly createdAt: string;
  readonly mode: CalibrationMode;
  readonly baseline: BaselineProfile;
  readonly binding: CalibrationBinding;
}

export interface StageDefinition {
  readonly id: CalibrationStageId;
  readonly title: string;
  readonly order: number;
  readonly dependencies: readonly CalibrationStageId[];
  readonly coachMethods: readonly CalibrationMethod[];
  readonly expertMethods: readonly CalibrationMethod[];
  readonly coachSkippable: boolean;
  readonly expertSkippable: boolean;
  readonly guidance: {
    readonly coach: string;
    readonly expert: string;
  };
}

export interface CalibrationFieldBound {
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
  readonly unit: CalibrationUnit;
}

export interface PhysicalMatchConfirmation {
  readonly snapshotId: string;
  readonly toolId: string;
  readonly toolheadId: string;
  readonly nozzleId: string;
  readonly nozzleDiameterMm: number;
  readonly confirmedAt: string;
}

export interface RuntimeCalibrationContext {
  readonly online: boolean;
  readonly pendingMutationCount: number;
  readonly unresolvedConflictCount: number;
  readonly currentPrinterConfigurationRevision: number | null;
  readonly currentSnapshotRevision: number | null;
  readonly physicalMatch: PhysicalMatchConfirmation | null;
  readonly bedClearConfirmed: boolean;
  readonly operatorPresent: boolean;
  /**
   * Whether the negotiated server advertises `calibrationGenerationEnabled`.
   * Generation and profile-patch actions are withheld when it does not, because
   * the server has no slicing path to satisfy them.
   */
  readonly serverGenerationEnabled: boolean;
}

export type GuardedCalibrationAction =
  'generate' | 'queue' | 'acknowledgeBedClear' | 'startPrint' | 'applyPatch';

export interface ActionDecision {
  readonly allowed: boolean;
  readonly blockers: readonly CalibrationDiagnostic[];
}

export interface CalibrationStageViewModel {
  readonly id: CalibrationStageId;
  readonly title: string;
  readonly order: number;
  readonly status: StageStatus;
  readonly isCurrent: boolean;
  readonly canNavigate: boolean;
  readonly canStart: boolean;
  readonly canSkip: boolean;
  readonly availableMethods: readonly CalibrationMethod[];
  readonly dependencies: readonly CalibrationStageId[];
  readonly attemptCount: number;
  readonly selectedAttempt?: CalibrationAttempt | undefined;
  readonly guidance: string;
  readonly blockers: readonly CalibrationDiagnostic[];
}

export interface CalibrationWorkflowViewModel {
  readonly projectId: string;
  readonly mode: CalibrationMode;
  readonly currentStageId: CalibrationStageId;
  readonly nextStageId: CalibrationStageId | null;
  readonly completedCount: number;
  readonly resolvedCount: number;
  readonly totalCount: number;
  readonly stages: readonly CalibrationStageViewModel[];
  readonly diagnostics: readonly CalibrationDiagnostic[];
}

export type OrcaPatchTarget = 'filament' | 'printer' | 'process';

export interface OrcaPatchScope {
  readonly backendPrinterId: string;
  readonly printerConfigurationId: string;
  readonly printerConfigurationRevision: number;
  readonly snapshotId: string;
  readonly toolId: string;
  readonly toolheadId: string;
  readonly nozzleId: string;
  readonly filamentProjectId: string;
  readonly filamentSku: string;
  readonly spoolId?: string | undefined;
}

export interface OrcaProfilePatchEntry {
  readonly target: OrcaPatchTarget;
  readonly key: string;
  readonly value: number | boolean | string;
  readonly unit: CalibrationUnit;
  readonly sourceStageId: CalibrationStageId;
  readonly sourceAttemptId: string;
  readonly sourceObservationId: string;
  readonly scope: OrcaPatchScope;
}

export interface OrcaProfilePatch {
  readonly projectId: string;
  readonly basePrinterConfigurationRevision: number;
  readonly snapshotId: string;
  readonly entries: readonly OrcaProfilePatchEntry[];
  readonly diagnostics: readonly CalibrationDiagnostic[];
}
