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

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfoResponse | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [serverProfiles, setServerProfiles] =
    useState<ListServerProfilesResponse>({
      profiles: [],
      selectedProfileId: null,
    });
  const [profilesOpen, setProfilesOpen] = useState(false);
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
  const restoreProfileFocusRef = useRef(false);
  const importPreparationRef = useRef(false);
  const previewRequestRef = useRef(0);
  const titlebarRef = useRef<HTMLElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const statusbarRef = useRef<HTMLElement | null>(null);

  const library = useLibrary();
  const modalOpen = previewOpen || library.importDraft !== null || profilesOpen;
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
      ),
    [library.models, library.status, library.lastReport, libraryView],
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
    if (!window.printFarmer.listServerProfiles) return;
    window.printFarmer
      .listServerProfiles()
      .then(setServerProfiles)
      .catch((err: unknown) =>
        setAppError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

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
    if (!profilesOpen && restoreProfileFocusRef.current) {
      restoreProfileFocusRef.current = false;
      profileReturnFocusRef.current?.focus();
    }
  }, [profilesOpen]);

  useEffect(() => {
    for (const element of [
      titlebarRef.current,
      workspaceRef.current,
      statusbarRef.current,
    ]) {
      if (modalOpen) {
        element?.setAttribute('inert', '');
      } else {
        element?.removeAttribute('inert');
      }
    }
  }, [modalOpen]);

  const beginImport = useCallback(() => {
    if (
      importPreparationRef.current ||
      busy ||
      previewOpen ||
      library.importDraft
    ) {
      return;
    }
    importPreparationRef.current = true;
    importReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void prepareFolderImport().finally(() => {
      importPreparationRef.current = false;
    });
  }, [busy, library.importDraft, prepareFolderImport, previewOpen]);

  const cancelImport = useCallback(() => {
    dismissFolderImport();
    queueMicrotask(() => {
      const previous = importReturnFocusRef.current;
      const fallback = document.querySelector<HTMLElement>(
        '.sidebar-primary-action',
      );
      (previous?.isConnected ? previous : fallback)?.focus();
    });
  }, [dismissFolderImport]);

  const confirmImport = useCallback(
    async (plan: ImportPlan, remember: boolean): Promise<boolean> => {
      const rootId = importRootId;
      const result = await commitFolderImport({
        rules: plan.rules,
        commonTags: plan.commonTags,
      });
      if (result && rootId) {
        if (remember) {
          rememberImportPlan(rootId, plan, result.resolvedCollections);
        } else {
          forgetImportPlan(rootId);
        }
        queueMicrotask(() => {
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
    [commitFolderImport, importRootId, modelCollections, modelTags],
  );

  const rememberPreviewTrigger = useCallback(() => {
    previewReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, []);

  const loadPreview = useCallback(async (target: PreviewTarget) => {
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
  }, []);

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
      setSelectedHash(model.hash);
      rememberPreviewTrigger();
      void loadPreview({
        path,
        name: modelDisplayName(model),
        hash: model.hash,
      });
    },
    [
      busy,
      library.importDraft,
      loadPreview,
      previewOpen,
      rememberPreviewTrigger,
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
    setAppError(null);
    try {
      const selection = await window.printFarmer.openModelFile();
      if (!selection) {
        return;
      }
      rememberPreviewTrigger();
      const name = selection.path.replace(/^.*[\\/]/, '');
      void loadPreview({ path: selection.path, name, hash: null });
    } catch (err: unknown) {
      setAppError(err instanceof Error ? err.message : String(err));
    }
  }, [
    busy,
    library.importDraft,
    loadPreview,
    previewOpen,
    rememberPreviewTrigger,
  ]);

  const closePreview = useCallback(() => {
    previewRequestRef.current += 1;
    setPreviewOpen(false);
    setPreviewTarget(null);
    setLoadedMesh(null);
    setPreviewError(null);
    setLoading(false);
    queueMicrotask(() => {
      const previous = previewReturnFocusRef.current;
      const fallback = document.querySelector<HTMLElement>(
        '.model-card-button.selected, .sidebar-search input',
      );
      (previous?.isConnected ? previous : fallback)?.focus();
    });
  }, []);

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
  const openProfiles = (): void => {
    profileReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setProfilesOpen(true);
  };
  const closeProfiles = (): void => {
    restoreProfileFocusRef.current = true;
    setProfilesOpen(false);
  };

  return (
    <div className={`app-root${info ? ` platform-${info.platform}` : ''}`}>
      <header
        ref={titlebarRef}
        className="window-titlebar"
        aria-hidden={modalOpen ? 'true' : undefined}
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
        aria-hidden={modalOpen ? 'true' : undefined}
      >
        <LibrarySidebar
          query={query}
          filter={filter}
          counts={counts}
          scanningFolder={scanningFolder}
          lastReport={library.lastReport}
          lastImport={library.lastImport}
          busy={busy}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onAddFolder={beginImport}
          onRefresh={() => {
            void library.refresh();
          }}
          serverProfile={activeServer}
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
                  <option value="name">Name</option>
                  <option value="size">Size</option>
                </select>
              </label>
              <button
                type="button"
                className="command-button"
                disabled={busy}
                onClick={() => {
                  void openModelFile();
                }}
              >
                <Icon name="folder" />
                Open file
              </button>
            </div>
          </header>

          <p
            ref={scanStatusRef}
            tabIndex={-1}
            className="library-live-status"
            role="status"
            aria-live="polite"
            aria-busy={isScanning}
          >
            {isScanning
              ? `Scanning ${scanningFolder ?? 'selected folder'}...`
              : ''}
          </p>

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
              previewDisabled={busy}
              isFavorite={isFavorite}
              onToggleFavorite={(model) => toggleFavorite(model.hash)}
              emptyLabel={emptyState(
                presentation.state,
                query,
                busy,
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
          previewDisabled={busy}
          onToggleFavorite={() => {
            if (selectedModel) {
              toggleFavorite(selectedModel.hash);
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
        aria-hidden={modalOpen ? 'true' : undefined}
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
          onChange={setServerProfiles}
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
        <button type="button" onClick={onAddFolder} disabled={busy}>
          Add your first folder
        </button>
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
