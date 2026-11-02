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
 * sidecar and the returned authoritative list replaces local state. Only the
 * newest request may publish its result, so a slow older read can never
 * restore tags that a later read (for example after a deletion) removed.
 */
export function useModelTags(hash: string | null): ModelTagsState {
  const [tags, setTags] = useState<Tag[]>([]);
  const [error, setError] = useState<string | null>(null);
  const activeHashRef = useRef(hash);
  activeHashRef.current = hash;
  const generationRef = useRef(0);

  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  const request = useCallback(
    async (target: string, action: () => Promise<Tag[]>) => {
      const generation = ++generationRef.current;
      const isCurrent = (): boolean =>
        generation === generationRef.current &&
        activeHashRef.current === target;
      setError(null);
      try {
        const next = await action();
        if (isCurrent()) setTags(next);
      } catch (err: unknown) {
        if (isCurrent()) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!hash) {
      generationRef.current += 1;
      setTags([]);
      return;
    }
    await request(hash, () => window.printFarmer.tagsForModel({ hash }));
  }, [hash, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(
    async (name: string) => {
      if (!hash || name.trim().length === 0) {
        return;
      }
      await request(hash, () => window.printFarmer.addModelTag({ hash, name }));
    },
    [hash, request],
  );

  const remove = useCallback(
    async (tagId: string) => {
      if (!hash) {
        return;
      }
      await request(hash, () =>
        window.printFarmer.removeModelTag({ hash, tagId }),
      );
    },
    [hash, request],
  );

  return { tags, error, refresh, add, remove };
}
