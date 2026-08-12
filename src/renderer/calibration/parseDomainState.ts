import { z } from 'zod';
import type { CalibrationWorkspaceStateRecord } from '@shared/ipc';
import {
  CALIBRATION_STAGE_IDS,
  type CalibrationState,
  type PhysicalMatchConfirmation,
} from './domain';

const nonEmptyId = z.string().min(1).max(256);
const timestamp = z.string().datetime();
const stageId = z.enum(CALIBRATION_STAGE_IDS);
const method = z.enum([
  'temperatureTower',
  'flowStandard',
  'flowCoarse',
  'flowYolo',
  'flowFine',
  'pressureAdvanceTower',
  'pressureAdvanceLine',
  'pressureAdvancePattern',
  'verificationPrint',
  'retractionTower',
  'volumetricSpeedTower',
  'dimensionalCoupon',
]);
const confidence = z.enum(['low', 'medium', 'high']);
const unit = z.enum([
  'celsius',
  'millimeter',
  'millimeterPerSecond',
  'cubicMillimeterPerSecond',
  'second',
  'percent',
  'ratio',
  'count',
  'boolean',
]);

const diagnostic = z
  .object({
    code: nonEmptyId,
    severity: z.enum(['warning', 'error']),
    message: z.string().min(1).max(16_384),
    field: z.string().max(256).optional(),
    stageId: stageId.optional(),
    eventId: nonEmptyId.optional(),
  })
  .strict();

const baseline = z
  .object({
    nozzleTemperatureC: z.number().finite(),
    flowRatio: z.number().finite(),
    pressureAdvance: z.number().finite(),
    retractionLengthMm: z.number().finite(),
    maximumVolumetricRateMm3S: z.number().finite(),
    shrinkageCompensationXPercent: z.number().finite(),
    shrinkageCompensationYPercent: z.number().finite(),
    shrinkageCompensationZPercent: z.number().finite(),
  })
  .strict();

const nozzle = z
  .object({
    nozzleId: nonEmptyId,
    diameterMm: z.number().positive().max(10),
    material: z.string().trim().min(1).max(256),
  })
  .strict();
const toolhead = z
  .object({
    toolId: nonEmptyId,
    toolheadId: nonEmptyId,
    nozzle,
    extruderType: z.enum(['directDrive', 'bowden']),
  })
  .strict();
const safety = z
  .object({
    buildVolumeMm: z
      .object({
        x: z.number().positive().max(10_000),
        y: z.number().positive().max(10_000),
        z: z.number().positive().max(10_000),
      })
      .strict(),
    maximumNozzleTemperatureC: z.number().positive().max(2_000),
    maximumBedTemperatureC: z.number().nonnegative().max(1_000),
    maximumVolumetricRateMm3S: z.number().positive().max(10_000),
    emergencyStopAvailable: z.boolean(),
    thermalProtectionConfirmed: z.boolean(),
    ventilationAssessed: z.boolean(),
  })
  .strict();
const snapshot = z
  .object({
    snapshotId: nonEmptyId,
    snapshotRevision: z.number().int().nonnegative(),
    capturedAt: timestamp,
    configurationRevision: z.number().int().nonnegative(),
    toolheads: z.array(toolhead).min(1).max(32),
    safety,
  })
  .strict();
const filament = z
  .object({
    filamentProjectId: nonEmptyId,
    provider: z.string().trim().min(1).max(256),
    product: z.string().trim().min(1).max(256),
    sku: z.string().trim().min(1).max(256),
    spoolId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
const profileIdentity = z
  .object({
    backendProfileId: nonEmptyId,
    orcaProfileName: z.string().trim().min(1).max(512),
    profileRevision: z.string().trim().min(1).max(256),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const binding = z
  .object({
    printer: z
      .object({
        backendProfileId: nonEmptyId,
        backendPrinterId: nonEmptyId,
        printerConfigurationId: nonEmptyId,
        printerConfigurationRevision: z.number().int().nonnegative(),
      })
      .strict(),
    snapshot,
    selectedToolId: nonEmptyId,
    selectedToolheadId: nonEmptyId,
    selectedNozzleId: nonEmptyId,
    // Optional only so workspaces persisted before exact-triple binding remain
    // loadable and editable offline. New creation and online sync require it.
    profileIdentities: z
      .object({
        machine: profileIdentity,
        process: profileIdentity,
        filament: profileIdentity,
      })
      .strict()
      .optional(),
    filament,
  })
  .strict();

const observationBase = {
  observationId: nonEmptyId,
  attemptId: nonEmptyId,
  observedAt: timestamp,
  notes: z.string().max(16_384),
};
const observation = z.discriminatedUnion('stageId', [
  z
    .object({
      ...observationBase,
      stageId: z.literal('temperature'),
      temperatureC: z.number().finite(),
      quality: z.number().finite(),
    })
    .strict(),
  z
    .object({
      ...observationBase,
      stageId: z.literal('flowPass1'),
      adjustmentPercent: z.number().finite(),
      quality: z.number().finite(),
    })
    .strict(),
  z
    .object({
      ...observationBase,
      stageId: z.literal('flowPass2'),
      adjustmentPercent: z.number().finite(),
      quality: z.number().finite(),
    })
    .strict(),
  z
    .object({
      ...observationBase,
      stageId: z.literal('pressureAdvance'),
      pressureAdvance: z.number().finite(),
      quality: z.number().finite(),
    })
    .strict(),
  z
    .object({
      ...observationBase,
      stageId: z.literal('flowVerification'),
      passed: z.boolean(),
      defectCount: z.number().int(),
    })
    .strict(),
  z
    .object({
      ...observationBase,
      stageId: z.literal('finalVerification'),
      passed: z.boolean(),
      defectCount: z.number().int(),
    })
    .strict(),
  z
    .object({
      ...observationBase,
      stageId: z.literal('retraction'),
      retractionLengthMm: z.number().finite(),
      quality: z.number().finite(),
    })
    .strict(),
  z
    .object({
      ...observationBase,
      stageId: z.literal('maximumVolumetricSpeed'),
      stableVolumetricRateMm3S: z.number().finite(),
      quality: z.number().finite(),
    })
    .strict(),
  z
    .object({
      ...observationBase,
      stageId: z.literal('shrinkage'),
      nominalXmm: z.number().finite(),
      nominalYmm: z.number().finite(),
      nominalZmm: z.number().finite(),
      measuredXmm: z.number().finite(),
      measuredYmm: z.number().finite(),
      measuredZmm: z.number().finite(),
    })
    .strict(),
]);

const recommendation = z
  .object({
    summary: z.string().min(1).max(16_384),
    rationale: z.string().min(1).max(16_384),
    values: z
      .array(
        z
          .object({
            key: nonEmptyId,
            value: z.union([z.number().finite(), z.boolean()]),
            unit,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const scope = z
  .object({
    backendProfileId: nonEmptyId,
    backendPrinterId: nonEmptyId,
    printerConfigurationId: nonEmptyId,
    printerConfigurationRevision: z.number().int().nonnegative(),
    snapshotId: nonEmptyId,
    snapshotRevision: z.number().int().nonnegative(),
    toolId: nonEmptyId,
    toolheadId: nonEmptyId,
    nozzleId: nonEmptyId,
    filamentProjectId: nonEmptyId,
    filamentProvider: z.string().min(1).max(256),
    filamentProduct: z.string().min(1).max(256),
    filamentSku: z.string().min(1).max(256),
    spoolId: z.string().min(1).max(256).optional(),
  })
  .strict();
const attempt = z
  .object({
    attemptId: nonEmptyId,
    stageId,
    method,
    scope,
    ordinal: z.number().int().positive(),
    status: z.enum(['inProgress', 'completed', 'abandoned']),
    startedAt: timestamp,
    completedAt: timestamp.optional(),
    observations: z.array(observation).max(2_000),
    selectedObservationId: nonEmptyId.optional(),
    confidence: confidence.optional(),
    recommendation: recommendation.optional(),
    diagnostics: z.array(diagnostic).max(2_000),
  })
  .strict();
const progress = z
  .object({
    stageId,
    status: z.enum([
      'notStarted',
      'inProgress',
      'completed',
      'skipped',
      'needsRetest',
    ]),
    attemptIds: z.array(nonEmptyId).max(1_000),
    selectedAttemptId: nonEmptyId.optional(),
    skip: z
      .object({
        skipId: nonEmptyId,
        reason: z.string().trim().min(1).max(16_384),
        skippedAt: timestamp,
      })
      .strict()
      .optional(),
    retestReason: z.string().min(1).max(16_384).optional(),
  })
  .strict();
const stages = z
  .object({
    temperature: progress,
    flowPass1: progress,
    flowPass2: progress,
    pressureAdvance: progress,
    flowVerification: progress,
    retraction: progress,
    maximumVolumetricSpeed: progress,
    shrinkage: progress,
    finalVerification: progress,
  })
  .strict()
  .superRefine((value, context) => {
    for (const id of CALIBRATION_STAGE_IDS) {
      if (value[id].stageId !== id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [id, 'stageId'],
          message: `Stage key ${id} does not match its stage identity.`,
        });
      }
    }
  });

const eventBase = { eventId: nonEmptyId, timestamp };
const event = z.discriminatedUnion('type', [
  z
    .object({
      ...eventBase,
      type: z.literal('setMode'),
      mode: z.enum(['coach', 'expert']),
    })
    .strict(),
  z.object({ ...eventBase, type: z.literal('navigate'), stageId }).strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('beginAttempt'),
      attemptId: nonEmptyId,
      stageId,
      method,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('recordObservation'),
      attemptId: nonEmptyId,
      observation,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('selectObservation'),
      attemptId: nonEmptyId,
      observationId: nonEmptyId,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('completeAttempt'),
      attemptId: nonEmptyId,
      confidence,
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('skipStage'),
      stageId,
      skipId: nonEmptyId,
      reason: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('redoStage'),
      stageId,
      attemptId: nonEmptyId,
      method,
      reason: z.string().min(1).max(16_384),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal('rebaseSnapshot'),
      binding,
      retestStages: z.array(stageId).min(1).max(9),
      reason: z.string().min(1).max(16_384),
    })
    .strict(),
]);

const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: nonEmptyId,
    createdAt: timestamp,
    mode: z.enum(['coach', 'expert']),
    baseline,
    binding,
    snapshotHistory: z.array(snapshot).min(1).max(1_000),
    currentStageId: stageId,
    stages,
    attempts: z.array(attempt).max(2_000),
    history: z.array(event).max(10_000),
    diagnostics: z.array(diagnostic).max(2_000),
  })
  .strict()
  .superRefine((state, context) => {
    const attemptIds = new Set(state.attempts.map((item) => item.attemptId));
    if (attemptIds.size !== state.attempts.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attempts'],
        message: 'Attempt identities must be unique.',
      });
    }
    const eventIds = new Set(state.history.map((item) => item.eventId));
    if (eventIds.size !== state.history.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['history'],
        message: 'Event identities must be unique.',
      });
    }
    for (const id of CALIBRATION_STAGE_IDS) {
      for (const attemptId of state.stages[id].attemptIds) {
        if (!attemptIds.has(attemptId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['stages', id, 'attemptIds'],
            message: 'Stage references an unknown attempt.',
          });
        }
      }
    }
    const observationIds = new Set<string>();
    const latestSnapshot = state.snapshotHistory.at(-1);
    if (
      latestSnapshot?.snapshotId !== state.binding.snapshot.snapshotId ||
      latestSnapshot.snapshotRevision !==
        state.binding.snapshot.snapshotRevision
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshotHistory'],
        message:
          'The current binding must match the latest snapshot history entry.',
      });
    }
    const snapshotKeys = new Set<string>();
    for (const [index, item] of state.snapshotHistory.entries()) {
      const key = `${item.snapshotId}:${item.snapshotRevision}`;
      if (snapshotKeys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['snapshotHistory', index],
          message: 'Snapshot history entries must be unique.',
        });
      }
      snapshotKeys.add(key);
      const toolIds = new Set(item.toolheads.map((tool) => tool.toolId));
      if (toolIds.size !== item.toolheads.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['snapshotHistory', index, 'toolheads'],
          message: 'Tool identities must be unique within a snapshot.',
        });
      }
    }

    for (const [index, item] of state.attempts.entries()) {
      const progress = state.stages[item.stageId];
      if (!progress.attemptIds.includes(item.attemptId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attempts', index, 'attemptId'],
          message: 'Attempt is not referenced by its stage.',
        });
      }
      for (const [
        observationIndex,
        itemObservation,
      ] of item.observations.entries()) {
        if (
          itemObservation.attemptId !== item.attemptId ||
          itemObservation.stageId !== item.stageId
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['attempts', index, 'observations', observationIndex],
            message: 'Observation identity must match its attempt and stage.',
          });
        }
        if (observationIds.has(itemObservation.observationId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              'attempts',
              index,
              'observations',
              observationIndex,
              'observationId',
            ],
            message: 'Observation identities must be unique.',
          });
        }
        observationIds.add(itemObservation.observationId);
      }
      if (
        item.selectedObservationId !== undefined &&
        !item.observations.some(
          (itemObservation) =>
            itemObservation.observationId === item.selectedObservationId,
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attempts', index, 'selectedObservationId'],
          message: 'Selected observation is not part of this attempt.',
        });
      }
      if (
        item.status === 'completed' &&
        (item.completedAt === undefined ||
          item.confidence === undefined ||
          item.recommendation === undefined ||
          item.selectedObservationId === undefined)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attempts', index, 'status'],
          message:
            'A completed attempt must retain its result, confidence, recommendation, and completion time.',
        });
      }
      const historicalSnapshot = state.snapshotHistory.find(
        (itemSnapshot) =>
          itemSnapshot.snapshotId === item.scope.snapshotId &&
          itemSnapshot.snapshotRevision === item.scope.snapshotRevision,
      );
      const scopedTool = historicalSnapshot?.toolheads.find(
        (tool) => tool.toolId === item.scope.toolId,
      );
      if (
        historicalSnapshot === undefined ||
        scopedTool?.toolheadId !== item.scope.toolheadId ||
        scopedTool.nozzle.nozzleId !== item.scope.nozzleId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attempts', index, 'scope'],
          message:
            'Attempt scope does not match an immutable snapshot tool identity.',
        });
      }
      if (
        item.scope.backendProfileId !==
          state.binding.printer.backendProfileId ||
        item.scope.backendPrinterId !==
          state.binding.printer.backendPrinterId ||
        item.scope.printerConfigurationId !==
          state.binding.printer.printerConfigurationId ||
        item.scope.filamentProjectId !==
          state.binding.filament.filamentProjectId ||
        item.scope.filamentProvider !== state.binding.filament.provider ||
        item.scope.filamentProduct !== state.binding.filament.product ||
        item.scope.filamentSku !== state.binding.filament.sku ||
        item.scope.spoolId !== state.binding.filament.spoolId
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attempts', index, 'scope'],
          message:
            'Attempt scope changes project printer or material identity.',
        });
      }
    }

    for (const id of CALIBRATION_STAGE_IDS) {
      const progress = state.stages[id];
      const stageAttemptIds = new Set(progress.attemptIds);
      if (stageAttemptIds.size !== progress.attemptIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', id, 'attemptIds'],
          message: 'A stage cannot reference the same attempt more than once.',
        });
      }
      for (const attemptId of progress.attemptIds) {
        const referenced = state.attempts.find(
          (item) => item.attemptId === attemptId,
        );
        if (referenced !== undefined && referenced.stageId !== id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['stages', id, 'attemptIds'],
            message:
              'A stage references an attempt belonging to another stage.',
          });
        }
      }
      if (
        progress.selectedAttemptId !== undefined &&
        !progress.attemptIds.includes(progress.selectedAttemptId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', id, 'selectedAttemptId'],
          message: 'Selected attempt is not part of this stage.',
        });
      }
      const activeCount = state.attempts.filter(
        (item) => item.stageId === id && item.status === 'inProgress',
      ).length;
      if (
        (progress.status === 'inProgress' && activeCount !== 1) ||
        (progress.status !== 'inProgress' && activeCount !== 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', id, 'status'],
          message: 'Stage status does not match its in-progress attempts.',
        });
      }
      if (
        progress.status === 'completed' &&
        progress.selectedAttemptId === undefined
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', id, 'selectedAttemptId'],
          message: 'A completed stage must retain its selected attempt.',
        });
      }
    }

    const selectedTool = state.binding.snapshot.toolheads.find(
      (item) => item.toolId === state.binding.selectedToolId,
    );
    if (
      selectedTool?.toolheadId !== state.binding.selectedToolheadId ||
      selectedTool.nozzle.nozzleId !== state.binding.selectedNozzleId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['binding', 'selectedToolId'],
        message:
          'Selected physical tool identity is not present in the snapshot.',
      });
    }
  });

export type CalibrationStateParseResult =
  | { readonly ok: true; readonly state: CalibrationState }
  | { readonly ok: false; readonly message: string };

export function parseCalibrationState(
  value: unknown,
): CalibrationStateParseResult {
  const result = stateSchema.safeParse(value);
  if (result.success) {
    // Zod has fully validated the value. Its inferred optional properties add
    // `undefined`, while the domain uses exact optional-property semantics.
    return { ok: true, state: result.data };
  }
  const first = result.error.issues[0];
  const location = first?.path.length ? first.path.join('.') : 'domainState';
  return {
    ok: false,
    message: `Saved calibration data is malformed at ${location}: ${first?.message ?? 'validation failed'}`,
  };
}

export function parseWorkspaceRecordDomain(
  record: CalibrationWorkspaceStateRecord,
): CalibrationStateParseResult {
  const parsed = parseCalibrationState(record.workspaceState.domainState);
  if (!parsed.ok) return parsed;
  const state = parsed.state;
  if (
    state.projectId !== record.projectId ||
    state.binding.printer.backendProfileId !== record.profileId ||
    state.binding.printer.backendPrinterId !== record.printerId
  ) {
    return {
      ok: false,
      message:
        'Saved calibration identity does not match its profile, project, or printer record. Recover or remove it from PrintFarmer before continuing.',
    };
  }
  const payload = record.workspaceState;
  const completedStepCount = CALIBRATION_STAGE_IDS.filter(
    (id) => state.stages[id].status === 'completed',
  ).length;
  if (
    payload.metadata.displayName !== record.displayName ||
    payload.metadata.description !== (record.description ?? '') ||
    state.createdAt !== record.createdAt ||
    record.totalStepCount !== CALIBRATION_STAGE_IDS.length ||
    record.completedStepCount !== completedStepCount
  ) {
    return {
      ok: false,
      message:
        'Saved calibration summary does not match its exact workspace payload. Recover or synchronize it before continuing.',
    };
  }
  const photoIds = new Set<string>();
  for (const photo of payload.photos) {
    const photoAttempt = state.attempts.find(
      (item) => item.attemptId === photo.attemptId,
    );
    if (
      photoIds.has(photo.photoId) ||
      photoAttempt === undefined ||
      photoAttempt.stageId !== photo.stageId
    ) {
      return {
        ok: false,
        message:
          'Saved calibration photo metadata does not match a unique attempt and stage.',
      };
    }
    photoIds.add(photo.photoId);
  }
  return parsed;
}

export function isCurrentPhysicalMatch(
  state: CalibrationState,
  confirmation: PhysicalMatchConfirmation | null,
): confirmation is PhysicalMatchConfirmation {
  if (confirmation === null) return false;
  const tool = state.binding.snapshot.toolheads.find(
    (item) => item.toolId === state.binding.selectedToolId,
  );
  return (
    tool !== undefined &&
    confirmation.snapshotId === state.binding.snapshot.snapshotId &&
    confirmation.toolId === state.binding.selectedToolId &&
    confirmation.toolheadId === state.binding.selectedToolheadId &&
    confirmation.nozzleId === state.binding.selectedNozzleId &&
    confirmation.nozzleDiameterMm === tool.nozzle.diameterMm
  );
}
