import type { FilterKey } from './filter';
import type { SourceRootSummary } from './sourceRoots';
import { Icon, type IconName } from '../ui/Icon';

export const FILTER_LABELS: Record<FilterKey, string> = {
  all: 'All models',
  favorites: 'Favorites',
  stl: 'STL',
  threeMf: '3MF',
  obj: 'OBJ',
  duplicates: 'Duplicates',
  missing: 'Missing files',
};

export type LibraryCounts = Record<FilterKey, number>;

export interface LibrarySidebarProps {
  query: string;
  filter: FilterKey;
  counts: LibraryCounts;
  scanningFolder: string | null;
  busy: boolean;
  sourceRoots: SourceRootSummary[];
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: FilterKey) => void;
  onAddFolder: () => void;
}

interface NavigationItem {
  filter: FilterKey;
  icon: IconName;
}

const LIBRARY_ITEMS: NavigationItem[] = [
  { filter: 'all', icon: 'collection' },
  { filter: 'favorites', icon: 'star' },
];

const CATEGORY_ITEMS: NavigationItem[] = [
  { filter: 'stl', icon: 'cube' },
  { filter: 'threeMf', icon: 'cube' },
  { filter: 'obj', icon: 'cube' },
];

const REVIEW_ITEMS: NavigationItem[] = [
  { filter: 'duplicates', icon: 'duplicate' },
  { filter: 'missing', icon: 'missing' },
];

export function LibrarySidebar({
  query,
  filter,
  counts,
  scanningFolder,
  busy,
  sourceRoots,
  onQueryChange,
  onFilterChange,
  onAddFolder,
}: LibrarySidebarProps): React.JSX.Element {
  return (
    <aside className="library-sidebar" aria-label="Library navigation">
      <div className="sidebar-search">
        <Icon name="search" />
        <input
          type="search"
          value={query}
          aria-label="Search models"
          placeholder="Search library"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear search"
            onClick={() => onQueryChange('')}
          >
            x
          </button>
        ) : null}
      </div>

      <nav className="sidebar-navigation" aria-label="Model scopes">
        <NavigationSection
          label="Library"
          items={LIBRARY_ITEMS}
          active={filter}
          counts={counts}
          onChange={onFilterChange}
        />
        <NavigationSection
          label="Categories"
          items={CATEGORY_ITEMS}
          active={filter}
          counts={counts}
          onChange={onFilterChange}
        />
        <NavigationSection
          label="Review"
          items={REVIEW_ITEMS}
          active={filter}
          counts={counts}
          onChange={onFilterChange}
        />
      </nav>

      <div className="sidebar-sources">
        <p className="sidebar-section-label">Sources</p>
        <SourceHealth roots={sourceRoots} scanningFolder={scanningFolder} />
        <button
          type="button"
          className="sidebar-primary-action"
          onClick={onAddFolder}
          disabled={busy}
        >
          <Icon name="folder" />
          <span>{scanningFolder ? 'Scanning...' : 'Add folder'}</span>
        </button>
      </div>
    </aside>
  );
}

interface NavigationSectionProps {
  label: string;
  items: NavigationItem[];
  active: FilterKey;
  counts: LibraryCounts;
  onChange: (filter: FilterKey) => void;
}

function NavigationSection({
  label,
  items,
  active,
  counts,
  onChange,
}: NavigationSectionProps): React.JSX.Element {
  return (
    <section className="sidebar-section" aria-label={label}>
      <h2 className="sidebar-section-label">{label}</h2>
      <ul className="sidebar-nav-list">
        {items.map((item) => (
          <li key={item.filter}>
            <button
              type="button"
              className={
                active === item.filter
                  ? 'sidebar-nav-item active'
                  : 'sidebar-nav-item'
              }
              aria-current={active === item.filter ? 'page' : undefined}
              onClick={() => onChange(item.filter)}
            >
              <Icon name={item.icon} />
              <span>{FILTER_LABELS[item.filter]}</span>
              <span className="sidebar-count">{counts[item.filter]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceHealth({
  roots,
  scanningFolder,
}: {
  roots: SourceRootSummary[];
  scanningFolder: string | null;
}): React.JSX.Element {
  const attentionCount = roots.filter(
    (root) => root.status !== 'available',
  ).length;
  const availableCount = roots.length - attentionCount;
  const headline = scanningFolder
    ? `Scanning ${scanningFolder}`
    : roots.length === 0
      ? 'No source folders'
      : attentionCount > 0
        ? `${attentionCount} ${attentionCount === 1 ? 'source needs' : 'sources need'} attention`
        : `${roots.length} ${roots.length === 1 ? 'source' : 'sources'} healthy`;
  const detail =
    roots.length === 0
      ? 'Add a folder to index local model files.'
      : `${availableCount} available · ${attentionCount} ${attentionCount === 1 ? 'needs' : 'need'} attention`;
  return (
    <div className="sidebar-source-health" role="status" aria-live="polite">
      <span
        className={`source-root-dot ${
          attentionCount > 0 ? 'missing' : roots.length > 0 ? 'available' : ''
        }`}
        aria-hidden="true"
      />
      <span>
        <strong>{headline}</strong>
        <small>{detail}</small>
      </span>
    </div>
  );
}
