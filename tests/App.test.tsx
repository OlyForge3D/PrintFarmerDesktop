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
