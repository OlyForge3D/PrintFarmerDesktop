import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import type { LogicalModel, PrintFarmerApi } from '@shared/ipc';
import { useLibrary } from '../src/renderer/library/useLibrary.js';
import { ModelGrid } from '../src/renderer/library/ModelGrid.js';
import { PropertiesInspector } from '../src/renderer/library/PropertiesInspector.js';
import { TagEditor } from '../src/renderer/library/TagEditor.js';
import { CollectionEditor } from '../src/renderer/library/CollectionEditor.js';
import { PartTree } from '../src/renderer/library/PartTree.js';
import { ModelStats } from '../src/renderer/library/ModelStats.js';
import {
  VendorPanel,
  formatDuration,
} from '../src/renderer/library/VendorPanel.js';
import { useVendorMetadata } from '../src/renderer/library/useVendorMetadata.js';
import {
  computeSceneStats,
  formatDimension,
} from '../src/renderer/library/sceneStats.js';
import { visibleIndices } from '../src/renderer/viewer/geometry.js';
import type { SceneMesh } from '../src/renderer/viewer/types.js';
import { useModelTags } from '../src/renderer/library/useModelTags.js';
import { useModelCollections } from '../src/renderer/library/useModelCollections.js';
import {
  defaultLibraryView,
  selectLibraryView,
} from '../src/renderer/library/filter.js';
import { useFavorites } from '../src/renderer/library/useFavorites.js';
import {
  clearThumbnailCache,
  useThumbnail,
} from '../src/renderer/library/useThumbnail.js';
import {
  basename,
  formatBytes,
  formatLabel,
  isAvailable,
  modelDisplayName,
  preferredPath,
  rootIdForPath,
} from '../src/renderer/library/model.js';

function installApi(api: Partial<PrintFarmerApi>): void {
  Object.defineProperty(window, 'printFarmer', {
    value: api,
    configurable: true,
    writable: true,
  });
}

function model(overrides: Partial<LogicalModel> = {}): LogicalModel {
  return {
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
    ...overrides,
  };
}

describe('library model helpers', () => {
  it('derives a stable rootId per path', () => {
    expect(rootIdForPath('C:\\models')).toBe(rootIdForPath('C:\\models'));
    expect(rootIdForPath('C:\\models')).not.toBe(rootIdForPath('C:\\other'));
    expect(rootIdForPath('C:\\models')).toMatch(/^root-[0-9a-f]+$/);
  });

  it('extracts the basename from either separator', () => {
    expect(basename('C:\\a\\b\\part.stl')).toBe('part.stl');
    expect(basename('/a/b/part.3mf')).toBe('part.3mf');
    expect(basename('/a/b/')).toBe('b');
  });

  it('names a model from its first location', () => {
    expect(modelDisplayName(model())).toBe('widget.stl');
    expect(modelDisplayName(model({ locations: [] }))).toBe('deadbeef');
  });

  it('labels formats and formats bytes', () => {
    expect(formatLabel('stl')).toBe('STL');
    expect(formatLabel('threeMf')).toBe('3MF');
    expect(formatLabel('obj')).toBe('OBJ');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('reports availability and preferred path', () => {
    expect(isAvailable(model())).toBe(true);
    expect(preferredPath(model())).toBe('C:\\models\\widget.stl');
    const missing = model({
      locations: [
        {
          rootId: 'r',
          path: 'C:\\gone.stl',
          rootRelative: 'gone.stl',
          size: 1,
          available: false,
        },
      ],
    });
    expect(isAvailable(missing)).toBe(false);
  });
});

describe('useLibrary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the persisted catalog on mount', async () => {
    const listModels = vi.fn().mockResolvedValue([model()]);
    installApi({ listModels });

    const { result } = renderHook(() => useLibrary());

    await waitFor(() => expect(result.current.models).toHaveLength(1));
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('scans a chosen folder then refreshes the model list', async () => {
    const openFolder = vi.fn().mockResolvedValue({ path: 'C:\\models' });
    const scanRoot = vi.fn().mockResolvedValue({
      added: 1,
      changed: 0,
      unchanged: 0,
      missing: 0,
      hashErrors: 0,
    });
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([model()]);
    installApi({ openFolder, scanRoot, listModels });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.addFolder();
    });

    expect(scanRoot).toHaveBeenCalledWith({
      rootId: rootIdForPath('C:\\models'),
      path: 'C:\\models',
    });
    expect(result.current.models).toHaveLength(1);
    expect(result.current.lastReport?.added).toBe(1);
  });

  it('exposes the selected folder path while a scan is running', async () => {
    const report = {
      added: 0,
      changed: 0,
      unchanged: 0,
      missing: 0,
      hashErrors: 0,
    };
    let finishScan!: (value: typeof report) => void;
    const scanPromise = new Promise<typeof report>((resolve) => {
      finishScan = resolve;
    });
    const openFolder = vi.fn().mockResolvedValue({ path: 'C:\\models' });
    const scanRoot = vi.fn().mockReturnValue(scanPromise);
    const listModels = vi.fn().mockResolvedValue([]);
    installApi({ openFolder, scanRoot, listModels });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));

    let addFolderPromise: Promise<void> | undefined;
    await act(async () => {
      addFolderPromise = result.current.addFolder();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('scanning');
    expect(result.current.scanningPath).toBe('C:\\models');

    await act(async () => {
      finishScan(report);
      await addFolderPromise;
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.scanningPath).toBeNull();
  });

  it('does not scan when the folder dialog is cancelled', async () => {
    const openFolder = vi.fn().mockResolvedValue(null);
    const scanRoot = vi.fn();
    const listModels = vi.fn().mockResolvedValue([]);
    installApi({ openFolder, scanRoot, listModels });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.addFolder();
    });

    expect(scanRoot).not.toHaveBeenCalled();
  });

  it('surfaces an error when the catalog cannot be read', async () => {
    installApi({
      listModels: vi.fn().mockRejectedValue(new Error('sidecar offline')),
    });

    const { result } = renderHook(() => useLibrary());

    await waitFor(() => expect(result.current.error).toBe('sidecar offline'));
  });
});

describe('selectLibraryView', () => {
  const stl = (name: string, size: number, available = true): LogicalModel =>
    model({
      hash: `h-${name}`,
      size,
      locations: [
        {
          rootId: 'r',
          path: `C:\\models\\${name}`,
          rootRelative: name,
          size,
          available,
        },
      ],
    });

  const dup = model({
    hash: 'h-dup',
    size: 10,
    locations: [
      {
        rootId: 'r',
        path: 'C:\\a\\dup.stl',
        rootRelative: 'dup.stl',
        size: 10,
        available: true,
      },
      {
        rootId: 'r',
        path: 'C:\\b\\dup.stl',
        rootRelative: 'dup.stl',
        size: 10,
        available: true,
      },
    ],
  });

  const models = [
    stl('beta.stl', 300),
    stl('alpha.stl', 100),
    stl('gone.stl', 200, false),
    dup,
  ];

  it('passes everything through with the default view', () => {
    expect(selectLibraryView(models, defaultLibraryView)).toHaveLength(4);
  });

  it('filters by case-insensitive name query', () => {
    const result = selectLibraryView(models, {
      ...defaultLibraryView,
      query: 'ALPHA',
    });
    expect(result.map((m) => m.hash)).toEqual(['h-alpha.stl']);
  });

  it('sorts by name then by size', () => {
    const byName = selectLibraryView(models, defaultLibraryView);
    expect(byName.map((m) => modelDisplayName(m))[0]).toBe('alpha.stl');

    const bySize = selectLibraryView(models, {
      ...defaultLibraryView,
      sort: 'size',
    });
    expect(bySize[0]?.size).toBe(300);
  });

  it('filters to favorites using the provided hash set', () => {
    const favorites = new Set(['h-alpha.stl', 'h-dup']);
    const result = selectLibraryView(models, {
      ...defaultLibraryView,
      filter: 'favorites',
      favorites,
    });
    expect(result.map((m) => m.hash).sort()).toEqual(['h-alpha.stl', 'h-dup']);
  });

  it('returns nothing for the favorites filter without a set', () => {
    expect(
      selectLibraryView(models, { ...defaultLibraryView, filter: 'favorites' }),
    ).toHaveLength(0);
  });

  it('filters by model format and searches physical paths', () => {
    const obj = model({
      hash: 'h-obj',
      format: 'obj',
      locations: [
        {
          rootId: 'r',
          path: 'D:\\Archive\\Robots\\armature.obj',
          rootRelative: 'Robots\\armature.obj',
          size: 12,
          available: true,
        },
      ],
    });
    const withObj = [...models, obj];

    expect(
      selectLibraryView(withObj, {
        ...defaultLibraryView,
        filter: 'obj',
      }).map((item) => item.hash),
    ).toEqual(['h-obj']);
    expect(
      selectLibraryView(withObj, {
        ...defaultLibraryView,
        query: 'robots',
      }).map((item) => item.hash),
    ).toEqual(['h-obj']);
  });
});

describe('useFavorites', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
  });

  it('toggles favorites and persists them to localStorage', () => {
    const { result } = renderHook(() => useFavorites());
    expect(result.current.isFavorite('abc')).toBe(false);

    act(() => {
      result.current.toggle('abc');
    });
    expect(result.current.isFavorite('abc')).toBe(true);
    expect(
      globalThis.localStorage.getItem('printfarmer.favorites.v1'),
    ).toContain('abc');

    act(() => {
      result.current.toggle('abc');
    });
    expect(result.current.isFavorite('abc')).toBe(false);
  });

  it('rehydrates favorites from localStorage', () => {
    globalThis.localStorage.setItem(
      'printfarmer.favorites.v1',
      JSON.stringify(['seeded']),
    );
    const { result } = renderHook(() => useFavorites());
    expect(result.current.isFavorite('seeded')).toBe(true);
  });
});

describe('<ModelGrid />', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearThumbnailCache();
    installApi({
      renderThumbnail: vi.fn().mockRejectedValue(new Error('no renderer')),
    });
  });

  it('shows an empty-state prompt with no models', () => {
    render(<ModelGrid models={[]} selectedHash={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/Add a folder to scan/i)).toBeInTheDocument();
  });

  it('renders a card per model and reports selection', () => {
    const onSelect = vi.fn();
    render(
      <ModelGrid
        models={[model({ hash: 'a', size: 1024 })]}
        selectedHash={null}
        onSelect={onSelect}
      />,
    );

    const button = screen.getByRole('button', { name: 'Select widget.stl' });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'a' }),
    );
  });

  it('keeps missing cards selectable but disables their preview action', () => {
    const onSelect = vi.fn();
    const onPreview = vi.fn();
    render(
      <ModelGrid
        models={[
          model({
            hash: 'gone',
            locations: [
              {
                rootId: 'r',
                path: 'C:\\gone.stl',
                rootRelative: 'gone.stl',
                size: 1,
                available: false,
              },
            ],
          }),
        ]}
        selectedHash={null}
        onSelect={onSelect}
        onPreview={onPreview}
      />,
    );
    const select = screen.getByRole('button', { name: 'Select gone.stl' });
    expect(select).toBeEnabled();
    fireEvent.click(select);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'gone' }),
    );
    expect(
      screen.getByRole('button', { name: 'Preview gone.stl in 3D' }),
    ).toBeDisabled();
    expect(onPreview).not.toHaveBeenCalled();
  });

  it('separates selection from explicit 3D preview', () => {
    const onSelect = vi.fn();
    const onPreview = vi.fn();
    render(
      <ModelGrid
        models={[model({ hash: 'a' })]}
        selectedHash={null}
        onSelect={onSelect}
        onPreview={onPreview}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Select widget.stl' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onPreview).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Preview widget.stl in 3D' }),
    );
    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'a' }),
    );
  });

  it('renders a favorite toggle and reports the model', () => {
    const onToggleFavorite = vi.fn();
    render(
      <ModelGrid
        models={[model({ hash: 'a' })]}
        selectedHash={null}
        onSelect={vi.fn()}
        isFavorite={(hash) => hash === 'a'}
        onToggleFavorite={onToggleFavorite}
      />,
    );

    const fav = screen.getByRole('button', { name: /Unfavorite/i });
    expect(fav).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(fav);
    expect(onToggleFavorite).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'a' }),
    );
  });
});

describe('<PropertiesInspector />', () => {
  it('bounds the rendered duplicate-location list', () => {
    installApi({
      renderThumbnail: vi.fn().mockRejectedValue(new Error('no renderer')),
    });
    const locations = Array.from({ length: 30 }, (_, index) => ({
      rootId: `root-${index}`,
      path: `D:\\copies\\${index}\\widget.stl`,
      rootRelative: `${index}\\widget.stl`,
      size: 2048,
      available: true,
    }));
    const { container } = render(
      <PropertiesInspector
        model={model({ locations })}
        favorite={false}
        mesh={null}
        vendorMetadata={null}
        tags={[]}
        collections={[]}
        collectionMembership={new Set()}
        organizationError={null}
        onToggleFavorite={vi.fn()}
        onPreview={vi.fn()}
        onAddTag={vi.fn()}
        onRemoveTag={vi.fn()}
        onToggleCollection={vi.fn()}
        onCreateCollection={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Showing the first 25 of 30 locations.'),
    ).toBeVisible();
    expect(container.querySelectorAll('.location-list > li')).toHaveLength(26);
  });
});

describe('useModelTags', () => {
  it('loads tags for the selected model and adds/removes them', async () => {
    const tagsForModel = vi.fn().mockResolvedValue([{ id: 'a', name: 'A' }]);
    const addModelTag = vi.fn().mockResolvedValue([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ]);
    const removeModelTag = vi.fn().mockResolvedValue([{ id: 'b', name: 'B' }]);
    installApi({ tagsForModel, addModelTag, removeModelTag });

    const { result } = renderHook(() => useModelTags('h1'));
    await waitFor(() => expect(result.current.tags).toHaveLength(1));
    expect(tagsForModel).toHaveBeenCalledWith({ hash: 'h1' });

    await act(async () => {
      await result.current.add('B');
    });
    expect(addModelTag).toHaveBeenCalledWith({ hash: 'h1', name: 'B' });
    expect(result.current.tags).toHaveLength(2);

    await act(async () => {
      await result.current.remove('a');
    });
    expect(removeModelTag).toHaveBeenCalledWith({ hash: 'h1', tagId: 'a' });
    expect(result.current.tags).toEqual([{ id: 'b', name: 'B' }]);
  });

  it('holds no tags and makes no calls when nothing is selected', () => {
    const tagsForModel = vi.fn();
    installApi({ tagsForModel });
    const { result } = renderHook(() => useModelTags(null));
    expect(result.current.tags).toEqual([]);
    expect(tagsForModel).not.toHaveBeenCalled();
  });
});

describe('useModelCollections', () => {
  const dragons = {
    id: 'col-1',
    name: 'Dragons',
    sharedToFarm: false,
    memberCount: 1,
  };
  const terrain = {
    id: 'col-2',
    name: 'Terrain',
    sharedToFarm: false,
    memberCount: 0,
  };

  it('loads collections and membership, then toggles a model in', async () => {
    const listCollections = vi.fn().mockResolvedValue([dragons, terrain]);
    const collectionsForModel = vi.fn().mockResolvedValue([dragons]);
    const addModelToCollection = vi.fn().mockResolvedValue([dragons, terrain]);
    installApi({ listCollections, collectionsForModel, addModelToCollection });

    const { result } = renderHook(() => useModelCollections('h1'));
    await waitFor(() => expect(result.current.all).toHaveLength(2));
    expect(collectionsForModel).toHaveBeenCalledWith({ hash: 'h1' });
    expect(result.current.membership.has('col-1')).toBe(true);
    expect(result.current.membership.has('col-2')).toBe(false);

    listCollections.mockResolvedValue([dragons, terrain]);
    await act(async () => {
      await result.current.toggle('col-2');
    });
    expect(addModelToCollection).toHaveBeenCalledWith({
      collectionId: 'col-2',
      hash: 'h1',
    });
    expect(result.current.membership.has('col-2')).toBe(true);
  });

  it('removes a model from a collection it belongs to', async () => {
    const listCollections = vi.fn().mockResolvedValue([dragons]);
    const collectionsForModel = vi.fn().mockResolvedValue([dragons]);
    const removeModelFromCollection = vi.fn().mockResolvedValue([]);
    installApi({
      listCollections,
      collectionsForModel,
      removeModelFromCollection,
    });

    const { result } = renderHook(() => useModelCollections('h1'));
    await waitFor(() =>
      expect(result.current.membership.has('col-1')).toBe(true),
    );

    await act(async () => {
      await result.current.toggle('col-1');
    });
    expect(removeModelFromCollection).toHaveBeenCalledWith({
      collectionId: 'col-1',
      hash: 'h1',
    });
    expect(result.current.membership.has('col-1')).toBe(false);
  });

  it('creates a collection and adds the model to it', async () => {
    const listCollections = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([dragons]);
    const collectionsForModel = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([dragons]);
    const createCollection = vi.fn().mockResolvedValue(dragons);
    const addModelToCollection = vi.fn().mockResolvedValue([dragons]);
    installApi({
      listCollections,
      collectionsForModel,
      createCollection,
      addModelToCollection,
    });

    const { result } = renderHook(() => useModelCollections('h1'));
    await waitFor(() => expect(result.current.all).toEqual([]));

    await act(async () => {
      await result.current.createAndAdd('Dragons');
    });
    expect(createCollection).toHaveBeenCalledWith({ name: 'Dragons' });
    expect(addModelToCollection).toHaveBeenCalledWith({
      collectionId: 'col-1',
      hash: 'h1',
    });
    await waitFor(() =>
      expect(result.current.membership.has('col-1')).toBe(true),
    );
  });

  it('makes no calls when nothing is selected', () => {
    const listCollections = vi.fn();
    installApi({ listCollections });
    const { result } = renderHook(() => useModelCollections(null));
    expect(result.current.all).toEqual([]);
    expect(listCollections).not.toHaveBeenCalled();
  });
});

describe('<CollectionEditor />', () => {
  it('renders membership checkboxes and reports toggles', () => {
    const onToggle = vi.fn();
    const onCreate = vi.fn();
    render(
      <CollectionEditor
        all={[
          { id: 'col-1', name: 'Dragons', sharedToFarm: false, memberCount: 2 },
        ]}
        membership={new Set(['col-1'])}
        onToggle={onToggle}
        onCreate={onCreate}
      />,
    );

    const checkbox = screen.getByRole('checkbox', { name: /Dragons/i });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith('col-1');

    fireEvent.change(screen.getByLabelText(/New collection name/i), {
      target: { value: '  Terrain ' },
    });
    fireEvent.submit(
      screen.getByLabelText(/New collection name/i).closest('form')!,
    );
    expect(onCreate).toHaveBeenCalledWith('Terrain');
  });
});

function partedMesh(): SceneMesh {
  return {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1],
    indices: [0, 1, 2, 3, 4, 5],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    sourceFormat: 'threeMf',
    parts: [
      { name: 'A', triangleStart: 0, triangleCount: 1 },
      { name: 'B', triangleStart: 1, triangleCount: 1 },
    ],
  };
}

describe('visibleIndices', () => {
  it('returns the full index buffer when nothing is hidden', () => {
    const mesh = partedMesh();
    expect(visibleIndices(mesh)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(visibleIndices(mesh, new Set())).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('omits the triangle ranges of hidden parts', () => {
    const mesh = partedMesh();
    expect(visibleIndices(mesh, new Set([0]))).toEqual([3, 4, 5]);
    expect(visibleIndices(mesh, new Set([1]))).toEqual([0, 1, 2]);
    expect(visibleIndices(mesh, new Set([0, 1]))).toEqual([]);
  });

  it('ignores hidden parts on a mesh without a part table', () => {
    const mesh: SceneMesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'stl',
    };
    expect(visibleIndices(mesh, new Set([0]))).toEqual([0, 1, 2]);
  });
});

describe('<PartTree />', () => {
  it('renders nothing when there are no parts', () => {
    const { container } = render(
      <PartTree
        parts={[]}
        hidden={new Set()}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('lists parts and reports visibility toggles', () => {
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <PartTree
        parts={[
          { name: 'Body', triangleStart: 0, triangleCount: 12 },
          { name: 'Lid', triangleStart: 12, triangleCount: 6 },
        ]}
        hidden={new Set([1])}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
      />,
    );

    const body = screen.getByRole('checkbox', { name: /Body/i });
    const lid = screen.getByRole('checkbox', { name: /Lid/i });
    expect(body).toBeChecked();
    expect(lid).not.toBeChecked();

    fireEvent.click(lid);
    expect(onToggle).toHaveBeenCalledWith(1);

    // Some parts are hidden, so the control offers to show all.
    fireEvent.click(screen.getByRole('button', { name: /Show all/i }));
    expect(onToggleAll).toHaveBeenCalledWith(true);
  });
});

describe('computeSceneStats', () => {
  it('derives counts and dimensions from a mesh', () => {
    const stats = computeSceneStats(partedMesh());
    expect(stats.triangles).toBe(2);
    expect(stats.vertices).toBe(6);
    expect(stats.dimensions).toEqual([1, 1, 1]);
    expect(stats.parts).toBe(2);
    expect(stats.format).toBe('threeMf');
  });

  it('formats dimensions without trailing zeros', () => {
    expect(formatDimension(12.5)).toBe('12.5');
    expect(formatDimension(3)).toBe('3');
    expect(formatDimension(1.005)).toBe('1');
  });
});

describe('<ModelStats />', () => {
  it('renders format, dimensions, and counts', () => {
    render(<ModelStats mesh={partedMesh()} />);
    expect(screen.getByText('3MF')).toBeInTheDocument();
    expect(screen.getByText('1 × 1 × 1')).toBeInTheDocument();
    expect(screen.getByText('Triangles')).toBeInTheDocument();
    // Two parts, so the Parts row appears.
    expect(screen.getByText('Parts')).toBeInTheDocument();
  });
});

describe('useVendorMetadata', () => {
  const vendorResult = {
    slicer: 'orcaSlicer' as const,
    core: { title: 'Widget' },
    plates: [] as never[],
    thumbnails: [] as string[],
  };

  it('fetches vendor metadata for a 3MF path', async () => {
    const extractVendorMetadata = vi.fn().mockResolvedValue(vendorResult);
    installApi({ extractVendorMetadata });
    const { result } = renderHook(() =>
      useVendorMetadata('C:/m/widget.3mf', 'threeMf'),
    );
    await waitFor(() => expect(result.current.metadata).not.toBeNull());
    expect(extractVendorMetadata).toHaveBeenCalledWith({
      path: 'C:/m/widget.3mf',
    });
  });

  it('does not call the sidecar for STL or when no path is set', () => {
    const extractVendorMetadata = vi.fn();
    installApi({ extractVendorMetadata });

    const stl = renderHook(() => useVendorMetadata('C:/m/a.stl', 'stl'));
    expect(stl.result.current.metadata).toBeNull();

    const none = renderHook(() => useVendorMetadata(null, null));
    expect(none.result.current.metadata).toBeNull();
    expect(extractVendorMetadata).not.toHaveBeenCalled();
  });
});

describe('<VendorPanel />', () => {
  it('formats print-time durations', () => {
    expect(formatDuration(90)).toBe('2m');
    expect(formatDuration(3720)).toBe('1h 2m');
    expect(formatDuration(0)).toBe('0m');
  });

  it('renders slicer, core metadata, and per-plate stats', () => {
    render(
      <VendorPanel
        metadata={{
          slicer: 'bambuStudio',
          core: { title: 'Dragon', designer: 'Ann' },
          plates: [
            {
              index: 1,
              predictionSeconds: 3720,
              weightGrams: 12.5,
              filamentTypes: ['PLA'],
            },
          ],
          thumbnails: [],
        }}
      />,
    );
    expect(screen.getByText('Bambu Studio')).toBeInTheDocument();
    expect(screen.getByText('Dragon')).toBeInTheDocument();
    expect(screen.getByText('Plate 1')).toBeInTheDocument();
    expect(screen.getByText(/1h 2m · 12\.5g · PLA/)).toBeInTheDocument();
  });

  it('shows an empty note when there is no vendor data', () => {
    render(
      <VendorPanel
        metadata={{
          slicer: 'unknown',
          core: {},
          plates: [],
          thumbnails: [],
        }}
      />,
    );
    expect(screen.getByText(/No slicer\/vendor metadata/i)).toBeInTheDocument();
  });
});

describe('<TagEditor />', () => {
  it('renders chips and reports add/remove', () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    render(
      <TagEditor
        tags={[{ id: 'minis', name: 'Minis' }]}
        onAdd={onAdd}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Remove tag Minis/i }));
    expect(onRemove).toHaveBeenCalledWith('minis');

    fireEvent.change(screen.getByLabelText(/Add a tag/i), {
      target: { value: '  Terrain ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    expect(onAdd).toHaveBeenCalledWith('Terrain');
  });
});

describe('useThumbnail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearThumbnailCache();
  });

  it('renders a data URL once the sidecar returns a PNG', async () => {
    const renderThumbnail = vi.fn().mockResolvedValue({
      width: 256,
      height: 256,
      pngBase64: 'iVBORw0KGgo=',
    });
    installApi({ renderThumbnail });

    const { result } = renderHook(() => useThumbnail(model()));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.src).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(renderThumbnail).toHaveBeenCalledWith({
      path: 'C:\\models\\widget.stl',
      size: 256,
    });
  });

  it('caches by content hash across hook instances', async () => {
    const renderThumbnail = vi.fn().mockResolvedValue({
      width: 256,
      height: 256,
      pngBase64: 'AAAA',
    });
    installApi({ renderThumbnail });

    const first = renderHook(() => useThumbnail(model({ hash: 'shared' })));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));

    const second = renderHook(() => useThumbnail(model({ hash: 'shared' })));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));

    expect(renderThumbnail).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight render across hook instances', async () => {
    const result = {
      width: 256,
      height: 256,
      pngBase64: 'SHARED',
    };
    let finish!: (value: typeof result) => void;
    const renderThumbnail = vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          finish = resolve;
        }),
    );
    installApi({ renderThumbnail });

    const first = renderHook(() => useThumbnail(model({ hash: 'pending' })));
    const second = renderHook(() => useThumbnail(model({ hash: 'pending' })));
    await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(1));

    await act(async () => {
      finish(result);
      await Promise.resolve();
    });
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    expect(second.result.current.status).toBe('ready');
  });

  it('bounds concurrent thumbnail work', async () => {
    const result = {
      width: 256,
      height: 256,
      pngBase64: 'BOUNDED',
    };
    const finishes: Array<(value: typeof result) => void> = [];
    const renderThumbnail = vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          finishes.push(resolve);
        }),
    );
    installApi({ renderThumbnail });

    const hooks = ['one', 'two', 'three', 'four'].map((hash) =>
      renderHook(() => useThumbnail(model({ hash }))),
    );
    await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(3));

    await act(async () => {
      finishes[0]?.(result);
      await Promise.resolve();
    });
    await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(4));

    await act(async () => {
      finishes.slice(1).forEach((finish) => finish(result));
      await Promise.resolve();
    });
    await waitFor(() =>
      hooks.forEach((hook) => expect(hook.result.current.status).toBe('ready')),
    );
  });

  it('reports an error when the sidecar cannot render', async () => {
    installApi({
      renderThumbnail: vi.fn().mockRejectedValue(new Error('unsupported')),
    });

    const { result } = renderHook(() => useThumbnail(model({ hash: 'bad' })));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.src).toBeNull();
  });
});
