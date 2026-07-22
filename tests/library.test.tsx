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

    const button = screen.getByRole('button', { name: /widget.stl/i });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'a' }),
    );
  });

  it('disables cards whose files are missing', () => {
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
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /gone.stl/i })).toBeDisabled();
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

  it('reports an error when the sidecar cannot render', async () => {
    installApi({
      renderThumbnail: vi.fn().mockRejectedValue(new Error('unsupported')),
    });

    const { result } = renderHook(() => useThumbnail(model({ hash: 'bad' })));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.src).toBeNull();
  });
});
