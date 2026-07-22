import { useCallback, useMemo, useState } from 'react';

const STORAGE_KEY = 'printfarmer.favorites.v1';

function readStored(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === 'string'));
    }
  } catch {
    // Corrupt or unavailable storage falls back to an empty set.
  }
  return new Set();
}

function writeStored(hashes: Set<string>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...hashes]));
  } catch {
    // Persistence is best-effort; ignore quota/availability errors.
  }
}

export interface FavoritesState {
  favorites: ReadonlySet<string>;
  isFavorite: (hash: string) => boolean;
  toggle: (hash: string) => void;
}

/**
 * Client-persisted favorite models, keyed by content hash so a favorite
 * follows the model across renames, moves, and roots. Stored in localStorage
 * because favorites are presentation state, not catalog data.
 */
export function useFavorites(): FavoritesState {
  const [favorites, setFavorites] = useState<Set<string>>(() => readStored());

  const toggle = useCallback((hash: string) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      writeStored(next);
      return next;
    });
  }, []);

  const isFavorite = useCallback(
    (hash: string) => favorites.has(hash),
    [favorites],
  );

  return useMemo(
    () => ({ favorites, isFavorite, toggle }),
    [favorites, isFavorite, toggle],
  );
}
