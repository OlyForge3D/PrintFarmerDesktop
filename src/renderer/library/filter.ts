import type { LogicalModel } from '@shared/ipc';
import { isAvailable, modelDisplayName } from './model';

export type SortKey = 'name' | 'size';
export type FilterKey = 'all' | 'favorites' | 'duplicates' | 'missing';

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
  sort: 'name',
};

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
    return modelDisplayName(model).toLowerCase().includes(needle);
  });

  const sorted = [...filtered];
  if (view.sort === 'size') {
    sorted.sort((a, b) => b.size - a.size);
  } else {
    sorted.sort((a, b) =>
      modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, {
        sensitivity: 'base',
        numeric: true,
      }),
    );
  }
  return sorted;
}
