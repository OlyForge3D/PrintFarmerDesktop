import React from 'react';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';

const availabilityCopy = {
  serverVersionTooLow:
    'Update the selected PrintFarmer server before calibrating a filament spool.',
  missingScopes:
    'The selected profile does not have every required calibration permission. Ask a PrintFarmer administrator to grant calibration read, write, generation, and print permissions to this profile.',
  unsupportedFirmware:
    'PrintFarmer did not confirm compatible Klipper firmware and dialect. Update the printer to a confirmed Klipper firmware in PrintFarmer, then refresh this workspace.',
  unsupportedSlicer:
    'Upstream OrcaSlicer capability was not confirmed. Configure an upstream OrcaSlicer distribution in PrintFarmer, then refresh this workspace.',
  missingCapabilityFlags:
    'One or more required calibration capabilities are disabled. Ask a PrintFarmer administrator to enable the calibration capabilities for this server, then refresh this workspace.',
  operatorDisabled:
    'Filament calibration was disabled by the server operator. Ask the server operator to re-enable calibration, then refresh this workspace.',
  legacyServer:
    'This profile points to a server without the calibration API. Select a profile for a PrintFarmer server that exposes the calibration API, or upgrade that server.',
  sessionExpired:
    'Your PrintFarmer session expired or was revoked. Reconnect this profile to sign in again, then refresh this workspace.',
  noProfile: 'Select a PrintFarmer profile to continue.',
} as const;

/**
 * Filament calibration landing page.
 *
 * The old dashboard was the printer-calibration saga's shell: it led with a
 * "New calibration project" primary button (that saga), and its summary
 * strip, saved-project list, conflict/queue tiles, backup-import flow, and
 * profile-sync panel were all state produced by the same saga. Filament
 * calibration (the feature this project actually serves — see
 * `.squad/decisions/inbox/vasquez-filament-calibration-reframe.md`) does
 * not produce any of that state and drives none of those tiles, so keeping
 * them meant the operator opened the calibration page and was led into the
 * wrong feature (`OlyForge3D/PrintFarmerDesktop#756`).
 *
 * Under Path D the surviving action is a single primary entry point into
 * the filament-spool wizard. Availability, profile identity, and
 * connection state are still surfaced because the wizard depends on them,
 * but they are read-only signals here — the "sync and retry" / "manage
 * conflicts" / "import backup" affordances belonged to the retired saga.
 */
export function CalibrationDashboard(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const unavailableReason = store.availability?.unavailableReason;
  const creationBlocked =
    store.profileId === null ||
    store.offline ||
    store.availability?.available !== true ||
    store.disabled;

  let recovery = 'Filament calibration is ready.';
  if (store.profileId === null)
    recovery = 'Select or create a PrintFarmer profile.';
  else if (store.offline)
    recovery =
      'Reconnect to PrintFarmer to calibrate a filament spool. The wizard needs a live connection to clone profiles and dispatch slices.';
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
            Filament Calibration
          </h1>
          <p className="cal-subtitle">
            Tune a filament spool using the OrcaSlicer wiki workflow: clone the
            profile, run a slice, print it, measure the result, and write the
            corrected value back to the cloned profile.
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
            onClick={() => void store.navigate('filamentCalibration')}
            disabled={creationBlocked}
            aria-describedby="filament-cal-gate"
          >
            Calibrate a filament spool
          </button>
        </div>
      </header>

      <p
        id="filament-cal-gate"
        className={creationBlocked ? 'cal-gate-copy' : 'cal-visually-hidden'}
      >
        {recovery}
      </p>

      {store.loading ? (
        <p role="status">Confirming calibration availability.</p>
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
          Offline: filament calibration requires a live PrintFarmer connection.
          Reconnect to PrintFarmer to start the wizard.
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
          Filament calibration is unavailable on this PrintFarmer server.{' '}
          {store.availability?.unavailableDetail ??
            availabilityCopy[unavailableReason]}
        </p>
      ) : null}

      <section
        className="cal-pane cal-detail-pane"
        aria-labelledby="cal-connection-title"
      >
        <h2 id="cal-connection-title">Profile and connection</h2>
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
        </div>
        {creationBlocked ? <p className="cal-inline-note">{recovery}</p> : null}
      </section>
    </section>
  );
}
