import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { App } from '../src/renderer/App.js';
import { LibraryOnboarding } from '../src/renderer/library/LibraryOnboarding.js';
import { CalibrationWorkspacePayload } from '@shared/ipc';
import type {
  CalibrationWorkspaceStateRecord,
  LoadSceneResponse,
  LogicalModel,
  PrintFarmerApi,
  ServerProfile,
} from '@shared/ipc';
import { rootIdForPath } from '../src/renderer/library/model.js';
import { ALL_PLATES } from '../src/renderer/viewer/plateSelection.js';
// Typing the mock from the real props means a signature change here is a
// typecheck error rather than a runtime failure in an unrelated assertion.
import type { PreviewWorkspaceProps } from '../src/renderer/viewer/PreviewWorkspace.js';
import { createCalibrationState } from '../src/renderer/calibration/domain';
import { emptyWorkflowDrafts } from '../src/renderer/calibration/workspaceTypes';

vi.mock('../src/renderer/viewer/PreviewWorkspace.js', () => ({
  PreviewWorkspace: ({
    name,
    loading,
    error,
    mesh,
    hiddenObjects,
    isolatedObject,
    onClose,
    onToggleObject,
    onToggleAllObjects,
    onTogglePlate,
    onSelectPlate,
    onIsolateObject,
  }: PreviewWorkspaceProps) => (
    <section role="dialog" aria-label={`3D preview of ${name}`}>
      <span>{loading ? `Loading ${name}` : null}</span>
      <span>{error}</span>
      <span>{mesh?.sourceFormat}</span>
      <span data-testid="hidden-objects">
        {[...hiddenObjects].sort().join(',')}
      </span>
      <span data-testid="isolated-object">{isolatedObject ?? ''}</span>
      <button type="button" onClick={onClose}>
        Back to library
      </button>
      <button type="button" onClick={() => onIsolateObject('lid')}>
        Isolate lid
      </button>
      <button type="button" onClick={() => onIsolateObject('ghost')}>
        Isolate ghost
      </button>
      <button type="button" onClick={() => onIsolateObject(null)}>
        Exit isolation
      </button>
      <button type="button" onClick={() => onToggleObject('spare')}>
        Toggle spare
      </button>
      <button type="button" onClick={() => onTogglePlate('plate-1', false)}>
        Hide plate 2
      </button>
      <button
        type="button"
        onClick={() => onSelectPlate({ kind: 'plate', plateId: 'plate-1' })}
      >
        Select plate 2
      </button>
      <button type="button" onClick={() => onSelectPlate(ALL_PLATES)}>
        Select all plates
      </button>
      <button type="button" onClick={() => onToggleAllObjects(false)}>
        Hide all
      </button>
    </section>
  ),
}));

function installApi(api: Partial<PrintFarmerApi>): void {
  Object.defineProperty(window, 'printFarmer', {
    value: api,
    configurable: true,
    writable: true,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function findAuthorityManageButton(
  name: string | RegExp,
): Promise<HTMLElement> {
  return within(screen.getByLabelText('PrintFarmer server')).findByRole(
    'button',
    { name },
  );
}

function serverProfile(id: string, displayName: string): ServerProfile {
  return {
    id,
    displayName,
    baseUrl: `https://${displayName.toLowerCase().replaceAll(' ', '-')}.example`,
    authMode: 'apiKey',
    version: null,
    capabilities: null,
    availability: {
      modelUpload: {
        available: true,
        mode: 'legacyModelOnly',
        reason: 'Legacy fallback',
      },
      librarySync: { available: false, reason: 'Unavailable' },
      clientThumbnailUpload: { available: false, reason: 'Unavailable' },
      serverThumbnailFallback: {
        available: true,
        reason: 'Server thumbnails',
      },
    },
    status: 'legacy',
    lastCheckedAt: '2026-07-23T12:00:00.000Z',
    warnings: ['legacy'],
  };
}

function appCalibrationRecord(
  profileId: string,
): CalibrationWorkspaceStateRecord {
  const projectId = '22222222-2222-4222-8222-222222222222';
  const timestamp = '2026-07-26T15:00:00.000Z';
  const domainState = createCalibrationState({
    projectId,
    createdAt: timestamp,
    mode: 'coach',
    baseline: {
      nozzleTemperatureC: 215,
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
        backendPrinterId: 'printer-app',
        printerConfigurationId: 'configuration-app',
        printerConfigurationRevision: 2,
      },
      snapshot: {
        snapshotId: 'snapshot-app',
        snapshotRevision: 2,
        capturedAt: timestamp,
        configurationRevision: 2,
        toolheads: [
          {
            toolId: 'tool-app',
            toolheadId: 'head-app',
            nozzle: {
              nozzleId: 'nozzle-app',
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
          maximumVolumetricRateMm3S: 30,
          emergencyStopAvailable: true,
          thermalProtectionConfirmed: true,
          ventilationAssessed: true,
        },
      },
      selectedToolId: 'tool-app',
      selectedToolheadId: 'head-app',
      selectedNozzleId: 'nozzle-app',
      filament: {
        filamentProjectId: 'filament-app',
        provider: 'Provider',
        product: 'PLA',
        sku: 'PLA-BLK',
      },
    },
  });
  return {
    profileId,
    projectId,
    displayName: 'App leave flush project',
    description: null,
    printerId: 'printer-app',
    status: 'draft',
    completedStepCount: 0,
    totalStepCount: 9,
    isSynced: true,
    isPrinterContextFresh: true,
    hasConflicts: false,
    remoteProjectId: null,
    baseRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    workspaceState: CalibrationWorkspacePayload.parse({
      schemaVersion: 1,
      domainState,
      metadata: {
        displayName: 'App leave flush project',
        description: '',
      },
      stepDrafts: {},
      workflowDrafts: emptyWorkflowDrafts(),
      photos: [],
      physicalMatch: {
        snapshotId: 'snapshot-app',
        toolId: 'tool-app',
        toolheadId: 'head-app',
        nozzleId: 'nozzle-app',
        nozzleDiameterMm: 0.4,
        confirmedAt: timestamp,
      },
      selectedBaseProfile: {
        orcaProfileId: 'orca-app',
        displayName: 'App profile',
        source: 'printFarmer',
        upstreamVerified: true,
        printerId: 'printer-app',
        configurationRevision: 2,
        snapshotId: 'snapshot-app',
        toolId: 'tool-app',
        toolheadId: 'head-app',
        nozzleId: 'nozzle-app',
        nozzleDiameterMm: 0.4,
        profileRevision: 'revision-app',
        contentHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      selectedBaseProfileId: 'orca-app',
      autosaveRevision: 0,
    }),
  };
}

describe('<App />', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('uses the canonical application icon in the custom titlebar', async () => {
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
    });

    render(<App />);

    const identity = screen
      .getByText('PrintFarmer Desktop')
      .closest('.product-identity');
    const icon = identity?.querySelector('.product-icon');

    expect(icon).toBeInstanceOf(HTMLImageElement);
    expect(icon).toHaveAttribute('src', expect.stringContaining('icon.png'));
    await waitFor(() =>
      expect(screen.getByLabelText('Application status')).toHaveTextContent(
        'v0.1.0 · win32',
      ),
    );
  });

  it('renders app info returned by the main process', async () => {
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'darwin',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByLabelText('Application status')).toHaveTextContent(
        'v0.1.0 · darwin',
      ),
    );
  });

  it('shows onboarding with keyboard focus management and restores focus when dismissed', async () => {
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 1,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
    });

    render(<App />);

    const dialog = await screen.findByRole('dialog', {
      name: 'Set up your model library',
    });
    expect(dialog).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Add your first folder' }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Set up your model library' }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add folder' })).toHaveFocus(),
    );
  });

  it('cycles Tab within library onboarding and snaps escaped focus back inside', () => {
    render(
      <>
        <button type="button">Background action</button>
        <LibraryOnboarding
          busy={false}
          onAddFolder={vi.fn()}
          onClose={vi.fn()}
        />
      </>,
    );

    const close = screen.getByRole('button', { name: 'Close onboarding' });
    const addFolder = screen.getByRole('button', {
      name: 'Add your first folder',
    });
    const maybeLater = screen.getByRole('button', { name: 'Maybe later' });
    const background = screen.getByRole('button', {
      name: 'Background action',
    });

    expect(addFolder).toHaveFocus();

    maybeLater.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(maybeLater).toHaveFocus();

    background.focus();
    expect(addFolder).toHaveFocus();
  });

  it('opens server profiles from the sidebar and excludes the workspace', async () => {
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      listServerProfiles: vi.fn().mockResolvedValue({
        profiles: [],
        selectedProfileId: null,
      }),
    });
    const { container } = render(<App />);

    const manage = await findAuthorityManageButton(/^Connect to PrintFarmer:/);
    expect(manage).toHaveAccessibleName(
      'Connect to PrintFarmer: No server selected yet, Status: Disconnected',
    );
    manage.focus();
    await waitFor(() => expect(manage).toBeEnabled());
    fireEvent.click(manage);
    expect(
      await screen.findByRole('dialog', { name: 'Connect to PrintFarmer' }),
    ).toBeVisible();
    const workspace = container.querySelector('.app-body');
    expect(workspace).toHaveAttribute('inert');
    let inertWhenFocusReturned: boolean | null = null;
    manage.addEventListener('focus', () => {
      inertWhenFocusReturned = workspace?.hasAttribute('inert') ?? null;
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Close server profiles' }),
    );
    await waitFor(() => expect(manage).toHaveFocus());
    expect(inertWhenFocusReturned).toBe(false);
  });

  it('removes a source root from the local library view', async () => {
    const models: LogicalModel[] = [
      {
        hash: 'deadbeef',
        format: 'stl',
        size: 2048,
        locations: [
          {
            rootId: 'root-1',
            path: 'C:\\models\\widget.stl',
            rootRelative: 'widget.stl',
            size: 2048,
            available: true,
          },
        ],
      },
    ];
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 1,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue(models),
      renderThumbnail: vi.fn().mockResolvedValue({
        width: 256,
        height: 256,
        pngBase64: 'AAAA',
      }),
    });

    render(<App />);
    await screen.findByRole('button', { name: 'Select widget.stl' });
    fireEvent.click(screen.getByRole('button', { name: /^Sources/ }));

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Hide models from the catalog',
      }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Select widget.stl' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('models')).not.toBeInTheDocument();
  });

  it('shows reconnect progress for a missing root and rescans it', async () => {
    const staleModels: LogicalModel[] = [
      {
        hash: 'deadbeef',
        format: 'stl',
        size: 2048,
        locations: [
          {
            rootId: 'root-1',
            path: 'C:\\models\\widget.stl',
            rootRelative: 'widget.stl',
            size: 2048,
            available: false,
          },
        ],
      },
    ];
    const refreshedModels: LogicalModel[] = [
      {
        hash: 'deadbeef',
        format: 'stl',
        size: 2048,
        locations: [
          {
            rootId: 'root-1',
            path: 'C:\\models\\widget.stl',
            rootRelative: 'widget.stl',
            size: 2048,
            available: true,
          },
        ],
      },
    ];
    const pending = deferred<{
      added: number;
      changed: number;
      unchanged: number;
      missing: number;
      hashErrors: number;
    }>();
    const listModels = vi
      .fn()
      .mockResolvedValueOnce(staleModels)
      .mockResolvedValueOnce(refreshedModels);
    const scanRoot = vi.fn(() => pending.promise);
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 1,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels,
      scanRoot,
      openFolder: vi.fn().mockResolvedValue({
        path: 'C:\\models',
        approvalId: '11111111-1111-4111-8111-111111111111',
      }),
      renderThumbnail: vi.fn().mockResolvedValue({
        width: 256,
        height: 256,
        pngBase64: 'AAAA',
      }),
    });

    render(<App />);
    expect(
      await screen.findByText('0 available · 1 needs attention'),
    ).toBeVisible();
    fireEvent.click(await screen.findByRole('button', { name: /^Sources/ }));
    const reconnect = await screen.findByRole('button', { name: 'Reconnect' });
    fireEvent.click(reconnect);

    expect(
      screen.getByRole('progressbar', { name: 'Scan progress' }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getAllByText('Reconnecting C:\\models')).toHaveLength(1),
    );
    expect(screen.getByLabelText('Application status')).toHaveTextContent(
      'Scanning source',
    );

    await act(async () => {
      pending.resolve({
        added: 0,
        changed: 0,
        unchanged: 1,
        missing: 0,
        hashErrors: 0,
      });
      await pending.promise;
    });

    await waitFor(() =>
      expect(scanRoot).toHaveBeenCalledWith({
        rootId: 'root-1',
        approvalId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Scan again' })).toBeVisible(),
    );
  });

  it('shows a scan error alert and clears scanning state after a rescan failure', async () => {
    const models: LogicalModel[] = [
      {
        hash: 'deadbeef',
        format: 'stl',
        size: 2048,
        locations: [
          {
            rootId: 'root-1',
            path: 'C:\\models\\widget.stl',
            rootRelative: 'widget.stl',
            size: 2048,
            available: true,
          },
        ],
      },
    ];
    const listModels = vi.fn().mockResolvedValue(models);
    const scanRoot = vi.fn().mockRejectedValue(new Error('scan failed hard'));
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 1,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels,
      scanRoot,
      openFolder: vi.fn().mockResolvedValue({
        path: 'C:\\models',
        approvalId: '22222222-2222-4222-8222-222222222222',
      }),
      renderThumbnail: vi.fn().mockResolvedValue({
        width: 256,
        height: 256,
        pngBase64: 'AAAA',
      }),
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^Sources/ }));
    const rescan = await screen.findByRole('button', { name: 'Scan again' });

    fireEvent.click(rescan);

    await waitFor(() =>
      expect(scanRoot).toHaveBeenCalledWith({
        rootId: 'root-1',
        approvalId: '22222222-2222-4222-8222-222222222222',
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('scan failed hard'),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('progressbar', { name: 'Scan progress' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('progressbar', { name: 'Current scan progress' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Add source folder' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Scan again' })).toBeEnabled();
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('announces a selected server connection error in the sidebar accessible name', async () => {
    const failedProfile: ServerProfile = {
      id: '11111111-1111-4111-8111-111111111111',
      displayName: 'Broken farm',
      baseUrl: 'https://farm.example',
      authMode: 'apiKey',
      version: null,
      capabilities: null,
      availability: {
        modelUpload: {
          available: true,
          mode: 'legacyModelOnly',
          reason: 'Legacy fallback',
        },
        librarySync: { available: false, reason: 'Unavailable' },
        clientThumbnailUpload: { available: false, reason: 'Unavailable' },
        serverThumbnailFallback: {
          available: true,
          reason: 'Server thumbnails',
        },
      },
      status: 'error',
      lastCheckedAt: '2026-07-23T12:00:00.000Z',
      warnings: ['legacy'],
    };
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      listServerProfiles: vi.fn().mockResolvedValue({
        profiles: [failedProfile],
        selectedProfileId: failedProfile.id,
      }),
    });
    render(<App />);

    const manage = await screen.findByRole('button', {
      name: 'Manage connection: Broken farm, Legacy server, Status: Connection error',
    });
    expect(manage).toHaveAccessibleName(
      'Manage connection: Broken farm, Legacy server, Status: Connection error',
    );
  });

  it('reconciles a delete that commits after the profile dialog closes', async () => {
    const profile = serverProfile(
      '11111111-1111-4111-8111-111111111111',
      'Delete me',
    );
    const deletion = deferred<{
      profiles: ServerProfile[];
      selectedProfileId: string | null;
    }>();
    let deleted = false;
    const listServerProfiles = vi.fn(() =>
      Promise.resolve({
        profiles: deleted ? [] : [profile],
        selectedProfileId: deleted ? null : profile.id,
      }),
    );
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      listServerProfiles,
      deleteServerProfile: vi.fn(() => deletion.promise),
    });
    render(<App />);
    const manage = await findAuthorityManageButton(/^Manage connection:/);
    expect(manage).toHaveTextContent('Delete me');
    expect(manage).toHaveTextContent('Legacy fallback');

    fireEvent.click(manage);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove Delete me' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Close server profiles' }),
    );
    deleted = true;
    deletion.resolve({ profiles: [], selectedProfileId: null });

    const disconnected = await findAuthorityManageButton(
      /^Connect to PrintFarmer:/,
    );
    fireEvent.click(disconnected);
    expect(
      await screen.findByText('No server profiles saved yet.'),
    ).toBeVisible();
    expect(listServerProfiles.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('orders select reconciliation across close, stale lists, and reopen', async () => {
    const first = serverProfile(
      '11111111-1111-4111-8111-111111111111',
      'First farm',
    );
    const second = serverProfile(
      '22222222-2222-4222-8222-222222222222',
      'Second farm',
    );
    const staleOpenList = deferred<{
      profiles: ServerProfile[];
      selectedProfileId: string | null;
    }>();
    const selection = deferred<ServerProfile>();
    let selectedId = first.id;
    let listCalls = 0;
    const listServerProfiles = vi.fn(() => {
      listCalls += 1;
      if (listCalls === 2) return staleOpenList.promise;
      return Promise.resolve({
        profiles: [first, second],
        selectedProfileId: selectedId,
      });
    });
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      listServerProfiles,
      selectServerProfile: vi.fn(() => selection.promise),
    });
    render(<App />);
    const manage = await findAuthorityManageButton(/^Manage connection:/);
    expect(manage).toHaveTextContent('First farm');

    fireEvent.click(manage);
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Close server profiles' }),
    );
    selectedId = second.id;
    selection.resolve(second);

    const selectedSecond =
      await findAuthorityManageButton(/^Manage connection:/);
    await waitFor(() =>
      expect(selectedSecond).toHaveTextContent('Second farm'),
    );
    staleOpenList.resolve({
      profiles: [first, second],
      selectedProfileId: first.id,
    });
    await act(async () => {
      await staleOpenList.promise;
    });
    expect(selectedSecond).toBeVisible();

    fireEvent.click(selectedSecond);
    const profilesDialog = await screen.findByRole('dialog', {
      name: 'Manage PrintFarmer connection',
    });
    const secondCard = within(profilesDialog)
      .getByText('Second farm')
      .closest('li');
    expect(secondCard).not.toBeNull();
    expect(
      within(secondCard as HTMLElement).getByRole('button', {
        name: 'Selected',
      }),
    ).toBeDisabled();
  });

  it('excludes server profiles throughout import preparation and its modal', async () => {
    const preview = deferred<{
      modelCount: number;
      totalBytes: number;
      skippedErrors: number;
      complete: boolean;
      formats: { stl: number; threeMf: number; obj: number };
      folders: [];
      foldersTruncated: boolean;
    }>();
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      listServerProfiles: vi.fn().mockResolvedValue({
        profiles: [],
        selectedProfileId: null,
      }),
      openFolder: vi.fn().mockResolvedValue({
        path: 'C:\\GatedImport',
        approvalId: '11111111-1111-4111-8111-111111111111',
      }),
      previewImport: vi.fn().mockReturnValue(preview.promise),
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });
    const { container } = render(<App />);
    const manage = await findAuthorityManageButton(/^Connect to PrintFarmer:/);
    await waitFor(() => expect(manage).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(manage).toBeDisabled();
    fireEvent.click(manage);
    expect(
      screen.queryByRole('dialog', { name: 'Connect to PrintFarmer' }),
    ).not.toBeInTheDocument();

    preview.resolve({
      modelCount: 1,
      totalBytes: 100,
      skippedErrors: 0,
      complete: true,
      formats: { stl: 1, threeMf: 0, obj: 0 },
      folders: [],
      foldersTruncated: false,
    });
    fireEvent.click(manage);

    expect(
      await screen.findByRole('dialog', {
        name: 'Organize models before importing',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('dialog', { name: 'Connect to PrintFarmer' }),
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    const cancel = screen.getByRole('button', { name: 'Cancel import' });
    await waitFor(() => expect(cancel).toHaveFocus());
    screen.getByLabelText('Search models').focus();
    expect(cancel).toHaveFocus();
  });

  it('gives same-tick profile and card-preview entries exclusive ownership', async () => {
    const model: LogicalModel = {
      hash: 'part',
      format: 'stl',
      size: 100,
      locations: [
        {
          rootId: 'root',
          path: 'C:\\models\\part.stl',
          rootRelative: 'part.stl',
          size: 100,
          available: true,
        },
      ],
    };
    const loadScene = vi.fn().mockResolvedValue({
      sceneVersion: 2,
      positions: [0, 0, 0],
      indices: [0, 0, 0],
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      sourceFormat: 'stl',
      status: 'complete',
      statusMessages: [],
      parts: [],
      objects: [],
      rootObjectIds: [],
      plates: [],
    });
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([model]),
      listServerProfiles: vi.fn().mockResolvedValue({
        profiles: [],
        selectedProfileId: null,
      }),
      renderThumbnail: vi.fn().mockResolvedValue({
        width: 256,
        height: 256,
        pngBase64: 'AAAA',
      }),
      loadScene,
    });
    render(<App />);
    const manage = await findAuthorityManageButton(/^Connect to PrintFarmer:/);
    const preview = await screen.findByRole('button', {
      name: 'Preview part.stl in 3D',
    });
    await waitFor(() => expect(manage).toBeEnabled());

    fireEvent.click(manage);
    fireEvent.click(preview);
    expect(
      await screen.findByRole('dialog', { name: 'Connect to PrintFarmer' }),
    ).toBeVisible();
    expect(loadScene).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Close server profiles' }),
    );
    await waitFor(() => expect(preview).toBeEnabled());

    fireEvent.click(preview);
    fireEvent.click(manage);
    expect(
      await screen.findByRole('dialog', { name: '3D preview of part.stl' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('dialog', { name: 'Connect to PrintFarmer' }),
    ).not.toBeInTheDocument();
    expect(loadScene).toHaveBeenCalledOnce();
  });

  it('isolates a scene object and clears isolation on any manual toggle', async () => {
    const model: LogicalModel = {
      hash: 'assembly',
      format: 'threeMf',
      size: 400,
      locations: [
        {
          rootId: 'root',
          path: 'C:\\models\\assembly.3mf',
          rootRelative: 'assembly.3mf',
          size: 400,
          available: true,
        },
      ],
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const scene: LoadSceneResponse = {
      sceneVersion: 2,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
      status: 'complete',
      statusMessages: [],
      parts: [],
      objects: [
        {
          id: 'body',
          sourceId: 'object-1',
          name: 'Body',
          parentId: null,
          children: ['lid'],
          transform: { matrix: identity },
          mesh: null,
          material: {},
          plateId: 'plate-0',
          buildItemIndex: 0,
        },
        {
          id: 'lid',
          sourceId: 'object-2',
          name: 'Lid',
          parentId: 'body',
          children: [],
          transform: { matrix: identity },
          mesh: {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            bounds: { min: [0, 0, 0], max: [1, 1, 0] },
          },
          material: {},
          plateId: 'plate-0',
          buildItemIndex: 0,
        },
        {
          id: 'spare',
          sourceId: 'object-3',
          name: 'Spare',
          parentId: null,
          children: [],
          transform: { matrix: identity },
          mesh: {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            bounds: { min: [0, 0, 0], max: [1, 1, 0] },
          },
          material: {},
          plateId: 'plate-1',
          buildItemIndex: 1,
        },
      ],
      rootObjectIds: ['body', 'spare'],
      plates: [
        { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['body'] },
        { id: 'plate-1', name: 'Plate 2', index: 1, rootObjectIds: ['spare'] },
      ],
    };
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([model]),
      listServerProfiles: vi
        .fn()
        .mockResolvedValue({ profiles: [], selectedProfileId: null }),
      renderThumbnail: vi
        .fn()
        .mockResolvedValue({ width: 256, height: 256, pngBase64: 'AAAA' }),
      extractVendorMetadata: vi.fn().mockResolvedValue(null),
      tagsForModel: vi.fn().mockResolvedValue([]),
      listCollections: vi.fn().mockResolvedValue([]),
      collectionsForModel: vi.fn().mockResolvedValue([]),
      loadScene: vi.fn().mockResolvedValue(scene),
    });

    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Preview assembly.3mf in 3D' }),
    );
    await screen.findByRole('dialog', { name: '3D preview of assembly.3mf' });

    const hidden = (): string =>
      screen.getByTestId('hidden-objects').textContent ?? '';
    const isolated = (): string =>
      screen.getByTestId('isolated-object').textContent ?? '';

    // Isolating a leaf keeps its ancestors visible and hides everything else.
    fireEvent.click(screen.getByRole('button', { name: 'Isolate lid' }));
    await waitFor(() => expect(isolated()).toBe('lid'));
    expect(hidden()).toBe('spare');

    // Any manual visibility change drops the (now inaccurate) isolation badge.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle spare' }));
    await waitFor(() => expect(isolated()).toBe(''));
    expect(hidden()).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Hide plate 2' }));
    await waitFor(() => expect(hidden()).toBe('spare'));

    fireEvent.click(screen.getByRole('button', { name: 'Isolate lid' }));
    await waitFor(() => expect(isolated()).toBe('lid'));
    fireEvent.click(screen.getByRole('button', { name: 'Exit isolation' }));
    await waitFor(() => expect(isolated()).toBe(''));
    expect(hidden()).toBe('');

    // Unknown object ids are ignored rather than hiding the whole scene.
    fireEvent.click(screen.getByRole('button', { name: 'Isolate ghost' }));
    await waitFor(() => expect(hidden()).toBe(''));
    expect(isolated()).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Hide all' }));
    await waitFor(() => expect(hidden()).toBe('body,lid,spare'));

    // Selecting a plate hides the other plates' roots outright, so it recovers
    // from "everything hidden" rather than composing with it.
    fireEvent.click(screen.getByRole('button', { name: 'Select plate 2' }));
    await waitFor(() => expect(hidden()).toBe('body'));
    expect(isolated()).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Isolate lid' }));
    await waitFor(() => expect(isolated()).toBe('lid'));

    // Returning to all plates clears both the plate filter and the isolation.
    fireEvent.click(screen.getByRole('button', { name: 'Select all plates' }));
    await waitFor(() => expect(hidden()).toBe(''));
    expect(isolated()).toBe('');
  });

  it('blocks profiles and imports while the open-file picker is deferred', async () => {
    const picker = deferred<null>();
    const openFolder = vi.fn();
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      listServerProfiles: vi.fn().mockResolvedValue({
        profiles: [],
        selectedProfileId: null,
      }),
      openModelFile: vi.fn(() => picker.promise),
      openFolder,
    });
    render(<App />);
    const manage = await findAuthorityManageButton(/^Connect to PrintFarmer:/);
    const addFolder = screen.getByRole('button', { name: 'Add folder' });
    const openFile = screen.getByRole('button', { name: 'Open file' });
    await waitFor(() => expect(openFile).toBeEnabled());

    fireEvent.click(openFile);
    expect(openFile).toBeDisabled();
    expect(manage).toBeDisabled();
    expect(addFolder).toBeDisabled();
    fireEvent.click(manage);
    fireEvent.click(addFolder);
    expect(
      screen.queryByRole('dialog', { name: 'Connect to PrintFarmer' }),
    ).not.toBeInTheDocument();
    expect(openFolder).not.toHaveBeenCalled();

    picker.resolve(null);
    await waitFor(() => expect(openFile).toBeEnabled());
    expect(manage).toBeEnabled();
    expect(addFolder).toBeEnabled();
  });

  it.each([
    ['cancellation', null],
    ['failure', new Error('folder picker unavailable')],
  ] as const)(
    'restores Add folder focus after native picker %s',
    async (_label, outcome) => {
      window.localStorage.setItem(
        'printfarmer.library.sourceRoots.v1',
        JSON.stringify({
          version: 1,
          roots: [{ rootId: 'existing-root', path: 'C:\\Existing' }],
        }),
      );
      installApi({
        getAppInfo: vi.fn().mockResolvedValue({
          contractVersion: 2,
          appVersion: '0.1.0',
          platform: 'win32',
          electronVersion: '33.0.0',
        }),
        listModels: vi.fn().mockResolvedValue([]),
        openFolder:
          outcome instanceof Error
            ? vi.fn().mockRejectedValue(outcome)
            : vi.fn().mockResolvedValue(outcome),
      });
      render(<App />);
      const addFolder = await screen.findByRole('button', {
        name: 'Add folder',
      });
      await waitFor(() => expect(addFolder).toBeEnabled());
      addFolder.focus();

      fireEvent.click(addFolder);

      await waitFor(() => expect(addFolder).toBeEnabled());
      await waitFor(() => expect(addFolder).toHaveFocus());
      expect(
        screen.queryByRole('dialog', {
          name: 'Organize models before importing',
        }),
      ).not.toBeInTheDocument();
      if (outcome instanceof Error) {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'folder picker unavailable',
        );
      }
    },
  );

  it.each([
    ['cancellation', null],
    ['failure', new Error('file picker unavailable')],
  ] as const)(
    'restores Open file focus after native picker %s',
    async (_label, outcome) => {
      window.localStorage.setItem(
        'printfarmer.library.sourceRoots.v1',
        JSON.stringify({
          version: 1,
          roots: [{ rootId: 'existing-root', path: 'C:\\Existing' }],
        }),
      );
      installApi({
        getAppInfo: vi.fn().mockResolvedValue({
          contractVersion: 2,
          appVersion: '0.1.0',
          platform: 'win32',
          electronVersion: '33.0.0',
        }),
        listModels: vi.fn().mockResolvedValue([]),
        openModelFile:
          outcome instanceof Error
            ? vi.fn().mockRejectedValue(outcome)
            : vi.fn().mockResolvedValue(outcome),
      });
      render(<App />);
      const openFile = await screen.findByRole('button', { name: 'Open file' });
      await waitFor(() => expect(openFile).toBeEnabled());
      openFile.focus();

      fireEvent.click(openFile);

      await waitFor(() => expect(openFile).toBeEnabled());
      await waitFor(() => expect(openFile).toHaveFocus());
      expect(
        screen.queryByRole('dialog', { name: /3D preview/ }),
      ).not.toBeInTheDocument();
      if (outcome instanceof Error) {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'file picker unavailable',
        );
      }
    },
  );

  it('shows an error when the main process call fails', async () => {
    installApi({
      getAppInfo: vi.fn().mockRejectedValue(new Error('bridge down')),
      listModels: vi.fn().mockResolvedValue([]),
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('bridge down'),
    );
  });

  it('shows detected slicer metadata after selecting a 3MF model', async () => {
    const project: LogicalModel = {
      hash: 'project',
      format: 'threeMf',
      size: 4096,
      locations: [
        {
          rootId: 'root',
          path: 'C:\\models\\project.3mf',
          rootRelative: 'project.3mf',
          size: 4096,
          available: true,
        },
      ],
    };
    const extractVendorMetadata = vi.fn().mockResolvedValue({
      slicer: 'orcaSlicer',
      core: { application: 'OrcaSlicer-2.3.0' },
      plates: [],
      thumbnails: [],
    });
    const loadScene = vi.fn();
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([project]),
      renderThumbnail: vi.fn().mockResolvedValue({
        width: 256,
        height: 256,
        pngBase64: 'AAAA',
      }),
      tagsForModel: vi.fn().mockResolvedValue([]),
      listCollections: vi.fn().mockResolvedValue([]),
      collectionsForModel: vi.fn().mockResolvedValue([]),
      extractVendorMetadata,
      loadScene,
    });

    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select project.3mf' }),
    );

    const inspector = screen.getByLabelText('Model properties');
    await waitFor(() =>
      expect(within(inspector).getByText('OrcaSlicer')).toBeVisible(),
    );
    expect(extractVendorMetadata).toHaveBeenCalledWith({
      path: 'C:\\models\\project.3mf',
    });
    expect(loadScene).not.toHaveBeenCalled();
  });

  it('previews folder rules before confirming a smart import', async () => {
    const selectedPath = 'C:\\SmartImportRoot';
    window.localStorage.setItem(
      'printfarmer.library.sourceRoots.v1',
      JSON.stringify({
        version: 1,
        roots: [{ rootId: 'existing-root', path: 'C:\\Existing' }],
      }),
    );
    const previewImport = vi.fn().mockResolvedValue({
      modelCount: 2,
      totalBytes: 3072,
      skippedErrors: 0,
      complete: true,
      formats: { stl: 1, threeMf: 1, obj: 0 },
      folders: [
        {
          relativePath: 'Cats',
          name: 'Cats',
          depth: 1,
          modelCount: 2,
        },
        {
          relativePath: 'Cats/Articulated',
          name: 'Articulated',
          depth: 2,
          modelCount: 1,
        },
      ],
      foldersTruncated: false,
    });
    const importRoot = vi.fn().mockResolvedValue({
      report: {
        added: 2,
        changed: 0,
        unchanged: 0,
        missing: 0,
        hashErrors: 0,
      },
      modelsOrganized: 2,
      collectionsCreated: 2,
      collectionAssignments: 4,
      tagAssignments: 3,
      resolvedCollections: [
        {
          relativePath: '',
          name: 'SmartImportRoot',
          collectionId: 'collection-root',
        },
        {
          relativePath: 'Cats',
          name: 'Cats',
          collectionId: 'collection-cats',
        },
      ],
    });
    const scanRoot = vi.fn();
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      openFolder: vi.fn().mockResolvedValue({
        path: selectedPath,
        approvalId: '11111111-1111-4111-8111-111111111111',
      }),
      previewImport,
      importRoot,
      scanRoot,
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add folder' }));

    expect(
      await screen.findByRole('dialog', {
        name: 'Organize models before importing',
      }),
    ).toBeVisible();
    expect(previewImport).toHaveBeenCalledWith({
      approvalId: '11111111-1111-4111-8111-111111111111',
    });
    expect(scanRoot).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Organization for Cats')).toHaveValue(
      'collection',
    );
    expect(
      screen.getByLabelText('Organization for Cats/Articulated'),
    ).toHaveValue('tag');

    fireEvent.change(screen.getByLabelText('Tags for all imported models'), {
      target: { value: 'printable' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 files' }));

    await waitFor(() =>
      expect(importRoot).toHaveBeenCalledWith({
        rootId: rootIdForPath(selectedPath),
        approvalId: '11111111-1111-4111-8111-111111111111',
        rules: [
          {
            relativePath: '',
            kind: 'collection',
            name: 'SmartImportRoot',
          },
          {
            relativePath: 'Cats',
            kind: 'collection',
            name: 'Cats',
          },
          {
            relativePath: 'Cats/Articulated',
            kind: 'tag',
            name: 'Articulated',
          },
        ],
        commonTags: ['printable'],
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'Organize models before importing',
        }),
      ).not.toBeInTheDocument(),
    );
  });

  it('disables preview entry points while an import is being prepared', async () => {
    const model: LogicalModel = {
      hash: 'part',
      format: 'stl',
      size: 100,
      locations: [
        {
          rootId: 'root',
          path: 'C:\\models\\part.stl',
          rootRelative: 'part.stl',
          size: 100,
          available: true,
        },
      ],
    };
    const openFolder = vi.fn(
      () =>
        new Promise<{ path: string; approvalId: string } | null>(
          () => undefined,
        ),
    );
    const loadScene = vi.fn();
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([model]),
      openFolder,
      openModelFile: vi.fn(),
      loadScene,
      renderThumbnail: vi.fn().mockResolvedValue({
        width: 256,
        height: 256,
        pngBase64: 'AAAA',
      }),
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Select part.stl' });

    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() => expect(openFolder).toHaveBeenCalledTimes(1));

    expect(screen.getByRole('button', { name: 'Open file' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Preview part.stl in 3D' }),
    ).toBeDisabled();
    fireEvent.doubleClick(
      screen.getByRole('button', { name: 'Select part.stl' }),
    );
    expect(loadScene).not.toHaveBeenCalled();
  });

  it('refreshes selected-model organization after a successful import', async () => {
    const selected: LogicalModel = {
      hash: 'selected',
      format: 'stl',
      size: 100,
      locations: [
        {
          rootId: 'root',
          path: 'C:\\models\\selected.stl',
          rootRelative: 'selected.stl',
          size: 100,
          available: true,
        },
      ],
    };
    const collection = {
      id: 'collection-1',
      name: 'Imported',
      sharedToFarm: false,
      memberCount: 1,
    };
    let finishTagRefresh!: (value: Array<{ id: string; name: string }>) => void;
    const tagRefresh = new Promise<Array<{ id: string; name: string }>>(
      (resolve) => {
        finishTagRefresh = resolve;
      },
    );
    let finishCollectionRefresh!: (value: (typeof collection)[]) => void;
    const collectionRefresh = new Promise<(typeof collection)[]>((resolve) => {
      finishCollectionRefresh = resolve;
    });
    const tagsForModel = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'before', name: 'Before import' }])
      .mockReturnValueOnce(tagRefresh);
    const collectionsForModel = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(collectionRefresh);
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([selected]),
      renderThumbnail: vi.fn().mockResolvedValue({
        width: 256,
        height: 256,
        pngBase64: 'AAAA',
      }),
      tagsForModel,
      collectionsForModel,
      listCollections: vi.fn().mockResolvedValue([collection]),
      listTags: vi.fn().mockResolvedValue([]),
      openFolder: vi.fn().mockResolvedValue({
        path: 'C:\\ImportRoot',
        approvalId: '11111111-1111-4111-8111-111111111111',
      }),
      previewImport: vi.fn().mockResolvedValue({
        modelCount: 1,
        totalBytes: 100,
        skippedErrors: 0,
        complete: true,
        formats: { stl: 1, threeMf: 0, obj: 0 },
        folders: [],
        foldersTruncated: false,
      }),
      importRoot: vi.fn().mockResolvedValue({
        report: {
          added: 0,
          changed: 0,
          unchanged: 1,
          missing: 0,
          hashErrors: 0,
        },
        modelsOrganized: 1,
        collectionsCreated: 0,
        collectionAssignments: 1,
        tagAssignments: 1,
        resolvedCollections: [
          {
            relativePath: '',
            name: 'ImportRoot',
            collectionId: 'collection-1',
          },
        ],
      }),
    });
    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Select selected.stl' }),
    );
    await waitFor(() => expect(tagsForModel).toHaveBeenCalledTimes(1));

    const addFolder = screen.getByRole('button', { name: 'Add folder' });
    addFolder.focus();
    fireEvent.click(addFolder);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Import 1 files' }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', {
          name: 'Organize models before importing',
        }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(addFolder).toHaveFocus());
    await waitFor(() => expect(tagsForModel).toHaveBeenCalledTimes(2));
    expect(collectionsForModel).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishTagRefresh([{ id: 'after', name: 'After import' }]);
      finishCollectionRefresh([collection]);
      await Promise.all([tagRefresh, collectionRefresh]);
    });
    expect(
      within(screen.getByLabelText('Model properties')).getByText(
        'After import',
      ),
    ).toBeVisible();
  });

  it('ignores a stale preview failure after another model is opened', async () => {
    const models: LogicalModel[] = [
      {
        hash: 'model-a',
        format: 'stl',
        size: 100,
        locations: [
          {
            rootId: 'root',
            path: 'C:\\models\\alpha.stl',
            rootRelative: 'alpha.stl',
            size: 100,
            available: true,
          },
        ],
      },
      {
        hash: 'model-b',
        format: 'obj',
        size: 200,
        locations: [
          {
            rootId: 'root',
            path: 'C:\\models\\beta.obj',
            rootRelative: 'beta.obj',
            size: 200,
            available: true,
          },
        ],
      },
    ];
    let rejectAlpha!: (error: Error) => void;
    let resolveBeta!: (scene: LoadSceneResponse) => void;
    const loadScene = vi.fn(({ path }: { path: string }) => {
      if (path.endsWith('alpha.stl')) {
        return new Promise<LoadSceneResponse>((_resolve, reject) => {
          rejectAlpha = reject;
        });
      }
      return new Promise<LoadSceneResponse>((resolve) => {
        resolveBeta = resolve;
      });
    });
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue(models),
      loadScene,
      renderThumbnail: vi.fn().mockResolvedValue({
        width: 256,
        height: 256,
        pngBase64: 'AAAA',
      }),
      tagsForModel: vi.fn().mockResolvedValue([]),
      listCollections: vi.fn().mockResolvedValue([]),
      collectionsForModel: vi.fn().mockResolvedValue([]),
    });

    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Preview alpha.stl in 3D',
      }),
    );
    expect(
      screen.getByRole('dialog', { name: '3D preview of alpha.stl' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to library' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview beta.obj in 3D' }),
    );
    expect(
      screen.getByRole('dialog', { name: '3D preview of beta.obj' }),
    ).toHaveTextContent('Loading beta.obj');

    await act(async () => {
      rejectAlpha(new Error('old preview failed'));
      await Promise.resolve();
    });
    expect(screen.queryByText('old preview failed')).not.toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: '3D preview of beta.obj' }),
    ).toHaveTextContent('Loading beta.obj');

    await act(async () => {
      resolveBeta({
        sceneVersion: 2,
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        sourceFormat: 'obj',
        status: 'complete',
        statusMessages: [],
        parts: [],
        objects: [],
        rootObjectIds: [],
        plates: [],
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: '3D preview of beta.obj' }),
      ).toHaveTextContent('obj'),
    );
    expect(screen.queryByText('old preview failed')).not.toBeInTheDocument();
  });

  it('switches workspaces with focus restoration and blocks switching for shell dialogs', async () => {
    const profileId = '11111111-1111-4111-8111-111111111111';
    const profile = serverProfile(profileId, 'Farm server');
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      listServerProfiles: vi.fn().mockResolvedValue({
        profiles: [profile],
        selectedProfileId: profileId,
      }),
      getCalibrationAvailability: vi.fn().mockResolvedValue({
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
      }),
      listCalibrationWorkspaceStates: vi.fn().mockResolvedValue({
        states: [],
        unhydratedProjects: [],
      }),
    });

    render(<App />);

    const calibrationSwitch = screen.getByRole('button', {
      name: 'Printer Calibration',
    });
    await screen.findByRole('dialog', { name: 'Set up your model library' });
    // The onboarding nudge does not own the shell, so it must NOT lock the
    // rail -- it appears on exactly the runs with no source roots yet (#222).
    // The server-profiles dialog below is a real modal and does lock it; that
    // contrast is the point of this test.
    await waitFor(() => expect(calibrationSwitch).toBeEnabled());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(calibrationSwitch).toBeEnabled());
    fireEvent.click(calibrationSwitch);

    const calibrationHeading = await screen.findByRole('heading', {
      name: 'Printer Calibration',
    });
    await waitFor(() => expect(calibrationHeading).toHaveFocus());
    expect(
      within(screen.getByLabelText('PrintFarmer server')).getByText(
        'Farm server',
      ),
    ).toBeInTheDocument();

    const manageProfiles = screen.getByRole('button', {
      name: 'Manage PrintFarmer profiles',
    });
    manageProfiles.focus();
    fireEvent.click(manageProfiles);
    expect(
      await screen.findByRole('dialog', {
        name: 'Manage PrintFarmer connection',
      }),
    ).toBeInTheDocument();
    expect(calibrationSwitch).toBeDisabled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Close server profiles' }),
    );
    await waitFor(() => expect(manageProfiles).toHaveFocus());

    const librarySwitch = screen.getByRole('button', { name: 'Library' });
    fireEvent.click(librarySwitch);
    const libraryHeading = await screen.findByRole('heading', {
      name: 'All models',
    });
    await waitFor(() => expect(libraryHeading).toHaveFocus());
  });

  it('keeps calibration mounted and announces when its leave flush fails', async () => {
    const profileId = '11111111-1111-4111-8111-111111111111';
    const profile = serverProfile(profileId, 'Farm server');
    const saved = appCalibrationRecord(profileId);
    const saveCalibrationWorkspaceState = vi
      .fn<PrintFarmerApi['saveCalibrationWorkspaceState']>()
      .mockRejectedValue(new Error('local queue unavailable'));
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 2,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      listServerProfiles: vi.fn().mockResolvedValue({
        profiles: [profile],
        selectedProfileId: profileId,
      }),
      getCalibrationAvailability: vi.fn().mockResolvedValue({
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
      }),
      listCalibrationWorkspaceStates: vi.fn().mockResolvedValue({
        states: [saved],
        unhydratedProjects: [],
      }),
      getCalibrationWorkspaceState: vi.fn().mockResolvedValue(saved),
      saveCalibrationWorkspaceState,
    });

    render(<App />);
    await screen.findByRole('dialog', { name: 'Set up your model library' });
    fireEvent.keyDown(document, { key: 'Escape' });
    const calibrationSwitch = screen.getByRole('button', {
      name: 'Printer Calibration',
    });
    await waitFor(() => expect(calibrationSwitch).toBeEnabled());
    fireEvent.click(calibrationSwitch);
    fireEvent.click(
      await screen.findByRole('button', { name: /App leave flush project/ }),
    );
    const projectName = await screen.findByLabelText('Project name');
    fireEvent.change(projectName, {
      target: { value: 'Pending local edit' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Library' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Application status')).toHaveTextContent(
        /Could not leave Printer Calibration.*local queue unavailable/i,
      ),
    );
    expect(saveCalibrationWorkspaceState).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('heading', { name: 'Pending local edit' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'All models' }),
    ).not.toBeInTheDocument();
  });
});
