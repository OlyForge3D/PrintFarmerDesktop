import { useEffect, useState } from 'react';
import type { AppInfoResponse } from '@shared/ipc';

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      <section className="app-status" aria-live="polite">
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
