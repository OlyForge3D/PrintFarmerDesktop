import type { LogicalModel, ModelLocation, ReconcileReport } from '@shared/ipc';
import { basename } from './model';

const STORAGE_KEY = 'printfarmer.library.sourceRoots.v1';

export type SourceRootStatus = 'available' | 'offline' | 'missing';

export interface StoredSourceRoot {
  rootId: string;
  path: string;
  removed?: boolean;
  lastReport?: ReconcileReport | null;
  lastScannedAt?: string | null;
}

export interface SourceRootSummary {
  rootId: string;
  path: string;
  label: string;
  status: SourceRootStatus;
  totalModels: number;
  availableModels: number;
  missingLocations: number;
  lastReport: ReconcileReport | null;
  lastScannedAt: string | null;
  usesAvailabilityApproximation: boolean;
}

interface DerivedSourceRoot {
  rootId: string;
  path: string | null;
  totalModels: number;
  availableModels: number;
  availableLocations: number;
  missingLocations: number;
}

interface StoredSourceRootPayload {
  version: 1;
  roots: StoredSourceRoot[];
}

export function loadStoredSourceRoots(): StoredSourceRoot[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredSourceRootPayload;
    return Array.isArray(parsed.roots)
      ? parsed.roots.filter(
          (root): root is StoredSourceRoot =>
            Boolean(root) &&
            typeof root.rootId === 'string' &&
            root.rootId.length > 0 &&
            typeof root.path === 'string' &&
            root.path.length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

export function saveStoredSourceRoots(roots: StoredSourceRoot[]): void {
  try {
    globalThis.localStorage?.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        roots,
      } satisfies StoredSourceRootPayload),
    );
  } catch {
    // Best-effort renderer preferences only.
  }
}

export function upsertStoredSourceRoot(
  roots: StoredSourceRoot[],
  incoming: StoredSourceRoot,
): StoredSourceRoot[] {
  const next = roots.filter((root) => root.rootId !== incoming.rootId);
  next.push({
    ...incoming,
    removed: incoming.removed ?? false,
    lastReport: incoming.lastReport ?? null,
    lastScannedAt: incoming.lastScannedAt ?? null,
  });
  return next.sort((left, right) => left.path.localeCompare(right.path));
}

export function removeStoredSourceRoot(
  roots: StoredSourceRoot[],
  rootId: string,
): StoredSourceRoot[] {
  return roots.map((root) =>
    root.rootId === rootId ? { ...root, removed: true } : root,
  );
}

export function filterModelsByRemovedRoots(
  models: LogicalModel[],
  removedRootIds: ReadonlySet<string>,
): LogicalModel[] {
  if (removedRootIds.size === 0) {
    return models;
  }
  return models.flatMap((model) => {
    const locations = model.locations.filter(
      (location) => !removedRootIds.has(location.rootId),
    );
    return locations.length > 0 ? [{ ...model, locations }] : [];
  });
}

export function summarizeSourceRoots(
  models: LogicalModel[],
  storedRoots: StoredSourceRoot[],
): SourceRootSummary[] {
  const derivedRoots = deriveSourceRoots(models);
  const storedById = new Map(
    storedRoots.map((root) => [
      root.rootId,
      root.path ? root : { ...root, path: root.rootId },
    ]),
  );
  for (const derived of derivedRoots.values()) {
    const stored = storedById.get(derived.rootId);
    if (!stored) {
      storedById.set(derived.rootId, {
        rootId: derived.rootId,
        path: derived.path ?? derived.rootId,
      });
      continue;
    }
    if (derived.path && stored.path !== derived.path) {
      storedById.set(derived.rootId, { ...stored, path: derived.path });
    }
  }

  return [...storedById.values()]
    .filter((root) => !root.removed)
    .map((root) => {
      const derived = derivedRoots.get(root.rootId);
      const path = derived?.path ?? root.path;
      const status: SourceRootStatus =
        (derived?.availableLocations ?? 0) > 0
          ? 'available'
          : (derived?.missingLocations ?? 0) > 0
            ? 'missing'
            : 'offline';

      return {
        rootId: root.rootId,
        path,
        label: basename(path) || path,
        status,
        totalModels: derived?.totalModels ?? 0,
        availableModels: derived?.availableModels ?? 0,
        missingLocations: derived?.missingLocations ?? 0,
        lastReport: root.lastReport ?? null,
        lastScannedAt: root.lastScannedAt ?? null,
        // The current IPC contract only exposes per-file availability, not a
        // root-level health/status signal, so root availability is inferred.
        usesAvailabilityApproximation: true,
      };
    })
    .sort((left, right) => {
      const weight = statusWeight(left.status) - statusWeight(right.status);
      return weight !== 0 ? weight : left.path.localeCompare(right.path);
    });
}

export function reconcileHeadline(report: ReconcileReport | null): string {
  if (!report) {
    return 'Catalog is local to this computer.';
  }
  if (report.missing > 0) {
    return `${report.missing} missing ${pluralize('file', report.missing)}`;
  }
  if (report.added > 0 || report.changed > 0) {
    return 'Library updated';
  }
  return 'Library is up to date';
}

export function reconcileDetails(
  report: ReconcileReport | null,
): string | null {
  if (!report) {
    return null;
  }
  return `${report.added} added • ${report.changed} changed • ${report.missing} missing`;
}

function deriveSourceRoots(
  models: LogicalModel[],
): Map<string, DerivedSourceRoot> {
  const roots = new Map<string, DerivedSourceRoot>();
  for (const model of models) {
    const perRoot = new Map<
      string,
      { available: boolean; path: string | null; missingLocations: number }
    >();
    for (const location of model.locations) {
      const path = rootPathFromLocation(location);
      const current = perRoot.get(location.rootId);
      perRoot.set(location.rootId, {
        available: (current?.available ?? false) || location.available,
        path: current?.path ?? path,
        missingLocations:
          (current?.missingLocations ?? 0) + (location.available ? 0 : 1),
      });
    }
    for (const [rootId, state] of perRoot) {
      const root = roots.get(rootId) ?? {
        rootId,
        path: state.path,
        totalModels: 0,
        availableModels: 0,
        availableLocations: 0,
        missingLocations: 0,
      };
      root.totalModels += 1;
      if (state.available) {
        root.availableModels += 1;
        root.availableLocations += 1;
      }
      root.missingLocations += state.missingLocations;
      if (!root.path && state.path) {
        root.path = state.path;
      }
      roots.set(rootId, root);
    }
  }
  return roots;
}

function rootPathFromLocation(location: ModelLocation): string | null {
  const trimmedPath = trimSeparators(location.path);
  const trimmedRelative = trimSeparators(location.rootRelative);
  if (!trimmedRelative) {
    return dirname(trimmedPath);
  }
  const normalizedPath = normalize(trimmedPath);
  const normalizedRelative = normalize(trimmedRelative);
  if (
    !normalizedPath.toLowerCase().endsWith(normalizedRelative.toLowerCase())
  ) {
    return dirname(trimmedPath);
  }
  const root = normalizedPath.slice(
    0,
    normalizedPath.length - normalizedRelative.length,
  );
  const normalizedRoot = root.replace(/\/$/, '');
  if (!normalizedRoot) {
    return dirname(trimmedPath);
  }
  return location.path.includes('\\')
    ? normalizedRoot.replace(/\//g, '\\')
    : normalizedRoot;
}

function dirname(path: string): string {
  const trimmed = trimSeparators(path);
  const withoutLeaf = trimmed.replace(/[\\/][^\\/]*$/, '');
  return withoutLeaf || trimmed;
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/');
}

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function pluralize(label: string, count: number): string {
  return count === 1 ? label : `${label}s`;
}

function statusWeight(status: SourceRootStatus): number {
  switch (status) {
    case 'missing':
      return 0;
    case 'offline':
      return 1;
    case 'available':
      return 2;
    default:
      return 3;
  }
}
