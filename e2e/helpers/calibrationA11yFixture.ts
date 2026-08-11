/**
 * Deterministic calibration fixtures for the packaged-bundle accessibility spec.
 *
 * The packaged binary ships with `RunAsNode: false` (see `forge.config.ts`), so
 * Playwright's Electron launcher cannot drive it and the CDP attach used by
 * `helpers/packagedApp.ts` exposes no main process. Without `ipcMain` there is
 * no way to make a recovery state genuinely enter, and a recovery assertion
 * that cannot enter its state is an assertion that cannot fail. These helpers
 * therefore drive the production `.vite` bundles — the same renderer bundle
 * that is packaged — with fixture handlers installed in the main process, the
 * pattern already proven in `e2e/calibration.spec.ts`.
 *
 * Every scenario is applied to a single long-lived Electron app by replacing
 * the handlers and reloading the renderer, so the workspace store remounts and
 * observes the scenario from startup.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Result } from 'axe-core';
import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CalibrationGetQueueStateResponse, IpcSchemas } from '@shared/ipc';
import type { z } from 'zod';

/**
 * Channels this fixture is allowed to stub, and the response each one owes.
 *
 * Derived from the live `ipcSchemas` registry rather than restated here, so a
 * channel whose contract changes cannot leave a stub behind that still
 * compiles. The previous signature took `channel: string` and returned
 * `unknown`, which meant the compiler checked no response shape at all: a stub
 * could return `{}` for every channel and typecheck stayed green while every
 * surface under test rendered its error state. That is the failure this
 * annotation exists to make impossible, and it is not hypothetical -- it is
 * how a fixture regression reached trunk.
 */
type StubbedChannel = keyof IpcSchemas;
type StubResponse<C extends StubbedChannel> = z.infer<
  IpcSchemas[C]['response']
>;

/**
 * The workspace-state record the fixture hands to the renderer.
 *
 * Derived from the list channel's response rather than restated, so the record
 * builder below cannot drift from the contract the renderer actually consumes.
 */
type CalibrationWorkspaceRecord =
  StubResponse<'calibration:listWorkspaceStates'>['states'][number];

/**
 * Sub-shapes of the record, each derived from the contract above rather than
 * restated. Every one of these was `Record<string, unknown>` before, which is
 * assignable to nothing and checked against nothing -- a fixture could omit a
 * required field and the only thing that noticed was the surface failing to
 * render, at which point the axe scan reports zero violations against an empty
 * container.
 */
type WorkspaceState = CalibrationWorkspaceRecord['workspaceState'];
type DomainState = WorkspaceState['domainState'];
type SnapshotFixture = DomainState['snapshotHistory'][number];
type WorkspaceStages = DomainState['stages'];
type WorkspaceAttempt = DomainState['attempts'][number];
type WorkspaceHistoryEvent = DomainState['history'][number];
type WorkflowDrafts = WorkspaceState['workflowDrafts'];
type CalibrationStage = WorkspaceStages[keyof WorkspaceStages];
type WorkflowDraft = WorkflowDrafts[keyof WorkflowDrafts];

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const requiredArtifacts = [
  path.join(repoRoot, '.vite', 'build', 'main.js'),
  path.join(repoRoot, '.vite', 'build', 'preload.js'),
  path.join(repoRoot, '.vite', 'renderer', 'main_window', 'index.html'),
];

export const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
];
const MATERIAL_IMPACTS = new Set(['moderate', 'serious', 'critical']);

export const CAL = {
  now: '2026-07-29T10:00:00.000Z',
  profileId: 'f1111111-f111-4111-8111-111111111111',
  projectId: 'f2222222-f222-4222-8222-222222222222',
  printerId: 'f3333333-f333-4333-8333-333333333333',
  attemptId: 'f4444444-f444-4444-8444-444444444444',
  verificationAttemptId: 'f9999999-f999-4999-8999-999999999999',
  verificationObservationId: 'fa999999-fa99-4a99-8a99-a99999999999',
  verificationEventId: 'fb999999-fb99-4b99-8b99-b99999999999',
  orchestrationId: 'f5555555-f555-4555-8555-555555555555',
  jobId: 'f6666666-f666-4666-8666-666666666666',
  filamentId: 'f7777777-f777-4777-8777-777777777777',
  gcodeId: 'f8888888-f888-4888-8888-888888888888',
  eventId: 'e1111111-e111-4111-8111-111111111111',
  orcaProfileId: 'orca-a11y-base',
  snapshotId: 'snapshot-a11y-7',
  configurationRevision: 7,
  toolId: 'tool-a11y-a',
  toolheadId: 'head-a11y-a',
  nozzleId: 'nozzle-a11y-a',
  nozzleDiameterMm: 0.4,
  contentHash: 'a'.repeat(64),
  displayName: 'A11y PLA Calibration',
} as const;

export type AvailabilityScenario =
  'ok' | 'missingScopes' | 'missingCapabilityFlags' | 'operatorDisabled';

export type OrchestrationScenario = 'succeeded' | 'failed';

/**
 * `unknownOutcomeRefetchFailure` reproduces the only state in which the panel
 * renders a retry affordance at all (issue #224/#225): the first
 * `getQueueState` succeeds with an unresolved outcome, a poll then reports a
 * gap, and the gap-triggered refetch fails. `CalibrationQueueDispatchPanel`
 * sets `fetchError` solely from `refetchJobState`'s failure branches, and a
 * *poll* failure is swallowed — so failing the poll reaches nothing.
 */
export type QueueScenario =
  'none' | 'assigned' | 'unknownOutcome' | 'unknownOutcomeRefetchFailure';

export interface CalibrationScenario {
  /** Availability request rejects, which is the store's offline signal. */
  readonly offline?: boolean;
  readonly availability?: AvailabilityScenario;
  readonly staleContext?: boolean;
  readonly hasConflicts?: boolean;
  /** Seeds an in-progress temperature attempt so generation is reachable. */
  readonly withAttempt?: boolean;
  /**
   * Seeds a clean completed final verification, which is what unblocks the
   * OrcaSlicer profile generate / install / restore actions.
   */
  readonly verified?: boolean;
  readonly orchestration?: OrchestrationScenario;
  readonly queue?: QueueScenario;
  /** Transactional install fails, so the operator must roll back. */
  readonly installFails?: boolean;
}

interface FixtureArgs {
  readonly scenario: CalibrationScenario;
  readonly record: CalibrationWorkspaceRecord;
  readonly ids: typeof CAL;
  readonly expiry: string;
}

function emptyStage(stageId: CalibrationStage['stageId']): CalibrationStage {
  return { stageId, status: 'notStarted', attemptIds: [] };
}

function emptyObservation(): WorkflowDraft['observation'] {
  return {
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
  };
}

function emptyDraft(): WorkflowDraft {
  return {
    method: null,
    observation: emptyObservation(),
    confidence: null,
    reason: '',
    photoAttemptId: null,
    photoCaption: '',
    photoOrder: 1,
  };
}

function snapshotFixture(): SnapshotFixture {
  return {
    snapshotId: CAL.snapshotId,
    snapshotRevision: CAL.configurationRevision,
    capturedAt: CAL.now,
    configurationRevision: CAL.configurationRevision,
    toolheads: [
      {
        toolId: CAL.toolId,
        toolheadId: CAL.toolheadId,
        nozzle: {
          nozzleId: CAL.nozzleId,
          diameterMm: CAL.nozzleDiameterMm,
          material: 'brass',
        },
        extruderType: 'directDrive',
      },
    ],
    safety: {
      buildVolumeMm: { x: 250, y: 250, z: 250 },
      maximumNozzleTemperatureC: 300,
      maximumBedTemperatureC: 110,
      maximumVolumetricRateMm3S: 35,
      emergencyStopAvailable: true,
      thermalProtectionConfirmed: true,
      ventilationAssessed: true,
    },
  };
}

/**
 * Builds the workspace record the renderer hydrates. `withAttempt` seeds an
 * in-progress temperature attempt, which is what makes the generation and
 * queue handoff controls reachable at all.
 */
export function buildCalibrationRecord(
  scenario: CalibrationScenario,
): CalibrationWorkspaceRecord {
  const snapshot = snapshotFixture();
  const binding = {
    printer: {
      backendProfileId: CAL.profileId,
      backendPrinterId: CAL.printerId,
      printerConfigurationId: 'config-a11y-1',
      printerConfigurationRevision: CAL.configurationRevision,
    },
    snapshot,
    selectedToolId: CAL.toolId,
    selectedToolheadId: CAL.toolheadId,
    selectedNozzleId: CAL.nozzleId,
    filament: {
      filamentProjectId: CAL.filamentId,
      provider: 'A11y Materials Co',
      product: 'A11y PLA Pro',
      sku: 'A11Y-PLA',
      spoolId: 'spool-a11y-1',
    },
  };
  const withAttempt = scenario.withAttempt === true;
  const verified = scenario.verified === true;
  const attemptScope = {
    backendProfileId: CAL.profileId,
    backendPrinterId: CAL.printerId,
    printerConfigurationId: 'config-a11y-1',
    printerConfigurationRevision: CAL.configurationRevision,
    snapshotId: CAL.snapshotId,
    snapshotRevision: CAL.configurationRevision,
    toolId: CAL.toolId,
    toolheadId: CAL.toolheadId,
    nozzleId: CAL.nozzleId,
    filamentProjectId: CAL.filamentId,
    filamentProvider: 'A11y Materials Co',
    filamentProduct: 'A11y PLA Pro',
    filamentSku: 'A11Y-PLA',
    spoolId: 'spool-a11y-1',
  };
  const stages: WorkspaceStages = {
    temperature: withAttempt
      ? {
          stageId: 'temperature',
          status: 'inProgress',
          attemptIds: [CAL.attemptId],
        }
      : emptyStage('temperature'),
    flowPass1: emptyStage('flowPass1'),
    flowPass2: emptyStage('flowPass2'),
    pressureAdvance: emptyStage('pressureAdvance'),
    flowVerification: emptyStage('flowVerification'),
    retraction: emptyStage('retraction'),
    maximumVolumetricSpeed: emptyStage('maximumVolumetricSpeed'),
    shrinkage: emptyStage('shrinkage'),
    finalVerification: verified
      ? {
          stageId: 'finalVerification',
          status: 'completed',
          attemptIds: [CAL.verificationAttemptId],
          selectedAttemptId: CAL.verificationAttemptId,
        }
      : emptyStage('finalVerification'),
  };
  const attempts: WorkspaceAttempt[] = [];
  if (withAttempt) {
    attempts.push({
      attemptId: CAL.attemptId,
      stageId: 'temperature',
      method: 'temperatureTower',
      scope: attemptScope,
      ordinal: 1,
      status: 'inProgress',
      startedAt: CAL.now,
      observations: [],
      diagnostics: [],
    });
  }
  if (verified) {
    attempts.push({
      attemptId: CAL.verificationAttemptId,
      stageId: 'finalVerification',
      method: 'verificationPrint',
      scope: attemptScope,
      ordinal: 1,
      status: 'completed',
      startedAt: CAL.now,
      completedAt: CAL.now,
      selectedObservationId: CAL.verificationObservationId,
      confidence: 'high',
      recommendation: {
        summary: 'Final verification passed with no defects.',
        rationale:
          'The verification coupon printed clean, so the calibrated values are safe to apply.',
        values: [],
      },
      observations: [
        {
          observationId: CAL.verificationObservationId,
          attemptId: CAL.verificationAttemptId,
          observedAt: CAL.now,
          notes: 'Verification coupon printed clean.',
          stageId: 'finalVerification',
          passed: true,
          defectCount: 0,
        },
      ],
      diagnostics: [],
    });
  }
  const history: WorkspaceHistoryEvent[] = [];
  if (withAttempt) {
    history.push({
      eventId: CAL.eventId,
      timestamp: CAL.now,
      type: 'beginAttempt',
      attemptId: CAL.attemptId,
      stageId: 'temperature',
      method: 'temperatureTower',
    });
  }
  if (verified) {
    history.push({
      eventId: CAL.verificationEventId,
      timestamp: CAL.now,
      type: 'beginAttempt',
      attemptId: CAL.verificationAttemptId,
      stageId: 'finalVerification',
      method: 'verificationPrint',
    });
  }

  const workflowDrafts: WorkflowDrafts = {
    temperature: { ...emptyDraft(), method: 'temperatureTower' },
    flowPass1: emptyDraft(),
    flowPass2: emptyDraft(),
    pressureAdvance: emptyDraft(),
    flowVerification: emptyDraft(),
    retraction: emptyDraft(),
    maximumVolumetricSpeed: emptyDraft(),
    shrinkage: emptyDraft(),
    finalVerification: emptyDraft(),
  };

  return {
    profileId: CAL.profileId,
    projectId: CAL.projectId,
    displayName: CAL.displayName,
    description: 'Accessibility fixture workspace',
    printerId: CAL.printerId,
    status: 'inProgress',
    completedStepCount: verified ? 1 : 0,
    totalStepCount: 9,
    isSynced: true,
    isPrinterContextFresh: scenario.staleContext !== true,
    hasConflicts: scenario.hasConflicts === true,
    remoteProjectId: null,
    baseRevision: 1,
    createdAt: CAL.now,
    updatedAt: CAL.now,
    workspaceState: {
      schemaVersion: 1,
      domainState: {
        schemaVersion: 1,
        projectId: CAL.projectId,
        createdAt: CAL.now,
        mode: 'expert',
        baseline: {
          nozzleTemperatureC: 220,
          flowRatio: 1.0,
          pressureAdvance: 0.03,
          retractionLengthMm: 0.6,
          maximumVolumetricRateMm3S: 12,
          shrinkageCompensationXPercent: 0,
          shrinkageCompensationYPercent: 0,
          shrinkageCompensationZPercent: 0,
        },
        binding,
        snapshotHistory: [snapshot],
        currentStageId: 'temperature',
        stages,
        attempts,
        history,
        diagnostics: [],
      },
      metadata: {
        displayName: CAL.displayName,
        description: 'Accessibility fixture workspace',
      },
      stepDrafts: {},
      workflowDrafts,
      photos: [],
      physicalMatch: {
        snapshotId: CAL.snapshotId,
        toolId: CAL.toolId,
        toolheadId: CAL.toolheadId,
        nozzleId: CAL.nozzleId,
        nozzleDiameterMm: CAL.nozzleDiameterMm,
        confirmedAt: CAL.now,
      },
      selectedBaseProfile: {
        orcaProfileId: CAL.orcaProfileId,
        displayName: 'A11y Base Profile',
        source: 'printFarmer',
        upstreamVerified: true,
        printerId: CAL.printerId,
        configurationRevision: CAL.configurationRevision,
        snapshotId: CAL.snapshotId,
        toolId: CAL.toolId,
        toolheadId: CAL.toolheadId,
        nozzleId: CAL.nozzleId,
        nozzleDiameterMm: CAL.nozzleDiameterMm,
        profileRevision: 'rev-a11y-7',
        contentHash: CAL.contentHash,
      },
      selectedBaseProfileId: CAL.orcaProfileId,
      autosaveRevision: 4,
    },
  };
}

export async function launchCalibrationApp(): Promise<{
  app: ElectronApplication;
  page: Page;
  stateRoot: string;
}> {
  for (const artifact of requiredArtifacts) {
    if (!existsSync(artifact)) {
      throw new Error(
        `Missing build artifact ${artifact}.\n` +
          'Run `npm run test:e2e` (which builds first) before the accessibility suite.',
      );
    }
  }
  // Kept out of the repository tree: a locked SQLite handle on Windows can
  // defeat cleanup, and a stray state directory must never look like a change.
  const stateRoot = mkdtempSync(path.join(tmpdir(), 'pf-cal-a11y-'));
  const userDataPath = path.join(stateRoot, 'user-data');
  mkdirSync(userDataPath, { recursive: true });
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      PRINTFARMER_CATALOG_DB: path.join(stateRoot, 'catalog.sqlite3'),
      PRINTFARMER_USER_DATA_PATH: userDataPath,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, stateRoot };
}

/**
 * Installs the fixture handlers for one scenario and reloads the renderer so
 * the calibration store observes the scenario from its first request.
 */
export async function applyCalibrationScenario(
  app: ElectronApplication,
  page: Page,
  scenario: CalibrationScenario,
): Promise<void> {
  const args: FixtureArgs = {
    scenario,
    record: buildCalibrationRecord(scenario),
    ids: CAL,
    expiry: new Date(Date.now() + 600_000).toISOString(),
  };

  await app.evaluate(({ ipcMain }, { scenario, record, ids, expiry }) => {
    const handle = <C extends StubbedChannel>(
      channel: C,
      handler: (...a: never[]) => StubResponse<C> | Promise<StubResponse<C>>,
    ) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler as never);
    };

    handle('serverProfiles:list', () => ({
      profiles: [
        {
          id: ids.profileId,
          displayName: 'A11y Test Server',
          baseUrl: 'http://localhost:8000',
          authMode: 'apiKey',
          version: {
            service: 'PrintFarmer',
            version: '2.0',
            commit: null,
            environment: 'test',
            runtime: 'node',
            timestamp: ids.now,
          },
          capabilities: {
            architecture: 'test',
            slicingEnabled: true,
            modelFilesEnabled: true,
            thumbnailGenerationEnabled: false,
            gcodeUploadEnabled: true,
            clientThumbnailUploadEnabled: false,
            idempotentModelUploadEnabled: true,
            modelThumbnailReplacementEnabled: false,
            platformNote: null,
          },
          availability: {
            modelUpload: { mode: 'modern', available: true, reason: null },
            librarySync: { mode: 'modern', available: true, reason: null },
            clientThumbnailUpload: {
              mode: 'unavailable',
              available: false,
              reason: null,
            },
            serverThumbnailFallback: {
              mode: 'unavailable',
              available: false,
              reason: 'Not required',
            },
          },
          status: 'connected',
          lastCheckedAt: ids.now,
          warnings: [],
        },
      ],
      selectedProfileId: ids.profileId,
    }));

    handle('catalog:listModels', () => []);

    const availabilityKind = scenario.availability ?? 'ok';
    handle('calibration:getAvailability', () => {
      if (scenario.offline === true) {
        // The store treats a rejected availability request as offline.
        throw new Error('PrintFarmer is unreachable from this workstation.');
      }
      const available = availabilityKind === 'ok';
      return {
        available,
        unavailableReason: available ? null : availabilityKind,
        unavailableDetail: null,
        negotiatedApiVersion: '2',
        negotiatedSchemaVersion: '2.0',
        capabilityFlags: {
          calibrationApiEnabled: true,
          calibrationChangeFeedEnabled: true,
          calibrationOfflineDraftEnabled: true,
          calibrationPhotoUploadEnabled: true,
          calibrationGenerationEnabled:
            availabilityKind !== 'missingCapabilityFlags',
        },
        grantedScopes:
          availabilityKind === 'missingScopes'
            ? ['CalibrationRead']
            : ['CalibrationRead', 'CalibrationWrite'],
        offlineEditingEnabled: true,
      };
    });

    handle('calibration:listWorkspaceStates', () => ({
      states: [record],
      unhydratedProjects: [],
    }));
    handle('calibration:getWorkspaceState', () => record);
    handle('calibration:saveWorkspaceState', () => ({
      state: record,
      queued: true,
    }));

    handle('calibration:getPrinterContext', () => ({
      printerId: ids.printerId,
      displayName: 'A11y Fixture Printer',
      printerModel: null,
      firmware: {
        firmware: 'Klipper',
        gcodeDialect: 'Klipper',
        firmwareVersion: '0.12',
        klipperConfigHash: null,
      },
      orcaProfileId: ids.orcaProfileId,
      orcaProfileDisplayName: 'A11y Base Profile',
      bedWidthMm: 250,
      bedDepthMm: 250,
      nozzleDiameterMm: ids.nozzleDiameterMm,
      snapshotAt: ids.now,
      isCurrent: scenario.staleContext !== true,
      configurationId: 'config-a11y-1',
      configurationRevision: ids.configurationRevision,
      snapshotId: ids.snapshotId,
      snapshotRevision: ids.configurationRevision,
      slicerIdentity: 'OrcaSlicer',
      slicerDistribution: 'upstream',
      profileRevision: 'rev-a11y-7',
      contentHash: ids.contentHash,
      toolheads: [
        {
          toolId: ids.toolId,
          toolheadId: ids.toolheadId,
          extruderType: 'directDrive',
          nozzle: {
            id: ids.nozzleId,
            diameterMm: ids.nozzleDiameterMm,
            material: 'brass',
          },
        },
      ],
      safety: {
        buildVolumeMm: { x: 250, y: 250, z: 250 },
        maximumNozzleTemperatureC: 300,
        maximumBedTemperatureC: 110,
        maximumVolumetricRateMm3S: 35,
        emergencyStopAvailable: true,
        thermalProtectionConfirmed: true,
        ventilationAssessed: true,
      },
      permissions: {
        readPrinter: true,
        writeCalibration: scenario.availability !== 'missingScopes',
        generateCalibration: scenario.availability !== 'missingScopes',
        startPrint: scenario.availability !== 'missingScopes',
      },
    }));

    handle('calibration:listPrinters', () => ({
      printers: [
        {
          printerId: ids.printerId,
          displayName: 'A11y Fixture Printer',
          printerModel: 'A11y Reference Klipper',
          firmwareCompatible: true,
          orcaProfileId: ids.orcaProfileId,
          isOnline: scenario.offline !== true,
          updatedAt: ids.now,
          rejectionReasonCodes: [],
          missingInputs: [],
          eligibility: {
            firmwareFamily: 'Klipper',
            gcodeDialect: 'Klipper',
            slicerFamily: 'OrcaSlicer',
            slicerDistribution: 'upstream',
            slicerIdentity: 'OrcaSlicer',
            hardwareContextComplete: true,
            safetyContextComplete: true,
            permissionsComplete: true,
            reasons: [],
          },
        },
      ],
      printersTruncated: false,
      printersUnreadable: 0,
      fetchedAt: ids.now,
    }));

    handle('calibration:listOrcaProfiles', () => ({
      profiles: [
        {
          orcaProfileId: ids.orcaProfileId,
          displayName: 'A11y Base Profile',
          vendor: null,
          material: null,
          source: 'printFarmer',
          upstreamVerified: true,
          printerId: ids.printerId,
          configurationRevision: ids.configurationRevision,
          snapshotId: ids.snapshotId,
          toolId: ids.toolId,
          toolheadId: ids.toolheadId,
          nozzleId: ids.nozzleId,
          nozzleDiameterMm: ids.nozzleDiameterMm,
          profileRevision: 'rev-a11y-7',
          contentHash: ids.contentHash,
          exportable: true,
        },
      ],
      discovery: {
        kind: 'ok',
        message: 'Server profile discovery completed.',
        serverCode: null,
      },
      localProfiles: [],
      localDiscovery: {
        kind: 'ok',
        message: 'Local OrcaSlicer profile scan completed.',
      },
    }));

    handle('calibration:startGeneration', () => ({
      status: 'submitted',
      orchestrationId: ids.orchestrationId,
    }));

    const failed = scenario.orchestration === 'failed';
    handle('calibration:getOrchestrationStatus', () => ({
      status: 'ok',
      orchestration: {
        id: ids.orchestrationId,
        projectId: ids.projectId,
        attemptId: ids.attemptId,
        operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        status: failed ? 'Failed' : 'Succeeded',
        currentStep: failed ? 'SlicingFailed' : 'Completed',
        revision: 2,
        retryCount: failed ? 2 : 0,
        nextRetryAtUtc: null,
        stepStartedAtUtc: ids.now,
        lastErrorCode: failed ? 'SLICER_EXIT_NONZERO' : null,
        problems: failed
          ? [
              {
                code: 'SLICER_EXIT_NONZERO',
                field: null,
                message: 'The slicer exited before producing G-code.',
              },
            ]
          : [],
        model3DId: null,
        sliceJobId: null,
        workerId: null,
        sourceArtifactId: null,
        finalArtifactId: null,
        gcodeFileId: failed ? null : ids.gcodeId,
        specificationSha256: null,
        planManifestSha256: null,
        gcodeSha256: null,
        manifestSha256: null,
        generatorVersion: 'a11y-gen-1.0',
        slicerContainerDigest: null,
        slicerBinarySha256: null,
        statusRoute: `/api/calibration-orchestrations/${ids.orchestrationId}`,
        createdAtUtc: ids.now,
        updatedAtUtc: ids.now,
        completedAtUtc: failed ? ids.now : ids.now,
      },
    }));

    const queueKind = scenario.queue ?? 'none';
    const unresolvedOutcome =
      queueKind === 'unknownOutcome' ||
      queueKind === 'unknownOutcomeRefetchFailure';
    // The refetch-failure scenario must let the FIRST fetch through, or
    // `queueState` is never populated and the panel renders nothing to
    // co-render with. Gating on a call count races with any prefetch and with
    // the mount-time poll, so gate on the mechanism itself: fail only once a
    // gap has been served AND at least one fetch has succeeded. That is
    // exactly the reachable path (gap -> refetch -> failure) and is
    // order-independent.
    let okServed = 0;
    let gapServed = false;
    handle('calibration:getQueueState', () => {
      if (queueKind === 'none') {
        return {
          status: 'error',
          error: {
            code: 'jobNotFound',
            message: 'No queued job for this project.',
            retryable: false,
            retryAfterSeconds: null,
            reference: null,
          },
        } satisfies CalibrationGetQueueStateResponse;
      }
      if (
        queueKind === 'unknownOutcomeRefetchFailure' &&
        gapServed &&
        okServed > 0
      ) {
        return {
          status: 'error',
          error: {
            code: 'serverError',
            message: 'Network timeout',
            retryable: true,
            retryAfterSeconds: null,
            reference: null,
          },
        } satisfies CalibrationGetQueueStateResponse;
      }
      okServed += 1;
      return {
        status: 'ok',
        job: {
          jobId: ids.jobId,
          jobKind: 'FilamentCalibration',
          rowVersion: 'W/"a11y-etag"',
          dispatchStateRowVersion: 'W/"a11y-dispatch"',
          status: unresolvedOutcome ? 'Starting' : 'Assigned',
          dispatchAttemptOutcome: unresolvedOutcome ? 'Unknown' : null,
          bedClearState: 'None',
          gcodeFileId: ids.gcodeId,
          assignedPrinterId: ids.printerId,
          assignedPrinterName: 'A11y Fixture Printer',
          acknowledgementExpiresAt: expiry,
          calibrationProjectId: ids.projectId,
          calibrationAttemptId: ids.attemptId,
          pinnedPrinterConfigRevision: ids.configurationRevision,
          priority: 50,
          queuePosition: 1,
          updatedAt: ids.now,
        },
      } satisfies CalibrationGetQueueStateResponse;
    });

    handle('calibration:acknowledgeBedClear', () => ({
      status: 'ok',
      jobRowVersion: 'W/"a11y-etag-2"',
      dispatchStateRowVersion: 'W/"a11y-dispatch-2"',
    }));

    handle('calibration:startPrint', () => ({
      status: 'ok',
      jobId: ids.jobId,
      rowVersion: 'W/"a11y-etag"',
      dispatchStateRowVersion: 'W/"a11y-dispatch"',
      replayed: false,
    }));

    // A gap is the panel's only trigger for a refetch after the initial fetch
    // (`:173 gapDetected -> onGapDetected() -> refetchJobState()`).
    handle('calibration:pollQueueChanges', () => {
      const gap = queueKind === 'unknownOutcomeRefetchFailure' && okServed > 0;
      if (gap) gapServed = true;
      return {
        status: 'ok',
        afterSequence: 0,
        nextSequence: 0,
        hasMore: false,
        gapDetected: gap,
        events: [],
      };
    });

    handle('calibration:getSubscriptionResources', () => ({
      status: 'ok',
      printerIds: [ids.printerId],
      jobIds: [ids.jobId],
      projectIds: [ids.projectId],
    }));

    handle('calibration:generateOrcaProfile', () => ({
      status: 'ok',
      displayName: 'A11y calibrated PLA',
      safeFilename: 'a11y-calibrated-pla.json',
      profileJsonHash: 'c'.repeat(64),
      patchedFieldCount: 4,
      warnings: [],
    }));

    handle('calibration:installOrcaProfile', () =>
      scenario.installFails === true
        ? {
            status: 'error',
            error: {
              code: 'verificationFailed',
              message: 'The OrcaSlicer profile directory rejected the write.',
              retryable: false,
            },
          }
        : {
            status: 'ok',
            installedHash: 'd'.repeat(64),
            backupHash: 'e'.repeat(64),
          },
    );

    handle('calibration:restoreOrcaProfile', () => ({
      status: 'ok',
      restoredHash: 'e'.repeat(64),
    }));

    handle('calibration:openPhoto', () => ({
      approvalId: 'fb000000-fb00-4b00-8b00-bb0000000000',
    }));
  }, args);

  await page.evaluate(() => {
    localStorage.setItem(
      'printfarmer.library.sourceRoots.v1',
      JSON.stringify({
        version: 1,
        roots: [
          {
            rootId: 'a11y-fixture-root',
            path: '/fixtures/a11y-models',
            approvalId: null,
            removed: false,
            lastReport: null,
            lastScannedAt: null,
          },
        ],
      }),
    );
  });

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByRole('button', { name: 'Printer Calibration' }),
  ).toBeEnabled({ timeout: 20_000 });
}

export async function openCalibrationWorkspace(page: Page): Promise<void> {
  const dashboardHeading = page.getByRole('heading', {
    name: 'Printer Calibration',
    level: 1,
  });
  if (!(await dashboardHeading.isVisible())) {
    const backToDashboard = page
      .getByRole('navigation', { name: 'Calibration views' })
      .getByRole('button', { name: 'Dashboard' });
    if (await backToDashboard.isVisible()) {
      await backToDashboard.click();
    } else {
      await page.getByRole('button', { name: 'Printer Calibration' }).click();
    }
  }
  await expect(
    page.getByRole('main', { name: 'Printer calibration workspace' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(dashboardHeading).toBeVisible({ timeout: 15_000 });
}

export async function openFixtureProject(page: Page): Promise<void> {
  const projectHeading = page.getByRole('heading', {
    name: CAL.displayName,
    level: 1,
  });
  if (await projectHeading.isVisible()) {
    return;
  }
  await openCalibrationWorkspace(page);
  const projectButton = page
    .getByRole('button', { name: new RegExp(CAL.displayName) })
    .first();
  await expect(projectButton).toBeVisible({ timeout: 15_000 });
  await projectButton.click();
  await expect(projectHeading).toBeVisible({ timeout: 15_000 });
}

export async function openTemperatureStage(page: Page): Promise<void> {
  const stageHeading = page.getByRole('heading', {
    name: 'Temperature',
    level: 1,
  });
  if (await stageHeading.isVisible()) {
    return;
  }
  await openFixtureProject(page);
  await page.getByRole('button', { name: /Open Temperature,/i }).click();
  await expect(stageHeading).toBeVisible({ timeout: 15_000 });
}

export async function openReportView(page: Page): Promise<void> {
  const reportHeading = page.getByRole('heading', {
    name: CAL.displayName,
    level: 1,
  });
  await openFixtureProject(page);
  await page.getByRole('button', { name: 'Calibration card' }).click();
  await expect(
    page.getByRole('article', { name: CAL.displayName }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(reportHeading).toBeVisible();
}

export async function openProfileView(page: Page): Promise<void> {
  const profileHeading = page.getByRole('heading', {
    name: 'OrcaSlicer profile patch preview',
    level: 1,
  });
  if (await profileHeading.isVisible()) {
    return;
  }
  await openFixtureProject(page);
  await page
    .getByRole('navigation', { name: 'Calibration views' })
    .getByRole('button', { name: 'Profile patch' })
    .click();
  await expect(profileHeading).toBeVisible({ timeout: 15_000 });
}

/**
 * A control with no accessible name. Injected into a surface to prove the
 * scanner reports, because `0 violations` and `scanner not wired` are the same
 * observation until non-zero has been shown to be reachable. Sized explicitly
 * so it cannot be skipped as a zero-area element.
 */
const AXE_PROBE_RULE = 'button-name';

async function withAxeProbe<T>(
  container: Locator,
  run: () => Promise<T>,
): Promise<T> {
  await container.evaluate((node) => {
    const probe = document.createElement('button');
    probe.type = 'button';
    probe.setAttribute('data-axe-probe', 'true');
    probe.style.cssText = 'width:44px;height:44px;opacity:0.01;';
    node.append(probe);
  });
  try {
    return await run();
  } finally {
    await container.evaluate((node) => {
      node.querySelector('[data-axe-probe]')?.remove();
    });
  }
}

/**
 * Asserts the surface actually rendered, that the scanner reports violations
 * in it, and only then that it has none.
 *
 * Two independent lies are defeated here. An axe scan of a container that
 * never rendered reports zero violations, so `present` must be visible and
 * non-empty first. And a misconfigured scanner — wrong scope, disabled rules,
 * a failed injection — reports zero violations on a fully rendered page, which
 * the render precondition cannot see. So a known violation is injected into
 * this specific surface and the scan must report it before the clean scan is
 * believed. `present` must be a locator unique to the surface under test.
 */
export async function scanSurface(
  page: Page,
  options: {
    readonly name: string;
    readonly present: Locator;
    readonly testInfo: TestInfo;
    readonly include?: string;
  },
): Promise<void> {
  const { name, present, testInfo } = options;
  await expect(
    present,
    `${name} did not render, so an axe scan of it would prove nothing`,
  ).toBeVisible({ timeout: 15_000 });
  const text = (await present.innerText()).trim();
  expect(
    text.length,
    `${name} rendered empty, so an axe scan of it would prove nothing`,
  ).toBeGreaterThan(0);

  const scan = async (): Promise<Result[]> => {
    // Electron's CDP target cannot create Axe's blank aggregation page. This
    // app has no frames, so legacy mode runs the same rules against the UI.
    let builder = new AxeBuilder({ page }).setLegacyMode().withTags(WCAG_TAGS);
    if (options.include !== undefined) {
      builder = builder.include(options.include);
    }
    const results = await builder.analyze();
    return results.violations.filter(
      (violation) =>
        typeof violation.impact === 'string' &&
        MATERIAL_IMPACTS.has(violation.impact),
    );
  };

  const probed = await withAxeProbe(present, scan);
  const detected = probed.find((violation) => violation.id === AXE_PROBE_RULE);
  expect(
    detected?.id,
    `the axe scan of ${name} did not report a deliberately unnamed button, so it is not scanning this surface and its zero-violation result would prove nothing (reported: ${probed.map((violation) => violation.id).join(', ') || 'nothing'})`,
  ).toBe(AXE_PROBE_RULE);
  expect(
    detected?.nodes.length ?? 0,
    `the axe scan of ${name} reported ${AXE_PROBE_RULE} with no nodes`,
  ).toBeGreaterThan(0);

  const material = await scan();
  if (material.length > 0) {
    await testInfo.attach(`axe-${name.replaceAll(' ', '-')}.json`, {
      body: Buffer.from(JSON.stringify(material, null, 2)),
      contentType: 'application/json',
    });
  }
  expect(material, `${name} has material WCAG A/AA violations`).toEqual([]);
}

/** Accessible name and role of the currently focused element. */
export async function focusedDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return '<body>';
    const label =
      active.getAttribute('aria-label') ??
      (active.textContent ?? '').trim().slice(0, 80);
    return `${active.tagName.toLowerCase()}[${active.getAttribute('role') ?? 'implicit'}] "${label}"`;
  });
}

/**
 * Tabs forward until `target` is focused, asserting focus actually moved and
 * that the element reached sits inside `expectedContainer` when given.
 *
 * A traversal that ends where it started, or that never reaches the named
 * element, is a dead end — this reports which named element it could not
 * reach and where focus ended up.
 *
 * **What `expectedContainer` does not do.** It is checked once, after
 * `target === document.activeElement`, so it asserts a structural fact — the
 * element reached is inside that container — and *not* that focus stayed
 * inside during the traversal. It cannot detect focus escaping and returning,
 * because it never runs while focus is in transit.
 *
 * This comment previously claimed containment was asserted "separately" as a
 * guard against focus escaping the surface. That was wrong, and the review of
 * #174 caught it. The check is not strengthened to run per press because
 * three of its four call sites *deliberately* begin outside `<main>` and cross
 * the sibling navigation landmark to get there — per-press containment would
 * fail them for doing the thing they are testing. **The check is correct; the
 * claim about it was not, so the claim is what changed.**
 *
 * A false constraint in a comment gets cited later as a rule by someone who
 * was not here, which is the reason this is a paragraph rather than a
 * deletion.
 */
export async function expectTabReaches(
  page: Page,
  target: Locator,
  description: string,
  maxPresses = 60,
  expectedContainer?: Locator,
): Promise<void> {
  const start = await focusedDescription(page);
  const seen: string[] = [];
  for (let press = 0; press < maxPresses; press += 1) {
    await page.keyboard.press('Tab');
    const current = await focusedDescription(page);
    seen.push(current);
    if (await target.evaluate((node) => node === document.activeElement)) {
      expect(
        current,
        `Tab left focus on ${start}; a traversal that does not move proves nothing`,
      ).not.toBe(start);
      if (expectedContainer !== undefined) {
        expect(
          await focusIsInside(expectedContainer),
          `Tab reached ${description}, but that element is not inside the surface under test (focus is ${current})`,
        ).toBe(true);
      }
      return;
    }
  }
  throw new Error(
    `Tab never reached ${description} in ${String(maxPresses)} presses.\n` +
      `Focus started on ${start} and visited:\n  ${seen.join('\n  ')}`,
  );
}

/** True when the focused element is inside `container`. */
export async function focusIsInside(container: Locator): Promise<boolean> {
  return container.evaluate(
    (node) =>
      document.activeElement !== null && node.contains(document.activeElement),
  );
}

/**
 * Presses `key` and asserts focus moved to `target`, and that it actually
 * moved: a traversal that ends where it started is a dead end, not a pass.
 */
export async function expectFocusMoves(
  page: Page,
  key: string,
  target: Locator,
  description: string,
): Promise<void> {
  const before = await focusedDescription(page);
  await page.keyboard.press(key);
  await expect(
    target,
    `${key} did not move focus to ${description} (focus was ${before})`,
  ).toBeFocused({ timeout: 10_000 });
  const after = await focusedDescription(page);
  expect(
    after,
    `${key} left focus on ${before}; a traversal that does not move proves nothing`,
  ).not.toBe(before);
}
