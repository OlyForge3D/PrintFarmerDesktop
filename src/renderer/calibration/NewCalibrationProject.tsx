import { useEffect, useMemo, useRef, useState } from 'react';
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
  /**
   * The candidate the operator is looking at, which is not yet the one they
   * chose. Kept apart from the store's `selectedPrinterId` so moving through the
   * list costs nothing.
   */
  const [highlightedPrinterId, setHighlightedPrinterId] = useState<
    string | null
  >(null);

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

  // The store owns the selection because it also owns the fetches the selection
  // triggers and the fencing that discards their late replies. Mirroring it into
  // form state would create a second source of truth that could disagree with
  // whichever printer the loaded context actually describes.
  const selectedPrinterId = store.creation.selectedPrinterId;
  const selectedCandidate = store.creation.printers.find(
    (candidate) => candidate.printerId === selectedPrinterId,
  );
  const highlightedCandidate = store.creation.printers.find(
    (candidate) => candidate.printerId === highlightedPrinterId,
  );
  const highlightedBlockers = candidateEligibilityBlockers(
    highlightedCandidate,
  );
  const candidateBlockers = candidateEligibilityBlockers(selectedCandidate);
  // Only ever read when it belongs to the current selection. The store already
  // fences responses, and this makes a stale render impossible as well.
  const context =
    store.creation.context?.printerId === selectedPrinterId
      ? store.creation.context
      : null;
  const contextBlockers = contextEligibilityBlockers(context, selectedCandidate);
  const printerChosen = selectedPrinterId !== null;
  const printerReady =
    printerChosen && candidateBlockers.length === 0 && context !== null;
  const selectedTool = context?.toolheads.find(
    (tool) => tool.toolId === form.toolId,
  );
  const scopedProfiles = store.creation.profiles.filter(
    (profile) =>
      orcaProfileScopeBlockers(profile, context, form.toolId).length === 0,
  );
  const selectedProfile = scopedProfiles.find(
    (profile) => profile.orcaProfileId === form.baseProfileId,
  );
  const profileBlockers = orcaProfileScopeBlockers(
    store.creation.profiles.find(
      (profile) => profile.orcaProfileId === form.baseProfileId,
    ),
    context,
    form.toolId,
  );

  /**
   * Highlight a printer without loading anything.
   *
   * Native radio groups move selection with the arrow keys, firing `change` on
   * every candidate passed through. Fetching a context there meant traversing a
   * ten-printer list with the keyboard issued ten context requests and ten
   * profile resolutions for printers the operator never chose — the same
   * fan-out this work removes, reintroduced through the keyboard. Highlighting
   * is local state only; nothing leaves the process until Step 2 is activated.
   */
  const highlightPrinter = (printerId: string): void => {
    setHighlightedPrinterId(printerId);
    setErrors((current) => {
      if (!('printerId' in current)) return current;
      const next = { ...current };
      delete next.printerId;
      return next;
    });
  };

  /**
   * Commit the highlighted printer. This is the only path that fetches.
   *
   * Every downstream field is reset here rather than left to settle, because a
   * tool, profile or safety acknowledgement carried over from the previous
   * printer would describe hardware the operator is no longer configuring.
   */
  const choosePrinter = (printerId: string | null): void => {
    setForm((current) => ({
      ...current,
      toolId: '',
      baseProfileId: '',
      physicalMatch: false,
      machineClear: false,
    }));
    setErrors({});
    setHighlightedPrinterId(printerId);
    void store.selectPrinter(printerId);
  };

  // Focus follows the outcome of a selection rather than staying where the
  // activation landed: when a choice is refused, the reason is what the operator
  // needs next, and when it is cleared, the list they must choose from again.
  const previousSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousSelectionRef.current;
    previousSelectionRef.current = selectedPrinterId;
    if (previous === selectedPrinterId) return;
    if (selectedPrinterId === null) {
      if (previous !== null) {
        window.setTimeout(
          () =>
            document
              .querySelector<HTMLElement>('.cal-choice-list input[type=radio]')
              ?.focus(),
          0,
        );
      }
      return;
    }
    if (candidateBlockers.length > 0) {
      window.setTimeout(
        () => document.getElementById('candidate-eligibility')?.focus(),
        0,
      );
    }
  }, [candidateBlockers.length, selectedPrinterId]);

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

  /**
   * Turn the typed server diagnostic into something the operator can act on.
   *
   * The diagnostic was previously stored and never rendered, which meant the
   * wizard knew exactly why discovery had failed and showed none of it.
   */
  const profileNotice = useMemo((): {
    tone: 'error' | 'info';
    message: string;
  } | null => {
    const diagnostic = store.creation.profileDiagnostic;
    if (diagnostic === null || context === null) return null;
    switch (diagnostic.kind) {
      case 'ok':
        return null;
      case 'unauthenticated':
      case 'forbidden':
        return { tone: 'error', message: diagnostic.message };
      case 'profileResolverUnavailable':
        return {
          tone: 'error',
          message: `${diagnostic.message} Calibration cannot start until it is restored.`,
        };
      case 'selectedPrinterContextUnavailable':
      case 'selectedPrinterNotACandidate':
      case 'noProfilesForSelectedPrinter':
        return { tone: 'error', message: diagnostic.message };
      default:
        return { tone: 'error', message: diagnostic.message };
    }
  }, [context, store.creation.profileDiagnostic]);

  const localNotice = useMemo((): string | null => {
    const diagnostic = store.creation.localDiagnostic;
    if (diagnostic === null || context === null || diagnostic.kind === 'ok')
      return null;
    return diagnostic.message;
  }, [context, store.creation.localDiagnostic]);

  const readiness = useMemo(() => {
    const blockers = [...candidateBlockers, ...contextBlockers];
    if (store.profileId === null)
      blockers.unshift('Select a PrintFarmer profile.');
    else if (store.offline) blockers.unshift('Reconnect to create a project.');
    else if (store.availability?.available !== true)
      blockers.unshift('Printer Calibration is unavailable for this profile.');
    // Stated first because it is the first thing the wizard asks and every
    // other requirement below is a property of the printer chosen here.
    if (!printerChosen)
      blockers.unshift('Select the PrintFarmer printer to calibrate.');
    else if (context === null)
      blockers.push(
        'Load the selected printer configuration before continuing.',
      );
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
    context,
    contextBlockers,
    form.baseProfileId,
    form.emergencyStop,
    form.machineClear,
    form.mode,
    form.physicalMatch,
    printerChosen,
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
    const safety = context?.safety;
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
      // A project may not be created until the selected printer's context and
      // profiles have actually resolved. `printerReady` is the same condition
      // the downstream steps are gated on, so a project can never be created
      // from a form the operator was not able to complete.
      !printerReady ||
      context === null ||
      store.creation.contextLoading ||
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
      context,
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
      {store.creation.listError ? (
        <div className="cal-alert" role="alert">
          <p>{store.creation.listError}</p>
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.loadCreationData()}
          >
            Retry loading printers
          </button>
        </div>
      ) : null}
      {store.creation.error ? (
        // Scoped to the selected printer. The printer list stays on screen
        // behind this: a context or profile failure describes one machine and
        // must never read as "there are no printers".
        <div className="cal-alert" role="alert">
          <p>{store.creation.error}</p>
          <button
            type="button"
            className="cal-button"
            onClick={() => void store.selectPrinter(selectedPrinterId)}
          >
            Retry selected printer
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
          {/*
            Step one, and it is a step rather than a field: nothing else in this
            wizard can be described until the machine being calibrated is known.
            The printer list is the only thing fetched before this choice.
          */}
          <fieldset
            disabled={!canLoad || submitting || store.disabled}
            className="cal-step-fieldset"
          >
            <legend>Step 1. Choose the printer to calibrate</legend>
            <div className="cal-field-group">
              <span className="cal-label" id="printer-choice-label">
                PrintFarmer printer
              </span>
              <p id="printer-choice-help" className="cal-hint">
                Calibration settings are specific to one printer. Choose it
                first; its configuration and profiles are loaded only then.
              </p>

              {store.creation.loading ? (
                <p role="status" className="cal-hint">
                  Loading PrintFarmer printers.
                </p>
              ) : null}

              {!store.creation.loading &&
              store.creation.loaded &&
              store.creation.printers.length === 0 ? (
                <div className="cal-empty-state">
                  <p>
                    {store.creation.listError === null
                      ? 'PrintFarmer returned no enabled printers for this account. Add or enable a printer in PrintFarmer, then reload.'
                      : store.creation.listError}
                  </p>
                  <button
                    type="button"
                    className="cal-button"
                    onClick={() => void store.loadCreationData()}
                  >
                    Reload printers
                  </button>
                </div>
              ) : null}

              {!store.creation.loading &&
              store.creation.printers.length > 0 &&
              store.creation.printersTruncated ? (
                // Announced before the eligibility summary below, because a
                // partial list changes what "none of these is eligible" means:
                // the printer the operator is looking for may simply be off the
                // end rather than refused.
                <p role="status" className="cal-hint">
                  This list is partial. PrintFarmer offered more printers than
                  this view can show, so a printer you expect may not appear
                  below.
                </p>
              ) : null}

              {!store.creation.loading &&
              store.creation.printers.length > 0 &&
              store.creation.printers.every(
                (candidate) =>
                  candidateEligibilityBlockers(candidate).length > 0,
              ) ? (
                // Deliberately distinct from "no printers": the farm has
                // printers and the account can see them. Collapsing the two
                // would send the operator to add hardware they already own.
                <p className="cal-notice" role="status">
                  None of the {store.creation.printers.length} available
                  printers is currently eligible for calibration. Select one to
                  see why.
                </p>
              ) : null}

              <div
                className="cal-choice-list"
                role="radiogroup"
                aria-labelledby="printer-choice-label"
                aria-describedby={
                  describedBy('printerId') ?? 'printer-choice-help'
                }
              >
                {store.creation.printers.map((candidate) => {
                  const blockers = candidateEligibilityBlockers(candidate);
                  const rowId = `printer-${candidate.printerId}`;
                  return (
                    <label
                      key={candidate.printerId}
                      className="cal-choice-row"
                      htmlFor={rowId}
                    >
                      <input
                        id={rowId}
                        type="radio"
                        name="printer"
                        value={candidate.printerId}
                        checked={highlightedPrinterId === candidate.printerId}
                        // Highlight only. Selection — and every fetch it causes
                        // — happens on explicit activation below, so arrowing
                        // through the list performs no requests at all.
                        onChange={() => highlightPrinter(candidate.printerId)}
                        aria-describedby={`${rowId}-detail`}
                      />
                      <span>
                        <strong>{candidate.displayName}</strong>
                        <small id={`${rowId}-detail`}>
                          {candidate.printerModel ?? 'Model not supplied'};{' '}
                          {candidate.isOnline ? 'online' : 'offline'};{' '}
                          {blockers.length === 0
                            ? 'eligible for calibration'
                            : 'not eligible for calibration'}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
              {fieldError('printerId')}

              <div className="cal-step-actions">
                <button
                  type="button"
                  className="cal-button cal-button--primary"
                  disabled={
                    highlightedPrinterId === null ||
                    highlightedBlockers.length > 0 ||
                    store.creation.contextLoading ||
                    highlightedPrinterId === selectedPrinterId
                  }
                  onClick={() => choosePrinter(highlightedPrinterId)}
                >
                  {store.creation.contextLoading
                    ? 'Loading printer configuration'
                    : 'Continue with this printer'}
                </button>
                {selectedPrinterId !== null ? (
                  <button
                    type="button"
                    className="cal-button"
                    onClick={() => choosePrinter(null)}
                  >
                    Choose a different printer
                  </button>
                ) : null}
              </div>

              {highlightedPrinterId !== null &&
              highlightedBlockers.length > 0 ? (
                // Ineligible printers stay highlightable so their reasons can be
                // read; continuation is blocked separately, so inspecting a
                // refusal never risks acting on it.
                <div className="cal-alert" role="alert">
                  <p>
                    {highlightedCandidate?.displayName ?? 'This printer'} cannot
                    be calibrated yet:
                  </p>
                  <ul
                    id="candidate-eligibility"
                    className="cal-blocker-list"
                    tabIndex={-1}
                  >
                    {highlightedBlockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {printerChosen &&
              candidateBlockers.length === 0 &&
              store.creation.contextLoading ? (
                <p role="status" className="cal-hint">
                  Loading configuration and profiles for{' '}
                  {selectedCandidate?.displayName ?? 'the selected printer'}.
                </p>
              ) : null}

              {printerChosen &&
              !store.creation.contextLoading &&
              context === null &&
              store.creation.error === null ? (
                <p className="cal-field-error" role="alert">
                  The configuration for this printer is unavailable. Other
                  printers are unaffected.
                </p>
              ) : null}

              {/*
                Each server-side outcome names a different remedy, so they are
                rendered as themselves rather than as one generic failure.
              */}
              {profileNotice ? (
                <p
                  className={
                    profileNotice.tone === 'error'
                      ? 'cal-field-error'
                      : 'cal-notice'
                  }
                  role={profileNotice.tone === 'error' ? 'alert' : 'status'}
                >
                  {profileNotice.message}
                </p>
              ) : null}

              {localNotice ? (
                <p className="cal-notice" role="status">
                  {localNotice}
                </p>
              ) : null}
            </div>
          </fieldset>

          <fieldset
            disabled={
              !printerReady ||
              !canLoad ||
              store.creation.contextLoading ||
              submitting ||
              store.disabled
            }
            className="cal-step-fieldset"
          >
            <legend>Step 2. Name the project</legend>
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

            {context !== null ? (
              <>
                <p
                  role="status"
                  className={
                    contextBlockers.length ? 'cal-field-error' : 'cal-success'
                  }
                >
                  Configuration loaded at {context.snapshotAt}.{' '}
                  {contextBlockers.length
                    ? 'Creation remains blocked.'
                    : 'Configuration is complete and current.'}
                </p>
                <dl className="cal-definition-list cal-definition-list--compact">
                  <div>
                    <dt>Firmware</dt>
                    <dd>
                      {context.firmware.firmware}; dialect{' '}
                      {context.firmware.gcodeDialect}; version{' '}
                      {context.firmware.firmwareVersion ?? 'not supplied'}
                    </dd>
                  </div>
                  <div>
                    <dt>Configuration</dt>
                    <dd>
                      {context.configurationId ?? 'missing'}, revision{' '}
                      {context.configurationRevision ?? 'missing'}
                    </dd>
                  </div>
                  <div>
                    <dt>Snapshot</dt>
                    <dd>
                      {context.snapshotId ?? 'missing'}, revision{' '}
                      {context.snapshotRevision ?? 'missing'}
                    </dd>
                  </div>
                  <div>
                    <dt>Machine dimensions</dt>
                    <dd>
                      {context.bedWidthMm ?? 'missing'} by{' '}
                      {context.bedDepthMm ?? 'missing'} mm bed; reported nozzle{' '}
                      {context.nozzleDiameterMm ?? 'missing'} mm
                    </dd>
                  </div>
                  <div>
                    <dt>Safety limits</dt>
                    <dd>
                      {context.safety
                        ? `${context.safety.maximumNozzleTemperatureC} C nozzle; ${context.safety.maximumBedTemperatureC} C bed; ${context.safety.maximumVolumetricRateMm3S} mm3/s`
                        : 'not published by this server'}
                    </dd>
                  </div>
                  <div>
                    <dt>Safety confirmations</dt>
                    <dd>
                      {context.safety
                        ? `Emergency stop ${context.safety.emergencyStopAvailable ? 'available' : 'not confirmed'}; thermal protection ${context.safety.thermalProtectionConfirmed ? 'confirmed' : 'not confirmed'}; ventilation ${context.safety.ventilationAssessed ? 'assessed' : 'not assessed'}`
                        : 'not published by this server'}
                    </dd>
                  </div>
                  <div>
                    <dt>Permissions</dt>
                    <dd>
                      {context.permissions
                        ? `Read ${context.permissions.readPrinter ? 'yes' : 'no'}; write ${context.permissions.writeCalibration ? 'yes' : 'no'}; generate ${context.permissions.generateCalibration ? 'yes' : 'no'}; start ${context.permissions.startPrint ? 'yes' : 'no'}`
                        : 'not published by this server'}
                    </dd>
                  </div>
                </dl>
              </>
            ) : null}
            {errors.context ? (
              <p id="new-context-error" className="cal-field-error">
                {errors.context}
              </p>
            ) : null}
          </fieldset>

          <fieldset
            disabled={!printerReady || !canLoad || submitting || store.disabled}
          >
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
                {context?.toolheads.map((tool) => (
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

          <fieldset
            disabled={!printerReady || !canLoad || submitting || store.disabled}
          >
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

          <fieldset
            disabled={!printerReady || !canLoad || submitting || store.disabled}
          >
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

          <fieldset
            disabled={!printerReady || !canLoad || submitting || store.disabled}
          >
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

          <fieldset
            disabled={!printerReady || !canLoad || submitting || store.disabled}
          >
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
