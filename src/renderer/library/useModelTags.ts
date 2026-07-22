import { useCallback, useEffect, useState } from 'react';
import type { Tag } from '@shared/ipc';

export interface ModelTagsState {
  tags: Tag[];
  error: string | null;
  add: (name: string) => Promise<void>;
  remove: (tagId: string) => Promise<void>;
}

/**
 * Loads and mutates the tags assigned to one model (by content hash) through
 * the sidecar. Tags are catalog data, so every mutation round-trips to the
 * sidecar and the returned authoritative list replaces local state.
 */
export function useModelTags(hash: string | null): ModelTagsState {
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hash) {
      setTags([]);
      return;
    }
    let cancelled = false;
    setError(null);
    window.printFarmer
      .tagsForModel({ hash })
      .then((next) => {
        if (!cancelled) {
          setTags(next);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hash]);

  const add = useCallback(
    async (name: string) => {
      if (!hash || name.trim().length === 0) {
        return;
      }
      setError(null);
      try {
        setTags(await window.printFarmer.addModelTag({ hash, name }));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [hash],
  );

  const remove = useCallback(
    async (tagId: string) => {
      if (!hash) {
        return;
      }
      setError(null);
      try {
        setTags(await window.printFarmer.removeModelTag({ hash, tagId }));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [hash],
  );

  return { tags, error, add, remove };
}
