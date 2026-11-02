import { useEffect, useRef, useState } from 'react';
import type {
  Collection,
  CollectionChangeOperation,
  PreviewCollectionChangeRequest,
  PreviewCollectionChangeResponse,
  QueryModelsRequest,
} from '@shared/ipc';
import {
  useDialogFocusLifecycle,
  useFocusTrap,
} from '../calibration/useDialogFocus';

/** Matches the IPC schema cap for an explicit selection target. */
export const MAX_SELECTED_COLLECTION_TARGET = 500;

export type CollectionTargetKind = 'selected' | 'query';

export interface CollectionManagerProps {
  collections: Collection[];
  /** Hashes selected on the current library page. */
  selectedHashes: readonly string[];
  /** Effective library filters; paging fields are ignored for bulk changes. */
  queryRequest: QueryModelsRequest;
  matchingTotal: number;
  queryPending: boolean;
  initialTarget?: CollectionTargetKind;
  /** Called after any successful catalog mutation so callers can re-query. */
  onChanged: () => void;
  /** Called after a collection is deleted so filters can drop its id. */
  onDeleted?: (collectionId: string) => void;
  /** Reports a delete failure that arrives after the dialog is closed. */
  onDeleteError?: (message: string) => void;
  onClose: () => void;
}

interface PreviewState {
  key: string;
  request: PreviewCollectionChangeRequest;
  response: PreviewCollectionChangeResponse;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Library-level collection editor: create and rename collections, and add or
 * remove many models at once. Bulk changes are two-step — the sidecar previews
 * exact counts and returns a fingerprint, and apply is refused if the target
 * set or memberships drifted in between. Only collection memberships change;
 * source files and other memberships are never touched.
 */
export function CollectionManager({
  collections,
  selectedHashes,
  queryRequest,
  matchingTotal,
  queryPending,
  initialTarget,
  onChanged,
  onDeleted,
  onDeleteError,
  onClose,
}: CollectionManagerProps): React.JSX.Element {
  const selectionUsable =
    selectedHashes.length > 0 &&
    selectedHashes.length <= MAX_SELECTED_COLLECTION_TARGET;
  const [operation, setOperation] = useState<CollectionChangeOperation>('add');
  const [targetKind, setTargetKind] = useState<CollectionTargetKind>(
    initialTarget ?? (selectionUsable ? 'selected' : 'query'),
  );
  const [destinations, setDestinations] = useState<string[]>([]);
  const [createDraft, setCreateDraft] = useState('');
  const [renaming, setRenaming] = useState<{
    id: string;
    draft: string;
  } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epochRef.current += 1;
    };
  }, []);

  const close = (): void => {
    epochRef.current += 1;
    onClose();
  };
  useFocusTrap(dialogRef, true, close);
  useDialogFocusLifecycle(dialogRef, true);

  // Drop destinations that no longer exist after a refresh.
  const knownIds = new Set(collections.map((collection) => collection.id));
  const liveDestinations = destinations.filter((id) => knownIds.has(id));

  const target: PreviewCollectionChangeRequest['target'] | null =
    targetKind === 'selected'
      ? selectionUsable
        ? { kind: 'selected', hashes: [...selectedHashes] }
        : null
      : queryPending || matchingTotal === 0
        ? null
        : { kind: 'query', query: queryRequest };
  const changeRequest: PreviewCollectionChangeRequest | null =
    target && liveDestinations.length > 0
      ? { operation, target, collectionIds: liveDestinations }
      : null;
  const changeKey = changeRequest ? JSON.stringify(changeRequest) : '';
  const currentPreview =
    preview && preview.key === changeKey && changeKey !== '' ? preview : null;

  const run = async <T,>(
    action: () => Promise<T>,
    onSuccess: (result: T) => void,
    onStaleError?: (error: unknown) => void,
  ): Promise<void> => {
    const epoch = ++epochRef.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (!mountedRef.current || epoch !== epochRef.current) return;
      onSuccess(result);
    } catch (err: unknown) {
      if (!mountedRef.current || epoch !== epochRef.current) {
        onStaleError?.(err);
        return;
      }
      setError(messageOf(err));
    } finally {
      if (mountedRef.current && epoch === epochRef.current) setBusy(false);
    }
  };

  const createCollection = (): void => {
    const name = createDraft.trim();
    if (!name) return;
    void run(
      () => window.printFarmer.createCollection({ name }),
      (created) => {
        setCreateDraft('');
        setDestinations((current) => [...current, created.id]);
        setNotice(`Created “${created.name}”.`);
        onChanged();
      },
    );
  };

  const saveRename = (): void => {
    if (!renaming) return;
    const name = renaming.draft.trim();
    const existing = collections.find(
      (collection) => collection.id === renaming.id,
    );
    if (!name || !existing) return;
    if (name === existing.name) {
      setRenaming(null);
      return;
    }
    void run(
      () => window.printFarmer.renameCollection({ id: renaming.id, name }),
      (renamed) => {
        setRenaming(null);
        setNotice(`Renamed “${existing.name}” to “${renamed.name}”.`);
        onChanged();
      },
    );
  };

  const deleteCollection = (collection: Collection): void => {
    void run(
      async () => {
        try {
          const remaining = await window.printFarmer.deleteCollection({
            id: collection.id,
          });
          if (remaining.some((entry) => entry.id === collection.id)) {
            throw new Error(
              'The collection was not deleted; refresh and retry.',
            );
          }
          onDeleted?.(collection.id);
        } finally {
          onChanged();
        }
      },
      () => {
        setDeleting(null);
        setRenaming(null);
        setPreview(null);
        setDestinations((current) =>
          current.filter((id) => id !== collection.id),
        );
        setNotice(`Deleted “${collection.name}”.`);
      },
      (error) =>
        onDeleteError?.(
          `Could not confirm deletion of “${collection.name}”: ${messageOf(error)}. Check the refreshed library.`,
        ),
    );
  };

  const requestPreview = (): void => {
    if (!changeRequest) return;
    const key = changeKey;
    const request = changeRequest;
    void run(
      () => window.printFarmer.previewCollectionChange(request),
      (response) => setPreview({ key, request, response }),
    );
  };

  const applyPreview = (): void => {
    if (!currentPreview) return;
    const { request, response } = currentPreview;
    void run(
      () =>
        window.printFarmer.applyCollectionChange({
          change: request,
          fingerprint: response.fingerprint,
        }),
      (result) => {
        setPreview(null);
        setNotice(
          result.operation === 'add'
            ? `Added ${plural(result.changedMemberships, 'membership')} across ${plural(result.modelCount, 'model')}; ${result.unchangedMemberships} already present.`
            : `Removed ${plural(result.changedMemberships, 'membership')} across ${plural(result.modelCount, 'model')}; ${result.unchangedMemberships} were not members.`,
        );
        onChanged();
      },
    );
  };

  const verb = operation === 'add' ? 'Add' : 'Remove';
  const selectionLabel =
    selectedHashes.length > MAX_SELECTED_COLLECTION_TARGET
      ? `Selected models (${selectedHashes.length}; limit ${MAX_SELECTED_COLLECTION_TARGET})`
      : `Selected models (${selectedHashes.length})`;

  return (
    <>
      <div className="profile-backdrop" aria-hidden="true" />
      <section
        ref={dialogRef}
        className="server-profiles-dialog collection-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-manager-title"
      >
        <header className="profile-dialog-header">
          <div>
            <h2 id="collection-manager-title">Manage collections</h2>
            <p>
              Collections only group catalog entries. Source files are never
              moved, modified, or deleted.
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close collection manager"
            onClick={close}
          >
            &times;
          </button>
        </header>

        {error ? (
          <div className="profile-alert profile-error" role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="profile-alert" role="status">
            {notice}
          </div>
        ) : null}

        <div className="profile-dialog-content">
          <section aria-labelledby="collection-manager-list">
            <h3 id="collection-manager-list">Collections</h3>
            {collections.length === 0 ? (
              <p className="profile-empty">No collections yet.</p>
            ) : (
              <ul className="collection-manager-list">
                {collections.map((collection) => (
                  <li key={collection.id}>
                    {renaming?.id === collection.id ? (
                      <form
                        className="collection-manager-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveRename();
                        }}
                      >
                        <input
                          type="text"
                          aria-label={`New name for ${collection.name}`}
                          value={renaming.draft}
                          maxLength={128}
                          disabled={busy}
                          autoFocus
                          onChange={(event) =>
                            setRenaming({
                              id: collection.id,
                              draft: event.target.value,
                            })
                          }
                        />
                        <button
                          type="submit"
                          disabled={busy || renaming.draft.trim().length === 0}
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
                      <>
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`Use ${collection.name} for bulk change`}
                            checked={liveDestinations.includes(collection.id)}
                            disabled={busy}
                            onChange={(event) =>
                              setDestinations((current) =>
                                event.target.checked
                                  ? [...current, collection.id]
                                  : current.filter(
                                      (id) => id !== collection.id,
                                    ),
                              )
                            }
                          />
                          <span className="collection-name">
                            {collection.name}
                          </span>
                          <span className="collection-count">
                            {collection.memberCount}
                          </span>
                        </label>
                        <button
                          type="button"
                          aria-label={`Rename ${collection.name}`}
                          disabled={busy}
                          onClick={() =>
                            setRenaming({
                              id: collection.id,
                              draft: collection.name,
                            })
                          }
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="danger-button"
                          aria-label={`Delete ${collection.name}`}
                          disabled={busy}
                          onClick={() => setDeleting(collection.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {deleting === collection.id ? (
                      <div
                        className="collection-manager-delete"
                        role="group"
                        aria-label={`Confirm deleting ${collection.name}`}
                      >
                        <p>
                          Delete “{collection.name}”? Its{' '}
                          {plural(collection.memberCount, 'membership')} will be
                          removed. Models and source files stay in the library.
                          This cannot be undone. If synchronized, the deletion
                          may also be sent to PrintFarmer.
                        </p>
                        <button
                          type="button"
                          className="danger-button"
                          disabled={busy}
                          onClick={() => deleteCollection(collection)}
                        >
                          Delete collection
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setDeleting(null)}
                        >
                          Keep
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <form
              className="collection-add"
              onSubmit={(event) => {
                event.preventDefault();
                createCollection();
              }}
            >
              <input
                type="text"
                aria-label="New collection name"
                placeholder="New collection…"
                value={createDraft}
                maxLength={128}
                disabled={busy}
                onChange={(event) => setCreateDraft(event.target.value)}
              />
              <button
                type="submit"
                disabled={busy || createDraft.trim().length === 0}
              >
                Create
              </button>
            </form>
          </section>

          <section aria-labelledby="collection-manager-bulk">
            <h3 id="collection-manager-bulk">Bulk change</h3>
            <fieldset className="collection-manager-choice" disabled={busy}>
              <legend>Action</legend>
              <label>
                <input
                  type="radio"
                  name="collection-operation"
                  checked={operation === 'add'}
                  onChange={() => setOperation('add')}
                />
                Add to checked collections
              </label>
              <label>
                <input
                  type="radio"
                  name="collection-operation"
                  checked={operation === 'remove'}
                  onChange={() => setOperation('remove')}
                />
                Remove from checked collections
              </label>
            </fieldset>
            <fieldset className="collection-manager-choice" disabled={busy}>
              <legend>Models</legend>
              <label>
                <input
                  type="radio"
                  name="collection-target"
                  checked={targetKind === 'selected'}
                  disabled={!selectionUsable}
                  onChange={() => setTargetKind('selected')}
                />
                {selectionLabel}
              </label>
              <label>
                <input
                  type="radio"
                  name="collection-target"
                  checked={targetKind === 'query'}
                  disabled={matchingTotal === 0}
                  onChange={() => setTargetKind('query')}
                />
                All {plural(matchingTotal, 'model')} matching current filters
                (every page)
              </label>
            </fieldset>
            <p className="collection-filter-hint">
              {liveDestinations.length === 0
                ? 'Check one or more collections above.'
                : targetKind === 'query' && queryPending
                  ? 'Waiting for the library filters to settle…'
                  : operation === 'add'
                    ? 'Existing memberships are kept; models already in a collection are skipped.'
                    : 'Only membership in the checked collections is removed.'}
            </p>
            <button
              type="button"
              className="command-button"
              disabled={busy || !changeRequest}
              onClick={requestPreview}
            >
              Preview {verb.toLowerCase()}
            </button>

            {currentPreview ? (
              <div className="collection-manager-preview" role="status">
                <p>
                  {verb} {plural(currentPreview.response.modelCount, 'model')}{' '}
                  {operation === 'add' ? 'to' : 'from'}:
                </p>
                <ul>
                  {currentPreview.response.targets.map((entry) => (
                    <li key={entry.collectionId}>
                      <strong>{entry.name}</strong>:{' '}
                      {operation === 'add'
                        ? `${entry.changeCount} will be added, ${entry.unchangedCount} already members`
                        : `${entry.changeCount} will be removed, ${entry.unchangedCount} not members`}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className={
                    operation === 'remove' ? 'danger-button' : 'command-button'
                  }
                  disabled={busy || currentPreview.response.changeCount === 0}
                  onClick={applyPreview}
                >
                  {currentPreview.response.changeCount === 0
                    ? 'Nothing to change'
                    : `Confirm: ${verb.toLowerCase()} ${plural(currentPreview.response.changeCount, 'membership')}`}
                </button>
              </div>
            ) : null}
          </section>
        </div>
      </section>
    </>
  );
}
