import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Collection, Tag } from '@shared/ipc';
import type { FilterKey } from './filter';
import type { SourceRootSummary } from './sourceRoots';
import { Icon, type IconName } from '../ui/Icon';

export const FILTER_LABELS: Record<FilterKey, string> = {
  all: 'All models',
  favorites: 'Favorites',
  stl: 'STL',
  threeMf: '3MF',
  obj: 'OBJ',
  step: 'STEP',
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
  collections?: Collection[];
  selectedCollections?: readonly string[];
  onCollectionsChange?: (ids: string[]) => void;
  tags?: Tag[];
  selectedTags?: readonly string[];
  onTagsChange?: (ids: string[]) => void;
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
  { filter: 'step', icon: 'cube' },
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
  collections = [],
  selectedCollections = [],
  onCollectionsChange,
  tags = [],
  selectedTags = [],
  onTagsChange,
}: LibrarySidebarProps): React.JSX.Element {
  const [prefs, setPrefs] = useState<SidebarPreferences>(
    loadSidebarPreferences,
  );
  const updatePrefs = useCallback(
    (change: (current: SidebarPreferences) => SidebarPreferences) => {
      setPrefs((current) => {
        const next = change(current);
        saveSidebarPreferences(next);
        return next;
      });
    },
    [],
  );
  const setExpanded = (key: 'collections' | 'tags', open: boolean): void =>
    updatePrefs((current) => ({
      ...current,
      expanded: { ...current.expanded, [key]: open },
    }));

  return (
    <SidebarResizer
      width={prefs.width}
      onCommit={(width) => updatePrefs((current) => ({ ...current, width }))}
    >
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

        {onCollectionsChange ? (
          <OrganizationFilter
            label="Collections"
            items={collections.map((collection) => ({
              ...collection,
              count: collection.memberCount,
            }))}
            selected={selectedCollections}
            onChange={onCollectionsChange}
            expanded={prefs.expanded.collections}
            onExpandedChange={(open) => setExpanded('collections', open)}
          />
        ) : null}
        {onTagsChange ? (
          <OrganizationFilter
            label="Tags"
            items={tags}
            selected={selectedTags}
            onChange={onTagsChange}
            expanded={prefs.expanded.tags}
            onExpandedChange={(open) => setExpanded('tags', open)}
          />
        ) : null}
        {onTagsChange && onCollectionsChange ? (
          <p className="organization-filter-note">
            Tag and collection scopes are combined.
          </p>
        ) : null}

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
    </SidebarResizer>
  );
}

function OrganizationFilter({
  label,
  items,
  selected,
  onChange,
  expanded,
  onExpandedChange,
}: {
  label: 'Tags' | 'Collections';
  items: Array<{ id: string; name: string; count?: number }>;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const bodyId = useId();
  const noun = label === 'Tags' ? 'tag' : 'collection';
  const matching = items.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()),
  );
  const countLabel =
    items.length === 1 ? noun : `${noun}${noun.endsWith('s') ? 'es' : 's'}`;
  return (
    <fieldset
      className={
        expanded ? 'sidebar-collections' : 'sidebar-collections collapsed'
      }
      aria-label={`${label} filter`}
    >
      <legend className="sidebar-section-label">
        <button
          type="button"
          className="organization-filter-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => onExpandedChange(!expanded)}
        >
          <span className="organization-filter-chevron" aria-hidden="true" />
          <span>{label}</span>
          {selected.length > 0 ? (
            <span className="organization-filter-selected">
              {selected.length} selected
            </span>
          ) : null}
          <span
            className="organization-filter-total"
            aria-label={`${items.length} ${countLabel}`}
          >
            {items.length}
          </span>
        </button>
      </legend>
      <div id={bodyId} className="organization-filter-body" hidden={!expanded}>
        <input
          type="search"
          aria-label={`Search ${label.toLowerCase()}`}
          placeholder={`Find ${noun}`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="organization-filter-actions">
          <button
            type="button"
            className="command-button"
            disabled={selected.length === 0}
            onClick={() => onChange([])}
          >
            All {label.toLowerCase()}
          </button>
        </div>
        <p className="collection-filter-hint">Matches any selected {noun}.</p>
        <div className="collection-filter-options">
          {matching.map((item) => (
            <label
              key={item.id}
              className={
                selected.includes(item.id)
                  ? 'organization-filter-option selected'
                  : 'organization-filter-option'
              }
            >
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, item.id]
                      : selected.filter((id) => id !== item.id),
                  )
                }
              />
              <span title={item.name}>{item.name}</span>
              {item.count !== undefined ? (
                <span className="sidebar-count">{item.count}</span>
              ) : null}
            </label>
          ))}
          {items.length === 0 ? (
            <p>No {label.toLowerCase()} yet.</p>
          ) : matching.length === 0 ? (
            <p>No matching {label.toLowerCase()}.</p>
          ) : null}
        </div>
      </div>
    </fieldset>
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

const SIDEBAR_PREFERENCES_KEY = 'printfarmer.library.sidebar.v1';
export const SIDEBAR_DEFAULT_WIDTH = 224;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
/** Narrowest the model list may become while the sidebar is widened. */
const MAIN_PANE_MIN_WIDTH = 320;
const KEYBOARD_STEP = 10;
const KEYBOARD_LARGE_STEP = 50;

interface SidebarPreferences {
  width: number;
  expanded: { collections: boolean; tags: boolean };
}

const DEFAULT_PREFERENCES: SidebarPreferences = {
  width: SIDEBAR_DEFAULT_WIDTH,
  expanded: { collections: true, tags: true },
};

function clampWidth(width: number, max = SIDEBAR_MAX_WIDTH): number {
  const upper = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, max));
  return Math.round(Math.min(upper, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

function loadSidebarPreferences(): SidebarPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_PREFERENCES_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return DEFAULT_PREFERENCES;
    }
    const { width, expanded } = parsed as Partial<
      Record<keyof SidebarPreferences, unknown>
    >;
    const open =
      typeof expanded === 'object' && expanded !== null
        ? (expanded as Partial<Record<'collections' | 'tags', unknown>>)
        : {};
    return {
      width:
        typeof width === 'number' && Number.isFinite(width)
          ? clampWidth(width)
          : SIDEBAR_DEFAULT_WIDTH,
      expanded: {
        collections:
          typeof open.collections === 'boolean' ? open.collections : true,
        tags: typeof open.tags === 'boolean' ? open.tags : true,
      },
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function saveSidebarPreferences(prefs: SidebarPreferences): void {
  try {
    globalThis.localStorage?.setItem(
      SIDEBAR_PREFERENCES_KEY,
      JSON.stringify(prefs),
    );
  } catch {
    // Layout preferences are best-effort; the sidebar still works unsaved.
  }
}

/**
 * Wraps the sidebar in a width-controlled pane with a vertical separator that
 * resizes it by pointer drag or keyboard. The stored width is the user's
 * preference; the rendered width is additionally capped so the model list
 * keeps a usable minimum when the window is narrow.
 */
function SidebarResizer({
  width,
  onCommit,
  children,
}: {
  width: number;
  onCommit: (width: number) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const paneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [available, setAvailable] = useState(SIDEBAR_MAX_WIDTH);

  useEffect(() => {
    const measure = (): void => {
      const pane = paneRef.current;
      const workspace = pane?.parentElement;
      if (!pane || !workspace || workspace.clientWidth === 0) return;
      let others = 0;
      for (const sibling of Array.from(workspace.children)) {
        if (sibling !== pane && !sibling.classList.contains('library-pane')) {
          others += sibling.getBoundingClientRect().width;
        }
      }
      setAvailable(workspace.clientWidth - others - MAIN_PANE_MIN_WIDTH);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const max = clampWidth(available);
  const current = clampWidth(dragWidth ?? width, max);

  const commit = (next: number): void => {
    const bounded = clampWidth(next, max);
    if (bounded !== width) onCommit(bounded);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: current };
    setDragWidth(current);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    setDragWidth(
      clampWidth(drag.startWidth + event.clientX - drag.startX, max),
    );
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commit(drag.startWidth + event.clientX - drag.startX);
    setDragWidth(null);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && dragRef.current) {
      dragRef.current = null;
      setDragWidth(null);
      return;
    }
    const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
    const next =
      event.key === 'ArrowLeft'
        ? current - step
        : event.key === 'ArrowRight'
          ? current + step
          : event.key === 'Home'
            ? SIDEBAR_MIN_WIDTH
            : event.key === 'End'
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    commit(next);
  };

  return (
    <div
      ref={paneRef}
      className={
        dragWidth === null
          ? 'library-sidebar-pane'
          : 'library-sidebar-pane resizing'
      }
      style={{ width: current }}
    >
      {children}
      <div
        className="library-sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize library sidebar"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={max}
        aria-valuenow={current}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragWidth(null);
        }}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(SIDEBAR_DEFAULT_WIDTH)}
      />
    </div>
  );
}
