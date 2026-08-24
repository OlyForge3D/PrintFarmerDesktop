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
import { FilamentCalibrationWizard } from './FilamentCalibrationWizard';
import { NewCalibrationProject } from './NewCalibrationProject';
import { ProjectOverview } from './ProjectOverview';
import type { CalibrationWorkspaceProps } from './workspaceTypes';
import './calibrationWorkspace.css';

function WorkspaceContent(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const { view, orcaProfiles, activeProject, loadProjectProfiles } = store;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      document
        .querySelector<HTMLElement>('.cal-workspace-content [data-cal-heading]')
        ?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [view]);

  // The profile-patch view once got its profiles from a farm-wide load that ran
  // on mount. That load is gone, so it asks for its own — scoped to the printer
  // and configuration revision the open project is already bound to, which is
  // the only printer whose profiles this view can legitimately patch.
  useEffect(() => {
    if (
      view === 'profile' &&
      activeProject !== null &&
      orcaProfiles.length === 0
    ) {
      void loadProjectProfiles();
    }
  }, [activeProject, loadProjectProfiles, orcaProfiles.length, view]);

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
        {store.view === 'filamentCalibration' ? (
          <FilamentCalibrationWizard />
        ) : null}
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
