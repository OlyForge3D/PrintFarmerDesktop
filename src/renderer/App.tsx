import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppInfoResponse,
  LoadSceneResponse,
  ListServerProfilesResponse,
  LogicalModel,
  UploadJob,
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
import { UploadQueueDialog } from './uploads/UploadQueueDialog';

interface PreviewTarget {
  path: string;
  name: string;
  hash: string | null;
}

const MAX_UPLOAD_SELECTION = 500;

type ModalOwner =
  | 'none'
  | 'profiles'
  | 'import'
  | 'previewPreparation'
  | 'preview'
  | 'uploadQueue';

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
  const [modalOwner, setModalOwnerState] = useState<ModalOwner>('none');
  const [query, setQuery] = useState(defaultLibraryView.query);
  const [filter, setFilter] = useState<FilterKey>(defaultLibraryView.filter);
  const [sort, setSort] = useState<SortKey>(defaultLibraryView.sort);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [selectedHashes, setSelectedHashes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const selectionAnchorRef = useRef<string | null>(null);
  const [uploadJobs, setUploadJobs] = useState<UploadJob[]>([]);
  const [uploadQueueOpen, setUploadQueueOpen] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
  const uploadReturnFocusRef = useRef<HTMLElement | null>(null);
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
  const modalOpen =
    previewOpen ||
    library.importDraft !== null ||
    profilesOpen ||
    uploadQueueOpen;
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
  const handleModelSelection = useCallback(
    (
      model: LogicalModel,
      modifiers: { toggle: boolean; range: boolean } = {
        toggle: false,
        range: false,
      },
    ): void => {
      const visibleHashes = presentation.visibleModels.map((item) => item.hash);
      if (modifiers.range && selectionAnchorRef.current) {
        const anchor = visibleHashes.indexOf(selectionAnchorRef.current);
        const target = visibleHashes.indexOf(model.hash);
        if (anchor >= 0 && target >= 0) {
          const range = visibleHashes.slice(
            Math.min(anchor, target),
            Math.max(anchor, target) + 1,
          );
          setSelectedHashes((current) => {
            const values = modifiers.toggle ? [...current, ...range] : range;
            if (new Set(values).size > MAX_UPLOAD_SELECTION) {
              setAppError('Select at most 500 models per upload job.');
            }
            return new Set([...new Set(values)].slice(0, MAX_UPLOAD_SELECTION));
          });
          setSelectedHash(model.hash);
          return;
        }
      }
      selectionAnchorRef.current = model.hash;
      if (modifiers.toggle) {
        setSelectedHashes((current) => {
          const next = new Set(current);
          if (next.has(model.hash)) next.delete(model.hash);
          else if (next.size < MAX_UPLOAD_SELECTION) next.add(model.hash);
          else setAppError('Select at most 500 models per upload job.');
          if (next.has(model.hash)) {
            setSelectedHash(model.hash);
          } else if (selectedHash === model.hash) {
            setSelectedHash(
              [...visibleHashes].reverse().find((hash) => next.has(hash)) ??
                null,
            );
          }
          return next;
        });
      } else {
        setSelectedHashes(new Set([model.hash]));
        setSelectedHash(model.hash);
      }
    },
    [presentation.visibleModels, selectedHash],
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
  const refreshUploadJobs = useCallback((): void => {
    if (!window.printFarmer.listUploadJobs) return;
    void window.printFarmer
      .listUploadJobs()
      .then(setUploadJobs)
      .catch((err: unknown) =>
        setUploadError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

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
    refreshUploadJobs();
    const interval = setInterval(refreshUploadJobs, 750);
    return () => clearInterval(interval);
  }, [refreshUploadJobs]);

  useEffect(() => {
    const catalogHashes = new Set(library.models.map((model) => model.hash));
    setSelectedHashes((current) => {
      const next = new Set(
        [...current].filter((hash) => catalogHashes.has(hash)),
      );
      return next.size === current.size ? current : next;
    });
    if (selectedHash && !catalogHashes.has(selectedHash)) setSelectedHash(null);
  }, [library.models, selectedHash]);

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
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'a' &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLSelectElement)
      ) {
        event.preventDefault();
        const hashes = presentation.visibleModels
          .map((model) => model.hash)
          .slice(0, MAX_UPLOAD_SELECTION);
        setSelectedHashes(new Set(hashes));
        setSelectedHash(hashes[0] ?? null);
        selectionAnchorRef.current = hashes[0] ?? null;
      }
    };
    document.addEventListener('keydown', focusSearch);
    return () => document.removeEventListener('keydown', focusSearch);
  }, [modalOpen, presentation.visibleModels]);

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

  useEffect(() => {
    if (profilesOpen || !restoreProfileFocusRef.current) return;
    restoreProfileFocusRef.current = false;
    const timeout = setTimeout(() => {
      profileReturnFocusRef.current?.focus();
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
    } else if (modalOwnerRef.current === 'uploadQueue' && !uploadQueueOpen) {
      releaseModal('uploadQueue');
    }
  }, [
    busy,
    importPreparing,
    library.importDraft,
    previewOpen,
    profilesOpen,
    uploadQueueOpen,
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
      setSelectedHashes(new Set([model.hash]));
      selectionAnchorRef.current = model.hash;
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
  const openUploadQueue = (): void => {
    if (modalOwnerRef.current !== 'none') return;
    if (reserveModal('uploadQueue') === null) return;
    uploadReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setUploadError(null);
    refreshUploadJobs();
    setUploadQueueOpen(true);
  };
  const closeUploadQueue = (): void => {
    setUploadQueueOpen(false);
    releaseModal('uploadQueue');
    setTimeout(() => {
      const previous = uploadReturnFocusRef.current;
      const fallback =
        document.querySelector<HTMLElement>('.open-upload-queue');
      (previous?.isConnected ? previous : fallback)?.focus();
    });
  };
  const selectedForUpload = library.models.filter((model) =>
    selectedHashes.has(model.hash),
  );
  const startUpload = (): void => {
    if (
      !activeServer ||
      !activeServer.availability.modelUpload.available ||
      selectedForUpload.length === 0 ||
      !window.printFarmer.startUploadJob ||
      modalOwnerRef.current !== 'none'
    ) {
      return;
    }
    openUploadQueue();
    setUploadBusy(true);
    setUploadError(null);
    void window.printFarmer
      .startUploadJob({
        profileId: activeServer.id,
        hashes: selectedForUpload.map((model) => model.hash),
      })
      .then(() => refreshUploadJobs())
      .catch((err: unknown) =>
        setUploadError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setUploadBusy(false));
  };
  const runUploadAction = (
    action: (request: { jobId: string }) => Promise<unknown>,
    jobId: string,
  ): void => {
    setUploadBusy(true);
    setUploadError(null);
    void action({ jobId })
      .then(() => refreshUploadJobs())
      .catch((err: unknown) =>
        setUploadError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setUploadBusy(false));
  };
  const queuedUploadCount = uploadJobs.reduce(
    (count, job) => count + job.summary.queued + job.summary.uploading,
    0,
  );

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
          busy={workspaceActionsDisabled}
          onQueryChange={setQuery}
          onFilterChange={setFilter}
          onAddFolder={beginImport}
          onRefresh={() => {
            void library.refresh();
          }}
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
              <span className="library-selection-count" aria-live="polite">
                {selectedHashes.size} selected
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
                disabled={workspaceActionsDisabled}
                onClick={() => {
                  void openModelFile();
                }}
              >
                <Icon name="folder" />
                Open file
              </button>
              <button
                type="button"
                className="command-button upload-selected"
                disabled={
                  workspaceActionsDisabled ||
                  selectedForUpload.length === 0 ||
                  !activeServer ||
                  !activeServer.availability.modelUpload.available
                }
                onClick={startUpload}
                title={
                  !activeServer
                    ? 'Connect a PrintFarmer server profile first.'
                    : !activeServer.availability.modelUpload.available
                      ? (activeServer.availability.modelUpload.reason ??
                        'Model upload is unavailable.')
                      : activeServer.availability.modelUpload.mode ===
                          'legacyModelOnly'
                        ? 'Legacy model-only upload; interrupted retries can create duplicates.'
                        : 'Upload selected models with idempotent retry protection.'
                }
              >
                Upload to PrintFarmer
              </button>
              <button
                type="button"
                className="command-button open-upload-queue"
                disabled={workspaceActionsDisabled}
                onClick={openUploadQueue}
              >
                Upload queue{queuedUploadCount ? ` (${queuedUploadCount})` : ''}
              </button>
            </div>
          </header>

          <div
            className="selection-toolbar"
            aria-label="Model selection actions"
          >
            <button
              type="button"
              onClick={() => {
                const allHashes = presentation.visibleModels.map(
                  (model) => model.hash,
                );
                const hashes = allHashes.slice(0, MAX_UPLOAD_SELECTION);
                if (allHashes.length > MAX_UPLOAD_SELECTION) {
                  setAppError(
                    'Selected the first 500 visible models. Start another job for the remainder.',
                  );
                }
                setSelectedHashes(new Set(hashes));
                setSelectedHash(hashes[0] ?? null);
                selectionAnchorRef.current = hashes[0] ?? null;
              }}
              disabled={presentation.visibleModels.length === 0}
            >
              Select all visible
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedHashes(new Set());
                setSelectedHash(null);
                selectionAnchorRef.current = null;
              }}
              disabled={selectedHashes.size === 0}
            >
              Clear selection
            </button>
            <button
              type="button"
              onClick={() => {
                if (
                  !window.confirm(
                    'Reset all approved folders? Catalog files will require reauthorization before they can be opened or uploaded.',
                  )
                ) {
                  return;
                }
                void window.printFarmer
                  .resetApprovedRoots()
                  .then(() => library.refresh())
                  .catch((err: unknown) =>
                    setAppError(
                      err instanceof Error ? err.message : String(err),
                    ),
                  );
              }}
              disabled={workspaceActionsDisabled}
            >
              Reset approved folders
            </button>
            {activeServer?.availability.modelUpload.mode ===
              'legacyModelOnly' && selectedHashes.size > 0 ? (
              <span className="upload-warning">
                Legacy upload: server thumbnails only; interrupted retries may
                duplicate models.
              </span>
            ) : null}
          </div>

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
              selectedHashes={selectedHashes}
              onSelect={handleModelSelection}
              onPreview={previewModel}
              previewDisabled={workspaceActionsDisabled}
              isFavorite={isFavorite}
              onToggleFavorite={(model) => toggleFavorite(model.hash)}
              emptyLabel={emptyState(
                presentation.state,
                query,
                workspaceActionsDisabled,
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
          onMutationSettled={refreshServerProfiles}
          onClose={closeProfiles}
        />
      ) : null}

      {uploadQueueOpen ? (
        <UploadQueueDialog
          jobs={uploadJobs}
          busy={uploadBusy}
          error={uploadError}
          onPause={(jobId) =>
            runUploadAction(
              (request) => window.printFarmer.pauseUploadJob(request),
              jobId,
            )
          }
          onResume={(jobId) =>
            runUploadAction(
              (request) => window.printFarmer.resumeUploadJob(request),
              jobId,
            )
          }
          onCancel={(jobId) =>
            runUploadAction(
              (request) => window.printFarmer.cancelUploadJob(request),
              jobId,
            )
          }
          onRetry={(jobId) =>
            runUploadAction(
              (request) => window.printFarmer.retryUploadJob(request),
              jobId,
            )
          }
          onConfirmLegacyRetry={(jobId) =>
            runUploadAction(
              (request) => window.printFarmer.confirmLegacyUploadRetry(request),
              jobId,
            )
          }
          onRemove={(jobId) =>
            runUploadAction(
              (request) => window.printFarmer.removeUploadJob(request),
              jobId,
            )
          }
          onReset={() => {
            setUploadBusy(true);
            void window.printFarmer
              .resetUploadJobs()
              .then(() => {
                setUploadError(null);
                refreshUploadJobs();
              })
              .catch((err: unknown) =>
                setUploadError(
                  err instanceof Error ? err.message : String(err),
                ),
              )
              .finally(() => setUploadBusy(false));
          }}
          onClose={closeUploadQueue}
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
