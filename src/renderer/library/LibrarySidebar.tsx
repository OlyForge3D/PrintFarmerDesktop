import type {
  ImportRootResponse,
  ReconcileReport,
  ServerProfile,
} from '@shared/ipc';
import type { FilterKey } from './filter';
import {
  reconcileDetails,
  reconcileHeadline,
  type SourceRootSummary,
} from './sourceRoots';
import type { LibraryScanActivity } from './useLibrary';
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
  lastReport: ReconcileReport | null;
  lastImport: ImportRootResponse | null;
  busy: boolean;
  sourceRoots: SourceRootSummary[];
  scanActivity: LibraryScanActivity;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: FilterKey) => void;
  onAddFolder: () => void;
  onRefresh: () => void;
  onRescanRoot: (rootId: string) => void;
  onRemoveRoot: (rootId: string) => void;
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
  lastReport,
  lastImport,
  busy,
  sourceRoots,
  scanActivity,
  onQueryChange,
  onFilterChange,
  onAddFolder,
  onRefresh,
  onRescanRoot,
  onRemoveRoot,
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
          className="sidebar-secondary-action"
          onClick={onRefresh}
          disabled={busy}
        >
          <Icon name="refresh" />
          <span>Refresh catalog</span>
        </button>
        <SidebarStatus
          scanningFolder={scanningFolder}
          lastReport={lastReport}
          lastImport={lastImport}
          scanActivity={scanActivity}
        />
        <SourceRootList
          roots={sourceRoots}
          busy={busy}
          onRescanRoot={onRescanRoot}
          onRemoveRoot={onRemoveRoot}
        />
      </div>
      <div className="sidebar-server">
        <p className="sidebar-section-label">PrintFarmer server</p>
        <button
          type="button"
          className="server-profile-entry"
          disabled={serverProfilesDisabled}
          onClick={onManageServerProfiles}
        >
          <span
            className={`server-status-dot ${serverProfile?.status ?? 'none'}`}
            aria-hidden="true"
          />
          <span>
            <strong>{serverProfile?.displayName ?? 'Not connected'}</strong>
            <small>
              {serverProfile
                ? (serverProfile.version?.version ?? 'Legacy server')
                : 'Manage profiles'}
            </small>
            <small
              className={`server-accessible-status ${serverProfile?.status ?? 'none'}`}
            >
              Status:{' '}
              {serverProfile
                ? serverProfile.status === 'error'
                  ? 'Connection error'
                  : serverProfile.status === 'legacy'
                    ? 'Legacy fallback'
                    : 'Connected'
                : 'Disconnected'}
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

function SidebarStatus({
  scanningFolder,
  lastReport,
  lastImport,
  scanActivity,
}: Pick<
  LibrarySidebarProps,
  'scanningFolder' | 'lastReport' | 'lastImport' | 'scanActivity'
>): React.JSX.Element {
  const report = lastImport?.report ?? lastReport;
  if (scanActivity.phase !== 'idle') {
    return (
      <div
        className="sidebar-status sidebar-progress"
        role="status"
        aria-live="polite"
      >
        <div className="sidebar-progress-header">
          <strong>
            {scanActivity.phase === 'preparing'
              ? 'Preparing source'
              : 'Scanning library'}
          </strong>
          <span>
            {scanActivity.estimatedTotal !== null
              ? `${scanActivity.estimatedTotal} known models`
              : 'Estimated progress'}
          </span>
        </div>
        <progress aria-label="Scan progress" />
        <p>
          {scanActivity.label ??
            `Scanning ${scanningFolder ?? 'selected folder'}`}
        </p>
      </div>
    );
  }
  if (lastImport) {
    return (
      <div className="sidebar-status" role="status" aria-live="polite">
        <strong>Last import</strong>
        <span>
          {lastImport.modelsOrganized} organized • {lastImport.report.added}{' '}
          added
        </span>
      </div>
    );
  }
  return (
    <div className="sidebar-status" role="status" aria-live="polite">
      <strong>{reconcileHeadline(report)}</strong>
      <span>
        {reconcileDetails(report) ?? 'Catalog is local to this computer.'}
      </span>
    </div>
  );
}

function SourceRootList({
  roots,
  busy,
  onRescanRoot,
  onRemoveRoot,
}: Pick<LibrarySidebarProps, 'busy' | 'onRescanRoot' | 'onRemoveRoot'> & {
  roots: SourceRootSummary[];
}): React.JSX.Element {
  if (roots.length === 0) {
    return (
      <p className="sidebar-root-empty">
        No source folders yet. Add one to start indexing STL, 3MF, and OBJ
        files.
      </p>
    );
  }

  return (
    <>
      <ul className="source-root-list" aria-label="Source roots">
        {roots.map((root) => (
          <li key={root.rootId} className={`source-root-item ${root.status}`}>
            <div className="source-root-summary">
              <span
                className={`source-root-dot ${root.status}`}
                aria-hidden="true"
              />
              <div>
                <strong>{root.label}</strong>
                <span className="source-root-state">
                  {sourceRootStateLabel(root)}
                </span>
                <small title={root.path}>{root.path}</small>
                <small>{sourceRootDetail(root)}</small>
              </div>
            </div>
            <div className="source-root-actions">
              <button
                type="button"
                className="source-root-action"
                disabled={busy}
                onClick={() => onRescanRoot(root.rootId)}
              >
                {root.status === 'available' ? 'Scan again' : 'Reconnect'}
              </button>
              <button
                type="button"
                className="source-root-action ghost"
                disabled={busy}
                aria-label={`Remove ${root.label}`}
                onClick={() => onRemoveRoot(root.rootId)}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="sidebar-root-footnote">
        Source availability is estimated from indexed file paths until the
        sidecar exposes root-level health and delete APIs.
      </p>
    </>
  );
}

function sourceRootStateLabel(root: SourceRootSummary): string {
  switch (root.status) {
    case 'available':
      return 'Available';
    case 'missing':
      return 'Missing files';
    case 'offline':
      return 'Needs scan';
    default:
      return 'Unknown';
  }
}

function sourceRootDetail(root: SourceRootSummary): string {
  if (root.status === 'missing' && root.missingLocations > 0) {
    return `${root.missingLocations} unavailable file locations`;
  }
  if (root.totalModels > 0) {
    return `${root.availableModels} of ${root.totalModels} models available`;
  }
  return root.lastReport ? reconcileHeadline(root.lastReport) : 'Ready to scan';
}
