import type { ServerProfile } from '@shared/ipc';
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

export function serverStatusLabel(profile: ServerProfile | null): string {
  if (!profile) return 'Disconnected';
  if (profile.status === 'error') return 'Connection error';
  if (profile.status === 'legacy') return 'Legacy fallback';
  return 'Connected';
}

function serverProfileVersionLabel(profile: ServerProfile | null): string {
  if (!profile) return 'No server selected yet';
  return profile.version?.version ?? 'Legacy server';
}

function serverProfileAccessibleLabel(profile: ServerProfile | null): string {
  const actionLabel = profile ? 'Manage connection' : 'Connect to PrintFarmer';
  const detailLabels = profile
    ? [
        profile.displayName,
        serverProfileVersionLabel(profile),
        `Status: ${serverStatusLabel(profile)}`,
      ]
    : [
        serverProfileVersionLabel(profile),
        `Status: ${serverStatusLabel(profile)}`,
      ];
  return `${actionLabel}: ${detailLabels.join(', ')}`;
}

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
  onManageSources: () => void;
  serverProfile: ServerProfile | null;
  serverProfilesDisabled: boolean;
  onManageServerProfiles: () => void;
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
  onManageSources,
  serverProfile,
  serverProfilesDisabled,
  onManageServerProfiles,
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
        <button
          type="button"
          className="sidebar-secondary-action manage-catalog-sources"
          onClick={onManageSources}
          disabled={busy}
        >
          <Icon name="collection" />
          <span>Manage sources</span>
        </button>
      </div>
      <div className="sidebar-server">
        <p className="sidebar-section-label">PrintFarmer server</p>
        <button
          type="button"
          className={
            serverProfile
              ? 'server-profile-entry'
              : 'server-profile-entry server-profile-entry--cta'
          }
          disabled={serverProfilesDisabled}
          aria-label={serverProfileAccessibleLabel(serverProfile)}
          onClick={onManageServerProfiles}
        >
          <span
            className={`server-status-dot ${serverProfile?.status ?? 'none'}`}
            aria-hidden="true"
          />
          <span aria-hidden="true">
            <strong className={serverProfile ? undefined : 'server-cta-label'}>
              {serverProfile?.displayName ?? 'Connect to PrintFarmer'}
            </strong>
            <small>{serverProfileVersionLabel(serverProfile)}</small>
            <small
              className={`server-accessible-status ${serverProfile?.status ?? 'none'}`}
            >
              Status: {serverStatusLabel(serverProfile)}
            </small>
          </span>
        </button>
        {serverProfile?.warnings.includes('insecureHttp') ? (
          <p className="sidebar-transport-warning">
            HTTP connection is not encrypted
          </p>
        ) : null}
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
      : `${availableCount} available · ${attentionCount} need attention`;
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
