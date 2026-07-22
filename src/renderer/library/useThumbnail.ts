import { useEffect, useState } from 'react';
import type { LogicalModel } from '@shared/ipc';
import { preferredPath } from './model';

/**
 * Process-lifetime cache of rendered thumbnails, keyed by content hash. Because
 * thumbnails are a deterministic function of model content, a hash hit is always
 * valid and lets us skip re-rendering the same model across cards and refreshes.
 */
const cache = new Map<string, string>();

/** Clears the thumbnail cache. Intended for tests. */
export function clearThumbnailCache(): void {
  cache.clear();
}

export type ThumbnailStatus = 'loading' | 'ready' | 'error';

export interface ThumbnailState {
  /** A `data:` URL for the rendered PNG, or `null` while loading or on error. */
  src: string | null;
  status: ThumbnailStatus;
}

const THUMBNAIL_SIZE = 256;

/**
 * Lazily renders (and caches) a deterministic thumbnail for a model via the Rust
 * sidecar. Falls back to an error state when the model has no readable location
 * or the sidecar cannot render it.
 */
export function useThumbnail(model: LogicalModel): ThumbnailState {
  const hash = model.hash;
  const path = preferredPath(model);
  const cached = cache.get(hash) ?? null;
  const [state, setState] = useState<ThumbnailState>(
    cached
      ? { src: cached, status: 'ready' }
      : { src: null, status: 'loading' },
  );

  useEffect(() => {
    const existing = cache.get(hash);
    if (existing) {
      setState({ src: existing, status: 'ready' });
      return;
    }

    const api = window.printFarmer;
    if (!path || typeof api?.renderThumbnail !== 'function') {
      setState({ src: null, status: 'error' });
      return;
    }

    let cancelled = false;
    setState({ src: null, status: 'loading' });
    api
      .renderThumbnail({ path, size: THUMBNAIL_SIZE })
      .then((result) => {
        if (cancelled) {
          return;
        }
        const src = `data:image/png;base64,${result.pngBase64}`;
        cache.set(hash, src);
        setState({ src, status: 'ready' });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ src: null, status: 'error' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hash, path]);

  return state;
}
