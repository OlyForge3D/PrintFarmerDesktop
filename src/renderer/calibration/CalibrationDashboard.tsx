import React, { useState } from 'react';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import { formatTimestamp } from './workspaceTypes';
import { ImportLegacyBackup } from './ImportLegacyBackup';
import { browserCalibrationEnvironment } from './api';
import { CalibrationConflictDialog } from './CalibrationConflictDialog';

const availabilityCopy = {
  serverVersionTooLow:
    'Update the selected PrintFarmer server before creating a calibration.',
  missingScopes:
    'The selected profile does not have every required calibration permission. Ask a PrintFarmer administrator to grant calibration read, write, generation, and print permissions to this profile.',
  unsupportedFirmware:
    'PrintFarmer did not confirm compatible Klipper firmware and dialect. Update the printer to a confirmed Klipper firmware in PrintFarmer, then refresh this workspace.',
  unsupportedSlicer:
    'Upstream OrcaSlicer capability was not confirmed. Configure an upstream OrcaSlicer distribution in PrintFarmer, then refresh this workspace.',
  missingCapabilityFlags:
    'One or more required calibration capabilities are disabled. Ask a PrintFarmer administrator to enable the calibration capabilities for this server, then refresh this workspace.',
  operatorDisabled:
    'Printer Calibration was disabled by the server operator. Ask the server operator to re-enable Printer Calibration, then refresh this workspace.',
  legacyServer:
    'This profile points to a server without the calibration API. Select a profile for a PrintFarmer server that exposes the calibration API, or upgrade that server.',
  sessionExpired:
    'Your PrintFarmer session expired or was revoked. Reconnect this profile to sign in again, then refresh this workspace.',
  noProfile: 'Select a PrintFarmer profile to continue.',
} as const;

export function CalibrationDashboard(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const [showImport, setShowImport] = useState(false);
  const [showConflicts, setShowConflicts] = useState(false);
  const conflictProfileId = store.profileId;
  const active = store.records.filter(
    (record) => record.status !== 'complete' && record.status !== 'archived',
  );
  const completed = store.records.filter(
    (record) => record.status === 'complete',
  );
  const pending = store.records.filter((record) => !record.isSynced);
  const conflicts = store.records.filter((record) => record.hasConflicts);
  const stale = store.records.filter((record) => !record.isPrinterContextFresh);
  const unavailableReason = store.availability?.unavailableReason;
  const creationBlocked =
    store.profileId === null ||
    store.offline ||
    store.availability?.available !== true ||
    store.disabled;

  let recovery = 'Calibration is ready.';
  if (store.profileId === null)
    recovery = 'Select or create a PrintFarmer profile.';
  else if (store.offline)
    recovery =
      'Reconnect to PrintFarmer to create a project. Existing projects remain editable offline.';
  else if (store.availability?.available !== true)
    recovery =
      store.availability?.unavailableDetail ??
      (unavailableReason
        ? availabilityCopy[unavailableReason]
        : 'Availability has not been confirmed.');

  return (
    <section
      className="cal-view cal-dashboard"
      aria-labelledby="cal-dashboard-title"
    >
      <header className="cal-view-heading">
        <div>
          <h1 id="cal-dashboard-title" data-cal-heading tabIndex={-1}>
            Printer Calibration
          </h1>
          <p className="cal-subtitle">
            Guided, traceable tuning bound to one explicit printer, tool,
            nozzle, material, and base profile.
          </p>
        </div>
        <div className="cal-actions">
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.refresh()}
            disabled={store.loading || store.profileId === null}
          >
            Refresh
          </button>
          <button
            type="button"
            className="cal-button cal-button--primary"
            onClick={() => void store.navigate('newProject')}
            disabled={creationBlocked}
            aria-describedby="new-project-gate"
          >
            New calibration project
          </button>
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.navigate('filamentCalibration')}
            disabled={
              store.profileId === null || store.offline || store.disabled
            }
            aria-describedby="new-project-gate"
          >
            Calibrate a filament spool
          </button>
          <button
            type="button"
            className="cal-button"
            onClick={() => setShowImport(true)}
            disabled={store.profileId === null || store.disabled}
            aria-label="Import a legacy calibration backup file"
          >
            Import backup…
          </button>
        </div>
      </header>

      <p
        id="new-project-gate"
        className={creationBlocked ? 'cal-gate-copy' : 'cal-visually-hidden'}
      >
        {recovery}
      </p>

      {store.loading ? (
        <p role="status">Loading saved calibration projects.</p>
      ) : null}
      {store.error ? (
        <div className="cal-alert" role="alert">
          <p>{store.error}</p>
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.refresh()}
          >
            Retry loading
          </button>
        </div>
      ) : null}
      {store.offline ? (
        <p className="cal-alert cal-alert--warning" role="alert">
          Offline: saved projects can be edited and queued locally.
          Synchronization and hardware actions are blocked. Reconnect to
          PrintFarmer, then select Sync and retry to restore hardware actions.
        </p>
      ) : null}
      {store.availability?.unavailableReason === 'missingScopes' ? (
        <p className="cal-alert" role="alert">
          Permission denied: calibration read, write, generation, and print
          permissions are required. Ask a PrintFarmer administrator to grant
          those permissions to this profile, then select Refresh.
        </p>
      ) : null}
      {!store.offline &&
      unavailableReason !== undefined &&
      unavailableReason !== null &&
      unavailableReason !== 'missingScopes' ? (
        <p className="cal-alert cal-alert--warning" role="alert">
          Calibration is unavailable on this PrintFarmer server.{' '}
          {store.availability?.unavailableDetail ??
            availabilityCopy[unavailableReason]}
        </p>
      ) : null}

      <section
        className="cal-summary-strip"
        aria-label="Calibration project summary"
      >
        <div>
          <strong>{active.length}</strong>
          <span>Active</span>
        </div>
        <div>
          <strong>{completed.length}</strong>
          <span>Completed</span>
        </div>
        <div>
          <strong>{pending.length}</strong>
          <span>Queued locally</span>
        </div>
        <div>
          <strong>{conflicts.length}</strong>
          <span>Conflicts</span>
          <button
            type="button"
            className="cal-link-button cal-summary-action"
            onClick={() => setShowConflicts(true)}
            disabled={
              store.profileId === null || store.offline || store.disabled
            }
          >
            Review conflicts
          </button>
        </div>
      </section>

      <div className="cal-dashboard-layout">
        <section className="cal-pane" aria-labelledby="projects-title">
          <div className="cal-pane-heading">
            <div>
              <h2 id="projects-title">Saved projects</h2>
              <p>Exact local workspace state for the selected profile.</p>
            </div>
            <span className="cal-count">{store.records.length}</span>
          </div>
          {!store.loading && !store.error && store.records.length === 0 ? (
            <div className="cal-empty">
              <h3>No calibration projects</h3>
              <p>
                Create one after PrintFarmer confirms eligibility and current
                printer context.
              </p>
            </div>
          ) : (
            <ul className="cal-project-list">
              {store.records.map((record) => {
                const recoveryMessage =
                  store.recoveryByProject[record.projectId];
                return (
                  <li key={record.projectId}>
                    <button
                      type="button"
                      className="cal-project-row"
                      onClick={() => void store.openProject(record.projectId)}
                      disabled={store.disabled}
                    >
                      <span className="cal-project-copy">
                        <strong>{record.displayName}</strong>
                        <span>
                          {record.completedStepCount} of {record.totalStepCount}{' '}
                          stages complete. Updated{' '}
                          {formatTimestamp(record.updatedAt)}.
                        </span>
                      </span>
                      <span className="cal-row-flags">
                        <span
                          className={`cal-badge cal-badge--${record.status}`}
                        >
                          {record.status}
                        </span>
                        {!record.isSynced ? (
                          <span className="cal-badge cal-badge--warning">
                            Queued locally
                          </span>
                        ) : (
                          <span className="cal-badge cal-badge--success">
                            Synchronized
                          </span>
                        )}
                        {!record.isPrinterContextFresh ? (
                          <span className="cal-badge cal-badge--danger">
                            Stale snapshot
                          </span>
                        ) : null}
                        {record.hasConflicts ? (
                          <span className="cal-badge cal-badge--danger">
                            Conflict
                          </span>
                        ) : null}
                        {recoveryMessage ? (
                          <span className="cal-badge cal-badge--danger">
                            Recovery required
                          </span>
                        ) : null}
                      </span>
                    </button>
                    {recoveryMessage ? (
                      <p className="cal-recovery-copy" role="alert">
                        {recoveryMessage}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {store.unhydratedProjects.length > 0 ? (
            <section
              className="cal-recovery-projects"
              aria-labelledby="remote-recovery-title"
            >
              <h3 id="remote-recovery-title">Remote recovery required</h3>
              <p>
                These PrintFarmer records are remote-only or require migration.
                No renderer domain state was fabricated.
              </p>
              <ul className="cal-project-list">
                {store.unhydratedProjects.map((project) => (
                  <li key={project.projectId} className="cal-recovery-copy">
                    <strong>{project.displayName}</strong>
                    <span>
                      Migration required; backend reference{' '}
                      {project.remoteProjectId}.
                    </span>
                    <button
                      type="button"
                      className="cal-button"
                      disabled={store.offline || store.disabled}
                      onClick={() => void store.sync(project.projectId)}
                    >
                      Sync and retry this project
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </section>

        <aside
          className="cal-dashboard-aside"
          aria-label="Calibration connection status"
        >
          <section className="cal-pane cal-detail-pane">
            <h2>Profile and synchronization</h2>
            <dl className="cal-definition-list">
              <div>
                <dt>Profile</dt>
                <dd>
                  {store.profileId
                    ? store.profileName || 'Selected'
                    : 'Not selected'}
                </dd>
              </div>
              <div>
                <dt>Connection</dt>
                <dd>
                  {store.profileId === null
                    ? 'Not connected'
                    : store.offline
                      ? 'Offline'
                      : 'Online'}
                </dd>
              </div>
              <div>
                <dt>Calibration API</dt>
                <dd>
                  {store.availability?.available ? 'Available' : 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>Offline editing</dt>
                <dd>
                  {store.availability?.offlineEditingEnabled ||
                  store.records.length > 0
                    ? 'Available'
                    : 'Unavailable'}
                </dd>
              </div>
              <div>
                <dt>Profile generation</dt>
                <dd>
                  {store.availability?.capabilityFlags
                    ?.calibrationGenerationEnabled
                    ? 'Available'
                    : 'Disabled on server'}
                </dd>
              </div>
              <div>
                <dt>Stale projects</dt>
                <dd>{stale.length}</dd>
              </div>
              <div>
                <dt>Conflicts</dt>
                <dd>{conflicts.length}</dd>
              </div>
            </dl>
            <div className="cal-actions cal-actions--stacked">
              <button
                type="button"
                className="cal-link-button"
                onClick={() => void store.manageProfiles()}
                disabled={store.disabled}
              >
                Manage PrintFarmer profiles
              </button>
              <button
                type="button"
                className="cal-button"
                onClick={() => void store.sync()}
                disabled={
                  store.disabled || store.profileId === null || store.offline
                }
                aria-describedby="sync-gate"
              >
                Sync and retry
              </button>
            </div>
            <p id="sync-gate" className="cal-field-help">
              Sync requires a connection. Conflicts remain explicit and are
              never overwritten here.
            </p>
            {creationBlocked ? (
              <p className="cal-inline-note">{recovery}</p>
            ) : null}
          </section>
        </aside>
      </div>
      {showImport && store.profileId !== null && (
        <div className="cal-modal-overlay" role="presentation">
          <ImportLegacyBackup
            profileId={store.profileId}
            env={browserCalibrationEnvironment}
            onClose={() => setShowImport(false)}
            onImportComplete={() => void store.refresh()}
          />
        </div>
      )}
      {showConflicts && conflictProfileId !== null ? (
        <CalibrationConflictDialog
          key={conflictProfileId}
          profileId={conflictProfileId}
          profileName={store.profileName || 'Selected profile'}
          onClose={() => setShowConflicts(false)}
          onResolved={() => void store.refresh()}
        />
      ) : null}
    </section>
  );
}
