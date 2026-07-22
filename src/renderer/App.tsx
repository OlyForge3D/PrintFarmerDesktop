import { useEffect, useMemo, useState } from 'react';
import type { AppInfoResponse } from '@shared/ipc';
import { ModelViewer, type Projection } from './viewer/ModelViewer';
import { sampleCubeScene } from './viewer/geometry';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [projection, setProjection] = useState<Projection>('perspective');

  const mesh = useMemo(() => sampleCubeScene(20), []);

  useEffect(() => {
    window.printFarmer
      .getAppInfo()
      .then(setInfo)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>PrintFarmer Desktop</h1>
        <p className="tagline">Local-first 3D model library</p>
      </header>

      <section className="app-viewer" aria-label="Model preview">
        <div className="viewer-toolbar">
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
