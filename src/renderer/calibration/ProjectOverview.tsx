import { useEffect, useState } from 'react';
import type {
  CalibrationPrinterContext,
  CalibrationJobProvenance,
} from '@shared/ipc';
import {
  CALIBRATION_STAGE_BY_ID,
  CALIBRATION_STAGE_IDS,
  buildWorkflowViewModel,
  type CalibrationStageId,
} from './domain';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import { isCurrentPhysicalMatch } from './parseDomainState';
import { bindingFromContext } from './projectEligibility';
import { formatTimestamp } from './workspaceTypes';
import { calibrationApi } from './api';
import { CalibrationProvenance } from './CalibrationProvenance';

function rebaseBlockers(
  context: CalibrationPrinterContext,
  project: NonNullable<
    ReturnType<typeof useCalibrationWorkspaceStore>['activeProject']
  >,
): string[] {
  const state = project.domainState;
  const blockers: string[] = [];
  if (context.printerId !== state.binding.printer.backendPrinterId)
    blockers.push('The refreshed context belongs to a different printer.');
  if (context.configurationId !== state.binding.printer.printerConfigurationId)
    blockers.push(
      'The printer configuration identity changed; create a new project instead.',
    );
  if (!context.isCurrent)
    blockers.push('The refreshed printer context is still stale.');
  if (
    context.configurationRevision === null ||
    context.configurationRevision === undefined ||
    context.configurationRevision <=
      state.binding.printer.printerConfigurationRevision
  )
    blockers.push('A newer printer configuration revision is required.');
  if (
    !context.snapshotId ||
    context.snapshotId === state.binding.snapshot.snapshotId ||
    context.snapshotRevision === null ||
    context.snapshotRevision === undefined ||
    context.snapshotRevision <= state.binding.snapshot.snapshotRevision
  )
    blockers.push('A newer, differently identified snapshot is required.');
  if (
    context.slicerIdentity !== 'OrcaSlicer' ||
    context.slicerDistribution !== 'upstream'
  )
    blockers.push(
      'The refreshed context must still identify upstream OrcaSlicer.',
    );
  if (
    !context.orcaProfileId ||
    !context.orcaProfileDisplayName ||
    context.bedWidthMm === null ||
    context.bedDepthMm === null ||
    context.nozzleDiameterMm === null
  )
    blockers.push(
      'The refreshed printer, dimensions, or OrcaSlicer context is incomplete.',
    );
  if (!context.safety || !context.permissions)
    blockers.push('The refreshed safety or permission context is incomplete.');
  else if (
    !context.safety.emergencyStopAvailable ||
    !context.safety.thermalProtectionConfirmed ||
    !context.safety.ventilationAssessed
  )
    blockers.push(
      'The refreshed context no longer confirms all required machine safety controls.',
    );
  else if (
    !context.permissions.readPrinter ||
    !context.permissions.writeCalibration ||
    !context.permissions.generateCalibration ||
    !context.permissions.startPrint
  )
    blockers.push(
      'The refreshed context no longer grants all calibration permissions.',
    );
  const refreshedTool = context.toolheads.find(
    (tool) => tool.toolId === state.binding.selectedToolId,
  );
  if (refreshedTool === undefined) {
    blockers.push(
      'The selected physical tool is absent from the new snapshot.',
    );
  } else {
    const boundTool = state.binding.snapshot.toolheads.find(
      (tool) => tool.toolId === state.binding.selectedToolId,
    );
    if (
      boundTool === undefined ||
      refreshedTool.toolheadId !== state.binding.selectedToolheadId ||
      refreshedTool.nozzle.id !== state.binding.selectedNozzleId ||
      refreshedTool.extruderType !== boundTool.extruderType ||
      refreshedTool.nozzle.diameterMm !== boundTool.nozzle.diameterMm ||
      refreshedTool.nozzle.material !== boundTool.nozzle.material
    ) {
      blockers.push(
        'The selected toolhead or nozzle identity changed; create a new project instead.',
      );
    }
  }
  return blockers;
}

export function ProjectOverview(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const project = store.activeProject;
  const [rebaseContext, setRebaseContext] =
    useState<CalibrationPrinterContext | null>(null);
  const [rebaseReason, setRebaseReason] = useState('');
  const [retestStages, setRetestStages] = useState<
    ReadonlySet<CalibrationStageId>
  >(() => new Set());

  // Load queue job provenance for the overview (criterion 11).
  const [queueProvenance, setQueueProvenance] =
    useState<CalibrationJobProvenance | null>(null);
  useEffect(() => {
    if (!store.profileId || !project) return;
    const profileId = store.profileId;
    const projectId = project.domainState.projectId;
    const api = calibrationApi();
    // Guard: method may be absent in partial mocks / older preload versions.
    if (typeof api.getCalibrationQueueState !== 'function') return;
    let cancelled = false;
    void api
      .getCalibrationQueueState({ profileId, projectId })
      .then((res) => {
        if (cancelled || res.status !== 'ok') return;
        const job = res.job;
        setQueueProvenance({
          requiredSlicerVersion: null,
          requiredGcodeDialect: null,
          requiredFirmwareFamily: null,
          requiredSlicerContainerDigest: null,
          pinnedPrinterConfigRevision: job.pinnedPrinterConfigRevision,
          jobId: job.jobId,
          assignedPrinterId: job.assignedPrinterId,
          gcodeFileId: job.gcodeFileId,
          gcodeContentSha256: null,
          specificationSha256: null,
          machineProfileSha256: null,
          processProfileSha256: null,
          filamentProfileSha256: null,
          printerConfigSnapshotSha256: null,
          rowVersion: job.rowVersion,
        });
      })
      .catch(() => undefined); // Silently ignore transient fetch failures.
    return () => {
      cancelled = true;
    };
  }, [store.profileId, project]);

  if (project === null) {
    return (
      <section
        className="cal-view cal-recovery"
        aria-labelledby="recovery-title"
      >
        <h1 id="recovery-title" data-cal-heading tabIndex={-1}>
          Project recovery required
        </h1>
        <p role="alert">
          The saved domain state failed renderer validation. It was not replaced
          with defaults.
        </p>
        <button
          type="button"
          className="cal-button"
          onClick={() => void store.navigate('dashboard')}
        >
          Return to dashboard
        </button>
      </section>
    );
  }

  const state = project.domainState;
  const payload = project.record.workspaceState;
  const workflow = buildWorkflowViewModel(state);
  const selectedTool = state.binding.snapshot.toolheads.find(
    (tool) => tool.toolId === state.binding.selectedToolId,
  );
  const physicalMatch = isCurrentPhysicalMatch(state, payload.physicalMatch);
  const currentRebaseBlockers = rebaseContext
    ? rebaseBlockers(rebaseContext, project)
    : ['Refresh the current printer context first.'];
  const canRebase =
    rebaseContext !== null &&
    currentRebaseBlockers.length === 0 &&
    rebaseReason.trim().length > 0 &&
    retestStages.size > 0;

  const refreshContext = async (): Promise<void> => {
    const context = await store.refreshProjectContext();
    setRebaseContext(context);
    setRetestStages(new Set());
  };

  const rebase = async (): Promise<void> => {
    if (
      !canRebase ||
      rebaseContext === null ||
      selectedTool === undefined ||
      store.profileId === null
    )
      return;
    const binding = bindingFromContext(
      store.profileId,
      rebaseContext,
      state.binding.selectedToolId,
      state.binding.filament,
    );
    if (binding === null) {
      store.reportError(
        'The refreshed snapshot could not preserve this project identity.',
      );
      return;
    }
    const timestamp = store.environment.now();
    const accepted = await store.dispatchEvent({
      eventId: store.environment.createId(),
      timestamp,
      type: 'rebaseSnapshot',
      binding,
      retestStages: CALIBRATION_STAGE_IDS.filter((stageId) =>
        retestStages.has(stageId),
      ),
      reason: rebaseReason.trim(),
    });
    if (!accepted) return;
    setRebaseContext(null);
    setRebaseReason('');
    setRetestStages(new Set());
    store.announce(
      'Snapshot rebased; selected stages now require explicit retesting. Physical match confirmation was cleared.',
    );
  };

  return (
    <section className="cal-view" aria-labelledby="project-overview-title">
      <header className="cal-view-heading">
        <div>
          <h1 id="project-overview-title" data-cal-heading tabIndex={-1}>
            {payload.metadata.displayName}
          </h1>
          <p className="cal-subtitle">
            {workflow.completedCount} of {workflow.totalCount} stages complete;{' '}
            {state.mode} mode.
          </p>
        </div>
        <div className="cal-actions">
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.navigate('dashboard')}
          >
            Dashboard
          </button>
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.navigate('report')}
          >
            Calibration card
          </button>
          <button
            type="button"
            className="cal-button cal-button--primary"
            onClick={() => void store.navigate('profile')}
          >
            Profile patch
          </button>
        </div>
      </header>

      {project.record.hasConflicts ? (
        <p className="cal-alert" role="alert">
          This project has an unresolved conflict. Synchronization cannot
          silently overwrite it, and hardware actions are blocked. Resolve the
          conflict in PrintFarmer, then refresh this workspace to unblock
          printing.
        </p>
      ) : null}
      {!project.record.isPrinterContextFresh ? (
        <p className="cal-alert cal-alert--warning" role="alert">
          The bound printer snapshot is stale. Refresh, explicitly rebase, and
          select retest stages.
        </p>
      ) : null}
      {store.offline ? (
        <p className="cal-alert cal-alert--warning" role="alert">
          Offline editing is available. Generation, queue, print start, and
          profile application remain blocked.
        </p>
      ) : null}
      {!physicalMatch ? (
        <p className="cal-alert cal-alert--warning" role="alert">
          Physical tool confirmation is missing or expired for this snapshot.
          Confirm it below before risky actions.
        </p>
      ) : null}

      <div className="cal-overview-layout">
        <div className="cal-overview-main">
          <section className="cal-pane" aria-labelledby="identity-title">
            <h2 id="identity-title">Immutable project identity</h2>
            <dl className="cal-definition-list">
              <div>
                <dt>PrintFarmer profile</dt>
                <dd>{state.binding.printer.backendProfileId}</dd>
              </div>
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
                <dt>Tool and toolhead</dt>
                <dd>
                  {state.binding.selectedToolId};{' '}
                  {state.binding.selectedToolheadId}
                </dd>
              </div>
              <div>
                <dt>Nozzle</dt>
                <dd>
                  {state.binding.selectedNozzleId};{' '}
                  {selectedTool?.nozzle.diameterMm} mm{' '}
                  {selectedTool?.nozzle.material}
                </dd>
              </div>
              <div>
                <dt>Extruder scope</dt>
                <dd>
                  {selectedTool?.extruderType === 'bowden'
                    ? 'Bowden'
                    : 'Direct drive'}
                </dd>
              </div>
              <div>
                <dt>Filament</dt>
                <dd>
                  {state.binding.filament.provider};{' '}
                  {state.binding.filament.product}; SKU{' '}
                  {state.binding.filament.sku}
                  {state.binding.filament.spoolId
                    ? `; spool ${state.binding.filament.spoolId}`
                    : ''}
                </dd>
              </div>
              <div>
                <dt>Base profile</dt>
                <dd>{payload.selectedBaseProfileId}</dd>
              </div>
              <div>
                <dt>Build volume</dt>
                <dd>
                  {state.binding.snapshot.safety.buildVolumeMm.x} by{' '}
                  {state.binding.snapshot.safety.buildVolumeMm.y} by{' '}
                  {state.binding.snapshot.safety.buildVolumeMm.z} mm
                </dd>
              </div>
              <div>
                <dt>Safety limits</dt>
                <dd>
                  {state.binding.snapshot.safety.maximumNozzleTemperatureC} C
                  nozzle; {state.binding.snapshot.safety.maximumBedTemperatureC}{' '}
                  C bed;{' '}
                  {state.binding.snapshot.safety.maximumVolumetricRateMm3S}{' '}
                  mm3/s
                </dd>
              </div>
              <div>
                <dt>Safety confirmations</dt>
                <dd>
                  Emergency stop{' '}
                  {state.binding.snapshot.safety.emergencyStopAvailable
                    ? 'available'
                    : 'not confirmed'}
                  ; thermal protection{' '}
                  {state.binding.snapshot.safety.thermalProtectionConfirmed
                    ? 'confirmed'
                    : 'not confirmed'}
                  ; ventilation{' '}
                  {state.binding.snapshot.safety.ventilationAssessed
                    ? 'assessed'
                    : 'not assessed'}
                </dd>
              </div>
            </dl>
          </section>

          <section className="cal-stage-pane" aria-labelledby="workflow-title">
            <div className="cal-pane-heading">
              <div>
                <h2 id="workflow-title">Nine-stage progression</h2>
                <p>
                  Dependencies and immutable attempts are controlled by the
                  domain reducer.
                </p>
              </div>
              <span className="cal-count">{workflow.resolvedCount} / 9</span>
            </div>
            <ol className="cal-stage-list">
              {workflow.stages.map((stage) => (
                <li key={stage.id}>
                  <button
                    type="button"
                    className="cal-stage-row"
                    onClick={() => void store.openStage(stage.id)}
                    disabled={store.disabled}
                    aria-label={`Open ${stage.title}, ${stage.status}`}
                  >
                    <span className="cal-stage-number">{stage.order + 1}</span>
                    <span className="cal-stage-copy">
                      <strong>{stage.title}</strong>
                      <span>
                        {stage.dependencies.length
                          ? `After ${stage.dependencies.map((id) => CALIBRATION_STAGE_BY_ID[id].title).join(', ')}`
                          : 'No stage dependencies'}
                      </span>
                      {stage.selectedAttempt?.recommendation ? (
                        <span className="cal-stage-value">
                          {stage.selectedAttempt.recommendation.summary}
                        </span>
                      ) : null}
                    </span>
                    <span className="cal-row-flags">
                      <span className={`cal-badge cal-badge--${stage.status}`}>
                        {stage.status}
                      </span>
                      <span className="cal-badge">
                        {stage.attemptCount} attempts
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <section className="cal-pane" aria-labelledby="rebase-title">
            <h2 id="rebase-title">Refresh, rebase, and retest</h2>
            <p>
              Refresh only compares context. It never changes this project
              snapshot. Rebase is available only for the same printer,
              configuration identity, and material identity with a newer
              revision and snapshot.
            </p>
            <button
              type="button"
              className="cal-button"
              onClick={() => void refreshContext()}
              disabled={store.offline || store.disabled}
            >
              Refresh current printer context
            </button>
            {rebaseContext ? (
              <>
                <p role="status">
                  Compared snapshot {rebaseContext.snapshotId ?? 'missing'},
                  revision {rebaseContext.snapshotRevision ?? 'missing'}.
                </p>
                <label>
                  Rebase reason
                  <textarea
                    value={rebaseReason}
                    onChange={(event) => setRebaseReason(event.target.value)}
                    aria-invalid={rebaseReason.trim().length === 0}
                  />
                </label>
                <fieldset className="cal-retest-list">
                  <legend>Stages to retest</legend>
                  {CALIBRATION_STAGE_IDS.map((stageId) => (
                    <label className="cal-checkbox" key={stageId}>
                      <input
                        type="checkbox"
                        checked={retestStages.has(stageId)}
                        onChange={(event) =>
                          setRetestStages((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(stageId);
                            else next.delete(stageId);
                            return next;
                          })
                        }
                      />
                      {CALIBRATION_STAGE_BY_ID[stageId].title}
                    </label>
                  ))}
                </fieldset>
                {currentRebaseBlockers.length ? (
                  <ul className="cal-blocker-list" role="alert">
                    {currentRebaseBlockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                ) : null}
                <button
                  type="button"
                  className="cal-button cal-button--primary"
                  onClick={() => void rebase()}
                  disabled={!canRebase}
                >
                  Rebase snapshot and require retests
                </button>
                {!canRebase ? (
                  <p className="cal-field-help">
                    A valid newer snapshot, a reason, and at least one selected
                    retest stage are required.
                  </p>
                ) : null}
              </>
            ) : null}
          </section>
        </div>

        <aside className="cal-overview-aside">
          <section
            className="cal-pane cal-detail-pane"
            aria-labelledby="metadata-title"
          >
            <h2 id="metadata-title">Project metadata</h2>
            <label htmlFor="cal-project-name">Project name</label>
            <input
              id="cal-project-name"
              value={store.metadataDraft.displayName}
              maxLength={256}
              onChange={(event) =>
                store.updateMetadata('displayName', event.target.value)
              }
              aria-invalid={store.metadataError !== null}
              aria-describedby={
                store.metadataError ? 'project-name-error' : undefined
              }
            />
            {store.metadataError ? (
              <p
                id="project-name-error"
                className="cal-field-error"
                role="alert"
              >
                {store.metadataError}
              </p>
            ) : null}
            <label>
              Description
              <textarea
                value={store.metadataDraft.description}
                maxLength={4096}
                onChange={(event) =>
                  store.updateMetadata('description', event.target.value)
                }
              />
            </label>
            <p className="cal-save-status">
              Text changes save locally after a short pause.
            </p>
          </section>

          <section
            className="cal-pane cal-detail-pane"
            aria-labelledby="physical-title"
          >
            <h2 id="physical-title">Physical match</h2>
            <label className="cal-checkbox">
              <input
                type="checkbox"
                checked={physicalMatch}
                onChange={(event) => {
                  if (!event.target.checked || selectedTool === undefined) {
                    void store.setPhysicalMatch(null);
                    return;
                  }
                  void store.setPhysicalMatch({
                    snapshotId: state.binding.snapshot.snapshotId,
                    toolId: state.binding.selectedToolId,
                    toolheadId: state.binding.selectedToolheadId,
                    nozzleId: state.binding.selectedNozzleId,
                    nozzleDiameterMm: selectedTool.nozzle.diameterMm,
                    confirmedAt: store.environment.now(),
                  });
                }}
              />
              Installed tool {state.binding.selectedToolId}, toolhead{' '}
              {state.binding.selectedToolheadId}, and{' '}
              {selectedTool?.nozzle.diameterMm} mm nozzle{' '}
              {state.binding.selectedNozzleId} match.
            </label>
            <p className="cal-field-help">
              Confirmation expires whenever snapshot or selected physical tool
              identity changes.
            </p>
          </section>

          <section
            className="cal-pane cal-detail-pane"
            aria-labelledby="snapshot-history-title"
          >
            <h2 id="snapshot-history-title">Snapshot history</h2>
            <ol className="cal-timeline">
              {state.snapshotHistory.map((snapshot) => (
                <li key={`${snapshot.snapshotId}-${snapshot.snapshotRevision}`}>
                  <span>
                    {snapshot.snapshotId}, revision {snapshot.snapshotRevision}
                  </span>
                  <time dateTime={snapshot.capturedAt}>
                    {formatTimestamp(snapshot.capturedAt)}
                  </time>
                </li>
              ))}
            </ol>
          </section>

          {/* Immutable job provenance — criterion 11 */}
          {queueProvenance !== null && (
            <CalibrationProvenance provenance={queueProvenance} />
          )}
        </aside>
      </div>
    </section>
  );
}
