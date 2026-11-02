import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  QueryModelsRequest,
  QueryModelsResponse,
  type LogicalModel,
  type PrintFarmerApi,
} from '@shared/ipc';
import { useLibrary } from '../src/renderer/library/useLibrary';
import { defaultLibraryView } from '../src/renderer/library/filter';
import { LibrarySidebar } from '../src/renderer/library/LibrarySidebar';
import { LibraryPagination } from '../src/renderer/library/LibraryPagination';
import { ModelGrid } from '../src/renderer/library/ModelGrid';
import {
  clearThumbnailCache,
  useThumbnail,
} from '../src/renderer/library/useThumbnail';
import { modelPage } from './helpers/libraryPage';

const models: LogicalModel[] = Array.from({ length: 130 }, (_, i) => ({
  hash: `model-${i}`,
  format: 'stl',
  size: i + 1,
  locations: [
    {
      rootId: 'r',
      path: `/models/model${i}.stl`,
      rootRelative: `model${i}.stl`,
      size: i + 1,
      available: true,
    },
  ],
}));

function api(value: Partial<PrintFarmerApi>): void {
  Object.defineProperty(window, 'printFarmer', {
    value: {
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
      ...value,
    },
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  clearThumbnailCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bounded library queries', () => {
  it('sends tag filters to the database and intersects them with collections', async () => {
    const membership = { 'model-1': ['a'], 'model-2': ['a'], 'model-3': ['b'] };
    const tagsByHash = {
      'model-2': ['red'],
      'model-3': ['red'],
      'model-4': ['blue'],
    };
    const queryModels = vi
      .fn<PrintFarmerApi['queryModels']>()
      .mockImplementation((request) =>
        Promise.resolve(modelPage(models, request, [], membership, tagsByHash)),
      );
    const listModels = vi.fn();
    api({
      queryModels,
      listModels,
      listTags: vi.fn().mockResolvedValue([{ id: 'red', name: 'Red' }]),
    });
    const hook = renderHook(
      ({ collections, tags }) =>
        useLibrary(defaultLibraryView, collections, tags),
      { initialProps: { collections: [] as string[], tags: [] as string[] } },
    );
    await waitFor(() => expect(hook.result.current.models).toHaveLength(48));
    expect(hook.result.current.tags.map((tag) => tag.id)).toEqual(['red']);
    act(() => hook.result.current.setPage(2));
    await waitFor(() => expect(hook.result.current.page).toBe(2));

    hook.rerender({ collections: [], tags: ['red', 'blue'] });
    await waitFor(() => expect(hook.result.current.filteredTotal).toBe(3));
    expect(hook.result.current.page).toBe(1);
    expect(QueryModelsRequest.parse(queryModels.mock.lastCall?.[0])).toEqual(
      expect.objectContaining({ tagIds: ['blue', 'red'], page: 1 }),
    );

    hook.rerender({ collections: ['a'], tags: ['red'] });
    await waitFor(() => expect(hook.result.current.filteredTotal).toBe(1));
    expect(hook.result.current.models.map((model) => model.hash)).toEqual([
      'model-2',
    ]);
    expect(hook.result.current.queryRequest).toEqual(
      expect.objectContaining({ collectionIds: ['a'], tagIds: ['red'] }),
    );
    expect(hook.result.current.queryPending).toBe(false);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('renders tag filters in the sidebar and reports selections', () => {
    const onTagsChange = vi.fn();
    render(
      <LibrarySidebar
        query=""
        filter="all"
        counts={
          modelPage(models, {
            query: '',
            filter: 'all',
            sort: 'name-asc',
            collectionIds: [],
            excludedRootIds: [],
            page: 1,
            pageSize: 48,
          }).counts
        }
        scanningFolder={null}
        busy={false}
        sourceRoots={[]}
        onQueryChange={vi.fn()}
        onFilterChange={vi.fn()}
        onAddFolder={vi.fn()}
        collections={[]}
        selectedCollections={[]}
        onCollectionsChange={vi.fn()}
        tags={[{ id: 'red', name: 'Red' }]}
        selectedTags={[]}
        onTagsChange={onTagsChange}
      />,
    );
    const tags = screen.getByRole('group', { name: 'Tags filter' });
    fireEvent.click(within(tags).getByRole('checkbox', { name: 'Red' }));
    expect(onTagsChange).toHaveBeenCalledWith(['red']);
    expect(
      screen.getByText('Tag and collection scopes are combined.'),
    ).toBeTruthy();
  });
  it('fetches bounded pages, keeps global totals, and persists page size', async () => {
    const listModels = vi.fn();
    const queryModels = vi
      .fn<PrintFarmerApi['queryModels']>()
      .mockImplementation((request) =>
        Promise.resolve(modelPage(models, request)),
      );
    api({ listModels, queryModels });
    const hook = renderHook(() => useLibrary());
    await waitFor(() => expect(hook.result.current.models).toHaveLength(48));
    expect(hook.result.current.totalModels).toBe(130);
    expect(hook.result.current.sourceRoots[0]?.totalModels).toBe(130);
    act(() => hook.result.current.setPage(2));
    await waitFor(() =>
      expect(hook.result.current.models[0]?.hash).toBe('model-48'),
    );
    expect(hook.result.current.page).toBe(2);
    act(() => hook.result.current.setPageSize(96));
    await waitFor(() => expect(hook.result.current.models).toHaveLength(96));
    expect(hook.result.current.page).toBe(1);
    expect(listModels).not.toHaveBeenCalled();
    hook.unmount();
    const reopened = renderHook(() => useLibrary());
    await waitFor(() =>
      expect(reopened.result.current.models).toHaveLength(96),
    );
    expect(reopened.result.current.pageSize).toBe(96);
  });

  it('resets to page one for additive collections and discards stale responses', async () => {
    const membership = {
      'model-1': ['a', 'b'],
      'model-2': ['b'],
      'model-3': ['c'],
    };
    const queryModels = vi
      .fn<PrintFarmerApi['queryModels']>()
      .mockImplementation((request) =>
        Promise.resolve(modelPage(models, request, [], membership)),
      );
    api({ queryModels });
    const hook = renderHook(({ ids }) => useLibrary(defaultLibraryView, ids), {
      initialProps: { ids: [] as string[] },
    });
    await waitFor(() => expect(hook.result.current.models).toHaveLength(48));
    act(() => hook.result.current.setPage(2));
    await waitFor(() =>
      expect(hook.result.current.models[0]?.hash).toBe('model-48'),
    );
    hook.rerender({ ids: ['a', 'b'] });
    await waitFor(() => expect(hook.result.current.filteredTotal).toBe(2));
    expect(hook.result.current.page).toBe(1);
    expect(hook.result.current.models.map((m) => m.hash)).toEqual([
      'model-1',
      'model-2',
    ]);

    let oldResolve: (result: ReturnType<typeof modelPage>) => void = () =>
      undefined;
    queryModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldResolve = resolve;
        }),
    );
    let pending: Promise<void>;
    act(() => {
      pending = hook.result.current.refresh();
    });
    hook.rerender({ ids: ['c'] });
    await waitFor(() =>
      expect(hook.result.current.models[0]?.hash).toBe('model-3'),
    );
    await act(async () => {
      oldResolve(
        modelPage(models, {
          ...queryModels.mock.calls[0]![0],
          collectionIds: [],
        }),
      );
      await pending!;
    });
    expect(hook.result.current.models.map((m) => m.hash)).toEqual(['model-3']);
  });

  it('coalesces typed search into one database request', async () => {
    vi.useFakeTimers();
    const queryModels = vi
      .fn<PrintFarmerApi['queryModels']>()
      .mockImplementation((request) =>
        Promise.resolve(modelPage(models, request)),
      );
    api({ queryModels });
    const hook = renderHook(
      ({ query }) => useLibrary({ ...defaultLibraryView, query }),
      { initialProps: { query: '' } },
    );
    await act(async () => {
      await Promise.resolve();
    });

    hook.rerender({ query: 'mod' });
    hook.rerender({ query: 'model129' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(queryModels).toHaveBeenCalledTimes(2);
    expect(hook.result.current.models.map((m) => m.hash)).toEqual([
      'model-129',
    ]);
  });

  it('does not present a failed page transition as current results', async () => {
    const queryModels = vi
      .fn<PrintFarmerApi['queryModels']>()
      .mockImplementation((request) =>
        Promise.resolve(modelPage(models, request)),
      );
    api({ queryModels });
    const hook = renderHook(() => useLibrary());
    await waitFor(() => expect(hook.result.current.resultsCurrent).toBe(true));
    queryModels.mockRejectedValueOnce(new Error('page query failed'));
    act(() => hook.result.current.setPage(2));
    await waitFor(() =>
      expect(hook.result.current.error).toBe('page query failed'),
    );
    expect(hook.result.current.resultsCurrent).toBe(false);
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(hook.result.current.resultsCurrent).toBe(true);
    expect(hook.result.current.models[0]?.hash).toBe('model-48');
    expect(hook.result.current.error).toBeNull();
  });

  it('rejects unbounded requests and inconsistent response totals', () => {
    const request = QueryModelsRequest.parse({
      ...defaultLibraryView,
      collectionIds: [],
      excludedRootIds: [],
      page: 1,
      pageSize: 48,
    });
    expect(() =>
      QueryModelsRequest.parse({ ...request, pageSize: 5000 }),
    ).toThrow();
    expect(() => QueryModelsRequest.parse({ ...request, page: 0 })).toThrow();
    expect(() =>
      QueryModelsResponse.parse({
        ...modelPage(models, request),
        filteredTotal: 0,
      }),
    ).toThrow();
    expect(
      QueryModelsResponse.parse(modelPage(models, request)).models,
    ).toHaveLength(48);
  });
});

describe('paging controls and lazy thumbnails', () => {
  it('emits additive collection choices and paging events', () => {
    const onCollectionsChange = vi.fn();
    render(
      <LibrarySidebar
        query=""
        filter="all"
        counts={
          modelPage(models, {
            ...defaultLibraryView,
            collectionIds: [],
            excludedRootIds: [],
            page: 1,
            pageSize: 48,
          }).counts
        }
        scanningFolder={null}
        busy={false}
        sourceRoots={[]}
        onQueryChange={vi.fn()}
        onFilterChange={vi.fn()}
        onAddFolder={vi.fn()}
        collections={[
          { id: 'a', name: 'A', sharedToFarm: false, memberCount: 2 },
          { id: 'b', name: 'B', sharedToFarm: false, memberCount: 3 },
        ]}
        selectedCollections={['a']}
        onCollectionsChange={onCollectionsChange}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'B 3' }));
    expect(onCollectionsChange).toHaveBeenCalledWith(['a', 'b']);
    fireEvent.click(screen.getByRole('button', { name: 'All collections' }));
    expect(onCollectionsChange).toHaveBeenLastCalledWith([]);
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();
    render(
      <LibraryPagination
        page={2}
        pageSize={48}
        total={130}
        busy={false}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.change(screen.getByLabelText('Items per page'), {
      target: { value: '24' },
    });
    expect(onPageSizeChange).toHaveBeenCalledWith(24);
  });

  it('does not request thumbnails for offscreen cards', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          callbacks.push(callback);
        }
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    const renderThumbnail = vi
      .fn()
      .mockResolvedValue({ width: 1, height: 1, pngBase64: 'AA==' });
    api({ renderThumbnail });
    render(<ModelGrid models={models.slice(0, 48)} onSelect={vi.fn()} />);
    expect(renderThumbnail).not.toHaveBeenCalled();
    act(() =>
      callbacks[0]!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(1));
  });

  it('skips queued thumbnails after their page unmounts', async () => {
    const settle: Array<
      (result: { width: number; height: number; pngBase64: string }) => void
    > = [];
    const renderThumbnail = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => settle.push(resolve)));
    api({ renderThumbnail });
    const active = [0, 1, 2].map((i) =>
      renderHook(() => useThumbnail(models[i]!)),
    );
    await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(3));
    const queued = renderHook(() => useThumbnail(models[3]!));
    queued.unmount();
    await act(async () => {
      for (const resolve of settle)
        resolve({ width: 1, height: 1, pngBase64: 'AA==' });
      await Promise.resolve();
    });
    await waitFor(() => expect(active[0]!.result.current.status).toBe('ready'));
    expect(renderThumbnail).toHaveBeenCalledTimes(3);
    active.forEach((hook) => hook.unmount());
    const next = renderHook(() => useThumbnail(models[4]!));
    await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(4));
    await act(async () => {
      settle[3]!({ width: 1, height: 1, pngBase64: 'AA==' });
      await Promise.resolve();
    });
    next.unmount();
  });

  it('bounds the thumbnail cache to 256 entries while retaining recent results', async () => {
    const renderThumbnail = vi
      .fn()
      .mockResolvedValue({ width: 1, height: 1, pngBase64: 'AA==' });
    api({ renderThumbnail });
    const entries = Array.from({ length: 260 }, (_, i) => ({
      ...models[0]!,
      hash: `cache-${i}`,
    }));
    const hooks = entries.map((entry) => renderHook(() => useThumbnail(entry)));
    await waitFor(() =>
      expect(
        hooks.every((hook) => hook.result.current.status === 'ready'),
      ).toBe(true),
    );
    expect(renderThumbnail).toHaveBeenCalledTimes(260);
    hooks.forEach((hook) => hook.unmount());
    const recent = renderHook(() => useThumbnail(entries[259]!));
    expect(recent.result.current.status).toBe('ready');
    expect(renderThumbnail).toHaveBeenCalledTimes(260);
    const evicted = renderHook(() => useThumbnail(entries[0]!));
    await waitFor(() => expect(evicted.result.current.status).toBe('ready'));
    expect(renderThumbnail).toHaveBeenCalledTimes(261);
    recent.unmount();
    evicted.unmount();
  });
});
