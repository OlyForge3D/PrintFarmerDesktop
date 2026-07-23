import { useEffect, useMemo, useRef, useState } from 'react';
import type { Collection } from '@shared/ipc';
import type { ImportDraft } from './useLibrary';
import {
  buildImportPlan,
  initialImportChoices,
  type ImportChoices,
  type ImportFolderChoice,
  type ImportPlan,
} from './importPlan';
import { basename, formatBytes } from './model';
import { Icon } from '../ui/Icon';

export interface ImportWizardProps {
  draft: ImportDraft;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (plan: ImportPlan, remember: boolean) => Promise<boolean>;
}

export function ImportWizard({
  draft,
  busy,
  error,
  onCancel,
  onConfirm,
}: ImportWizardProps): React.JSX.Element {
  const [choices, setChoices] = useState<ImportChoices>(() =>
    bindKnownCollections(
      initialImportChoices(draft.rootId, basename(draft.path), draft.preview),
      draft.collections,
    ),
  );
  const [remember, setRemember] = useState(true);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const plan = useMemo(() => buildImportPlan(choices), [choices]);
  const namedRulesAreValid =
    (!choices.rootCollection ||
      validOrganizationName(choices.rootCollectionName)) &&
    choices.folders.every((folder) =>
      folder.mode === 'ignore' ? true : validOrganizationName(folder.name),
    );
  const commonTagsError =
    plan.commonTags.length > 100
      ? 'Use no more than 100 tags.'
      : plan.commonTags.some((tag) => tag.length > 128)
        ? 'Each tag must be 128 characters or fewer.'
        : null;
  const ambiguousRoot =
    choices.rootCollection &&
    !choices.rootCollectionId &&
    matchingCollections(choices.rootCollectionName, draft.collections).length >
      1;
  const ambiguousFolders = choices.folders.filter(
    (folder) =>
      folder.mode === 'collection' &&
      !folder.collectionId &&
      matchingCollections(folder.name, draft.collections).length > 1,
  );
  const canImport =
    namedRulesAreValid &&
    commonTagsError === null &&
    !ambiguousRoot &&
    ambiguousFolders.length === 0 &&
    !busy;

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (
        event.target instanceof Node &&
        dialogRef.current &&
        !dialogRef.current.contains(event.target)
      ) {
        cancelRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [busy, onCancel]);

  const updateFolder = (
    relativePath: string,
    update: (folder: ImportFolderChoice) => ImportFolderChoice,
  ): void => {
    setChoices((current) => ({
      ...current,
      folders: current.folders.map((folder) =>
        folder.relativePath === relativePath ? update(folder) : folder,
      ),
    }));
  };

  return (
    <>
      <div className="import-backdrop" aria-hidden="true" />
      <section
        ref={dialogRef}
        className="import-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-wizard-title"
      >
        <header className="import-header">
          <div>
            <p className="pane-eyebrow">Smart import</p>
            <h2 id="import-wizard-title">Organize models before importing</h2>
            <p className="import-source-path" title={draft.path}>
              {draft.path}
            </p>
          </div>
          <button
            ref={cancelRef}
            type="button"
            className="icon-button import-close"
            aria-label="Cancel import"
            disabled={busy}
            onClick={onCancel}
          >
            &times;
          </button>
        </header>

        <div className="import-summary" aria-label="Import summary">
          <SummaryStat label="Model files" value={draft.preview.modelCount} />
          <SummaryStat
            label="Size"
            value={formatBytes(draft.preview.totalBytes)}
          />
          <SummaryStat label="STL" value={draft.preview.formats.stl} />
          <SummaryStat label="3MF" value={draft.preview.formats.threeMf} />
          <SummaryStat label="OBJ" value={draft.preview.formats.obj} />
        </div>

        {error ? (
          <div className="import-alert" role="alert">
            <Icon name="missing" />
            <span>{error}</span>
          </div>
        ) : null}
        {draft.preview.skippedErrors > 0 ? (
          <p className="import-warning">
            {draft.preview.skippedErrors} unreadable filesystem{' '}
            {draft.preview.skippedErrors === 1 ? 'entry was' : 'entries were'}{' '}
            skipped.
          </p>
        ) : null}
        {draft.preview.modelCount === 0 ? (
          <p className="import-warning">
            No supported files were found. Confirming will reconcile this source
            and mark its previously cataloged files as missing.
          </p>
        ) : null}
        {draft.preview.foldersTruncated ? (
          <p className="import-warning">
            Folder choices are limited to the first 500 paths. All supported
            models will still be imported.
          </p>
        ) : null}

        <div className="import-body">
          <section className="import-section">
            <div className="import-section-heading">
              <div>
                <h3>Whole import</h3>
                <p>Apply a collection and optional tags to every model.</p>
              </div>
            </div>
            <label className="import-root-rule">
              <input
                type="checkbox"
                checked={choices.rootCollection}
                disabled={busy}
                onChange={(event) =>
                  setChoices((current) => ({
                    ...current,
                    rootCollection: event.target.checked,
                  }))
                }
              />
              <span>Add all models to collection</span>
              <input
                type="text"
                aria-label="Import collection name"
                aria-invalid={
                  choices.rootCollection &&
                  !validOrganizationName(choices.rootCollectionName)
                }
                value={choices.rootCollectionName}
                maxLength={128}
                list="known-import-collections"
                disabled={busy || !choices.rootCollection}
                onChange={(event) =>
                  setChoices((current) => {
                    const name = event.target.value;
                    return withRootCollectionId(
                      { ...current, rootCollectionName: name },
                      uniqueCollectionId(name, draft.collections),
                    );
                  })
                }
              />
            </label>
            {ambiguousRoot ? (
              <CollectionDisambiguator
                label="Choose import collection"
                name={choices.rootCollectionName}
                collections={draft.collections}
                disabled={busy}
                onSelect={(collection) =>
                  setChoices((current) => ({
                    ...current,
                    rootCollectionName: collection.name,
                    rootCollectionId: collection.id,
                  }))
                }
              />
            ) : null}
            <label className="import-common-tags">
              <span>Tags for all models</span>
              <input
                type="text"
                aria-label="Tags for all imported models"
                value={choices.commonTagsText}
                maxLength={2048}
                disabled={busy}
                placeholder="terrain, printable, customer-a"
                onChange={(event) =>
                  setChoices((current) => ({
                    ...current,
                    commonTagsText: event.target.value,
                  }))
                }
              />
              <small
                className={commonTagsError ? 'import-field-error' : undefined}
                role={commonTagsError ? 'alert' : undefined}
              >
                {commonTagsError ?? 'Separate tags with commas.'}
              </small>
            </label>
          </section>

          <section className="import-section import-folder-section">
            <div className="import-section-heading">
              <div>
                <h3>Folder rules</h3>
                <p>
                  Top-level folders become collections; deeper folders become
                  tags. Review or override each suggestion.
                </p>
              </div>
              <span>{draft.preview.folders.length} folders</span>
            </div>
            {choices.folders.length ? (
              <div className="import-rule-list" role="list">
                {choices.folders.map((folder) => (
                  <div
                    className="import-rule-row"
                    role="listitem"
                    key={folder.relativePath}
                  >
                    <div
                      className="import-rule-path"
                      style={{ paddingLeft: `${(folder.depth - 1) * 16}px` }}
                    >
                      <Icon name="folder" />
                      <span title={folder.relativePath}>
                        {folder.relativePath}
                      </span>
                      <small>{folder.modelCount}</small>
                    </div>
                    <select
                      aria-label={`Organization for ${folder.relativePath}`}
                      value={folder.mode}
                      disabled={busy}
                      onChange={(event) =>
                        updateFolder(folder.relativePath, (current) => {
                          const mode = event.target.value as
                            'collection' | 'tag' | 'ignore';
                          return withFolderCollectionId(
                            { ...current, mode },
                            mode === 'collection'
                              ? uniqueCollectionId(
                                  current.name,
                                  draft.collections,
                                )
                              : undefined,
                          );
                        })
                      }
                    >
                      <option value="collection">Collection</option>
                      <option value="tag">Tag</option>
                      <option value="ignore">Ignore</option>
                    </select>
                    <input
                      type="text"
                      aria-label={`Name for ${folder.relativePath}`}
                      aria-invalid={
                        folder.mode !== 'ignore' &&
                        !validOrganizationName(folder.name)
                      }
                      value={folder.name}
                      maxLength={128}
                      list={
                        folder.mode === 'collection'
                          ? 'known-import-collections'
                          : folder.mode === 'tag'
                            ? 'known-import-tags'
                            : undefined
                      }
                      disabled={busy || folder.mode === 'ignore'}
                      onChange={(event) =>
                        updateFolder(folder.relativePath, (current) => {
                          const name = event.target.value;
                          return withFolderCollectionId(
                            { ...current, name },
                            current.mode === 'collection'
                              ? uniqueCollectionId(name, draft.collections)
                              : undefined,
                          );
                        })
                      }
                    />
                    {folder.mode === 'collection' &&
                    !folder.collectionId &&
                    matchingCollections(folder.name, draft.collections).length >
                      1 ? (
                      <CollectionDisambiguator
                        label={`Choose collection for ${folder.relativePath}`}
                        name={folder.name}
                        collections={draft.collections}
                        disabled={busy}
                        onSelect={(collection) =>
                          updateFolder(folder.relativePath, (current) => ({
                            ...current,
                            name: collection.name,
                            collectionId: collection.id,
                          }))
                        }
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="import-no-folders">
                Models are directly inside the selected folder.
              </p>
            )}
          </section>
        </div>

        <footer className="import-footer">
          <label>
            <input
              type="checkbox"
              checked={remember}
              disabled={busy}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Remember these rules for this source
          </label>
          <div>
            <button
              type="button"
              className="import-secondary"
              disabled={busy}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="import-primary"
              disabled={!canImport}
              onClick={() => {
                void onConfirm(plan, remember);
              }}
            >
              {busy
                ? 'Importing...'
                : draft.preview.modelCount === 0
                  ? 'Reconcile source'
                  : `Import ${draft.preview.modelCount} files`}
            </button>
          </div>
        </footer>

        <datalist id="known-import-collections">
          {draft.collections.map((collection) => (
            <option value={collection.name} key={collection.id} />
          ))}
        </datalist>
        <datalist id="known-import-tags">
          {draft.tags.map((tag) => (
            <option value={tag.name} key={tag.id} />
          ))}
        </datalist>
      </section>
    </>
  );
}

function validOrganizationName(value: string): boolean {
  const length = value.trim().length;
  return length > 0 && length <= 128;
}

function bindKnownCollections(
  choices: ImportChoices,
  collections: readonly Collection[],
): ImportChoices {
  const rootId =
    choices.rootCollectionId &&
    collections.some((collection) => collection.id === choices.rootCollectionId)
      ? choices.rootCollectionId
      : uniqueCollectionId(choices.rootCollectionName, collections);
  return {
    ...withRootCollectionId(choices, rootId),
    folders: choices.folders.map((folder) =>
      withFolderCollectionId(
        folder,
        folder.mode === 'collection'
          ? folder.collectionId &&
            collections.some(
              (collection) => collection.id === folder.collectionId,
            )
            ? folder.collectionId
            : uniqueCollectionId(folder.name, collections)
          : undefined,
      ),
    ),
  };
}

function matchingCollections(
  name: string,
  collections: readonly Collection[],
): Collection[] {
  const normalized = name.trim().toLocaleLowerCase();
  return collections.filter(
    (collection) => collection.name.toLocaleLowerCase() === normalized,
  );
}

function uniqueCollectionId(
  name: string,
  collections: readonly Collection[],
): string | undefined {
  const matches = matchingCollections(name, collections);
  return matches.length === 1 ? matches[0]?.id : undefined;
}

function withRootCollectionId(
  choices: ImportChoices,
  collectionId: string | undefined,
): ImportChoices {
  const next = { ...choices };
  delete next.rootCollectionId;
  return collectionId ? { ...next, rootCollectionId: collectionId } : next;
}

function withFolderCollectionId(
  folder: ImportFolderChoice,
  collectionId: string | undefined,
): ImportFolderChoice {
  const next = { ...folder };
  delete next.collectionId;
  return collectionId ? { ...next, collectionId } : next;
}

function CollectionDisambiguator({
  label,
  name,
  collections,
  disabled,
  onSelect,
}: {
  label: string;
  name: string;
  collections: readonly Collection[];
  disabled: boolean;
  onSelect: (collection: Collection) => void;
}): React.JSX.Element {
  const matches = matchingCollections(name, collections);
  return (
    <label className="import-collection-choice">
      <span>Multiple collections have this name</span>
      <select
        aria-label={label}
        value=""
        disabled={disabled}
        onChange={(event) => {
          const collection = matches.find(
            (candidate) => candidate.id === event.target.value,
          );
          if (collection) {
            onSelect(collection);
          }
        }}
      >
        <option value="" disabled>
          Choose a collection
        </option>
        {matches.map((collection) => (
          <option value={collection.id} key={collection.id}>
            {collection.name} ({collection.id.slice(0, 8)})
          </option>
        ))}
      </select>
    </label>
  );
}

function SummaryStat({
  label,
  value,
}: {
  label: string;
  value: string | number;
}): React.JSX.Element {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
