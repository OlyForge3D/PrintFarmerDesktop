import { useEffect } from 'react';
import { CalibrationDashboard } from './CalibrationDashboard';
import {
  CalibrationReport,
  CalibrationProfileEntry,
} from './CalibrationReportAndProfile';
import { CalibrationStepWorkflow } from './CalibrationStepWorkflow';
import {
  CalibrationWorkspaceStoreProvider,
  useCalibrationWorkspaceStore,
} from './CalibrationWorkspaceStore';
import { NewCalibrationProject } from './NewCalibrationProject';
import { ProjectOverview } from './ProjectOverview';
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

  // The profile-patch view once triggered a farm-wide profile load of its own.
  // It has an open project, so the printer is already known and its profiles
  // are resolved through that project's own context refresh; there is nothing
  // left here that could be fetched without naming a printer.

  return (
    <div className="calibration-workspace" aria-busy={store.loading}>
      <nav className="cal-workspace-nav" aria-label="Calibration views">
        <button
          type="button"
          onClick={() => void store.navigate('dashboard')}
          aria-current={store.view === 'dashboard' ? 'page' : undefined}
        >
          Dashboard
        </button>
        {store.activeProject ? (
          <>
            <button
              type="button"
              onClick={() => void store.navigate('overview')}
              aria-current={store.view === 'overview' ? 'page' : undefined}
            >
              Project
            </button>
            <button
              type="button"
              onClick={() => void store.navigate('report')}
              aria-current={store.view === 'report' ? 'page' : undefined}
            >
              Report
            </button>
            <button
              type="button"
              onClick={() => void store.navigate('profile')}
              aria-current={store.view === 'profile' ? 'page' : undefined}
            >
              Profile patch
            </button>
          </>
        ) : null}
        <span className="cal-nav-profile">
          Profile:{' '}
          {store.profileId === null
            ? 'Not selected'
            : store.profileName || 'Selected'}
        </span>
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
        aria-label="Printer calibration workspace"
      >
        {store.view === 'dashboard' ? <CalibrationDashboard /> : null}
        {store.view === 'newProject' ? <NewCalibrationProject /> : null}
        {store.view === 'overview' ? <ProjectOverview /> : null}
        {store.view === 'step' && store.activeProject ? (
          <CalibrationStepWorkflow stageId={store.selectedStageId} />
        ) : null}
        {store.view === 'report' && store.activeProject ? (
          <CalibrationReport />
        ) : null}
        {store.view === 'profile' && store.activeProject ? (
          <CalibrationProfileEntry />
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
