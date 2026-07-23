import { useEffect, useState } from 'react';
import type { ModelFormat, VendorMetadata } from '@shared/ipc';

export interface VendorMetadataState {
  metadata: VendorMetadata | null;
  error: string | null;
  sourcePath: string | null;
}

/**
 * Fetches slicer-project (vendor) metadata for the loaded model. Only 3MF files
 * can carry it, so STL loads (and no selection) clear the state without a call.
 * A vendor-less standard 3MF simply resolves to a `slicer: 'unknown'` record
 * with empty plates/thumbnails, which the panel renders as "no vendor data".
 */
export function useVendorMetadata(
  path: string | null,
  format: ModelFormat | null,
): VendorMetadataState {
  const [metadata, setMetadata] = useState<VendorMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);

  useEffect(() => {
    if (!path || format !== 'threeMf') {
      setMetadata(null);
      setError(null);
      setSourcePath(null);
      return;
    }
    let cancelled = false;
    setMetadata(null);
    setError(null);
    setSourcePath(null);
    window.printFarmer
      .extractVendorMetadata({ path })
      .then((result) => {
        if (!cancelled) {
          setMetadata(result);
          setSourcePath(path);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setMetadata(null);
          setError(err instanceof Error ? err.message : String(err));
          setSourcePath(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, format]);

  return { metadata, error, sourcePath };
}
