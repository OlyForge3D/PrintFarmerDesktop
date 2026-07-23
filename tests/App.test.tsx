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
import type {
  LoadSceneResponse,
  LogicalModel,
  PrintFarmerApi,
} from '@shared/ipc';
import { rootIdForPath } from '../src/renderer/library/model.js';

vi.mock('../src/renderer/viewer/PreviewWorkspace.js', () => ({
  PreviewWorkspace: ({
    name,
    loading,
    error,
    mesh,
    onClose,
  }: {
    name: string;
    loading: boolean;
    error: string | null;
    mesh: LoadSceneResponse | null;
    onClose: () => void;
  }) => (
    <section role="dialog" aria-label={`3D preview of ${name}`}>
      <span>{loading ? `Loading ${name}` : null}</span>
      <span>{error}</span>
      <span>{mesh?.sourceFormat}</span>
      <button type="button" onClick={onClose}>
        Back to library
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

describe('<App />', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders app info returned by the main process', async () => {
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 1,
        appVersion: '0.1.0',
        platform: 'darwin',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByLabelText('Application status')).toHaveTextContent(
        'v0.1.0 / darwin',
      ),
    );
  });

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
        contractVersion: 1,
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
        contractVersion: 1,
        appVersion: '0.1.0',
        platform: 'win32',
        electronVersion: '33.0.0',
      }),
      listModels: vi.fn().mockResolvedValue([]),
      openFolder: vi.fn().mockResolvedValue({ path: selectedPath }),
      previewImport,
      importRoot,
      scanRoot,
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });

    render(<App />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Add your first folder' }),
    );

    expect(
      await screen.findByRole('dialog', {
        name: 'Organize models before importing',
      }),
    ).toBeVisible();
    expect(previewImport).toHaveBeenCalledWith({ path: selectedPath });
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
        path: selectedPath,
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
      () => new Promise<{ path: string } | null>(() => undefined),
    );
    const loadScene = vi.fn();
    installApi({
      getAppInfo: vi.fn().mockResolvedValue({
        contractVersion: 1,
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
        contractVersion: 1,
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
      openFolder: vi.fn().mockResolvedValue({ path: 'C:\\ImportRoot' }),
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
        contractVersion: 1,
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
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        sourceFormat: 'obj',
        parts: [],
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
});
