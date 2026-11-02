import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  OrganizationEntry,
  OrganizationKind,
  PreviewOrganizationDeletionRequest,
  PreviewOrganizationDeletionResponse,
} from '@shared/ipc';
import { Icon } from '../ui/Icon';

/** Matches the IPC cap for one deletion request. */
export const MAX_ORGANIZATION_SELECTION = 500;
const PAGE_SIZE = 200;

type UsageFilter = 'all' | 'unused' | 'used';

export interface OrganizationWorkspaceProps {
  /** Which list to open on; the sidebar's Manage links pass their own. */
  initialKind?: OrganizationKind;
  /** Disables mutations while another catalog operation runs. */
  busy: boolean;
  /** Bumped by the caller when tags or collections changed elsewhere. */
  revision: number;
  /** Called after any successful mutation so the library can re-query. */
  onChanged: () => void;
  /** Called with ids that no longer exist so filters can drop them. */
  onDeleted: (kind: OrganizationKind, ids: readonly string[]) => void;
}

interface ReviewState {
  key: string;
  request: PreviewOrganizationDeletionRequest;
  response: PreviewOrganizationDeletionResponse;
}

const KIND_LABELS: Record<OrganizationKind, { one: string; many: string }> = {
  collection: { one: 'collection', many: 'collections' },
  tag: { one: 'tag', many: 'tags' },
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scopeLabel(entry: OrganizationEntry): string {
  if (entry.deleteScope === 'readOnly') return 'Shared · read-only';
  if (entry.kind === 'tag' && entry.synced) return 'From PrintFarmer';
  if (entry.deleteScope === 'sync') return 'Synced';
  return 'Local';
}

/**
 * Durable place for tag and collection definitions. Filtering by tag or
 * collection stays in the library sidebar; this is where definitions are
 * reviewed, renamed, and removed in bulk. Deletion is two-step: the sidecar
 * previews exact counts and a fingerprint, and apply is refused if anything
 * drifted in between. Models and source files are never touched.
 */
export function OrganizationWorkspace({
  initialKind = 'collection',
  busy: externalBusy,
  revision,
  onChanged,
  onDeleted,
}: OrganizationWorkspaceProps): React.JSX.Element {
  const [kind, setKind] = useState<OrganizationKind>(initialKind);
  const [entries, setEntries] = useState<OrganizationEntry[] | null>(null);
  const [search, setSearch] = useState('');
  const [usage, setUsage] = useState<UsageFilter>('all');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [review, setReview] = useState<ReviewState | null>(null);
  const [renaming, setRenaming] = useState<{
    id: string;
    draft: string;
  } | null>(null);
  const [createDraft, setCreateDraft] = useState('');
  const [working, setWorking] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);
  const cancelReviewRef = useRef<HTMLButtonElement | null>(null);
  const busy = externalBusy || working;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const epoch = ++epochRef.current;
    try {
      const listed = await window.printFarmer.listOrganization();
      if (!mountedRef.current || epoch !== epochRef.current) return;
      setEntries(listed);
      setLoadError(null);
    } catch (err: unknown) {
      if (!mountedRef.current || epoch !== epochRef.current) return;
      setLoadError(`Could not load tags and collections: ${messageOf(err)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const ofKind = useMemo(
    () => (entries ?? []).filter((entry) => entry.kind === kind),
    [entries, kind],
  );
  const counts = useMemo(() => {
    const result = { collection: 0, tag: 0 };
    for (const entry of entries ?? []) result[entry.kind] += 1;
    return result;
  }, [entries]);
  const needle = search.trim().toLowerCase();
  const visible = ofKind.filter(
    (entry) =>
      (needle === '' || entry.name.toLowerCase().includes(needle)) &&
      (usage === 'all' ||
        (usage === 'unused' ? entry.modelCount === 0 : entry.modelCount > 0)),
  );
  const shown = visible.slice(0, limit);
  const deletable = (entry: OrganizationEntry): boolean =>
    entry.deleteScope !== 'readOnly';
  // Selection follows what still exists; a refresh silently drops stale ids.
  const liveSelection = ofKind.filter(
    (entry) => selected.has(entry.id) && deletable(entry),
  );
  const unusedDeletable = ofKind.filter(
    (entry) => entry.modelCount === 0 && deletable(entry),
  );
  const visibleDeletable = visible.filter(deletable);
  const allVisibleSelected =
    visibleDeletable.length > 0 &&
    visibleDeletable.every((entry) => selected.has(entry.id));
  const overLimit = liveSelection.length > MAX_ORGANIZATION_SELECTION;
  const request: PreviewOrganizationDeletionRequest | null =
    liveSelection.length > 0 && !overLimit
      ? {
          kind,
          ids: liveSelection.map((entry) => entry.id),
          emptyOnly: liveSelection.every((entry) => entry.modelCount === 0),
        }
      : null;
  const requestKey = request ? JSON.stringify(request) : '';
  const currentReview =
    review && review.key === requestKey && requestKey !== '' ? review : null;
  const labels = KIND_LABELS[kind];

  useEffect(() => {
    if (currentReview) cancelReviewRef.current?.focus();
  }, [currentReview]);

  const switchKind = (next: OrganizationKind): void => {
    if (next === kind) return;
    setKind(next);
    setSelected(new Set());
    setReview(null);
    setRenaming(null);
    setLimit(PAGE_SIZE);
    setError(null);
    setNotice(null);
  };

  const run = async <T,>(
    action: () => Promise<T>,
    onSuccess: (result: T) => void,
  ): Promise<void> => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (!mountedRef.current) return;
      onSuccess(result);
    } catch (err: unknown) {
      if (mountedRef.current) setError(messageOf(err));
    } finally {
      if (mountedRef.current) setWorking(false);
    }
  };

  const toggle = (id: string, checked: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const selectEntries = (list: readonly OrganizationEntry[]): void => {
    setSelected(new Set(list.map((entry) => entry.id)));
  };

  const requestReview = (): void => {
    if (!request) return;
    const key = requestKey;
    const pending = request;
    void run(
      () => window.printFarmer.previewOrganizationDeletion(pending),
      (response) => setReview({ key, request: pending, response }),
    );
  };

  const applyReview = (): void => {
    if (!currentReview) return;
    const { request: selection, response } = currentReview;
    void run(
      async () => {
        try {
          const result = await window.printFarmer.applyOrganizationDeletion({
            selection,
            fingerprint: response.fingerprint,
          });
          // Notify before any reload and even if the user has navigated away,
          // so the library drops the deleted definitions immediately.
          onDeleted(result.kind, result.deletedIds);
          return result;
        } finally {
          // Refresh even on failure: a refused apply means the catalog moved.
          onChanged();
          if (mountedRef.current) await load();
        }
      },
      (result) => {
        setReview(null);
        setSelected(new Set());
        const names = KIND_LABELS[result.kind];
        setNotice(
          `Deleted ${plural(result.deletedIds.length, names.one, names.many)}` +
            (result.assignmentsRemoved > 0
              ? ` and removed ${plural(result.assignmentsRemoved, 'model assignment')}.`
              : '.'),
        );
      },
    );
  };

  const saveRename = (entry: OrganizationEntry): void => {
    if (!renaming) return;
    const name = renaming.draft.trim();
    if (!name) return;
    if (name === entry.name) {
      setRenaming(null);
      return;
    }
    void run(
      async () => {
        const renamed = await window.printFarmer.renameCollection({
          id: entry.id,
          name,
        });
        onChanged();
        await load();
        return renamed;
      },
      (renamed) => {
        setRenaming(null);
        setNotice(`Renamed “${entry.name}” to “${renamed.name}”.`);
      },
    );
  };

  const createCollection = (): void => {
    const name = createDraft.trim();
    if (!name) return;
    void run(
      async () => {
        const created = await window.printFarmer.createCollection({ name });
        onChanged();
        await load();
        return created;
      },
      (created) => {
        setCreateDraft('');
        setNotice(`Created “${created.name}”.`);
      },
    );
  };

  return (
    <main
      id="organization-main"
      className="sources-pane organization-pane"
      aria-label="Tags and collections"
      aria-busy={busy}
    >
      <header className="service-heading">
        <div>
          <h1 data-organization-heading tabIndex={-1}>
            Tags &amp; Collections
          </h1>
          <p>
            Review how models are organized and clear out what you no longer
            use. Deleting a tag or collection only removes it from models;
            models and source files stay.
          </p>
        </div>
        <div className="service-heading-actions">
          <button
            type="button"
            disabled={working}
            onClick={() => {
              setError(null);
              setNotice(null);
              void load();
            }}
          >
            <Icon name="refresh" />
            Refresh
          </button>
        </div>
      </header>

      <div
        className="organization-kinds"
        role="radiogroup"
        aria-label="Organization type"
      >
        {(['collection', 'tag'] as const).map((value) => (
          <label key={value} className={value === kind ? 'active' : undefined}>
            <input
              type="radio"
              name="organization-kind"
              checked={value === kind}
              onChange={() => switchKind(value)}
            />
            <Icon name={value === 'tag' ? 'tag' : 'collection'} />
            <span>{value === 'tag' ? 'Tags' : 'Collections'}</span>
            <span className="organization-kind-count">{counts[value]}</span>
          </label>
        ))}
      </div>

      {loadError ? (
        <div className="catalog-sources-alert error" role="alert">
          <span>{loadError}</span>
        </div>
      ) : null}
      {error ? (
        <div className="catalog-sources-alert error" role="alert">
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="catalog-sources-alert success" role="status">
          <span>{notice}</span>
        </div>
      ) : null}

      <section
        className="organization-panel"
        aria-labelledby="organization-list-title"
      >
        <div className="organization-toolbar">
          <h2 id="organization-list-title">
            {kind === 'tag' ? 'Tags' : 'Collections'}
          </h2>
          <div className="organization-search">
            <Icon name="search" />
            <input
              type="search"
              aria-label={`Search ${labels.many}`}
              placeholder={`Find ${labels.one}`}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(PAGE_SIZE);
              }}
            />
          </div>
          <label className="organization-usage">
            <span>Show</span>
            <select
              aria-label="Show by usage"
              value={usage}
              onChange={(event) => {
                setUsage(event.target.value as UsageFilter);
                setLimit(PAGE_SIZE);
              }}
            >
              <option value="all">All</option>
              <option value="unused">Unused (0 models)</option>
              <option value="used">In use</option>
            </select>
          </label>
        </div>

        <div
          className="organization-selection-bar"
          role="toolbar"
          aria-label="Selection"
        >
          <span className="organization-selection-count" aria-live="polite">
            {liveSelection.length === 0
              ? 'Nothing selected'
              : `${liveSelection.length} selected`}
          </span>
          <button
            type="button"
            disabled={busy || unusedDeletable.length === 0}
            onClick={() => selectEntries(unusedDeletable)}
          >
            Select all unused ({unusedDeletable.length})
          </button>
          <button
            type="button"
            disabled={busy || liveSelection.length === 0}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
          <button
            type="button"
            className="organization-delete-trigger"
            disabled={busy || !request}
            onClick={requestReview}
          >
            Review deletion…
          </button>
        </div>
        {overLimit ? (
          <p className="organization-hint" role="status">
            Select at most {MAX_ORGANIZATION_SELECTION} {labels.many} per
            deletion.
          </p>
        ) : null}

        {currentReview ? (
          <div
            className="catalog-reset-confirmation organization-review"
            role="alert"
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || busy) return;
              event.preventDefault();
              setReview(null);
            }}
          >
            <strong>
              Delete{' '}
              {plural(
                currentReview.response.entries.length,
                labels.one,
                labels.many,
              )}
              ?
            </strong>
            <p>
              {currentReview.response.assignmentsRemoved === 0
                ? currentReview.response.entries.length === 1
                  ? `This ${labels.one} is not on any model.`
                  : `None of these ${labels.many} are on any model.`
                : `${plural(currentReview.response.assignmentsRemoved, 'model assignment')} will be removed. The models themselves stay in the library.`}{' '}
              This cannot be undone.
            </p>
            {currentReview.response.serverDeletions > 0 ? (
              <p>
                {plural(
                  currentReview.response.serverDeletions,
                  'synced collection',
                )}{' '}
                will also be deleted on PrintFarmer at the next sync.
              </p>
            ) : null}
            {kind === 'tag' &&
            currentReview.response.entries.some((entry) => entry.synced) ? (
              <p>
                Tags from PrintFarmer are removed on this computer only and may
                return on the next sync.
              </p>
            ) : null}
            <ul className="organization-review-list">
              {currentReview.response.entries.slice(0, 8).map((entry) => (
                <li key={entry.id}>
                  {entry.name} <span>{plural(entry.modelCount, 'model')}</span>
                </li>
              ))}
              {currentReview.response.entries.length > 8 ? (
                <li>and {currentReview.response.entries.length - 8} more</li>
              ) : null}
            </ul>
            <div>
              <button
                ref={cancelReviewRef}
                type="button"
                disabled={busy}
                onClick={() => setReview(null)}
              >
                Keep{' '}
                {currentReview.response.entries.length === 1
                  ? labels.one
                  : labels.many}
              </button>
              <button
                type="button"
                className="catalog-reset-confirm"
                disabled={busy}
                onClick={applyReview}
              >
                {working
                  ? 'Deleting…'
                  : `Delete ${plural(currentReview.response.entries.length, labels.one, labels.many)}`}
              </button>
            </div>
          </div>
        ) : null}

        {entries === null && !loadError ? (
          <p className="organization-hint" role="status">
            Loading {labels.many}…
          </p>
        ) : ofKind.length === 0 && entries !== null ? (
          <div className="catalog-source-empty">
            <span className="catalog-source-empty-icon" aria-hidden="true">
              <Icon name={kind === 'tag' ? 'tag' : 'collection'} size={22} />
            </span>
            <div>
              <h3>No {labels.many} yet</h3>
              <p>
                {kind === 'tag'
                  ? 'Add tags to a model from its inspector.'
                  : 'Create a collection below, then add models from the library.'}
              </p>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <p className="organization-hint" role="status">
            No {labels.many} match these filters.
          </p>
        ) : (
          <table className="organization-table">
            <thead>
              <tr>
                <th scope="col" className="organization-check">
                  <input
                    type="checkbox"
                    aria-label={`Select all shown ${labels.many}`}
                    checked={allVisibleSelected}
                    disabled={busy || visibleDeletable.length === 0}
                    onChange={(event) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const entry of visibleDeletable) {
                          if (event.target.checked) next.add(entry.id);
                          else next.delete(entry.id);
                        }
                        return next;
                      })
                    }
                  />
                </th>
                <th scope="col">Name</th>
                <th scope="col" className="organization-number">
                  Models
                </th>
                <th scope="col">Source</th>
                {kind === 'collection' ? (
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <tr
                  key={entry.id}
                  className={selected.has(entry.id) ? 'selected' : undefined}
                >
                  <td className="organization-check">
                    <input
                      type="checkbox"
                      aria-label={`Select ${entry.name}`}
                      checked={selected.has(entry.id) && deletable(entry)}
                      disabled={busy || !deletable(entry)}
                      title={
                        deletable(entry)
                          ? undefined
                          : 'Shared or owned by another server profile; manage it on PrintFarmer.'
                      }
                      onChange={(event) =>
                        toggle(entry.id, event.target.checked)
                      }
                    />
                  </td>
                  <td className="organization-name">
                    {renaming?.id === entry.id ? (
                      <form
                        className="organization-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveRename(entry);
                        }}
                      >
                        <input
                          type="text"
                          aria-label={`New name for ${entry.name}`}
                          value={renaming.draft}
                          maxLength={128}
                          disabled={busy}
                          autoFocus
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              setRenaming(null);
                            }
                          }}
                          onChange={(event) =>
                            setRenaming({
                              id: entry.id,
                              draft: event.target.value,
                            })
                          }
                        />
                        <button
                          type="submit"
                          disabled={busy || renaming.draft.trim() === ''}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setRenaming(null)}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <span title={entry.name}>{entry.name}</span>
                    )}
                  </td>
                  <td
                    className={`organization-number${entry.modelCount === 0 ? ' unused' : ''}`}
                  >
                    {entry.modelCount === 0 ? 'Unused' : entry.modelCount}
                  </td>
                  <td>
                    <span className={`organization-scope ${entry.deleteScope}`}>
                      {scopeLabel(entry)}
                    </span>
                  </td>
                  {kind === 'collection' ? (
                    <td className="organization-actions">
                      {renaming?.id !== entry.id &&
                      entry.deleteScope !== 'readOnly' ? (
                        <button
                          type="button"
                          aria-label={`Rename ${entry.name}`}
                          disabled={busy}
                          onClick={() =>
                            setRenaming({ id: entry.id, draft: entry.name })
                          }
                        >
                          Rename
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {visible.length > shown.length ? (
          <button
            type="button"
            className="organization-more"
            onClick={() => setLimit((current) => current + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, visible.length - shown.length)} more of{' '}
            {visible.length - shown.length}
          </button>
        ) : null}

        {kind === 'collection' ? (
          <form
            className="organization-create"
            onSubmit={(event) => {
              event.preventDefault();
              createCollection();
            }}
          >
            <input
              type="text"
              aria-label="New collection name"
              placeholder="New collection name"
              value={createDraft}
              maxLength={128}
              disabled={busy}
              onChange={(event) => setCreateDraft(event.target.value)}
            />
            <button type="submit" disabled={busy || createDraft.trim() === ''}>
              Create collection
            </button>
          </form>
        ) : null}
      </section>
    </main>
  );
}
