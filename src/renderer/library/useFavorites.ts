import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'printfarmer.favorites.v1';

function readStored(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((value): value is string => typeof value === 'string'));
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
  toggle: (hash: string) => Promise<void>;
}

/**
 * Favorites live in the catalog when the bridge exposes the catalog-backed IPC.
 * For older binaries and isolated renderer tests, fall back to localStorage so
 * the UI remains usable without direct Node access.
 */
export function useFavorites(): FavoritesState {
  const [favorites, setFavorites] = useState<Set<string>>(() => readStored());

  useEffect(() => {
    if (typeof window.printFarmer.listFavorites !== 'function') {
      return;
    }
    let cancelled = false;
    void window.printFarmer
      .listFavorites()
      .then((hashes) => {
        if (cancelled) {
          return;
        }
        const next = new Set(hashes);
        setFavorites(next);
        writeStored(next);
      })
      .catch(() => {
        // Keep the fallback state when the catalog is temporarily unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback(async (hash: string) => {
    if (
      typeof window.printFarmer.addFavorite === 'function' &&
      typeof window.printFarmer.removeFavorite === 'function'
    ) {
      const next = favorites.has(hash)
        ? await window.printFarmer.removeFavorite({ hash })
        : await window.printFarmer.addFavorite({ hash });
      const set = new Set(next);
      setFavorites(set);
      writeStored(set);
      return;
    }
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
  }, [favorites]);

  const isFavorite = useCallback(
    (hash: string) => favorites.has(hash),
    [favorites],
  );

  return useMemo(
    () => ({ favorites, isFavorite, toggle }),
    [favorites, isFavorite, toggle],
  );
}
