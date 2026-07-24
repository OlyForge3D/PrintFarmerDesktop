import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppInfoResponse,
  LoadSceneResponse,
  ListServerProfilesResponse,
  LogicalModel,
  VendorMetadata,
} from '@shared/ipc';
import { useLibrary } from './library/useLibrary';
import { useFavorites } from './library/useFavorites';
import { useModelTags } from './library/useModelTags';
import { useModelCollections } from './library/useModelCollections';
import { ModelGrid } from './library/ModelGrid';
import { PropertiesInspector } from './library/PropertiesInspector';
import {
  FILTER_LABELS,
  LibrarySidebar,
  type LibraryCounts,
} from './library/LibrarySidebar';
import { isAvailable, modelDisplayName, preferredPath } from './library/model';
import {
  defaultLibraryView,
  type FilterKey,
  type SortKey,
} from './library/filter';
import { folderBasename, libraryPresentation } from './library/presentation';
import { useVendorMetadata } from './library/useVendorMetadata';
import { computeSceneStats, type SceneStats } from './library/sceneStats';
import { ImportWizard } from './library/ImportWizard';
import { LibraryOnboarding } from './library/LibraryOnboarding';
import {
  forgetImportPlan,
  rememberImportPlan,
  type ImportPlan,
} from './library/importPlan';
import { PreviewWorkspace } from './viewer/PreviewWorkspace';
import type { Projection } from './viewer/ModelViewer';
import { Icon } from './ui/Icon';
import appIconUrl from '../../assets/icon.png';
import { ServerProfilesDialog } from './serverProfiles/ServerProfilesDialog';

interface PreviewTarget {
  path: string;
  name: string;
  hash: string | null;
}

type ModalOwner =
  'none' | 'profiles' | 'import' | 'previewPreparation' | 'preview';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfoResponse | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [serverProfiles, setServerProfiles] =
    useState<ListServerProfilesResponse>({
      profiles: [],
      selectedProfileId: null,
    });
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [importPreparing, setImportPreparing] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [modalOwner, setModalOwnerState] = useState<ModalOwner>('none');
  const [query, setQuery] = useState(defaultLibraryView.query);
  const [filter, setFilter] = useState<FilterKey>(defaultLibraryView.filter);
  const [sort, setSort] = useState<SortKey>(defaultLibraryView.sort);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedMesh, setLoadedMesh] = useState<LoadSceneResponse | null>(null);
  const [cachedStats, setCachedStats] = useState<{
    hash: string;
    stats: SceneStats;
  } | null>(null);
  const [cachedVendor, setCachedVendor] = useState<{
    hash: string;
    metadata: VendorMetadata;
  } | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [projection, setProjection] = useState<Projection>('perspective');
  const [resetToken, setResetToken] = useState(0);
  const [hiddenParts, setHiddenParts] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const previewReturnFocusRef = useRef<HTMLElement | null>(null);
  const importReturnFocusRef = useRef<HTMLElement | null>(null);
  const profileReturnFocusRef = useRef<HTMLElement | null>(null);
  const onboardingReturnFocusRef = useRef<HTMLElement | null>(null);
  const restoreProfileFocusRef = useRef(false);
  const importPreparationRef = useRef(false);
  const modalOwnerRef = useRef<ModalOwner>('none');
  const modalOwnerEpochRef = useRef(0);
  const previewRequestRef = useRef(0);
  const profilesListRequestRef = useRef(0);
  const titlebarRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const statusbarRef = useRef<HTMLElement | null>(null);

  const library = useLibrary();
  const setModalOwner = useCallback((owner: ModalOwner): void => {
    modalOwnerRef.current = owner;
    setModalOwnerState(owner);
  }, []);
  const reserveModal = useCallback(
    (owner: Exclude<ModalOwner, 'none'>): number | null => {
      if (modalOwnerRef.current !== 'none') return null;
      const epoch = ++modalOwnerEpochRef.current;
      setModalOwner(owner);
      return epoch;
    },
    [setModalOwner],
  );
  const releaseModal = useCallback(
    (owner: Exclude<ModalOwner, 'none'>): void => {
      if (modalOwnerRef.current === owner) {
        modalOwnerEpochRef.current += 1;
        setModalOwner('none');
      }
    },
    [setModalOwner],
  );
  const releaseAndRestoreTrigger = useCallback(
    (
      owner: 'import' | 'previewPreparation',
      ownerEpoch: number,
      trigger: React.RefObject<HTMLElement | null>,
      fallbackSelector: string,
    ): void => {
      if (
        modalOwnerRef.current !== owner ||
        modalOwnerEpochRef.current !== ownerEpoch
      ) {
        return;
      }
      releaseModal(owner);
      const releasedEpoch = modalOwnerEpochRef.current;
      const focusWhenEnabled = (attempt: number): void => {
        setTimeout(() => {
          if (
            modalOwnerRef.current !== 'none' ||
            modalOwnerEpochRef.current !== releasedEpoch
          ) {
            return;
          }
          const previous = trigger.current;
          const fallback =
            document.querySelector<HTMLElement>(fallbackSelector);
          const target = previous?.isConnected ? previous : fallback;
          if (target && !target.matches(':disabled')) {
            target.focus();
          } else if (attempt < 3) {
            focusWhenEnabled(attempt + 1);
          }
        }, 0);
      };
      focusWhenEnabled(0);
    },
    [releaseModal],
  );
  const onboardingOpen =
    !onboardingDismissed &&
    library.status !== 'loading' &&
    !profilesOpen &&
    !previewOpen &&
    !library.importDraft &&
    !importPreparing &&
    library.sourceRoots.length === 0;
  const modalOpen =
    onboardingOpen ||
    previewOpen ||
    library.importDraft !== null ||
    profilesOpen;
  const backgroundExcluded =
    previewOpen || library.importDraft !== null || profilesOpen;
  const prepareFolderImport = library.addFolder;
  const dismissFolderImport = library.cancelImport;
  const commitFolderImport = library.confirmImport;
  const importRootId = library.importDraft?.rootId;
  const { favorites, isFavorite, toggle: toggleFavorite } = useFavorites();
  const selectedModel = useMemo(
    () =>
      selectedHash
        ? (library.models.find((model) => model.hash === selectedHash) ?? null)
        : null,
    [library.models, selectedHash],
  );
  const selectedPath =
    selectedModel && isAvailable(selectedModel)
      ? preferredPath(selectedModel)
      : null;
  const modelTags = useModelTags(selectedHash);
  const modelCollections = useModelCollections(selectedHash);
  const selectedVendorState = useVendorMetadata(
    selectedPath,
    selectedModel?.format ?? null,
  );
  const previewUsesSelectedVendor =
    previewTarget !== null && previewTarget.path === selectedPath;
  const previewVendorState = useVendorMetadata(
    previewTarget && !previewUsesSelectedVendor ? previewTarget.path : null,
    previewTarget && !previewUsesSelectedVendor
      ? (loadedMesh?.sourceFormat ?? null)
      : null,
  );
  const selectedVendor =
    selectedPath && selectedVendorState.sourcePath === selectedPath
      ? selectedVendorState.metadata
      : null;
  const previewVendor =
    previewTarget && previewUsesSelectedVendor
      ? selectedVendor
      : previewTarget && previewVendorState.sourcePath === previewTarget.path
        ? previewVendorState.metadata
        : null;

  useEffect(() => {
    if (selectedModel && selectedVendor) {
      setCachedVendor({
        hash: selectedModel.hash,
        metadata: selectedVendor,
      });
    }
  }, [selectedModel, selectedVendor]);

  useEffect(() => {
    if (previewTarget?.hash && previewVendor) {
      setCachedVendor({
        hash: previewTarget.hash,
        metadata: previewVendor,
      });
    }
  }, [previewTarget, previewVendor]);

  const libraryView = useMemo(
    () => ({ query, filter, sort, favorites }),
    [query, filter, sort, favorites],
  );
  const presentation = useMemo(
    () =>
      libraryPresentation(
        library.models,
        library.status,
        library.lastReport,
        libraryView,
        library.sourceRoots.length,
      ),
    [
      library.lastReport,
      library.models,
      library.sourceRoots.length,
      library.status,
      libraryView,
    ],
  );
  const counts = useMemo<LibraryCounts>(
    () => ({
      all: library.models.length,
      favorites: library.models.filter((model) => favorites.has(model.hash))
        .length,
      stl: library.models.filter((model) => model.format === 'stl').length,
      threeMf: library.models.filter((model) => model.format === 'threeMf')
        .length,
      obj: library.models.filter((model) => model.format === 'obj').length,
      duplicates: library.models.filter((model) => model.locations.length > 1)
        .length,
      missing: library.models.filter((model) => !isAvailable(model)).length,
    }),
    [library.models, favorites],
  );

  const isScanning = library.status === 'scanning';
  const busy = library.status !== 'idle';
  const scanningFolder = folderBasename(library.scanningPath);
  const scanStatusRef = useRef<HTMLParagraphElement | null>(null);
  const wasScanningRef = useRef(false);
  const refreshServerProfiles = useCallback((): void => {
    if (!window.printFarmer.listServerProfiles) return;
    const requestId = ++profilesListRequestRef.current;
    void window.printFarmer
      .listServerProfiles()
      .then((latest) => {
        if (profilesListRequestRef.current === requestId) {
          setServerProfiles(latest);
        }
      })
      .catch((err: unknown) => {
        if (profilesListRequestRef.current === requestId) {
          setAppError(err instanceof Error ? err.message : String(err));
        }
      });
  }, []);

  useEffect(() => {
    if (library.sourceRoots.length > 0) {
      setOnboardingDismissed(false);
    }
  }, [library.sourceRoots.length]);

  useEffect(() => {
    if (isScanning && !wasScanningRef.current) {
      scanStatusRef.current?.focus();
    }
    wasScanningRef.current = isScanning;
  }, [isScanning]);

  useEffect(() => {
    window.printFarmer
      .getAppInfo()
      .then(setInfo)
      .catch((err: unknown) =>
        setAppError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  useEffect(() => {
    refreshServerProfiles();
  }, [refreshServerProfiles]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (modalOpen) {
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        document
          .querySelector<HTMLInputElement>('.sidebar-search input')
          ?.focus();
      }
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, [modalOpen]);

  useEffect(() => {
    for (const element of [
      titlebarRef.current,
      workspaceRef.current,
      statusbarRef.current,
    ]) {
      if (backgroundExcluded) {
        element?.setAttribute('inert', '');
      } else {
        element?.removeAttribute('inert');
      }
    }
  }, [backgroundExcluded]);

  useEffect(() => {
    if (profilesOpen || !restoreProfileFocusRef.current) return;
    restoreProfileFocusRef.current = false;
    const timeout = setTimeout(() => {
      const previous = profileReturnFocusRef.current;
      const fallback = document.querySelector<HTMLElement>(
        '.server-profile-entry',
      );
      (previous?.isConnected ? previous : fallback)?.focus();
    }, 0);
    return () => clearTimeout(timeout);
  }, [profilesOpen]);

  useEffect(() => {
    if (modalOwnerRef.current === 'profiles' && !profilesOpen) {
      releaseModal('profiles');
    } else if (
      modalOwnerRef.current === 'import' &&
      !importPreparing &&
      !library.importDraft &&
      !busy
    ) {
      releaseModal('import');
    } else if (modalOwnerRef.current === 'preview' && !previewOpen) {
      releaseModal('preview');
    }
  }, [
    busy,
    importPreparing,
    library.importDraft,
    previewOpen,
    profilesOpen,
    releaseModal,
  ]);

  const beginImport = useCallback(() => {
    if (
      importPreparationRef.current ||
      busy ||
      previewOpen ||
      library.importDraft
    ) {
      return;
    }
    const ownerEpoch = reserveModal('import');
    if (ownerEpoch === null) return;
    importPreparationRef.current = true;
    setImportPreparing(true);
    importReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void prepareFolderImport().then(
      (opened) => {
        importPreparationRef.current = false;
        setImportPreparing(false);
        if (!opened) {
          releaseAndRestoreTrigger(
            'import',
            ownerEpoch,
            importReturnFocusRef,
            '.sidebar-primary-action',
          );
        }
      },
      () => {
        importPreparationRef.current = false;
        setImportPreparing(false);
        releaseAndRestoreTrigger(
          'import',
          ownerEpoch,
          importReturnFocusRef,
          '.sidebar-primary-action',
        );
      },
    );
  }, [
    busy,
    library.importDraft,
    prepareFolderImport,
    previewOpen,
    releaseAndRestoreTrigger,
    reserveModal,
  ]);

  const cancelImport = useCallback(() => {
    dismissFolderImport();
    releaseModal('import');
    setTimeout(() => {
      const previous = importReturnFocusRef.current;
      const fallback = document.querySelector<HTMLElement>(
        '.sidebar-primary-action',
      );
      (previous?.isConnected ? previous : fallback)?.focus();
    });
  }, [dismissFolderImport, releaseModal]);

  const confirmImport = useCallback(
    async (plan: ImportPlan, remember: boolean): Promise<boolean> => {
      const rootId = importRootId;
      const result = await commitFolderImport({
        rules: plan.rules,
        commonTags: plan.commonTags,
      });
      if (result && rootId) {
        releaseModal('import');
        if (remember) {
          rememberImportPlan(rootId, plan, result.resolvedCollections);
        } else {
          forgetImportPlan(rootId);
        }
        setTimeout(() => {
          const previous = importReturnFocusRef.current;
          const fallback = document.querySelector<HTMLElement>(
            '.sidebar-primary-action',
          );
          (previous?.isConnected ? previous : fallback)?.focus();
        });
        await Promise.all([modelTags.refresh(), modelCollections.refresh()]);
      }
      return result !== null;
    },
    [
      commitFolderImport,
      importRootId,
      modelCollections,
      modelTags,
      releaseModal,
    ],
  );

  const rememberPreviewTrigger = useCallback(() => {
    previewReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, []);

  const loadPreview = useCallback(
    async (target: PreviewTarget, entryEpoch?: number) => {
      if (entryEpoch !== undefined) {
        if (
          modalOwnerRef.current !== 'previewPreparation' ||
          modalOwnerEpochRef.current !== entryEpoch
        ) {
          return;
        }
        setModalOwner('preview');
      } else if (modalOwnerRef.current !== 'preview') {
        return;
      }
      const requestId = ++previewRequestRef.current;
      setPreviewTarget(target);
      setPreviewOpen(true);
      setPreviewError(null);
      setLoadedMesh(null);
      setHiddenParts(new Set());
      setLoading(true);
      try {
        const scene = await window.printFarmer.loadScene({ path: target.path });
        if (previewRequestRef.current === requestId) {
          setLoadedMesh(scene);
          if (target.hash) {
            setCachedStats({
              hash: target.hash,
              stats: computeSceneStats(scene),
            });
          }
        }
      } catch (err: unknown) {
        if (previewRequestRef.current === requestId) {
          setPreviewError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (previewRequestRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [setModalOwner],
  );

  const previewModel = useCallback(
    (model: LogicalModel) => {
      if (
        importPreparationRef.current ||
        busy ||
        previewOpen ||
        library.importDraft ||
        !isAvailable(model)
      ) {
        return;
      }
      const path = preferredPath(model);
      if (!path) {
        return;
      }
      const entryEpoch = reserveModal('previewPreparation');
      if (entryEpoch === null) return;
      setSelectedHash(model.hash);
      rememberPreviewTrigger();
      void loadPreview(
        {
          path,
          name: modelDisplayName(model),
          hash: model.hash,
        },
        entryEpoch,
      );
    },
    [
      busy,
      library.importDraft,
      loadPreview,
      previewOpen,
      rememberPreviewTrigger,
      reserveModal,
    ],
  );

  const openModelFile = useCallback(async () => {
    if (
      importPreparationRef.current ||
      busy ||
      previewOpen ||
      library.importDraft
    ) {
      return;
    }
    const entryEpoch = reserveModal('previewPreparation');
    if (entryEpoch === null) return;
    setAppError(null);
    rememberPreviewTrigger();
    try {
      const selection = await window.printFarmer.openModelFile();
      if (
        modalOwnerRef.current !== 'previewPreparation' ||
        modalOwnerEpochRef.current !== entryEpoch
      ) {
        return;
      }
      if (!selection) {
        releaseAndRestoreTrigger(
          'previewPreparation',
          entryEpoch,
          previewReturnFocusRef,
          '.library-commandbar .command-button',
        );
        return;
      }
      const name = selection.path.replace(/^.*[\\/]/, '');
      void loadPreview({ path: selection.path, name, hash: null }, entryEpoch);
    } catch (err: unknown) {
      if (
        modalOwnerRef.current === 'previewPreparation' &&
        modalOwnerEpochRef.current === entryEpoch
      ) {
        setAppError(err instanceof Error ? err.message : String(err));
        releaseAndRestoreTrigger(
          'previewPreparation',
          entryEpoch,
          previewReturnFocusRef,
          '.library-commandbar .command-button',
        );
      }
    }
  }, [
    busy,
    library.importDraft,
    loadPreview,
    previewOpen,
    releaseAndRestoreTrigger,
    rememberPreviewTrigger,
    reserveModal,
  ]);

  const closePreview = useCallback(() => {
    previewRequestRef.current += 1;
    setPreviewOpen(false);
    setPreviewTarget(null);
    setLoadedMesh(null);
    setPreviewError(null);
    setLoading(false);
    releaseModal('preview');
    setTimeout(() => {
      const previous = previewReturnFocusRef.current;
      const fallback = document.querySelector<HTMLElement>(
        '.model-card-button.selected, .sidebar-search input',
      );
      (previous?.isConnected ? previous : fallback)?.focus();
    });
  }, [releaseModal]);

  const retryPreview = useCallback(() => {
    if (previewTarget) {
      void loadPreview(previewTarget);
    }
  }, [loadPreview, previewTarget]);

  const togglePart = useCallback((index: number) => {
    setHiddenParts((current) => {
      const next = new Set(current);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const toggleAllParts = useCallback(
    (visible: boolean) => {
      setHiddenParts(
        visible
          ? new Set()
          : new Set((loadedMesh?.parts ?? []).map((_, index) => index)),
      );
    },
    [loadedMesh],
  );

  const inspectedStats =
    selectedHash && cachedStats?.hash === selectedHash
      ? cachedStats.stats
      : null;
  const inspectedVendor =
    selectedVendor ??
    (selectedHash && cachedVendor?.hash === selectedHash
      ? cachedVendor.metadata
      : null);
  const organizationError = modelTags.error ?? modelCollections.error;
  const activeServer =
    serverProfiles.profiles.find(
      (profile) => profile.id === serverProfiles.selectedProfileId,
    ) ?? null;
  const workspaceActionsDisabled = busy || modalOwner !== 'none';
  const serverProfilesDisabled =
    workspaceActionsDisabled ||
    importPreparing ||
    previewOpen ||
    library.importDraft !== null ||
    profilesOpen;
  const openProfiles = (): void => {
    if (serverProfilesDisabled) return;
    if (reserveModal('profiles') === null) return;
    if (onboardingOpen) {
      setOnboardingDismissed(true);
    }
    refreshServerProfiles();
    profileReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setProfilesOpen(true);
  };
  const closeProfiles = (): void => {
    restoreProfileFocusRef.current = true;
    setProfilesOpen(false);
    releaseModal('profiles');
  };
  const dismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true);
    setTimeout(() => {
      const previous = onboardingReturnFocusRef.current;
      const fallback = document.querySelector<HTMLElement>(
        '.sidebar-primary-action',
      );
      (previous?.isConnected ? previous : fallback)?.focus();
    });
  }, []);

  useEffect(() => {
    if (!onboardingOpen) return;
    onboardingReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, [onboardingOpen]);

  return (
    <div className={`app-root${info ? ` platform-${info.platform}` : ''}`}>
      <header
        ref={titlebarRef}
        className="window-titlebar"
        aria-hidden={backgroundExcluded ? 'true' : undefined}
      >
        <div className="product-identity">
          <img
            className="product-icon"
            src={appIconUrl}
            alt=""
            width={20}
            height={20}
            draggable={false}
          />
          <h1>PrintFarmer Desktop</h1>
        </div>
        <div className="titlebar-drag-region" aria-hidden="true" />
      </header>

      <div
        ref={workspaceRef}
        className="workspace"
        aria-hidden={backgroundExcluded ? 'true' : undefined}
      >
        <LibrarySidebar
          query={query}
          filter={filter}
          counts={counts}
          scanningFolder={scanningFolder}
          lastReport={library.lastReport}
          lastImport={library.lastImport}
          busy={workspaceActionsDisabled}
          sourceRoots={library.sourceRoots}
          scanActivity={library.scanActivity}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onAddFolder={beginImport}
          onRefresh={() => {
            void library.refresh();
          }}
          onRescanRoot={(rootId) => {
            void library.rescanRoot(rootId);
          }}
          onRemoveRoot={library.removeRoot}
          serverProfile={activeServer}
          serverProfilesDisabled={serverProfilesDisabled}
          onManageServerProfiles={openProfiles}
        />

        <main className="library-pane" aria-label="Model library">
          <header className="library-commandbar">
            <div>
              <p className="pane-eyebrow">Model library</p>
              <h2>{FILTER_LABELS[filter]}</h2>
              <span className="library-result-count">
                {presentation.visibleModels.length} of {library.models.length}
              </span>
            </div>
            <div className="library-command-actions">
              <label className="sort-control">
                <span>Sort by</span>
                <select
                  aria-label="Sort models"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortKey)}
                >
                  <option value="name-asc">Name (A-Z)</option>
                  <option value="name-desc">Name (Z-A)</option>
                  <option value="size-asc">Size (smallest first)</option>
                  <option value="size-desc">Size (largest first)</option>
                  <option value="date-desc">Date (newest first)</option>
                  <option value="date-asc">Date (oldest first)</option>
                </select>
              </label>
              <button
                type="button"
                className="command-button"
                disabled={workspaceActionsDisabled}
                onClick={() => {
                  void openModelFile();
                }}
              >
                <Icon name="folder" />
                Open file
              </button>
            </div>
          </header>

          <div
            ref={scanStatusRef}
            tabIndex={-1}
            className="library-live-status"
            role="status"
            aria-live="polite"
            aria-busy={isScanning}
          >
            {isScanning ? (
              <>
                <strong>
                  {library.scanActivity.label ??
                    `Scanning ${scanningFolder ?? 'selected folder'}`}
                </strong>
                <span>
                  {library.scanActivity.estimatedTotal !== null
                    ? `${library.scanActivity.estimatedTotal} known models queued`
                    : 'Progress will update when the scan completes'}
                </span>
                <progress aria-label="Current scan progress" />
              </>
            ) : library.lastReport ? (
              <>
                <strong>
                  {library.lastReport.missing > 0
                    ? `${library.lastReport.missing} files missing`
                    : library.lastReport.added > 0 ||
                        library.lastReport.changed > 0
                      ? 'Library updated'
                      : 'Library is up to date'}
                </strong>
                <span>
                  {library.lastReport.added} added •{' '}
                  {library.lastReport.changed} changed •{' '}
                  {library.lastReport.missing} missing
                </span>
              </>
            ) : null}
          </div>

          {library.error ? (
            <div className="library-alert" role="alert">
              <Icon name="missing" />
              <span>{library.error}</span>
              <button
                type="button"
                onClick={() => {
                  void library.refresh();
                }}
              >
                Retry
              </button>
            </div>
          ) : null}

          <div className="library-content">
            <ModelGrid
              models={presentation.visibleModels}
              selectedHash={selectedHash}
              onSelect={(model) => setSelectedHash(model.hash)}
              onPreview={previewModel}
              previewDisabled={workspaceActionsDisabled}
              isFavorite={isFavorite}
              onToggleFavorite={(model) => {
                void toggleFavorite(model.hash);
              }}
              emptyLabel={emptyState(
                presentation.state,
                query,
                workspaceActionsDisabled,
                !onboardingOpen,
                () => {
                  beginImport();
                },
                () => {
                  setQuery('');
                  setFilter('all');
                },
              )}
            />
          </div>
        </main>

        <PropertiesInspector
          model={selectedModel}
          favorite={selectedModel ? isFavorite(selectedModel.hash) : false}
          stats={inspectedStats}
          vendorMetadata={inspectedVendor}
          tags={modelTags.tags}
          collections={modelCollections.all}
          collectionMembership={modelCollections.membership}
          organizationError={organizationError}
          previewDisabled={workspaceActionsDisabled}
          onToggleFavorite={() => {
            if (selectedModel) {
              void toggleFavorite(selectedModel.hash);
            }
          }}
          onPreview={() => {
            if (selectedModel) {
              previewModel(selectedModel);
            }
          }}
          onAddTag={(name) => {
            void modelTags.add(name);
          }}
          onRemoveTag={(tagId) => {
            void modelTags.remove(tagId);
          }}
          onToggleCollection={(id) => {
            void modelCollections.toggle(id);
          }}
          onCreateCollection={(name) => {
            void modelCollections.createAndAdd(name);
          }}
        />
      </div>

      <footer
        ref={statusbarRef}
        className="app-statusbar"
        aria-label="Application status"
        aria-hidden={backgroundExcluded ? 'true' : undefined}
      >
        <span>
          {library.status === 'loading'
            ? 'Loading catalog'
            : library.status === 'preparing'
              ? 'Analyzing source'
              : isScanning
                ? 'Scanning source'
                : 'Ready'}
        </span>
        {appError ? (
          <span className="statusbar-error" role="alert">
            {appError}
          </span>
        ) : null}
        <span className="statusbar-spacer" />
        {info ? (
          <span>
            v{info.appVersion} / {info.platform}
          </span>
        ) : null}
      </footer>

      {library.importDraft ? (
        <ImportWizard
          key={library.importDraft.rootId}
          draft={library.importDraft}
          busy={library.status === 'scanning'}
          error={library.error}
          onCancel={cancelImport}
          onConfirm={confirmImport}
        />
      ) : null}

      {onboardingOpen ? (
        <LibraryOnboarding
          busy={importPreparing}
          onAddFolder={beginImport}
          onClose={dismissOnboarding}
        />
      ) : null}

      {previewOpen && previewTarget ? (
        <PreviewWorkspace
          name={previewTarget.name}
          loading={loading}
          error={previewError}
          mesh={loadedMesh}
          vendorMetadata={previewVendor}
          wireframe={wireframe}
          projection={projection}
          resetToken={resetToken}
          hiddenParts={hiddenParts}
          onClose={closePreview}
          onRetry={retryPreview}
          onToggleWireframe={() => setWireframe((value) => !value)}
          onToggleProjection={() =>
            setProjection((value) =>
              value === 'perspective' ? 'orthographic' : 'perspective',
            )
          }
          onReset={() => setResetToken((value) => value + 1)}
          onTogglePart={togglePart}
          onToggleAllParts={toggleAllParts}
        />
      ) : null}

      {profilesOpen ? (
        <ServerProfilesDialog
          profiles={serverProfiles}
          onMutationSettled={refreshServerProfiles}
          onClose={closeProfiles}
        />
      ) : null}
    </div>
  );
}

function emptyState(
  state:
    'onboarding' | 'scanning' | 'empty-scan' | 'empty-filter' | 'populated',
  query: string,
  busy: boolean,
  showOnboardingAction: boolean,
  onAddFolder: () => void,
  onClear: () => void,
): React.ReactNode {
  if (state === 'onboarding') {
    return (
      <div className="purposeful-empty-state">
        <Icon name="folder" size={30} />
        <h3>Build your model library</h3>
        <p>
          Add a folder containing STL, 3MF, or OBJ files. Your catalog stays
          local to this computer.
        </p>
        {showOnboardingAction ? (
          <button type="button" onClick={onAddFolder} disabled={busy}>
            Add your first folder
          </button>
        ) : null}
      </div>
    );
  }
  if (state === 'scanning') {
    return (
      <div className="purposeful-empty-state">
        <span className="loading-indicator" aria-hidden="true" />
        <h3>Scanning your source</h3>
        <p>Models will appear here when indexing is complete.</p>
      </div>
    );
  }
  if (state === 'empty-filter') {
    return (
      <div className="purposeful-empty-state">
        <Icon name="search" size={28} />
        <h3>No matching models</h3>
        <p>{query ? `Nothing matches "${query}".` : 'This view is empty.'}</p>
        <button type="button" onClick={onClear}>
          Clear filters
        </button>
      </div>
    );
  }
  if (state === 'empty-scan') {
    return (
      <div className="purposeful-empty-state">
        <Icon name="cube" size={30} />
        <h3>No supported models found</h3>
        <p>Choose another folder containing STL, 3MF, or OBJ files.</p>
        <button type="button" onClick={onAddFolder} disabled={busy}>
          Add another folder
        </button>
      </div>
    );
  }
  return undefined;
}
