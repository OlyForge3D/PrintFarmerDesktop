import { useEffect, useMemo, useRef, useState } from 'react';
import type { Collection } from '@shared/ipc';
import type { ImportDraft, ImportStage } from './useLibrary';
import {
  buildImportPlan,
  initialImportChoices,
  type ImportChoices,
  type ImportFolderChoice,
  type ImportPlan,
} from './importPlan';
import { basename, formatBytes } from './model';
import { Icon } from '../ui/Icon';
import { LibraryErrorAlert } from './LibraryErrorAlert';
import { ScanFeedback } from './ScanFeedback';

export interface ImportWizardProps {
  draft: ImportDraft;
  busy: boolean;
  /** Stage of the running import, or null when no import is running. */
  importStage?: ImportStage | null;
  error: string | null;
  onCancel: () => void;
  onDismissError: () => void;
  onRetryScan?: () => void;
  retryLabel?: string | null;
  onConfirm: (plan: ImportPlan, remember: boolean) => Promise<boolean>;
}

export function ImportWizard({
  draft,
  busy: operationBusy,
  importStage = null,
  error,
  onCancel,
  onDismissError,
  onConfirm,
  onRetryScan,
  retryLabel,
}: ImportWizardProps): React.JSX.Element {
  const [choices, setChoices] = useState<ImportChoices>(() =>
    bindKnownCollections(
      initialImportChoices(draft.rootId, basename(draft.path), draft.preview),
      draft.collections,
    ),
  );
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = operationBusy || submitting;
  const progressText = importProgressText(
    importStage,
    draft.preview.modelCount,
  );
  const [scanFeedbackDismissed, setScanFeedbackDismissed] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const importButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasBusyRef = useRef(false);
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
      if (busy) {
        // Every control is disabled while importing; the progress region is
        // the only focus stop that keeps focus inside the modal.
        event.preventDefault();
        progressRef.current?.focus();
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
        (busy ? progressRef.current : cancelRef.current)?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [busy, onCancel]);

  useEffect(() => {
    setScanFeedbackDismissed(false);
  }, [draft.preview]);

  useEffect(() => {
    if (!busy) {
      setStartedAt(null);
      if (wasBusyRef.current) {
        wasBusyRef.current = false;
        // The import ended without closing the wizard (a failure). Move focus
        // off the now-empty progress region to the error's action, or to the
        // re-enabled Import button.
        const target =
          dialogRef.current?.querySelector<HTMLElement>(
            '.import-alert button',
          ) ?? importButtonRef.current;
        target?.focus();
      }
      return;
    }
    wasBusyRef.current = true;
    setStartedAt((current) => current ?? Date.now());
    // Every dialog control is disabled while importing, so keep focus inside
    // the dialog on the progress region instead of letting it fall to <body>.
    progressRef.current?.focus();
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const submit = async (): Promise<void> => {
    if (submittingRef.current || busy) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onConfirm(plan, remember);
    } catch {
      // The library owner surfaces import failures through `error`.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

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

        {/* aria-busy stays off the progress live region so stage changes are
            announced while the import runs. */}
        <div className="import-body" aria-busy={busy}>
          <div className="import-summary" aria-label="Import summary">
            <SummaryStat label="Model files" value={draft.preview.modelCount} />
            <SummaryStat
              label="Size"
              value={formatBytes(draft.preview.totalBytes)}
            />
            <SummaryStat label="STL" value={draft.preview.formats.stl} />
            <SummaryStat label="3MF" value={draft.preview.formats.threeMf} />
            <SummaryStat label="OBJ" value={draft.preview.formats.obj} />
            {draft.preview.formats.step !== undefined ? (
              <SummaryStat label="STEP" value={draft.preview.formats.step} />
            ) : null}
          </div>

          {error ? (
            <LibraryErrorAlert
              error={error}
              className="import-alert"
              onDismiss={onDismissError}
              onRetry={onRetryScan}
              retryLabel={retryLabel}
            />
          ) : null}
          {!scanFeedbackDismissed ? (
            <ScanFeedback
              data={draft.preview}
              onRetry={onRetryScan}
              retryLabel={retryLabel}
              onDismiss={() => setScanFeedbackDismissed(true)}
              className="import-scan-feedback"
            />
          ) : null}
          {draft.preview.modelCount === 0 ? (
            <p className="import-warning">
              No locally available supported files were found.
              {(draft.preview.cloudDirectoriesSkipped ?? 0) > 0 ||
              (draft.preview.cloudFilesSkipped ?? 0) > 0 ||
              (draft.preview.skippedEntries?.permissionDenied ?? 0) > 0 ||
              (draft.preview.skippedEntries?.unreadable ?? 0) > 0 ||
              (draft.preview.skippedEntries?.tooLarge ?? 0) > 0
                ? ' Previously cataloged files will be preserved where availability could not be determined.'
                : ' Confirming will reconcile this source and mark previously cataloged files confirmed missing as unavailable.'}
            </p>
          ) : null}
          {draft.preview.foldersTruncated ? (
            <p className="import-warning">
              Folder choices are limited to the first 500 paths. All supported
              models will still be imported.
            </p>
          ) : null}

          <div className="import-content">
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
                          unresolved={Boolean(
                            folder.collectionTargetUnresolved,
                          )}
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
        </div>

        <div
          ref={progressRef}
          className="import-progress"
          tabIndex={-1}
          data-active={busy ? 'true' : 'false'}
        >
          <div
            className="import-progress-text"
            role="status"
            aria-live="polite"
            aria-label="Import progress"
          >
            {busy ? (
              <>
                <strong>{progressText.heading}</strong>
                <span>{progressText.detail}</span>
              </>
            ) : null}
          </div>
          {busy ? (
            <>
              <span className="import-progress-elapsed">
                Elapsed{' '}
                {formatElapsed(
                  startedAt === null ? 0 : Math.max(0, now - startedAt),
                )}
              </span>
              <progress aria-label={`${progressText.heading}, in progress`} />
            </>
          ) : null}
        </div>

        <footer className="import-footer" aria-busy={busy}>
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
              ref={importButtonRef}
              className="import-primary"
              disabled={!canImport}
              onClick={() => {
                void submit();
              }}
            >
              {busy
                ? 'Importing...'
                : draft.preview.modelCount === 0
                  ? 'Reconcile source'
                  : `Import ${draft.preview.modelCount} ${draft.preview.modelCount === 1 ? 'file' : 'files'}`}
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

function importProgressText(
  stage: ImportStage | null,
  modelCount: number,
): { heading: string; detail: string } {
  if (stage === 'refreshing') {
    return {
      heading: 'Refreshing library',
      detail: 'Import finished. Loading the updated catalog.',
    };
  }
  if (stage === 'checking') {
    return {
      heading: 'Checking library',
      detail:
        'The import did not finish normally. Checking the catalog before reporting the error.',
    };
  }
  // The preview count can be stale: importRoot rescans the source itself.
  const previewCount =
    modelCount === 0
      ? 'No model files were found during preview.'
      : `${modelCount.toLocaleString()} ${modelCount === 1 ? 'file' : 'files'} found during preview.`;
  return {
    heading: modelCount === 0 ? 'Reconciling source' : 'Importing source',
    detail:
      stage === 'importing'
        ? `${previewCount} Rescanning the source folder and applying organization rules. Large libraries can take several minutes; per-file progress is not available.`
        : `${previewCount} Starting import.`,
  };
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
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
