import { useCallback, useEffect, useRef, useState } from 'react';
import type { Tag } from '@shared/ipc';

export interface ModelTagsState {
  tags: Tag[];
  error: string | null;
  refresh: () => Promise<void>;
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
  const activeHashRef = useRef(hash);
  activeHashRef.current = hash;

  const refresh = useCallback(async () => {
    if (!hash) {
      setTags([]);
      return;
    }
    setError(null);
    try {
      const next = await window.printFarmer.tagsForModel({ hash });
      if (activeHashRef.current === hash) {
        setTags(next);
      }
    } catch (err: unknown) {
      if (activeHashRef.current === hash) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [hash]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  return { tags, error, refresh, add, remove };
}
