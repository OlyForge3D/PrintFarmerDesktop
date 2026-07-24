import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Collection,
  ImportPreviewResponse,
  ImportRootRequest,
  ImportRootResponse,
  LogicalModel,
  ReconcileReport,
  ScanRootResponse,
  Tag,
} from '@shared/ipc';
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

export type LibraryStatus = 'idle' | 'loading' | 'preparing' | 'scanning';

export interface LibraryScanActivity {
  phase: 'idle' | 'preparing' | 'scanning';
  path: string | null;
  label: string | null;
  estimatedTotal: number | null;
  backendProgressAvailable: boolean;
}

export interface ImportDraft {
  rootId: string;
  path: string;
  preview: ImportPreviewResponse;
  collections: Collection[];
  tags: Tag[];
}

export interface Library {
  /** Every logical model currently visible in the library UI. */
  models: LogicalModel[];
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
  /** Close the import preview without changing the catalog. */
  cancelImport: () => void;
  /** Re-read the catalog without scanning. */
  refresh: () => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns the renderer-side model library: loads the persisted catalog on mount,
 * prepares read-only folder previews, then imports confirmed organization rules
 * through the Rust sidecar and refreshes the list.
 */
export function useLibrary(): Library {
  const [catalogModels, setCatalogModels] = useState<LogicalModel[]>([]);
  const [storedRoots, setStoredRoots] = useState<StoredSourceRoot[]>(
    () => loadStoredSourceRoots(),
  );
  const [status, setStatus] = useState<LibraryStatus>('idle');
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    saveStoredSourceRoots(storedRoots);
  }, [storedRoots]);

  const removedRootIds = useMemo(
    () =>
      new Set(
        storedRoots
          .filter((root) => root.removed)
          .map((root) => root.rootId),
      ),
    [storedRoots],
  );
  const models = useMemo(
    () => filterModelsByRemovedRoots(catalogModels, removedRootIds),
    [catalogModels, removedRootIds],
  );
  const sourceRoots = useMemo(
    () => summarizeSourceRoots(catalogModels, storedRoots),
    [catalogModels, storedRoots],
  );
  const sourceRootsRef = useRef(sourceRoots);
  sourceRootsRef.current = sourceRoots;

  const rememberRoot = useCallback(
    (
      rootId: string,
      path: string,
      report: ReconcileReport | null = null,
      scannedAt = new Date().toISOString(),
    ) => {
      setStoredRoots((current) =>
        upsertStoredSourceRoot(current, {
          rootId,
          path,
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
      if (!options?.preserveStatus) {
        setStatus('loading');
      }
      try {
        setCatalogModels(await window.printFarmer.listModels());
      } catch (err: unknown) {
        setError(messageOf(err));
        if (options?.throwOnError) {
          throw err;
        }
      } finally {
        if (!options?.preserveStatus) {
          setStatus('idle');
        }
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    setError(null);
    await loadCatalog();
  }, [loadCatalog]);

  const addFolder = useCallback(async () => {
    if (importInFlightRef.current) {
      setError('An import operation is already in progress.');
      return false;
    }
    importInFlightRef.current = true;
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
      const [preview, collections, tags] = await Promise.all([
        window.printFarmer.previewImport({ path: selection.path }),
        window.printFarmer.listCollections(),
        window.printFarmer.listTags(),
      ]);
      if (!preview.complete) {
        setError(
          `Could not inspect the entire folder (${preview.skippedErrors} filesystem errors). No files were imported.`,
        );
        return false;
      }
      setImportDraft({
        rootId: rootIdForPath(selection.path),
        path: selection.path,
        preview,
        collections,
        tags,
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
  }, []);

  const confirmImport = useCallback(
    async (
      plan: Pick<ImportRootRequest, 'rules' | 'commonTags'>,
    ): Promise<ImportRootResponse | null> => {
      if (!importDraft) {
        setError('No folder is ready to import.');
        return null;
      }
      if (importInFlightRef.current) {
        setError('An import operation is already in progress.');
        return null;
      }
      importInFlightRef.current = true;
      setError(null);
      setStatus('scanning');
      setScanningPath(importDraft.path);
      setScanActivity({
        phase: 'scanning',
        path: importDraft.path,
        label: `Scanning ${importDraft.path}`,
        estimatedTotal: importDraft.preview.modelCount,
        backendProgressAvailable: false,
      });
      try {
        const result = await window.printFarmer.importRoot({
          rootId: importDraft.rootId,
          path: importDraft.path,
          ...plan,
        });
        setLastImport(result);
        setLastReport(result.report);
        rememberRoot(importDraft.rootId, importDraft.path, result.report);
        try {
          await loadCatalog({ preserveStatus: true, throwOnError: true });
        } catch (refreshError: unknown) {
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

  const rescanRoot = useCallback(
    async (rootId: string): Promise<ScanRootResponse | null> => {
      if (importInFlightRef.current) {
        setError('A library scan is already in progress.');
        return null;
      }
      const root = sourceRootsRef.current.find((entry) => entry.rootId === rootId);
      if (!root) {
        setError('That source root is no longer available in the library.');
        return null;
      }
      importInFlightRef.current = true;
      setError(null);
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
      try {
        const report = await window.printFarmer.scanRoot({
          rootId: root.rootId,
          path: root.path,
        });
        setLastImport(null);
        setLastReport(report);
        rememberRoot(root.rootId, root.path, report);
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
        const derived = sourceRootsRef.current.find((root) => root.rootId === rootId);
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    models,
    status,
    error,
    lastReport,
    scanningPath,
    importDraft,
    lastImport,
    sourceRoots,
    scanActivity,
    addFolder,
    confirmImport,
    rescanRoot,
    removeRoot,
    cancelImport,
    refresh,
  };
}
