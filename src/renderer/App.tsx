import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AppInfoResponse,
  LoadSceneResponse,
  LogicalModel,
} from '@shared/ipc';
import { ModelViewer, type Projection } from './viewer/ModelViewer';
import { sampleCubeScene } from './viewer/geometry';
import type { SceneMesh } from './viewer/types';
import { useLibrary } from './library/useLibrary';
import { useFavorites } from './library/useFavorites';
import { useModelTags } from './library/useModelTags';
import { useModelCollections } from './library/useModelCollections';
import { ModelGrid } from './library/ModelGrid';
import { TagEditor } from './library/TagEditor';
import { CollectionEditor } from './library/CollectionEditor';
import { PartTree } from './library/PartTree';
import { ModelStats } from './library/ModelStats';
import { modelDisplayName, preferredPath } from './library/model';
import {
  defaultLibraryView,
  selectLibraryView,
  type FilterKey,
  type SortKey,
} from './library/filter';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [projection, setProjection] = useState<Projection>('perspective');
  const [loadedMesh, setLoadedMesh] = useState<LoadSceneResponse | null>(null);
  const [loadedName, setLoadedName] = useState<string | null>(null);
  const [hiddenParts, setHiddenParts] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(false);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [query, setQuery] = useState(defaultLibraryView.query);
  const [filter, setFilter] = useState<FilterKey>(defaultLibraryView.filter);
  const [sort, setSort] = useState<SortKey>(defaultLibraryView.sort);

  const library = useLibrary();
  const { favorites, isFavorite, toggle: toggleFavorite } = useFavorites();
  const modelTags = useModelTags(selectedHash);
  const modelCollections = useModelCollections(selectedHash);

  const visibleModels = useMemo(
    () => selectLibraryView(library.models, { query, filter, sort, favorites }),
    [library.models, query, filter, sort, favorites],
  );

  const sampleMesh = useMemo(() => sampleCubeScene(20), []);
  // The shared LoadSceneResponse is structurally the viewer's SceneMesh.
  const mesh: SceneMesh = loadedMesh ?? sampleMesh;

  useEffect(() => {
    window.printFarmer
      .getAppInfo()
      .then(setInfo)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  const openModel = useCallback(async () => {
    setError(null);
    try {
      const selection = await window.printFarmer.openModelFile();
      if (!selection) {
        return;
      }
      setLoading(true);
      const scene = await window.printFarmer.loadScene({
        path: selection.path,
      });
      setLoadedMesh(scene);
      setLoadedName(selection.path.replace(/^.*[\\/]/, ''));
      setSelectedHash(null);
      setHiddenParts(new Set());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const openFromLibrary = useCallback(async (model: LogicalModel) => {
    const path = preferredPath(model);
    if (!path) {
      return;
    }
    setError(null);
    setSelectedHash(model.hash);
    setLoading(true);
    try {
      const scene = await window.printFarmer.loadScene({ path });
      setLoadedMesh(scene);
      setLoadedName(modelDisplayName(model));
      setHiddenParts(new Set());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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
          : new Set((mesh.parts ?? []).map((_, index) => index)),
      );
    },
    [mesh],
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>PrintFarmer Desktop</h1>
        <p className="tagline">Local-first 3D model library</p>
      </header>

      <section className="app-library" aria-label="Model library">
        <div className="library-toolbar">
          <button
            type="button"
            onClick={() => {
              void library.addFolder();
            }}
            disabled={library.status === 'scanning'}
          >
            {library.status === 'scanning' ? 'Scanning…' : 'Add folder…'}
          </button>
          <button
            type="button"
            onClick={() => {
              void library.refresh();
            }}
            disabled={library.status !== 'idle'}
          >
            Refresh
          </button>
          <span className="library-count">
            {library.models.length}{' '}
            {library.models.length === 1 ? 'model' : 'models'}
          </span>
        </div>

        <div className="library-controls">
          <input
            type="search"
            className="library-search"
            placeholder="Search models…"
            aria-label="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="library-select">
            Show
            <select
              aria-label="Filter models"
              value={filter}
              onChange={(event) => setFilter(event.target.value as FilterKey)}
            >
              <option value="all">All</option>
              <option value="favorites">Favorites</option>
              <option value="duplicates">Duplicates</option>
              <option value="missing">Missing files</option>
            </select>
          </label>
          <label className="library-select">
            Sort
            <select
              aria-label="Sort models"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
            >
              <option value="name">Name</option>
              <option value="size">Size</option>
            </select>
          </label>
        </div>

        {library.error ? (
          <p role="alert" className="status-error">
            {library.error}
          </p>
        ) : null}

        {library.lastReport ? (
          <p className="library-report">
            Last scan: {library.lastReport.added} added,{' '}
            {library.lastReport.changed} changed, {library.lastReport.unchanged}{' '}
            unchanged, {library.lastReport.missing} missing.
          </p>
        ) : null}

        <ModelGrid
          models={visibleModels}
          selectedHash={selectedHash}
          onSelect={(model) => {
            void openFromLibrary(model);
          }}
          isFavorite={isFavorite}
          onToggleFavorite={(model) => toggleFavorite(model.hash)}
          emptyLabel={
            library.models.length > 0
              ? 'No models match your search or filter.'
              : undefined
          }
        />
      </section>

      <section className="app-viewer" aria-label="Model preview">
        <div className="viewer-toolbar">
          <button
            type="button"
            onClick={() => {
              void openModel();
            }}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Open model…'}
          </button>
          <button
            type="button"
            aria-pressed={wireframe}
            onClick={() => setWireframe((value) => !value)}
          >
            {wireframe ? 'Solid' : 'Wireframe'}
          </button>
          <button
            type="button"
            onClick={() =>
              setProjection((value) =>
                value === 'perspective' ? 'orthographic' : 'perspective',
              )
            }
          >
            {projection === 'perspective' ? 'Orthographic' : 'Perspective'}
          </button>
          <span className="viewer-model-name">
            {loadedName ?? 'Sample cube'}
          </span>
        </div>
        <ModelViewer
          mesh={mesh}
          wireframe={wireframe}
          projection={projection}
          hiddenParts={hiddenParts}
          className="viewer-canvas"
        />
        <ModelStats mesh={mesh} />
        {(mesh.parts?.length ?? 0) > 1 ? (
          <div className="viewer-parts">
            <PartTree
              parts={mesh.parts ?? []}
              hidden={hiddenParts}
              onToggle={togglePart}
              onToggleAll={toggleAllParts}
            />
          </div>
        ) : null}
        {selectedHash ? (
          <div className="viewer-tags">
            <h2 className="viewer-tags-title">Tags</h2>
            <TagEditor
              tags={modelTags.tags}
              onAdd={(name) => {
                void modelTags.add(name);
              }}
              onRemove={(tagId) => {
                void modelTags.remove(tagId);
              }}
            />
            {modelTags.error ? (
              <p role="alert" className="status-error">
                {modelTags.error}
              </p>
            ) : null}
            <h2 className="viewer-tags-title">Collections</h2>
            <CollectionEditor
              all={modelCollections.all}
              membership={modelCollections.membership}
              onToggle={(id) => {
                void modelCollections.toggle(id);
              }}
              onCreate={(name) => {
                void modelCollections.createAndAdd(name);
              }}
            />
            {modelCollections.error ? (
              <p role="alert" className="status-error">
                {modelCollections.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section
        className="app-status"
        aria-live="polite"
        aria-label="App status"
      >
        {error ? (
          <p role="alert" className="status-error">
            {error}
          </p>
        ) : info ? (
          <dl className="status-grid">
            <dt>App version</dt>
            <dd>{info.appVersion}</dd>
            <dt>Platform</dt>
            <dd>{info.platform}</dd>
            <dt>Electron</dt>
            <dd>{info.electronVersion}</dd>
            <dt>IPC contract</dt>
            <dd>v{info.contractVersion}</dd>
          </dl>
        ) : (
          <p>Connecting to main process…</p>
        )}
      </section>
    </main>
  );
}
