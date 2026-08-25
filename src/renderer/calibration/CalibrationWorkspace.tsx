import { useEffect } from 'react';
import { CalibrationDashboard } from './CalibrationDashboard';
import {
  CalibrationWorkspaceStoreProvider,
  useCalibrationWorkspaceStore,
} from './CalibrationWorkspaceStore';
import { FilamentCalibrationWizard } from './FilamentCalibrationWizard';
import type { CalibrationWorkspaceProps } from './workspaceTypes';
import './calibrationWorkspace.css';

function WorkspaceContent(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const { view } = store;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      document
        .querySelector<HTMLElement>('.cal-workspace-content [data-cal-heading]')
        ?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [view]);

  return (
    <div className="calibration-workspace" aria-busy={store.loading}>
      <nav className="cal-workspace-nav" aria-label="Calibration views">
        <h2 className="cal-nav-label">Calibration</h2>
        <button
          type="button"
          onClick={() => void store.navigate('dashboard')}
          aria-current={store.view === 'dashboard' ? 'page' : undefined}
        >
          Dashboard
        </button>
      </nav>

      <div className="cal-global-live" role="status" aria-live="polite">
        {store.liveMessage}
      </div>
      {store.alertMessage ? (
        <div className="cal-global-alert" role="alert">
          {store.alertMessage}
        </div>
      ) : null}

      <main
        id="calibration-main"
        className="cal-workspace-content"
        aria-label="Filament calibration workspace"
      >
        {store.view === 'dashboard' ? <CalibrationDashboard /> : null}
        {store.view === 'filamentCalibration' ? (
          <FilamentCalibrationWizard />
        ) : null}
      </main>
    </div>
  );
}

export function CalibrationWorkspace(
  props: CalibrationWorkspaceProps,
): React.JSX.Element {
  return (
    <CalibrationWorkspaceStoreProvider {...props}>
      <WorkspaceContent />
    </CalibrationWorkspaceStoreProvider>
  );
}
