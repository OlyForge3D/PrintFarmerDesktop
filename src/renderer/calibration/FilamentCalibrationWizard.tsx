/**
 * Filament calibration wizard — the operator-facing surface of the OrcaSlicer
 * wiki calibration workflow.
 *
 * The five wire-level verbs this consumes were built by Bishop on
 * `dev-bishop-filament-calibration-channels` (see
 * `.squad/decisions/inbox/bishop-filament-calibration-channels.md`). This
 * component's job is exactly the loop the reframe describes: clone → submit
 * → poll → send-to-printer → measure → write-back → next method. The clone
 * is the identity that carries state across steps.
 *
 * ## Design constraints observed
 *
 * - **Step sequencing carries the updated profile forward.** The clone id
 *   is set once and never re-derived. Every write-back names the SAME
 *   `customProfileId`, so a `flow_rate_pass_1` correction is visible in the
 *   `filament_flow_ratio` field the wire mapper reads for the next slice.
 *   The acceptance suite proves this behaviour end-to-end; the
 *   corresponding renderer test proves the wizard never re-clones between
 *   steps.
 * - **Restart resilience (issue #754).** Once the clone exists, every
 *   change to phase/method/in-flight job is persisted through
 *   `saveFilamentCalibrationWizardState` (a filament-shaped IPC channel
 *   pair, deliberately additive rather than reusing the printer-
 *   calibration-shaped `saveCalibrationWorkspaceState`). On mount the
 *   wizard calls `getFilamentCalibrationWizardState` and, if a record
 *   exists, resumes directly into the saved phase/method/job rather than
 *   starting over. Transient in-flight-network phases
 *   (`submittingSlice`/`sendingToPrinter`/`writingBack`) are folded onto
 *   their nearest stable predecessor before every save (see
 *   `mapPhaseForPersistence` in `filamentWizardState.ts`), so a restore
 *   never has to answer "did that request land before the crash" — the
 *   operator just retries the interrupted step. `restartWizard` clears the
 *   record explicitly. The renderer stays presentation-only throughout:
 *   persistence is delegated to main over the same Zod-validated IPC
 *   boundary as every other wizard action.
 * - **`startPrint` is an explicit operator choice.** The confirmation
 *   dialog names the physical consequence ("This will start a real print
 *   on a machine that heats to 300 °C and moves") and the operator has
 *   to type `START` to enable the "Start print" button. Sending gcode
 *   with `startPrint: false` (upload only) is offered as a distinct
 *   button on the same dialog.
 * - **Errors are actionable.** `unsupported_calibration_method` renders
 *   the supported list from the client's known-good set (the server can
 *   drift from the client but not the other way — the client cannot ask
 *   for something it hasn't put in the picker); `sliceJobFailed` shows
 *   the `errorMessage` verbatim; every other code maps to catalogued
 *   copy in `errorCopy()` below. Raw codes and Zod field paths never
 *   render.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import type {
  CalibrationApiError,
  CalibrationPrinterCandidate,
  CalibrationSliceJobSnapshot,
  CalibrationSliceMethod,
} from '@shared/ipc';
import { CalibrationFilamentMeasurement } from '@shared/ipc';
import { browserCalibrationEnvironment, calibrationApi } from './api';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import {
  ProfileSelectionSection,
  type ProfileSelectionSnapshot,
} from './ProfileSelectionSection';
import {
  FILAMENT_METHOD_META,
  FILAMENT_WIZARD_METHODS,
  buildPersistedState,
  restoredWorkingState,
  scalarSpecFor,
  type FilamentWizardInFlightJob,
  type FilamentWizardPersistedState,
  type FilamentWizardPhase,
} from './filamentWizardState';

/**
 * Operator-facing display names, derived from the single method catalogue so a
 * method added to `FILAMENT_METHOD_META` cannot be missing here. This was a
 * hand-maintained `Record<CalibrationSliceMethod, string>` duplicating
 * `FILAMENT_METHOD_META[].title`; deriving it removes the second place a new
 * method has to be registered.
 */
const SUPPORTED_METHOD_NAMES: readonly string[] = Object.values(
  FILAMENT_METHOD_META,
).map((meta) => meta.title);

interface PrinterListState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly printers: readonly CalibrationPrinterCandidate[];
}

const emptyPrinterList: PrinterListState = {
  loading: false,
  error: null,
  printers: [],
};

/**
 * One option label for the printer dropdown. A `<select>` option can only carry
 * text, so the model that the radio list rendered as a separate node is folded
 * into the single string here.
 *
 * The "(offline)" marker the flat list used to append is deliberately NOT
 * repeated: reachability is carried by the enclosing `<optgroup>` instead, so
 * an offline printer is not labelled offline twice.
 */
function printerOptionLabel(printer: CalibrationPrinterCandidate): string {
  const model =
    printer.printerModel !== null ? ` — ${printer.printerModel}` : '';
  return `${printer.displayName}${model}`;
}

/**
 * Split the printer list by reachability, preserving server order within each
 * group. Online printers are offered first because they are the only ones that
 * can complete a calibration in one sitting — the flow ends in a real print.
 *
 * Offline printers are kept rather than pruned. The filament wizard does not
 * gate on `isOnline` (unlike the retired saga's `candidateEligibilityBlockers`),
 * so an offline printer can still be taken through clone and slice, and a
 * printer that is merely rebooting must not vanish from the farm mid-session.
 */
function partitionPrintersByReachability(
  printers: readonly CalibrationPrinterCandidate[],
): {
  readonly online: readonly CalibrationPrinterCandidate[];
  readonly offline: readonly CalibrationPrinterCandidate[];
} {
  return {
    online: printers.filter((printer) => printer.isOnline),
    offline: printers.filter((printer) => !printer.isOnline),
  };
}

interface SliceJobUiState {
  readonly snapshot: CalibrationSliceJobSnapshot | null;
  readonly cappedOut: boolean;
  readonly terminal: 'completed' | 'failed' | null;
  readonly nextPollDelayMs: number | null;
}

const emptySliceJobUi: SliceJobUiState = {
  snapshot: null,
  cappedOut: false,
  terminal: null,
  nextPollDelayMs: null,
};

/**
 * Render an operator-friendly explanation for a wire error. Never renders
 * the raw code (`unsupportedCalibrationMethod`) at the operator or a field
 * path — those were the anti-patterns that made the original feature
 * unusable. The `unsupported` case names the client's known-good list; the
 * client cannot ask the server for a method it does not have in the
 * picker, so this is honest as an operator recovery.
 */
function errorCopy(error: CalibrationApiError): {
  readonly title: string;
  readonly detail: string;
  readonly recovery: string | null;
} {
  switch (error.code) {
    case 'unsupportedCalibrationMethod':
      return {
        title: 'This calibration method is not supported by the server.',
        detail: `${error.message} Supported by this desktop build: ${SUPPORTED_METHOD_NAMES.join(', ')}.`,
        recovery: 'Pick one of the supported methods and try again.',
      };
    case 'interactiveSessionRequired':
      return {
        title: 'Sign in to PrintFarmer to continue.',
        detail:
          'Cloning a profile and writing calibration results back onto it require a live signed-in session; a background token is not enough.',
        recovery: 'Reconnect this PrintFarmer profile and then retry.',
      };
    case 'sliceJobFailed':
      return {
        title: 'The slice job failed.',
        detail: error.message,
        recovery:
          error.retryable === true
            ? 'Retry to submit a fresh slice job.'
            : 'Adjust the settings that produced the failure, then submit again.',
      };
    case 'sliceJobTimeout':
      return {
        title: 'The slice job did not complete in time.',
        detail:
          'The desktop stopped polling for the outcome. The server may still be working on it — try again in a minute, or submit a fresh job.',
        recovery: 'Retry with a fresh job.',
      };
    case 'forbidden':
      return {
        title: 'This calibration step is not permitted.',
        detail: error.message,
        recovery:
          'Ask a PrintFarmer administrator to grant the required calibration permissions.',
      };
    case 'invalidData':
      return {
        title: 'The request was rejected as invalid.',
        detail: error.message,
        recovery:
          'Restart the wizard — the clone or its base profile appears to have drifted from what the server has on record.',
      };
    case 'workerUnavailable':
      return {
        title: 'The slicing worker is unavailable.',
        detail: 'PrintFarmer reported no slice worker was reachable.',
        recovery: 'Wait a minute and retry.',
      };
    case 'serverError':
      return {
        title: 'PrintFarmer returned an error.',
        detail: error.message,
        recovery: error.retryable ? 'Retry.' : null,
      };
    default:
      return {
        title: 'PrintFarmer could not complete this step.',
        detail: error.message,
        recovery: error.retryable ? 'Retry.' : null,
      };
  }
}

interface WizardBanner {
  readonly kind: 'error' | 'info';
  readonly title: string;
  readonly detail: string;
  readonly recovery: string | null;
  readonly reference: string | null;
}

function bannerFromApiError(error: CalibrationApiError): WizardBanner {
  const copy = errorCopy(error);
  return {
    kind: 'error',
    title: copy.title,
    detail: copy.detail,
    recovery: copy.recovery,
    reference: error.reference,
  };
}

// --------------------------------------------------------------------------
// Top-level component
// --------------------------------------------------------------------------

const GENERATION_DISABLED_FALLBACK_MESSAGE =
  'This PrintFarmer server cannot slice right now, so filament calibration cannot start.';

export function FilamentCalibrationWizard(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const environment = store.environment ?? browserCalibrationEnvironment;
  const profileId = store.profileId;

  if (profileId === null) {
    return (
      <section
        className="cal-view cal-view--form"
        aria-labelledby="filament-cal-title"
        data-testid="filament-calibration-wizard"
      >
        <header className="cal-view-heading">
          <h1 id="filament-cal-title" data-cal-heading tabIndex={-1}>
            Filament calibration wizard
          </h1>
          <p className="cal-subtitle">
            Calibrate a filament spool using the OrcaSlicer wiki workflow.
          </p>
        </header>
        <p className="cal-alert" role="alert">
          Select a PrintFarmer profile before starting a filament calibration.
        </p>
        <button
          type="button"
          className="cal-button"
          onClick={() => void store.navigate('dashboard')}
        >
          Back to calibration dashboard
        </button>
      </section>
    );
  }

  // Step 0 (issue #798): refuse to start before any profile-selection UI is
  // shown, rendering the server's own reason text, when the deployment
  // cannot slice. Checked here — before `FilamentCalibrationWizardInner`
  // mounts and before a single pick, clone, or local wizard-state write can
  // happen — rather than deferring the refusal to slice submission.
  //
  // Gated strictly on an explicit `false`: `capabilityFlags` is `null` (or
  // `calibrationGenerationEnabled` simply unconfirmed) before availability
  // negotiation completes, and that "not yet known" state is not the same
  // claim as "the server said no" — only the latter blocks entry here.
  if (
    store.availability?.capabilityFlags?.calibrationGenerationEnabled === false
  ) {
    const slicingReasons = (
      store.availability.serverUnavailableReasons ?? []
    ).filter((reason) => reason.feature === 'slicing');
    const message =
      slicingReasons.length > 0
        ? slicingReasons.map((reason) => reason.message).join(' ')
        : GENERATION_DISABLED_FALLBACK_MESSAGE;
    return (
      <section
        className="cal-view cal-view--form"
        aria-labelledby="filament-cal-title"
        data-testid="filament-calibration-wizard"
      >
        <header className="cal-view-heading">
          <h1 id="filament-cal-title" data-cal-heading tabIndex={-1}>
            Filament calibration wizard
          </h1>
          <p className="cal-subtitle">
            Calibrate a filament spool using the OrcaSlicer wiki workflow.
          </p>
        </header>
        <p className="cal-alert" role="alert">
          {message}
        </p>
        <button
          type="button"
          className="cal-button"
          onClick={() => void store.navigate('dashboard')}
        >
          Back to calibration dashboard
        </button>
      </section>
    );
  }

  return (
    <FilamentCalibrationWizardInner
      profileId={profileId}
      environment={environment}
      onExit={() => void store.navigate('dashboard')}
    />
  );
}

interface WizardInnerProps {
  readonly profileId: string;
  readonly environment: {
    readonly createId: () => string;
    readonly now: () => string;
  };
  readonly onExit: () => void;
}

interface WizardWorkingState {
  readonly phase: FilamentWizardPhase;
  readonly picks: ProfileSelectionSnapshot | null;
  readonly printerId: string | null;
  readonly printerModelId: string | null;
  readonly cloneId: string | null;
  readonly cloneName: string;
  readonly completedMethods: readonly CalibrationSliceMethod[];
  readonly currentMethod: CalibrationSliceMethod | null;
  readonly inFlightJob: FilamentWizardInFlightJob | null;
}

const initialWorking: WizardWorkingState = {
  phase: 'select',
  picks: null,
  printerId: null,
  printerModelId: null,
  cloneId: null,
  cloneName: '',
  completedMethods: [],
  currentMethod: null,
  inFlightJob: null,
};

function FilamentCalibrationWizardInner(
  props: WizardInnerProps,
): React.JSX.Element {
  const { profileId, environment, onExit } = props;
  const [working, setWorking] = useState<WizardWorkingState>(initialWorking);
  const [banner, setBanner] = useState<WizardBanner | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [sliceJobUi, setSliceJobUi] =
    useState<SliceJobUiState>(emptySliceJobUi);

  // ---------------------------------------------------------------- printers
  const [printerList, setPrinterList] =
    useState<PrinterListState>(emptyPrinterList);
  const printerListEpochRef = useRef(0);
  const unmountedRef = useRef(false);
  useEffect(
    () => () => {
      unmountedRef.current = true;
    },
    [],
  );

  // ------------------------------------------------------- restart resilience
  //
  // Issue #754: restore any in-flight method/step/jobId from the last save,
  // then keep saving on every change so a later restart has a fresh
  // bookmark. `lastPersistedJsonRef` dedupes writes — `working` changes on
  // every keystroke of unrelated fields (for example `cloneName` while
  // typing), but the persisted record only needs to change when the
  // persistable projection of it actually differs. Comparisons ignore
  // `updatedAt` (a timestamp-only difference is not a state change worth
  // writing to disk), so both the restore and the save effect key off the
  // same `stripUpdatedAt` projection.
  const stripUpdatedAt = (
    record: FilamentWizardPersistedState,
  ): Omit<FilamentWizardPersistedState, 'updatedAt'> => {
    const rest: Partial<FilamentWizardPersistedState> = { ...record };
    delete rest.updatedAt;
    return rest as Omit<FilamentWizardPersistedState, 'updatedAt'>;
  };
  const lastPersistedJsonRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const record = await calibrationApi().getFilamentCalibrationWizardState(
          {
            profileId,
          },
        );
        if (cancelled || unmountedRef.current || record === null) return;
        const restored = restoredWorkingState(record);
        lastPersistedJsonRef.current = JSON.stringify(stripUpdatedAt(record));
        setWorking((current) => ({ ...current, ...restored }));
        setBanner({
          kind: 'info',
          title: 'Resumed filament calibration.',
          detail: `Continuing calibration of "${restored.cloneName}" where it left off.`,
          recovery: null,
          reference: null,
        });
      } catch {
        // Best-effort: a failed restore just leaves the wizard starting
        // fresh, same as if nothing had ever been persisted.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(() => {
    const snapshot = buildPersistedState(
      {
        phase: working.phase,
        printerId: working.printerId,
        printerModelId: working.printerModelId,
        machineName: working.picks?.machineName ?? null,
        processName: working.picks?.processName ?? null,
        baseFilamentName: working.picks?.filamentName ?? null,
        baseFilamentGuid: working.picks?.filamentGuid ?? null,
        cloneId: working.cloneId,
        cloneName: working.cloneName,
        completedMethods: working.completedMethods,
        currentMethod: working.currentMethod,
        inFlightJob: working.inFlightJob,
      },
      environment.now(),
    );
    if (snapshot === null) return;
    const comparableJson = JSON.stringify(stripUpdatedAt(snapshot));
    if (lastPersistedJsonRef.current === comparableJson) return;
    lastPersistedJsonRef.current = comparableJson;
    void calibrationApi()
      .saveFilamentCalibrationWizardState({ profileId, state: snapshot })
      .catch(() => {
        // Best-effort: a failed save only degrades resume behaviour on a
        // future restart, it must never interrupt the active wizard.
      });
  }, [
    environment,
    profileId,
    working.cloneId,
    working.cloneName,
    working.completedMethods,
    working.currentMethod,
    working.inFlightJob,
    working.phase,
    working.picks,
    working.printerId,
    working.printerModelId,
  ]);

  const loadPrinters = useCallback(async (): Promise<void> => {
    const epoch = ++printerListEpochRef.current;
    setPrinterList((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await calibrationApi().listCalibrationPrinters({
        profileId,
      });
      if (printerListEpochRef.current !== epoch || unmountedRef.current) return;
      setPrinterList({
        loading: false,
        error: null,
        printers: response.printers,
      });
    } catch (cause) {
      if (printerListEpochRef.current !== epoch || unmountedRef.current) return;
      const message =
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : 'PrintFarmer printers could not be loaded.';
      setPrinterList({ loading: false, error: message, printers: [] });
    }
  }, [profileId]);

  useEffect(() => {
    if (working.phase === 'select') {
      void loadPrinters();
    }
  }, [loadPrinters, working.phase]);

  // ---------------------------------------------------------------- events

  const handleSelectionChange = useCallback(
    (snapshot: ProfileSelectionSnapshot): void => {
      setWorking((current) => ({ ...current, picks: snapshot }));
    },
    [],
  );

  const handlePickPrinter = useCallback(
    (candidate: CalibrationPrinterCandidate): void => {
      setWorking((current) => ({
        ...current,
        printerId: candidate.printerId,
        printerModelId: candidate.printerModelId ?? null,
      }));
    },
    [],
  );

  const proceedToCloneName = useCallback(() => {
    setWorking((current) => {
      const nameSeed =
        current.picks?.filamentName !== null &&
        current.picks?.filamentName !== undefined
          ? `${current.picks.filamentName} (calibration)`
          : '';
      return {
        ...current,
        phase: 'cloneName',
        cloneName: current.cloneName === '' ? nameSeed : current.cloneName,
      };
    });
  }, []);

  const performClone = useCallback(async (): Promise<void> => {
    const { picks, printerId, printerModelId, cloneName } = working;
    if (
      picks === null ||
      picks.filamentName === null ||
      cloneName.trim().length === 0 ||
      printerId === null
    ) {
      return;
    }
    setBusy(true);
    setBanner(null);
    setWorking((current) => ({ ...current, phase: 'cloning' }));
    try {
      // The base filament may never have been imported into PrintFarmer
      // (`picks.filamentGuid === null`) — no longer a dead end (issue #766,
      // PrintFarmer PR #2008). Resolve its real Guid on demand, right here
      // at the point it is actually needed, instead of requiring an admin
      // to have pre-imported it before the operator could even pick it.
      let sourceProfileId = picks.filamentGuid;
      if (sourceProfileId === null) {
        if (printerModelId === null) {
          setBanner({
            kind: 'error',
            title: 'This filament profile could not be resolved.',
            detail:
              'The printer has no catalog model association, so its ' +
              'system profiles cannot be resolved by name.',
            recovery:
              'Pick a custom filament profile, or associate this printer ' +
              'with a catalog model.',
            reference: null,
          });
          setWorking((current) => ({ ...current, phase: 'cloneName' }));
          return;
        }
        const resolution = await calibrationApi().resolveSystemProfile({
          profileId,
          printerModelId,
          profileType: 'filament',
          profileName: picks.filamentName,
        });
        if (unmountedRef.current) return;
        if (resolution.status === 'error') {
          setBanner(bannerFromApiError(resolution.error));
          setWorking((current) => ({ ...current, phase: 'cloneName' }));
          return;
        }
        sourceProfileId = resolution.profileId;
      }
      // Issue #798: create the server-side `CalibrationProject` (Coach
      // mode) BEFORE the profile clone and before any local wizard state is
      // written (persistence only begins once `cloneId !== null` — see
      // `buildPersistedState` in `filamentWizardState.ts`). Best-effort
      // filament-identity mapping: no spool-selection UI exists in this
      // wizard yet, so Spoolman/local-spool ids are left `null` server-side
      // (out of scope here, see #798 scope note 3); no material metadata is
      // available client-side for a profile pick, so a documented
      // placeholder is sent — the field just needs to be non-empty.
      const projectResponse = await calibrationApi().createCalibrationProject({
        profileId,
        name: `${cloneName.trim()} (calibration project)`,
        printerId,
        filamentProvider: 'printfarmer',
        filamentProductId: sourceProfileId,
        filamentProductName: picks.filamentName,
        filamentMaterial: 'unknown',
      });
      if (unmountedRef.current) return;
      if (projectResponse.status === 'error') {
        setBanner(bannerFromApiError(projectResponse.error));
        setWorking((current) => ({ ...current, phase: 'cloneName' }));
        return;
      }
      const response = await calibrationApi().cloneCalibrationFilamentProfile({
        profileId,
        sourceProfileId,
        name: cloneName.trim(),
        printerModelId: printerModelId ?? null,
      });
      if (unmountedRef.current) return;
      if (response.status === 'error') {
        setBanner(bannerFromApiError(response.error));
        setWorking((current) => ({ ...current, phase: 'cloneName' }));
        return;
      }
      setWorking((current) => ({
        ...current,
        // Fold the just-resolved Guid back onto `picks` so the persistence
        // effect (which reads `picks.filamentGuid`) can save a resumable
        // record — otherwise a never-imported filament's clone would work
        // in-session but never survive a restart (issue #766).
        picks:
          current.picks === null
            ? current.picks
            : { ...current.picks, filamentGuid: sourceProfileId },
        cloneId: response.clone.id,
        cloneName: response.clone.name,
        phase: 'methodPicker',
      }));
    } catch (cause) {
      if (unmountedRef.current) return;
      setBanner({
        kind: 'error',
        title: 'The clone could not be created.',
        detail:
          cause instanceof Error
            ? cause.message
            : 'The desktop lost contact with the main process.',
        recovery: 'Retry.',
        reference: null,
      });
      setWorking((current) => ({ ...current, phase: 'cloneName' }));
    } finally {
      if (!unmountedRef.current) setBusy(false);
    }
  }, [profileId, working]);

  const beginMethod = useCallback(
    async (method: CalibrationSliceMethod): Promise<void> => {
      const { picks, printerId, cloneId, cloneName } = working;
      if (
        picks === null ||
        picks.machineName === null ||
        picks.processName === null ||
        printerId === null ||
        cloneId === null
      ) {
        return;
      }
      setBusy(true);
      setBanner(null);
      setSliceJobUi(emptySliceJobUi);
      setWorking((current) => ({
        ...current,
        phase: 'submittingSlice',
        currentMethod: method,
      }));
      try {
        const response = await calibrationApi().submitCalibrationSlice({
          profileId,
          printerId,
          machineProfileName: picks.machineName,
          processProfileName: picks.processName,
          filamentProfileName: cloneName,
          method,
        });
        if (unmountedRef.current) return;
        if (response.status === 'error') {
          setBanner(bannerFromApiError(response.error));
          setWorking((current) => ({ ...current, phase: 'methodPicker' }));
          return;
        }
        setWorking((current) => ({
          ...current,
          phase: 'pollingSlice',
          inFlightJob: {
            jobId: response.job.jobId,
            method,
            submittedAt: response.job.queuedAt,
            pollAttempt: 0,
            lastStatus: response.job.status,
          },
        }));
      } catch (cause) {
        if (unmountedRef.current) return;
        setBanner({
          kind: 'error',
          title: 'The slice job could not be submitted.',
          detail:
            cause instanceof Error
              ? cause.message
              : 'The desktop lost contact with the main process.',
          recovery: 'Retry.',
          reference: null,
        });
        setWorking((current) => ({ ...current, phase: 'methodPicker' }));
      } finally {
        if (!unmountedRef.current) setBusy(false);
      }
    },
    [profileId, working],
  );

  // ---- Polling loop
  //
  // The counter lives in a ref, not in wizard state. Under `useDefineForClassFields`
  // ES2022 semantics don't matter here; what matters is React effect identity:
  // if the poll counter were in `working.inFlightJob`, incrementing it after
  // each poll would change the object identity every tick. Any dep array that
  // referenced `working.inFlightJob` by object identity would then tear the
  // effect down on every counter update, cancel the `setTimeout` that was
  // just scheduled to honour `response.nextPollDelayMs`, re-mount the effect,
  // and fire `void runPoll()` again immediately. The advertised delay would
  // become dead code and the loop would free-run at IPC round-trip speed —
  // which is exactly the defect PR #753 shipped (Bishop measured 4 polls in
  // 500 ms against a mock advertising 2000 ms).
  //
  // The fix has three parts, none of which is optional:
  //   1. The counter is a `useRef` — mutating it does not re-render or
  //      re-run the effect.
  //   2. The effect depends on `working.inFlightJob?.jobId`, a stable primitive
  //      that changes only when a genuinely new job starts (or the job is
  //      cleared). It does NOT depend on the `inFlightJob` object.
  //   3. The counter is initialised from `job.pollAttempt` inside the effect
  //      body on entry, so a resumed job keeps its backoff position while a
  //      fresh slice still starts from 0.
  //
  // The existing `jobId` guard in the `setWorking` reducer still applies —
  // a stale in-flight response cannot mutate a newer job's state — but with
  // this shape the guard is a safety net rather than the load-bearing
  // discriminator (the effect re-mounts on jobId change, so `pollJobIdRef`
  // and the captured `job.jobId` agree by construction).
  const pollAttemptRef = useRef<number>(0);
  useEffect(() => {
    if (working.phase !== 'pollingSlice' || working.inFlightJob === null) {
      return;
    }
    const job = working.inFlightJob;
    pollAttemptRef.current = job.pollAttempt;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runPoll = async (): Promise<void> => {
      const attempt = pollAttemptRef.current;
      try {
        const response = await calibrationApi().getCalibrationSliceJobStatus({
          profileId,
          jobId: job.jobId,
          pollAttempt: attempt,
        });
        if (cancelled || unmountedRef.current) return;
        pollAttemptRef.current = attempt + 1;
        if (response.status === 'error') {
          setBanner(bannerFromApiError(response.error));
          if (
            response.error.code === 'sliceJobFailed' ||
            response.error.code === 'sliceJobTimeout'
          ) {
            setWorking((current) => ({
              ...current,
              phase: 'methodPicker',
              inFlightJob: null,
            }));
          }
          return;
        }
        setSliceJobUi({
          snapshot: response.snapshot,
          cappedOut: response.cappedOut,
          terminal: response.terminal,
          nextPollDelayMs: response.nextPollDelayMs,
        });
        setWorking((current) => {
          if (current.inFlightJob?.jobId !== job.jobId) return current;
          const nextJob: FilamentWizardInFlightJob = {
            ...current.inFlightJob,
            pollAttempt: attempt + 1,
            lastStatus: response.snapshot.status,
          };
          if (response.terminal === 'completed') {
            return {
              ...current,
              inFlightJob: nextJob,
              phase: 'sliceReady',
            };
          }
          if (response.terminal === 'failed') {
            setBanner({
              kind: 'error',
              title: 'The slice job failed on the server.',
              detail:
                response.snapshot.errorMessage ??
                'The server reported a slice failure without a message.',
              recovery: 'Submit a fresh slice job.',
              reference: null,
            });
            return {
              ...current,
              inFlightJob: null,
              phase: 'methodPicker',
            };
          }
          return { ...current, inFlightJob: nextJob };
        });
        if (response.terminal === 'completed') {
          return;
        }
        if (response.terminal === 'failed') {
          return;
        }
        if (
          response.nextPollDelayMs !== null &&
          !cancelled &&
          !unmountedRef.current
        ) {
          timer = setTimeout(() => {
            void runPoll();
          }, response.nextPollDelayMs);
        }
      } catch (cause) {
        if (cancelled || unmountedRef.current) return;
        setBanner({
          kind: 'error',
          title: 'The desktop could not read the slice job status.',
          detail:
            cause instanceof Error
              ? cause.message
              : 'The desktop lost contact with the main process.',
          recovery: 'Retry — the wizard will keep the job id.',
          reference: null,
        });
      }
    };

    void runPoll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // See docblock above: depending on `working.inFlightJob?.jobId` (a stable
    // primitive) rather than the whole `inFlightJob` object is what makes the
    // `setTimeout(response.nextPollDelayMs)` schedule survive incrementing
    // the poll counter. exhaustive-deps flags the missing `working.inFlightJob`
    // object; including it would reintroduce the effect-restart-per-poll defect
    // this PR fixes. The captured `job` variable inside the effect reads only
    // `job.jobId`, which the dep array already tracks; every other field on
    // `inFlightJob` is stable for the life of a single slice job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, working.inFlightJob?.jobId, working.phase]);

  const [confirmStart, setConfirmStart] = useState<string>('');

  // Physical-action idempotency: sending calibration gcode to a printer with
  // `startPrint: true` moves a machine that heats to 300 °C and drives a
  // toolhead. The button-disabled + phase transition + wire idempotency key
  // are all necessary but each defers to the layer below it. React state
  // does not commit synchronously, so a synchronous double-click within a
  // single event tick will pass the `busy` disabled-check twice before the
  // first setState commits. Defence-in-depth: a synchronous ref guarantees
  // the second click short-circuits before any await. Idempotency-key
  // dedup on the wire remains the last line of defence.
  const sendToPrinterInFlightRef = useRef<boolean>(false);

  const sendToPrinter = useCallback(
    async (startPrint: boolean): Promise<void> => {
      if (sendToPrinterInFlightRef.current) return;
      const { printerId, inFlightJob } = working;
      if (printerId === null || inFlightJob === null) return;
      sendToPrinterInFlightRef.current = true;
      setBusy(true);
      setBanner(null);
      setWorking((current) => ({ ...current, phase: 'sendingToPrinter' }));
      try {
        const operatorAcknowledgement = startPrint
          ? `filament-cal:${environment.createId()}:${environment.now()}`
          : null;
        const response = await calibrationApi().sendCalibrationSliceToPrinter({
          profileId,
          jobId: inFlightJob.jobId,
          printerId,
          startPrint,
          operatorAcknowledgement,
        });
        if (unmountedRef.current) return;
        if (response.status === 'error') {
          setBanner(bannerFromApiError(response.error));
          setWorking((current) => ({ ...current, phase: 'sliceReady' }));
          return;
        }
        setBanner({
          kind: 'info',
          title: startPrint
            ? 'Calibration print started.'
            : 'Gcode uploaded to the printer.',
          detail: response.result.message ?? '',
          recovery: startPrint
            ? 'When the print completes, measure the printed piece and enter the result below.'
            : 'Start the print from the printer once you are ready; the wizard will still accept the measurement.',
          reference: null,
        });
        setWorking((current) => ({
          ...current,
          phase: 'awaitingMeasurement',
        }));
      } catch (cause) {
        if (unmountedRef.current) return;
        setBanner({
          kind: 'error',
          title: 'The desktop could not hand the gcode to the printer.',
          detail:
            cause instanceof Error
              ? cause.message
              : 'The desktop lost contact with the main process.',
          recovery: 'Retry.',
          reference: null,
        });
        setWorking((current) => ({ ...current, phase: 'sliceReady' }));
      } finally {
        sendToPrinterInFlightRef.current = false;
        if (!unmountedRef.current) setBusy(false);
        setConfirmStart('');
      }
    },
    [environment, profileId, working],
  );

  const writeMeasurement = useCallback(
    async (measurement: CalibrationFilamentMeasurement): Promise<void> => {
      const { cloneId, currentMethod } = working;
      if (cloneId === null || currentMethod === null) return;
      setBusy(true);
      setBanner(null);
      setWorking((current) => ({ ...current, phase: 'writingBack' }));
      try {
        const response =
          await calibrationApi().updateCalibrationFilamentProfileMeasurement({
            profileId,
            customProfileId: cloneId,
            measurement,
          });
        if (unmountedRef.current) return;
        if (response.status === 'error') {
          setBanner(bannerFromApiError(response.error));
          setWorking((current) => ({
            ...current,
            phase: 'awaitingMeasurement',
          }));
          return;
        }
        setBanner({
          kind: 'info',
          title: `${FILAMENT_METHOD_META[currentMethod].title} — measurement saved.`,
          detail: 'The corrected value is now on the cloned filament profile.',
          recovery:
            'Pick another calibration method to continue, or exit the wizard.',
          reference: null,
        });
        setWorking((current) => {
          const alreadyDone = current.completedMethods.includes(currentMethod);
          return {
            ...current,
            completedMethods: alreadyDone
              ? current.completedMethods
              : [...current.completedMethods, currentMethod],
            currentMethod: null,
            inFlightJob: null,
            phase: 'methodPicker',
          };
        });
      } catch (cause) {
        if (unmountedRef.current) return;
        setBanner({
          kind: 'error',
          title: 'The measurement could not be written.',
          detail:
            cause instanceof Error
              ? cause.message
              : 'The desktop lost contact with the main process.',
          recovery: 'Retry.',
          reference: null,
        });
        setWorking((current) => ({
          ...current,
          phase: 'awaitingMeasurement',
        }));
      } finally {
        if (!unmountedRef.current) setBusy(false);
      }
    },
    [profileId, working],
  );

  const restartWizard = useCallback(() => {
    setWorking(initialWorking);
    setBanner(null);
    setSliceJobUi(emptySliceJobUi);
    setConfirmStart('');
    lastPersistedJsonRef.current = null;
    void calibrationApi()
      .clearFilamentCalibrationWizardState({ profileId })
      .catch(() => {
        // Best-effort: if this fails, the stale bookmark only affects a
        // future restart. The live wizard has already returned to a clean
        // in-memory state.
      });
  }, [profileId]);

  // ---------------------------------------------------------------- render

  return (
    <section
      className="cal-view cal-view--form"
      aria-labelledby="filament-cal-title"
      data-testid="filament-calibration-wizard"
    >
      <header className="cal-view-heading">
        <div>
          <h1 id="filament-cal-title" data-cal-heading tabIndex={-1}>
            Filament calibration wizard
          </h1>
          <p className="cal-subtitle">
            Calibrate a filament spool using the OrcaSlicer wiki workflow —
            clone the base profile under a spool name, then loop through the
            calibration steps, writing each measurement back onto the clone.
          </p>
        </div>
        <div className="cal-actions">
          <button type="button" className="cal-button" onClick={onExit}>
            Back to dashboard
          </button>
          <button
            type="button"
            className="cal-button"
            onClick={restartWizard}
            disabled={busy}
          >
            Start over
          </button>
        </div>
      </header>

      {banner !== null ? (
        <div
          className={
            banner.kind === 'error'
              ? 'cal-alert'
              : 'cal-alert cal-alert--warning'
          }
          role={banner.kind === 'error' ? 'alert' : 'status'}
        >
          <p>
            <strong>{banner.title}</strong>
          </p>
          {banner.detail.length > 0 ? <p>{banner.detail}</p> : null}
          {banner.recovery !== null ? <p>{banner.recovery}</p> : null}
          {banner.reference !== null ? (
            <p className="cal-hint">Reference: {banner.reference}</p>
          ) : null}
        </div>
      ) : null}

      <SelectStep
        profileId={profileId}
        printerList={printerList}
        onLoadPrinters={() => void loadPrinters()}
        working={working}
        onPickPrinter={handlePickPrinter}
        onSelectionChange={handleSelectionChange}
        onProceed={proceedToCloneName}
        visible={working.phase === 'select'}
      />

      {working.phase === 'cloneName' || working.phase === 'cloning' ? (
        <CloneStep
          working={working}
          onCloneNameChange={(name) =>
            setWorking((current) => ({ ...current, cloneName: name }))
          }
          onConfirmClone={() => void performClone()}
          onBack={() =>
            setWorking((current) => ({ ...current, phase: 'select' }))
          }
          busy={busy}
        />
      ) : null}

      {working.phase === 'methodPicker' ? (
        <MethodStep
          working={working}
          busy={busy}
          onPickMethod={(method) => void beginMethod(method)}
        />
      ) : null}

      {(working.phase === 'submittingSlice' ||
        working.phase === 'pollingSlice') &&
      working.inFlightJob !== null ? (
        <SliceProgress
          job={working.inFlightJob}
          ui={sliceJobUi}
          phase={working.phase}
        />
      ) : null}

      {working.phase === 'sliceReady' && working.inFlightJob !== null ? (
        <SendToPrinterStep
          job={working.inFlightJob}
          ui={sliceJobUi}
          confirmStart={confirmStart}
          onConfirmStartChange={setConfirmStart}
          onSend={(startPrint) => void sendToPrinter(startPrint)}
          busy={busy}
        />
      ) : null}

      {working.phase === 'awaitingMeasurement' &&
      working.currentMethod !== null ? (
        <MeasurementStep
          method={working.currentMethod}
          onSubmit={(measurement) => void writeMeasurement(measurement)}
          busy={busy}
        />
      ) : null}

      {working.phase === 'sendingToPrinter' ||
      working.phase === 'writingBack' ? (
        <p role="status" className="cal-hint">
          Working…
        </p>
      ) : null}
    </section>
  );
}

// --------------------------------------------------------------------------
// Sub-steps
// --------------------------------------------------------------------------

interface SelectStepProps {
  readonly profileId: string;
  readonly printerList: PrinterListState;
  readonly onLoadPrinters: () => void;
  readonly working: WizardWorkingState;
  readonly onPickPrinter: (candidate: CalibrationPrinterCandidate) => void;
  readonly onSelectionChange: (snapshot: ProfileSelectionSnapshot) => void;
  readonly onProceed: () => void;
  readonly visible: boolean;
}

function SelectStep(props: SelectStepProps): React.JSX.Element | null {
  const {
    profileId,
    printerList,
    onLoadPrinters,
    working,
    onPickPrinter,
    onSelectionChange,
    onProceed,
    visible,
  } = props;
  if (!visible) return null;
  const printerGroups = partitionPrintersByReachability(printerList.printers);
  const readyToProceed =
    working.printerId !== null &&
    working.picks !== null &&
    working.picks.readyForClone;

  return (
    <fieldset
      className="cal-step-fieldset"
      aria-label="Step 1 — machine, process, and base filament"
      disabled={false}
    >
      <legend>
        1. Pick the printer, machine profile, process profile, and base filament
        profile
      </legend>
      <p className="cal-hint">
        Pick a printer, then the three profiles that describe it and the base
        filament you want to calibrate. The wizard will clone the base filament
        under a name you choose next; every calibration measurement will land on
        the clone, not on the source profile.
      </p>

      {printerList.loading ? (
        <p role="status" className="cal-hint">
          Loading printers.
        </p>
      ) : null}
      {printerList.error !== null ? (
        <div className="cal-alert" role="alert">
          <p>{printerList.error}</p>
          <button type="button" className="cal-button" onClick={onLoadPrinters}>
            Retry loading printers
          </button>
        </div>
      ) : null}

      {printerList.printers.length > 0 ? (
        <label>
          Printer
          <select
            value={working.printerId ?? ''}
            onChange={(event) => {
              const picked = printerList.printers.find(
                (printer) => printer.printerId === event.target.value,
              );
              if (picked !== undefined) onPickPrinter(picked);
            }}
            aria-label="Printer"
          >
            <option value="">Select a printer</option>
            {printerGroups.online.length > 0 ? (
              <optgroup label="Online">
                {printerGroups.online.map((printer) => (
                  <option key={printer.printerId} value={printer.printerId}>
                    {printerOptionLabel(printer)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {printerGroups.offline.length > 0 ? (
              <optgroup label="Offline — cannot print until reachable">
                {printerGroups.offline.map((printer) => (
                  <option key={printer.printerId} value={printer.printerId}>
                    {printerOptionLabel(printer)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
      ) : printerList.loading || printerList.error !== null ? null : (
        <p className="cal-hint">
          No PrintFarmer printers are available. Add one on the server, then
          reload this workspace.
        </p>
      )}

      {working.printerId !== null ? (
        <ProfileSelectionSection
          profileId={profileId}
          printerId={working.printerId}
          printerModelId={working.printerModelId}
          disabled={false}
          onSelectionChange={onSelectionChange}
        />
      ) : null}

      <div className="cal-actions">
        <button
          type="button"
          className="cal-button cal-button--primary"
          disabled={!readyToProceed}
          onClick={onProceed}
        >
          Next — name the clone
        </button>
      </div>
    </fieldset>
  );
}

interface CloneStepProps {
  readonly working: WizardWorkingState;
  readonly onCloneNameChange: (name: string) => void;
  readonly onConfirmClone: () => void;
  readonly onBack: () => void;
  readonly busy: boolean;
}

function CloneStep(props: CloneStepProps): React.JSX.Element {
  const { working, onCloneNameChange, onConfirmClone, onBack, busy } = props;
  const nameValid = working.cloneName.trim().length > 0;

  return (
    <fieldset
      className="cal-step-fieldset"
      aria-label="Step 2 — name the clone"
      disabled={busy}
    >
      <legend>2. Name the clone</legend>
      <p className="cal-hint">
        Give the clone a name that identifies this spool (manufacturer, colour,
        batch — whatever will help you find it later). It will appear alongside
        your other custom filament profiles.
      </p>
      <label>
        Clone name
        <input
          type="text"
          value={working.cloneName}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onCloneNameChange(event.target.value)
          }
          aria-label="Clone name"
          maxLength={512}
        />
      </label>
      <div className="cal-actions">
        <button type="button" className="cal-button" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="cal-button cal-button--primary"
          disabled={!nameValid || busy}
          onClick={onConfirmClone}
        >
          {busy ? 'Cloning…' : 'Clone this filament profile'}
        </button>
      </div>
    </fieldset>
  );
}

interface MethodStepProps {
  readonly working: WizardWorkingState;
  readonly busy: boolean;
  readonly onPickMethod: (method: CalibrationSliceMethod) => void;
}

function MethodStep(props: MethodStepProps): React.JSX.Element {
  const { working, busy, onPickMethod } = props;
  const isActive = working.phase === 'methodPicker';

  return (
    <fieldset
      className="cal-step-fieldset"
      aria-label="Step 3 — calibration method"
      disabled={!isActive || busy}
    >
      <legend>3. Pick a calibration step</legend>
      <p className="cal-hint">
        Work through these in order. Each measurement is written back onto{' '}
        <strong>{working.cloneName}</strong>, so the next step reads the value
        the previous step just corrected.
      </p>
      <p className="cal-notice">
        These are the calibration steps PrintFarmer runs, in OrcaSlicer&apos;s
        recommended order. Cornering, input shaping and VFA are deliberately
        absent: they calibrate firmware motion settings rather than filament
        behaviour, so there is nothing for them to write back to a filament
        profile. Run those in OrcaSlicer directly.
      </p>
      <ul className="cal-method-list">
        {FILAMENT_WIZARD_METHODS.map((method) => {
          const meta = FILAMENT_METHOD_META[method];
          const done = working.completedMethods.includes(method);
          return (
            <li key={method}>
              <button
                type="button"
                className="cal-button"
                onClick={() => onPickMethod(method)}
                disabled={!isActive || busy}
                aria-label={`Start ${meta.title}${done ? ' (completed once)' : ''}`}
              >
                {meta.title}
                {done ? ' — completed' : ''}
              </button>
              <p className="cal-hint">{meta.summary}</p>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

interface SliceProgressProps {
  readonly job: FilamentWizardInFlightJob;
  readonly ui: SliceJobUiState;
  readonly phase: FilamentWizardPhase;
}

function SliceProgress(props: SliceProgressProps): React.JSX.Element {
  const { job, ui, phase } = props;
  const meta = FILAMENT_METHOD_META[job.method];
  const percent = ui.snapshot?.progressPercent ?? 0;
  const message = ui.snapshot?.progressMessage ?? null;

  return (
    <fieldset
      className="cal-step-fieldset"
      aria-label="Step 4 — slicing"
      disabled
    >
      <legend>
        4. Slicing {meta.title.toLowerCase()}
        {phase === 'submittingSlice' ? ' — submitting' : ' — in progress'}
      </legend>
      <p className="cal-hint">
        Job id <code>{job.jobId}</code>. The server is preparing gcode for the
        calibration model. This can take a minute or so on a busy worker.
      </p>
      <progress
        aria-label="Slice progress"
        value={percent}
        max={100}
        data-testid="slice-progress-bar"
      />
      <p role="status" data-testid="slice-progress-message">
        {ui.snapshot === null
          ? 'Waiting for the first status report.'
          : `${percent}% — ${ui.snapshot.status}${message !== null ? ` — ${message}` : ''}`}
      </p>
      {ui.cappedOut ? (
        <p className="cal-hint">
          Automatic polling paused after the wall-clock cap. Retry from the
          method picker to submit a fresh job.
        </p>
      ) : null}
    </fieldset>
  );
}

interface SendToPrinterStepProps {
  readonly job: FilamentWizardInFlightJob;
  readonly ui: SliceJobUiState;
  readonly confirmStart: string;
  readonly onConfirmStartChange: (value: string) => void;
  readonly onSend: (startPrint: boolean) => void;
  readonly busy: boolean;
}

function SendToPrinterStep(props: SendToPrinterStepProps): React.JSX.Element {
  const { job, ui, confirmStart, onConfirmStartChange, onSend, busy } = props;
  const meta = FILAMENT_METHOD_META[job.method];
  const canStart = confirmStart.trim().toUpperCase() === 'START';

  return (
    <fieldset
      className="cal-step-fieldset"
      aria-label="Step 5 — send to printer"
      disabled={busy}
    >
      <legend>5. Send {meta.title.toLowerCase()} to the printer</legend>
      <p className="cal-hint">
        The slice is ready. The estimated print time is{' '}
        {ui.snapshot?.estimatedPrintTimeSeconds !== null &&
        ui.snapshot?.estimatedPrintTimeSeconds !== undefined
          ? `${Math.round(ui.snapshot.estimatedPrintTimeSeconds / 60)} min`
          : 'not reported by the server'}
        {ui.snapshot?.filamentUsedGrams !== null &&
        ui.snapshot?.filamentUsedGrams !== undefined
          ? `, using approximately ${ui.snapshot.filamentUsedGrams.toFixed(1)} g of filament`
          : ''}
        .
      </p>
      <div className="cal-alert cal-alert--warning" role="status">
        <p>
          <strong>Starting a print moves the machine.</strong> The printer will
          heat the bed and nozzle (up to 300 °C for some materials) and the
          toolhead will move. Make sure the bed is clear, the spool is loaded,
          and nothing is in the way of the head.
        </p>
      </div>
      <label>
        Type <code>START</code> to confirm you want to start the print
        immediately:
        <input
          type="text"
          value={confirmStart}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onConfirmStartChange(event.target.value)
          }
          aria-label="Confirm start"
          autoComplete="off"
        />
      </label>
      <div className="cal-actions">
        <button
          type="button"
          className="cal-button"
          onClick={() => onSend(false)}
          disabled={busy}
        >
          Upload gcode only (do not start)
        </button>
        <button
          type="button"
          className="cal-button cal-button--primary"
          onClick={() => onSend(true)}
          disabled={busy || !canStart}
          aria-label="Start the calibration print now"
        >
          Start print now
        </button>
      </div>
    </fieldset>
  );
}

interface MeasurementStepProps {
  readonly method: CalibrationSliceMethod;
  readonly onSubmit: (measurement: CalibrationFilamentMeasurement) => void;
  readonly busy: boolean;
}

function MeasurementStep(props: MeasurementStepProps): React.JSX.Element {
  const { method, onSubmit, busy } = props;
  const meta = FILAMENT_METHOD_META[method];
  const scalarSpec = scalarSpecFor(meta.measurementSchema);
  const [scalarValue, setScalarValue] = useState<string>('');
  const [nozzleTemp, setNozzleTemp] = useState<string>('');
  const [initialTemp, setInitialTemp] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(null);
    try {
      if (scalarSpec !== null) {
        const value = Number(scalarValue);
        if (scalarValue.trim() === '' || !Number.isFinite(value)) {
          setFormError(scalarSpec.rangeMessage);
          return;
        }
        // Validate by parsing the wire schema rather than re-checking the
        // spec's numbers here. The spec's min/max exist for the label; the
        // schema is what the IPC boundary actually enforces, and duplicating
        // the band in the UI is how the two drift apart.
        const parsed = CalibrationFilamentMeasurement.safeParse({
          method,
          [scalarSpec.field]: value,
        });
        if (!parsed.success) {
          setFormError(scalarSpec.rangeMessage);
          return;
        }
        onSubmit(parsed.data);
        return;
      }
      const nozzle = Number(nozzleTemp);
      const initial = Number(initialTemp);
      if (!Number.isInteger(nozzle) || !Number.isInteger(initial)) {
        setFormError('Enter whole numbers for both temperatures.');
        return;
      }
      if (nozzle < 150 || nozzle > 300 || initial < 150 || initial > 300) {
        setFormError(
          'Both temperatures must be integers between 150 and 300 °C.',
        );
        return;
      }
      onSubmit({
        method: 'temperature_tower',
        nozzleTemperature: nozzle,
        nozzleTemperatureInitialLayer: initial,
      });
    } catch (cause) {
      setFormError(
        cause instanceof Error ? cause.message : 'The measurement is invalid.',
      );
    }
  };

  return (
    <form onSubmit={submit}>
      <fieldset
        className="cal-step-fieldset"
        aria-label="Step 6 — measurement"
        disabled={busy}
      >
        <legend>6. Enter the measurement</legend>
        <p className="cal-hint">{meta.measurementPrompt}</p>
        {scalarSpec !== null ? (
          <label>
            {scalarSpec.label}
            <input
              type="number"
              step={scalarSpec.step}
              value={scalarValue}
              onChange={(event) => setScalarValue(event.target.value)}
              aria-label={scalarSpec.ariaLabel}
            />
          </label>
        ) : (
          <>
            <label>
              Best-print nozzle temperature (°C)
              <input
                type="number"
                step="1"
                value={nozzleTemp}
                onChange={(event) => setNozzleTemp(event.target.value)}
                aria-label="Nozzle temperature"
              />
            </label>
            <label>
              Initial-layer nozzle temperature (°C)
              <input
                type="number"
                step="1"
                value={initialTemp}
                onChange={(event) => setInitialTemp(event.target.value)}
                aria-label="Initial layer nozzle temperature"
              />
            </label>
          </>
        )}
        {formError !== null ? (
          <p role="alert" className="cal-alert">
            {formError}
          </p>
        ) : null}
        <div className="cal-actions">
          <button
            type="submit"
            className="cal-button cal-button--primary"
            disabled={busy}
          >
            Save measurement and continue
          </button>
        </div>
      </fieldset>
    </form>
  );
}

// end of file
