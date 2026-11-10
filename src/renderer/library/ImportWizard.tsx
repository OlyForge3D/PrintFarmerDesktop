import { useEffect, useMemo, useRef, useState } from 'react';
import type { Collection, ImportPreviewResponse } from '@shared/ipc';
import type { ImportDraft, ImportStage } from './useLibrary';
import {
  applyPolicyToFolders,
  bulkFolderPolicies,
  buildImportPlan,
  forgetImportPlan,
  initialImportChoices,
  policyValidationError,
  type ImportChoices,
  type ImportFolderChoice,
  type ImportPlan,
} from './importPlan';
import { basename, formatBytes } from './model';
import { Icon } from '../ui/Icon';
import { LibraryErrorAlert } from './LibraryErrorAlert';
import { ScanFeedback, scanOutcomeCounts } from './ScanFeedback';

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
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = operationBusy || submitting;
  const progressText = importProgressText(
    importStage,
    draft.preview.modelCount,
  );
  const scanCounts = scanOutcomeCounts(draft.preview);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const importButtonRef = useRef<HTMLButtonElement | null>(null);
  const folderEditorRef = useRef<HTMLElement | null>(null);
  const wasBusyRef = useRef(false);
  const previewRequestRef = useRef(0);
  const completedPreviewKeyRef = useRef<string | null>(null);
  const [previewState, setPreviewState] = useState<{
    key: string;
    status: 'pending' | 'ready' | 'error';
    organization?: NonNullable<ImportPreviewResponse['organization']>;
    error?: string;
  } | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [selectedFolderPath, setSelectedFolderPath] = useState(
    () => choices.folders[0]?.relativePath ?? '',
  );
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const [folderPage, setFolderPage] = useState(0);
  const plan = useMemo(() => buildImportPlan(choices), [choices]);
  const planKey = JSON.stringify(plan);
  const unresolvedTargets = [
    ...plan.rules.flatMap((rule) =>
      rule.kind === 'collection'
        ? [
            {
              source: 'rule' as const,
              path: rule.relativePath,
              name: rule.name,
              id: rule.collectionId,
            },
          ]
        : [],
    ),
    ...(plan.policies ?? []).flatMap((policy) =>
      policy.mode === 'organize' &&
      policy.collectionName &&
      !hasTemplatePlaceholder(policy.collectionName)
        ? [
            {
              source: 'policy' as const,
              path: policy.relativePath,
              name: policy.collectionName,
              id: policy.collectionId,
            },
          ]
        : [],
    ),
  ].filter(
    (target) =>
      rememberedCollectionTarget(target.name, target.id, draft.collections)
        .unresolved,
  );
  const folderTree = useMemo(
    () => buildFolderTree(choices.folders),
    [choices.folders],
  );
  const visibleFolders = useMemo(
    () => visibleFolderTree(folderTree, expandedPaths),
    [folderTree, expandedPaths],
  );
  const folderPageSize = 100;
  const folderPageCount = Math.max(
    1,
    Math.ceil(visibleFolders.length / folderPageSize),
  );
  const currentFolderPage = Math.min(folderPage, folderPageCount - 1);
  const displayedFolders = visibleFolders.slice(
    currentFolderPage * folderPageSize,
    (currentFolderPage + 1) * folderPageSize,
  );
  const foldersByPath = useMemo(
    () =>
      new Map(choices.folders.map((folder) => [folder.relativePath, folder])),
    [choices.folders],
  );
  useEffect(() => {
    setFolderPage((current) => Math.min(current, folderPageCount - 1));
  }, [folderPageCount]);
  const selectedFolder = choices.folders.find(
    (folder) => folder.relativePath === selectedFolderPath,
  );
  const selectedFolderContext = selectedFolder
    ? folderPolicyContext(selectedFolder, choices, foldersByPath)
    : null;
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
      (folder.mode === 'collection' ||
        (folder.mode === 'recipe' &&
          folder.name.trim() !== '' &&
          !hasTemplatePlaceholder(folder.name))) &&
      folder.collectionTargetUnresolved,
  );
  const validationError = policyValidationError(choices);
  const folderValidationIssues = useMemo(() => {
    const isolatedChoices: ImportChoices = {
      ...choices,
      folders: [],
      policies: [],
      legacyRules: [],
      legacyIgnoredPaths: [],
    };
    delete isolatedChoices.recipeError;
    const issues = new Map<string, string>();
    for (const folder of choices.folders) {
      const message = policyValidationError({
        ...isolatedChoices,
        folders: [folder],
      });
      if (message) issues.set(folder.relativePath, message);
    }
    const visiblePaths = new Set(
      choices.folders.map((folder) => folder.relativePath),
    );
    for (const policy of choices.policies) {
      if (visiblePaths.has(policy.relativePath)) continue;
      const message = policyValidationError({
        ...isolatedChoices,
        policies: [policy],
      });
      if (message) issues.set(policy.relativePath, message);
    }
    return issues;
  }, [choices]);
  const selectedFolderValidationError = selectedFolder
    ? folderValidationIssues.get(selectedFolder.relativePath)
    : undefined;
  const canCopyFolderPolicy =
    selectedFolder !== undefined &&
    (selectedFolder.mode === 'collection' ||
      selectedFolder.mode === 'tag' ||
      selectedFolder.mode === 'recipe');
  const bulkPolicyError =
    canCopyFolderPolicy && selectedFolder
      ? policyValidationError({
          ...choices,
          legacyRules: [],
          legacyIgnoredPaths: [],
          policies: [],
          folders: [{ ...selectedFolder, legacy: false }],
        })
      : null;
  const bulkPolicyHasUnresolvedTarget = Boolean(
    canCopyFolderPolicy && selectedFolder?.collectionTargetUnresolved,
  );
  const previewIsCurrent =
    previewState?.key === planKey && previewState.status === 'ready';
  const canImport =
    (!choices.rootCollection ||
      validOrganizationName(choices.rootCollectionName)) &&
    validationError === null &&
    commonTagsError === null &&
    !unresolvedRoot &&
    unresolvedFolders.length === 0 &&
    unresolvedTargets.length === 0 &&
    previewIsCurrent &&
    (previewState?.organization?.errors.length ?? 1) === 0 &&
    !busy;

  useEffect(() => {
    if (busy || completedPreviewKeyRef.current === planKey) return;
    const requestId = ++previewRequestRef.current;
    if (
      unresolvedRoot ||
      unresolvedFolders.length ||
      unresolvedTargets.length
    ) {
      setPreviewState({
        key: planKey,
        status: 'error',
        error:
          'Choose collection targets in Folder policies or Whole import to calculate the summary.',
      });
      return;
    }
    setPreviewState({ key: planKey, status: 'pending' });
    const timer = window.setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          window.printFarmer.previewImport({
            approvalId: draft.approvalId,
            rules: plan.rules,
            commonTags: plan.commonTags,
            policies: plan.policies,
          }),
        )
        .then((response) => {
          if (previewRequestRef.current !== requestId) return;
          if (!response.complete || response.failure) {
            throw new Error(
              response.failure ?? 'The organization preview is incomplete.',
            );
          }
          if (!response.organization) {
            throw new Error(
              'Organization preview is unavailable. Update the desktop sidecar and retry.',
            );
          }
          const organization = response.organization;
          setPreviewState({
            key: planKey,
            status: organization.errors.length ? 'error' : 'ready',
            ...(organization.errors.length
              ? { error: organization.errors.join(' ') }
              : { organization }),
          });
          if (!organization.errors.length)
            completedPreviewKeyRef.current = planKey;
        })
        .catch((cause: unknown) => {
          if (previewRequestRef.current !== requestId) return;
          setPreviewState({
            key: planKey,
            status: 'error',
            error:
              cause instanceof Error
                ? cause.message
                : 'The organization preview failed. Retry the preview.',
          });
        });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      if (previewRequestRef.current === requestId) {
        previewRequestRef.current += 1;
      }
    };
  }, [
    busy,
    draft.approvalId,
    plan,
    planKey,
    previewRetry,
    unresolvedRoot,
    unresolvedFolders.length,
    unresolvedTargets.length,
  ]);

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
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
      setSubmitError(null);
      await onConfirm(plan, remember);
    } catch (cause) {
      setSubmitError(
        cause instanceof Error
          ? cause.message
          : 'The import could not be completed. Review the error and retry.',
      );
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
        folder.relativePath === relativePath
          ? { ...update(folder), legacy: false }
          : folder,
      ),
    }));
  };

  const setBulkFolderMode = (mode: 'inherit' | 'disabled'): void => {
    if (!selectedPaths.size) return;
    setChoices((current) =>
      bulkFolderPolicies(current, [...selectedPaths], mode),
    );
    setSelectedPaths(new Set());
  };

  const applySelectedFolderPolicy = (): void => {
    if (!selectedFolder || !selectedPaths.size || !canCopyFolderPolicy) return;
    setChoices((current) =>
      applyPolicyToFolders(current, [...selectedPaths], selectedFolder),
    );
    setSelectedPaths(new Set());
  };

  const inspectInvalidFolder = (relativePath: string): void => {
    const expanded = new Set(expandedPaths);
    let ancestor = relativePath;
    while (ancestor.includes('/')) {
      ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
      expanded.add(ancestor);
    }
    const revealedFolders = visibleFolderTree(folderTree, expanded);
    const index = revealedFolders.findIndex(
      ({ folder }) => folder.relativePath === relativePath,
    );
    setExpandedPaths(expanded);
    setFolderPage(Math.max(0, Math.floor(index / folderPageSize)));
    setSelectedFolderPath(relativePath);
    window.requestAnimationFrame(() =>
      folderEditorRef.current?.querySelector<HTMLElement>('select')?.focus(),
    );
  };

  const setFolderSelected = (path: string, selected: boolean): void => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (selected) next.add(path);
      else next.delete(path);
      return next;
    });
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
            <SummaryStat label="Skipped entries" value={scanCounts.skipped} />
            <SummaryStat label="Cloud-only" value={scanCounts.cloudOnly} />
            <SummaryStat label="Unreadable" value={scanCounts.unreadable} />
            <SummaryStat label="Oversized ZIPs" value={scanCounts.tooLarge} />
            {scanCounts.permissionDenied ? (
              <SummaryStat
                label="Permission denied"
                value={scanCounts.permissionDenied}
              />
            ) : null}
            {scanCounts.filesystemErrors ? (
              <SummaryStat
                label="Filesystem errors"
                value={scanCounts.filesystemErrors}
              />
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
          <ScanFeedback
            data={draft.preview}
            onRetry={onRetryScan}
            retryLabel={retryLabel}
            compact
            disabled={busy}
          />
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
                {commonTagsError ? (
                  <small className="import-field-error" role="alert">
                    {commonTagsError}
                  </small>
                ) : null}
              </label>
            </section>

            <section className="import-section import-folder-section">
              <div className="import-section-heading">
                <div>
                  <h3>Folder policies</h3>
                  <p>
                    Policies inherit down the tree. A local policy replaces
                    inherited folder metadata.
                  </p>
                </div>
                <span>
                  {choices.folders.length.toLocaleString()} folders ·{' '}
                  {plan.policies?.length ?? 0} policies ·{' '}
                  {(
                    choices.legacyRules.filter(
                      (rule) => rule.relativePath !== '',
                    ).length + choices.legacyIgnoredPaths.length
                  ).toLocaleString()}{' '}
                  legacy rules/ignores
                </span>
              </div>
              {unresolvedTargets.length ? (
                <div
                  className="import-policy-alert"
                  role="alert"
                  aria-label="Collection targets need attention"
                >
                  <strong>Saved collection choices need attention</strong>
                  <span>
                    A remembered collection is missing or its name is ambiguous.
                    Choose a target explicitly; files will not be moved.
                  </span>
                  {unresolvedTargets.map((target, index) => (
                    <label
                      className="import-policy-field"
                      key={`${target.source}-${target.path}-${index}`}
                    >
                      <span>
                        {target.path || 'Source folder'} — {target.name}
                      </span>
                      <CollectionTargetPicker
                        label={`Resolve ${target.source} collection for ${target.path || 'source'}`}
                        name={target.name}
                        collectionId={target.id}
                        unresolved
                        collections={draft.collections}
                        disabled={busy}
                        onSelect={(collection) =>
                          setChoices((current) => {
                            const selected = collection
                              ? { collectionId: collection.id }
                              : {};
                            const name = collection?.name ?? target.name;
                            const next = {
                              ...current,
                              legacyRules: current.legacyRules.map((rule) => {
                                if (
                                  target.source !== 'rule' ||
                                  rule.kind !== 'collection' ||
                                  rule.relativePath !== target.path ||
                                  rule.name !== target.name ||
                                  rule.collectionId !== target.id
                                )
                                  return rule;
                                const rest = { ...rule };
                                delete rest.collectionId;
                                return { ...rest, name, ...selected };
                              }),
                              policies: current.policies.map((policy) => {
                                if (
                                  target.source !== 'policy' ||
                                  policy.relativePath !== target.path
                                )
                                  return policy;
                                const rest = { ...policy };
                                delete rest.collectionId;
                                return {
                                  ...rest,
                                  collectionName: name,
                                  ...selected,
                                };
                              }),
                              folders: current.folders.map((folder) =>
                                folder.relativePath === target.path &&
                                (folder.mode === 'collection' ||
                                  folder.mode === 'recipe')
                                  ? withFolderCollectionTarget(
                                      { ...folder, name },
                                      selected,
                                    )
                                  : folder,
                              ),
                            };
                            return target.source === 'rule' &&
                              target.path === ''
                              ? withRootCollectionTarget(
                                  { ...next, rootCollectionName: name },
                                  selected,
                                )
                              : next;
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              {validationError && !choices.recipeError ? (
                <div
                  className="import-policy-alert"
                  role="alert"
                  aria-label="Source organization errors"
                >
                  <strong>Import blocked: review source organization</strong>
                  {folderValidationIssues.size ? (
                    <ul>
                      {[...folderValidationIssues].map(([path, message]) => (
                        <li key={path}>
                          <span>
                            <strong>{path || 'Source folder'}</strong>:{' '}
                            {message}
                          </span>{' '}
                          {foldersByPath.has(path) ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => inspectInvalidFolder(path)}
                            >
                              Review policy for {path}
                            </button>
                          ) : (
                            <span>
                              Saved policy for a folder absent from this scan.
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span>{validationError}</span>
                  )}
                </div>
              ) : null}
              {choices.recipeError ? (
                <div className="import-policy-alert" role="alert">
                  <strong>Saved organization choices need attention</strong>
                  <span>{choices.recipeError}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      try {
                        forgetImportPlan(draft.rootId);
                        const nextChoices = bindKnownCollections(
                          initialImportChoices(
                            draft.rootId,
                            basename(draft.path),
                            draft.preview,
                          ),
                          draft.collections,
                        );
                        setChoices(nextChoices);
                        setSelectedFolderPath(
                          nextChoices.folders[0]?.relativePath ?? '',
                        );
                        setSelectedPaths(new Set());
                        setExpandedPaths(new Set());
                        setSubmitError(null);
                      } catch (cause) {
                        setSubmitError(
                          cause instanceof Error
                            ? cause.message
                            : 'The saved recipe could not be discarded.',
                        );
                      }
                    }}
                  >
                    Discard unreadable saved recipe
                  </button>
                </div>
              ) : null}
              <div className="import-tree-tools">
                <div>
                  <button
                    type="button"
                    disabled={busy || !choices.folders.length}
                    onClick={() =>
                      setSelectedPaths(
                        new Set(
                          choices.folders.map((folder) => folder.relativePath),
                        ),
                      )
                    }
                  >
                    Select all folders in source
                  </button>
                  <button
                    type="button"
                    disabled={busy || !selectedPaths.size}
                    onClick={() => setSelectedPaths(new Set())}
                  >
                    Clear selection
                  </button>
                  <span>{selectedPaths.size.toLocaleString()} selected</span>
                </div>
                <p>
                  Bulk actions apply to each selected folder and every
                  descendant, including collapsed folders and saved choices not
                  shown in this scan.
                </p>
                <div>
                  <button
                    type="button"
                    disabled={busy || !selectedPaths.size}
                    onClick={() => setBulkFolderMode('disabled')}
                  >
                    Disable folder organization
                  </button>
                  <button
                    type="button"
                    disabled={busy || !selectedPaths.size}
                    onClick={() => setBulkFolderMode('inherit')}
                  >
                    Clear policy; inherit
                  </button>
                  {selectedPaths.size && canCopyFolderPolicy ? (
                    <button
                      type="button"
                      disabled={
                        busy ||
                        bulkPolicyError !== null ||
                        bulkPolicyHasUnresolvedTarget
                      }
                      onClick={applySelectedFolderPolicy}
                    >
                      Apply policy to selected subtrees
                    </button>
                  ) : null}
                </div>
                {selectedPaths.size &&
                canCopyFolderPolicy &&
                (bulkPolicyError || bulkPolicyHasUnresolvedTarget) ? (
                  <p className="import-field-error" role="alert">
                    {bulkPolicyError ??
                      'Choose a collection target before applying this policy.'}
                  </p>
                ) : null}
              </div>
              {choices.folders.length ? (
                <div className="import-tree-layout">
                  <div className="import-folder-tree-container">
                    <nav
                      className="import-tree-pagination"
                      aria-label="Folder tree pages"
                    >
                      <button
                        type="button"
                        disabled={busy || currentFolderPage === 0}
                        onClick={() =>
                          setFolderPage((current) => Math.max(0, current - 1))
                        }
                      >
                        Previous 100
                      </button>
                      <span
                        role="status"
                        aria-label="Folder page"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        Showing{' '}
                        {visibleFolders.length
                          ? (
                              currentFolderPage * folderPageSize +
                              1
                            ).toLocaleString()
                          : '0'}
                        –
                        {Math.min(
                          (currentFolderPage + 1) * folderPageSize,
                          visibleFolders.length,
                        ).toLocaleString()}{' '}
                        of {visibleFolders.length.toLocaleString()} visible ·
                        Page {currentFolderPage + 1} of {folderPageCount}
                      </span>
                      <button
                        type="button"
                        disabled={
                          busy || currentFolderPage >= folderPageCount - 1
                        }
                        onClick={() =>
                          setFolderPage((current) =>
                            Math.min(folderPageCount - 1, current + 1),
                          )
                        }
                      >
                        Next 100
                      </button>
                    </nav>
                    <div
                      className="import-folder-tree"
                      role="list"
                      aria-label="Source folders"
                    >
                      {displayedFolders.map(
                        ({ folder, hasChildren, expanded }) => {
                          const context = folderPolicyContext(
                            folder,
                            choices,
                            foldersByPath,
                          );
                          return (
                            <div
                              className={`import-tree-row${selectedFolderPath === folder.relativePath ? ' selected' : ''}`}
                              role="listitem"
                              key={folder.relativePath}
                              style={
                                {
                                  '--folder-depth': folder.depth - 1,
                                } as React.CSSProperties
                              }
                            >
                              <input
                                type="checkbox"
                                aria-label={`Select ${folder.relativePath} and descendants`}
                                checked={selectedPaths.has(folder.relativePath)}
                                disabled={busy}
                                onChange={(event) =>
                                  setFolderSelected(
                                    folder.relativePath,
                                    event.target.checked,
                                  )
                                }
                              />
                              {hasChildren ? (
                                <button
                                  type="button"
                                  className="import-tree-disclosure"
                                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${folder.relativePath}`}
                                  aria-expanded={expanded}
                                  disabled={busy}
                                  onClick={() =>
                                    setExpandedPaths((current) => {
                                      const next = new Set(current);
                                      if (next.has(folder.relativePath)) {
                                        next.delete(folder.relativePath);
                                      } else {
                                        next.add(folder.relativePath);
                                      }
                                      return next;
                                    })
                                  }
                                >
                                  {expanded ? '−' : '+'}
                                </button>
                              ) : (
                                <span
                                  className="import-tree-disclosure-placeholder"
                                  aria-hidden="true"
                                />
                              )}
                              <Icon name="folder" />
                              <button
                                type="button"
                                className="import-tree-path"
                                aria-label={`Edit policy for ${folder.relativePath}`}
                                aria-pressed={
                                  selectedFolderPath === folder.relativePath
                                }
                                disabled={busy}
                                onClick={() =>
                                  setSelectedFolderPath(folder.relativePath)
                                }
                              >
                                {folder.relativePath}
                              </button>
                              <span className="import-tree-count">
                                {folder.modelCount.toLocaleString()} models
                              </span>
                              <span className="import-policy-state">
                                {context.label}
                                {folderValidationIssues.has(folder.relativePath)
                                  ? ' · Policy error'
                                  : ''}
                              </span>
                            </div>
                          );
                        },
                      )}
                    </div>
                  </div>
                  <section
                    ref={folderEditorRef}
                    className="import-folder-editor"
                    aria-label={
                      selectedFolder
                        ? `Policy editor for ${selectedFolder.relativePath}`
                        : 'Folder policy editor'
                    }
                  >
                    {selectedFolder ? (
                      <>
                        <div className="import-folder-editor-heading">
                          <div>
                            <h4>Selected folder</h4>
                            <code>{selectedFolder.relativePath}</code>
                          </div>
                          <span>
                            {selectedFolder.modelCount.toLocaleString()} models
                          </span>
                        </div>
                        {selectedFolder.mode === 'ignore' ? (
                          <p className="import-legacy-note">
                            Legacy ignore only removes the old choice here. It
                            does not block an ancestor policy.
                          </p>
                        ) : null}
                        <p className="import-inheritance-status">
                          {selectedFolderContext?.description}
                        </p>
                        <label className="import-policy-mode">
                          <span>Folder organization</span>
                          <select
                            aria-label={`Folder organization for ${selectedFolder.relativePath}`}
                            value={selectedFolder.mode}
                            disabled={busy}
                            onChange={(event) =>
                              updateFolder(
                                selectedFolder.relativePath,
                                (current) => {
                                  const mode = event.target.value as
                                    | 'collection'
                                    | 'tag'
                                    | 'inherit'
                                    | 'disabled'
                                    | 'recipe';
                                  const next = { ...current, mode };
                                  return withFolderCollectionTarget(
                                    next,
                                    mode === 'collection' ||
                                      (mode === 'recipe' &&
                                        !hasTemplatePlaceholder(next.name))
                                      ? inferredCollectionTarget(
                                          next.name,
                                          draft.collections,
                                        )
                                      : {},
                                  );
                                },
                              )
                            }
                          >
                            {selectedFolder.legacy &&
                            selectedFolder.mode === 'ignore' ? (
                              <option value="ignore">Legacy ignore</option>
                            ) : null}
                            <option value="inherit">
                              Inherit nearest folder policy
                            </option>
                            <option value="collection">
                              Collection with optional tags
                            </option>
                            <option value="tag">One fixed tag</option>
                            <option value="recipe">Pattern-based recipe</option>
                            <option value="disabled">
                              Disable folder organization
                            </option>
                          </select>
                        </label>
                        {selectedFolder.mode === 'collection' ? (
                          <>
                            <label className="import-policy-field">
                              <span>Collection name</span>
                              <input
                                type="text"
                                aria-label={`Collection name for ${selectedFolder.relativePath}`}
                                value={selectedFolder.name}
                                maxLength={128}
                                list="known-import-collections"
                                disabled={busy}
                                onChange={(event) =>
                                  updateFolder(
                                    selectedFolder.relativePath,
                                    (current) => {
                                      const name = event.target.value;
                                      return withFolderCollectionTarget(
                                        { ...current, name },
                                        inferredCollectionTarget(
                                          name,
                                          draft.collections,
                                        ),
                                      );
                                    },
                                  )
                                }
                              />
                            </label>
                            <CollectionTargetPicker
                              label={`Choose collection for ${selectedFolder.relativePath}`}
                              name={selectedFolder.name}
                              collectionId={selectedFolder.collectionId}
                              unresolved={Boolean(
                                selectedFolder.collectionTargetUnresolved,
                              )}
                              collections={draft.collections}
                              disabled={busy}
                              onSelect={(collection) =>
                                updateFolder(
                                  selectedFolder.relativePath,
                                  (current) =>
                                    collection
                                      ? withFolderCollectionTarget(
                                          { ...current, name: collection.name },
                                          { collectionId: collection.id },
                                        )
                                      : withFolderCollectionTarget(current, {}),
                                )
                              }
                            />
                            <label className="import-policy-field">
                              <span>Also add tags (optional)</span>
                              <input
                                type="text"
                                aria-label={`Tags for ${selectedFolder.relativePath}`}
                                value={selectedFolder.tagsText}
                                maxLength={2048}
                                list="known-import-tags"
                                disabled={busy}
                                placeholder="miniatures, terrain"
                                onChange={(event) =>
                                  updateFolder(
                                    selectedFolder.relativePath,
                                    (current) => ({
                                      ...current,
                                      tagsText: event.target.value,
                                    }),
                                  )
                                }
                              />
                            </label>
                          </>
                        ) : null}
                        {selectedFolder.mode === 'tag' ? (
                          <label className="import-policy-field">
                            <span>Tags for this folder</span>
                            <input
                              type="text"
                              aria-label={`Tags for ${selectedFolder.relativePath}`}
                              value={selectedFolder.name}
                              maxLength={128}
                              list="known-import-tags"
                              disabled={busy}
                              placeholder="miniatures, terrain"
                              onChange={(event) =>
                                updateFolder(
                                  selectedFolder.relativePath,
                                  (current) => ({
                                    ...current,
                                    name: event.target.value,
                                  }),
                                )
                              }
                            />
                          </label>
                        ) : null}
                        {selectedFolder.mode === 'recipe' ? (
                          <>
                            <p className="import-recipe-example">
                              Example: <code>{'{maker}/{project}/**'}</code>{' '}
                              creates collection <code>{'{maker}'}</code> and
                              adds tag <code>miniatures</code>.
                            </p>
                            <label className="import-policy-field">
                              <span>Path pattern</span>
                              <input
                                type="text"
                                aria-label={`Path pattern for ${selectedFolder.relativePath}`}
                                value={selectedFolder.pattern}
                                maxLength={4096}
                                disabled={busy}
                                placeholder="{maker}/{project}/**"
                                onChange={(event) =>
                                  updateFolder(
                                    selectedFolder.relativePath,
                                    (current) => ({
                                      ...current,
                                      pattern: event.target.value,
                                    }),
                                  )
                                }
                              />
                              <small>
                                Match paths below this folder; captures use one
                                segment and ** may appear only at the end.
                              </small>
                            </label>
                            <label className="import-policy-field">
                              <span>Collection name (optional)</span>
                              <input
                                type="text"
                                aria-label={`Recipe collection name for ${selectedFolder.relativePath}`}
                                value={selectedFolder.name}
                                maxLength={128}
                                disabled={busy}
                                placeholder="{maker}"
                                onChange={(event) =>
                                  updateFolder(
                                    selectedFolder.relativePath,
                                    (current) => {
                                      const name = event.target.value;
                                      const next = { ...current, name };
                                      return withFolderCollectionTarget(
                                        next,
                                        hasTemplatePlaceholder(name)
                                          ? {}
                                          : inferredCollectionTarget(
                                              name,
                                              draft.collections,
                                            ),
                                      );
                                    },
                                  )
                                }
                              />
                            </label>
                            {selectedFolder.name.trim() &&
                            !hasTemplatePlaceholder(selectedFolder.name) ? (
                              <CollectionTargetPicker
                                label={`Choose recipe collection for ${selectedFolder.relativePath}`}
                                name={selectedFolder.name}
                                collectionId={selectedFolder.collectionId}
                                unresolved={Boolean(
                                  selectedFolder.collectionTargetUnresolved,
                                )}
                                collections={draft.collections}
                                disabled={busy}
                                onSelect={(collection) =>
                                  updateFolder(
                                    selectedFolder.relativePath,
                                    (current) =>
                                      collection
                                        ? withFolderCollectionTarget(
                                            {
                                              ...current,
                                              name: collection.name,
                                            },
                                            { collectionId: collection.id },
                                          )
                                        : withFolderCollectionTarget(
                                            current,
                                            {},
                                          ),
                                  )
                                }
                              />
                            ) : null}
                            <label className="import-policy-field">
                              <span>Tags (optional)</span>
                              <textarea
                                aria-label={`Recipe tags for ${selectedFolder.relativePath}`}
                                value={selectedFolder.tagsText}
                                maxLength={2048}
                                disabled={busy}
                                placeholder="miniatures, {project}"
                                onChange={(event) =>
                                  updateFolder(
                                    selectedFolder.relativePath,
                                    (current) => ({
                                      ...current,
                                      tagsText: event.target.value,
                                    }),
                                  )
                                }
                              />
                            </label>
                          </>
                        ) : null}
                        {selectedFolderValidationError ? (
                          <p className="import-field-error" role="alert">
                            Policy error for {selectedFolder.relativePath}:{' '}
                            {selectedFolderValidationError}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="import-no-folders">
                        Select a folder to inspect or edit its policy.
                      </p>
                    )}
                  </section>
                </div>
              ) : (
                <p className="import-no-folders">
                  Models are directly inside the selected folder.
                </p>
              )}
            </section>
            <section className="import-section import-organization-preview">
              <div className="import-section-heading">
                <div>
                  <h3>What this import will do</h3>
                  <p>
                    Read-only summary of the complete source scan. Updates
                    automatically as you change folder settings.
                  </p>
                </div>
                <span>
                  {previewState?.key !== planKey ||
                  previewState.status === 'pending'
                    ? 'Updating…'
                    : previewState.status === 'error'
                      ? "Couldn't calculate"
                      : 'Up to date'}
                </span>
              </div>
              {previewState?.key !== planKey ||
              previewState.status === 'pending' ? (
                <p className="import-preview-status" role="status">
                  Calculating organization changes…
                </p>
              ) : previewState.status === 'error' ? (
                <div className="import-preview-error" role="alert">
                  <span>Preview failed: {previewState.error}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPreviewRetry((current) => current + 1)}
                  >
                    Retry organization preview
                  </button>
                </div>
              ) : previewState.organization ? (
                <OrganizationPreview organization={previewState.organization} />
              ) : null}
            </section>
          </div>
          {submitError ? (
            <p
              className="import-preview-error import-submit-error"
              role="alert"
            >
              {submitError}
            </p>
          ) : null}
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
          <div className="import-footer-actions">
            {!busy && !canImport ? (
              <p
                id="import-unavailable-reason"
                className="import-action-reason"
                role="status"
              >
                {unresolvedRoot ||
                unresolvedFolders.length ||
                unresolvedTargets.length
                  ? 'Choose the collection targets that need attention.'
                  : validationError ||
                    commonTagsError ||
                    (choices.rootCollection &&
                    !validOrganizationName(choices.rootCollectionName)
                      ? 'Check the organization settings above.'
                      : !previewIsCurrent &&
                          previewState?.key === planKey &&
                          previewState.status === 'error'
                        ? 'Import is unavailable because the summary could not be calculated. Review the error above and retry.'
                        : 'Import will be available when the automatic summary finishes updating.')}
              </p>
            ) : null}
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
                aria-describedby={
                  !busy && !canImport ? 'import-unavailable-reason' : undefined
                }
                disabled={!canImport}
                onClick={() => {
                  void submit();
                }}
              >
                {busy
                  ? 'Importing...'
                  : draft.preview.modelCount === 0
                    ? 'Reconcile source'
                    : 'Import'}
              </button>
            </div>
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

interface FolderTreeNode {
  folder: ImportFolderChoice;
  children: FolderTreeNode[];
}

function buildFolderTree(
  folders: readonly ImportFolderChoice[],
): FolderTreeNode[] {
  const nodes = new Map<string, FolderTreeNode>();
  for (const folder of folders) {
    nodes.set(folder.relativePath, { folder, children: [] });
  }
  const roots: FolderTreeNode[] = [];
  for (const node of nodes.values()) {
    const separator = node.folder.relativePath.lastIndexOf('/');
    const parentPath =
      separator < 0 ? '' : node.folder.relativePath.slice(0, separator);
    const parent = nodes.get(parentPath);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function visibleFolderTree(
  roots: readonly FolderTreeNode[],
  expandedPaths: ReadonlySet<string>,
): Array<{
  folder: ImportFolderChoice;
  hasChildren: boolean;
  expanded: boolean;
}> {
  const visible: Array<{
    folder: ImportFolderChoice;
    hasChildren: boolean;
    expanded: boolean;
  }> = [];
  const visit = (nodes: readonly FolderTreeNode[]): void => {
    for (const node of nodes) {
      const expanded = expandedPaths.has(node.folder.relativePath);
      visible.push({
        folder: node.folder,
        hasChildren: node.children.length > 0,
        expanded,
      });
      if (expanded) visit(node.children);
    }
  };
  visit(roots);
  return visible;
}

function folderPolicyContext(
  folder: ImportFolderChoice,
  choices: ImportChoices,
  byPath: ReadonlyMap<string, ImportFolderChoice>,
): { label: string; description: string } {
  const localPolicy =
    !folder.legacy && folder.mode !== 'inherit' && folder.mode !== 'ignore';
  if (localPolicy && folder.mode === 'disabled') {
    return {
      label: 'Disabled here',
      description:
        'Folder organization is stopped at this path. Files are still imported.',
    };
  }
  if (localPolicy) {
    return {
      label: 'Local policy',
      description:
        'This local policy replaces inherited folder metadata for matching paths.',
    };
  }
  let parentPath = folder.relativePath;
  while (parentPath.includes('/')) {
    parentPath = parentPath.slice(0, parentPath.lastIndexOf('/'));
    const parent = byPath.get(parentPath);
    if (
      parent &&
      !parent.legacy &&
      parent.mode !== 'inherit' &&
      parent.mode !== 'ignore'
    ) {
      if (parent.mode === 'disabled') {
        const inherited = {
          label: `Disabled by ${parent.relativePath}`,
          description: `Folder organization is disabled by ${parent.relativePath}. Files in this subtree are still imported.`,
        };
        return folder.legacy
          ? {
              label: `Legacy ${folder.mode}`,
              description: `This saved v1 choice is additive and remains unchanged until you edit this folder. ${inherited.description}`,
            }
          : inherited;
      }
      const inherited = {
        label: `Inherited from ${parent.relativePath}`,
        description: `This folder inherits its organization policy from ${parent.relativePath}. A local policy here would replace the inherited folder metadata.`,
      };
      return folder.legacy
        ? {
            label: `Legacy ${folder.mode}`,
            description: `This saved v1 choice is additive and remains unchanged until you edit this folder. ${inherited.description}`,
          }
        : inherited;
    }
  }
  const hasWholeImportMetadata =
    choices.rootCollection || Boolean(choices.commonTagsText.trim());
  const inherited = hasWholeImportMetadata
    ? {
        label: 'Whole import',
        description:
          'No folder policy applies. Whole-import collection and tags still apply.',
      }
    : {
        label: 'No folder policy',
        description:
          'No folder policy applies here. Model files are still imported without folder metadata.',
      };
  return folder.legacy
    ? {
        label: `Legacy ${folder.mode}`,
        description: `This saved v1 choice is additive and remains unchanged until you edit this folder. ${inherited.description}`,
      }
    : inherited;
}

function OrganizationPreview({
  organization,
}: {
  organization: NonNullable<ImportPreviewResponse['organization']>;
}): React.JSX.Element {
  if (
    organization.affectedModels === 0 &&
    !organization.newCollections.length &&
    !organization.reusedCollections.length &&
    !organization.newTags.length &&
    !organization.reusedTags.length
  ) {
    return (
      <p className="import-preview-status">
        No collections or tags will be added. Model files will still be
        imported.
      </p>
    );
  }
  return (
    <div className="import-preview-content">
      <div className="import-preview-metrics">
        <SummaryStat
          label="Affected models"
          value={organization.affectedModels.toLocaleString()}
        />
        <SummaryStat
          label="Unmatched"
          value={organization.unmatchedModels.toLocaleString()}
        />
        <SummaryStat
          label="New collections"
          value={organization.newCollections.length.toLocaleString()}
        />
        <SummaryStat
          label="Reused collections"
          value={organization.reusedCollections.length.toLocaleString()}
        />
        <SummaryStat
          label="New tags"
          value={organization.newTags.length.toLocaleString()}
        />
        <SummaryStat
          label="Reused tags"
          value={organization.reusedTags.length.toLocaleString()}
        />
      </div>
      <div className="import-preview-names">
        <OrganizationNameList
          label="New collections"
          names={organization.newCollections}
        />
        <OrganizationNameList
          label="Reused collections"
          names={organization.reusedCollections}
        />
        <OrganizationNameList label="New tags" names={organization.newTags} />
        <OrganizationNameList
          label="Reused tags"
          names={organization.reusedTags}
        />
      </div>
      {organization.unmatchedModels ? (
        <p className="import-preview-status">
          {organization.unmatchedModels.toLocaleString()} models have no
          matching folder policy. Whole-import settings still apply.
        </p>
      ) : null}
      {organization.samples.length ? (
        <details className="import-preview-samples">
          <summary>Example model paths and resulting organization</summary>
          <ul>
            {organization.samples.map((sample) => (
              <li key={sample.relativePath}>
                <code>{sample.relativePath}</code>
                <span>
                  Collections: {sample.collections.join(', ') || 'none'} · Tags:{' '}
                  {sample.tags.join(', ') || 'none'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {organization.errors.length ? (
        <div className="import-policy-alert" role="alert">
          <strong>Preview reported errors; import is blocked</strong>
          <ul>
            {organization.errors.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function OrganizationNameList({
  label,
  names,
}: {
  label: string;
  names: readonly string[];
}): React.JSX.Element {
  const visible = names.slice(0, 30);
  if (!names.length) return <></>;
  return (
    <details>
      <summary>
        {label} ({names.length.toLocaleString()})
      </summary>
      {visible.length ? (
        <ul>
          {visible.map((name) => (
            <li key={name}>{name}</li>
          ))}
          {names.length > visible.length ? (
            <li>And {names.length - visible.length} more</li>
          ) : null}
        </ul>
      ) : (
        <p>None</p>
      )}
    </details>
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

function hasTemplatePlaceholder(value: string): boolean {
  return /[{}]/.test(value);
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
      if (
        folder.mode !== 'collection' &&
        !(
          folder.mode === 'recipe' &&
          folder.name.trim() !== '' &&
          !hasTemplatePlaceholder(folder.name)
        )
      ) {
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
    : { collectionId: rememberedId, unresolved: true };
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
  const value = unresolved ? '__unresolved__' : (collectionId ?? '__name__');
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
