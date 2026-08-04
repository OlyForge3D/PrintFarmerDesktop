import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CalibrationGetPrinterContextResponse,
  CalibrationListOrcaProfilesResponse,
  CalibrationListPrintersResponse,
  CalibrationSaveWorkspaceStateRequest as CalibrationSaveWorkspaceStateRequestSchema,
  CalibrationSaveWorkspaceStateResponse,
  CalibrationWorkspacePayload,
  CalibrationWorkspaceStateRecord as CalibrationWorkspaceStateRecordSchema,
} from '@shared/ipc';
import type {
  CalibrationPrinterCandidate,
  CalibrationPrinterContext,
  CalibrationQueueEventEnvelope,
  CalibrationSaveWorkspaceStateRequest,
  CalibrationWorkspaceStateRecord,
} from '@shared/ipc';
import { CalibrationWorkspace } from '../src/renderer/calibration';
import type {
  CalibrationEnvironment,
  CalibrationApi,
} from '../src/renderer/calibration/api';
import { emptyWorkflowDrafts } from '../src/renderer/calibration/workspaceTypes';
import {
  calibrationReducer,
  createCalibrationState,
  type CalibrationState,
} from '../src/renderer/calibration/domain';

const profileId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const observationId = '44444444-4444-4444-8444-444444444444';
const now = '2026-07-26T15:00:00.000Z';

function domainState(mode: 'coach' | 'expert' = 'expert'): CalibrationState {
  return createCalibrationState({
    projectId,
    createdAt: now,
    mode,
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
        backendPrinterId: 'printer-safe',
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
          {
            toolId: 'tool-b',
            toolheadId: 'head-b',
            nozzle: {
              nozzleId: 'nozzle-b',
              diameterMm: 0.6,
              material: 'hardened steel',
            },
            extruderType: 'bowden',
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

function withActiveAttempt(state = domainState()): CalibrationState {
  return calibrationReducer(state, {
    eventId: '66666666-6666-4666-8666-666666666666',
    timestamp: now,
    type: 'beginAttempt',
    attemptId,
    stageId: 'temperature',
    method: 'temperatureTower',
  });
}

function withCompletedAttempt(state = domainState()): CalibrationState {
  let next = withActiveAttempt(state);
  next = calibrationReducer(next, {
    eventId: '77777777-7777-4777-8777-777777777777',
    timestamp: now,
    type: 'recordObservation',
    attemptId,
    observation: {
      observationId,
      attemptId,
      observedAt: now,
      notes: 'Clean bridge and surface.',
      stageId: 'temperature',
      temperatureC: 215,
      quality: 5,
    },
  });
  next = calibrationReducer(next, {
    eventId: '88888888-8888-4888-8888-888888888888',
    timestamp: now,
    type: 'selectObservation',
    attemptId,
    observationId,
  });
  return calibrationReducer(next, {
    eventId: '99999999-9999-4999-8999-999999999999',
    timestamp: now,
    type: 'completeAttempt',
    attemptId,
    confidence: 'high',
  });
}

function record(
  state = domainState(),
  overrides: Partial<CalibrationWorkspaceStateRecord> = {},
): CalibrationWorkspaceStateRecord {
  return CalibrationWorkspaceStateRecordSchema.parse({
    profileId,
    projectId,
    displayName: 'PLA production calibration',
    description: 'Exact saved workspace',
    printerId: 'printer-safe',
    status: state.history.length ? 'inProgress' : 'draft',
    completedStepCount: Object.values(state.stages).filter(
      (stage) => stage.status === 'completed',
    ).length,
    totalStepCount: 9,
    isSynced: false,
    isPrinterContextFresh: true,
    hasConflicts: false,
    remoteProjectId: null,
    baseRevision: 3,
    createdAt: now,
    updatedAt: now,
    workspaceState: CalibrationWorkspacePayload.parse({
      schemaVersion: 1,
      domainState: state,
      metadata: {
        displayName: 'PLA production calibration',
        description: 'Exact saved workspace',
      },
      stepDrafts: {
        temperature: {
          prerequisites: 'Clean plate',
          methodNotes: 'Use controlled lighting',
          expectedResult: 'Clean bridge',
        },
      },
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
        printerId: 'printer-safe',
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
      autosaveRevision: 4,
    }),
    ...overrides,
  });
}

const candidates: CalibrationPrinterCandidate[] = [
  {
    printerId: 'printer-name-trap',
    displayName: 'Klipper Orca Super Printer',
    printerModel: null,
    firmwareCompatible: false,
    orcaProfileId: 'orca-base',
    isOnline: true,
    updatedAt: now,
    eligibility: null,
  },
  {
    printerId: 'printer-safe',
    displayName: 'Unbranded cell 7',
    printerModel: 'Machine 400',
    firmwareCompatible: true,
    orcaProfileId: null,
    isOnline: true,
    updatedAt: now,
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
];

const context: CalibrationPrinterContext = {
  printerId: 'printer-safe',
  displayName: 'Unbranded cell 7',
  printerModel: 'Machine 400',
  firmware: {
    firmware: 'Klipper',
    gcodeDialect: 'Klipper',
    firmwareVersion: 'v1',
    klipperConfigHash: 'hash',
  },
  orcaProfileId: 'bound-orca',
  orcaProfileDisplayName: 'Bound upstream profile',
  profileRevision: 'profile-revision-7',
  contentHash:
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bedWidthMm: 220,
  bedDepthMm: 220,
  nozzleDiameterMm: 0.4,
  snapshotAt: now,
  isCurrent: true,
  configurationId: 'configuration-1',
  configurationRevision: 7,
  snapshotId: 'snapshot-7',
  snapshotRevision: 7,
  slicerIdentity: 'OrcaSlicer',
  slicerDistribution: 'upstream',
  toolheads: [
    {
      toolId: 'tool-a',
      toolheadId: 'head-a',
      extruderType: 'directDrive',
      nozzle: { id: 'nozzle-a', diameterMm: 0.4, material: 'brass' },
    },
    {
      toolId: 'tool-b',
      toolheadId: 'head-b',
      extruderType: 'bowden',
      nozzle: { id: 'nozzle-b', diameterMm: 0.6, material: 'hardened steel' },
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
  permissions: {
    readPrinter: true,
    writeCalibration: true,
    generateCalibration: true,
    startPrint: true,
  },
};

function availability() {
  return {
    available: true,
    unavailableReason: null,
    unavailableDetail: null,
    negotiatedApiVersion: '2',
    negotiatedSchemaVersion: '2.0',
    capabilityFlags: {
      calibrationApiEnabled: true,
      calibrationChangeFeedEnabled: true,
      calibrationOfflineDraftEnabled: true,
      calibrationPhotoUploadEnabled: true,
      calibrationGenerationEnabled: true,
    },
    grantedScopes: ['CalibrationRead', 'CalibrationWrite'],
    offlineEditingEnabled: true,
  } as const;
}

function makeApi(savedRecord = record()) {
  const save = vi.fn<CalibrationApi['saveCalibrationWorkspaceState']>(
    (request: CalibrationSaveWorkspaceStateRequest) => {
      const exactRequest =
        CalibrationSaveWorkspaceStateRequestSchema.parse(request);
      return Promise.resolve(
        CalibrationSaveWorkspaceStateResponse.parse({
          queued: true,
          state: {
            ...savedRecord,
            profileId: exactRequest.profileId,
            projectId: exactRequest.projectId,
            printerId: exactRequest.printerId,
            displayName: exactRequest.displayName,
            description: exactRequest.description ?? null,
            status: exactRequest.status,
            completedStepCount: exactRequest.completedStepCount,
            totalStepCount: exactRequest.totalStepCount,
            baseRevision: exactRequest.baseRevision ?? null,
            isSynced: false,
            createdAt: exactRequest.createdAt,
            updatedAt: exactRequest.updatedAt,
            workspaceState: exactRequest.workspaceState,
          },
        }),
      );
    },
  );
  return {
    getCalibrationAvailability: vi.fn().mockResolvedValue(availability()),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [savedRecord], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockResolvedValue(savedRecord),
    saveCalibrationWorkspaceState: save,
    listCalibrationPrinters: vi.fn().mockResolvedValue(
      CalibrationListPrintersResponse.parse({
        printers: candidates,
        fetchedAt: now,
      }),
    ),
    getCalibrationPrinterContext: vi
      .fn()
      .mockResolvedValue(CalibrationGetPrinterContextResponse.parse(context)),
    listOrcaProfiles: vi.fn().mockResolvedValue(
      CalibrationListOrcaProfilesResponse.parse({
        profiles: [
          {
            orcaProfileId: 'orca-base',
            displayName: 'Explicit upstream PLA',
            vendor: 'Vendor',
            material: 'PLA',
            source: 'printFarmer',
            upstreamVerified: true,
            printerId: 'printer-safe',
            configurationRevision: 7,
            snapshotId: 'snapshot-7',
            toolId: 'tool-a',
            toolheadId: 'head-a',
            nozzleId: 'nozzle-a',
            nozzleDiameterMm: 0.4,
            profileRevision: 'profile-revision-7',
            contentHash:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            exportable: true,
          },
          {
            orcaProfileId: 'orca-tool-b',
            displayName: 'Explicit upstream PLA 0.6',
            vendor: 'Vendor',
            material: 'PLA',
            source: 'printFarmer',
            upstreamVerified: true,
            printerId: 'printer-safe',
            configurationRevision: 7,
            snapshotId: 'snapshot-7',
            toolId: 'tool-b',
            toolheadId: 'head-b',
            nozzleId: 'nozzle-b',
            nozzleDiameterMm: 0.6,
            profileRevision: 'profile-revision-7b',
            contentHash:
              'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            exportable: true,
          },
        ],
      }),
    ),
    syncCalibrationNow: vi.fn().mockResolvedValue({
      phase: 'succeeded',
      profileId,
      projectId: null,
      pushedOperations: 1,
      pulledChanges: 0,
      conflictCount: 0,
      cursor: null,
      error: null,
    }),
    openCalibrationPhoto: vi.fn().mockResolvedValue(null),
    stageCalibrationPhoto: vi.fn<CalibrationApi['stageCalibrationPhoto']>(),
    generateOrcaProfile: vi
      .fn<CalibrationApi['generateOrcaProfile']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'workspaceNotReady',
          message: 'Not implemented in test.',
          retryable: false,
        },
      }),
    exportOrcaProfile: vi
      .fn<CalibrationApi['exportOrcaProfile']>()
      .mockResolvedValue({
        status: 'canceled',
      }),
    installOrcaProfile: vi
      .fn<CalibrationApi['installOrcaProfile']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'unsupportedPlatform',
          message: 'Not implemented in test.',
          retryable: false,
        },
      }),
    restoreOrcaProfile: vi
      .fn<CalibrationApi['restoreOrcaProfile']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'unsupportedPlatform',
          message: 'Not implemented in test.',
          retryable: false,
        },
      }),
    // --- Calibration generation, queue, and bed-clear (issue #54) ----------
    startCalibrationGeneration: vi
      .fn<CalibrationApi['startCalibrationGeneration']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'serverError',
          message: 'Not implemented in test.',
          retryable: false,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    getCalibrationOrchestrationStatus: vi
      .fn<CalibrationApi['getCalibrationOrchestrationStatus']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'serverError',
          message: 'Not implemented in test.',
          retryable: false,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    getCalibrationQueueState: vi
      .fn<CalibrationApi['getCalibrationQueueState']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'serverError',
          message: 'Not implemented in test.',
          retryable: false,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    acknowledgeCalibrationBedClear: vi
      .fn<CalibrationApi['acknowledgeCalibrationBedClear']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'serverError',
          message: 'Not implemented in test.',
          retryable: false,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    startCalibrationPrint: vi
      .fn<CalibrationApi['startCalibrationPrint']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'serverError',
          message: 'Not implemented in test.',
          retryable: false,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    // --- Queue reconciliation (issue #54) ------------------------------------
    pollCalibrationQueueChanges: vi
      .fn<CalibrationApi['pollCalibrationQueueChanges']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'serverError',
          message: 'Not implemented in test.',
          retryable: false,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    getCalibrationSubscriptionResources: vi
      .fn<CalibrationApi['getCalibrationSubscriptionResources']>()
      .mockResolvedValue({
        status: 'error',
        error: {
          code: 'serverError',
          message: 'Not implemented in test.',
          retryable: false,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    // --- External calibration asset manifest (issue #54) -------------------
    getCalibrationAssetManifest: vi
      .fn<CalibrationApi['getCalibrationAssetManifest']>()
      .mockResolvedValue({
        status: 'error',
        message: 'Not implemented in test.',
      }),
    pickCalibrationAssetFile: vi
      .fn<CalibrationApi['pickCalibrationAssetFile']>()
      .mockResolvedValue({ status: 'cancelled' }),
    validateCalibrationAssetFile: vi
      .fn<CalibrationApi['validateCalibrationAssetFile']>()
      .mockResolvedValue({
        status: 'error',
        message: 'Not implemented in test.',
      }),
    // --- Allowlisted manifest URL navigation (criterion 14) ----------------
    openCalibrationManifestUrl: vi
      .fn<CalibrationApi['openCalibrationManifestUrl']>()
      .mockResolvedValue({ status: 'ok' }),
  } satisfies CalibrationApi;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function deterministicEnvironment(): CalibrationEnvironment {
  let sequence = 100;
  return {
    createId: () => {
      sequence += 1;
      return `aaaaaaaa-aaaa-4aaa-8aaa-${sequence.toString().padStart(12, '0')}`;
    },
    now: () => '2026-07-26T16:00:00.000Z',
  };
}

function renderWorkspace(
  api = makeApi(),
  selectedProfileId: string | null = profileId,
) {
  Object.defineProperty(window, 'printFarmer', {
    configurable: true,
    value: api,
  });
  const manageProfiles = vi.fn();
  let flush: (() => Promise<void>) | null = null;
  const rendered = render(
    <CalibrationWorkspace
      selectedProfileId={selectedProfileId}
      selectedProfileName="Farm server"
      onManageProfiles={manageProfiles}
      onFlushReady={(nextFlush) => {
        flush = nextFlush;
      }}
      environment={deterministicEnvironment()}
    />,
  );
  return {
    api,
    manageProfiles,
    unmount: rendered.unmount,
    flush: async (): Promise<void> => {
      if (flush === null) throw new Error('Flush was not registered.');
      await flush();
    },
  };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());

describe('CalibrationWorkspace', () => {
  it('shows precise no-profile and offline states while keeping local projects resumable', async () => {
    const noProfile = renderWorkspace(makeApi(), null);
    expect(
      await screen.findByRole('heading', { name: 'Printer Calibration' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'New calibration project' }),
    ).toBeDisabled();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Manage PrintFarmer profiles' }),
    );
    await waitFor(() =>
      expect(noProfile.manageProfiles).toHaveBeenCalledOnce(),
    );
  });

  it('uses explicit candidate eligibility independent of printer names', async () => {
    const { api } = renderWorkspace();
    fireEvent.click(
      await screen.findByRole('button', { name: 'New calibration project' }),
    );
    const trap = await screen.findByRole('radio', {
      name: /Klipper Orca Super Printer/,
    });
    fireEvent.click(trap);
    expect(
      screen.getByRole('button', { name: 'Load current printer context' }),
    ).toBeDisabled();
    expect(
      screen.getAllByText(/canonical Klipper, OrcaSlicer, upstream eligibility/)
        .length,
    ).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('radio', { name: /Unbranded cell 7/ }));
    const load = screen.getByRole('button', {
      name: 'Load current printer context',
    });
    expect(load).toBeEnabled();
    fireEvent.click(load);
    expect(
      await screen.findByText(/Context is complete and current/),
    ).toBeInTheDocument();
    expect(api.getCalibrationPrinterContext).toHaveBeenCalledWith({
      profileId,
      printerId: 'printer-safe',
    });
  });

  it('creates a complete explicit project and persists the exact workspace payload', async () => {
    const api = makeApi();
    const originalSave =
      api.saveCalibrationWorkspaceState.getMockImplementation();
    if (!originalSave)
      throw new Error('Expected the exact save implementation.');
    const saveGate = deferred<void>();
    api.saveCalibrationWorkspaceState.mockImplementationOnce(
      async (request) => {
        await saveGate.promise;
        return originalSave(request);
      },
    );
    const workspace = renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'New calibration project' }),
    );
    fireEvent.click(
      await screen.findByRole('radio', { name: /Unbranded cell 7/ }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Load current printer context' }),
    );
    await screen.findByText(/Context is complete and current/);

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Exact PETG project' },
    });
    fireEvent.change(screen.getByLabelText('Description Optional'), {
      target: { value: 'Cell-specific run' },
    });
    fireEvent.change(screen.getByLabelText('Physical tool and nozzle'), {
      target: { value: 'tool-b' },
    });
    fireEvent.click(
      screen.getByLabelText(
        /installed physical toolhead and nozzle exactly match/i,
      ),
    );
    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'Provider A' },
    });
    fireEvent.change(screen.getByLabelText('Product'), {
      target: { value: 'PETG Pro' },
    });
    fireEvent.change(screen.getByLabelText('SKU'), {
      target: { value: 'PETG-RED' },
    });
    fireEvent.change(screen.getByLabelText('Spool ID Optional'), {
      target: { value: 'spool-22' },
    });
    const baseProfile = screen.getByLabelText('Base OrcaSlicer profile');
    expect(
      within(baseProfile).queryByRole('option', {
        name: /^Explicit upstream PLA; printFarmer$/,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(baseProfile).getByRole('option', {
        name: /Explicit upstream PLA 0.6/,
      }),
    ).toBeInTheDocument();
    fireEvent.change(baseProfile, {
      target: { value: 'orca-tool-b' },
    });
    fireEvent.click(screen.getByLabelText(/Expert: additional methods/));

    const numbers: Record<string, string> = {
      'Nozzle temperature (C)': '240',
      'Flow ratio': '0.98',
      'Pressure advance (s)': '0.05',
      'Retraction length (mm)': '1.2',
      'Maximum volumetric rate (mm3/s)': '18',
      'X shrinkage compensation (%)': '100',
      'Y shrinkage compensation (%)': '100',
      'Z shrinkage compensation (%)': '100',
    };
    for (const [label, value] of Object.entries(numbers)) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(
      screen.getByLabelText(/located and can operate the emergency stop/i),
    );
    fireEvent.click(
      screen.getByLabelText(/reviewed the confirmed thermal protection/i),
    );
    fireEvent.click(
      screen.getByLabelText(/reviewed the ventilation assessment/i),
    );
    fireEvent.click(
      screen.getByLabelText(/machine, build plate, and motion area are clear/i),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create calibration project' }),
    );
    await waitFor(() =>
      expect(api.saveCalibrationWorkspaceState).toHaveBeenCalledTimes(1),
    );
    let flushFinished = false;
    const pendingFlush = workspace.flush().then(() => {
      flushFinished = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(flushFinished).toBe(false);
    await act(async () => {
      saveGate.resolve();
      await pendingFlush;
    });

    await screen.findByRole('heading', { name: 'Exact PETG project' });
    expect(api.saveCalibrationWorkspaceState).toHaveBeenCalledTimes(1);
    const request = api.saveCalibrationWorkspaceState.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      profileId,
      printerId: 'printer-safe',
      displayName: 'Exact PETG project',
      totalStepCount: 9,
      workspaceState: {
        selectedBaseProfileId: 'orca-tool-b',
        metadata: { description: 'Cell-specific run' },
        physicalMatch: {
          toolId: 'tool-b',
          toolheadId: 'head-b',
          nozzleId: 'nozzle-b',
          nozzleDiameterMm: 0.6,
        },
        domainState: {
          mode: 'expert',
          baseline: { nozzleTemperatureC: 240, flowRatio: 0.98 },
          binding: {
            selectedToolId: 'tool-b',
            selectedToolheadId: 'head-b',
            selectedNozzleId: 'nozzle-b',
            filament: {
              provider: 'Provider A',
              product: 'PETG Pro',
              sku: 'PETG-RED',
              spoolId: 'spool-22',
            },
          },
        },
      },
    });
  });

  it('denies creation when current context is incomplete or permissions are missing', async () => {
    const incomplete = {
      ...context,
      configurationId: null,
      permissions: { ...context.permissions!, writeCalibration: false },
    };
    const api = makeApi();
    api.getCalibrationPrinterContext.mockResolvedValue(incomplete);
    renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'New calibration project' }),
    );
    fireEvent.click(
      await screen.findByRole('radio', { name: /Unbranded cell 7/ }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Load current printer context' }),
    );
    expect(
      await screen.findByText(/Creation remains blocked/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/configuration identity is missing/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/calibration write is required/i),
    ).toBeInTheDocument();
    expect(api.saveCalibrationWorkspaceState).not.toHaveBeenCalled();
  });

  it('hydrates drafts, physical match, immutable attempts, selection, and recommendation exactly', async () => {
    const saved = record(withCompletedAttempt());
    renderWorkspace(makeApi(saved));
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    expect(
      await screen.findByRole('heading', {
        name: 'PLA production calibration',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/snapshot-7, revision 7/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Installed tool tool-a/)).toBeChecked();
    fireEvent.click(
      screen.getByRole('button', { name: /Open Temperature, completed/ }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Temperature' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Prerequisites and setup')).toHaveValue(
      'Clean plate',
    );
    expect(
      screen.getByText(/Attempt 1; completed; selected/),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/Use 215 .*C as the filament nozzle temperature/)
        .length,
    ).toBeGreaterThan(0);
  });

  it('runs begin, observation, select, and complete through reducer saves', async () => {
    const api = makeApi(record(domainState()));
    renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open Temperature, notStarted/,
      }),
    );
    const methodSelect = await screen.findByLabelText('Calibration method');
    await waitFor(() =>
      expect(api.saveCalibrationWorkspaceState).toHaveBeenCalled(),
    );
    const draftSessionSave =
      api.saveCalibrationWorkspaceState.mock.calls.at(-1)?.[0];
    expect(draftSessionSave?.status).toBe('inProgress');
    expect(draftSessionSave?.workspaceState.domainState.attempts).toHaveLength(
      0,
    );
    expect(
      draftSessionSave?.workspaceState.domainState.history.at(-1)?.type,
    ).toBe('navigate');
    fireEvent.change(methodSelect, {
      target: { value: 'temperatureTower' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Begin attempt' }));
    expect(
      await screen.findByText(/Attempt 1 is in progress/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Temperature (C)'), {
      target: { value: '215' },
    });
    fireEvent.change(screen.getByLabelText('Visual quality (1 to 5)'), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByLabelText('Observation notes'), {
      target: { value: 'Clean result' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add observation row' }),
    );
    const choice = await screen.findByRole('radio', {
      name: /215 C; quality 5/,
    });
    fireEvent.click(choice);
    fireEvent.click(screen.getByLabelText('high'));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Complete attempt with selected result',
      }),
    );

    await waitFor(() => {
      const requests = api.saveCalibrationWorkspaceState.mock.calls.map(
        (call) => call[0],
      );
      const types = requests.flatMap((request) =>
        request.workspaceState.domainState.history.map(
          (entry: { type: string }) => entry.type,
        ),
      );
      expect(types).toEqual(
        expect.arrayContaining([
          'beginAttempt',
          'recordObservation',
          'selectObservation',
          'completeAttempt',
        ]),
      );
    });
    expect(
      screen.getAllByText(/Use 215 .*C as the filament nozzle temperature/)
        .length,
    ).toBeGreaterThan(0);
  });

  it('supports explicit skip and immutable redo and changes method availability by mode', async () => {
    const api = makeApi(record(domainState('coach')));
    renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Open Flow pass 1/ }),
    );
    const methods = await screen.findByLabelText('Calibration method');
    expect(
      within(methods).getByRole('option', { name: 'Flow Standard' }),
    ).toBeInTheDocument();
    expect(
      within(methods).queryByRole('option', { name: 'Flow YOLO' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Flow adjustment (%)')).toHaveAttribute(
      'max',
      '20',
    );
    expect(screen.getByLabelText('Flow adjustment (%)')).toHaveAttribute(
      'step',
      '5',
    );
    fireEvent.click(screen.getByLabelText('Expert'));
    expect(
      await within(methods).findByRole('option', { name: 'Flow YOLO' }),
    ).toBeInTheDocument();
    fireEvent.change(methods, { target: { value: 'flowYolo' } });
    expect(screen.getByLabelText('Flow adjustment (%)')).toHaveAttribute(
      'max',
      '30',
    );
    expect(screen.getByLabelText('Flow adjustment (%)')).toHaveAttribute(
      'step',
      '1',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Project overview' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Open Temperature/ }),
    );
    fireEvent.change(await screen.findByLabelText('Calibration method'), {
      target: { value: 'temperatureTower' },
    });
    fireEvent.change(screen.getByLabelText('Skip or redo reason'), {
      target: { value: 'Existing controlled result' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Skip stage with reason' }),
    );
    expect(
      await screen.findByText('skipped', { selector: 'dd' }),
    ).toBeInTheDocument();
    expect(
      api.saveCalibrationWorkspaceState.mock.calls.some((call) =>
        call[0].workspaceState.domainState.history.some(
          (event: { type: string }) => event.type === 'skipStage',
        ),
      ),
    ).toBe(true);
  });

  it('stages opaque approved photo IDs and handles cancel and format failure', async () => {
    const saved = record(withActiveAttempt());
    const api = makeApi(saved);
    api.openCalibrationPhoto
      .mockResolvedValueOnce({
        approvalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        approvalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      })
      .mockResolvedValueOnce({
        approvalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      });
    api.stageCalibrationPhoto
      .mockImplementationOnce((request) =>
        Promise.resolve({
          ...request,
          contentHash: 'a'.repeat(64),
          mimeType: 'image/png',
          byteSize: 2048,
          status: 'staged',
          uploadAttempts: 0,
          remotePhotoId: null,
          remoteUrl: null,
          stagedAt: now,
          uploadedAt: null,
        }),
      )
      .mockRejectedValueOnce(
        new Error('Unsupported JPEG, PNG, and WebP format'),
      )
      .mockRejectedValueOnce(new Error('Approval already consumed and reused'));
    renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open Temperature, inProgress/,
      }),
    );

    fireEvent.change(await screen.findByLabelText('Attempt'), {
      target: { value: attemptId },
    });
    fireEvent.change(await screen.findByLabelText('Accessible caption'), {
      target: { value: 'Clean temperature bridge' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose and stage approved photo' }),
    );
    expect(
      await screen.findByText(/Photo metadata staged locally/),
    ).toBeInTheDocument();
    expect(screen.getByText(/image\/png; 2048 bytes/)).toBeInTheDocument();
    expect(api.stageCalibrationPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        stageId: 'temperature',
        attemptId,
        caption: 'Clean temperature bridge',
      }),
    );
    expect(api.stageCalibrationPhoto.mock.calls[0]?.[0]).not.toHaveProperty(
      'path',
    );

    const photoSave = api.saveCalibrationWorkspaceState.mock.calls.at(-1)?.[0];
    expect(photoSave?.workspaceState.photos).toHaveLength(1);
    const savedPhoto = photoSave?.workspaceState.photos[0];
    expect(savedPhoto?.photoId).toEqual(expect.any(String));
    expect(savedPhoto).toMatchObject({
      attemptId,
      stageId: 'temperature',
      contentHash: 'a'.repeat(64),
      mimeType: 'image/png',
      byteSize: 2048,
      status: 'staged',
      caption: 'Clean temperature bridge',
      order: 1,
      stagedAt: now,
    });
    expect(photoSave?.workspaceState.workflowDrafts.temperature).toMatchObject({
      photoAttemptId: attemptId,
      photoCaption: '',
      photoOrder: 2,
    });

    fireEvent.change(await screen.findByLabelText('Accessible caption'), {
      target: { value: 'Canceled image' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose and stage approved photo' }),
    );
    expect(await screen.findByText(/selection canceled/)).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText('Accessible caption'), {
      target: { value: 'Invalid image' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose and stage approved photo' }),
    );
    expect(await screen.findByRole('alert', { name: '' })).toHaveTextContent(
      /Photo format is invalid/,
    );

    fireEvent.change(await screen.findByLabelText('Accessible caption'), {
      target: { value: 'Reused approval' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose and stage approved photo' }),
    );
    expect(
      await screen.findByText(/already used.*already consumed/i),
    ).toBeInTheDocument();

    const malformedApproval = {
      approvalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    Reflect.deleteProperty(malformedApproval, 'approvalId');
    api.openCalibrationPhoto.mockResolvedValueOnce(malformedApproval);
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose and stage approved photo' }),
    );
    expect(
      await screen.findByText(/photo approval response was invalid/i),
    ).toBeInTheDocument();
    expect(api.stageCalibrationPhoto).toHaveBeenCalledTimes(3);
  });

  it('debounces metadata autosave and serializes all existing workspace fields', async () => {
    const api = makeApi();
    renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    await screen.findByRole('heading', { name: 'PLA production calibration' });
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Renamed exact project' },
    });
    expect(api.saveCalibrationWorkspaceState).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(api.saveCalibrationWorkspaceState).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.saveCalibrationWorkspaceState).toHaveBeenCalledTimes(1);
    expect(api.saveCalibrationWorkspaceState.mock.calls[0]?.[0]).toMatchObject({
      displayName: 'Renamed exact project',
      workspaceState: {
        metadata: {
          displayName: 'Renamed exact project',
          description: 'Exact saved workspace',
        },
        stepDrafts: { temperature: { prerequisites: 'Clean plate' } },
        selectedBaseProfileId: 'orca-base',
        physicalMatch: { snapshotId: 'snapshot-7' },
        autosaveRevision: 5,
      },
    });
  });

  it('requires a newer same-identity snapshot, reason, and explicit retest stages for rebase', async () => {
    const stale = record(withCompletedAttempt(), {
      isPrinterContextFresh: false,
    });
    const api = makeApi(stale);
    api.getCalibrationPrinterContext.mockResolvedValue({
      ...context,
      configurationRevision: 8,
      snapshotId: 'snapshot-8',
      snapshotRevision: 8,
      snapshotAt: '2026-07-26T17:00:00.000Z',
    });
    api.listOrcaProfiles.mockResolvedValue({
      profiles: [
        {
          orcaProfileId: 'orca-base',
          displayName: 'Explicit upstream PLA',
          vendor: 'Vendor',
          material: 'PLA',
          source: 'printFarmer',
          upstreamVerified: true,
          printerId: 'printer-safe',
          configurationRevision: 8,
          snapshotId: 'snapshot-8',
          toolId: 'tool-a',
          toolheadId: 'head-a',
          nozzleId: 'nozzle-a',
          nozzleDiameterMm: 0.4,
          profileRevision: 'profile-revision-7',
          contentHash:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          exportable: true,
        },
      ],
    });
    renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Refresh current printer context',
      }),
    );
    expect(
      await screen.findByText(/Compared snapshot snapshot-8, revision 8/),
    ).toBeInTheDocument();
    const rebase = screen.getByRole('button', {
      name: 'Rebase snapshot and require retests',
    });
    expect(rebase).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Rebase reason'), {
      target: { value: 'Configuration revision changed' },
    });
    fireEvent.click(
      screen.getByLabelText('Temperature', { selector: 'input' }),
    );
    expect(rebase).toBeEnabled();
    fireEvent.click(rebase);
    await waitFor(() => {
      const requests = api.saveCalibrationWorkspaceState.mock.calls.map(
        (call) => call[0],
      );
      expect(
        requests.some((request) =>
          request.workspaceState.domainState.history.some(
            (event: { type: string }) => event.type === 'rebaseSnapshot',
          ),
        ),
      ).toBe(true);
      expect(requests.at(-1)?.workspaceState.physicalMatch).toBeNull();
    });
  });

  it('keeps persisted projects editable offline but blocks creation and sync', async () => {
    const api = makeApi();
    api.getCalibrationAvailability.mockRejectedValue(
      new Error('network offline'),
    );
    renderWorkspace(api);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Offline/);
    expect(
      screen.getByRole('button', { name: 'New calibration project' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Sync and retry' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /PLA production calibration/ }),
    ).toBeEnabled();
  });

  it('redoes a resolved stage as a new attempt without changing old history', async () => {
    const api = makeApi(record(withCompletedAttempt()));
    renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open Temperature, completed/,
      }),
    );
    fireEvent.change(await screen.findByLabelText('Calibration method'), {
      target: { value: 'temperatureTower' },
    });
    fireEvent.change(screen.getByLabelText('Skip or redo reason'), {
      target: { value: 'Retest after maintenance' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Redo as new immutable attempt' }),
    );
    expect(
      await screen.findByText(/Attempt 2 is in progress/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Attempt 1; completed/)).toBeInTheDocument();
    const latest = api.saveCalibrationWorkspaceState.mock.calls.at(-1)?.[0];
    expect(latest).toBeDefined();
    if (!latest) throw new Error('Expected a redo save request.');
    expect(latest.workspaceState.domainState.attempts).toHaveLength(2);
    expect(latest.workspaceState.domainState.history.at(-1)).toMatchObject({
      type: 'redoStage',
      reason: 'Retest after maintenance',
    });
  });

  it('renders print-safe history and exact profile patch preview without fake install success', async () => {
    renderWorkspace(makeApi(record(withCompletedAttempt())));
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Calibration card' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Immutable attempt history' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          element.textContent?.includes('Selected observation: 215 C') === true,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('cell', { name: 'nozzle_temperature' }),
    ).toBeInTheDocument();

    expect(screen.getByText('Not synchronized')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Profile patch' }));
    expect(
      await screen.findByRole('heading', {
        name: 'OrcaSlicer profile patch preview',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Explicit upstream PLA')).toBeInTheDocument();
    expect(screen.getByText('orca-base')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Generate OrcaSlicer profile' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Resolve blockers before generating a profile/),
    ).toBeInTheDocument();
  });

  it('keeps an empty metadata draft out of reducer saves and persists a trimmed retype', async () => {
    const api = makeApi();
    const workspace = renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    const name = await screen.findByLabelText('Project name');
    fireEvent.change(name, { target: { value: '' } });
    expect(name).toHaveValue('');
    expect(screen.getByRole('alert')).toHaveTextContent(
      /last valid name remains saved/i,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Open Flow pass 1, notStarted/ }),
    );
    await screen.findByRole('heading', { name: 'Flow pass 1' });
    await waitFor(() =>
      expect(api.saveCalibrationWorkspaceState).toHaveBeenCalled(),
    );
    const navigationSave =
      api.saveCalibrationWorkspaceState.mock.calls.at(-1)?.[0];
    expect(navigationSave?.displayName).toBe('PLA production calibration');
    expect(navigationSave?.workspaceState.metadata.displayName).toBe(
      'PLA production calibration',
    );
    expect(
      navigationSave?.workspaceState.domainState.history.at(-1)?.type,
    ).toBe('navigate');

    fireEvent.click(screen.getByRole('button', { name: 'Project overview' }));
    const emptyDraft = await screen.findByLabelText('Project name');
    expect(emptyDraft).toHaveValue('');
    fireEvent.change(emptyDraft, {
      target: { value: '  Retyped valid project  ' },
    });
    await act(async () => {
      await workspace.flush();
    });
    const retypeSave = api.saveCalibrationWorkspaceState.mock.calls.at(-1)?.[0];
    expect(retypeSave?.displayName).toBe('Retyped valid project');
    expect(retypeSave?.workspaceState.metadata.displayName).toBe(
      'Retyped valid project',
    );
  });

  it('preserves a newer field edit while an earlier autosave is in flight', async () => {
    const api = makeApi();
    const originalSave =
      api.saveCalibrationWorkspaceState.getMockImplementation();
    if (!originalSave)
      throw new Error('Expected the exact save implementation.');
    const gate = deferred<void>();
    api.saveCalibrationWorkspaceState.mockImplementationOnce(
      async (request) => {
        await gate.promise;
        return originalSave(request);
      },
    );
    const workspace = renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    const description = await screen.findByLabelText('Description');
    fireEvent.change(description, { target: { value: 'First queued edit' } });

    let firstFlush: Promise<void> | undefined;
    act(() => {
      firstFlush = workspace.flush();
    });
    await waitFor(() =>
      expect(api.saveCalibrationWorkspaceState).toHaveBeenCalledTimes(1),
    );
    fireEvent.change(description, {
      target: { value: 'Newer edit while save is pending' },
    });
    await act(async () => {
      gate.resolve();
      await firstFlush;
    });
    await act(async () => {
      await workspace.flush();
    });

    const latest = api.saveCalibrationWorkspaceState.mock.calls.at(-1)?.[0];
    expect(latest?.description).toBe('Newer edit while save is pending');
    expect(latest?.workspaceState.metadata.description).toBe(
      'Newer edit while save is pending',
    );
  });

  it('persists and restores all nine workflow drafts without creating an implicit attempt', async () => {
    const original = record();
    const workflowDrafts = {
      ...emptyWorkflowDrafts(),
      flowPass1: {
        ...emptyWorkflowDrafts().flowPass1,
        method: 'flowYolo' as const,
        observation: {
          ...emptyWorkflowDrafts().flowPass1.observation,
          primary: '7',
          quality: '4',
          notes: 'Inspect three adjacent samples.',
        },
        confidence: 'medium' as const,
        reason: 'Draft retest rationale',
        photoCaption: 'Pending flow sample',
        photoOrder: 3,
      },
      finalVerification: {
        ...emptyWorkflowDrafts().finalVerification,
        method: 'verificationPrint' as const,
        observation: {
          ...emptyWorkflowDrafts().finalVerification.observation,
          primary: '0',
          passed: true,
          notes: 'Clean verification draft.',
        },
      },
      shrinkage: {
        ...emptyWorkflowDrafts().shrinkage,
        method: 'dimensionalCoupon' as const,
        observation: {
          ...emptyWorkflowDrafts().shrinkage.observation,
          nominalXmm: '100',
          nominalYmm: '101',
          nominalZmm: '102',
          measuredXmm: '99.5',
          measuredYmm: '100.5',
          measuredZmm: '101.5',
          notes: 'Cooled for two hours.',
        },
      },
    };
    const draftRecord: CalibrationWorkspaceStateRecord = {
      ...original,
      status: 'inProgress',
      workspaceState: CalibrationWorkspacePayload.parse({
        ...original.workspaceState,
        workflowDrafts,
      }),
    };
    const firstApi = makeApi(draftRecord);
    const first = renderWorkspace(firstApi);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Open Flow pass 1/ }),
    );
    expect(await screen.findByLabelText('Calibration method')).toHaveValue(
      'flowYolo',
    );
    expect(screen.getByLabelText('Flow adjustment (%)')).toHaveValue(7);
    expect(screen.getByLabelText('Visual quality (1 to 5)')).toHaveValue(4);
    expect(screen.getByLabelText('Observation notes')).toHaveValue(
      'Inspect three adjacent samples.',
    );
    expect(screen.getByLabelText('medium')).toBeChecked();
    expect(screen.getByLabelText('Skip or redo reason')).toHaveValue(
      'Draft retest rationale',
    );
    expect(screen.getByLabelText('Accessible caption')).toHaveValue(
      'Pending flow sample',
    );
    expect(screen.getByLabelText('Reading order')).toHaveValue(3);
    expect(
      screen.getByText(/Draft in progress.*no immutable attempt/i),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Calibration method'), {
      target: { value: 'flowCoarse' },
    });
    fireEvent.change(screen.getByLabelText('Flow adjustment (%)'), {
      target: { value: '-10' },
    });
    fireEvent.change(screen.getByLabelText('Observation notes'), {
      target: { value: 'Retyped exact sample.' },
    });
    await act(async () => {
      await first.flush();
    });
    const request =
      firstApi.saveCalibrationWorkspaceState.mock.calls.at(-1)?.[0];
    expect(request?.status).toBe('inProgress');
    expect(request?.workspaceState.domainState.attempts).toHaveLength(0);
    expect(request?.workspaceState.domainState.stages.flowPass1.status).toBe(
      'notStarted',
    );
    expect(Object.keys(request?.workspaceState.workflowDrafts ?? {})).toEqual([
      'temperature',
      'flowPass1',
      'flowPass2',
      'pressureAdvance',
      'flowVerification',
      'retraction',
      'maximumVolumetricSpeed',
      'shrinkage',
      'finalVerification',
    ]);
    expect(request?.workspaceState.workflowDrafts.flowPass1).toMatchObject({
      method: 'flowCoarse',
      observation: { primary: '-10', notes: 'Retyped exact sample.' },
      confidence: 'medium',
      reason: 'Draft retest rationale',
      photoCaption: 'Pending flow sample',
      photoOrder: 3,
    });
    if (!request) throw new Error('Expected an exact workflow draft save.');
    first.unmount();

    const restartRecord: CalibrationWorkspaceStateRecord = {
      ...record(request.workspaceState.domainState),
      displayName: request.displayName,
      description: request.description ?? null,
      status: request.status,
      updatedAt: request.updatedAt,
      workspaceState: request.workspaceState,
    };
    renderWorkspace(makeApi(restartRecord));
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Open Flow pass 1/ }),
    );
    expect(await screen.findByLabelText('Calibration method')).toHaveValue(
      'flowCoarse',
    );
    expect(screen.getByLabelText('Flow adjustment (%)')).toHaveValue(-10);
    expect(screen.getByLabelText('Observation notes')).toHaveValue(
      'Retyped exact sample.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Project overview' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Open Final verification/ }),
    );
    expect(
      await screen.findByLabelText('Verification passed cleanly'),
    ).toBeChecked();
    expect(screen.getByLabelText('Defect count (defects)')).toHaveValue(0);

    fireEvent.click(screen.getByRole('button', { name: 'Project overview' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Open Shrinkage/ }),
    );
    expect(await screen.findByLabelText('Nominal X')).toHaveValue(100);
    expect(screen.getByLabelText('Measured X')).toHaveValue(99.5);
    expect(screen.getByLabelText('Nominal Y')).toHaveValue(101);
    expect(screen.getByLabelText('Measured Y')).toHaveValue(100.5);
    expect(screen.getByLabelText('Nominal Z')).toHaveValue(102);
    expect(screen.getByLabelText('Measured Z')).toHaveValue(101.5);
  });

  it('surfaces migration-required remote records and sends the strict sync request', async () => {
    const api = makeApi();
    api.listCalibrationWorkspaceStates.mockResolvedValue({
      states: [record()],
      unhydratedProjects: [
        {
          profileId,
          projectId: '12121212-1212-4212-8212-121212121212',
          displayName: 'Remote legacy calibration',
          description: null,
          printerId: 'printer-safe',
          status: 'draft',
          isSynced: true,
          isPrinterContextFresh: false,
          hasConflicts: false,
          remoteProjectId: '13131313-1313-4313-8313-131313131313',
          baseRevision: 4,
          createdAt: now,
          updatedAt: now,
          recoveryState: 'migrationRequired',
        },
      ],
    });
    renderWorkspace(api);
    expect(
      await screen.findByRole('heading', { name: 'Remote recovery required' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No renderer domain state was fabricated/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Sync and retry this project' }),
    );
    await waitFor(() =>
      expect(api.syncCalibrationNow).toHaveBeenCalledWith({
        profileId,
        projectId: '12121212-1212-4212-8212-121212121212',
      }),
    );
    expect(api.syncCalibrationNow.mock.calls[0]?.[0]).not.toHaveProperty(
      'operationId',
    );
  });

  it('shows recovery instead of defaulting malformed domain state', async () => {
    const valid = record();
    const malformed = structuredClone(valid);
    Reflect.set(malformed.workspaceState, 'domainState', {
      schemaVersion: 1,
      projectId,
    });
    const api = makeApi(malformed);
    renderWorkspace(api);
    expect(await screen.findByText('Recovery required')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) => /malformed/i.test(alert.textContent ?? '')),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: /PLA production calibration/ }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Project recovery required' }),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) =>
          /not replaced with defaults/i.test(alert.textContent ?? ''),
        ),
    ).toBe(true);
  });

  it('settles explicit empty printer and profile discovery without retry loops', async () => {
    const api = makeApi();
    api.listCalibrationPrinters.mockResolvedValue({
      printers: [],
      fetchedAt: now,
    });
    api.listOrcaProfiles.mockResolvedValue({ profiles: [] });
    renderWorkspace(api);

    fireEvent.click(
      await screen.findByRole('button', { name: 'New calibration project' }),
    );
    expect(
      await screen.findByText('No printer candidates were returned.'),
    ).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.listCalibrationPrinters).toHaveBeenCalledOnce();
    expect(api.listOrcaProfiles).toHaveBeenCalledOnce();
  });

  it('flushes pending debounced metadata to the local queue when leaving the workspace', async () => {
    const api = makeApi();
    const workspace = renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    await screen.findByRole('heading', { name: 'PLA production calibration' });
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Flush before workspace switch' },
    });

    await act(async () => {
      await workspace.flush();
    });
    workspace.unmount();
    expect(api.saveCalibrationWorkspaceState).toHaveBeenCalledOnce();
    const flushed = api.saveCalibrationWorkspaceState.mock.calls[0]?.[0];
    expect(flushed?.displayName).toBe('Flush before workspace switch');
    expect(flushed?.workspaceState.metadata.displayName).toBe(
      'Flush before workspace switch',
    );
  });

  it('keeps the calibration renderer inside the narrow bridge boundary', () => {
    const root = join(process.cwd(), 'src', 'renderer', 'calibration');
    const readSources = (directory: string): string =>
      readdirSync(directory, { withFileTypes: true })
        .map((entry) => {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) return readSources(path);
          return /\.(ts|tsx)$/.test(entry.name)
            ? readFileSync(path, 'utf8')
            : '';
        })
        .join('\n');
    const source = readSources(root);
    for (const forbidden of [
      'ipc' + 'Renderer',
      'navigator' + '.clipboard',
      'local' + 'Storage',
      'session' + 'Storage',
      'indexed' + 'DB',
      'XML' + 'HttpRequest',
      'globalThis' + '.fetch',
      'window' + '.fetch',
      'child_' + 'process',
      'node:' + 'fs',
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toContain('selection' + '.path');
  });

  // ---------------------------------------------------------------------------
  // Handoff section integration: generation → queue → bed-clear → lifecycle
  // (criteria 4, 7, 8, 9, 10, 11, 12, 13 — issue #54)
  // ---------------------------------------------------------------------------

  const HANDOFF_QUEUE_JOB_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const HANDOFF_ORCH_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const HANDOFF_PRINTER_ID = 'printer-safe';

  function queueJobFixture(
    overrides: {
      status?: string;
      dispatchAttemptOutcome?: string | null;
      bedClearState?: string;
      pinnedPrinterConfigRevision?: number | null;
      gcodeFileId?: string | null;
      assignedPrinterName?: string | null;
      /** Criterion 10 / 7: firmware family required by the job. */
      requiredFirmwareFamily?: string | null;
      /** Criterion 10: filament SKU required by the job. */
      requiredFilamentSku?: string | null;
      /** Criterion 11: machine profile SHA-256 recorded at job creation. */
      machineProfileSha256?: string | null;
      /** Criterion 7: distinct attempt ID to trigger reorder detection. */
      calibrationAttemptId?: string;
    } = {},
  ) {
    return {
      status: 'ok' as const,
      job: {
        jobId: HANDOFF_QUEUE_JOB_ID,
        jobKind: 'FilamentCalibration',
        rowVersion: 'AAAA==',
        dispatchStateRowVersion: 'BBBB==',
        status: overrides.status ?? 'Queued',
        dispatchAttemptOutcome: overrides.dispatchAttemptOutcome ?? null,
        bedClearState: overrides.bedClearState ?? 'None',
        gcodeFileId:
          overrides.gcodeFileId !== undefined ? overrides.gcodeFileId : null,
        assignedPrinterId: HANDOFF_PRINTER_ID,
        assignedPrinterName:
          overrides.assignedPrinterName !== undefined
            ? overrides.assignedPrinterName
            : null,
        calibrationProjectId: projectId,
        calibrationAttemptId:
          overrides.calibrationAttemptId !== undefined
            ? overrides.calibrationAttemptId
            : attemptId,
        pinnedPrinterConfigRevision:
          overrides.pinnedPrinterConfigRevision !== undefined
            ? overrides.pinnedPrinterConfigRevision
            : 7,
        priority: 1,
        queuePosition: 1,
        updatedAt: now,
        // Criterion 10: new optional fields
        requiredFirmwareFamily:
          overrides.requiredFirmwareFamily !== undefined
            ? overrides.requiredFirmwareFamily
            : null,
        requiredFilamentSku:
          overrides.requiredFilamentSku !== undefined
            ? overrides.requiredFilamentSku
            : null,
        // Criterion 11: stale profile detection
        machineProfileSha256:
          overrides.machineProfileSha256 !== undefined
            ? overrides.machineProfileSha256
            : null,
      },
    };
  }

  async function openStepView(api: ReturnType<typeof makeApi>) {
    renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    // Match any stage status (notStarted, inProgress, etc.)
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Open Temperature/,
      }),
    );
    await screen.findByRole('heading', { name: 'Temperature' });
  }

  it('CalibrationQueueDispatchPanel appears when a queue job exists (criterion 8)', async () => {
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    await openStepView(api);

    // Panel is always rendered when queue state loads from the useEffect
    expect(
      await screen.findByRole('heading', { name: 'Queue State', level: 3 }),
    ).toBeInTheDocument();
    expect(await screen.findByText(HANDOFF_QUEUE_JOB_ID)).toBeInTheDocument();
    expect(
      await screen.findByText('Queued — waiting for printer'),
    ).toBeInTheDocument();
  });

  it('Unknown dispatch outcome renders as "Starting" with reconciliation note and no retry button (criterion 9)', async () => {
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ dispatchAttemptOutcome: 'Unknown' }),
    );
    await openStepView(api);

    // Dispatch Outcome section shows "Starting" not "Unknown"
    expect(await screen.findByText('Starting')).toBeInTheDocument();
    // Reconciliation guidance is present (no blind-retry)
    expect(await screen.findByText(/Do not retry/)).toBeInTheDocument();
    // No "Retry" button anywhere in the dispatch panel
    const panel = await screen.findByLabelText('Queue and dispatch status');
    expect(
      within(panel).queryByRole('button', { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Accessible name, live-region mount order, and the retry/do-not-retry
  // co-render (issues #226, #242, #225 — all in CalibrationQueueDispatchPanel)
  // ---------------------------------------------------------------------------

  it('dispatch panel exposes an accessible name via a role that supports one (issue #226)', async () => {
    // The twelve findByLabelText('Queue and dispatch status') calls in this file
    // matched the aria-label ATTRIBUTE, which testing-library reads directly.
    // They passed for as long as the attribute sat on a role-less <div>, where
    // the implicit `generic` role means assistive technology never exposes it.
    // Only a role query computes the accessible name, so this is the only
    // assertion in the file that can fail when role="region" is removed.
    //
    // Mutation: delete role="region" from CalibrationQueueDispatchPanel.tsx →
    // this test fails naming the role and name it could not find, while every
    // findByLabelText assertion in this file stays green. That asymmetry is
    // the defect, demonstrated.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    await openStepView(api);

    expect(
      await screen.findByRole('region', {
        name: 'Queue and dispatch status',
      }),
      'the panel has an aria-label but no role that supports an accessible name',
    ).toBeInTheDocument();
  });

  /** Envelope that flips only the dispatch outcome to Unknown (issues #242/#225). */
  function unknownOutcomeEvent(): CalibrationQueueEventEnvelope {
    return {
      schemaVersion: '1',
      eventId: 'aaaabbbb-0000-4000-8000-000000000042',
      sequence: 1,
      eventType: 'CalibrationJobDispatchStateChanged',
      occurredAtUtc: now,
      jobId: HANDOFF_QUEUE_JOB_ID,
      printerId: HANDOFF_PRINTER_ID,
      projectId: null,
      calibrationAttemptId: null,
      jobStatus: null,
      jobKind: null,
      jobRevision: null,
      dispatchStateRevision: null,
      attemptId: null,
      attemptNumber: null,
      attemptOutcome: 'Unknown',
      bedClearState: null,
      bedClearCommandId: null,
      bedClearExpiresAtUtc: null,
      failureCode: null,
      failureRetryable: null,
      failureRequiresReconciliation: null,
      jobLogicalRevision: null,
      dispatchStateLogicalRevision: null,
    };
  }

  /**
   * Holds the first poll open so a test can observe the pre-transition DOM,
   * then release it with the supplied events. Without this the poll resolves
   * during `openStepView` and any "before" assertion races the transition it
   * is supposed to be the control for.
   */
  function deferFirstPoll(api: ReturnType<typeof makeApi>): {
    fire: (events: CalibrationQueueEventEnvelope[]) => void;
  } {
    const handle = { fire: undefined as unknown as (e: never[]) => void };
    api.pollCalibrationQueueChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          handle.fire = (events: CalibrationQueueEventEnvelope[]) =>
            resolve({
              status: 'ok',
              afterSequence: 0,
              nextSequence: 5,
              hasMore: false,
              gapDetected: false,
              events,
            });
        }),
    );
    api.pollCalibrationQueueChanges.mockResolvedValue({
      status: 'ok',
      afterSequence: 5,
      nextSequence: 5,
      hasMore: false,
      gapDetected: false,
      events: [],
    });
    return handle as {
      fire: (events: CalibrationQueueEventEnvelope[]) => void;
    };
  }

  it('reconciliation live region exists before there is any guidance to put in it (issue #242)', async () => {
    // A live region announces CHANGES to content it already held. A region
    // inserted already carrying its text is a new subtree and is broadly not
    // announced. The dangerous path is opening this view on a job whose outcome
    // is ALREADY Unknown — which is exactly what the pre-existing criterion-9
    // test above drives, and it asserts only presence, so it passes under the
    // defect it reproduces.
    //
    // Falsifier: re-wrap the guidance container in
    // `queueState?.dispatchAttemptOutcome === 'Unknown' && (...)`, or move it
    // back inside the <dl>, and the findByRole below fails naming the region it
    // could not find — because under either arrangement no region exists while
    // there is nothing to say.
    //
    // The panel's own first render always precedes its fetch resolving, so the
    // region proven here is in place for the already-Unknown path too.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ dispatchAttemptOutcome: null }),
    );
    const poll = deferFirstPoll(api);

    await openStepView(api);

    const liveRegion = await screen.findByRole('status', {
      name: 'Dispatch reconciliation guidance',
    });
    // Emptiness is the requirement, not an accident.
    expect(
      liveRegion,
      'the live region already held content before any outcome existed',
    ).toBeEmptyDOMElement();

    act(() => {
      poll.fire([unknownOutcomeEvent()]);
    });

    // Same node, now populated: an announced change, not an insertion.
    await waitFor(() => {
      expect(liveRegion).toHaveTextContent(/Do not retry/);
    });
    expect(liveRegion).toHaveTextContent(/check the printer/);
  });

  it('shows the operator the quotable reference when the detail was withheld (issue #177)', async () => {
    // The catalogued message is what the renderer now receives instead of the
    // backend's ProblemDetails `detail`. That closes the leak and removes the
    // only actionable string the failure had, so the reference is what has to
    // reach the screen -- a reference carried in the IPC payload and never
    // rendered satisfies the ruling in the type and fails it for the operator.
    //
    // The panel only mounts once a queue job has loaded, so the failure has to
    // be reached the way it is reached in production: a successful first fetch,
    // then a gap-triggered refetch that returns an error response.
    const api = makeApi(record(domainState()));
    const REFERENCE = '7f1c9a34-2b6e-4d51-9a02-5c8e3f0b71d4';
    let failFetch = false;
    api.getCalibrationQueueState.mockImplementation(() => {
      if (failFetch)
        return Promise.resolve({
          status: 'error' as const,
          error: {
            code: 'workerUnavailable' as const,
            message: 'No generation worker is available.',
            retryable: true,
            retryAfterSeconds: null,
            reference: REFERENCE,
          },
        });
      return Promise.resolve(queueJobFixture());
    });

    let fireGap!: () => void;
    api.pollCalibrationQueueChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          fireGap = () =>
            resolve({
              status: 'ok',
              afterSequence: 0,
              nextSequence: 5,
              hasMore: false,
              gapDetected: true,
              events: [],
            });
        }),
    );
    api.pollCalibrationQueueChanges.mockResolvedValue({
      status: 'ok',
      afterSequence: 5,
      nextSequence: 5,
      hasMore: false,
      gapDetected: false,
      events: [],
    });

    await openStepView(api);
    const panel = await screen.findByRole('region', {
      name: 'Queue and dispatch status',
    });

    failFetch = true;
    act(() => {
      fireGap();
    });

    // Precondition: the failure actually rendered. Without this the reference
    // assertion below would pass on a panel that never showed an error.
    const alert = await within(panel).findByText(
      /No generation worker is available\./,
    );
    expect(
      (alert.textContent ?? '').includes(REFERENCE),
      `the reference is absent from the rendered failure, so the operator has nothing to quote for a detail that was withheld. Rendered text: ${alert.textContent ?? ''}`,
    ).toBe(true);
  });

  it('shows no reference when the failure withheld nothing to reference (issue #177)', async () => {
    // Discriminating control for the test above. Without it a formatter that
    // appended a reference unconditionally -- including `undefined` or an empty
    // one -- would satisfy every assertion there while telling the operator to
    // quote a value that does not exist.
    const api = makeApi(record(domainState()));
    let failFetch = false;
    api.getCalibrationQueueState.mockImplementation(() => {
      if (failFetch)
        return Promise.resolve({
          status: 'error' as const,
          error: {
            code: 'jobNotFound' as const,
            message: 'No queue job to look up.',
            retryable: false,
            retryAfterSeconds: null,
            reference: null,
          },
        });
      return Promise.resolve(queueJobFixture());
    });

    let fireGap!: () => void;
    api.pollCalibrationQueueChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          fireGap = () =>
            resolve({
              status: 'ok',
              afterSequence: 0,
              nextSequence: 5,
              hasMore: false,
              gapDetected: true,
              events: [],
            });
        }),
    );
    api.pollCalibrationQueueChanges.mockResolvedValue({
      status: 'ok',
      afterSequence: 5,
      nextSequence: 5,
      hasMore: false,
      gapDetected: false,
      events: [],
    });

    await openStepView(api);
    const panel = await screen.findByRole('region', {
      name: 'Queue and dispatch status',
    });

    failFetch = true;
    act(() => {
      fireGap();
    });

    const alert = await within(panel).findByText(/No queue job to look up\./);
    expect(
      alert.textContent ?? '',
      'a reference was rendered for a failure that carried none, so the operator is being told to quote a value that does not exist',
    ).not.toMatch(/Reference/i);
  });

  it('guidance arrives into the already-mounted region on the transition path (issue #242)', async () => {
    // Second entry path: an outcome that is already non-null and non-Unknown
    // later becomes Unknown. This is the path that announces correctly even
    // under the old arrangement, so it exists to make a regression on either
    // path attributable rather than to prove the fix on its own.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ dispatchAttemptOutcome: 'InProgress' }),
    );
    const poll = deferFirstPoll(api);

    await openStepView(api);

    const liveRegion = await screen.findByRole('status', {
      name: 'Dispatch reconciliation guidance',
    });
    // Positive control for the fixture: prove the panel really reached a
    // non-Unknown outcome first, so "the region was empty" is a live
    // observation and not the fixture silently producing no outcome at all.
    expect(await screen.findByText(/Dispatch in progress/)).toBeInTheDocument();
    expect(liveRegion).toBeEmptyDOMElement();

    act(() => {
      poll.fire([unknownOutcomeEvent()]);
    });

    await waitFor(() => {
      expect(liveRegion).toHaveTextContent(/Do not retry/);
    });
  });

  it('a failed refetch beside an Unknown outcome does not offer a bare "Retry" (issue #225)', async () => {
    // #225 was filed without a test because constructing the co-render by hand
    // would have proven nothing about whether it is reachable. This drives it
    // through production transitions instead: the success path clears
    // `fetchError`, the failure path does NOT clear `queueState`, so a refetch
    // that fails while an outcome is unresolved renders both blocks. Reaching
    // it via gap detection is what makes this a reachability proof.
    //
    // Mutation: restore the button's label to "Retry" → the first assertion
    // fails naming the accessible name it could not find, and the second fails
    // having found a control named exactly "Retry".
    const api = makeApi(record(domainState()));
    let failFetch = false;
    api.getCalibrationQueueState.mockImplementation(() => {
      // An eager mockRejectedValue creates a rejected promise at setup time and
      // reports as an unhandled rejection if the panel has not called it yet.
      // Rejecting from inside the implementation keeps the rejection attached
      // to the call that caused it.
      if (failFetch) return Promise.reject(new Error('Network timeout'));
      return Promise.resolve(
        queueJobFixture({ dispatchAttemptOutcome: 'Unknown' }),
      );
    });

    let fireGap!: () => void;
    api.pollCalibrationQueueChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          fireGap = () =>
            resolve({
              status: 'ok',
              afterSequence: 0,
              nextSequence: 5,
              hasMore: false,
              gapDetected: true,
              events: [],
            });
        }),
    );
    api.pollCalibrationQueueChanges.mockResolvedValue({
      status: 'ok',
      afterSequence: 5,
      nextSequence: 5,
      hasMore: false,
      gapDetected: false,
      events: [],
    });

    await openStepView(api);
    const panel = await screen.findByRole('region', {
      name: 'Queue and dispatch status',
    });
    expect(await screen.findByText(/Do not retry/)).toBeInTheDocument();

    // Gap → refetch → rejection → fetchError set, queueState retained.
    failFetch = true;
    act(() => {
      fireGap();
    });

    // Precondition: the co-render actually happened. Without this the
    // assertions below would pass on a panel that never showed an error.
    // Targeted by text because the panel legitimately carries more than one
    // role="alert" (the blocked-reason banner is the other).
    await waitFor(() => {
      expect(within(panel).getByText('Network timeout')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Do not retry/),
      'the guidance was dropped, so this is no longer a co-render test',
    ).toBeInTheDocument();

    expect(
      within(panel).getByRole('button', { name: 'Retry loading status' }),
      'the refresh control does not name what it retries',
    ).toBeInTheDocument();
    expect(
      within(panel).queryByRole('button', { name: 'Retry' }),
      'a bare "Retry" renders beside "Do not retry — a duplicate print may result"',
    ).not.toBeInTheDocument();
  });

  it('staleTelemetry blocked reason renders in dispatch panel (criterion 10)', async () => {
    // Mutation test: remove `staleTelemetry` branch from computedBlockedReason →
    // no alert → this test fails.
    const api = makeApi(
      record(domainState(), { isPrinterContextFresh: false }),
    );
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    await waitFor(() => {
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Stale telemetry',
      );
    });
  });

  it('configChange blocked reason renders when pinnedRevision differs from binding (criterion 10)', async () => {
    // Mutation test: remove `configChange` branch from computedBlockedReason →
    // no alert → this test fails.
    const api = makeApi(record(domainState()));
    // Binding revision is 7; pinning to 5 causes configChange.
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ pinnedPrinterConfigRevision: 5 }),
    );
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    await waitFor(() => {
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Configuration changed',
      );
    });
  });

  it('printerOffline blocked reason renders when availability rejects (criterion 10)', async () => {
    // Mutation test: remove `printerOffline` branch → no alert → test fails.
    const api = makeApi(record(domainState()));
    api.getCalibrationAvailability.mockRejectedValue(
      new Error('Network timeout'),
    );
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    // When offline, the panel shows its own offline banner AND the blockedReason
    // banner (both carry role="alert"). Check specifically for the blockedReason
    // detail text which only appears when computedBlockedReason === 'printerOffline'.
    await waitFor(() => {
      expect(
        within(panel).getByText(/Check network and Klipper status/i),
      ).toBeInTheDocument();
    });
  });

  it('gap detection triggers getCalibrationQueueState refetch (criterion 8)', async () => {
    // Mutation test: delete onGapDetected() call at CalibrationQueueDispatchPanel.tsx:168
    // Strategy: defer the first poll so we can clear the call counter AFTER all
    // initialization calls are done. Then fire the gap response and assert ≥1
    // NEW call. Without the onGapDetected() call, count stays at 0 → test fails.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());

    // First poll hangs until fireGap() is called.
    let fireGap!: () => void;
    api.pollCalibrationQueueChanges.mockImplementationOnce(
      () =>
        new Promise<{
          status: 'ok';
          afterSequence: number;
          nextSequence: number;
          hasMore: boolean;
          gapDetected: boolean;
          events: CalibrationQueueEventEnvelope[];
        }>((resolve) => {
          fireGap = () =>
            resolve({
              status: 'ok',
              afterSequence: 0,
              nextSequence: 5,
              hasMore: false,
              gapDetected: true,
              events: [],
            });
        }),
    );
    // Subsequent polls: gap-free so the loop settles.
    api.pollCalibrationQueueChanges.mockResolvedValue({
      status: 'ok',
      afterSequence: 5,
      nextSequence: 5,
      hasMore: false,
      gapDetected: false,
      events: [],
    });

    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    // All initialization calls (workflow + panel) are done. Zero out the counter.
    api.getCalibrationQueueState.mockClear();

    // Fire the deferred gap response. This triggers onGapDetected() → refetchJobState().
    act(() => {
      fireGap();
    });

    // Mutation test: delete onGapDetected() → no refetch → mock stays at 0 → fails.
    await waitFor(() => {
      expect(
        api.getCalibrationQueueState.mock.calls.length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('redacted Printer-group envelope (jobId:null) is NOT applied to job state (criterion 8)', async () => {
    // Mutation test: remove `evt.jobId === jobId` guard at line 174 of
    // CalibrationQueueDispatchPanel.tsx → the Cancelled status is applied →
    // 'Queued — waiting for printer' text disappears → this test fails.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    api.pollCalibrationQueueChanges.mockResolvedValueOnce({
      status: 'ok',
      afterSequence: 0,
      nextSequence: 10,
      hasMore: false,
      gapDetected: false,
      events: [
        {
          schemaVersion: '1',
          eventId: 'aaaabbbb-0000-4000-8000-000000000001',
          sequence: 1,
          eventType: 'PrinterGroupStateChanged',
          occurredAtUtc: now,
          jobId: null, // redacted envelope — must not touch job state
          printerId: HANDOFF_PRINTER_ID,
          projectId: null,
          calibrationAttemptId: null,
          jobStatus: 'Cancelled', // would be catastrophic if applied
          jobKind: null,
          jobRevision: null,
          dispatchStateRevision: null,
          attemptId: null,
          attemptNumber: null,
          attemptOutcome: null,
          bedClearState: null,
          bedClearCommandId: null,
          bedClearExpiresAtUtc: null,
          failureCode: null,
          failureRetryable: null,
          failureRequiresReconciliation: null,
          jobLogicalRevision: null,
          dispatchStateLogicalRevision: null,
        },
      ],
    });

    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    // Job status must remain "Queued", not "Cancelled"
    expect(
      await screen.findByText('Queued — waiting for printer'),
    ).toBeInTheDocument();
  });

  it('CalibrationOrchestrationProgress shows free-form status from server (criterion 4)', async () => {
    const api = makeApi(record(withActiveAttempt(), { isSynced: true }));
    api.startCalibrationGeneration.mockResolvedValue({
      status: 'submitted',
      orchestrationId: HANDOFF_ORCH_ID,
    });
    api.getCalibrationOrchestrationStatus.mockResolvedValue({
      status: 'ok',
      orchestration: {
        id: HANDOFF_ORCH_ID,
        projectId,
        attemptId,
        operationId: 'op-1',
        status: 'Running',
        currentStep: 'TemperatureSensing',
        revision: 1,
        retryCount: 0,
        nextRetryAtUtc: null,
        stepStartedAtUtc: null,
        lastErrorCode: null,
        problems: [],
        model3DId: null,
        sliceJobId: null,
        workerId: null,
        sourceArtifactId: null,
        finalArtifactId: null,
        gcodeFileId: null,
        specificationSha256: null,
        planManifestSha256: null,
        gcodeSha256: null,
        manifestSha256: null,
        generatorVersion: null,
        slicerContainerDigest: null,
        slicerBinarySha256: null,
        statusRoute: '/api/calibration-orchestrations/' + HANDOFF_ORCH_ID,
        createdAtUtc: now,
        updatedAtUtc: now,
        completedAtUtc: null,
      },
    });
    await openStepView(api);

    // Click Generate — enabled because isSynced+physicalMatch+online
    const generateButton = await screen.findByRole('button', {
      name: 'Generate calibration model',
    });
    fireEvent.click(generateButton);

    // Progress panel appears with free-form status "Running"
    expect(await screen.findByText('Running')).toBeInTheDocument();
    // And the free-form current step is rendered verbatim
    expect(await screen.findByText('TemperatureSensing')).toBeInTheDocument();
  });

  it('unrecognised orchestration status renders verbatim without crash (criterion 4)', async () => {
    const api = makeApi(record(withActiveAttempt(), { isSynced: true }));
    api.startCalibrationGeneration.mockResolvedValue({
      status: 'submitted',
      orchestrationId: HANDOFF_ORCH_ID,
    });
    api.getCalibrationOrchestrationStatus.mockResolvedValue({
      status: 'ok',
      orchestration: {
        id: HANDOFF_ORCH_ID,
        projectId,
        attemptId,
        operationId: 'op-1',
        status: 'QuantumEntangled',
        currentStep: 'NeuralCalibrationPass',
        revision: 1,
        retryCount: 0,
        nextRetryAtUtc: null,
        stepStartedAtUtc: null,
        lastErrorCode: null,
        problems: [],
        model3DId: null,
        sliceJobId: null,
        workerId: null,
        sourceArtifactId: null,
        finalArtifactId: null,
        gcodeFileId: null,
        specificationSha256: null,
        planManifestSha256: null,
        gcodeSha256: null,
        manifestSha256: null,
        generatorVersion: null,
        slicerContainerDigest: null,
        slicerBinarySha256: null,
        statusRoute: '/api/calibration-orchestrations/' + HANDOFF_ORCH_ID,
        createdAtUtc: now,
        updatedAtUtc: now,
        completedAtUtc: null,
      },
    });
    await openStepView(api);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Generate calibration model',
      }),
    );
    // Unrecognised status rendered verbatim — no crash, no blank
    expect(await screen.findByText('QuantumEntangled')).toBeInTheDocument();
    expect(
      await screen.findByText('NeuralCalibrationPass'),
    ).toBeInTheDocument();
  });

  it('CalibrationProvenance appears in project overview when a queue job is loaded (criterion 11)', async () => {
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    renderWorkspace(api);

    // Navigate to overview (not step view — provenance is in ProjectOverview)
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );
    // Now we're in the overview view (default after project click)
    await screen.findByRole('heading', { name: 'PLA production calibration' });

    // Provenance section should appear with the job ID
    expect(
      await screen.findByText(new RegExp(HANDOFF_QUEUE_JOB_ID.slice(0, 8))),
    ).toBeInTheDocument();
  });

  it('CalibrationPrintLifecycle shows status and accepts append-only observations (criterion 13)', async () => {
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ status: 'Completed' }),
    );
    await openStepView(api);

    // Lifecycle panel shows the completed status
    expect(
      await screen.findByRole('region', { name: 'Print lifecycle' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('✓ Completed')).toBeInTheDocument();

    // Add first observation
    const resultSelect = screen.getByLabelText('Result');
    fireEvent.change(resultSelect, { target: { value: 'accepted' } });
    const confidenceSelect = screen.getByLabelText('Confidence');
    fireEvent.change(confidenceSelect, { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Observation' }));

    // First observation appears (each list item has aria-label="Observation N")
    await screen.findByRole('listitem', { name: 'Observation 1' });

    // Add a second observation — first must still be present
    fireEvent.change(resultSelect, { target: { value: 'rejected' } });
    fireEvent.change(confidenceSelect, { target: { value: 'low' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Observation' }));

    // Both observations are in the DOM (append-only)
    await waitFor(() => {
      expect(
        screen.getByRole('listitem', { name: 'Observation 1' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('listitem', { name: 'Observation 2' }),
      ).toBeInTheDocument();
    });
  });

  describe('bed-clear dialog accessibility (criterion 12)', () => {
    async function openBedClearDialog(api: ReturnType<typeof makeApi>) {
      api.getCalibrationQueueState.mockResolvedValue(
        queueJobFixture({ bedClearState: 'None' }),
      );
      await openStepView(api);

      const confirmButton = await screen.findByRole('button', {
        name: 'Confirm bed clear',
      });
      await waitFor(() => expect(confirmButton).not.toBeDisabled());
      // Explicitly focus the button so the dialog captures it as the restore target
      act(() => {
        confirmButton.focus();
      });
      fireEvent.click(confirmButton);
      return await screen.findByRole('dialog');
    }

    it('opens with role=dialog aria-modal and initial focus on close button', async () => {
      const api = makeApi(record(domainState()));
      const dialog = await openBedClearDialog(api);

      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      // Initial focus is moved to first focusable element (Close ×)
      await waitFor(() => {
        const closeBtn = within(dialog).getByRole('button', {
          name: 'Close dialog',
        });
        expect(document.activeElement).toBe(closeBtn);
      });
    });

    it('Escape closes dialog and restores focus to trigger button', async () => {
      const api = makeApi(record(domainState()));
      await openBedClearDialog(api);

      const trigger = screen.getByRole('button', { name: 'Confirm bed clear' });

      // Fire Escape on document (useFocusTrap listens on document)
      fireEvent.keyDown(document, {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });

      // Dialog closes
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );

      // Focus is restored to the trigger button
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    it('Tab from last focusable element wraps focus to first focusable', async () => {
      const api = makeApi(record(domainState()));
      const dialog = await openBedClearDialog(api);

      const closeBtn = within(dialog).getByRole('button', {
        name: 'Close dialog',
      });
      const allButtons = within(dialog).getAllByRole('button');
      const lastButton = allButtons[allButtons.length - 1]!;

      // Move focus to the last button explicitly
      act(() => {
        lastButton.focus();
      });
      expect(document.activeElement).toBe(lastButton);

      // Tab from last should cycle back to first
      fireEvent.keyDown(document, {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });

      expect(document.activeElement).toBe(closeBtn);
    });

    it('Shift+Tab from first focusable wraps focus to last focusable', async () => {
      const api = makeApi(record(domainState()));
      const dialog = await openBedClearDialog(api);

      const allButtons = within(dialog).getAllByRole('button');
      const firstButton = allButtons[0]!;
      const lastButton = allButtons[allButtons.length - 1]!;

      // Move focus to first button explicitly
      act(() => {
        firstButton.focus();
      });
      expect(document.activeElement).toBe(firstButton);

      // Shift+Tab from first should wrap to last
      fireEvent.keyDown(document, {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });

      expect(document.activeElement).toBe(lastButton);
    });

    it('countdown announces via aria-live when expiry propagates from poll event (criterion 12)', async () => {
      // Mutation test: remove onBedClearExpiryChange call from handleEvent in
      // CalibrationQueueDispatchPanel → bedClearExpiresAt never set → countdown
      // never fires → /expires in \d+ second/i match fails.
      vi.useFakeTimers({ toFake: ['Date'] });
      const fixedNow = new Date('2026-07-26T16:00:00.000Z').getTime();
      vi.setSystemTime(fixedNow);
      const expiresAt = new Date(fixedNow + 20_000).toISOString(); // 20 s from now (within 30-second window)

      const api = makeApi(record(domainState()));
      api.getCalibrationQueueState.mockResolvedValue(
        queueJobFixture({ bedClearState: 'None' }),
      );
      // First poll delivers a bed-clear-expiry event for our specific job.
      api.pollCalibrationQueueChanges.mockResolvedValueOnce({
        status: 'ok',
        afterSequence: 0,
        nextSequence: 5,
        hasMore: false,
        gapDetected: false,
        events: [
          {
            schemaVersion: '1',
            eventId: 'ccccdddd-0000-4000-8000-000000000001',
            sequence: 1,
            eventType: 'BedClearRequested',
            occurredAtUtc: now,
            jobId: HANDOFF_QUEUE_JOB_ID,
            printerId: HANDOFF_PRINTER_ID,
            projectId,
            calibrationAttemptId: attemptId,
            jobStatus: 'Assigned',
            jobKind: 'FilamentCalibration',
            jobRevision: 'AAAA==',
            dispatchStateRevision: 'BBBB==',
            attemptId: null,
            attemptNumber: null,
            attemptOutcome: 'InProgress',
            bedClearState: 'None',
            bedClearCommandId: null,
            bedClearExpiresAtUtc: expiresAt,
            failureCode: null,
            failureRetryable: null,
            failureRequiresReconciliation: null,
            jobLogicalRevision: null,
            dispatchStateLogicalRevision: null,
          },
        ],
      });

      await openStepView(api);

      const confirmButton = await screen.findByRole('button', {
        name: 'Confirm bed clear',
      });
      await waitFor(() => expect(confirmButton).not.toBeDisabled());
      act(() => {
        confirmButton.focus();
      });
      fireEvent.click(confirmButton);
      await screen.findByRole('dialog');

      // After the poll event is processed, bedClearExpiresAt propagates into the
      // dialog which then shows the countdown. Target the dialog's specific live
      // region (not [aria-live="assertive"] which also matches the blocked-reason
      // alert in the panel).
      await waitFor(() => {
        const liveRegion = document.querySelector(
          '.calibration-bed-clear-dialog__live-region',
        );
        expect(liveRegion?.textContent).toMatch(/expires in \d+ second/i);
      });

      vi.useRealTimers();
    });

    it('dialog shows material and nozzle from project binding (criterion 12)', async () => {
      // Mutation test: remove material wiring from bedClearDialogJob in
      // CalibrationStepWorkflow → material is null → "Material Co PLA Pro" absent
      // → within(dialog).getByText('Material Co PLA Pro') throws → test fails.
      const api = makeApi(record(domainState()));
      api.getCalibrationQueueState.mockResolvedValue(
        queueJobFixture({ bedClearState: 'None' }),
      );
      const dialog = await openBedClearDialog(api);

      // Material = binding.filament.provider + ' ' + product
      expect(
        within(dialog).getByText('Material Co PLA Pro'),
      ).toBeInTheDocument();
      // Nozzle = selectedTool (tool-a): 0.4 mm brass
      expect(within(dialog).getByText('0.4 mm brass')).toBeInTheDocument();
    });

    it('revisionConflict (412) closes dialog and updates ETags for the next attempt (criterion 6)', async () => {
      // Mutation test: remove ETag update from revisionConflict branch →
      // second call still uses 'AAAA==' rowVersion → expect(...).toBe('CONFLICT_JOB==')
      // fails.
      const api = makeApi(record(domainState()));
      api.getCalibrationQueueState.mockResolvedValue(
        queueJobFixture({ bedClearState: 'None' }),
      );
      // First ack returns 412 with authoritative ETags.
      api.acknowledgeCalibrationBedClear
        .mockResolvedValueOnce({
          status: 'revisionConflict',
          jobRowVersion: 'CONFLICT_JOB==',
          dispatchStateRowVersion: 'CONFLICT_DISP==',
        })
        .mockResolvedValueOnce({
          status: 'ok',
          jobRowVersion: null,
          dispatchStateRowVersion: null,
        });

      // Open dialog
      await openBedClearDialog(api);

      // Click confirm inside dialog — triggers handleBedClearConfirm
      const confirmBedClearBtn = screen.getByRole('button', {
        name: 'Confirm Bed Clear',
      });
      fireEvent.click(confirmBedClearBtn);

      // Dialog should close (revisionConflict path closes without showing error)
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      // Re-open dialog (ETags should now be updated)
      const triggerBtn = await screen.findByRole('button', {
        name: 'Confirm bed clear',
      });
      await waitFor(() => expect(triggerBtn).not.toBeDisabled());
      act(() => {
        triggerBtn.focus();
      });
      fireEvent.click(triggerBtn);
      await screen.findByRole('dialog');

      const confirmBedClearBtn2 = screen.getByRole('button', {
        name: 'Confirm Bed Clear',
      });
      fireEvent.click(confirmBedClearBtn2);

      // The second ack call must carry the 412-supplied ETags.
      await waitFor(() => {
        const calls = api.acknowledgeCalibrationBedClear.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(2);
        const secondArgs = calls[1]?.[0];
        expect(secondArgs?.rowVersion).toBe('CONFLICT_JOB==');
        expect(secondArgs?.dispatchStateRowVersion).toBe('CONFLICT_DISP==');
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Criterion 10 — four new blocked reason branches
  // ─────────────────────────────────────────────────────────────────────────

  it('maintenanceBusy blocked reason when availability.unavailableReason is operatorDisabled (criterion 10)', async () => {
    // Mutation test: remove the operatorDisabled branch → renders printerOffline
    // instead → "Printer in maintenance" absent → test fails.
    const api = makeApi(record(domainState()));
    api.getCalibrationAvailability.mockResolvedValue({
      ...availability(),
      available: false,
      unavailableReason: 'operatorDisabled',
    });
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    await waitFor(() => {
      // When availability is false+operatorDisabled, both the offline banner and
      // the maintenanceBusy blocked reason render as alert roles. Check the text
      // directly rather than expecting a single alert.
      expect(
        within(panel).getByText(/Printer in maintenance/),
      ).toBeInTheDocument();
    });
  });

  it('permissionFailure blocked reason when CalibrationWrite scope is absent (criterion 10)', async () => {
    // Mutation test: remove the grantedScopes branch → returns null → no alert
    // → test fails.
    const api = makeApi(record(domainState()));
    api.getCalibrationAvailability.mockResolvedValue({
      ...availability(),
      available: true,
      grantedScopes: ['CalibrationRead'], // CalibrationWrite absent
    });
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    await waitFor(() => {
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Permission denied',
      );
    });
  });

  it('firmwareChange blocked reason when requiredFirmwareFamily is not Klipper (criterion 10)', async () => {
    // Mutation test: remove requiredFirmwareFamily branch → returns null → no
    // alert → test fails.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ requiredFirmwareFamily: 'Marlin' }),
    );
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    await waitFor(() => {
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Firmware changed',
      );
    });
  });

  it('materialMismatch blocked reason when requiredFilamentSku differs from binding.filament.sku (criterion 10)', async () => {
    // Mutation test: remove requiredFilamentSku branch → returns null → no
    // alert → test fails.
    // Binding filament sku = 'PLA-BLK'; job requires 'PETG-RED'.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ requiredFilamentSku: 'PETG-RED' }),
    );
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    await waitFor(() => {
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Material mismatch',
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Criterion 7 — extended canAcknowledge guards
  // ─────────────────────────────────────────────────────────────────────────

  it('expired bed-clear acknowledgement blocks canAcknowledge hint (criterion 7)', async () => {
    // Mutation test: remove isExpired check from canAcknowledge → hint appears
    // even after expiry → expect(...).not.toBeInTheDocument() fails.
    //
    // Strategy: deliver a poll event that carries a bedClearExpiresAtUtc value
    // in the past (2 hours ago). The component sets bedClearExpiresAt from the
    // event and computes isExpired = Date.parse(...) <= Date.now(). Since the
    // timestamp is well in the past, isExpired becomes true immediately and the
    // acknowledgement hint must be absent.
    const api = makeApi(record(domainState()));

    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ bedClearState: 'None', gcodeFileId: 'gcode-1' }),
    );

    // Use a timestamp guaranteed to be far in the past.
    const farPastExpiry = new Date(Date.now() - 7200_000).toISOString();
    api.pollCalibrationQueueChanges.mockResolvedValue({
      status: 'ok',
      afterSequence: 0,
      nextSequence: 1,
      hasMore: false,
      gapDetected: false,
      events: [
        {
          schemaVersion: '3',
          eventId: 'aaaabbbb-0000-4000-8000-000000000010',
          sequence: 1,
          eventType: 'JobStateChanged',
          occurredAtUtc: now,
          jobId: HANDOFF_QUEUE_JOB_ID,
          printerId: HANDOFF_PRINTER_ID,
          projectId: projectId,
          calibrationAttemptId: attemptId,
          jobStatus: 'WaitingForBedClear',
          jobKind: 'FilamentCalibration',
          jobRevision: 'AAAA==',
          dispatchStateRevision: 'BBBB==',
          attemptId: null,
          attemptNumber: null,
          attemptOutcome: null,
          bedClearState: 'None',
          bedClearCommandId: null,
          bedClearExpiresAtUtc: farPastExpiry,
          failureCode: null,
          failureRetryable: null,
          failureRequiresReconciliation: null,
          jobLogicalRevision: null,
          dispatchStateLogicalRevision: null,
        },
      ],
    });

    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    // The acknowledgement hint must NOT be visible when the window has expired.
    await waitFor(() => {
      expect(
        within(panel).queryByText(/Bed-clear acknowledgement is available/i),
      ).not.toBeInTheDocument();
    });
  });

  it('reordered job (calibrationAttemptId change) blocks canAcknowledge hint (criterion 7)', async () => {
    // Mutation test: remove !isReordered from canAcknowledge → hint appears
    // even after reorder → expect(...).not.toBeInTheDocument() fails.
    //
    // Strategy:
    //   Call #1 (workflow mount) → original attemptId
    //   Call #2 (panel initial fetch) → original attemptId (sets initialAttemptIdRef)
    //   First poll returns gapDetected=true → panel refetches
    //   Call #3 (gap refetch) → replacement attemptId → setIsReordered(true)
    // With !isReordered in canAcknowledge and gcodeFileId non-null (no other
    // blocked reason), the hint is absent; panel shows "Queue position changed".
    const api = makeApi(record(domainState()));

    const originalFixture = queueJobFixture({
      bedClearState: 'None',
      calibrationAttemptId: 'attempt-original',
      gcodeFileId: 'gcode-1',
    });
    const replacementFixture = queueJobFixture({
      bedClearState: 'None',
      calibrationAttemptId: 'attempt-replacement',
      gcodeFileId: 'gcode-1',
    });

    // Panel calls include jobId; ProjectOverview and workflow-mount calls do not.
    // Use that to give the panel's initial fetch 'original' and subsequent
    // panel fetches (gap-triggered) 'replacement'. This is robust regardless
    // of how many non-panel calls fire before the panel mounts.
    let panelFetchCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.getCalibrationQueueState.mockImplementation((req: any) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (req.jobId != null) {
        panelFetchCount += 1;
        return Promise.resolve(
          panelFetchCount <= 1 ? originalFixture : replacementFixture,
        );
      }
      return Promise.resolve(originalFixture);
    });

    // A single gap drives the refetchJobState call.
    api.pollCalibrationQueueChanges.mockResolvedValueOnce({
      status: 'ok',
      afterSequence: 0,
      nextSequence: 1,
      hasMore: false,
      gapDetected: true,
      events: [],
    });
    api.pollCalibrationQueueChanges.mockResolvedValue({
      status: 'ok',
      afterSequence: 1,
      nextSequence: 1,
      hasMore: false,
      gapDetected: false,
      events: [],
    });

    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    // After reorder detection the "Queue position changed" banner appears.
    await waitFor(() => {
      expect(
        within(panel).getByText(/Queue position changed/i),
      ).toBeInTheDocument();
    });
    // Acknowledgement hint must be absent — isReordered blocks canAcknowledge.
    expect(
      within(panel).queryByText(/Bed-clear acknowledgement is available/i),
    ).not.toBeInTheDocument();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Criterion 11 — provenance fields wired from real orchestration data
  // ─────────────────────────────────────────────────────────────────────────

  it('machineProfileSha256 is wired from selectedBaseProfile.contentHash when queueing (criterion 11)', async () => {
    // Mutation test: null machineProfileSha256 in handleQueuePrint → assert below
    // finds null, not the real hash → fails.
    // selectedBaseProfile.contentHash fixture value:
    //   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' (64 a's)
    const api = makeApi(record(withActiveAttempt(), { isSynced: true }));
    api.getCalibrationOrchestrationStatus.mockResolvedValue({
      status: 'ok',
      orchestration: {
        id: HANDOFF_ORCH_ID,
        projectId,
        attemptId,
        operationId: 'op-1',
        status: 'Completed',
        currentStep: 'Completed',
        revision: 2,
        retryCount: 0,
        nextRetryAtUtc: null,
        stepStartedAtUtc: null,
        lastErrorCode: null,
        problems: [],
        model3DId: 'model-1',
        sliceJobId: 'slice-1',
        workerId: null,
        sourceArtifactId: null,
        finalArtifactId: null,
        gcodeFileId: 'gcode-1',
        specificationSha256: null,
        planManifestSha256: null,
        gcodeSha256: null,
        manifestSha256: null,
        generatorVersion: null,
        slicerContainerDigest: null,
        slicerBinarySha256: null,
        statusRoute: '/api/calibration-orchestrations/' + HANDOFF_ORCH_ID,
        createdAtUtc: now,
        updatedAtUtc: now,
        completedAtUtc: null,
      },
    });
    api.startCalibrationGeneration.mockResolvedValue({
      status: 'submitted',
      orchestrationId: HANDOFF_ORCH_ID,
    });
    api.startCalibrationPrint.mockResolvedValue({
      status: 'ok',
      jobId: HANDOFF_QUEUE_JOB_ID,
      rowVersion: 'BBBB==',
      dispatchStateRowVersion: 'CCCC==',
      replayed: false,
    });

    await openStepView(api);

    // Trigger generation to populate orchId then queue print.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Generate calibration model' }),
    );
    await waitFor(() =>
      expect(api.getCalibrationOrchestrationStatus).toHaveBeenCalled(),
    );
    const queueBtn = await screen.findByRole('button', {
      name: 'Queue calibration print',
    });
    await waitFor(() => expect(queueBtn).not.toBeDisabled());
    fireEvent.click(queueBtn);

    await waitFor(() => expect(api.startCalibrationPrint).toHaveBeenCalled());
    const callArg = api.startCalibrationPrint.mock.calls[0]?.[0];
    expect(callArg?.machineProfileSha256).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(callArg?.requiredFirmwareFamily).toBe('Klipper');
    expect(callArg?.requiredGcodeDialect).toBe('Klipper');
    // filamentProfileSha256 must be null — not a mirror of machineProfileSha256.
    // The workspace persists only one profile hash (the machine base profile);
    // there is no distinct filament-profile hash to record.
    // Mutation test: set filamentProfileSha256 = machineProfileSha256 → this
    // expect(null) fails, catching the false-provenance regression.
    expect(callArg?.filamentProfileSha256).toBeNull();
  });

  it('stale machineProfileSha256 (job differs from selectedBaseProfile) causes configChange block (criterion 11)', async () => {
    // Mutation test: remove the machineProfileSha256 comparison from
    // computedBlockedReason → stale job no longer triggers configChange →
    // alert absent → test fails.
    // Job was created with hash bbbb... but current profile has aaaa...
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({
        machineProfileSha256:
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }),
    );
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    const panel = await screen.findByLabelText('Queue and dispatch status');
    await waitFor(() => {
      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Configuration changed',
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Criterion 13 — durable observation persistence via workspace-state path
  // ─────────────────────────────────────────────────────────────────────────

  it('adding an observation persists it via saveCalibrationWorkspaceState (criterion 13)', async () => {
    // Mutation test: make storePrintObservation a no-op (comment out the
    // bumpAndSave call) → saveCalibrationWorkspaceState is never called with
    // printObservations → expect(...).toHaveBeenCalledWith() fails.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ status: 'Completed' }),
    );
    await openStepView(api);

    // Lifecycle panel requires a non-null printStatus — 'Completed' propagates.
    const resultSelect = await screen.findByLabelText('Result');
    fireEvent.change(resultSelect, { target: { value: 'accepted' } });
    const confidenceSelect = screen.getByLabelText('Confidence');
    fireEvent.change(confidenceSelect, { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Observation' }));

    await waitFor(() => {
      const lastCall = api.saveCalibrationWorkspaceState.mock.calls.at(-1)?.[0];
      expect(lastCall?.workspaceState?.printObservations).toHaveLength(1);
      expect(
        lastCall?.workspaceState?.printObservations?.[0]?.selectedResult,
      ).toBe('accepted');
      expect(lastCall?.workspaceState?.printObservations?.[0]?.attemptId).toBe(
        attemptId,
      );
    });
  });

  it('print observations survive remount (durable persistence) (criterion 13)', async () => {
    // Mutation test: read printObservations from volatile useState instead of
    // workspace state → observations absent on mount without re-adding →
    // findByRole('listitem') fails.
    const prePopObs = {
      observationId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099',
      attemptId,
      jobId: HANDOFF_QUEUE_JOB_ID,
      recordedAt: now,
      selectedResult: 'accepted' as const,
      confidence: 'high' as const,
      retestRequired: false,
      notes: '',
      photoIds: [] as string[],
    };
    const defaultRecord = record(domainState());
    const prePopRecord = record(domainState(), {
      workspaceState: CalibrationWorkspacePayload.parse({
        ...defaultRecord.workspaceState,
        printObservations: [prePopObs],
      }),
    });
    const api = makeApi(prePopRecord);
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ status: 'Completed' }),
    );
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });
    // The observation must be visible from workspace state alone — no user
    // interaction, proving it survives a simulated remount/reload.
    await screen.findByRole('listitem', { name: 'Observation 1' });
  });

  it('observations survive job invalidation (failure/cancel preserves history) (criterion 13)', async () => {
    // Mutation test: make storePrintObservation a no-op → observation never
    // stored in workspace state → 'Observation 1' absent at findByRole →
    // test fails.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ status: 'Completed' }),
    );
    await openStepView(api);

    // Add an observation first.
    const resultSelect = await screen.findByLabelText('Result');
    fireEvent.change(resultSelect, { target: { value: 'accepted' } });
    const confidenceSelect = screen.getByLabelText('Confidence');
    fireEvent.change(confidenceSelect, { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Observation' }));
    await screen.findByRole('listitem', { name: 'Observation 1' });

    // Invalidate the job by sending a Cancelled event.
    api.pollCalibrationQueueChanges.mockResolvedValue({
      status: 'ok',
      afterSequence: 0,
      nextSequence: 1,
      hasMore: false,
      gapDetected: false,
      events: [
        {
          schemaVersion: '3',
          eventId: 'aaaabbbb-0000-4000-8000-000000000020',
          sequence: 1,
          eventType: 'JobStateChanged',
          occurredAtUtc: now,
          jobId: HANDOFF_QUEUE_JOB_ID,
          printerId: HANDOFF_PRINTER_ID,
          projectId: projectId,
          calibrationAttemptId: attemptId,
          jobStatus: 'Cancelled',
          jobKind: 'FilamentCalibration',
          jobRevision: 'AAAA==',
          dispatchStateRevision: 'BBBB==',
          attemptId: null,
          attemptNumber: null,
          attemptOutcome: null,
          bedClearState: 'None',
          bedClearCommandId: null,
          bedClearExpiresAtUtc: null,
          failureCode: null,
          failureRetryable: null,
          failureRequiresReconciliation: null,
          jobLogicalRevision: null,
          dispatchStateLogicalRevision: null,
        },
      ],
    });

    // Wait for the event to be processed. The panel's event loop calls
    // onJobInvalidated, which does NOT clear printObservations.
    await waitFor(() => {
      // The lifecycle panel remains visible because observations persist.
      expect(
        screen.getByRole('listitem', { name: 'Observation 1' }),
      ).toBeInTheDocument();
    });
  });

  it('stage status does not auto-complete when queue job reports Completed (criterion 13)', async () => {
    // Mutation test: auto-advance domain state to completed on queue completion
    // → step card shows completed status → assertion fails.
    // This test drives through the step list which should NOT show the stage
    // as "completed" simply because the queue job finished.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(
      queueJobFixture({ status: 'Completed' }),
    );

    renderWorkspace(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /PLA production calibration/ }),
    );

    // The step button in the list should NOT bear a "Completed" label.
    // It remains "not started" or "in progress" — the queue outcome does not
    // automatically close the calibration attempt.
    const stepButton = await screen.findByRole('button', {
      name: /Open Temperature/,
    });
    // The button's accessible name should not include "Completed"
    expect(stepButton.getAttribute('aria-label')).not.toMatch(/completed/i);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Criterion 14 — manifest checksum storage and allowlisted URL navigation
  // ─────────────────────────────────────────────────────────────────────────

  it('validated asset SHA-256 is stored and displayed after Pick+Validate (criterion 14)', async () => {
    // Mutation test: make storeAttemptAssetSha256 a no-op → SHA-256 is never
    // persisted to workspace state → displaySha256 is null → the element has
    // no text content → toHaveTextContent('cccc...') fails.
    const api = makeApi(record(withActiveAttempt(domainState())));
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    api.pickCalibrationAssetFile.mockResolvedValue({
      status: 'ok',
      approvalId: 'aaaabbbb-0000-4000-8000-000000000099',
      byteSize: 1024,
      extension: '3mf',
    });
    api.validateCalibrationAssetFile.mockResolvedValue({
      status: 'ok',
      sha256:
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      byteSize: 1024,
      extension: '3mf',
      contentType: 'model/3mf',
      checksumVerified: true,
      validationNotes: [],
    });

    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    fireEvent.click(await screen.findByTestId('pick-validate-asset'));

    await waitFor(() => {
      const sha256El = screen.getByTestId('validated-asset-sha256');
      expect(sha256El).toHaveTextContent(
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      );
    });

    // Verify durable write: saveCalibrationWorkspaceState must have been
    // called with the SHA-256 keyed by the active attempt ID.
    await waitFor(() => {
      const lastCall = api.saveCalibrationWorkspaceState.mock.calls.at(-1)?.[0];
      expect(
        lastCall?.workspaceState?.assetSha256ByAttemptId?.[attemptId],
      ).toBe(
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      );
    });
  });

  it('asset SHA-256 survives remount (durable persistence) (criterion 14)', async () => {
    // Mutation test: read displaySha256 from volatile useState instead of
    // workspace state → SHA-256 absent on mount without re-picking →
    // toHaveTextContent() fails.
    const defaultRecord = record(withActiveAttempt(domainState()));
    const prePopRecord = record(withActiveAttempt(domainState()), {
      workspaceState: CalibrationWorkspacePayload.parse({
        ...defaultRecord.workspaceState,
        assetSha256ByAttemptId: {
          [attemptId]:
            'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
      }),
    });
    const api = makeApi(prePopRecord);
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });
    // SHA-256 must be visible from workspace state alone — no user interaction.
    await waitFor(() => {
      const sha256El = screen.getByTestId('validated-asset-sha256');
      expect(sha256El).toHaveTextContent(
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      );
    });
  });

  it('manifest source URL opens through openCalibrationManifestUrl, not window.open (criterion 14)', async () => {
    // Mutation test: replace calibrationApi().openCalibrationManifestUrl with
    // window.open → IPC mock never called → expect(...).toHaveBeenCalled()
    // fails.
    const api = makeApi(record(domainState()));
    api.getCalibrationQueueState.mockResolvedValue(queueJobFixture());
    api.getCalibrationAssetManifest.mockResolvedValue({
      status: 'ok',
      schemaVersion: '1',
      entries: [
        {
          method: 'TestMethod',
          enabled: true,
          disabledReason: null,
          sourceUrl: 'https://example.com/test-asset.stl',
          author: 'Test Author',
          license: 'MIT',
          attribution: 'Test Attribution',
          expectedFilename: null,
          contentType: 'model/stl',
          expectedExtension: 'stl',
          expectedSha256: null,
          minSizeBytes: 100,
          maxSizeBytes: 1048576,
          validationRules: {},
        },
      ],
    });

    const windowOpenSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);

    await openStepView(api);
    await screen.findByRole('heading', { name: 'Queue State', level: 3 });

    fireEvent.click(await screen.findByTestId('open-manifest-url'));

    await waitFor(() => {
      expect(api.openCalibrationManifestUrl).toHaveBeenCalledTimes(1);
    });
    expect(api.openCalibrationManifestUrl.mock.calls[0]?.[0]?.url).toBe(
      'https://example.com/test-asset.stl',
    );
    expect(windowOpenSpy).not.toHaveBeenCalled();

    windowOpenSpy.mockRestore();
  });
});
