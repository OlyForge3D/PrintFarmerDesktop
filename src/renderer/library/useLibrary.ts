import { useCallback, useEffect, useState } from 'react';
import type { LogicalModel, ReconcileReport } from '@shared/ipc';
import { rootIdForPath } from './model';

export type LibraryStatus = 'idle' | 'loading' | 'scanning';

export interface Library {
  /** Every logical model currently known to the on-disk catalog. */
  models: LogicalModel[];
  status: LibraryStatus;
  error: string | null;
  /** Reconciliation summary from the most recent folder scan. */
  lastReport: ReconcileReport | null;
  /** Absolute path for the folder currently being scanned, if any. */
  scanningPath: string | null;
  /** Prompt for a folder, scan it in place, then refresh the model list. */
  addFolder: () => Promise<void>;
  /** Re-read the catalog without scanning. */
  refresh: () => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns the renderer-side model library: loads the persisted catalog on mount,
 * and lets the user add a source folder (which scans it in place via the Rust
 * sidecar and refreshes the list).
 */
export function useLibrary(): Library {
  const [models, setModels] = useState<LogicalModel[]>([]);
  const [status, setStatus] = useState<LibraryStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<ReconcileReport | null>(null);
  const [scanningPath, setScanningPath] = useState<string | null>(null);

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

    setStatus('scanning');
    setScanningPath(selection.path);
    try {
      const report = await window.printFarmer.scanRoot({
        rootId: rootIdForPath(selection.path),
        path: selection.path,
      });
      setLastReport(report);
      setModels(await window.printFarmer.listModels());
    } catch (err: unknown) {
      setError(messageOf(err));
    } finally {
      setScanningPath(null);
      setStatus('idle');
    }
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
    addFolder,
    refresh,
  };
}
