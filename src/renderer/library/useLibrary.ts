import { useCallback, useEffect, useState } from 'react';
import type {
  Collection,
  ImportPreviewResponse,
  ImportRootRequest,
  ImportRootResponse,
  LogicalModel,
  ReconcileReport,
  Tag,
} from '@shared/ipc';
import { rootIdForPath } from './model';

export type LibraryStatus = 'idle' | 'loading' | 'preparing' | 'scanning';

export interface ImportDraft {
  rootId: string;
  path: string;
  preview: ImportPreviewResponse;
  collections: Collection[];
  tags: Tag[];
}

export interface Library {
  /** Every logical model currently known to the on-disk catalog. */
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
  /** Prompt for a folder and prepare a read-only hierarchy preview. */
  addFolder: () => Promise<void>;
  /** Reconcile and organize the prepared folder using the confirmed rules. */
  confirmImport: (
    plan: Pick<ImportRootRequest, 'rules' | 'commonTags'>,
  ) => Promise<boolean>;
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
  const [models, setModels] = useState<LogicalModel[]>([]);
  const [status, setStatus] = useState<LibraryStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<ReconcileReport | null>(null);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [importDraft, setImportDraft] = useState<ImportDraft | null>(null);
  const [lastImport, setLastImport] = useState<ImportRootResponse | null>(null);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      setModels(await window.printFarmer.listModels());
    } catch (err: unknown) {
      setError(messageOf(err));
    } finally {
      setStatus('idle');
    }
  }, []);

  const addFolder = useCallback(async () => {
    setError(null);
    let selection: Awaited<ReturnType<typeof window.printFarmer.openFolder>>;
    try {
      selection = await window.printFarmer.openFolder();
    } catch (err: unknown) {
      setError(messageOf(err));
      return;
    }
    if (!selection) {
      return;
    }

    setStatus('preparing');
    try {
      const [preview, collections, tags] = await Promise.all([
        window.printFarmer.previewImport({ path: selection.path }),
        window.printFarmer.listCollections(),
        window.printFarmer.listTags(),
      ]);
      setImportDraft({
        rootId: rootIdForPath(selection.path),
        path: selection.path,
        preview,
        collections,
        tags,
      });
    } catch (err: unknown) {
      setError(messageOf(err));
    } finally {
      setStatus('idle');
    }
  }, []);

  const confirmImport = useCallback(
    async (
      plan: Pick<ImportRootRequest, 'rules' | 'commonTags'>,
    ): Promise<boolean> => {
      if (!importDraft) {
        setError('No folder is ready to import.');
        return false;
      }
      setError(null);
      setStatus('scanning');
      setScanningPath(importDraft.path);
      try {
        const result = await window.printFarmer.importRoot({
          rootId: importDraft.rootId,
          path: importDraft.path,
          ...plan,
        });
        setLastImport(result);
        setLastReport(result.report);
        setModels(await window.printFarmer.listModels());
        setImportDraft(null);
        return true;
      } catch (err: unknown) {
        setError(messageOf(err));
        return false;
      } finally {
        setScanningPath(null);
        setStatus('idle');
      }
    },
    [importDraft],
  );

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
    addFolder,
    confirmImport,
    cancelImport,
    refresh,
  };
}
