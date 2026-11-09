import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Collection,
  ImportPreviewResponse,
  ImportRootRequest,
  ImportRootResponse,
  LogicalModel,
  OrganizationKind,
  ReconcileReport,
  ResetCatalogResponse,
  ScanRootResponse,
  Tag,
  LibraryPageSize,
  LibrarySourceSummary,
  QueryModelsRequest,
  QueryModelsResponse,
} from '@shared/ipc';
import { LibraryPageSize as PageSizeSchema } from '@shared/ipc';
import { defaultLibraryView, type LibraryView } from './filter';
import { rootIdForPath } from './model';
import {
  filterModelsByRemovedRoots,
  loadStoredSourceRoots,
  removeStoredSourceRoot,
  saveStoredSourceRoots,
  summarizeSourceRoots,
  upsertStoredSourceRoot,
  type SourceRootSummary,
  type StoredSourceRoot,
} from './sourceRoots';

export type LibraryStatus =
  'idle' | 'loading' | 'preparing' | 'scanning' | 'resetting';

export interface LibraryScanActivity {
  phase: 'idle' | 'preparing' | 'scanning';
  path: string | null;
  label: string | null;
  estimatedTotal: number | null;
  backendProgressAvailable: boolean;
  /**
   * Renderer-observable stage of a confirmed import. The sidecar import is a
   * single request with no incremental progress, so only stage boundaries are
   * reported, never processed counts.
   */
  importStage?: ImportStage;
}

export type ImportStage = 'importing' | 'refreshing';

export interface ImportDraft {
  rootId: string;
  approvalId: string;
  path: string;
  preview: ImportPreviewResponse;
  collections: Collection[];
  tags: Tag[];
}

export interface Library {
  /** Every logical model currently visible in the library UI. */
  models: LogicalModel[];
  resultsCurrent: boolean;
  totalModels: number;
  filteredTotal: number;
  counts: QueryModelsResponse['counts'];
  collections: Collection[];
  tags: Tag[];
  /** Effective filter request for the current page (used by bulk "all matching"). */
  queryRequest: QueryModelsRequest;
  /** True while search debounce or a query is still settling. */
  queryPending: boolean;
  page: number;
  pageSize: LibraryPageSize;
  setPage: (page: number) => void;
  setPageSize: (size: LibraryPageSize) => void;
  status: LibraryStatus;
  error: string | null;
  /** Reconciliation summary from the most recent folder scan. */
  lastReport: ReconcileReport | null;
  /** Absolute path for the folder currently being scanned, if any. */
  scanningPath: string | null;
  /** Folder preview waiting for organization choices, if any. */
  importDraft: ImportDraft | null;
  /** Organization summary from the most recently completed import. */
  lastImport: ImportRootResponse | null;
  /** Source roots currently configured in the renderer. */
  sourceRoots: SourceRootSummary[];
  /** Best-effort scan/progress status for the current operation. */
  scanActivity: LibraryScanActivity;
  /** Retry the last source operation, preserving its original folder and rules. */
  retryLastOperation: () => Promise<void>;
  retryLabel: string | null;
  /** Hide the most recent scan feedback without changing the catalog. */
  dismissScanFeedback: () => void;
  scanFeedbackVisible: boolean;
  /** Prompt for a folder and prepare a read-only hierarchy preview. */
  addFolder: () => Promise<boolean>;
  /** Reconcile and organize the prepared folder using the confirmed rules. */
  confirmImport: (
    plan: Pick<ImportRootRequest, 'rules' | 'commonTags'>,
  ) => Promise<ImportRootResponse | null>;
  /** Reconcile an existing source root against the current filesystem. */
  rescanRoot: (rootId: string) => Promise<ScanRootResponse | null>;
  /** Hide a source root in the UI until the sidecar grows root deletion. */
  removeRoot: (rootId: string) => void;
  /** Clear indexed models and source roots without deleting source files. */
  resetCatalog: () => Promise<ResetCatalogResponse | null>;
  /** Close the import preview without changing the catalog. */
  cancelImport: () => void;
  /** Re-read the catalog without scanning. */
  refresh: () => Promise<void>;
  /**
   * Drop deleted tag or collection definitions from the cached catalog at once
   * and discard any in-flight read that could still contain them. Follow with
   * {@link Library.refresh} to re-read authoritative state.
   */
  forgetOrganizationDefinitions: (
    kind: OrganizationKind,
    ids: readonly string[],
  ) => void;
  /** Dismiss the current notification without changing catalog or import state. */
  dismissError: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns the renderer-side model library: loads the persisted catalog on mount,
 * prepares read-only folder previews, then imports confirmed organization rules
 * through the Rust sidecar and refreshes the list.
 */
const PAGE_SIZE_KEY = 'printfarmer.library.pageSize.v1';
const EMPTY_COUNTS: QueryModelsResponse['counts'] = {
  all: 0,
  favorites: 0,
  stl: 0,
  threeMf: 0,
  obj: 0,
  step: 0,
  duplicates: 0,
  missing: 0,
};

function storedPageSize(): LibraryPageSize {
  try {
    const parsed = PageSizeSchema.safeParse(
      Number(globalThis.localStorage?.getItem(PAGE_SIZE_KEY)),
    );
    return parsed.success ? parsed.data : 48;
  } catch {
    return 48;
  }
}

export function useLibrary(
  view: Pick<LibraryView, 'query' | 'filter' | 'sort'> = defaultLibraryView,
  collectionIds: readonly string[] = [],
  tagIds: readonly string[] = [],
): Library {
  const [catalogModels, setCatalogModels] = useState<LogicalModel[]>([]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [sourceSummaries, setSourceSummaries] = useState<
    LibrarySourceSummary[]
  >([]);
  const [loadedQueryKey, setLoadedQueryKey] = useState('');
  const [paging, setPaging] = useState(() => ({
    page: 1,
    size: storedPageSize(),
    scope: '',
  }));
  const [search, setSearch] = useState(view.query);
  const responseRevision = useRef(0);
  const [storedRoots, setStoredRoots] = useState<StoredSourceRoot[]>(() =>
    loadStoredSourceRoots(),
  );
  const [status, setStatus] = useState<LibraryStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [retryLabel, setRetryLabel] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<ReconcileReport | null>(null);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [scanActivity, setScanActivity] = useState<LibraryScanActivity>({
    phase: 'idle',
    path: null,
    label: null,
    estimatedTotal: null,
    backendProgressAvailable: false,
  });
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [lastImport, setLastImport] = useState<ImportRootResponse | null>(null);
  const importInFlightRef = useRef(false);
  const retryActionRef = useRef<(() => Promise<void>) | null>(null);
  const [scanFeedbackVisible, setScanFeedbackVisible] = useState(false);

  useEffect(() => {
    saveStoredSourceRoots(storedRoots);
  }, [storedRoots]);

  const removedRootIds = useMemo(
    () =>
      new Set(
        storedRoots.filter((root) => root.removed).map((root) => root.rootId),
      ),
    [storedRoots],
  );
  const collectionKey = JSON.stringify([...collectionIds].sort());
  const tagKey = JSON.stringify([...tagIds].sort());
  const rootKey = JSON.stringify([...removedRootIds].sort());
  const scope = JSON.stringify([
    search,
    view.filter,
    view.sort,
    collectionKey,
    tagKey,
    rootKey,
  ]);
  const page = paging.scope === scope ? paging.page : 1;
  const request = useMemo<QueryModelsRequest>(
    () => ({
      query: search,
      filter: view.filter,
      sort: view.sort,
      collectionIds: JSON.parse(collectionKey) as string[],
      tagIds: JSON.parse(tagKey) as string[],
      excludedRootIds: JSON.parse(rootKey) as string[],
      page,
      pageSize: paging.size,
    }),
    [
      search,
      view.filter,
      view.sort,
      collectionKey,
      tagKey,
      rootKey,
      page,
      paging.size,
    ],
  );
  const requestRef = useRef(request);
  requestRef.current = request;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const setPage = useCallback(
    (next: number) => {
      setPaging((current) => ({
        ...current,
        scope,
        page: Math.max(
          1,
          Math.min(next, Math.max(1, Math.ceil(filteredTotal / current.size))),
        ),
      }));
    },
    [scope, filteredTotal],
  );
  const setPageSize = useCallback(
    (size: LibraryPageSize) => {
      setPaging({ page: 1, size, scope });
      try {
        globalThis.localStorage?.setItem(PAGE_SIZE_KEY, String(size));
      } catch {
        // Best-effort renderer preference; paging still works without storage.
      }
    },
    [scope],
  );
  useEffect(() => {
    const timer = setTimeout(() => setSearch(view.query), 200);
    return () => clearTimeout(timer);
  }, [view.query]);
  const models = useMemo(
    () => filterModelsByRemovedRoots(catalogModels, removedRootIds),
    [catalogModels, removedRootIds],
  );
  const sourceRoots = useMemo(
    () => summarizeSourceRoots(catalogModels, storedRoots, sourceSummaries),
    [catalogModels, storedRoots, sourceSummaries],
  );
  const sourceRootsRef = useRef(sourceRoots);
  sourceRootsRef.current = sourceRoots;

  const rememberRoot = useCallback(
    (
      rootId: string,
      path: string,
      approvalId: string | null,
      report: ReconcileReport | null = null,
      scannedAt = new Date().toISOString(),
    ) => {
      setStoredRoots((current) =>
        upsertStoredSourceRoot(current, {
          rootId,
          path,
          approvalId,
          removed: false,
          lastReport: report,
          lastScannedAt: scannedAt,
        }),
      );
    },
    [],
  );

  const loadCatalog = useCallback(
    async (options?: {
      preserveStatus?: boolean;
      throwOnError?: boolean;
    }): Promise<void> => {
      const revision = ++responseRevision.current;
      const target = requestRef.current;
      const targetScope = scopeRef.current;
      if (!options?.preserveStatus) {
        setStatus('loading');
      }
      try {
        const [result, definitions, tagDefinitions] = await Promise.all([
          window.printFarmer.queryModels(target),
          window.printFarmer.listCollections(),
          window.printFarmer.listTags(),
        ]);
        if (
          revision !== responseRevision.current ||
          target !== requestRef.current
        )
          return;
        setError(null);
        setCatalogModels(result.models);
        setCounts(result.counts);
        setFilteredTotal(result.filteredTotal);
        setSourceSummaries(result.sources);
        setCollections(definitions);
        setTags(tagDefinitions);
        setLoadedQueryKey(JSON.stringify({ ...target, page: result.page }));
        setPaging((current) => ({
          ...current,
          page: result.page,
          scope: targetScope,
        }));
      } catch (err: unknown) {
        if (
          revision === responseRevision.current &&
          target === requestRef.current
        )
          setError(messageOf(err));
        if (options?.throwOnError) {
          throw err;
        }
      } finally {
        if (
          !options?.preserveStatus &&
          revision === responseRevision.current &&
          target === requestRef.current
        ) {
          setStatus('idle');
        }
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    retryActionRef.current = async () => {
      setError(null);
      await loadCatalog();
    };
    setRetryLabel('Reload catalog');
    setError(null);
    await loadCatalog();
  }, [loadCatalog]);

  const forgetOrganizationDefinitions = useCallback(
    (kind: OrganizationKind, ids: readonly string[]) => {
      if (ids.length === 0) return;
      responseRevision.current += 1;
      const deleted = new Set(ids);
      if (kind === 'tag') {
        setTags((current) => current.filter((tag) => !deleted.has(tag.id)));
      } else {
        setCollections((current) =>
          current.filter((collection) => !deleted.has(collection.id)),
        );
      }
    },
    [],
  );

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  const retryLastOperation = useCallback(async () => {
    if (importInFlightRef.current) return;
    if (retryActionRef.current) {
      await retryActionRef.current();
    } else {
      setError(null);
      await loadCatalog();
    }
  }, [loadCatalog]);

  const dismissScanFeedback = useCallback(() => {
    setScanFeedbackVisible(false);
  }, []);

  const previewSelection = useCallback(
    async (selection: {
      path: string;
      approvalId: string;
    }): Promise<boolean> => {
      if (importInFlightRef.current) return false;
      importInFlightRef.current = true;
      retryActionRef.current = () => previewSelection(selection).then(() => {});
      setRetryLabel('Retry folder scan');
      setError(null);
      setScanFeedbackVisible(false);
      setStatus('preparing');
      setScanActivity({
        phase: 'preparing',
        path: selection.path,
        label: `Preparing ${selection.path}`,
        estimatedTotal: null,
        backendProgressAvailable: false,
      });
      try {
        const preview = await window.printFarmer.previewImport({
          approvalId: selection.approvalId,
        });
        if (!preview.complete) {
          setError(
            preview.failure ??
              'The folder scan did not complete, so no files were imported. Retry the scan, or check folder access if this keeps happening.',
          );
          return false;
        }
        setScanActivity({
          phase: 'preparing',
          path: selection.path,
          label: 'Loading import organization choices',
          estimatedTotal: preview.modelCount,
          backendProgressAvailable: false,
        });
        const nextCollections = await window.printFarmer.listCollections();
        const nextTags = await window.printFarmer.listTags();
        setImportDraft({
          rootId: rootIdForPath(selection.path),
          approvalId: selection.approvalId,
          path: selection.path,
          preview,
          collections: nextCollections,
          tags: nextTags,
        });
        return true;
      } catch (err: unknown) {
        setError(messageOf(err));
        return false;
      } finally {
        importInFlightRef.current = false;
        setStatus('idle');
        setScanActivity({
          phase: 'idle',
          path: null,
          label: null,
          estimatedTotal: null,
          backendProgressAvailable: false,
        });
      }
    },
    [],
  );

  const chooseAndPreviewFolder = useCallback(async (): Promise<boolean> => {
    if (importInFlightRef.current) {
      setError('An import operation is already in progress.');
      return false;
    }
    importInFlightRef.current = true;
    retryActionRef.current = async () => {
      await chooseAndPreviewFolder();
    };
    setRetryLabel('Choose source folder');
    setError(null);
    setStatus('preparing');
    setScanActivity({
      phase: 'preparing',
      path: null,
      label: 'Choosing a source folder',
      estimatedTotal: null,
      backendProgressAvailable: false,
    });
    try {
      const selection = await window.printFarmer.openFolder();
      if (!selection) {
        return false;
      }
      importInFlightRef.current = false;
      return await previewSelection(selection);
    } catch (err: unknown) {
      setError(messageOf(err));
      return false;
    } finally {
      importInFlightRef.current = false;
      setStatus('idle');
      setScanActivity({
        phase: 'idle',
        path: null,
        label: null,
        estimatedTotal: null,
        backendProgressAvailable: false,
      });
    }
  }, [previewSelection]);

  const addFolder = useCallback(
    () => chooseAndPreviewFolder(),
    [chooseAndPreviewFolder],
  );

  const performImport = useCallback(
    async (
      rootId: string,
      path: string,
      approvalId: string,
      plan: Pick<ImportRootRequest, 'rules' | 'commonTags'>,
    ): Promise<ImportRootResponse | null> => {
      if (importInFlightRef.current) {
        setError('An import operation is already in progress.');
        return null;
      }
      importInFlightRef.current = true;
      retryActionRef.current = () =>
        performImport(rootId, path, approvalId, plan).then(() => {});
      setRetryLabel('Retry import');
      setError(null);
      setScanFeedbackVisible(false);
      setStatus('scanning');
      setScanningPath(path);
      setScanActivity({
        phase: 'scanning',
        path,
        label: `Scanning ${path}`,
        estimatedTotal: importDraft?.preview.modelCount ?? null,
        backendProgressAvailable: false,
        importStage: 'importing',
      });
      try {
        const result = await window.printFarmer.importRoot({
          rootId,
          approvalId,
          ...plan,
        });
        if (result.report.failure) {
          setError(result.report.failure);
          return null;
        }
        setLastImport(result);
        setLastReport(result.report);
        setScanFeedbackVisible(true);
        rememberRoot(rootId, path, approvalId, result.report);
        setScanActivity((current) => ({
          ...current,
          label: 'Refreshing library',
          importStage: 'refreshing',
        }));
        try {
          await loadCatalog({ preserveStatus: true, throwOnError: true });
        } catch (refreshError: unknown) {
          retryActionRef.current = async () => {
            setError(null);
            await loadCatalog();
          };
          setRetryLabel('Reload catalog');
          setError(
            `Import completed, but the catalog could not be refreshed: ${messageOf(refreshError)}`,
          );
        }
        setImportDraft(null);
        return result;
      } catch (err: unknown) {
        const importError = messageOf(err);
        try {
          await loadCatalog({ preserveStatus: true, throwOnError: true });
          setError(importError);
        } catch (refreshError: unknown) {
          setError(
            `${importError} Catalog refresh also failed: ${messageOf(refreshError)}`,
          );
        }
        return null;
      } finally {
        importInFlightRef.current = false;
        setScanningPath(null);
        setStatus('idle');
        setScanActivity({
          phase: 'idle',
          path: null,
          label: null,
          estimatedTotal: null,
          backendProgressAvailable: false,
        });
      }
    },
    [importDraft, loadCatalog, rememberRoot],
  );

  const confirmImport = useCallback(
    async (
      plan: Pick<ImportRootRequest, 'rules' | 'commonTags'>,
    ): Promise<ImportRootResponse | null> => {
      if (!importDraft) {
        setError('No folder is ready to import.');
        return null;
      }
      return performImport(
        importDraft.rootId,
        importDraft.path,
        importDraft.approvalId,
        plan,
      );
    },
    [importDraft, performImport],
  );

  const rescanRoot = useCallback(
    async (rootId: string): Promise<ScanRootResponse | null> => {
      if (importInFlightRef.current) {
        setError('A library scan is already in progress.');
        return null;
      }
      const root = sourceRootsRef.current.find(
        (entry) => entry.rootId === rootId,
      );
      if (!root) {
        setError('That source root is no longer available in the library.');
        return null;
      }
      importInFlightRef.current = true;
      retryActionRef.current = () => rescanRoot(rootId).then(() => {});
      setRetryLabel('Retry scan');
      setError(null);
      setScanFeedbackVisible(false);
      try {
        let approvalId = root.approvalId;
        if (!approvalId) {
          setStatus('preparing');
          setScanActivity({
            phase: 'preparing',
            path: root.path,
            label: `Reauthorize ${root.path}`,
            estimatedTotal: null,
            backendProgressAvailable: false,
          });
          const selection = await window.printFarmer.openFolder();
          if (!selection) {
            return null;
          }
          if (selection.path !== root.path) {
            setError(`Select ${root.path} to reconnect this source.`);
            return null;
          }
          approvalId = selection.approvalId;
        }
        setStatus('scanning');
        setScanningPath(root.path);
        setScanActivity({
          phase: 'scanning',
          path: root.path,
          label:
            root.status === 'available'
              ? `Scanning ${root.path}`
              : `Reconnecting ${root.path}`,
          estimatedTotal: root.totalModels > 0 ? root.totalModels : null,
          backendProgressAvailable: false,
        });
        const report = await window.printFarmer.scanRoot({
          rootId: root.rootId,
          approvalId,
        });
        setLastImport(null);
        setLastReport(report);
        setScanFeedbackVisible(true);
        if (report.failure) {
          setError(report.failure);
          return null;
        }
        rememberRoot(root.rootId, root.path, approvalId, report);
        await loadCatalog({ preserveStatus: true, throwOnError: true });
        return report;
      } catch (err: unknown) {
        const scanError = messageOf(err);
        try {
          await loadCatalog({ preserveStatus: true, throwOnError: true });
        } catch {
          // Keep the original scan error; the last known catalog is still useful.
        }
        setError(scanError);
        return null;
      } finally {
        importInFlightRef.current = false;
        setScanningPath(null);
        setStatus('idle');
        setScanActivity({
          phase: 'idle',
          path: null,
          label: null,
          estimatedTotal: null,
          backendProgressAvailable: false,
        });
      }
    },
    [loadCatalog, rememberRoot],
  );

  const removeRoot = useCallback((rootId: string) => {
    setStoredRoots((current) => {
      const existing = current.find((root) => root.rootId === rootId);
      if (!existing) {
        const derived = sourceRootsRef.current.find(
          (root) => root.rootId === rootId,
        );
        if (!derived) {
          return current;
        }
        return removeStoredSourceRoot(
          upsertStoredSourceRoot(current, {
            rootId,
            path: derived.path,
            removed: false,
            lastReport: derived.lastReport,
            lastScannedAt: derived.lastScannedAt,
          }),
          rootId,
        );
      }
      return removeStoredSourceRoot(current, rootId);
    });
  }, []);

  const cancelImport = useCallback(() => {
    setImportDraft(null);
  }, []);

  const resetCatalog = useCallback(async () => {
    if (importInFlightRef.current) {
      setError('Wait for the current library operation to finish.');
      return null;
    }
    importInFlightRef.current = true;
    setError(null);
    setStatus('resetting');
    try {
      const result = await window.printFarmer.resetCatalog();
      setCatalogModels([]);
      responseRevision.current += 1;
      setCollections([]);
      setTags([]);
      setCounts(EMPTY_COUNTS);
      setFilteredTotal(0);
      setSourceSummaries([]);
      setPaging((current) => ({ ...current, page: 1 }));
      setStoredRoots([]);
      setLastReport(null);
      setLastImport(null);
      setImportDraft(null);
      return result;
    } catch (err: unknown) {
      setError(`Catalog reset failed: ${messageOf(err)}`);
      return null;
    } finally {
      importInFlightRef.current = false;
      setStatus('idle');
    }
  }, []);

  useEffect(() => {
    void loadCatalog({ preserveStatus: importInFlightRef.current });
    return () => {
      responseRevision.current += 1;
    };
  }, [loadCatalog, request]);

  return {
    models,
    resultsCurrent: loadedQueryKey === JSON.stringify(request),
    totalModels: counts.all,
    filteredTotal,
    counts,
    collections,
    tags,
    queryRequest: request,
    queryPending:
      view.query !== search ||
      loadedQueryKey !== JSON.stringify(request) ||
      status === 'loading',
    page,
    pageSize: paging.size,
    setPage,
    setPageSize,
    status,
    error,
    lastReport,
    scanningPath,
    importDraft,
    lastImport,
    sourceRoots,
    scanActivity,
    retryLastOperation,
    retryLabel: retryLabel ?? (error ? 'Reload catalog' : null),
    dismissScanFeedback,
    scanFeedbackVisible,
    addFolder,
    confirmImport,
    rescanRoot,
    removeRoot,
    resetCatalog,
    cancelImport,
    refresh,
    forgetOrganizationDefinitions,
    dismissError,
  };
}
