import { useEffect, useMemo, useState } from 'react';
import {
  createCalibrationState,
  validateBaselineProfile,
  type BaselineProfile,
  type CalibrationMode,
} from './domain';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import {
  bindingFromContext,
  candidateEligibilityBlockers,
  contextEligibilityBlockers,
  orcaProfileScopeBlockers,
  selectedBaseProfileFromEntry,
} from './projectEligibility';

interface FormState {
  readonly displayName: string;
  readonly description: string;
  readonly printerId: string;
  readonly toolId: string;
  readonly provider: string;
  readonly product: string;
  readonly sku: string;
  readonly spoolId: string;
  readonly baseProfileId: string;
  readonly mode: CalibrationMode | '';
  readonly nozzleTemperatureC: string;
  readonly flowRatio: string;
  readonly pressureAdvance: string;
  readonly retractionLengthMm: string;
  readonly maximumVolumetricRateMm3S: string;
  readonly shrinkageCompensationXPercent: string;
  readonly shrinkageCompensationYPercent: string;
  readonly shrinkageCompensationZPercent: string;
  readonly physicalMatch: boolean;
  readonly emergencyStop: boolean;
  readonly thermalProtection: boolean;
  readonly ventilation: boolean;
  readonly machineClear: boolean;
}

const emptyForm: FormState = {
  displayName: '',
  description: '',
  printerId: '',
  toolId: '',
  provider: '',
  product: '',
  sku: '',
  spoolId: '',
  baseProfileId: '',
  mode: '',
  nozzleTemperatureC: '',
  flowRatio: '',
  pressureAdvance: '',
  retractionLengthMm: '',
  maximumVolumetricRateMm3S: '',
  shrinkageCompensationXPercent: '',
  shrinkageCompensationYPercent: '',
  shrinkageCompensationZPercent: '',
  physicalMatch: false,
  emergencyStop: false,
  thermalProtection: false,
  ventilation: false,
  machineClear: false,
};

type FormErrors = Readonly<Record<string, string>>;

function parseNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function NewCalibrationProject(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const canLoad =
    store.profileId !== null &&
    !store.offline &&
    store.availability?.available === true;
  const creationLoaded = store.creation.loaded;
  const creationLoading = store.creation.loading;
  const loadCreationData = store.loadCreationData;
  useEffect(() => {
    if (canLoad && !creationLoaded && !creationLoading) {
      void loadCreationData();
    }
  }, [canLoad, creationLoaded, creationLoading, loadCreationData]);

  const selectedCandidate = store.creation.printers.find(
    (candidate) => candidate.printerId === form.printerId,
  );
  const candidateBlockers = candidateEligibilityBlockers(selectedCandidate);
  const contextBlockers = contextEligibilityBlockers(
    store.creation.context,
    selectedCandidate,
  );
  const selectedTool = store.creation.context?.toolheads.find(
    (tool) => tool.toolId === form.toolId,
  );
  const scopedProfiles = store.creation.profiles.filter(
    (profile) =>
      orcaProfileScopeBlockers(profile, store.creation.context, form.toolId)
        .length === 0,
  );
  const selectedProfile = scopedProfiles.find(
    (profile) => profile.orcaProfileId === form.baseProfileId,
  );
  const profileBlockers = orcaProfileScopeBlockers(
    store.creation.profiles.find(
      (profile) => profile.orcaProfileId === form.baseProfileId,
    ),
    store.creation.context,
    form.toolId,
  );

  const update = <Key extends keyof FormState>(
    key: Key,
    value: FormState[Key],
  ): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const readiness = useMemo(() => {
    const blockers = [...candidateBlockers, ...contextBlockers];
    if (store.profileId === null)
      blockers.unshift('Select a PrintFarmer profile.');
    else if (store.offline) blockers.unshift('Reconnect to create a project.');
    else if (store.availability?.available !== true)
      blockers.unshift('Printer Calibration is unavailable for this profile.');
    if (form.toolId === '')
      blockers.push('Select the physical tool and nozzle explicitly.');
    if (form.baseProfileId === '') {
      blockers.push(
        'Select a scope-matched PrintFarmer OrcaSlicer base profile explicitly.',
      );
    } else {
      blockers.push(...profileBlockers);
    }
    if (form.mode === '') blockers.push('Choose Coach or Expert mode.');
    if (!form.physicalMatch)
      blockers.push(
        'Confirm the installed physical toolhead and nozzle match the selection.',
      );
    if (
      !form.emergencyStop ||
      !form.thermalProtection ||
      !form.ventilation ||
      !form.machineClear
    )
      blockers.push('Complete every operator safety acknowledgment.');
    return [...new Set(blockers)];
  }, [
    candidateBlockers,
    contextBlockers,
    form.baseProfileId,
    form.emergencyStop,
    form.machineClear,
    form.mode,
    form.physicalMatch,
    profileBlockers,
    form.thermalProtection,
    form.toolId,
    form.ventilation,
    store.availability?.available,
    store.offline,
    store.profileId,
  ]);

  const validate = (): {
    errors: FormErrors;
    baseline: BaselineProfile | null;
  } => {
    const next: Record<string, string> = {};
    if (form.displayName.trim() === '')
      next.displayName = 'Enter a project name.';
    if (form.provider.trim() === '')
      next.provider = 'Enter the filament provider.';
    if (form.product.trim() === '')
      next.product = 'Enter the filament product.';
    if (form.sku.trim() === '') next.sku = 'Enter the filament SKU.';
    if (selectedTool === undefined)
      next.toolId = 'Select a returned physical tool.';
    if (selectedProfile === undefined) {
      next.baseProfileId =
        profileBlockers.join(' ') ||
        'Select a scope-matched profile returned by PrintFarmer discovery.';
    }
    if (form.mode === '') next.mode = 'Choose Coach or Expert mode.';
    const numericFields = [
      'nozzleTemperatureC',
      'flowRatio',
      'pressureAdvance',
      'retractionLengthMm',
      'maximumVolumetricRateMm3S',
      'shrinkageCompensationXPercent',
      'shrinkageCompensationYPercent',
      'shrinkageCompensationZPercent',
    ] as const;
    const values: Partial<Record<(typeof numericFields)[number], number>> = {};
    for (const field of numericFields) {
      const value = parseNumber(form[field]);
      if (value === null)
        next[field] = 'Enter a finite numeric baseline value.';
      else values[field] = value;
    }
    if (!form.physicalMatch)
      next.physicalMatch = 'Confirm the exact physical tool match.';
    if (!form.emergencyStop)
      next.emergencyStop = 'Acknowledge the emergency stop location.';
    if (!form.thermalProtection)
      next.thermalProtection = 'Acknowledge the confirmed thermal protection.';
    if (!form.ventilation)
      next.ventilation = 'Acknowledge the ventilation assessment.';
    if (!form.machineClear)
      next.machineClear = 'Confirm the machine and bed are clear.';
    if (candidateBlockers.length > 0)
      next.printerId = candidateBlockers.join(' ');
    if (contextBlockers.length > 0) next.context = contextBlockers.join(' ');

    if (Object.keys(values).length !== numericFields.length) {
      return { errors: next, baseline: null };
    }
    const baseline: BaselineProfile = {
      nozzleTemperatureC: values.nozzleTemperatureC!,
      flowRatio: values.flowRatio!,
      pressureAdvance: values.pressureAdvance!,
      retractionLengthMm: values.retractionLengthMm!,
      maximumVolumetricRateMm3S: values.maximumVolumetricRateMm3S!,
      shrinkageCompensationXPercent: values.shrinkageCompensationXPercent!,
      shrinkageCompensationYPercent: values.shrinkageCompensationYPercent!,
      shrinkageCompensationZPercent: values.shrinkageCompensationZPercent!,
    };
    for (const diagnostic of validateBaselineProfile(baseline)) {
      if (diagnostic.field) next[diagnostic.field] = diagnostic.message;
    }
    const safety = store.creation.context?.safety;
    if (
      safety &&
      baseline.nozzleTemperatureC > safety.maximumNozzleTemperatureC
    ) {
      next.nozzleTemperatureC =
        'Baseline temperature exceeds the current printer safety limit.';
    }
    if (
      safety &&
      baseline.maximumVolumetricRateMm3S > safety.maximumVolumetricRateMm3S
    ) {
      next.maximumVolumetricRateMm3S =
        'Baseline volumetric rate exceeds the current printer safety limit.';
    }
    return { errors: next, baseline };
  };

  const submit = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const validation = validate();
    setErrors(validation.errors);
    if (
      Object.keys(validation.errors).length > 0 ||
      validation.baseline === null ||
      store.profileId === null ||
      store.creation.context === null ||
      selectedCandidate === undefined ||
      selectedTool === undefined ||
      selectedProfile === undefined ||
      form.mode === ''
    ) {
      store.announce('Project creation has errors. Review the error summary.');
      window.setTimeout(
        () => document.getElementById('new-project-errors')?.focus(),
        0,
      );
      return;
    }
    const now = store.environment.now();
    const binding = bindingFromContext(
      store.profileId,
      store.creation.context,
      selectedTool.toolId,
      {
        filamentProjectId: store.environment.createId(),
        provider: form.provider.trim(),
        product: form.product.trim(),
        sku: form.sku.trim(),
        ...(form.spoolId.trim() ? { spoolId: form.spoolId.trim() } : {}),
      },
    );
    if (binding === null) {
      setErrors({
        context:
          'The current printer context is incomplete and cannot be bound.',
      });
      return;
    }
    const projectId = store.environment.createId();
    const domainState = createCalibrationState({
      projectId,
      createdAt: now,
      mode: form.mode,
      baseline: validation.baseline,
      binding,
    });
    if (
      domainState.diagnostics.some(
        (diagnostic) => diagnostic.severity === 'error',
      )
    ) {
      setErrors({
        binding: domainState.diagnostics
          .filter((diagnostic) => diagnostic.severity === 'error')
          .map((diagnostic) => diagnostic.message)
          .join(' '),
      });
      return;
    }
    const selectedBaseProfile = selectedBaseProfileFromEntry(selectedProfile);
    if (selectedBaseProfile === null) {
      setErrors({
        baseProfileId:
          'The selected base profile is not a PrintFarmer upstream profile.',
      });
      return;
    }
    setSubmitting(true);
    await store.createProject({
      domainState,
      displayName: form.displayName,
      description: form.description,
      printerId: selectedCandidate.printerId,
      selectedBaseProfile,
      physicalMatch: {
        snapshotId: binding.snapshot.snapshotId,
        toolId: selectedTool.toolId,
        toolheadId: selectedTool.toolheadId,
        nozzleId: selectedTool.nozzle.id,
        nozzleDiameterMm: selectedTool.nozzle.diameterMm,
        confirmedAt: now,
      },
    });
    setSubmitting(false);
  };

  const fieldError = (field: string): React.JSX.Element | null =>
    errors[field] ? (
      <span id={`new-${field}-error`} className="cal-field-error">
        {errors[field]}
      </span>
    ) : null;
  const describedBy = (field: string): string | undefined =>
    errors[field] ? `new-${field}-error` : undefined;

  return (
    <section className="cal-view" aria-labelledby="new-calibration-title">
      <header className="cal-view-heading">
        <div>
          <h1 id="new-calibration-title" data-cal-heading tabIndex={-1}>
            New calibration project
          </h1>
          <p className="cal-subtitle">
            Every printer, snapshot, tool, nozzle, material, profile, and
            baseline value is explicit.
          </p>
        </div>
        <button
          type="button"
          className="cal-button"
          onClick={() => void store.navigate('dashboard')}
        >
          Back to dashboard
        </button>
      </header>

      {!canLoad ? (
        <div className="cal-alert" role="alert">
          <p>
            {store.profileId === null
              ? 'No PrintFarmer profile is selected.'
              : store.offline
                ? 'Project creation is unavailable offline because current printer context cannot be verified.'
                : (store.availability?.unavailableDetail ??
                  'Printer Calibration is unavailable for this profile.')}
          </p>
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.manageProfiles()}
          >
            Manage PrintFarmer profiles
          </button>
        </div>
      ) : null}
      {store.creation.error ? (
        <div className="cal-alert" role="alert">
          <p>{store.creation.error}</p>
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.loadCreationData()}
          >
            Retry candidates and profiles
          </button>
        </div>
      ) : null}
      {Object.keys(errors).length > 0 ? (
        <div
          id="new-project-errors"
          className="cal-error-summary"
          role="alert"
          tabIndex={-1}
        >
          <h2>Project cannot be created</h2>
          <ul>
            {Object.entries(errors).map(([field, message]) => (
              <li key={field}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="cal-flow-layout">
        <form
          className="cal-form-pane"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          <fieldset
            disabled={
              !canLoad || store.creation.loading || submitting || store.disabled
            }
          >
            <legend>Project and PrintFarmer printer</legend>
            <label>
              Project name
              <input
                value={form.displayName}
                maxLength={256}
                onChange={(event) => update('displayName', event.target.value)}
                aria-invalid={Boolean(errors.displayName)}
                aria-describedby={describedBy('displayName')}
                required
              />
              {fieldError('displayName')}
            </label>
            <label>
              Description <span className="cal-optional">Optional</span>
              <textarea
                value={form.description}
                maxLength={4096}
                onChange={(event) => update('description', event.target.value)}
              />
            </label>
            <div className="cal-field-group">
              <span className="cal-label" id="printer-choice-label">
                PrintFarmer printer candidate
              </span>
              {store.creation.loading ? (
                <p role="status">Loading candidates from PrintFarmer.</p>
              ) : null}
              {!store.creation.loading &&
              store.creation.printers.length === 0 ? (
                <p>No printer candidates were returned.</p>
              ) : null}
              {!store.creation.loading && store.creation.printersTruncated ? (
                <p role="status" className="cal-hint">
                  This list is partial. PrintFarmer offered more printers than
                  this view can show, so a printer you expect may not appear
                  below.
                </p>
              ) : null}
              {!store.creation.loading &&
              store.creation.printersUnreadable > 0 ? (
                <p role="status" className="cal-hint">
                  {store.creation.printersUnreadable} printer record
                  {store.creation.printersUnreadable === 1 ? '' : 's'} could not
                  be read and{' '}
                  {store.creation.printersUnreadable === 1 ? 'is' : 'are'} not
                  listed below. The rest of the list is unaffected.
                </p>
              ) : null}
              <div
                className="cal-choice-list"
                role="radiogroup"
                aria-labelledby="printer-choice-label"
                aria-describedby={describedBy('printerId')}
              >
                {store.creation.printers.map((candidate) => {
                  const blockers = candidateEligibilityBlockers(candidate);
                  return (
                    <label key={candidate.printerId} className="cal-choice-row">
                      <input
                        type="radio"
                        name="printer"
                        value={candidate.printerId}
                        checked={form.printerId === candidate.printerId}
                        onChange={() => {
                          update('printerId', candidate.printerId);
                          update('toolId', '');
                          update('physicalMatch', false);
                        }}
                      />
                      <span>
                        <strong>{candidate.displayName}</strong>
                        <small>
                          {candidate.printerModel ?? 'Model not supplied'};{' '}
                          {blockers.length === 0
                            ? 'explicitly eligible'
                            : 'not eligible'}
                          ; {candidate.isOnline ? 'online' : 'offline'}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
              {fieldError('printerId')}
              <button
                type="button"
                className="cal-button"
                disabled={
                  candidateBlockers.length > 0 || store.creation.contextLoading
                }
                onClick={() => void store.loadPrinterContext(form.printerId)}
                aria-describedby="candidate-eligibility"
              >
                {store.creation.contextLoading
                  ? 'Loading current context'
                  : 'Load current printer context'}
              </button>
              <ul id="candidate-eligibility" className="cal-blocker-list">
                {candidateBlockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
              {store.creation.context?.printerId === form.printerId ? (
                <p
                  role="status"
                  className={
                    contextBlockers.length ? 'cal-field-error' : 'cal-success'
                  }
                >
                  Context loaded at {store.creation.context.snapshotAt}.{' '}
                  {contextBlockers.length
                    ? 'Creation remains blocked.'
                    : 'Context is complete and current.'}
                </p>
              ) : null}
              {store.creation.context?.printerId === form.printerId ? (
                <dl className="cal-definition-list cal-definition-list--compact">
                  <div>
                    <dt>Firmware</dt>
                    <dd>
                      {store.creation.context.firmware.firmware}; dialect{' '}
                      {store.creation.context.firmware.gcodeDialect}; version{' '}
                      {store.creation.context.firmware.firmwareVersion ??
                        'not supplied'}
                    </dd>
                  </div>
                  <div>
                    <dt>Configuration</dt>
                    <dd>
                      {store.creation.context.configurationId ?? 'missing'},
                      revision{' '}
                      {store.creation.context.configurationRevision ??
                        'missing'}
                    </dd>
                  </div>
                  <div>
                    <dt>Snapshot</dt>
                    <dd>
                      {store.creation.context.snapshotId ?? 'missing'}, revision{' '}
                      {store.creation.context.snapshotRevision ?? 'missing'}
                    </dd>
                  </div>
                  <div>
                    <dt>Machine dimensions</dt>
                    <dd>
                      {store.creation.context.bedWidthMm ?? 'missing'} by{' '}
                      {store.creation.context.bedDepthMm ?? 'missing'} mm bed;
                      reported nozzle{' '}
                      {store.creation.context.nozzleDiameterMm ?? 'missing'} mm
                    </dd>
                  </div>
                  <div>
                    <dt>Safety limits</dt>
                    <dd>
                      {store.creation.context.safety
                        ? `${store.creation.context.safety.maximumNozzleTemperatureC} C nozzle; ${store.creation.context.safety.maximumBedTemperatureC} C bed; ${store.creation.context.safety.maximumVolumetricRateMm3S} mm3/s`
                        : 'missing'}
                    </dd>
                  </div>
                  <div>
                    <dt>Safety confirmations</dt>
                    <dd>
                      {store.creation.context.safety
                        ? `Emergency stop ${store.creation.context.safety.emergencyStopAvailable ? 'available' : 'not confirmed'}; thermal protection ${store.creation.context.safety.thermalProtectionConfirmed ? 'confirmed' : 'not confirmed'}; ventilation ${store.creation.context.safety.ventilationAssessed ? 'assessed' : 'not assessed'}`
                        : 'missing'}
                    </dd>
                  </div>
                  <div>
                    <dt>Permissions</dt>
                    <dd>
                      {store.creation.context.permissions
                        ? `Read ${store.creation.context.permissions.readPrinter ? 'yes' : 'no'}; write ${store.creation.context.permissions.writeCalibration ? 'yes' : 'no'}; generate ${store.creation.context.permissions.generateCalibration ? 'yes' : 'no'}; start ${store.creation.context.permissions.startPrint ? 'yes' : 'no'}`
                        : 'missing'}
                    </dd>
                  </div>
                </dl>
              ) : null}
              {errors.context ? (
                <p id="new-context-error" className="cal-field-error">
                  {errors.context}
                </p>
              ) : null}
            </div>
          </fieldset>

          <fieldset disabled={!canLoad || submitting || store.disabled}>
            <legend>Physical tool, toolhead, and nozzle</legend>
            <label>
              Physical tool and nozzle
              <select
                value={form.toolId}
                onChange={(event) => {
                  update('toolId', event.target.value);
                  update('physicalMatch', false);
                }}
                aria-invalid={Boolean(errors.toolId)}
                aria-describedby={describedBy('toolId')}
                required
              >
                <option value="">Select the installed tool</option>
                {store.creation.context?.toolheads.map((tool) => (
                  <option key={tool.toolId} value={tool.toolId}>
                    {tool.toolId}; {tool.toolheadId}; {tool.nozzle.id};{' '}
                    {tool.nozzle.diameterMm} mm {tool.nozzle.material};{' '}
                    {tool.extruderType === 'directDrive'
                      ? 'direct drive'
                      : 'Bowden'}
                  </option>
                ))}
              </select>
              {fieldError('toolId')}
            </label>
            {selectedTool ? (
              <dl className="cal-definition-list cal-definition-list--compact">
                <div>
                  <dt>Tool</dt>
                  <dd>{selectedTool.toolId}</dd>
                </div>
                <div>
                  <dt>Toolhead</dt>
                  <dd>{selectedTool.toolheadId}</dd>
                </div>
                <div>
                  <dt>Nozzle</dt>
                  <dd>
                    {selectedTool.nozzle.id}, {selectedTool.nozzle.diameterMm}{' '}
                    mm {selectedTool.nozzle.material}
                  </dd>
                </div>
                <div>
                  <dt>Extruder</dt>
                  <dd>
                    {selectedTool.extruderType === 'directDrive'
                      ? 'Direct drive'
                      : 'Bowden'}
                  </dd>
                </div>
              </dl>
            ) : null}
            <label className="cal-checkbox">
              <input
                type="checkbox"
                checked={form.physicalMatch}
                onChange={(event) =>
                  update('physicalMatch', event.target.checked)
                }
                aria-invalid={Boolean(errors.physicalMatch)}
                aria-describedby={describedBy('physicalMatch')}
              />
              I verified the installed physical toolhead and nozzle exactly
              match this selection.
            </label>
            {fieldError('physicalMatch')}
          </fieldset>

          <fieldset disabled={!canLoad || submitting || store.disabled}>
            <legend>Filament identity</legend>
            <div className="cal-form-grid">
              {(
                [
                  ['provider', 'Provider'],
                  ['product', 'Product'],
                  ['sku', 'SKU'],
                ] as const
              ).map(([field, label]) => (
                <label key={field}>
                  {label}
                  <input
                    value={form[field]}
                    maxLength={256}
                    onChange={(event) => update(field, event.target.value)}
                    aria-invalid={Boolean(errors[field])}
                    aria-describedby={describedBy(field)}
                    required
                  />
                  {fieldError(field)}
                </label>
              ))}
              <label>
                Spool ID <span className="cal-optional">Optional</span>
                <input
                  value={form.spoolId}
                  maxLength={256}
                  onChange={(event) => update('spoolId', event.target.value)}
                />
              </label>
            </div>
          </fieldset>

          <fieldset disabled={!canLoad || submitting || store.disabled}>
            <legend>Base OrcaSlicer profile and mode</legend>
            <label>
              Base OrcaSlicer profile
              <select
                value={form.baseProfileId}
                onChange={(event) =>
                  update('baseProfileId', event.target.value)
                }
                aria-invalid={Boolean(errors.baseProfileId)}
                aria-describedby={describedBy('baseProfileId')}
                required
              >
                <option value="">Select a discovered profile</option>
                {scopedProfiles.map((profile) => (
                  <option
                    key={profile.orcaProfileId}
                    value={profile.orcaProfileId}
                  >
                    {profile.displayName}; {profile.source}
                  </option>
                ))}
              </select>
              {fieldError('baseProfileId')}
            </label>
            <fieldset
              className="cal-inline-fieldset"
              aria-describedby={describedBy('mode')}
            >
              <legend>Workflow mode</legend>
              <label className="cal-radio">
                <input
                  type="radio"
                  name="mode"
                  checked={form.mode === 'coach'}
                  onChange={() => update('mode', 'coach')}
                />
                Coach: bounded guidance
              </label>
              <label className="cal-radio">
                <input
                  type="radio"
                  name="mode"
                  checked={form.mode === 'expert'}
                  onChange={() => update('mode', 'expert')}
                />
                Expert: additional methods
              </label>
              {fieldError('mode')}
            </fieldset>
          </fieldset>

          <fieldset disabled={!canLoad || submitting || store.disabled}>
            <legend>Numeric baseline profile values</legend>
            <div className="cal-form-grid">
              {(
                [
                  [
                    'nozzleTemperatureC',
                    'Nozzle temperature (C)',
                    '1',
                    150,
                    400,
                  ],
                  ['flowRatio', 'Flow ratio', '0.001', 0.5, 1.5],
                  ['pressureAdvance', 'Pressure advance (s)', '0.001', 0, 10],
                  [
                    'retractionLengthMm',
                    'Retraction length (mm)',
                    '0.1',
                    0,
                    100,
                  ],
                  [
                    'maximumVolumetricRateMm3S',
                    'Maximum volumetric rate (mm3/s)',
                    '0.1',
                    0.001,
                    10_000,
                  ],
                  [
                    'shrinkageCompensationXPercent',
                    'X shrinkage compensation (%)',
                    '0.01',
                    -100,
                    100,
                  ],
                  [
                    'shrinkageCompensationYPercent',
                    'Y shrinkage compensation (%)',
                    '0.01',
                    -100,
                    100,
                  ],
                  [
                    'shrinkageCompensationZPercent',
                    'Z shrinkage compensation (%)',
                    '0.01',
                    -100,
                    100,
                  ],
                ] as const
              ).map(([field, label, step, min, max]) => (
                <label key={field}>
                  {label}
                  <input
                    type="number"
                    step={step}
                    min={min}
                    max={max}
                    value={form[field]}
                    onChange={(event) => update(field, event.target.value)}
                    aria-invalid={Boolean(errors[field])}
                    aria-describedby={describedBy(field)}
                    required
                  />
                  {fieldError(field)}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset disabled={!canLoad || submitting || store.disabled}>
            <legend>Operator safety acknowledgment</legend>
            <p>
              Use the current PrintFarmer safety context and physically inspect
              the machine before proceeding.
            </p>
            {(
              [
                [
                  'emergencyStop',
                  'I located and can operate the emergency stop.',
                ],
                [
                  'thermalProtection',
                  'I reviewed the confirmed thermal protection status.',
                ],
                [
                  'ventilation',
                  'I reviewed the ventilation assessment for this material.',
                ],
                [
                  'machineClear',
                  'The machine, build plate, and motion area are clear.',
                ],
              ] as const
            ).map(([field, label]) => (
              <div key={field}>
                <label className="cal-checkbox">
                  <input
                    type="checkbox"
                    checked={form[field]}
                    onChange={(event) => update(field, event.target.checked)}
                    aria-invalid={Boolean(errors[field])}
                    aria-describedby={describedBy(field)}
                  />
                  {label}
                </label>
                {fieldError(field)}
              </div>
            ))}
          </fieldset>

          <div className="cal-review-bar">
            <div>
              <strong>Create exact local workspace</strong>
              <p>
                Creation queues one exact state record locally. It does not
                generate or start a print.
              </p>
            </div>
            <button
              type="submit"
              className="cal-button cal-button--primary"
              disabled={!canLoad || submitting || store.disabled}
            >
              {submitting ? 'Creating project' : 'Create calibration project'}
            </button>
          </div>
        </form>

        <aside
          className="cal-flow-aside"
          aria-labelledby="creation-readiness-title"
        >
          <section className="cal-pane cal-detail-pane">
            <h2 id="creation-readiness-title">Creation readiness</h2>
            <p>
              Eligibility uses only explicit typed fields from PrintFarmer.
              Names and legacy compatibility flags are ignored.
            </p>
            {readiness.length === 0 ? (
              <p className="cal-success">
                Identity and safety selections are ready for validation.
              </p>
            ) : (
              <ul className="cal-blocker-list" aria-live="polite">
                {readiness.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
