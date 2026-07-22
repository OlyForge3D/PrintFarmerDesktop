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
import { ModelGrid } from './library/ModelGrid';
import { modelDisplayName, preferredPath } from './library/model';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [projection, setProjection] = useState<Projection>('perspective');
  const [loadedMesh, setLoadedMesh] = useState<LoadSceneResponse | null>(null);
  const [loadedName, setLoadedName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);

  const library = useLibrary();

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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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
          models={library.models}
          selectedHash={selectedHash}
          onSelect={(model) => {
            void openFromLibrary(model);
          }}
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
          className="viewer-canvas"
        />
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
