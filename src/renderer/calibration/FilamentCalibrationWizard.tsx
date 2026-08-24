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
 * - **Restart resilience — declared gap.** The renderer is presentation-
 *   only (no renderer-scoped web storage, no filesystem, no capability
 *   except Zod IPC).
 *   The existing `saveCalibrationWorkspaceState` surface is bound to
 *   printer-calibration `projectId`/`printerId` and won't accept a
 *   filament clone id; adding a new channel is out of scope for this PR
 *   per the brief. So restart resilience is best-effort: the clone
 *   itself is durable on the server, but wizard-local state (current
 *   method, in-flight `jobId`, completion set) is lost if the operator
 *   closes the app mid-loop. Documented on the decision record; the
 *   fix path is either extending workspace persistence to be filament-
 *   aware or adding a `listSliceJobs` verb.
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
  CalibrationFilamentMeasurement,
} from '@shared/ipc';
import { browserCalibrationEnvironment, calibrationApi } from './api';
import { useCalibrationWorkspaceStore } from './CalibrationWorkspaceStore';
import {
  ProfileSelectionSection,
  type ProfileSelectionSnapshot,
} from './ProfileSelectionSection';
import {
  FILAMENT_METHOD_META,
  FILAMENT_WIZARD_METHODS,
  type FilamentWizardInFlightJob,
  type FilamentWizardPhase,
} from './filamentWizardState';

const SUPPORTED_METHOD_NAMES: Record<CalibrationSliceMethod, string> = {
  flow_rate_pass_1: 'Flow rate — pass 1',
  temperature_tower: 'Temperature tower',
  flow_rate_pass_2: 'Flow rate — pass 2',
};

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
        detail: `${error.message} Supported by this desktop build: ${Object.values(SUPPORTED_METHOD_NAMES).join(', ')}.`,
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

export function FilamentCalibrationWizard(): React.JSX.Element {
  const store = useCalibrationWorkspaceStore();
  const environment = store.environment ?? browserCalibrationEnvironment;
  const profileId = store.profileId;

  if (profileId === null) {
    return (
      <section
        className="cal-view"
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
      picks.filamentGuid === null ||
      cloneName.trim().length === 0 ||
      printerId === null
    ) {
      return;
    }
    setBusy(true);
    setBanner(null);
    setWorking((current) => ({ ...current, phase: 'cloning' }));
    try {
      const response = await calibrationApi().cloneCalibrationFilamentProfile({
        profileId,
        sourceProfileId: picks.filamentGuid,
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
  useEffect(() => {
    if (working.phase !== 'pollingSlice' || working.inFlightJob === null) {
      return;
    }
    const job = working.inFlightJob;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runPoll = async (): Promise<void> => {
      try {
        const response = await calibrationApi().getCalibrationSliceJobStatus({
          profileId,
          jobId: job.jobId,
          pollAttempt: job.pollAttempt,
        });
        if (cancelled || unmountedRef.current) return;
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
            pollAttempt: current.inFlightJob.pollAttempt + 1,
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
        if (
          response.terminal === null &&
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
  }, [profileId, working.inFlightJob, working.phase]);

  const [confirmStart, setConfirmStart] = useState<string>('');

  const sendToPrinter = useCallback(
    async (startPrint: boolean): Promise<void> => {
      const { printerId, inFlightJob } = working;
      if (printerId === null || inFlightJob === null) return;
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
  }, []);

  // ---------------------------------------------------------------- render

  return (
    <section
      className="cal-view"
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
        <fieldset className="cal-step-fieldset">
          <legend>Printer</legend>
          {printerList.printers.map((printer) => (
            <label key={printer.printerId} className="cal-printer-option">
              <input
                type="radio"
                name="filament-cal-printer"
                value={printer.printerId}
                checked={working.printerId === printer.printerId}
                onChange={() => onPickPrinter(printer)}
                aria-label={printer.displayName}
              />
              <span>
                {printer.displayName}
                {printer.printerModel !== null
                  ? ` — ${printer.printerModel}`
                  : ''}
                {printer.isOnline ? '' : ' (offline)'}
              </span>
            </label>
          ))}
        </fieldset>
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
        Work through the steps in the recommended order. Each measurement is
        written back onto <strong>{working.cloneName}</strong>, so the next step
        reads the value the previous step just corrected.
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
  const [flowRatio, setFlowRatio] = useState<string>('');
  const [nozzleTemp, setNozzleTemp] = useState<string>('');
  const [initialTemp, setInitialTemp] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(null);
    try {
      if (method === 'flow_rate_pass_1' || method === 'flow_rate_pass_2') {
        const value = Number(flowRatio);
        if (!Number.isFinite(value)) {
          setFormError('Enter a flow ratio between 0.5 and 1.5.');
          return;
        }
        if (value < 0.5 || value > 1.5) {
          setFormError(
            'The flow ratio must be between 0.5 and 1.5 — values outside that band are physically implausible.',
          );
          return;
        }
        onSubmit({ method, filamentFlowRatio: value });
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
        {meta.measurementSchema === 'flowRatio' ? (
          <label>
            Corrected filament flow ratio (0.5–1.5)
            <input
              type="number"
              step="0.001"
              value={flowRatio}
              onChange={(event) => setFlowRatio(event.target.value)}
              aria-label="Flow ratio"
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
