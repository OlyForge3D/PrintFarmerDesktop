import { useEffect, useState } from 'react';
import type { LogicalModel } from '@shared/ipc';
import { preferredPath } from './model';

/**
 * Process-lifetime cache of rendered thumbnails, keyed by content hash. Because
 * thumbnails are a deterministic function of model content, a hash hit is always
 * valid and lets us skip re-rendering the same model across cards and refreshes.
 */
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
const thumbnailQueue: Array<() => void> = [];
const MAX_CONCURRENT_THUMBNAILS = 3;
let activeThumbnails = 0;
let cacheGeneration = 0;

/** Clears the thumbnail cache. Intended for tests. */
export function clearThumbnailCache(): void {
  cacheGeneration += 1;
  cache.clear();
  inFlight.clear();
}

export type ThumbnailStatus = 'loading' | 'ready' | 'error';

export interface ThumbnailState {
  /** A `data:` URL for the rendered PNG, or `null` while loading or on error. */
  src: string | null;
  status: ThumbnailStatus;
}

const THUMBNAIL_SIZE = 256;

function scheduleThumbnail<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      activeThumbnails += 1;
      void task()
        .then(resolve, reject)
        .finally(() => {
          activeThumbnails -= 1;
          thumbnailQueue.shift()?.();
        });
    };
    if (activeThumbnails < MAX_CONCURRENT_THUMBNAILS) {
      start();
    } else {
      thumbnailQueue.push(start);
    }
  });
}

function requestThumbnail(
  hash: string,
  render: () => Promise<{ pngBase64: string }>,
): Promise<string> {
  const pending = inFlight.get(hash);
  if (pending) {
    return pending;
  }

  const generation = cacheGeneration;
  const request = scheduleThumbnail(render)
    .then((result) => {
      const src = `data:image/png;base64,${result.pngBase64}`;
      if (generation === cacheGeneration) {
        cache.set(hash, src);
      }
      return src;
    })
    .finally(() => {
      if (inFlight.get(hash) === request) {
        inFlight.delete(hash);
      }
    });
  inFlight.set(hash, request);
  return request;
}

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
    requestThumbnail(hash, () =>
      api.renderThumbnail({ path, size: THUMBNAIL_SIZE }),
    )
      .then((src) => {
        if (cancelled) {
          return;
        }
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
