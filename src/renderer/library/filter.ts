import type { LogicalModel } from '@shared/ipc';
import { isAvailable, modelDisplayName } from './model';

export type SortKey =
  | 'name-asc'
  | 'name-desc'
  | 'size-asc'
  | 'size-desc'
  | 'date-asc'
  | 'date-desc';
export type FilterKey =
  'all' | 'favorites' | 'stl' | 'threeMf' | 'obj' | 'duplicates' | 'missing';

export interface LibraryView {
  query: string;
  filter: FilterKey;
  sort: SortKey;
  /** Content hashes the user has favorited; only used by the favorites filter. */
  favorites?: ReadonlySet<string>;
}

export const defaultLibraryView: LibraryView = {
  query: '',
  filter: 'all',
  sort: 'name-asc',
};

function latestModifiedUnixSeconds(model: LogicalModel): number | null {
  let latest: number | null = null;
  for (const location of model.locations) {
    const modified = location.modifiedUnixSeconds;
    if (
      typeof modified === 'number' &&
      (latest === null || modified > latest)
    ) {
      latest = modified;
    }
  }
  return latest;
}

function compareNames(a: LogicalModel, b: LogicalModel): number {
  return modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, {
    sensitivity: 'base',
    numeric: true,
  });
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  direction: 'asc' | 'desc',
): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return direction === 'asc' ? left - right : right - left;
}

function matchesFilter(
  model: LogicalModel,
  filter: FilterKey,
  favorites: ReadonlySet<string> | undefined,
): boolean {
  switch (filter) {
    case 'favorites':
      return favorites?.has(model.hash) ?? false;
    case 'duplicates':
      // Same content present at more than one path.
      return model.locations.length > 1;
    case 'missing':
      return !isAvailable(model);
    case 'stl':
    case 'threeMf':
    case 'obj':
      return model.format === filter;
    case 'all':
    default:
      return true;
  }
}

/**
 * Applies the current search query, filter, and sort to the catalog. Pure and
 * side-effect free so it can be memoized and unit-tested in isolation.
 */
export function selectLibraryView(
  models: LogicalModel[],
  view: LibraryView,
): LogicalModel[] {
  const needle = view.query.trim().toLowerCase();

  const filtered = models.filter((model) => {
    if (!matchesFilter(model, view.filter, view.favorites)) {
      return false;
    }
    if (needle.length === 0) {
      return true;
    }
    if (
      modelDisplayName(model).toLowerCase().includes(needle) ||
      model.format.toLowerCase().includes(needle)
    ) {
      return true;
    }
    return model.locations.some(
      (location) =>
        location.path.toLowerCase().includes(needle) ||
        location.rootRelative.toLowerCase().includes(needle),
    );
  });

  const sorted = [...filtered];
  sorted.sort((a, b) => {
    switch (view.sort) {
      case 'name-desc':
        return compareNames(b, a);
      case 'size-asc':
        return a.size - b.size || compareNames(a, b);
      case 'size-desc':
        return b.size - a.size || compareNames(a, b);
      case 'date-asc':
        return (
          compareNullableNumbers(
            latestModifiedUnixSeconds(a),
            latestModifiedUnixSeconds(b),
            'asc',
          ) || compareNames(a, b)
        );
      case 'date-desc':
        return (
          compareNullableNumbers(
            latestModifiedUnixSeconds(a),
            latestModifiedUnixSeconds(b),
            'desc',
          ) || compareNames(a, b)
        );
      case 'name-asc':
      default:
        return compareNames(a, b);
    }
  });
  return sorted;
}
