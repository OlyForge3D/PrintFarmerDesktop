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
});
