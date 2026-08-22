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
  const unresolvedRoot =
    choices.rootCollection && Boolean(choices.rootCollectionTargetUnresolved);
  const unresolvedFolders = choices.folders.filter(
    (folder) =>
      folder.mode === 'collection' && folder.collectionTargetUnresolved,
  );
  const canImport =
    namedRulesAreValid &&
    commonTagsError === null &&
    !unresolvedRoot &&
    unresolvedFolders.length === 0 &&
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
            <div className="import-root-rule">
              <label className="import-root-toggle">
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
              </label>
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
                    return withRootCollectionTarget(
                      { ...current, rootCollectionName: name },
                      inferredCollectionTarget(name, draft.collections),
                    );
                  })
                }
              />
              <CollectionTargetPicker
                label="Choose import collection"
                name={choices.rootCollectionName}
                collectionId={choices.rootCollectionId}
                unresolved={Boolean(choices.rootCollectionTargetUnresolved)}
                collections={draft.collections}
                disabled={busy || !choices.rootCollection}
                onSelect={(collection) =>
                  setChoices((current) =>
                    collection
                      ? withRootCollectionTarget(
                          {
                            ...current,
                            rootCollectionName: collection.name,
                          },
                          { collectionId: collection.id },
                        )
                      : withRootCollectionTarget(current, {}),
                  )
                }
              />
            </div>
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
                          return withFolderCollectionTarget(
                            { ...current, mode },
                            mode === 'collection'
                              ? inferredCollectionTarget(
                                  current.name,
                                  draft.collections,
                                )
                              : {},
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
                          return withFolderCollectionTarget(
                            { ...current, name },
                            current.mode === 'collection'
                              ? inferredCollectionTarget(
                                  name,
                                  draft.collections,
                                )
                              : {},
                          );
                        })
                      }
                    />
                    {folder.mode === 'collection' ? (
                      <CollectionTargetPicker
                        label={`Choose collection for ${folder.relativePath}`}
                        name={folder.name}
                        collectionId={folder.collectionId}
                        unresolved={Boolean(folder.collectionTargetUnresolved)}
                        collections={draft.collections}
                        disabled={busy}
                        onSelect={(collection) =>
                          updateFolder(folder.relativePath, (current) =>
                            collection
                              ? withFolderCollectionTarget(
                                  { ...current, name: collection.name },
                                  { collectionId: collection.id },
                                )
                              : withFolderCollectionTarget(current, {}),
                          )
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
  const rootTarget = rememberedCollectionTarget(
    choices.rootCollectionName,
    choices.rootCollectionId,
    collections,
  );
  const rootChoices = withRootCollectionTarget(choices, rootTarget);
  return {
    ...rootChoices,
    ...(rootTarget.resolvedName
      ? { rootCollectionName: rootTarget.resolvedName }
      : {}),
    folders: choices.folders.map((folder) => {
      if (folder.mode !== 'collection') {
        return withFolderCollectionTarget(folder, {});
      }
      const target = rememberedCollectionTarget(
        folder.name,
        folder.collectionId,
        collections,
      );
      return withFolderCollectionTarget(
        target.resolvedName ? { ...folder, name: target.resolvedName } : folder,
        target,
      );
    }),
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

interface CollectionTarget {
  collectionId?: string;
  unresolved?: boolean;
  resolvedName?: string;
}

function inferredCollectionTarget(
  name: string,
  collections: readonly Collection[],
): CollectionTarget {
  const matches = matchingCollections(name, collections);
  const match = matches[0];
  if (matches.length === 1 && match) {
    return { collectionId: match.id, resolvedName: match.name };
  }
  return matches.length > 1 ? { unresolved: true } : {};
}

function rememberedCollectionTarget(
  name: string,
  rememberedId: string | undefined,
  collections: readonly Collection[],
): CollectionTarget {
  if (!rememberedId) {
    return inferredCollectionTarget(name, collections);
  }
  const remembered = collections.find(
    (collection) => collection.id === rememberedId,
  );
  return remembered
    ? { collectionId: remembered.id, resolvedName: remembered.name }
    : { unresolved: true };
}

function withRootCollectionTarget(
  choices: ImportChoices,
  target: CollectionTarget,
): ImportChoices {
  const next = { ...choices };
  delete next.rootCollectionId;
  delete next.rootCollectionTargetUnresolved;
  return {
    ...next,
    ...(target.collectionId ? { rootCollectionId: target.collectionId } : {}),
    ...(target.unresolved ? { rootCollectionTargetUnresolved: true } : {}),
  };
}

function withFolderCollectionTarget(
  folder: ImportFolderChoice,
  target: CollectionTarget,
): ImportFolderChoice {
  const next = { ...folder };
  delete next.collectionId;
  delete next.collectionTargetUnresolved;
  return {
    ...next,
    ...(target.collectionId ? { collectionId: target.collectionId } : {}),
    ...(target.unresolved ? { collectionTargetUnresolved: true } : {}),
  };
}

function CollectionTargetPicker({
  label,
  name,
  collectionId,
  unresolved,
  collections,
  disabled,
  onSelect,
}: {
  label: string;
  name: string;
  collectionId: string | undefined;
  unresolved: boolean;
  collections: readonly Collection[];
  disabled: boolean;
  onSelect: (collection: Collection | null) => void;
}): React.JSX.Element {
  const matches = matchingCollections(name, collections);
  const nameTargetDisabled = matches.length > 1;
  const value = collectionId ?? (unresolved ? '__unresolved__' : '__name__');
  return (
    <select
      className="import-collection-target"
      aria-label={label}
      aria-invalid={unresolved}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        if (event.target.value === '__name__') {
          onSelect(null);
          return;
        }
        const collection = collections.find(
          (candidate) => candidate.id === event.target.value,
        );
        if (collection) {
          onSelect(collection);
        }
      }}
    >
      {unresolved ? (
        <option value="__unresolved__" disabled>
          Choose a collection target
        </option>
      ) : null}
      <option value="__name__" disabled={nameTargetDisabled}>
        {nameTargetDisabled
          ? 'Choose one of the duplicate collections'
          : matches.length === 1
            ? `Use "${name}" by name`
            : `Create "${name}"`}
      </option>
      {collections.map((collection) => (
        <option value={collection.id} key={collection.id}>
          {collection.name} · {collection.memberCount}{' '}
          {collection.memberCount === 1 ? 'model' : 'models'} · …
          {collection.id.slice(-10)}
        </option>
      ))}
    </select>
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
