import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  ImportRootResponse,
  LogicalModel,
  PrintFarmerApi,
} from '@shared/ipc';
import { modelPage, withModelPaging } from './helpers/libraryPage';
import { useLibrary } from '../src/renderer/library/useLibrary.js';
import { ScanFeedback } from '../src/renderer/library/ScanFeedback.js';
import { ModelGrid } from '../src/renderer/library/ModelGrid.js';
import { PropertiesInspector } from '../src/renderer/library/PropertiesInspector.js';
import { LibrarySidebar } from '../src/renderer/library/LibrarySidebar.js';
import { TagEditor } from '../src/renderer/library/TagEditor.js';
import { CollectionEditor } from '../src/renderer/library/CollectionEditor.js';
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
import { ImportWizard } from '../src/renderer/library/ImportWizard.js';
import type { ImportDraft } from '../src/renderer/library/useLibrary.js';
import {
  buildImportPlan,
  forgetImportPlan,
  initialImportChoices,
  rememberImportPlan,
  type ImportPlan,
} from '../src/renderer/library/importPlan.js';
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
import {
  saveStoredSourceRoots,
  reconcileHeadline,
  reconcileDetails,
} from '../src/renderer/library/sourceRoots.js';

function installApi(api: Partial<PrintFarmerApi>): void {
  Object.defineProperty(window, 'printFarmer', {
    value: withModelPaging(api),
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
    expect(formatLabel('step')).toBe('STEP');
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
    window.localStorage.clear();
  });

  it('loads the persisted catalog on mount', async () => {
    const listModels = vi.fn().mockResolvedValue([model()]);
    installApi({ listModels });

    const { result } = renderHook(() => useLibrary());

    await waitFor(() => expect(result.current.models).toHaveLength(1));
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('loads only a page in a mixed-format catalog larger than 10K files', async () => {
    const models = Array.from({ length: 10_001 }, (_, index) =>
      model({
        hash: `model-${index}`,
        format: index % 2 === 0 ? 'step' : 'stl',
      }),
    );
    const queryModels = vi
      .fn<PrintFarmerApi['queryModels']>()
      .mockImplementation((request) =>
        Promise.resolve(modelPage(models, request)),
      );
    const listModels = vi.fn();
    installApi({ queryModels, listModels });

    const { result } = renderHook(() => useLibrary());

    await waitFor(() => expect(result.current.status).toBe('idle'));
    expect(result.current.models).toHaveLength(48);
    expect(result.current.totalModels).toBe(10001);
    expect(result.current.counts.step).toBe(5001);
    expect(listModels).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(
      selectLibraryView(result.current.models, {
        ...defaultLibraryView,
        filter: 'step',
      }),
    ).toHaveLength(24);
  });

  it('clears renderer catalog state only after a successful backend reset', async () => {
    localStorage.setItem(
      'printfarmer.import-recipe.v2.root-1',
      JSON.stringify({
        rules: [
          {
            relativePath: '',
            kind: 'collection',
            name: 'Orcs',
            collectionId: 'c1',
          },
        ],
        commonTags: [],
      }),
    );
    localStorage.setItem(
      'printfarmer.import-recipe.v1.removed-source',
      JSON.stringify({ rules: [], commonTags: [] }),
    );
    localStorage.setItem('unrelated-preference', 'preserve');
    saveStoredSourceRoots([
      {
        rootId: 'root-1',
        path: 'C:\\models',
        approvalId: '11111111-1111-4111-8111-111111111111',
      },
    ]);
    const resetCatalog = vi.fn().mockResolvedValue({
      reset: true,
      modelsRemoved: 1,
      sourceRootsRemoved: 1,
      tagsRemoved: 0,
      collectionsRemoved: 0,
    });
    installApi({
      listModels: vi.fn().mockResolvedValue([model()]),
      listCollections: vi.fn(() =>
        Promise.resolve(
          resetCatalog.mock.calls.length > 0
            ? []
            : [{ id: 'c1', name: 'Orcs', sharedToFarm: false, memberCount: 1 }],
        ),
      ),
      listTags: vi.fn(() =>
        Promise.resolve(
          resetCatalog.mock.calls.length > 0 ? [] : [{ id: 't1', name: 'red' }],
        ),
      ),
      resetCatalog,
    });
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.models).toHaveLength(1));
    expect(result.current.collections).toHaveLength(1);
    expect(result.current.tags).toHaveLength(1);
    expect(result.current.sourceRoots).toHaveLength(1);

    let summary;
    await act(async () => {
      summary = await result.current.resetCatalog();
    });

    expect(summary).toEqual({
      reset: true,
      modelsRemoved: 1,
      sourceRootsRemoved: 1,
      tagsRemoved: 0,
      collectionsRemoved: 0,
    });
    expect(resetCatalog).toHaveBeenCalledOnce();
    expect(result.current.models).toEqual([]);
    expect(result.current.sourceRoots).toEqual([]);
    expect(result.current.collections).toEqual([]);
    expect(result.current.tags).toEqual([]);
    expect(result.current.lastReport).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(
      localStorage.getItem('printfarmer.import-recipe.v2.root-1'),
    ).toBeNull();
    expect(
      localStorage.getItem('printfarmer.import-recipe.v1.removed-source'),
    ).toBeNull();
    expect(localStorage.getItem('unrelated-preference')).toBe('preserve');
    expect(
      initialImportChoices('root-1', 'Models', {
        modelCount: 0,
        totalBytes: 0,
        skippedErrors: 0,
        complete: true,
        formats: { stl: 0, threeMf: 0, obj: 0 },
        folders: [],
        foldersTruncated: false,
      }),
    ).toMatchObject({
      rootCollection: true,
      rootCollectionName: 'Models',
      legacyRules: [],
      policies: [],
    });
    await waitFor(() =>
      expect(
        JSON.parse(
          window.localStorage.getItem('printfarmer.library.sourceRoots.v1') ??
            '{}',
        ),
      ).toMatchObject({ roots: [] }),
    );
  });

  it('keeps the last known catalog visible when reset fails', async () => {
    localStorage.setItem(
      'printfarmer.import-recipe.v2.root-1',
      'preserve-recipe',
    );
    saveStoredSourceRoots([{ rootId: 'root-1', path: 'C:\\models' }]);
    installApi({
      listModels: vi.fn().mockResolvedValue([model()]),
      resetCatalog: vi.fn().mockRejectedValue(new Error('database locked')),
    });
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.models).toHaveLength(1));

    await act(async () => {
      await result.current.resetCatalog();
    });

    expect(result.current.models).toHaveLength(1);
    expect(result.current.sourceRoots).toHaveLength(1);
    expect(result.current.error).toBe('Catalog reset failed: database locked');
    expect(result.current.status).toBe('idle');
    expect(localStorage.getItem('printfarmer.import-recipe.v2.root-1')).toBe(
      'preserve-recipe',
    );
  });

  it('previews a chosen folder, then imports its confirmed rules', async () => {
    const warning =
      'Skipped ZIP oversized.zip: on-disk size 536870913 bytes exceeds the 512 MiB limit (536870912 bytes).';
    const openFolder = vi.fn().mockResolvedValue({
      path: 'C:\\models',
      approvalId: '11111111-1111-4111-8111-111111111111',
    });
    const previewImport = vi.fn().mockResolvedValue({
      modelCount: 1,
      totalBytes: 2048,
      skippedErrors: 1,
      archiveWarnings: [warning],
      complete: true,
      skippedEntries: {
        cloudOnly: 0,
        permissionDenied: 0,
        unreadable: 1,
        tooLarge: 0,
      },
      scanIssues: [
        {
          path: 'C:\\models\\restricted',
          kind: 'folder',
          reason: 'unreadable',
          detail: 'Access to this subtree failed.',
        },
      ],
      scanIssuesTruncated: false,
      formats: { stl: 1, threeMf: 0, obj: 0 },
      folders: [],
      foldersTruncated: false,
    });
    const importRoot = vi.fn().mockResolvedValue({
      report: {
        added: 1,
        changed: 0,
        unchanged: 0,
        missing: 0,
        hashErrors: 0,
        archiveWarnings: [warning],
        skippedEntries: {
          cloudOnly: 0,
          permissionDenied: 0,
          unreadable: 1,
          tooLarge: 0,
        },
        scanIssues: [
          {
            path: 'C:\\models\\restricted',
            kind: 'folder',
            reason: 'unreadable',
            detail: 'Access to this subtree failed.',
          },
        ],
        scanIssuesTruncated: false,
      },
      modelsOrganized: 1,
      collectionsCreated: 1,
      collectionAssignments: 1,
      tagAssignments: 1,
      resolvedCollections: [],
    });
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([model({ format: 'step' })]);
    installApi({
      openFolder,
      previewImport,
      importRoot,
      listModels,
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.addFolder();
    });

    expect(previewImport).toHaveBeenCalledWith({
      approvalId: '11111111-1111-4111-8111-111111111111',
    });
    expect(importRoot).not.toHaveBeenCalled();
    expect(result.current.importDraft?.rootId).toBe(
      rootIdForPath('C:\\models'),
    );
    expect(result.current.importDraft?.preview.archiveWarnings).toEqual([
      warning,
    ]);
    expect(result.current.importDraft?.preview.skippedErrors).toBe(1);
    expect(result.current.importDraft?.preview.scanIssues?.[0]?.kind).toBe(
      'folder',
    );
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.confirmImport({
        rules: [{ relativePath: '', kind: 'collection', name: 'Models' }],
        commonTags: ['printable'],
      });
    });
    expect(result.current.lastImport?.report.archiveWarnings).toEqual([
      warning,
    ]);
    expect(reconcileHeadline(result.current.lastImport!.report)).toBe(
      'Oversized ZIP archives were skipped',
    );
    expect(reconcileDetails(result.current.lastImport!.report)).toBe(
      '1 added • 0 changed • 0 missing',
    );

    expect(importRoot).toHaveBeenCalledWith({
      rootId: rootIdForPath('C:\\models'),
      approvalId: '11111111-1111-4111-8111-111111111111',
      rules: [{ relativePath: '', kind: 'collection', name: 'Models' }],
      commonTags: ['printable'],
    });
    expect(result.current.models).toHaveLength(1);
    expect(result.current.models[0]?.format).toBe('step');
    expect(result.current.lastReport?.added).toBe(1);
    expect(result.current.lastImport?.modelsOrganized).toBe(1);
    expect(result.current.importDraft).toBeNull();
  });

  it('treats a completed import as successful when the catalog refresh fails', async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('refresh offline'))
      .mockRejectedValueOnce(new Error('still offline'));
    const importRoot = vi.fn().mockResolvedValue({
      report: {
        added: 1,
        changed: 0,
        unchanged: 0,
        missing: 0,
        hashErrors: 0,
      },
      modelsOrganized: 0,
      collectionsCreated: 0,
      collectionAssignments: 0,
      tagAssignments: 0,
      resolvedCollections: [],
    });
    installApi({
      openFolder: vi.fn().mockResolvedValue({
        path: 'C:\\models',
        approvalId: '11111111-1111-4111-8111-111111111111',
      }),
      previewImport: vi.fn().mockResolvedValue({
        modelCount: 1,
        totalBytes: 1,
        skippedErrors: 0,
        complete: true,
        formats: { stl: 1, threeMf: 0, obj: 0 },
        folders: [],
        foldersTruncated: false,
      }),
      importRoot,
      listModels,
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    await act(async () => result.current.addFolder());

    let completed: ImportRootResponse | null = null;
    await act(async () => {
      completed = await result.current.confirmImport({
        rules: [],
        commonTags: [],
      });
    });

    expect(completed).not.toBeNull();
    expect(result.current.importDraft).toBeNull();
    expect(result.current.lastImport?.report.added).toBe(1);
    expect(result.current.retryLabel).toBe('Reload catalog');
    expect(result.current.error).toContain(
      'Import completed, but the catalog could not be refreshed: refresh offline',
    );

    await act(async () => result.current.retryLastOperation());
    expect(importRoot).toHaveBeenCalledTimes(1);
    expect(listModels).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBe('still offline');
  });

  it('refreshes the catalog after an interrupted import outcome', async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([model()]);
    installApi({
      openFolder: vi.fn().mockResolvedValue({
        path: 'C:\\models',
        approvalId: '11111111-1111-4111-8111-111111111111',
      }),
      previewImport: vi.fn().mockResolvedValue({
        modelCount: 1,
        totalBytes: 1,
        skippedErrors: 0,
        complete: true,
        formats: { stl: 1, threeMf: 0, obj: 0 },
        folders: [],
        foldersTruncated: false,
      }),
      importRoot: vi
        .fn()
        .mockRejectedValue(
          new Error('sidecar was terminated; refresh the catalog'),
        ),
      listModels,
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    await act(async () => result.current.addFolder());

    let completed: ImportRootResponse | null = null;
    await act(async () => {
      completed = await result.current.confirmImport({
        rules: [],
        commonTags: [],
      });
    });

    expect(completed).toBeNull();
    expect(result.current.models).toHaveLength(1);
    expect(result.current.importDraft).not.toBeNull();
    expect(result.current.error).toContain('sidecar was terminated');
  });

  it('allows an empty completed source to reconcile missing locations', async () => {
    const importRoot = vi.fn().mockResolvedValue({
      report: {
        added: 0,
        changed: 0,
        unchanged: 0,
        missing: 1,
        hashErrors: 0,
      },
      modelsOrganized: 0,
      collectionsCreated: 0,
      collectionAssignments: 0,
      tagAssignments: 0,
      resolvedCollections: [],
    });
    installApi({
      openFolder: vi.fn().mockResolvedValue({
        path: 'C:\\empty',
        approvalId: '11111111-1111-4111-8111-111111111111',
      }),
      previewImport: vi.fn().mockResolvedValue({
        modelCount: 0,
        totalBytes: 0,
        skippedErrors: 0,
        complete: true,
        formats: { stl: 0, threeMf: 0, obj: 0 },
        folders: [],
        foldersTruncated: false,
      }),
      importRoot,
      listModels: vi.fn().mockResolvedValue([]),
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    await act(async () => result.current.addFolder());

    expect(result.current.importDraft?.preview.modelCount).toBe(0);
    await act(async () => {
      await result.current.confirmImport({ rules: [], commonTags: [] });
    });
    expect(importRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: '11111111-1111-4111-8111-111111111111',
        rules: [],
      }),
    );
    expect(result.current.lastReport?.missing).toBe(1);
  });

  it('rejects an incomplete folder preview before opening the wizard', async () => {
    installApi({
      openFolder: vi.fn().mockResolvedValue({
        path: 'C:\\restricted',
        approvalId: '11111111-1111-4111-8111-111111111111',
      }),
      previewImport: vi.fn().mockResolvedValue({
        modelCount: 0,
        totalBytes: 0,
        skippedErrors: 2,
        complete: false,
        formats: { stl: 0, threeMf: 0, obj: 0 },
        folders: [],
        foldersTruncated: false,
      }),
      listModels: vi.fn().mockResolvedValue([]),
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.status).toBe('idle'));
    await act(async () => result.current.addFolder());

    expect(result.current.importDraft).toBeNull();
    expect(result.current.error).toBe(
      'The folder scan did not complete, so no files were imported. Retry the scan, or check folder access if this keeps happening.',
    );
  });

  it('retries an incomplete preview on the same folder and leaves catalog work out of Dismiss', async () => {
    let finishPreview!: (value: {
      modelCount: number;
      totalBytes: number;
      skippedErrors: number;
      complete: boolean;
      formats: { stl: number; threeMf: number; obj: number };
      folders: [];
      foldersTruncated: boolean;
    }) => void;
    const retriedPreview = new Promise<{
      modelCount: number;
      totalBytes: number;
      skippedErrors: number;
      complete: boolean;
      formats: { stl: number; threeMf: number; obj: number };
      folders: [];
      foldersTruncated: boolean;
    }>((resolve) => {
      finishPreview = resolve;
    });
    const selection = {
      path: 'C:\\OneDrive\\Models',
      approvalId: '11111111-1111-4111-8111-111111111111',
    };
    const openFolder = vi.fn().mockResolvedValue(selection);
    const previewImport = vi
      .fn()
      .mockResolvedValueOnce({
        modelCount: 0,
        totalBytes: 0,
        skippedErrors: 0,
        complete: false,
        failure: 'The folder scan could not be prepared.',
        formats: { stl: 0, threeMf: 0, obj: 0 },
        folders: [],
        foldersTruncated: false,
      })
      .mockReturnValueOnce(retriedPreview);
    const listCollections = vi.fn().mockResolvedValue([]);
    const listTags = vi.fn().mockResolvedValue([]);
    const listModels = vi.fn().mockResolvedValue([]);
    installApi({
      openFolder,
      previewImport,
      listModels,
      listCollections,
      listTags,
    });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    listCollections.mockClear();
    listTags.mockClear();
    await act(async () => result.current.addFolder());
    expect(result.current.error).toBe('The folder scan could not be prepared.');
    expect(result.current.retryLabel).toBe('Retry folder scan');
    expect(listCollections).not.toHaveBeenCalled();
    act(() => result.current.dismissError());
    expect(result.current.error).toBeNull();
    expect(previewImport).toHaveBeenCalledTimes(1);

    let retry!: Promise<void>;
    act(() => {
      retry = result.current.retryLastOperation();
    });
    expect(result.current.status).toBe('preparing');
    expect(result.current.scanActivity.path).toBe(selection.path);
    expect(result.current.scanActivity.label).toContain(selection.path);
    expect(previewImport).toHaveBeenNthCalledWith(2, {
      approvalId: selection.approvalId,
    });
    expect(listCollections).not.toHaveBeenCalled();

    await act(async () => {
      finishPreview({
        modelCount: 1,
        totalBytes: 1,
        skippedErrors: 0,
        complete: true,
        formats: { stl: 1, threeMf: 0, obj: 0 },
        folders: [],
        foldersTruncated: false,
      });
      await retry;
    });
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(previewImport).toHaveBeenCalledTimes(2);
    expect(listCollections).toHaveBeenCalledTimes(1);
    expect(listTags).toHaveBeenCalledTimes(1);
    expect(result.current.importDraft?.path).toBe(selection.path);

    act(() => result.current.dismissScanFeedback());
    expect(result.current.importDraft?.path).toBe(selection.path);
    expect(previewImport).toHaveBeenCalledTimes(2);
    expect(listCollections).toHaveBeenCalledTimes(1);
  });

  it('exposes the selected folder path while an import is running', async () => {
    const importResult = {
      report: {
        added: 0,
        changed: 0,
        unchanged: 0,
        missing: 0,
        hashErrors: 0,
      },
      modelsOrganized: 0,
      collectionsCreated: 0,
      collectionAssignments: 0,
      tagAssignments: 0,
      resolvedCollections: [],
    };
    let finishImport!: (value: typeof importResult) => void;
    const importPromise = new Promise<typeof importResult>((resolve) => {
      finishImport = resolve;
    });
    const openFolder = vi.fn().mockResolvedValue({
      path: 'C:\\models',
      approvalId: '11111111-1111-4111-8111-111111111111',
    });
    const previewImport = vi.fn().mockResolvedValue({
      modelCount: 1,
      totalBytes: 1,
      skippedErrors: 0,
      complete: true,
      formats: { stl: 1, threeMf: 0, obj: 0 },
      folders: [],
      foldersTruncated: false,
    });
    const importRoot = vi.fn().mockReturnValue(importPromise);
    const listModels = vi.fn().mockResolvedValue([]);
    installApi({
      openFolder,
      previewImport,
      importRoot,
      listModels,
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.addFolder();
    });
    let confirmPromise: Promise<ImportRootResponse | null> | undefined;
    await act(async () => {
      confirmPromise = result.current.confirmImport({
        rules: [],
        commonTags: [],
      });
      await Promise.resolve();
    });

    expect(result.current.status).toBe('scanning');
    expect(result.current.scanningPath).toBe('C:\\models');

    await act(async () => {
      finishImport(importResult);
      await confirmPromise;
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.scanningPath).toBeNull();
  });

  it('retries a completed partial import on its source and replaces its report', async () => {
    const selection = {
      path: 'C:\\OneDrive\\Models',
      approvalId: '11111111-1111-4111-8111-111111111111',
    };
    const firstResult: ImportRootResponse = {
      report: {
        added: 1,
        changed: 0,
        unchanged: 2,
        missing: 0,
        hashErrors: 0,
        cloudFilesSkipped: 1,
        cloudDirectoriesSkipped: 1,
        skippedEntries: {
          cloudOnly: 2,
          permissionDenied: 0,
          unreadable: 0,
          tooLarge: 0,
        },
        scanIssues: [
          {
            path: 'C:\\OneDrive\\Models\\online.stl',
            kind: 'file',
            reason: 'cloudOnly',
            detail: 'The file is online-only.',
          },
        ],
        scanIssuesTruncated: false,
      },
      modelsOrganized: 3,
      collectionsCreated: 0,
      collectionAssignments: 0,
      tagAssignments: 0,
      resolvedCollections: [],
    };
    const replacementResult: ImportRootResponse = {
      ...firstResult,
      report: {
        added: 0,
        changed: 1,
        unchanged: 1,
        missing: 0,
        hashErrors: 0,
      },
    };
    let finishRetry!: (value: ImportRootResponse) => void;
    const retryPromise = new Promise<ImportRootResponse>((resolve) => {
      finishRetry = resolve;
    });
    const openFolder = vi.fn().mockResolvedValue(selection);
    const previewImport = vi.fn().mockResolvedValue({
      modelCount: 3,
      totalBytes: 3,
      skippedErrors: 0,
      complete: true,
      formats: { stl: 3, threeMf: 0, obj: 0 },
      folders: [],
      foldersTruncated: false,
    });
    const importRoot = vi
      .fn()
      .mockResolvedValueOnce(firstResult)
      .mockReturnValueOnce(retryPromise);
    const listModels = vi.fn().mockResolvedValue([]);
    installApi({
      openFolder,
      previewImport,
      importRoot,
      listModels,
      listCollections: vi.fn().mockResolvedValue([]),
      listTags: vi.fn().mockResolvedValue([]),
    });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    await act(async () => result.current.addFolder());
    const plan = {
      rules: [
        { relativePath: '', kind: 'collection' as const, name: 'Models' },
      ],
      commonTags: ['printable'],
    };
    await act(async () => result.current.confirmImport(plan));
    expect(result.current.lastReport).toEqual(firstResult.report);
    const firstReport = result.current.lastReport;
    expect(firstReport).not.toBeNull();
    expect(
      (firstReport?.added ?? 0) +
        (firstReport?.changed ?? 0) +
        (firstReport?.unchanged ?? 0),
    ).toBe(3);

    act(() => result.current.dismissScanFeedback());
    expect(result.current.scanFeedbackVisible).toBe(false);
    expect(importRoot).toHaveBeenCalledTimes(1);
    expect(previewImport).toHaveBeenCalledTimes(1);

    let retry!: Promise<void>;
    act(() => {
      retry = result.current.retryLastOperation();
    });
    expect(result.current.status).toBe('scanning');
    expect(result.current.scanningPath).toBe(selection.path);
    expect(result.current.retryLabel).toBe('Retry import');
    expect(importRoot).toHaveBeenNthCalledWith(2, {
      rootId: rootIdForPath(selection.path),
      approvalId: selection.approvalId,
      ...plan,
    });
    await act(async () => {
      finishRetry(replacementResult);
      await retry;
    });
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(previewImport).toHaveBeenCalledTimes(1);
    expect(result.current.lastReport).toEqual(replacementResult.report);
    expect(result.current.lastImport?.report).toEqual(replacementResult.report);
    expect(result.current.scanFeedbackVisible).toBe(true);
    expect(importRoot).toHaveBeenCalledTimes(2);
  });

  it('does not scan when the folder dialog is cancelled', async () => {
    const openFolder = vi.fn().mockResolvedValue(null);
    const previewImport = vi.fn();
    const importRoot = vi.fn();
    const listModels = vi.fn().mockResolvedValue([]);
    installApi({ openFolder, previewImport, importRoot, listModels });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.addFolder();
    });

    expect(previewImport).not.toHaveBeenCalled();
    expect(importRoot).not.toHaveBeenCalled();
  });

  it('tracks source root status and reconnects a missing root', async () => {
    const missingModel = model({
      locations: [
        {
          rootId: 'root-1',
          path: 'C:\\models\\widget.stl',
          rootRelative: 'widget.stl',
          size: 2048,
          available: false,
        },
      ],
    });
    const availableModel = model();
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([missingModel])
      .mockResolvedValueOnce([availableModel]);
    const scanRoot = vi.fn().mockResolvedValue({
      added: 0,
      changed: 0,
      unchanged: 1,
      missing: 0,
      hashErrors: 0,
    });
    const openFolder = vi.fn().mockResolvedValue({
      path: 'C:\\models',
      approvalId: '11111111-1111-4111-8111-111111111111',
    });
    installApi({ listModels, scanRoot, openFolder });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.sourceRoots).toHaveLength(1));

    expect(result.current.sourceRoots[0]).toMatchObject({
      path: 'C:\\models',
      status: 'missing',
      totalModels: 1,
    });

    await act(async () => {
      await result.current.rescanRoot('root-1');
    });

    expect(openFolder).toHaveBeenCalledOnce();
    expect(scanRoot).toHaveBeenCalledWith({
      rootId: 'root-1',
      approvalId: '11111111-1111-4111-8111-111111111111',
    });
    expect(result.current.lastReport?.unchanged).toBe(1);
    expect(result.current.sourceRoots[0]?.status).toBe('available');
  });

  it('retains skipped paths and the catalog when a scan has a fatal policy failure', async () => {
    const report = {
      added: 0,
      changed: 0,
      unchanged: 0,
      missing: 0,
      hashErrors: 0,
      failure: 'Could not restore dataless materialization policy.',
      cloudFilesSkipped: 1,
      scanIssues: [
        {
          path: 'C:\\models\\cloud.stl',
          kind: 'file',
          reason: 'cloudOnly',
          detail: 'Online-only file.',
        },
      ],
    };
    const listModels = vi.fn().mockResolvedValue([model()]);
    const scanRoot = vi.fn().mockResolvedValue(report);
    const openFolder = vi.fn().mockResolvedValue({
      path: 'C:\\models',
      approvalId: '11111111-1111-4111-8111-111111111111',
    });
    installApi({ listModels, scanRoot, openFolder });
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.sourceRoots).toHaveLength(1));

    await act(async () => {
      expect(await result.current.rescanRoot('root-1')).toBeNull();
    });

    expect(result.current.error).toBe(report.failure);
    expect(result.current.lastReport).toEqual(report);
    expect(result.current.scanFeedbackVisible).toBe(true);
    expect(result.current.models).toHaveLength(1);
    expect(result.current.retryLabel).toBe('Retry scan');
    expect(listModels).toHaveBeenCalledOnce();
  });

  it('labels fatal scan feedback without implying files were successfully indexed', () => {
    render(
      <ScanFeedback
        data={{
          added: 0,
          failure: 'Could not restore dataless materialization policy.',
          cloudFilesSkipped: 1,
          scanIssues: [
            {
              path: 'C:\\models\\cloud.stl',
              kind: 'file',
              reason: 'cloudOnly',
              detail: 'Online-only file.',
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByRole('status', { name: 'Scan results' }),
    ).toHaveTextContent('Scan stopped; catalog unchanged.');
    expect(screen.queryByText(/files? indexed/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Show skipped paths and details'));
    expect(screen.getByText('C:\\models\\cloud.stl')).toBeVisible();
  });

  it('excludes removed source roots from the bounded library query', async () => {
    const queryModels = vi
      .fn<PrintFarmerApi['queryModels']>()
      .mockImplementation((request) =>
        Promise.resolve(modelPage([model()], request)),
      );
    installApi({ queryModels });

    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.models).toHaveLength(1));

    await act(async () => {
      result.current.removeRoot('root-1');
      await Promise.resolve();
    });

    expect(result.current.models).toEqual([]);
    expect(result.current.sourceRoots).toEqual([]);
    await waitFor(() => expect(result.current.totalModels).toBe(0));
    expect(queryModels.mock.lastCall?.[0].excludedRootIds).toEqual(['root-1']);
  });

  it('surfaces an error when the catalog cannot be read', async () => {
    installApi({
      listModels: vi.fn().mockRejectedValue(new Error('sidecar offline')),
    });

    const { result } = renderHook(() => useLibrary());

    await waitFor(() => expect(result.current.error).toBe('sidecar offline'));
  });

  it('keeps the existing catalog on an approval failure and recovers on retry', async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([model()])
      .mockRejectedValueOnce(new Error('Approved folders could not be read.'))
      .mockResolvedValueOnce([model()]);
    installApi({ listModels });
    const { result } = renderHook(() => useLibrary());
    await waitFor(() => expect(result.current.models).toHaveLength(1));

    await act(async () => result.current.refresh());
    expect(result.current.error).toBe('Approved folders could not be read.');
    expect(result.current.models).toEqual([model()]);

    await act(async () => result.current.refresh());
    expect(result.current.error).toBeNull();
    expect(result.current.models).toEqual([model()]);
    expect(listModels).toHaveBeenCalledTimes(3);
  });
});

describe('smart import', () => {
  const draft: ImportDraft = {
    rootId: 'root-smart',
    approvalId: '11111111-1111-4111-8111-111111111111',
    path: 'C:\\Models',
    preview: {
      modelCount: 3,
      totalBytes: 4096,
      skippedErrors: 0,
      complete: true,
      formats: { stl: 1, threeMf: 1, obj: 1 },
      folders: [
        {
          relativePath: 'Animals',
          name: 'Animals',
          depth: 1,
          modelCount: 2,
        },
        {
          relativePath: 'Animals/Cats',
          name: 'Cats',
          depth: 2,
          modelCount: 1,
        },
      ],
      foldersTruncated: false,
    },
    collections: [],
    tags: [],
  };

  beforeEach(() => {
    forgetImportPlan(draft.rootId);
    installApi({
      previewImport: vi.fn().mockResolvedValue({
        ...draft.preview,
        organization: {
          affectedModels: 3,
          newCollections: ['Models'],
          reusedCollections: [],
          newTags: [],
          reusedTags: [],
          unmatchedModels: 0,
          samples: [],
          errors: [],
        },
      }),
    });
  });

  it('explains all-cloud-only folders without describing them as empty', () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    render(
      <ImportWizard
        draft={{
          ...draft,
          preview: {
            ...draft.preview,
            modelCount: 0,
            cloudFilesSkipped: 4,
            cloudDirectoriesSkipped: 1,
          },
        }}
        busy={false}
        error={null}
        onDismissError={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    const scanDetails = screen.getByText('Skipped paths and scan details');
    expect(scanDetails.closest('details')).not.toHaveProperty('open', true);
    fireEvent.click(scanDetails);
    expect(
      screen.getByRole('status', { name: 'Scan results' }),
    ).toHaveTextContent('Cloud-only: 5 entries (4 files, 1 folder)');
    expect(
      screen.getByRole('status', { name: 'Scan results' }),
    ).toHaveTextContent('Make cloud-only items available locally');
    expect(
      screen.getByText(/No locally available supported files/),
    ).toHaveTextContent('preserved where availability could not be determined');
    fireEvent.click(scanDetails);
    expect(scanDetails.closest('details')).not.toHaveProperty('open', true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('summarizes legacy oversized ZIP warnings and keeps per-file details collapsed', async () => {
    const warning =
      'Skipped ZIP oversized.zip: on-disk size 536870913 bytes exceeds the 512 MiB limit (536870912 bytes).';
    render(
      <ImportWizard
        draft={{
          ...draft,
          preview: { ...draft.preview, archiveWarnings: [warning] },
        }}
        busy={false}
        error={null}
        onDismissError={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(true)}
      />,
    );
    const compactDetails = screen.getByText('Skipped paths and scan details');
    expect(compactDetails.closest('details')).not.toHaveProperty('open', true);
    fireEvent.click(compactDetails);
    const feedback = screen.getByRole('status', { name: 'Scan results' });
    expect(feedback).toHaveTextContent(
      'Oversized ZIP archives: 1 skipped (512 MB limit)',
    );
    const details = screen.getByText('Show skipped paths and details');
    expect(details.closest('details')).not.toHaveProperty('open', true);
    fireEvent.click(details);
    expect(feedback).toHaveTextContent('oversized.zip');
    expect(feedback).toHaveTextContent('Size: 512 MB · limit: 512 MB');
    expect(feedback).not.toHaveTextContent(warning);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled(),
    );
  });

  it('shows bounded path-specific scan reasons and the configured ZIP limit', () => {
    render(
      <ImportWizard
        draft={{
          ...draft,
          preview: {
            ...draft.preview,
            skippedEntries: {
              cloudOnly: 1,
              permissionDenied: 1,
              unreadable: 1,
              tooLarge: 1,
            },
            scanIssues: [
              {
                path: 'C:\\Models\\online.stl',
                kind: 'file',
                reason: 'cloudOnly',
                detail: 'The file is not available offline.',
              },
              {
                path: 'C:\\Models\\restricted',
                kind: 'folder',
                reason: 'permissionDenied',
                detail: 'Access was denied.',
              },
              {
                path: 'C:\\Models\\damaged.stl',
                kind: 'file',
                reason: 'unreadable',
                detail: 'The file could not be read.',
              },
              {
                path: 'C:\\Models\\large.zip',
                kind: 'file',
                reason: 'tooLarge',
                detail: 'The ZIP is over the configured limit.',
                sizeBytes: 128 * 1024 * 1024,
                limitBytes: 64 * 1024 * 1024,
              },
            ],
            scanIssuesTruncated: true,
          },
        }}
        busy={false}
        error={null}
        onDismissError={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(true)}
      />,
    );
    const feedback = screen.getByRole('status', { name: 'Scan results' });
    expect(feedback).toHaveTextContent('Cloud-only: 1 entry');
    expect(feedback).toHaveTextContent('Permission denied: 1');
    expect(feedback).toHaveTextContent('Unreadable: 1');
    expect(feedback).toHaveTextContent(
      'Oversized ZIP archives: 1 skipped (64 MB limit)',
    );
    expect(feedback).not.toHaveTextContent('512 MB limit');
    fireEvent.click(screen.getByText('Show skipped paths and details'));
    expect(feedback).toHaveTextContent(
      'Path details are limited to the first 200 entries',
    );
    expect(feedback).toHaveTextContent('C:\\Models\\online.stl');
    expect(feedback).toHaveTextContent('Make it available on this device');
    expect(feedback).toHaveTextContent('Check its permissions');
    expect(feedback).toHaveTextContent('Size: 128 MB · limit: 64 MB');
  });

  it('dismisses an import error without cancelling the prepared import', () => {
    const onDismissError = vi.fn();
    const onRetryScan = vi.fn();
    const onCancel = vi.fn();
    render(
      <ImportWizard
        draft={{
          ...draft,
          preview: {
            ...draft.preview,
            formats: { ...draft.preview.formats, step: 2 },
          },
        }}
        busy={false}
        error="Import failed"
        onDismissError={onDismissError}
        onRetryScan={onRetryScan}
        retryLabel="Retry import"
        onCancel={onCancel}
        onConfirm={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByText('STEP')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Import failed');
    expect(screen.queryByText('Error details')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    expect(onRetryScan).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'Dismiss library error' }),
    );
    expect(onDismissError).toHaveBeenCalledTimes(1);
    expect(onRetryScan).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('defaults new folders to inheritance without deriving folder metadata', () => {
    const choices = initialImportChoices(draft.rootId, 'Models', draft.preview);
    const plan = buildImportPlan(choices);

    expect(plan.rules).toEqual([
      { relativePath: '', kind: 'collection', name: 'Models' },
    ]);
    expect(plan.policies).toEqual([]);
    expect(choices.folders.every((folder) => folder.mode === 'inherit')).toBe(
      true,
    );
  });

  it('restores remembered choices for the same source', () => {
    rememberImportPlan(draft.rootId, {
      rules: [
        {
          relativePath: 'Animals',
          kind: 'tag',
          name: 'creatures',
        },
      ],
      ignoredPaths: [],
      commonTags: ['printable'],
      visibleFolderPaths: ['Animals', 'Animals/Cats'],
    });

    const choices = initialImportChoices(draft.rootId, 'Models', draft.preview);

    expect(choices.rootCollection).toBe(false);
    expect(choices.folders[0]).toMatchObject({
      mode: 'tag',
      name: 'creatures',
    });
    expect(choices.commonTagsText).toBe('printable');
  });

  it('restores remembered ignore choices explicitly', () => {
    rememberImportPlan(draft.rootId, {
      rules: [],
      ignoredPaths: ['Animals'],
      commonTags: [],
      visibleFolderPaths: ['Animals', 'Animals/Cats'],
    });

    const choices = initialImportChoices(draft.rootId, 'Models', draft.preview);

    expect(choices.folders[0]?.mode).toBe('ignore');
    expect(buildImportPlan(choices).ignoredPaths).toContain('Animals');
  });

  it('preserves remembered rules for folders absent from an empty preview', () => {
    rememberImportPlan(draft.rootId, {
      rules: [
        {
          relativePath: 'Animals/Cats',
          kind: 'tag',
          name: 'feline',
        },
      ],
      ignoredPaths: ['Animals'],
      commonTags: ['printable'],
      visibleFolderPaths: ['Animals', 'Animals/Cats'],
    });
    rememberImportPlan(draft.rootId, {
      rules: [
        {
          relativePath: '',
          kind: 'collection',
          name: 'Models',
        },
      ],
      ignoredPaths: [],
      commonTags: ['printable'],
      visibleFolderPaths: [],
    });

    const choices = initialImportChoices(draft.rootId, 'Models', draft.preview);

    expect(choices.folders[0]?.mode).toBe('ignore');
    expect(choices.folders[1]).toMatchObject({
      mode: 'tag',
      name: 'feline',
    });
  });

  it('remembers collection identities resolved by the import', () => {
    const initial = initialImportChoices(draft.rootId, 'Models', draft.preview);
    initial.folders[0] = {
      ...initial.folders[0]!,
      mode: 'collection',
    };
    const plan = buildImportPlan(initial);
    rememberImportPlan(draft.rootId, plan, [
      {
        relativePath: 'Animals',
        name: 'Animals',
        collectionId: 'collection-animals',
      },
    ]);

    const choices = initialImportChoices(draft.rootId, 'Models', draft.preview);

    expect(choices.folders[0]?.collectionId).toBe('collection-animals');
  });

  it('shows the hierarchy and submits reviewed organization rules', async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    render(
      <ImportWizard
        draft={draft}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(
      screen.getByRole('dialog', {
        name: 'Organize models before importing',
      }),
    ).toBeVisible();
    expect(screen.getByLabelText('Import collection name')).toHaveValue(
      'Models',
    );
    expect(
      screen.getByLabelText('Folder organization for Animals'),
    ).toHaveValue('inherit');
    expect(
      screen.queryByRole('button', { name: 'Edit policy for Animals/Cats' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Animals' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit policy for Animals/Cats' }),
    );
    expect(
      screen.getByLabelText('Folder organization for Animals/Cats'),
    ).toHaveValue('inherit');

    fireEvent.change(screen.getByLabelText('Tags for all imported models'), {
      target: { value: 'printable, terrain' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(
        {
          rules: [{ relativePath: '', kind: 'collection', name: 'Models' }],
          policies: [],
          completeRecipe: true,
          ignoredPaths: [],
          commonTags: ['printable', 'terrain'],
          visibleFolderPaths: ['Animals', 'Animals/Cats'],
        },
        true,
      ),
    );
  });

  it('blocks invalid bulk tags instead of silently dropping them', () => {
    render(
      <ImportWizard
        draft={draft}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(true)}
      />,
    );

    fireEvent.change(screen.getByLabelText('Tags for all imported models'), {
      target: { value: 'x'.repeat(129) },
    });

    expect(screen.getByRole('alert')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('requires an explicit id when existing collections share a name', async () => {
    const onConfirm =
      vi.fn<(plan: ImportPlan, remember: boolean) => Promise<boolean>>();
    onConfirm.mockResolvedValue(true);
    render(
      <ImportWizard
        draft={{
          ...draft,
          collections: [
            {
              id: 'collection-one',
              name: 'Animals',
              sharedToFarm: false,
              memberCount: 1,
            },
            {
              id: 'collection-two',
              name: 'Animals',
              sharedToFarm: false,
              memberCount: 2,
            },
          ],
        }}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByLabelText('Folder organization for Animals'), {
      target: { value: 'collection' },
    });
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    const picker = screen.getByLabelText('Choose collection for Animals');
    picker.focus();
    fireEvent.change(picker, {
      target: { value: 'collection-two' },
    });
    expect(screen.getByLabelText('Choose collection for Animals')).toHaveValue(
      'collection-two',
    );
    expect(document.activeElement).toBe(picker);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0]?.[0].policies).toContainEqual({
      relativePath: 'Animals',
      mode: 'organize',
      collectionName: 'Animals',
      collectionId: 'collection-two',
      tags: [],
    });
    expect(onConfirm.mock.calls[0]?.[1]).toBe(true);
  });

  it('requires confirmation when a remembered collection id is gone', async () => {
    rememberImportPlan(draft.rootId, {
      rules: [
        {
          relativePath: 'Animals',
          kind: 'collection',
          name: 'Animals',
          collectionId: 'deleted-collection',
        },
      ],
      ignoredPaths: [],
      commonTags: [],
      visibleFolderPaths: ['Animals', 'Animals/Cats'],
    });
    render(
      <ImportWizard
        draft={{
          ...draft,
          collections: [
            {
              id: 'replacement-collection',
              name: 'Animals',
              sharedToFarm: false,
              memberCount: 3,
            },
          ],
        }}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={vi.fn().mockResolvedValue(true)}
      />,
    );

    const picker = screen.getByLabelText('Resolve rule collection for Animals');
    expect(picker).toHaveValue('__unresolved__');
    expect(picker).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

    fireEvent.change(picker, {
      target: { value: 'replacement-collection' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled(),
    );
  });

  it('lets the user confirm reconciliation for an empty source', async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    render(
      <ImportWizard
        draft={{
          ...draft,
          preview: {
            ...draft.preview,
            modelCount: 0,
            totalBytes: 0,
            formats: { stl: 0, threeMf: 0, obj: 0 },
            folders: [],
          },
        }}
        busy={false}
        error={null}
        onCancel={vi.fn()}
        onDismissError={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Reconcile source' }),
      ).toBeEnabled(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconcile source' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
  });
});

describe('selectLibraryView', () => {
  const stl = (
    name: string,
    size: number,
    available = true,
    overrides: Partial<LogicalModel> = {},
  ): LogicalModel =>
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
      ...overrides,
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

    const byNameDesc = selectLibraryView(models, {
      ...defaultLibraryView,
      sort: 'name-desc',
    });
    expect(byNameDesc.map((m) => modelDisplayName(m))[0]).toBe('gone.stl');

    const bySizeAsc = selectLibraryView(models, {
      ...defaultLibraryView,
      sort: 'size-asc',
    });
    expect(bySizeAsc.map((m) => m.hash)).toEqual([
      'h-dup',
      'h-alpha.stl',
      'h-gone.stl',
      'h-beta.stl',
    ]);

    const bySize = selectLibraryView(models, {
      ...defaultLibraryView,
      sort: 'size-desc',
    });
    expect(bySize[0]?.size).toBe(300);
  });

  it('sorts by newest and oldest modified date when timestamps are present', () => {
    const dated = [
      stl('old.stl', 10, true, {
        locations: [
          {
            rootId: 'r',
            path: 'C:\\models\\old.stl',
            rootRelative: 'old.stl',
            size: 10,
            modifiedUnixSeconds: 1,
            available: true,
          },
        ],
      }),
      stl('new.stl', 10, true, {
        locations: [
          {
            rootId: 'r',
            path: 'C:\\models\\new.stl',
            rootRelative: 'new.stl',
            size: 10,
            modifiedUnixSeconds: 10,
            available: true,
          },
        ],
      }),
      stl('unknown.stl', 10, true),
    ];

    expect(
      selectLibraryView(dated, {
        ...defaultLibraryView,
        sort: 'date-desc',
      }).map((item) => modelDisplayName(item)),
    ).toEqual(['new.stl', 'old.stl', 'unknown.stl']);
    expect(
      selectLibraryView(dated, { ...defaultLibraryView, sort: 'date-asc' }).map(
        (item) => modelDisplayName(item),
      ),
    ).toEqual(['old.stl', 'new.stl', 'unknown.stl']);
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

  it('filters to missing files and to duplicates', () => {
    const missing = selectLibraryView(models, {
      ...defaultLibraryView,
      filter: 'missing',
    });
    expect(missing.map((m) => m.hash)).toEqual(['h-gone.stl']);

    const duplicates = selectLibraryView(models, {
      ...defaultLibraryView,
      filter: 'duplicates',
    });
    expect(duplicates.map((m) => m.hash)).toEqual(['h-dup']);
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

  it('filters and sorts a large result set from a 100k-entry catalog', () => {
    const synthetic = Array.from({ length: 100_000 }, (_, offset) => {
      const index = 99_999 - offset;
      const suffix = index.toString().padStart(6, '0');
      const format = index % 2 === 0 ? 'stl' : 'obj';
      return model({
        hash: `bulk-${suffix}`,
        format,
        size: 1_024 + (index % 64),
        locations: [
          {
            rootId: `root-${index % 20}`,
            path: `D:\\catalog\\segment-${index % 20}\\gear-${suffix}.${format}`,
            rootRelative: `segment-${index % 20}\\gear-${suffix}.${format}`,
            size: 1_024 + (index % 64),
            available: true,
          },
        ],
      });
    });

    const start = Date.now();
    const filtered = selectLibraryView(synthetic, {
      ...defaultLibraryView,
      filter: 'stl',
      query: 'gear-',
      sort: 'name-asc',
    });
    const elapsedMs = Date.now() - start;

    expect(filtered).toHaveLength(50_000);
    expect(filtered[0]?.hash).toBe('bulk-000000');
    expect(filtered[25_000]?.hash).toBe('bulk-050000');
    expect(filtered.at(-1)?.hash).toBe('bulk-099998');
    expect(elapsedMs).toBeLessThan(5_000);
  }, 15_000);
});

describe('useFavorites', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    vi.restoreAllMocks();
  });

  it('toggles favorites through the catalog bridge and mirrors them locally', async () => {
    const listFavorites = vi.fn().mockResolvedValue(['seeded']);
    const addFavorite = vi.fn().mockResolvedValue(['seeded', 'abc']);
    const removeFavorite = vi.fn().mockResolvedValue(['seeded']);
    installApi({ listFavorites, addFavorite, removeFavorite });

    const { result } = renderHook(() => useFavorites());
    await waitFor(() => expect(result.current.isFavorite('seeded')).toBe(true));

    await act(async () => {
      await result.current.toggle('abc');
    });
    expect(addFavorite).toHaveBeenCalledWith({ hash: 'abc' });
    expect(result.current.isFavorite('abc')).toBe(true);
    expect(
      globalThis.localStorage.getItem('printfarmer.favorites.v1'),
    ).toContain('abc');

    await act(async () => {
      await result.current.toggle('abc');
    });
    expect(removeFavorite).toHaveBeenCalledWith({ hash: 'abc' });
    expect(result.current.isFavorite('abc')).toBe(false);
  });

  it('falls back to localStorage when the catalog favorite IPC is unavailable', async () => {
    installApi({});
    globalThis.localStorage.setItem(
      'printfarmer.favorites.v1',
      JSON.stringify(['seeded']),
    );
    const { result } = renderHook(() => useFavorites());
    expect(result.current.isFavorite('seeded')).toBe(true);

    await act(async () => {
      await result.current.toggle('added-locally');
    });
    expect(result.current.isFavorite('added-locally')).toBe(true);
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
    expect(screen.getByRole('list', { name: 'Model grid' })).toBeVisible();
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
  it('makes preview primary and hides U1 preparation when ineligible', () => {
    installApi({
      renderThumbnail: vi.fn().mockRejectedValue(new Error('no renderer')),
    });
    render(
      <PropertiesInspector
        model={model()}
        favorite={false}
        stats={null}
        vendorMetadata={null}
        tags={[]}
        collections={[]}
        collectionMembership={new Set()}
        organizationError={null}
        previewDisabled={false}
        retargetEligible={false}
        onToggleFavorite={vi.fn()}
        onPreview={vi.fn()}
        onRetarget={vi.fn()}
        onAddTag={vi.fn()}
        onRemoveTag={vi.fn()}
        onToggleCollection={vi.fn()}
        onCreateCollection={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Preview in 3D' })).toHaveClass(
      'primary',
    );
    expect(
      screen.queryByRole('button', { name: 'Prepare for Snapmaker U1' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Requires an available cataloged editable 3MF.'),
    ).not.toBeInTheDocument();
  });

  it('keeps eligible U1 preparation visible but disabled while busy', () => {
    installApi({
      renderThumbnail: vi.fn().mockRejectedValue(new Error('no renderer')),
    });
    render(
      <PropertiesInspector
        model={model()}
        favorite={false}
        stats={null}
        vendorMetadata={null}
        tags={[]}
        collections={[]}
        collectionMembership={new Set()}
        organizationError={null}
        previewDisabled
        retargetEligible
        onToggleFavorite={vi.fn()}
        onPreview={vi.fn()}
        onRetarget={vi.fn()}
        onAddTag={vi.fn()}
        onRemoveTag={vi.fn()}
        onToggleCollection={vi.fn()}
        onCreateCollection={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Prepare for Snapmaker U1' }),
    ).toBeDisabled();
    expect(
      screen.getByText('Unavailable while another operation is in progress.'),
    ).toBeVisible();
  });

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
        stats={null}
        vendorMetadata={null}
        tags={[]}
        collections={[]}
        collectionMembership={new Set()}
        organizationError={null}
        previewDisabled={false}
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

  it('shows every full location path inside the File section', () => {
    installApi({
      renderThumbnail: vi.fn().mockRejectedValue(new Error('no renderer')),
    });
    const longPath =
      'D:\\Printing\\Archive\\Very long vendor folder name\\Nested\\Deeper\\Still deeper\\widget-final-v12.stl';
    const missingPath = 'E:\\Offline drive\\widget-final-v12.stl';
    render(
      <PropertiesInspector
        model={model({
          locations: [
            {
              rootId: 'root-a',
              path: longPath,
              rootRelative: 'widget-final-v12.stl',
              size: 2048,
              available: true,
            },
            {
              rootId: 'root-b',
              path: missingPath,
              rootRelative: 'widget-final-v12.stl',
              size: 2048,
              available: false,
            },
          ],
        })}
        favorite={false}
        stats={null}
        vendorMetadata={null}
        tags={[]}
        collections={[]}
        collectionMembership={new Set()}
        organizationError={null}
        previewDisabled={false}
        onToggleFavorite={vi.fn()}
        onPreview={vi.fn()}
        onAddTag={vi.fn()}
        onRemoveTag={vi.fn()}
        onToggleCollection={vi.fn()}
        onCreateCollection={vi.fn()}
      />,
    );

    const file = screen
      .getByRole('heading', { name: 'File', level: 3 })
      .closest('section') as HTMLElement;
    expect(
      within(file).getByRole('heading', { name: 'Locations', level: 4 }),
    ).toBeVisible();
    const items = within(file).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      `Available${longPath}`,
      `Missing${missingPath}`,
    ]);
    expect(
      screen.queryByRole('heading', { name: 'Locations', level: 3 }),
    ).toBeNull();
    const sections = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(sections.indexOf('Collections')).toBeLessThan(
      sections.indexOf('Tags'),
    );
  });
});

describe('<LibrarySidebar /> organization filters', () => {
  it('keeps selected scopes visible and exposes full names without changing OR semantics', () => {
    const onCollectionsChange = vi.fn();
    const collectionName =
      'Very long collection name that should remain discoverable';
    render(
      <LibrarySidebar
        query=""
        filter="all"
        counts={{
          all: 0,
          favorites: 0,
          stl: 0,
          threeMf: 0,
          obj: 0,
          step: 0,
          duplicates: 0,
          missing: 0,
        }}
        onQueryChange={vi.fn()}
        onFilterChange={vi.fn()}
        collections={[
          {
            id: 'collection-1',
            name: collectionName,
            sharedToFarm: false,
            memberCount: 3,
          },
        ]}
        selectedCollections={['collection-1']}
        onCollectionsChange={onCollectionsChange}
        tags={[{ id: 'tag-1', name: 'Miniatures' }]}
        selectedTags={['tag-1']}
        onTagsChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Tag and collection scopes are combined.'),
    ).toBeVisible();
    expect(screen.getByText(collectionName)).toHaveAttribute(
      'title',
      collectionName,
    );
    const collectionFilter = screen.getByRole('group', {
      name: 'Collections filter',
    });
    const collectionCheckbox = within(collectionFilter).getByRole('checkbox');
    expect(collectionCheckbox).toBeChecked();
    fireEvent.click(collectionCheckbox);
    expect(onCollectionsChange).toHaveBeenCalledWith([]);
  });
});

describe('useModelTags', () => {
  it('does not restore deleted tags from an older same-model refresh', async () => {
    let finishOldRead = (): void => undefined;
    const tagsForModel = vi
      .fn<PrintFarmerApi['tagsForModel']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRead = () => resolve([{ id: 'old', name: 'Deleted' }]);
          }),
      )
      .mockResolvedValue([]);
    installApi({ tagsForModel });
    const { result } = renderHook(() => useModelTags('h1'));
    await waitFor(() => expect(tagsForModel).toHaveBeenCalledOnce());
    await act(async () => result.current.refresh());
    await act(async () => {
      finishOldRead();
      await Promise.resolve();
    });
    expect(result.current.tags).toEqual([]);
  });

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

  it('does not restore deleted collections from an older same-model refresh', async () => {
    let finishOldRead = (): void => undefined;
    const listCollections = vi
      .fn<PrintFarmerApi['listCollections']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRead = () => resolve([dragons]);
          }),
      )
      .mockResolvedValue([]);
    const collectionsForModel = vi
      .fn()
      .mockResolvedValueOnce([dragons])
      .mockResolvedValue([]);
    installApi({ listCollections, collectionsForModel });
    const { result } = renderHook(() => useModelCollections('h1'));
    await waitFor(() => expect(listCollections).toHaveBeenCalledOnce());
    await act(async () => result.current.refresh());
    await act(async () => {
      finishOldRead();
      await Promise.resolve();
    });
    expect(result.current.all).toEqual([]);
    expect([...result.current.membership]).toEqual([]);
  });

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
    sceneVersion: 2,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1],
    indices: [0, 1, 2, 3, 4, 5],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    sourceFormat: 'threeMf',
    status: 'complete',
    statusMessages: [],
    parts: [
      { name: 'A', triangleStart: 0, triangleCount: 1, status: 'complete' },
      { name: 'B', triangleStart: 1, triangleCount: 1, status: 'complete' },
    ],
    objects: [
      {
        id: 'plate-0/item-0/object-1',
        sourceId: '3d/3dmodel.model#object-1',
        name: 'A',
        parentId: null,
        children: [],
        transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
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
        id: 'plate-0/item-1/object-2',
        sourceId: '3d/3dmodel.model#object-2',
        name: 'B',
        parentId: null,
        children: [],
        transform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        mesh: {
          positions: [0, 0, 1, 1, 0, 1, 0, 1, 1],
          indices: [0, 1, 2],
          bounds: { min: [0, 0, 1], max: [1, 1, 1] },
        },
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 1,
      },
    ],
    rootObjectIds: ['plate-0/item-0/object-1', 'plate-0/item-1/object-2'],
    plates: [
      {
        id: 'plate-0',
        name: 'Plate 1',
        index: 0,
        rootObjectIds: ['plate-0/item-0/object-1', 'plate-0/item-1/object-2'],
      },
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
      sceneVersion: 2,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'stl',
      faceColors: null,
      status: 'complete',
      statusMessages: [],
      parts: [],
      objects: [],
      rootObjectIds: [],
      plates: [],
    };
    expect(visibleIndices(mesh, new Set([0]))).toEqual([0, 1, 2]);
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
    expect(result.current.sourcePath).toBe('C:/m/widget.3mf');
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

  it('associates extraction errors with their source and clears them on selection change', async () => {
    installApi({
      extractVendorMetadata: vi
        .fn()
        .mockRejectedValue(new Error('Invalid 3MF')),
    });
    const { result, rerender } = renderHook(
      ({ path }) => useVendorMetadata(path, 'threeMf'),
      { initialProps: { path: 'C:\\models\\broken.3mf' } },
    );
    await waitFor(() => expect(result.current.error).toBe('Invalid 3MF'));
    expect(result.current.metadata).toBeNull();
    expect(result.current.sourcePath).toBe('C:\\models\\broken.3mf');

    rerender({ path: 'C:\\models\\other.3mf' });
    expect(result.current.error).toBeNull();
    expect(result.current.sourcePath).toBeNull();
    await waitFor(() =>
      expect(result.current.sourcePath).toBe('C:\\models\\other.3mf'),
    );
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

  it('reuses a cached thumbnail while the sidecar reports the same recipe', async () => {
    const renderThumbnail = vi.fn().mockResolvedValue({
      width: 256,
      height: 256,
      pngBase64: 'STABLE',
      cacheRecipe: 'scene/v3.2/thumb-v1-256',
    });
    installApi({ renderThumbnail });

    const first = renderHook(() => useThumbnail(model({ hash: 'versioned' })));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));

    const second = renderHook(() => useThumbnail(model({ hash: 'versioned' })));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));

    expect(renderThumbnail).toHaveBeenCalledTimes(1);
  });

  it('evicts thumbnails rendered under a superseded recipe', async () => {
    // A version nothing reads invalidates nothing: once the sidecar reports a
    // new recipe, pixels produced under the previous semantics must go.
    const png = (pngBase64: string, cacheRecipe: string) => ({
      width: 256,
      height: 256,
      pngBase64,
      cacheRecipe,
    });
    const renderThumbnail = vi
      .fn()
      .mockResolvedValueOnce(png('OLD', 'scene/v3.2/thumb-v1-256'))
      .mockResolvedValueOnce(png('BUMPED', 'scene/v3.3/thumb-v2-256'))
      .mockResolvedValueOnce(png('REDONE', 'scene/v3.3/thumb-v2-256'));
    installApi({ renderThumbnail });

    const first = renderHook(() => useThumbnail(model({ hash: 'first' })));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    expect(first.result.current.src).toBe('data:image/png;base64,OLD');

    // A different model answered by a newer sidecar carries the new recipe.
    const other = renderHook(() => useThumbnail(model({ hash: 'second' })));
    await waitFor(() =>
      expect(other.result.current.src).toBe('data:image/png;base64,BUMPED'),
    );

    // The first model's cached pixels are now stale and must be re-rendered.
    const again = renderHook(() => useThumbnail(model({ hash: 'first' })));
    await waitFor(() =>
      expect(again.result.current.src).toBe('data:image/png;base64,REDONE'),
    );
    expect(renderThumbnail).toHaveBeenCalledTimes(3);
  });

  it('does not serve unversioned entries once a versioned sidecar answers', async () => {
    // An older sidecar omits the recipe. Those pixels must not satisfy a
    // lookup made once a versioned sidecar is answering.
    const renderThumbnail = vi
      .fn()
      .mockResolvedValueOnce({ width: 256, height: 256, pngBase64: 'LEGACY' })
      .mockResolvedValueOnce({
        width: 256,
        height: 256,
        pngBase64: 'VERSIONED',
        cacheRecipe: 'scene/v3.2/thumb-v1-256',
      })
      .mockResolvedValueOnce({
        width: 256,
        height: 256,
        pngBase64: 'REDONE',
        cacheRecipe: 'scene/v3.2/thumb-v1-256',
      });
    installApi({ renderThumbnail });

    const legacy = renderHook(() => useThumbnail(model({ hash: 'mixed' })));
    await waitFor(() =>
      expect(legacy.result.current.src).toBe('data:image/png;base64,LEGACY'),
    );

    const upgraded = renderHook(() => useThumbnail(model({ hash: 'other' })));
    await waitFor(() =>
      expect(upgraded.result.current.src).toBe(
        'data:image/png;base64,VERSIONED',
      ),
    );

    const again = renderHook(() => useThumbnail(model({ hash: 'mixed' })));
    await waitFor(() =>
      expect(again.result.current.src).toBe('data:image/png;base64,REDONE'),
    );
    expect(renderThumbnail).toHaveBeenCalledTimes(3);
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

  it('does not share an obsolete path for the same content hash', async () => {
    const result = {
      width: 256,
      height: 256,
      pngBase64: 'MOVED',
    };
    const finishes: Array<(value: typeof result) => void> = [];
    const renderThumbnail = vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          finishes.push(resolve);
        }),
    );
    installApi({ renderThumbnail });
    const atPath = (path: string): LogicalModel =>
      model({
        hash: 'moved-model',
        locations: [
          {
            rootId: path,
            path,
            rootRelative: path,
            size: 2048,
            available: true,
          },
        ],
      });

    const oldPath = renderHook(() =>
      useThumbnail(atPath('C:\\old\\widget.stl')),
    );
    const newPath = renderHook(() =>
      useThumbnail(atPath('D:\\new\\widget.stl')),
    );

    await waitFor(() => expect(renderThumbnail).toHaveBeenCalledTimes(2));
    expect(renderThumbnail).toHaveBeenNthCalledWith(1, {
      path: 'C:\\old\\widget.stl',
      size: 256,
    });
    expect(renderThumbnail).toHaveBeenNthCalledWith(2, {
      path: 'D:\\new\\widget.stl',
      size: 256,
    });
    await act(async () => {
      finishes.forEach((finish) => finish(result));
      await Promise.resolve();
    });
    await waitFor(() => expect(oldPath.result.current.status).toBe('ready'));
    expect(newPath.result.current.status).toBe('ready');
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

  it('completes repeated thumbnail batches without deadlocking queued work', async () => {
    const renderThumbnail = vi.fn().mockImplementation(() =>
      Promise.resolve({
        width: 256,
        height: 256,
        pngBase64: 'SOAK',
        cacheRecipe: 'scene/v3.2/thumb-v1-256',
      }),
    );
    installApi({ renderThumbnail });

    for (let round = 0; round < 5; round += 1) {
      const hooks = Array.from({ length: 40 }, (_, index) =>
        renderHook(() =>
          useThumbnail(model({ hash: `round-${round}-h-${index}` })),
        ),
      );
      await waitFor(() =>
        hooks.forEach((hook) =>
          expect(hook.result.current.status).toBe('ready'),
        ),
      );
      hooks.forEach((hook) => hook.unmount());
    }

    expect(renderThumbnail).toHaveBeenCalledTimes(200);
  });
});
