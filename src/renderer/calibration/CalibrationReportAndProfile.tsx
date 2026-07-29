import {
  buildOrcaProfilePatch,
  decideCalibrationAction,
  type CalibrationEvent,
  type CalibrationObservation,
  type RuntimeCalibrationContext,
} from './domain';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import { isCurrentPhysicalMatch } from './parseDomainState';
import { profileMatchesProject } from './projectEligibility';
import { formatTimestamp } from './workspaceTypes';

function observationValue(observation: CalibrationObservation): string {
  switch (observation.stageId) {
    case 'temperature':
      return `${observation.temperatureC} C`;
    case 'flowPass1':
    case 'flowPass2':
      return `${observation.adjustmentPercent}%`;
    case 'pressureAdvance':
      return String(observation.pressureAdvance);
    case 'flowVerification':
    case 'finalVerification':
      return `${observation.passed ? 'Passed' : 'Did not pass'}; ${observation.defectCount} defects`;
    case 'retraction':
      return `${observation.retractionLengthMm} mm`;
    case 'maximumVolumetricSpeed':
      return `${observation.stableVolumetricRateMm3S} mm3/s`;
    case 'shrinkage':
      return `Nominal ${observation.nominalXmm}/${observation.nominalYmm}/${observation.nominalZmm}; measured ${observation.measuredXmm}/${observation.measuredYmm}/${observation.measuredZmm} mm`;
  }
}

function eventSummary(event: CalibrationEvent): string {
  switch (event.type) {
    case 'setMode':
      return `Mode changed to ${event.mode}.`;
    case 'navigate':
      return `Current stage changed to ${event.stageId}.`;
    case 'beginAttempt':
      return `Began ${event.method} attempt ${event.attemptId} for ${event.stageId}.`;
    case 'recordObservation':
      return `Recorded observation ${event.observation.observationId} for attempt ${event.attemptId}.`;
    case 'selectObservation':
      return `Selected observation ${event.observationId} for attempt ${event.attemptId}.`;
    case 'completeAttempt':
      return `Completed attempt ${event.attemptId} with ${event.confidence} confidence.`;
    case 'completePrintedAttempt':
      return `Completed printed attempt ${event.attemptId}: ${event.result} (${event.confidence} confidence, retest: ${event.retest}).`;
    case 'skipStage':
      return `Skipped ${event.stageId}. Reason: ${event.reason}`;
    case 'redoStage':
      return `Started immutable redo ${event.attemptId} for ${event.stageId} using ${event.method}. Reason: ${event.reason}`;
    case 'rebaseSnapshot':
      return `Rebased to snapshot ${event.binding.snapshot.snapshotId}; retest ${event.retestStages.join(', ')}. Reason: ${event.reason}`;
  }
}

function Identity(): React.JSX.Element {
  const { activeProject } = useCalibrationWorkspaceStore();
  const project = activeProject!;
  const state = project.domainState;
  const tool = state.binding.snapshot.toolheads.find(
    (item) => item.toolId === state.binding.selectedToolId,
  );
  return (
    <dl className="cal-definition-list">
      <div>
        <dt>Printer</dt>
        <dd>{state.binding.printer.backendPrinterId}</dd>
      </div>
      <div>
        <dt>Configuration</dt>
        <dd>
          {state.binding.printer.printerConfigurationId}, revision{' '}
          {state.binding.printer.printerConfigurationRevision}
        </dd>
      </div>
      <div>
        <dt>Snapshot</dt>
        <dd>
          {state.binding.snapshot.snapshotId}, revision{' '}
          {state.binding.snapshot.snapshotRevision}
        </dd>
      </div>
      <div>
        <dt>Tool</dt>
        <dd>
          {state.binding.selectedToolId}; {state.binding.selectedToolheadId}
        </dd>
      </div>
      <div>
        <dt>Nozzle</dt>
        <dd>
          {state.binding.selectedNozzleId}; {tool?.nozzle.diameterMm} mm{' '}
          {tool?.nozzle.material}
        </dd>
      </div>
      <div>
        <dt>Filament</dt>
        <dd>
          {state.binding.filament.provider}; {state.binding.filament.product};{' '}
          {state.binding.filament.sku}
          {state.binding.filament.spoolId
            ? `; spool ${state.binding.filament.spoolId}`
            : ''}
        </dd>
      </div>
      <div>
        <dt>Base OrcaSlicer profile</dt>
        <dd>
          {project.record.workspaceState.selectedBaseProfile.displayName} (
          {project.record.workspaceState.selectedBaseProfile.orcaProfileId}),
          revision{' '}
          {project.record.workspaceState.selectedBaseProfile.profileRevision ??
            'not supplied'}
          , hash{' '}
          {project.record.workspaceState.selectedBaseProfile.contentHash ??
            'not supplied'}
        </dd>
      </div>
    </dl>
  );
}

export function CalibrationReport(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const project = store.activeProject!;
  const state = project.domainState;
  const patch = buildOrcaProfilePatch(state);

  return (
    <article
      className="cal-view cal-report"
      aria-labelledby="calibration-report-title"
    >
      <header className="cal-view-heading">
        <div>
          <h1 id="calibration-report-title" data-cal-heading tabIndex={-1}>
            {project.record.workspaceState.metadata.displayName}
          </h1>
          <p className="cal-subtitle">
            Printable calibration card with immutable identity, attempts,
            selected observations, and proposed patch provenance.
          </p>
        </div>
        <div className="cal-actions cal-no-print">
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.navigate('overview')}
          >
            Project overview
          </button>
        </div>
      </header>

      <section
        className="cal-report-section"
        aria-labelledby="report-identity-title"
      >
        <h2 id="report-identity-title">Immutable identity</h2>
        <Identity />
        <p>
          <strong>Local project reference:</strong>{' '}
          <code>{state.projectId}</code>
        </p>
        <p>
          <strong>PrintFarmer backend reference:</strong>{' '}
          <code>{project.record.remoteProjectId ?? 'Not synchronized'}</code>
        </p>
        <p>
          <strong>Created:</strong> {formatTimestamp(state.createdAt)}
        </p>
      </section>

      <section
        className="cal-report-section"
        aria-labelledby="attempt-history-title"
      >
        <h2 id="attempt-history-title">Immutable attempt history</h2>
        {state.attempts.length === 0 ? (
          <p>No attempts recorded.</p>
        ) : (
          <ol className="cal-report-attempts">
            {state.attempts.map((attempt) => {
              const selected = attempt.observations.find(
                (observation) =>
                  observation.observationId === attempt.selectedObservationId,
              );
              return (
                <li key={attempt.attemptId}>
                  <h3>
                    {attempt.stageId}: attempt {attempt.ordinal}
                  </h3>
                  <p>
                    {attempt.method}; {attempt.status}; started{' '}
                    {formatTimestamp(attempt.startedAt)}
                    {attempt.completedAt
                      ? `; completed ${formatTimestamp(attempt.completedAt)}`
                      : ''}
                  </p>
                  <p>Confidence: {attempt.confidence ?? 'Not recorded'}</p>
                  {selected ? (
                    <p>
                      <strong>Selected observation:</strong>{' '}
                      {observationValue(selected)}
                    </p>
                  ) : (
                    <p>No selected observation.</p>
                  )}
                  {attempt.observations.length ? (
                    <ol>
                      {attempt.observations.map((observation) => (
                        <li key={observation.observationId}>
                          {observationValue(observation)}
                          {observation.observationId ===
                          attempt.selectedObservationId
                            ? '; selected result'
                            : ''}
                          {observation.notes ? `; ${observation.notes}` : ''}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {attempt.recommendation ? (
                    <div>
                      <p>
                        <strong>{attempt.recommendation.summary}</strong>
                      </p>
                      <p>{attempt.recommendation.rationale}</p>
                    </div>
                  ) : null}
                  {attempt.diagnostics.length ? (
                    <ul>
                      {attempt.diagnostics.map((diagnostic, index) => (
                        <li key={`${diagnostic.code}-${index}`}>
                          {diagnostic.severity}: {diagnostic.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section
        className="cal-report-section"
        aria-labelledby="event-history-title"
      >
        <h2 id="event-history-title">Reducer event history</h2>
        {state.history.length ? (
          <ol className="cal-timeline">
            {state.history.map((event) => (
              <li key={event.eventId}>
                <strong>{event.type}</strong>
                <span>{eventSummary(event)}</span>
                <time dateTime={event.timestamp}>
                  {formatTimestamp(event.timestamp)}; event {event.eventId}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p>No reducer events recorded.</p>
        )}
      </section>

      {state.diagnostics.length ? (
        <section
          className="cal-report-section"
          aria-labelledby="workflow-warning-title"
        >
          <h2 id="workflow-warning-title">Workflow warnings and diagnostics</h2>
          <ul className="cal-blocker-list">
            {state.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${diagnostic.eventId ?? index}`}>
                {diagnostic.severity}: {diagnostic.message}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className="cal-report-section"
        aria-labelledby="patch-card-title"
      >
        <h2 id="patch-card-title">Proposed OrcaSlicer patch</h2>
        {patch.entries.length ? (
          <table>
            <thead>
              <tr>
                <th>Target</th>
                <th>Setting</th>
                <th>Value</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {patch.entries.map((entry) => (
                <tr key={`${entry.sourceAttemptId}-${entry.key}`}>
                  <td>{entry.target}</td>
                  <td>
                    <code>{entry.key}</code>
                  </td>
                  <td>
                    {String(entry.value)} {entry.unit}
                  </td>
                  <td>
                    {entry.sourceStageId}; attempt {entry.sourceAttemptId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>
            No selected completed observations currently produce patch entries.
          </p>
        )}
        {patch.diagnostics.length ? (
          <ul className="cal-blocker-list">
            {patch.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${index}`}>
                {diagnostic.severity}: {diagnostic.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="cal-success">No patch diagnostics.</p>
        )}
      </section>

      <section
        className="cal-report-section"
        aria-labelledby="photo-card-title"
      >
        <h2 id="photo-card-title">Photo evidence metadata</h2>
        {project.record.workspaceState.photos.length ? (
          <ol className="cal-photo-list">
            {project.record.workspaceState.photos.map((photo) => (
              <li key={photo.photoId}>
                <strong>{photo.caption}</strong>
                <span>
                  {photo.stageId}; {photo.mimeType}; {photo.byteSize} bytes;{' '}
                  {photo.status}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>No photo metadata attached.</p>
        )}
      </section>
    </article>
  );
}

export function CalibrationProfileEntry(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const project = store.activeProject!;
  const state = project.domainState;
  const patch = buildOrcaProfilePatch(state);
  const persistedBase = project.record.workspaceState.selectedBaseProfile;
  const selectedBase = store.orcaProfiles.find((profile) =>
    profileMatchesProject(profile, state.binding, persistedBase),
  );
  const physicalMatch = isCurrentPhysicalMatch(
    state,
    project.record.workspaceState.physicalMatch,
  )
    ? project.record.workspaceState.physicalMatch
    : null;
  const runtime: RuntimeCalibrationContext = {
    online: !store.offline && store.availability?.available === true,
    pendingMutationCount: project.record.isSynced ? 0 : 1,
    unresolvedConflictCount: project.record.hasConflicts ? 1 : 0,
    currentPrinterConfigurationRevision: project.record.isPrinterContextFresh
      ? state.binding.printer.printerConfigurationRevision
      : null,
    currentSnapshotRevision: project.record.isPrinterContextFresh
      ? state.binding.snapshot.snapshotRevision
      : null,
    physicalMatch,
    bedClearConfirmed: false,
    operatorPresent: false,
  };
  const applyDecision = decideCalibrationAction(state, runtime, 'applyPatch');
  const profileBlockers = [
    ...applyDecision.blockers.map((blocker) => blocker.message),
    ...(selectedBase
      ? selectedBase.exportable
        ? []
        : ['The explicitly selected base profile is not exportable.']
      : ['The explicitly selected base profile is not currently discovered.']),
    ...patch.diagnostics
      .filter((diagnostic) => diagnostic.severity === 'error')
      .map((diagnostic) => diagnostic.message),
  ];

  return (
    <section className="cal-view" aria-labelledby="profile-entry-title">
      <header className="cal-view-heading">
        <div>
          <h1 id="profile-entry-title" data-cal-heading tabIndex={-1}>
            OrcaSlicer profile patch preview
          </h1>
          <p className="cal-subtitle">
            Exact pure patch preview only. Transactional profile installation
            belongs to the dedicated profile workflow.
          </p>
        </div>
        <div className="cal-actions">
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.navigate('overview')}
          >
            Project overview
          </button>
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.navigate('report')}
          >
            Calibration card
          </button>
        </div>
      </header>

      <div className="cal-profile-layout">
        <div className="cal-profile-main">
          <section
            className="cal-step-section"
            aria-labelledby="base-profile-title"
          >
            <h2 id="base-profile-title">Explicit base profile</h2>
            <dl className="cal-definition-list">
              <div>
                <dt>Persisted profile</dt>
                <dd>{persistedBase.displayName}</dd>
              </div>
              <div>
                <dt>PrintFarmer profile identity</dt>
                <dd>{persistedBase.orcaProfileId}</dd>
              </div>
              <div>
                <dt>Revision and content hash</dt>
                <dd>
                  {persistedBase.profileRevision ?? 'not supplied'};{' '}
                  {persistedBase.contentHash ?? 'not supplied'}
                </dd>
              </div>
            </dl>
            {selectedBase ? (
              <dl className="cal-definition-list">
                <div>
                  <dt>Vendor</dt>
                  <dd>{selectedBase.vendor ?? 'Not supplied'}</dd>
                </div>
                <div>
                  <dt>Material</dt>
                  <dd>{selectedBase.material ?? 'Not supplied'}</dd>
                </div>
                <div>
                  <dt>Exportable</dt>
                  <dd>{selectedBase.exportable ? 'Yes' : 'No'}</dd>
                </div>
              </dl>
            ) : (
              <p
                id="base-profile-discovery-warning"
                className="cal-alert cal-alert--warning"
                role="alert"
              >
                The immutable base profile identity, revision, hash, or physical
                scope differs from current discovery. Rebase and retest only
                when the same immutable identity can be preserved; otherwise
                create a new project. No replacement was guessed.
              </p>
            )}
          </section>

          <section
            className="cal-step-section"
            aria-labelledby="patch-preview-title"
          >
            <h2 id="patch-preview-title">Exact patch entries</h2>
            {patch.entries.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Key</th>
                    <th>Value</th>
                    <th>Observation provenance</th>
                  </tr>
                </thead>
                <tbody>
                  {patch.entries.map((entry) => (
                    <tr key={`${entry.sourceAttemptId}-${entry.key}`}>
                      <td>{entry.target}</td>
                      <td>
                        <code>{entry.key}</code>
                      </td>
                      <td>
                        {String(entry.value)} {entry.unit}
                      </td>
                      <td>
                        {entry.sourceStageId}; {entry.sourceAttemptId};{' '}
                        {entry.sourceObservationId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>
                No patch entries are available from completed selected
                observations.
              </p>
            )}
          </section>

          <section
            className="cal-step-section"
            aria-labelledby="patch-validation-title"
          >
            <h2 id="patch-validation-title">
              Patch validation and runtime gates
            </h2>
            {patch.diagnostics.length ? (
              <ul className="cal-blocker-list">
                {patch.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}-${index}`}>
                    {diagnostic.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cal-success">Domain patch validation passed.</p>
            )}
            {profileBlockers.length ? (
              <ul className="cal-blocker-list">
                {[...new Set(profileBlockers)].map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : (
              <p className="cal-success">
                Runtime safety, patch, and explicit base-profile gates pass for
                a future transactional install.
              </p>
            )}
          </section>
        </div>

        <aside className="cal-profile-aside">
          <section className="cal-pane cal-detail-pane">
            <h2>Profile actions</h2>
            {store.generatedProfile ? (
              <>
                <p>
                  <strong>Generated:</strong>{' '}
                  {store.generatedProfile.displayName}
                </p>
                <p>
                  <strong>Hash:</strong>{' '}
                  <code>
                    {store.generatedProfile.profileJsonHash.slice(0, 16)}…
                  </code>
                </p>
                <p>
                  <strong>Fields patched:</strong>{' '}
                  {store.generatedProfile.patchedFieldCount}
                </p>
                {store.generatedProfile.warnings.length > 0 && (
                  <ul className="cal-blocker-list">
                    {store.generatedProfile.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                {store.generatedProfile.installedHash ? (
                  <p className="cal-success">
                    Installed. Hash:{' '}
                    <code>
                      {store.generatedProfile.installedHash.slice(0, 16)}…
                    </code>
                  </p>
                ) : null}
                {store.generatedProfile.exportedHash ? (
                  <p className="cal-success">
                    Exported. Hash:{' '}
                    <code>
                      {store.generatedProfile.exportedHash.slice(0, 16)}…
                    </code>
                  </p>
                ) : null}
                <div className="cal-actions">
                  {typeof window !== 'undefined' &&
                  // Check navigator.platform only on darwin/linux for export
                  (navigator.platform.startsWith('Mac') ||
                    navigator.platform.startsWith('Linux')) ? (
                    <button
                      type="button"
                      className="cal-button cal-button--primary"
                      disabled={profileBlockers.length > 0}
                      onClick={() => void store.exportProfile()}
                    >
                      Export profile…
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="cal-button cal-button--primary"
                        disabled={profileBlockers.length > 0}
                        onClick={() => void store.installProfile()}
                      >
                        Install transactionally
                      </button>
                      {store.generatedProfile.backupHash ? (
                        <button
                          type="button"
                          className="cal-button"
                          onClick={() => void store.restoreProfile()}
                        >
                          Restore from backup
                        </button>
                      ) : null}
                    </>
                  )}
                  <button
                    type="button"
                    className="cal-button"
                    disabled={profileBlockers.length > 0}
                    onClick={() => void store.generateProfile()}
                  >
                    Regenerate
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="cal-button cal-button--primary"
                  disabled={profileBlockers.length > 0}
                  aria-describedby="profile-generate-gate"
                  onClick={() => void store.generateProfile()}
                >
                  Generate OrcaSlicer profile
                </button>
                {profileBlockers.length > 0 ? (
                  <p
                    id="profile-generate-gate"
                    className="cal-alert cal-alert--warning"
                    role="alert"
                  >
                    Resolve blockers before generating a profile.
                  </p>
                ) : (
                  <p id="profile-generate-gate">
                    Generates a deterministic, calibrated OrcaSlicer filament
                    profile from selected completed observations. Explicit
                    confirmation is required before any write.
                  </p>
                )}
              </>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
