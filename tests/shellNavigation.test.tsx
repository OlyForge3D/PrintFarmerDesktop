import {
  act,
  within,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PrintFarmerApi, ResetCatalogResponse } from '@shared/ipc';
import { App } from '../src/renderer/App.js';
import {
  DEFAULT_WORKSPACE,
  WORKSPACE_GROUP_LABELS,
  WORKSPACE_LIST,
  workspaceById,
  workspacesInGroup,
} from '../src/renderer/shell/workspaces.js';

describe('workspace registry', () => {
  it('declares a unique, complete definition for every place', () => {
    const ids = WORKSPACE_LIST.map((workspace) => workspace.id);
    const landmarks = WORKSPACE_LIST.map((workspace) => workspace.landmarkId);
    const selectors = WORKSPACE_LIST.map(
      (workspace) => workspace.headingSelector,
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(landmarks).size).toBe(landmarks.length);
    expect(new Set(selectors).size).toBe(selectors.length);
    for (const workspace of WORKSPACE_LIST) {
      expect(workspace.label).not.toHaveLength(0);
      expect(workspace.skipTarget).not.toHaveLength(0);
      expect(workspaceById(workspace.id)).toBe(workspace);
    }
  });

  it('sorts every place into exactly one rail group', () => {
    const grouped = [
      ...workspacesInGroup('places'),
      ...workspacesInGroup('services'),
    ];
    expect(grouped).toHaveLength(WORKSPACE_LIST.length);
    expect(new Set(grouped.map((workspace) => workspace.id)).size).toBe(
      WORKSPACE_LIST.length,
    );
  });
});

describe('shell navigation', () => {
  it('consolidates configuration in Settings without duplicating library controls', async () => {
    installApi();
    render(<App />);
    await screen.findByRole('heading', { name: 'All models', level: 1 });
    expect(screen.queryByRole('button', { name: /^Sources/ })).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Thumbnail cache' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Add folder' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    const settings = await screen.findByRole('main', { name: 'Settings' });
    expect(
      within(settings).getByRole('heading', {
        name: 'Source folders',
        level: 2,
      }),
    ).toBeVisible();
    expect(
      within(settings).getByRole('heading', {
        name: 'Thumbnail cache',
        level: 2,
      }),
    ).toBeVisible();
    expect(
      within(settings).getByRole('heading', {
        name: 'PrintFarmer connections',
        level: 2,
      }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText('Maximum size (MiB)')).toHaveValue(512),
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);

    const manageProfiles = screen.getByRole('button', {
      name: 'Manage server profiles',
    });
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Settings', level: 1 }),
      ).toHaveFocus(),
    );
    manageProfiles.focus();
    fireEvent.click(manageProfiles);
    const dialog = await screen.findByRole('dialog', {
      name: 'Connect to PrintFarmer',
    });
    expect(dialog).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Close server profiles' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Manage server profiles' }),
      ).toHaveFocus(),
    );
  });

  it('holds navigation and other settings until a cache save settles, preserving errors', async () => {
    let rejectSave: (error: Error) => void = () => {};
    installApi({
      setThumbnailCacheSettings: vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectSave = reject;
          }),
      ),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'All models', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    await screen.findByText('/profile/scene-cache.v1');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByRole('button', { name: 'Library' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Reset catalog' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Manage server profiles' }),
    ).toBeDisabled();
    act(() => {
      rejectSave(new Error('Cache folder is not writable'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cache folder is not writable',
    );
    expect(screen.getByRole('button', { name: 'Library' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
  });

  it('offers every registered place in the rail and moves focus to the one it opens', async () => {
    installApi();
    render(<App />);
    await screen.findByRole('heading', { name: 'All models', level: 1 });

    for (const workspace of WORKSPACE_LIST) {
      expect(
        screen.getByRole('button', {
          name: new RegExp(`^${escapeForName(workspace.label)}`),
        }),
      ).toBeInTheDocument();
    }

    for (const workspace of WORKSPACE_LIST) {
      if (workspace.id === DEFAULT_WORKSPACE) continue;
      fireEvent.click(
        screen.getByRole('button', {
          name: new RegExp(`^${escapeForName(workspace.label)}`),
        }),
      );
      const landmark = await waitFor(() => {
        const main = screen.getByRole('main');
        expect(main).toHaveAttribute('id', workspace.landmarkId);
        return main;
      });
      expect(landmark).toBeVisible();
      await waitFor(() =>
        expect(document.querySelector(workspace.headingSelector)).toHaveFocus(),
      );
      expect(screen.getByRole('link', { name: /^Skip to/ })).toHaveAttribute(
        'href',
        `#${workspace.landmarkId}`,
      );
    }
  });

  it('keeps the shell to one visible h1, owned by the open place', async () => {
    installApi();
    render(<App />);
    await screen.findByRole('heading', { name: 'All models', level: 1 });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /^Uploads/ }));
    await screen.findByRole('heading', { name: 'Uploads', level: 1 });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  /*
   * Two elements with the same accessible name are ambiguous to assistive tech.
   * The rail once shared its name with its own first group, which reached CI as
   * a Playwright strict-mode violation rather than as the accessibility defect
   * it actually was.
   */
  it('does not give the rail and its groups colliding accessible names', async () => {
    installApi();
    render(<App />);
    await screen.findByRole('heading', { name: 'All models', level: 1 });

    expect(screen.getAllByRole('navigation', { name: 'Primary' })).toHaveLength(
      1,
    );

    const rail = screen.getByRole('navigation', { name: 'Primary' });
    const groupNames = [
      ...new Set(WORKSPACE_LIST.map((workspace) => workspace.group)),
    ].map((group) => WORKSPACE_GROUP_LABELS[group]);

    expect(groupNames).not.toContain('Primary');
    for (const name of groupNames) {
      expect(within(rail).getAllByRole('region', { name })).toHaveLength(1);
    }
  });

  it('reports ambient state in the statusbar instead of restating the route', async () => {
    installApi();
    render(<App />);
    await screen.findByRole('heading', { name: 'All models', level: 1 });

    const statusbar = screen.getByLabelText('Application status');
    await waitFor(() => expect(statusbar).toHaveTextContent('v0.1.0 · win32'));
    expect(statusbar).toHaveTextContent('Disconnected');
    expect(statusbar).not.toHaveTextContent('Library');

    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(statusbar).not.toHaveTextContent('Sources');
  });

  /*
   * The onboarding nudge appears on exactly the runs that have no source roots
   * yet. Locking the rail behind it would strand a first run on the one place
   * that cannot help, and it would narrow the #222 escape path that the old
   * sidebar button deliberately kept open.
   */
  it('keeps the rail usable while the onboarding nudge is open, and answers it', async () => {
    installApi({ listModels: vi.fn().mockResolvedValue([]) });
    render(<App />);

    const onboarding = await screen.findByRole('dialog', {
      name: 'Set up your model library',
    });
    const railSources = screen.getByRole('button', { name: /^Settings/ });
    expect(railSources).toBeEnabled();

    fireEvent.click(railSources);
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    expect(onboarding).not.toBeInTheDocument();
  });

  /*
   * Clearing the catalog reports what it removed exactly once. Navigating away
   * mid-reset unmounts the only surface that shows those counts, so the rail
   * holds until the destructive operation settles -- the navigation half of a
   * guard the old modal got for free by refusing to close.
   */
  it('holds navigation while a catalog reset is in flight', async () => {
    let releaseReset: (value: ResetCatalogResponse) => void = () => {};
    const resetCatalog = vi.fn(
      () =>
        new Promise<ResetCatalogResponse>((resolve) => {
          releaseReset = resolve;
        }),
    );
    installApi({ resetCatalog });
    render(<App />);
    await screen.findByRole('heading', { name: 'All models', level: 1 });

    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Reset catalog' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear local catalog' }),
    );

    const railLibrary = screen.getByRole('button', { name: 'Library' });
    await waitFor(() => expect(railLibrary).toBeDisabled());

    await act(async () => {
      releaseReset({
        reset: true,
        modelsRemoved: 1,
        sourceRootsRemoved: 1,
        tagsRemoved: 0,
        collectionsRemoved: 0,
      });
      // Let the resolved reset settle through the library hook before asserting.
      await Promise.resolve();
    });

    await waitFor(() => expect(railLibrary).toBeEnabled());
    expect(
      await screen.findByText(
        'Catalog cleared. Removed 1 indexed model, 1 source folder, 0 tags, and 0 collections.',
      ),
    ).toBeVisible();
  });

  /* A destructive confirmation that takes focus must be cancellable by keyboard
   * even though the place around it is not modal. */
  it('cancels the reset confirmation on Escape without leaving the place', async () => {
    installApi();
    render(<App />);
    await screen.findByRole('heading', { name: 'All models', level: 1 });

    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Reset catalog' }));
    const keep = await screen.findByRole('button', { name: 'Keep catalog' });
    await waitFor(() => expect(keep).toHaveFocus());

    fireEvent.keyDown(keep, { key: 'Escape' });

    await waitFor(() =>
      expect(
        screen.queryByText('Clear this local catalog?'),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('main', { name: 'Settings' })).toBeInTheDocument();
  });
});

function escapeForName(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function installApi(overrides: Partial<PrintFarmerApi> = {}): void {
  const api: Partial<PrintFarmerApi> = {
    getArchiveSettings: vi
      .fn()
      .mockResolvedValue({ maxArchiveBytes: 512 * 1024 * 1024 }),
    getThumbnailCacheSettings: vi.fn().mockResolvedValue({
      location: null,
      effectiveLocation: '/profile/scene-cache.v1',
      maxBytes: 512 * 1024 * 1024,
      retentionDays: 30,
      usedBytes: 2048,
      entryCount: 3,
      warning: null,
    }),
    getAppInfo: vi.fn().mockResolvedValue({
      contractVersion: 2,
      appVersion: '0.1.0',
      platform: 'win32',
      electronVersion: '33.0.0',
    }),
    listModels: vi.fn().mockResolvedValue([
      {
        hash: 'a'.repeat(64),
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
    ]),
    listServerProfiles: vi.fn().mockResolvedValue({
      profiles: [],
      selectedProfileId: null,
    }),
    listUploadJobs: vi.fn().mockResolvedValue([]),
    renderThumbnail: vi.fn().mockRejectedValue(new Error('not rendered')),
    resetCatalog: vi.fn().mockResolvedValue({
      reset: true,
      modelsRemoved: 1,
      sourceRootsRemoved: 1,
      tagsRemoved: 0,
      collectionsRemoved: 0,
    }),
    getCalibrationAvailability: vi.fn().mockResolvedValue({
      available: false,
      unavailableReason: 'noProfile',
      unavailableDetail: null,
      negotiatedApiVersion: null,
      negotiatedSchemaVersion: null,
      capabilityFlags: {
        calibrationApiEnabled: false,
        calibrationChangeFeedEnabled: false,
        calibrationOfflineDraftEnabled: false,
        calibrationPhotoUploadEnabled: false,
        calibrationGenerationEnabled: false,
        calibrationArtifactPromotionEnabled: false,
      },
      grantedScopes: [],
      offlineEditingEnabled: false,
    }),
    listCalibrationWorkspaceStates: vi.fn().mockResolvedValue({
      states: [],
      unhydratedProjects: [],
    }),
    ...overrides,
  };
  Object.defineProperty(window, 'printFarmer', {
    value: withModelPaging(api),
    configurable: true,
  });
}
import { withModelPaging } from './helpers/libraryPage';
