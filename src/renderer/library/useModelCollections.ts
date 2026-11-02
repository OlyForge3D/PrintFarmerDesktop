import { useCallback, useEffect, useRef, useState } from 'react';
import type { Collection } from '@shared/ipc';

export interface ModelCollectionsState {
  all: Collection[];
  membership: Set<string>;
  error: string | null;
  refresh: () => Promise<void>;
  toggle: (collectionId: string) => Promise<void>;
  createAndAdd: (name: string) => Promise<void>;
}

interface CollectionsSnapshot {
  all: Collection[];
  mine: Collection[];
}

/**
 * Loads every collection plus the membership of one model (by hash), and
 * mutates membership through the sidecar. Collections are catalog data, so all
 * mutations round-trip and the authoritative results replace local state.
 * Only the newest request may publish, so a slow older read can never restore
 * collections that a later read (for example after a deletion) removed.
 */
export function useModelCollections(
  hash: string | null,
): ModelCollectionsState {
  const [all, setAll] = useState<Collection[]>([]);
  const [membership, setMembership] = useState<Set<string>>(new Set());
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
    async (target: string, action: () => Promise<CollectionsSnapshot>) => {
      const generation = ++generationRef.current;
      const isCurrent = (): boolean =>
        generation === generationRef.current &&
        activeHashRef.current === target;
      setError(null);
      try {
        const next = await action();
        if (isCurrent()) {
          setAll(next.all);
          setMembership(new Set(next.mine.map((c) => c.id)));
        }
      } catch (err: unknown) {
        if (isCurrent()) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    },
    [],
  );

  const read = useCallback(async (target: string) => {
    const [collections, mine] = await Promise.all([
      window.printFarmer.listCollections(),
      window.printFarmer.collectionsForModel({ hash: target }),
    ]);
    return { all: collections, mine };
  }, []);

  const refresh = useCallback(async () => {
    if (!hash) {
      generationRef.current += 1;
      setAll([]);
      setMembership(new Set());
      return;
    }
    await request(hash, () => read(hash));
  }, [hash, read, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (collectionId: string) => {
      if (!hash) {
        return;
      }
      await request(hash, async () => {
        const change = { collectionId, hash };
        const mine = membership.has(collectionId)
          ? await window.printFarmer.removeModelFromCollection(change)
          : await window.printFarmer.addModelToCollection(change);
        return { all: await window.printFarmer.listCollections(), mine };
      });
    },
    [hash, membership, request],
  );

  const createAndAdd = useCallback(
    async (name: string) => {
      if (!hash || name.trim().length === 0) {
        return;
      }
      await request(hash, async () => {
        const created = await window.printFarmer.createCollection({ name });
        await window.printFarmer.addModelToCollection({
          collectionId: created.id,
          hash,
        });
        return read(hash);
      });
    },
    [hash, read, request],
  );

  return { all, membership, error, refresh, toggle, createAndAdd };
}
