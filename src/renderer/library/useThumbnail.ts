import { useEffect, useState } from 'react';
import type { LogicalModel, RenderThumbnailResponse } from '@shared/ipc';
import { preferredPath } from './model';

/**
 * Process-lifetime cache of rendered thumbnails, keyed by content hash *and* the
 * sidecar's cache recipe. The hash alone is not a safe key: the same bytes
 * render to different pixels after a parser or renderer change, and a version
 * nothing reads invalidates nothing. The sidecar is authoritative about its own
 * recipe, so the first render establishes it and a recipe change drops
 * everything cached under the previous one.
 */
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
const thumbnailQueue: Array<() => void> = [];
const MAX_CONCURRENT_THUMBNAILS = 3;
let activeThumbnails = 0;
let cacheGeneration = 0;

/**
 * Recipe the cached entries were rendered under, or `null` before the first
 * response. A sidecar that predates cache versioning omits it, which is its own
 * distinct key namespace rather than a silent merge with versioned entries.
 */
let activeRecipe: string | null = null;

const UNVERSIONED = '\u0000unversioned';

/**
 * The separator is NUL rather than a printable character on purpose. A joined
 * key is only unambiguous while neither field can contain the separator: with
 * `/`, `('a/b', 'c')` and `('a', 'b/c')` collapse onto the same entry and two
 * models silently share pixels. Recipes are built sidecar-side from
 * compile-time constants and a range-validated size, and hashes are hex, so
 * neither field can carry a NUL — the precondition holds by construction and
 * not by convention.
 */
function cacheKey(recipe: string | null, hash: string): string {
  return `${recipe ?? UNVERSIONED}\u0000${hash}`;
}

/**
 * Adopt the recipe the sidecar reported. A change means everything already
 * cached was produced by different semantics, so it is dropped rather than
 * served — including entries from a sidecar that predates cache versioning.
 */
function adoptRecipe(recipe: string | null): void {
  if (activeRecipe === recipe) {
    return;
  }
  // Only bump the generation when there is actually something to invalidate,
  // so the first response of a session does not cancel its own peers.
  if (cache.size > 0) {
    cacheGeneration += 1;
    cache.clear();
    inFlight.clear();
  }
  activeRecipe = recipe;
}

/** Clears the thumbnail cache. Intended for tests. */
export function clearThumbnailCache(): void {
  cacheGeneration += 1;
  cache.clear();
  inFlight.clear();
  activeRecipe = null;
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
  path: string,
  render: () => Promise<
    Pick<RenderThumbnailResponse, 'pngBase64' | 'cacheRecipe'>
  >,
): Promise<string> {
  const requestKey = `${cacheKey(activeRecipe, hash)}\u0000${path}`;
  const pending = inFlight.get(requestKey);
  if (pending) {
    return pending;
  }

  const generation = cacheGeneration;
  const request = scheduleThumbnail(render)
    .then((result) => {
      const src = `data:image/png;base64,${result.pngBase64}`;
      if (generation === cacheGeneration) {
        // Store under the recipe the sidecar actually rendered with, not the
        // one assumed at request time; adopting it first evicts anything cached
        // under a superseded recipe. This result is valid for its own recipe,
        // so it is stored even though adopting may have bumped the generation.
        const recipe = result.cacheRecipe ?? null;
        adoptRecipe(recipe);
        cache.set(cacheKey(recipe, hash), src);
      }
      return src;
    })
    .finally(() => {
      if (inFlight.get(requestKey) === request) {
        inFlight.delete(requestKey);
      }
    });
  inFlight.set(requestKey, request);
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
  const cached = cache.get(cacheKey(activeRecipe, hash)) ?? null;
  const [state, setState] = useState<ThumbnailState>(
    cached
      ? { src: cached, status: 'ready' }
      : { src: null, status: 'loading' },
  );

  useEffect(() => {
    const existing = cache.get(cacheKey(activeRecipe, hash));
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
    requestThumbnail(hash, path, () =>
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
