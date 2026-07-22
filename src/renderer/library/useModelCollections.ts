import { useCallback, useEffect, useState } from 'react';
import type { Collection } from '@shared/ipc';

export interface ModelCollectionsState {
  all: Collection[];
  membership: Set<string>;
  error: string | null;
  toggle: (collectionId: string) => Promise<void>;
  createAndAdd: (name: string) => Promise<void>;
}

/**
 * Loads every collection plus the membership of one model (by hash), and
 * mutates membership through the sidecar. Collections are catalog data, so all
 * mutations round-trip and the authoritative results replace local state.
 */
export function useModelCollections(
  hash: string | null,
): ModelCollectionsState {
  const [all, setAll] = useState<Collection[]>([]);
  const [membership, setMembership] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (target: string) => {
    setError(null);
    try {
      const [collections, mine] = await Promise.all([
        window.printFarmer.listCollections(),
        window.printFarmer.collectionsForModel({ hash: target }),
      ]);
      setAll(collections);
      setMembership(new Set(mine.map((c) => c.id)));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!hash) {
      setAll([]);
      setMembership(new Set());
      return;
    }
    void load(hash);
  }, [hash, load]);

  const toggle = useCallback(
    async (collectionId: string) => {
      if (!hash) {
        return;
      }
      setError(null);
      try {
        const request = { collectionId, hash };
        const mine = membership.has(collectionId)
          ? await window.printFarmer.removeModelFromCollection(request)
          : await window.printFarmer.addModelToCollection(request);
        setMembership(new Set(mine.map((c) => c.id)));
        setAll(await window.printFarmer.listCollections());
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [hash, membership],
  );

  const createAndAdd = useCallback(
    async (name: string) => {
      if (!hash || name.trim().length === 0) {
        return;
      }
      setError(null);
      try {
        const created = await window.printFarmer.createCollection({ name });
        await window.printFarmer.addModelToCollection({
          collectionId: created.id,
          hash,
        });
        await load(hash);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [hash, load],
  );

  return { all, membership, error, toggle, createAndAdd };
}
