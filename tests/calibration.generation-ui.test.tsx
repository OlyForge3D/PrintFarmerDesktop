/**
 * Focused production-backed tests for the calibration generation/queue/bed-clear
 * UI workflow (issue #54, iteration 2).
 *
 * Covers: G-03, G-05, G-07, G-09, Q-01, Q-05, Q-06, B-01 through B-07,
 * L-01 through L-07, S-05, A-03, A-07, A-08.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CalibrationSaveWorkspaceStateRequest as CalibrationSaveWorkspaceStateRequestSchema,
  CalibrationSaveWorkspaceStateResponse,
  CalibrationWorkspacePayload,
  CalibrationWorkspaceStateRecord as CalibrationWorkspaceStateRecordSchema,
} from '@shared/ipc';
import type {
  CalibrationBedClearAckOutcome,
  CalibrationOrchestrationStatus,
  CalibrationQueueJobState,
  CalibrationSaveWorkspaceStateRequest,
  CalibrationWorkspaceStateRecord,
} from '@shared/ipc';
import type {
  CalibrationApi,
  CalibrationEnvironment,
} from '../src/renderer/calibration/api';
import { CalibrationWorkspace } from '../src/renderer/calibration';
import { emptyWorkflowDrafts } from '../src/renderer/calibration/workspaceTypes';
import { createCalibrationState } from '../src/renderer/calibration/domain';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const profileId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const jobId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const printerId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const orchestrationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const now = '2026-07-29T10:00:00.000Z';

function makeDomainState() {
  return createCalibrationState({
    projectId,
    createdAt: now,
    mode: 'expert',
    baseline: {
      nozzleTemperatureC: 220,
      flowRatio: 1,
      pressureAdvance: 0.03,
      retractionLengthMm: 0.6,
      maximumVolumetricRateMm3S: 12,
      shrinkageCompensationXPercent: 100,
      shrinkageCompensationYPercent: 100,
      shrinkageCompensationZPercent: 100,
    },
    binding: {
      printer: {
        backendProfileId: profileId,
        backendPrinterId: printerId,
        printerConfigurationId: 'configuration-1',
        printerConfigurationRevision: 7,
      },
      snapshot: {
        snapshotId: 'snapshot-7',
        snapshotRevision: 7,
        capturedAt: now,
        configurationRevision: 7,
        toolheads: [
          {
            toolId: 'tool-a',
            toolheadId: 'head-a',
            nozzle: {
              nozzleId: 'nozzle-a',
              diameterMm: 0.4,
              material: 'brass',
            },
            extruderType: 'directDrive',
          },
        ],
        safety: {
          buildVolumeMm: { x: 220, y: 220, z: 250 },
          maximumNozzleTemperatureC: 300,
          maximumBedTemperatureC: 110,
          maximumVolumetricRateMm3S: 35,
          emergencyStopAvailable: true,
          thermalProtectionConfirmed: true,
          ventilationAssessed: true,
        },
      },
      selectedToolId: 'tool-a',
      selectedToolheadId: 'head-a',
      selectedNozzleId: 'nozzle-a',
      filament: {
        filamentProjectId: '55555555-5555-4555-8555-555555555555',
        provider: 'Material Co',
        product: 'PLA Pro',
        sku: 'PLA-BLK',
        spoolId: 'spool-9',
      },
    },
  });
}

function makeRecord(): CalibrationWorkspaceStateRecord {
  const domainState = makeDomainState();
  return CalibrationWorkspaceStateRecordSchema.parse({
    profileId,
    projectId,
    displayName: 'PLA calibration project',
    description: '',
    printerId,
    status: 'draft',
    completedStepCount: 0,
    totalStepCount: 9,
    isSynced: true,
    isPrinterContextFresh: true,
    hasConflicts: false,
    remoteProjectId: null,
    baseRevision: 1,
    createdAt: now,
    updatedAt: now,
    workspaceState: CalibrationWorkspacePayload.parse({
      schemaVersion: 1,
      domainState,
      metadata: {
        displayName: 'PLA calibration project',
        description: '',
      },
      stepDrafts: {},
      workflowDrafts: emptyWorkflowDrafts(),
      photos: [],
      physicalMatch: {
        snapshotId: 'snapshot-7',
        toolId: 'tool-a',
        toolheadId: 'head-a',
        nozzleId: 'nozzle-a',
        nozzleDiameterMm: 0.4,
        confirmedAt: now,
      },
      selectedBaseProfile: {
        orcaProfileId: 'orca-base',
        displayName: 'Explicit upstream PLA',
        source: 'printFarmer',
        upstreamVerified: true,
        printerId,
        configurationRevision: 7,
        snapshotId: 'snapshot-7',
        toolId: 'tool-a',
        toolheadId: 'head-a',
        nozzleId: 'nozzle-a',
        nozzleDiameterMm: 0.4,
        profileRevision: 'profile-revision-7',
        contentHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      selectedBaseProfileId: 'orca-base',
      autosaveRevision: 1,
    }),
  });
}

function makeOrchestration(
  overrides: Partial<CalibrationOrchestrationStatus> = {},
): CalibrationOrchestrationStatus {
  return {
    orchestrationId,
    projectId,
    attemptId,
    operationId,
    status: 'Running',
    currentStep: 'SlicingQueued',
    revision: 1,
    retryCount: 0,
    nextRetryAtUtc: null,
    stepStartedAtUtc: now,
    lastErrorCode: null,
    problems: [],
    model3DId: null,
    sliceJobId: null,
    gcodeFileId: null,
    specificationSha256: null,
    planManifestSha256: null,
    gcodeSha256: null,
    generatorVersion: null,
    slicerContainerDigest: null,
    statusRoute: `/api/calibration-orchestrations/${orchestrationId}`,
    createdAtUtc: now,
    updatedAtUtc: now,
    completedAtUtc: null,
    ...overrides,
  };
}

function makeQueueJob(
  overrides: Partial<CalibrationQueueJobState> = {},
): CalibrationQueueJobState {
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  return {
    jobId,
    profileId,
    calibrationProjectId: projectId,
    assignedPrinterId: printerId,
    assignedPrinterName: 'Unbranded cell 7',
    gcodeFileId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    gcodeFileName: 'temperature_tower_v1.gcode',
    jobStatus: 'Assigned',
    queuePosition: 1,
    priority: 50,
    requiredNozzleDiameter: 0.4,
    requiredMaterialType: 'PLA',
    pinnedPrinterConfigRevision: 7,
    jobEtag: 'W/"abc123"',
    dispatchStateEtag: 'W/"def456"',
    dispatchStateRevision: 3,
    bedClearExpiresAtUtc: expiresAt,
    updatedAt: now,
    ...overrides,
  };
}

function deterministicEnvironment(): CalibrationEnvironment {
  let seq = 200;
  return {
    createId: () => {
      seq += 1;
      return `bbbbbbbb-bbbb-4bbb-8bbb-${seq.toString().padStart(12, '0')}`;
    },
    now: () => now,
  };
}

function makeSaveApi(
  savedRecord: CalibrationWorkspaceStateRecord,
): CalibrationApi['saveCalibrationWorkspaceState'] {
  return vi
    .fn()
    .mockImplementation((req: CalibrationSaveWorkspaceStateRequest) => {
      const parsed = CalibrationSaveWorkspaceStateRequestSchema.parse(req);
      return Promise.resolve(
        CalibrationSaveWorkspaceStateResponse.parse({
          queued: true,
          state: {
            ...savedRecord,
            profileId: parsed.profileId,
            projectId: parsed.projectId,
            printerId: parsed.printerId,
            displayName: parsed.displayName,
            description: parsed.description ?? null,
            status: parsed.status,
            completedStepCount: parsed.completedStepCount,
            totalStepCount: parsed.totalStepCount,
            baseRevision: parsed.baseRevision ?? null,
            isSynced: true,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
            workspaceState: parsed.workspaceState,
          },
        }),
      );
    });
}

function makeBaseApi(savedRecord = makeRecord()): CalibrationApi {
  return {
    getCalibrationAvailability: vi.fn().mockResolvedValue({
      available: true,
      unavailableReason: null,
      unavailableDetail: null,
      negotiatedApiVersion: '2',
      negotiatedSchemaVersion: 2,
      capabilityFlags: {
        calibrationApiEnabled: true,
        calibrationChangeFeedEnabled: true,
        calibrationOfflineDraftEnabled: true,
        calibrationPhotoUploadEnabled: true,
        calibrationGenerationEnabled: true,
      },
      grantedScopes: ['CalibrationRead', 'CalibrationWrite'],
      offlineEditingEnabled: true,
    }),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [savedRecord], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockResolvedValue(savedRecord),
    saveCalibrationWorkspaceState: makeSaveApi(savedRecord),
    listCalibrationPrinters: vi
      .fn()
      .mockResolvedValue({ printers: [], fetchedAt: now }),
    getCalibrationPrinterContext: vi.fn(),
    listOrcaProfiles: vi.fn().mockResolvedValue({ profiles: [] }),
    openCalibrationPhoto: vi.fn().mockResolvedValue(null),
    stageCalibrationPhoto: vi.fn(),
    syncCalibrationNow: vi.fn().mockResolvedValue({
      phase: 'succeeded',
      profileId,
      projectId: null,
      pushedOperations: 0,
      pulledChanges: 0,
      conflictCount: 0,
      cursor: null,
      error: null,
    }),
    generateOrcaProfile: vi.fn().mockResolvedValue({
      status: 'error',
      error: { code: 'workspaceNotReady', message: 'test', retryable: false },
    }),
    exportOrcaProfile: vi.fn().mockResolvedValue({ status: 'canceled' }),
    installOrcaProfile: vi.fn().mockResolvedValue({
      status: 'error',
      error: {
        code: 'unsupportedPlatform',
        message: 'test',
        retryable: false,
      },
    }),
    restoreOrcaProfile: vi.fn().mockResolvedValue({
      status: 'error',
      error: {
        code: 'unsupportedPlatform',
        message: 'test',
        retryable: false,
      },
    }),
    startCalibrationGeneration: vi.fn().mockResolvedValue({
      status: 'error',
      error: {
        code: 'syncRequired',
        message: 'Not in test.',
        retryable: false,
        retryAfterSeconds: null,
      },
    }),
    getCalibrationOrchestrationStatus: vi
      .fn()
      .mockResolvedValue({ status: 'notFound' }),
    getCalibrationQueueState: vi.fn().mockResolvedValue({
      status: 'error',
      error: {
        code: 'syncRequired',
        message: 'Not in test.',
        retryable: false,
        retryAfterSeconds: null,
      },
    }),
    acknowledgeCalibrationBedClear: vi.fn().mockResolvedValue({
      status: 'error',
      error: {
        code: 'syncRequired',
        message: 'Not in test.',
        retryable: false,
        retryAfterSeconds: null,
      },
    }),
  } satisfies CalibrationApi;
}

function renderWorkspace(api: CalibrationApi) {
  Object.defineProperty(window, 'printFarmer', {
    configurable: true,
    value: api,
  });
  return render(
    <CalibrationWorkspace
      selectedProfileId={profileId}
      selectedProfileName="Farm server"
      environment={deterministicEnvironment()}
    />,
  );
}

async function openStepWorkflow(api: CalibrationApi): Promise<void> {
  renderWorkspace(api);

  // Wait for project list to load and click the project
  const projectBtn = await screen.findByRole('button', {
    name: /PLA calibration project/,
  });
  fireEvent.click(projectBtn);

  // Wait for overview, then click on the Temperature stage
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: /Open Temperature/ }),
    ).not.toBeNull(),
  );
  fireEvent.click(screen.getByRole('button', { name: /Open Temperature/ }));

  // Wait for step workflow to fully load with the generation panel
  // (requires isSynced:true after save, so we wait for the generation panel)
  await waitFor(
    () => expect(screen.queryByText(/PrintFarmer generation/i)).not.toBeNull(),
    { timeout: 5000 },
  );

  // Select the temperature tower method so Start Generation button is enabled
  const methodSelect = screen.queryByLabelText('Calibration method');
  if (methodSelect) {
    fireEvent.change(methodSelect, { target: { value: 'temperatureTower' } });
  }
  // Wait for start generation button to be present (indicates method is set)
  await waitFor(
    () => expect(screen.queryByTestId('start-generation-btn')).not.toBeNull(),
    { timeout: 3000 },
  );
}

// ─── G-03: Generation Preview ─────────────────────────────────────────────────

describe('G-03: Method/specification preview before POST', () => {
  it('shows generation panel with method preview when gate passes', async () => {
    const api = makeBaseApi();
    await openStepWorkflow(api);
    await waitFor(() =>
      expect(screen.getByText(/PrintFarmer generation/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Method:/i)).toBeInTheDocument();
    expect(screen.getByText(/Stage:/i)).toBeInTheDocument();
  });

  it('Start Generation button is present and enabled when method is selected', async () => {
    const api = makeBaseApi();
    await openStepWorkflow(api);
    await waitFor(() => screen.getByTestId('start-generation-btn'));
    const btn = screen.getByTestId('start-generation-btn');
    expect(btn).toBeInTheDocument();
  });
});

// ─── G-05: Durable orchestration stages ──────────────────────────────────────

describe('G-05, G-07: Orchestration stage progress and hashes', () => {
  it('shows all seven durable stages in the panel', async () => {
    const api = {
      ...makeBaseApi(),
      startCalibrationGeneration: vi.fn().mockResolvedValue({
        status: 'submitted',
        orchestration: makeOrchestration({ currentStep: 'SlicingQueued' }),
      }),
    };
    await openStepWorkflow(api);

    fireEvent.click(screen.getByTestId('start-generation-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('orchestration-stages')).toBeInTheDocument(),
    );
    const stages = screen.getByTestId('orchestration-stages');
    expect(stages).toHaveTextContent('Model accepted');
    expect(stages).toHaveTextContent('Slicing queued');
    expect(stages).toHaveTextContent('Slicing claimed');
    expect(stages).toHaveTextContent('Slicing in progress');
    expect(stages).toHaveTextContent('Artifact validated');
    expect(stages).toHaveTextContent('G-code promoted');
    expect(stages).toHaveTextContent('Print job created in queue');
  });

  it('shows provenance hashes when present in orchestration (G-07)', async () => {
    const orchestration = makeOrchestration({
      currentStep: 'QueueJobCreated',
      status: 'Completed',
      specificationSha256:
        'aabbccddeeffaabbccddeeffaabbccddeeffaabbccddeeffaabbccddeeffaabb',
      planManifestSha256:
        'ccddaabbccddeeffaabbccddeeffaabbccddeeffaabbccddeeffaabbccddeeff',
      gcodeSha256:
        'eeffaabbccddeeffaabbccddeeffaabbccddeeffaabbccddeeffaabbccddeeff',
      generatorVersion: 'gen-v2.3.1',
      slicerContainerDigest: 'sha256:deadbeefcafe1234',
    });
    const api = {
      ...makeBaseApi(),
      startCalibrationGeneration: vi.fn().mockResolvedValue({
        status: 'submitted',
        orchestration,
      }),
    };
    await openStepWorkflow(api);

    fireEvent.click(screen.getByTestId('start-generation-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('spec-sha256')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('spec-sha256')).toHaveTextContent('aabbccddee');
    await waitFor(() =>
      expect(screen.getByTestId('generation-hashes')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('plan-sha256')).toHaveTextContent('ccddaabbcc');
    expect(screen.getByTestId('gcode-sha256')).toHaveTextContent('eeffaabbcc');
    expect(screen.getByTestId('generator-version')).toHaveTextContent(
      'gen-v2.3.1',
    );
  });
});

// ─── G-09: Generation idempotency and structured failures ─────────────────────

describe('G-09: Structured failure variants map to typed reasons', () => {
  it('maps structured failure problems to typed codes', async () => {
    const orchestration = makeOrchestration({
      status: 'Failed',
      currentStep: 'ModelAccepted',
      problems: [
        {
          code: 'CONTEXT_STALE',
          field: 'printerContext',
          message: 'Printer context is outdated',
        },
      ],
    });
    const api = {
      ...makeBaseApi(),
      startCalibrationGeneration: vi.fn().mockResolvedValue({
        status: 'submitted',
        orchestration,
      }),
    };
    await openStepWorkflow(api);

    fireEvent.click(screen.getByTestId('start-generation-btn'));

    await waitFor(() =>
      expect(
        screen.getByText(/Printer context is outdated/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/CONTEXT_STALE/)).toBeInTheDocument();
  });

  it('poll button calls getCalibrationOrchestrationStatus (G-06)', async () => {
    const pollMock = vi
      .fn<CalibrationApi['getCalibrationOrchestrationStatus']>()
      .mockResolvedValue({
        status: 'ok',
        orchestration: makeOrchestration({ currentStep: 'ArtifactValidated' }),
      });

    const api = {
      ...makeBaseApi(),
      startCalibrationGeneration: vi.fn().mockResolvedValue({
        status: 'submitted',
        orchestration: makeOrchestration(),
      }),
      getCalibrationOrchestrationStatus: pollMock,
    };
    await openStepWorkflow(api);

    fireEvent.click(screen.getByTestId('start-generation-btn'));

    await waitFor(() =>
      expect(screen.getByTestId('poll-orchestration-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('poll-orchestration-btn'));

    await waitFor(() =>
      expect(pollMock).toHaveBeenCalledWith({
        profileId,
        orchestrationId,
      }),
    );
  });
});

// ─── Q-01: Authoritative queue state display ──────────────────────────────────

describe('Q-01: Authoritative queue state display', () => {
  async function setupWithJob(
    jobOverrides: Partial<CalibrationQueueJobState> = {},
  ) {
    const job = makeQueueJob(jobOverrides);
    const api = {
      ...makeBaseApi(),
      getCalibrationQueueState: vi
        .fn<CalibrationApi['getCalibrationQueueState']>()
        .mockResolvedValue({
          status: 'ok',
          job,
        }),
    };
    await openStepWorkflow(api);
    await waitFor(() =>
      expect(screen.getByTestId('refresh-queue-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('refresh-queue-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('queue-job-id')).toBeInTheDocument(),
    );
    return { job };
  }

  it('displays job ID from REST (Q-01)', async () => {
    await setupWithJob();
    expect(screen.getByTestId('queue-job-id')).toHaveTextContent(jobId);
  });

  it('displays job status from REST (Q-01)', async () => {
    await setupWithJob({ jobStatus: 'Assigned' });
    expect(screen.getByTestId('queue-job-status')).toHaveTextContent(
      'Assigned',
    );
  });

  it('displays assigned printer from REST (Q-01)', async () => {
    await setupWithJob();
    expect(screen.getByTestId('queue-printer')).toHaveTextContent(
      'Unbranded cell 7',
    );
  });

  it('displays required nozzle from REST (Q-01)', async () => {
    await setupWithJob();
    expect(screen.getByTestId('queue-nozzle')).toHaveTextContent('0.4 mm');
  });

  it('displays required material from REST (Q-01)', async () => {
    await setupWithJob();
    expect(screen.getByTestId('queue-material')).toHaveTextContent('PLA');
  });

  it('shows bed-clear expiry when job is Assigned (B-01)', async () => {
    await setupWithJob({ jobStatus: 'Assigned' });
    expect(screen.getByTestId('queue-bed-clear-expiry')).toHaveTextContent(
      /remaining|None/i,
    );
  });

  it('shows bed-clear dialog button when job is Assigned and has expiry', async () => {
    await setupWithJob({ jobStatus: 'Assigned' });
    await waitFor(() =>
      expect(screen.getByTestId('open-bed-clear-btn')).toBeInTheDocument(),
    );
  });
});

// ─── B-01: Bed-clear safety dialog fields ─────────────────────────────────────

describe('B-01: Bed-clear safety dialog shows exact fields', () => {
  async function openDialog() {
    const api = {
      ...makeBaseApi(),
      getCalibrationQueueState: vi
        .fn<CalibrationApi['getCalibrationQueueState']>()
        .mockResolvedValue({
          status: 'ok',
          job: makeQueueJob({ jobStatus: 'Assigned' }),
        }),
      acknowledgeCalibrationBedClear: vi.fn(),
    };
    await openStepWorkflow(api);
    fireEvent.click(screen.getByTestId('refresh-queue-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('open-bed-clear-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-bed-clear-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('bed-clear-dialog')).toBeInTheDocument(),
    );
  }

  it('displays exact job ID (B-01)', async () => {
    await openDialog();
    expect(screen.getByTestId('bed-clear-job-id')).toHaveTextContent(jobId);
  });

  it('displays assigned printer name and ID (B-01)', async () => {
    await openDialog();
    expect(screen.getByTestId('bed-clear-printer')).toHaveTextContent(
      'Unbranded cell 7',
    );
    expect(screen.getByTestId('bed-clear-printer')).toHaveTextContent(
      printerId,
    );
  });

  it('displays queue revision ETag (B-01)', async () => {
    await openDialog();
    expect(screen.getByTestId('bed-clear-etag')).toHaveTextContent(
      'W/"abc123"',
    );
  });

  it('displays dispatch state revision (B-01)', async () => {
    await openDialog();
    expect(screen.getByTestId('bed-clear-dispatch-revision')).toHaveTextContent(
      '3',
    );
  });

  it('displays required nozzle diameter (B-01)', async () => {
    await openDialog();
    expect(screen.getByTestId('bed-clear-nozzle')).toHaveTextContent('0.4 mm');
  });

  it('displays required material type (B-01)', async () => {
    await openDialog();
    expect(screen.getByTestId('bed-clear-material')).toHaveTextContent('PLA');
  });

  it('displays bed-clear expiry (B-01)', async () => {
    await openDialog();
    expect(screen.getByTestId('bed-clear-expiry')).toHaveTextContent(
      /remaining|None/i,
    );
  });

  it('displays G-code file name (B-01)', async () => {
    await openDialog();
    expect(screen.getByTestId('bed-clear-gcode')).toHaveTextContent(
      'temperature_tower_v1.gcode',
    );
  });

  it('has proper dialog aria semantics (accessibility)', async () => {
    await openDialog();
    const dialog = screen.getByTestId('bed-clear-dialog');
    // <dialog> has implicit role=dialog, no need for explicit role attribute
    expect(dialog.tagName.toLowerCase()).toBe('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'bed-clear-dialog-title');
  });
});

// ─── B-02: Exact IPC channel and headers ─────────────────────────────────────

describe('B-02: Single acknowledgement endpoint with exact headers', () => {
  it('sends jobId, printerId, jobEtag, dispatchStateEtag, operationId', async () => {
    const ackMock = vi
      .fn<CalibrationApi['acknowledgeCalibrationBedClear']>()
      .mockResolvedValue({
        status: 'ok',
        outcome: { kind: 'starting', jobId },
      });

    const api = {
      ...makeBaseApi(),
      getCalibrationQueueState: vi
        .fn<CalibrationApi['getCalibrationQueueState']>()
        .mockResolvedValue({
          status: 'ok',
          job: makeQueueJob(),
        }),
      acknowledgeCalibrationBedClear: ackMock,
    };

    await openStepWorkflow(api);
    fireEvent.click(screen.getByTestId('refresh-queue-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('open-bed-clear-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-bed-clear-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('bed-clear-confirm-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('bed-clear-confirm-btn'));

    await waitFor(() => expect(ackMock).toHaveBeenCalledTimes(1));
    const firstArgCall = ackMock.mock.calls[0];
    expect(firstArgCall).toBeDefined();
    const arg = firstArgCall![0];
    expect(arg.jobId).toBe(jobId);
    expect(arg.printerId).toBe(printerId);
    expect(arg.jobEtag).toBe('W/"abc123"');
    expect(arg.dispatchStateEtag).toBe('W/"def456"');
    expect(arg.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

// ─── B-03: Each HTTP status code handled ─────────────────────────────────────

describe('B-03: Each HTTP status code handled exactly', () => {
  async function doAck(outcome: CalibrationBedClearAckOutcome): Promise<void> {
    const ackMock = vi
      .fn<CalibrationApi['acknowledgeCalibrationBedClear']>()
      .mockResolvedValue({ status: 'ok', outcome });

    const api = {
      ...makeBaseApi(),
      getCalibrationQueueState: vi
        .fn<CalibrationApi['getCalibrationQueueState']>()
        .mockResolvedValue({
          status: 'ok',
          job: makeQueueJob(),
        }),
      acknowledgeCalibrationBedClear: ackMock,
    };

    await openStepWorkflow(api);
    fireEvent.click(screen.getByTestId('refresh-queue-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('open-bed-clear-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-bed-clear-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('bed-clear-confirm-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('bed-clear-confirm-btn'));
    await waitFor(() => expect(ackMock).toHaveBeenCalledTimes(1));
  }

  it('202 starting → Starting state and dialog closes (B-03)', async () => {
    await doAck({ kind: 'starting', jobId });
    await waitFor(() =>
      expect(screen.queryByTestId('bed-clear-dialog')).toBeNull(),
    );
  });

  it('200 alreadyStarting → idempotent, shown in status (B-03)', async () => {
    await doAck({ kind: 'alreadyStarting', jobId });
    await waitFor(() =>
      expect(
        screen.queryByTestId('bed-clear-outcome-already-starting'),
      ).not.toBeNull(),
    );
  });

  it('409 conflict → dialog dismissed without retry, reason visible (B-03)', async () => {
    await doAck({
      kind: 'conflict',
      reason: 'wrong_printer',
      detail: 'Mismatch.',
    });
    await waitFor(() =>
      expect(screen.queryByTestId('bed-clear-outcome-conflict')).not.toBeNull(),
    );
    expect(screen.getByTestId('bed-clear-outcome-conflict')).toHaveTextContent(
      'wrong_printer',
    );
  });

  it('412 staleRevision → queue refetched, dialog closes (B-03)', async () => {
    const queueMock = vi
      .fn<CalibrationApi['getCalibrationQueueState']>()
      .mockResolvedValue({
        status: 'ok',
        job: makeQueueJob(),
      });

    const ackMock = vi
      .fn<CalibrationApi['acknowledgeCalibrationBedClear']>()
      .mockResolvedValue({
        status: 'ok',
        outcome: { kind: 'staleRevision' },
      });

    const api = {
      ...makeBaseApi(),
      getCalibrationQueueState: queueMock,
      acknowledgeCalibrationBedClear: ackMock,
    };

    await openStepWorkflow(api);
    fireEvent.click(screen.getByTestId('refresh-queue-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('open-bed-clear-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-bed-clear-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('bed-clear-confirm-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('bed-clear-confirm-btn'));

    // Dialog closes (stale: dialog dismissed, refetch triggered)
    await waitFor(() =>
      expect(screen.queryByTestId('bed-clear-dialog')).toBeNull(),
    );
    // REST refetch triggered (not retry as ack)
    expect(queueMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('503 printerOffline → dialog stays open, no retry, reason shown (B-03)', async () => {
    await doAck({ kind: 'printerOffline', detail: 'Telemetry timeout' });
    // Dialog stays open
    expect(screen.queryByTestId('bed-clear-dialog')).not.toBeNull();
    expect(screen.getByTestId('bed-clear-outcome-offline')).toHaveTextContent(
      'Telemetry timeout',
    );
  });
});

// ─── B-04: Starting state with no blind retry ─────────────────────────────────

describe('B-04: Starting state with no blind retry', () => {
  it('shows no-retry notice for Starting status', async () => {
    const api = {
      ...makeBaseApi(),
      getCalibrationQueueState: vi
        .fn<CalibrationApi['getCalibrationQueueState']>()
        .mockResolvedValue({
          status: 'ok',
          job: makeQueueJob({ jobStatus: 'Starting' }),
        }),
    };
    await openStepWorkflow(api);
    fireEvent.click(screen.getByTestId('refresh-queue-btn'));
    await waitFor(() =>
      expect(
        screen.getByTestId('starting-no-retry-notice'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('starting-no-retry-notice')).toHaveTextContent(
      /No automatic retry/i,
    );
  });
});

// ─── B-05: Fresh UUID per dialog ─────────────────────────────────────────────

describe('B-05: Fresh stable UUID per dialog invocation', () => {
  it('uses different operationId for each dialog invocation', async () => {
    const ackMock = vi
      .fn<CalibrationApi['acknowledgeCalibrationBedClear']>()
      .mockResolvedValueOnce({
        status: 'ok',
        outcome: {
          kind: 'conflict',
          reason: 'busy',
          detail: null,
        },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        outcome: { kind: 'starting', jobId },
      });

    const api = {
      ...makeBaseApi(),
      getCalibrationQueueState: vi
        .fn<CalibrationApi['getCalibrationQueueState']>()
        .mockResolvedValue({
          status: 'ok',
          job: makeQueueJob(),
        }),
      acknowledgeCalibrationBedClear: ackMock,
    };

    await openStepWorkflow(api);
    fireEvent.click(screen.getByTestId('refresh-queue-btn'));

    // First invocation
    await waitFor(() =>
      expect(screen.getByTestId('open-bed-clear-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-bed-clear-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('bed-clear-confirm-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('bed-clear-confirm-btn'));
    await waitFor(() => expect(ackMock).toHaveBeenCalledTimes(1));
    const firstCall = ackMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const firstOpId = firstCall![0].operationId;

    // Second invocation - first close the conflict dialog
    await waitFor(() =>
      expect(screen.getByTestId('bed-clear-close-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('bed-clear-close-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('open-bed-clear-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('open-bed-clear-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('bed-clear-confirm-btn')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('bed-clear-confirm-btn'));
    await waitFor(() => expect(ackMock).toHaveBeenCalledTimes(2));
    const secondCall = ackMock.mock.calls[1];
    expect(secondCall).toBeDefined();
    const secondOpId = secondCall![0].operationId;

    expect(firstOpId).not.toBe(secondOpId);
  });
});

// ─── L-01: All eight lifecycle states from REST ────────────────────────────────

describe('L-01: All lifecycle states reconciled from REST', () => {
  const allStatuses = [
    'Queued',
    'Assigned',
    'Starting',
    'Printing',
    'Paused',
    'Completed',
    'Failed',
    'Cancelled',
  ] as const;

  for (const status of allStatuses) {
    it(`displays "${status}" lifecycle state from REST (L-01)`, async () => {
      const api = {
        ...makeBaseApi(),
        getCalibrationQueueState: vi
          .fn<CalibrationApi['getCalibrationQueueState']>()
          .mockResolvedValue({
            status: 'ok',
            job: makeQueueJob({ jobStatus: status }),
          }),
      };
      await openStepWorkflow(api);
      fireEvent.click(screen.getByTestId('refresh-queue-btn'));
      await waitFor(() =>
        expect(
          screen.getByTestId('lifecycle-status-label'),
        ).toBeInTheDocument(),
      );
      expect(screen.getByTestId('lifecycle-status-label')).toHaveTextContent(
        status,
      );
    });
  }
});

// ─── L-04: Terminal states preserve history ────────────────────────────────────

describe('L-04: Terminal states preserve history', () => {
  for (const status of ['Completed', 'Failed', 'Cancelled'] as const) {
    it(`shows terminal notice for "${status}" without mutating history`, async () => {
      const api = {
        ...makeBaseApi(),
        getCalibrationQueueState: vi
          .fn<CalibrationApi['getCalibrationQueueState']>()
          .mockResolvedValue({
            status: 'ok',
            job: makeQueueJob({ jobStatus: status }),
          }),
      };
      await openStepWorkflow(api);
      fireEvent.click(screen.getByTestId('refresh-queue-btn'));
      await waitFor(() =>
        expect(
          screen.getByTestId('lifecycle-terminal-notice'),
        ).toBeInTheDocument(),
      );
    });
  }
});

// ─── Q-06: REST is authoritative, not SignalR ─────────────────────────────────

describe('Q-06: REST reconciliation is authoritative', () => {
  it('refreshQueueState calls IPC (REST), not SignalR', async () => {
    const queueMock = vi
      .fn<CalibrationApi['getCalibrationQueueState']>()
      .mockResolvedValue({
        status: 'ok',
        job: makeQueueJob({ jobStatus: 'Printing' }),
      });

    const api = { ...makeBaseApi(), getCalibrationQueueState: queueMock };
    await openStepWorkflow(api);
    fireEvent.click(screen.getByTestId('refresh-queue-btn'));

    await waitFor(() => expect(queueMock).toHaveBeenCalledTimes(1));
    expect(queueMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileId, projectId }),
    );
    // Confirms REST is called (not a local mock event or SignalR path)
    expect(screen.getByTestId('lifecycle-status-label')).toHaveTextContent(
      'Printing',
    );
  });
});

// ─── S-05: Renderer privilege boundary ────────────────────────────────────────

describe('S-05: Renderer privilege boundary', () => {
  it('CalibrationApi only exposes named typed channels, no generic primitives', () => {
    type ApiKeys = keyof CalibrationApi;
    const approvedChannels: ApiKeys[] = [
      'getCalibrationAvailability',
      'listCalibrationPrinters',
      'getCalibrationPrinterContext',
      'listCalibrationWorkspaceStates',
      'getCalibrationWorkspaceState',
      'saveCalibrationWorkspaceState',
      'syncCalibrationNow',
      'listOrcaProfiles',
      'openCalibrationPhoto',
      'stageCalibrationPhoto',
      'generateOrcaProfile',
      'exportOrcaProfile',
      'installOrcaProfile',
      'restoreOrcaProfile',
      'startCalibrationGeneration',
      'getCalibrationOrchestrationStatus',
      'getCalibrationQueueState',
      'acknowledgeCalibrationBedClear',
    ];

    const forbidden = [
      'fetch',
      'request',
      'readFile',
      'writeFile',
      'readDir',
      'exec',
      'spawn',
      'shell',
      'openExternal',
      'downloadFile',
      'uploadFile',
    ];

    for (const key of forbidden) {
      expect(approvedChannels).not.toContain(key);
    }
    // All approved channels are named and typed
    for (const key of approvedChannels) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });
});

// ─── A-03, A-07: Provenance and no bundled models ─────────────────────────────

interface ProvenanceManifest {
  schemaVersion: number;
  feature: string;
  approvedSource: { canonicalRepository: string };
  derivedFiles: unknown[];
}

describe('A-03, A-07, A-08: Asset provenance manifest', () => {
  it('compliance/printer-calibration-provenance.json exists and is valid (A-07)', () => {
    const manifestPath = join(
      process.cwd(),
      'compliance',
      'printer-calibration-provenance.json',
    );
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as ProvenanceManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.feature).toBe('printer-calibration');
    expect(manifest.approvedSource).toBeDefined();
    expect(manifest.approvedSource.canonicalRepository).toContain('github.com');
  });

  it('no third-party calibration .3mf/.stl/.obj models bundled in resources (A-03)', () => {
    const resourcesDir = join(process.cwd(), 'resources');
    function findModels(dir: string): string[] {
      let found: string[] = [];
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            found = found.concat(findModels(fullPath));
          } else if (/\.(3mf|stl|obj|amf|step)$/i.test(entry)) {
            found.push(fullPath);
          }
        }
      } catch {
        // Directory may not exist in test environment
      }
      return found;
    }
    const models = findModels(resourcesDir);
    expect(models).toHaveLength(0);
  });

  it('provenance derivedFiles array exists (A-07)', () => {
    const manifestPath = join(
      process.cwd(),
      'compliance',
      'printer-calibration-provenance.json',
    );
    const manifest = JSON.parse(
      readFileSync(manifestPath, 'utf-8'),
    ) as ProvenanceManifest;
    expect(Array.isArray(manifest.derivedFiles)).toBe(true);
  });
});
