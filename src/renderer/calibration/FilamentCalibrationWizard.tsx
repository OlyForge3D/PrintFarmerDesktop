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
  CalibrationMethodGuidanceRecord,
  CalibrationMethodProgressRecord,
  CalibrationPrinterCandidate,
  CalibrationSliceJobSnapshot,
  CalibrationSliceMethod,
  CalibrationSpoolmanSpoolCandidate,
} from '@shared/ipc';
import {
  CALIBRATION_MAX_PROJECT_NAME,
  CalibrationFilamentMeasurement,
  PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C,
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
  buildPersistedState,
  deriveGuidedMethodStates,
  restoredWorkingState,
  scalarSpecFor,
  validateSetupInputs,
  type FilamentWizardInFlightJob,
  type FilamentWizardPersistedState,
  type FilamentWizardPhase,
  type GuidedMethodState,
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
 * Spoolman spool list state for the wizard's spool-picker step (issue #805).
 * Mirrors `PrinterListState`'s shape/loading pattern. A failed or empty load
 * is not fatal to the wizard — the operator can still explicitly proceed
 * without a spool, so `error` is surfaced as a hint rather than blocking
 * `CloneStep`.
 */
interface SpoolListState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly spools: readonly CalibrationSpoolmanSpoolCandidate[];
}

const emptySpoolList: SpoolListState = {
  loading: false,
  error: null,
  spools: [],
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

/**
 * Issue #796: banner for a `submitCalibrationObservation` failure —
 * distinct from {@link bannerFromApiError} because that function's shared
 * `invalidData` copy ("Restart the wizard — the clone or its base profile
 * appears to have drifted…") is written for the clone/slice/project call
 * sites and is wrong advice here. A range-validation rejection of a
 * *measurement* is recoverable by entering a corrected value and
 * resubmitting — nothing about the clone or project is wrong.
 *
 * Per issue #177, `error.message` is a client-authored literal catalogued by
 * `error.code` — it is never the backend's own validation prose. The
 * server's raw `detail` text (`serverDetail`) is deliberately withheld from
 * the renderer and stays in the main-process log; only the diagnosed
 * category ("Calibration data is invalid or unsafe.") and the opaque
 * `reference` cross the IPC boundary. So this banner does not show the
 * operator the exact range the server enforced — it shows the diagnosed
 * category plus the reference the operator can quote for support, which is
 * the #177-sanctioned recovery path.
 *
 * The method name is folded into the title because
 * `latestObservationRequestRef` tracks "latest" per method: a rejection for
 * method A can still be A's own latest outcome after the operator has
 * already moved on to method B, so the banner must name the method it is
 * about or it reads as though the method currently on screen was rejected.
 *
 * Every other error code delegates to the shared copy, since those
 * genuinely are the same category of failure regardless of which call
 * raised them.
 */
function bannerFromObservationApiError(
  method: CalibrationSliceMethod,
  error: CalibrationApiError,
): WizardBanner {
  if (error.code === 'invalidData') {
    return {
      kind: 'error',
      title: `${FILAMENT_METHOD_META[method].title} — measurement rejected by the server.`,
      detail: error.message,
      recovery:
        'Enter a corrected value within the allowed range and record it again; quote the reference below if it keeps failing.',
      reference: error.reference,
    };
  }
  return bannerFromApiError(error);
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
  // claim as "the server said no". This handler-level check is the only
  // capability gate on this path — `calibration:createProject` in
  // `main/ipc.ts` is a thin bridge that does not re-check
  // `calibrationGenerationEnabled` itself, so an "unconfirmed" state here
  // would reach the server rather than being refused. Blocking on
  // "unconfirmed" too would be more conservative, but availability is
  // negotiated once, up front, by the dashboard this wizard is always
  // reached from (see `CalibrationDashboard`'s `creationBlocked`), so by the
  // time this component mounts the flag is expected to already be settled
  // one way or the other; only a confirmed `false` blocks entry here.
  if (
    store.availability?.capabilityFlags?.calibrationGenerationEnabled === false
  ) {
    // Both `slicing` and `calibrationGeneration` reasons explain why
    // generation is disabled (per the server's capability negotiation
    // model — see `capabilitiesLiveResponse.snapshot.ts`); a deployment can
    // report either depending on which dependency failed.
    // `calibrationArtifactPromotion` reasons are about write-back/promotion
    // (out of scope here, blocked on #795) and are deliberately excluded.
    const relevantReasons = (
      store.availability.serverUnavailableReasons ?? []
    ).filter(
      (reason) =>
        reason.feature === 'slicing' ||
        reason.feature === 'calibrationGeneration',
    );
    const message =
      relevantReasons.length > 0
        ? relevantReasons.map((reason) => reason.message).join(' ')
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
  /**
   * The server `CalibrationProject` created at wizard start (issue #798).
   * Used to scope the server-authoritative method-guidance/method-progress
   * calls added by issue #797, AND (issue #795) from `writeMeasurement`
   * onward to submit draft-profile write-back and, on completion, to
   * trigger server-side promotion. `null` before the clone step runs.
   */
  readonly calibrationProjectId: string | null;
  /**
   * The operator's Spoolman spool pick (issue #805), or `null` to explicitly
   * proceed without one — the default, and the only option when the spool
   * list is empty or failed to load. Reset to `null` whenever `printerId`
   * changes, since a spool list is scoped to a printer. Consumed only by
   * `performClone`'s `createCalibrationProject` call; never persisted (the
   * clone-restart record only exists once a project has already been
   * created with this value baked in).
   */
  readonly selectedSpoolmanSpoolId: string | null;
  readonly completedMethods: readonly CalibrationSliceMethod[];
  readonly currentMethod: CalibrationSliceMethod | null;
  readonly inFlightJob: FilamentWizardInFlightJob | null;
  /**
   * Methods whose `submitCalibrationObservation` dual-write (issue #795) has
   * failed and not yet been retried. The clone write-back that matters for
   * the *next* slice already succeeded when a method lands here, so the
   * wizard does not block on this at write time — but a non-empty list means
   * the draft profile is missing that method's contribution, so "Finish
   * calibration" is gated on this being empty rather than silently
   * presenting an incomplete promoted profile as a success.
   */
  readonly draftObservationFailures: readonly CalibrationSliceMethod[];
  /**
   * Methods whose `submitCalibrationObservation` dual-write (issue #795) has
   * been fired but has not yet settled. Tracked separately from — and
   * synchronously with, before the async call is even issued — from
   * `draftObservationFailures` so there is no window between "the write was
   * launched" and "the write result was recorded" in which `completedMethods`
   * already lists the method but neither the pending nor the failure set
   * does. Without this, "Finish calibration" could be clicked while an
   * observation for the just-completed method is still in flight, silently
   * promoting a draft profile before its own last write landed. Never
   * persisted: an in-flight promise cannot survive a process restart, so
   * there is nothing meaningful to resume it into (see `filamentWizardState.ts`,
   * `FilamentWizardWorkingSnapshot` — deliberately excludes this field).
   */
  readonly draftObservationPending: readonly CalibrationSliceMethod[];
}

const initialWorking: WizardWorkingState = {
  phase: 'select',
  picks: null,
  printerId: null,
  printerModelId: null,
  cloneId: null,
  cloneName: '',
  calibrationProjectId: null,
  selectedSpoolmanSpoolId: null,
  completedMethods: [],
  currentMethod: null,
  inFlightJob: null,
  draftObservationFailures: [],
  draftObservationPending: [],
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
  // ------------------------------------------------------------------ spools
  const [spoolList, setSpoolList] = useState<SpoolListState>(emptySpoolList);
  const spoolListEpochRef = useRef(0);
  const unmountedRef = useRef(false);
  // Issue #795: tracks the most-recently-issued `submitCalibrationObservation`
  // request for each method. A settling request only updates
  // `draftObservationFailures` when it is STILL the latest request recorded
  // here for its method — an out-of-order settlement (an older, superseded
  // request resolving AFTER a newer redo for the same method) must not be
  // allowed to overwrite the newer request's outcome. Every request still
  // removes its own `draftObservationPending` marker on settle regardless of
  // whether it is latest, so pending accurately reflects "any request still
  // outstanding" while the failure flag reflects only the newest one.
  const latestObservationRequestRef = useRef<
    Partial<Record<CalibrationSliceMethod, symbol>>
  >({});
  // Guards `beginMethod` against a synchronous double-submit — see the
  // comment at its call site. Mirrors `sendToPrinterInFlightRef` below.
  const beginMethodInFlightRef = useRef(false);
  // Issue #798: the server's create-project route is idempotent on
  // `(clientId, requestId)` — a retry that reuses the same pair returns the
  // already-created project instead of minting a duplicate. This id must
  // stay stable across a failed create/clone retry *within the same
  // attempt* (the operator clicking "Clone" again after a transient error)
  // and only roll over once a genuinely new attempt starts, at
  // `proceedToCloneName`.
  const createProjectRequestIdRef = useRef<string | null>(null);
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
        calibrationProjectId: working.calibrationProjectId,
        completedMethods: working.completedMethods,
        currentMethod: working.currentMethod,
        inFlightJob: working.inFlightJob,
        // Persist any method still `draftObservationPending` as a FAILURE,
        // not merely dropping it. `draftObservationPending` is intentionally
        // never itself persisted (an in-flight promise can't survive a
        // restart) — but if the app exits while a request is unresolved, we
        // cannot confirm it landed, so treat it the same as a known failure
        // on restore. Otherwise a restart mid-write would silently forget
        // both that the method was unconfirmed AND that it failed, letting
        // "Finish calibration" re-enable over a draft profile that was
        // never actually confirmed complete.
        draftObservationFailures: Array.from(
          new Set([
            ...working.draftObservationFailures,
            ...working.draftObservationPending,
          ]),
        ),
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
    working.calibrationProjectId,
    working.cloneId,
    working.cloneName,
    working.completedMethods,
    working.currentMethod,
    working.draftObservationFailures,
    working.draftObservationPending,
    working.inFlightJob,
    working.phase,
    working.picks,
    working.printerId,
    working.printerModelId,
  ]);

  // ------------------ server-authoritative method disposition (issue #797) --
  //
  // `method-progress` is project-owned, not device-scoped, so this reads the
  // same Skipped/Pending/Completed state a second device would see for the
  // same project — never from `working.completedMethods` (local-JSON-only,
  // legacy from before this issue, left in place for #799 to reconcile).
  const [methodProgress, setMethodProgress] = useState<
    Readonly<Record<string, CalibrationMethodProgressRecord>>
  >({});
  // Distinguishes "no row yet, defaults to Pending" from "we don't actually
  // know, the read failed" — a read failure must never render a step that
  // was skipped on another device as Pending (see `MethodStep` below).
  const [methodProgressStatus, setMethodProgressStatus] = useState<
    'loading' | 'ready' | 'error'
  >('loading');
  // A `Set`, not a single method: two skip/un-skip clicks on different
  // methods fired in quick succession must each independently gate their own
  // button until their own round trip settles, rather than one request's
  // completion re-enabling every other in-flight request's button.
  const [methodProgressBusyMethods, setMethodProgressBusyMethods] = useState<
    ReadonlySet<string>
  >(new Set());

  // ------------------ server-authoritative method guidance (issue #797) -----
  //
  // `method-guidance` is a global catalogue (not project-scoped), so it is
  // fetched once per profile session rather than re-fetched per project. It
  // replaces the client-hardcoded `FILAMENT_METHOD_META` title/summary text
  // (the interim stand-in #794/#799 shipped against) wherever the server
  // supplies a value; a fetch failure degrades gracefully to
  // `FILAMENT_METHOD_META` alone (a banner would be noise for a background
  // enrichment call the wizard can fully operate without).
  const [methodGuidance, setMethodGuidance] = useState<
    Readonly<Record<string, CalibrationMethodGuidanceRecord>>
  >({});
  // Fetch-only generation counter, bumped once per `fetchMethodProgress`
  // call. This DATA's merge is always safe to apply regardless of this
  // counter (it merges per-method by revision — see `fetchMethodProgress`),
  // but the *status indicator* (`'ready'`/`'error'`) is gated by it either
  // way: only the fetch that is still the LATEST by this counter may move
  // the status, in either direction. Without that symmetry a stale, slow
  // response could clobber a newer fetch's genuine outcome — a late
  // success masking a newer failure (leaving no "Retry sync" offered for a
  // read that actually never completed), or, before this counter existed,
  // a late failure masking a newer success. Deliberately NOT bumped by
  // skip/un-skip writes (`toggleMethodDisposition`): an earlier version did
  // that to invalidate in-flight reads, but that meant an unrelated write
  // landing between a rejected write's conflict-refetch and that refetch's
  // *failure* would make the mismatch swallow the error, leaving the sync
  // status stuck at `'loading'` forever with no "Retry sync" ever offered.
  const methodProgressSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response =
          await calibrationApi().getCalibrationMethodGuidanceCatalog({
            profileId,
          });
        if (cancelled || unmountedRef.current) return;
        if (response.status === 'ok') {
          const byMethod: Record<string, CalibrationMethodGuidanceRecord> = {};
          for (const entry of response.catalog) {
            byMethod[entry.method] = entry;
          }
          setMethodGuidance(byMethod);
        }
      } catch {
        // Best-effort — see comment above; the wizard falls back to
        // FILAMENT_METHOD_META for any method the catalog didn't supply.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  const fetchMethodProgress = useCallback(async (): Promise<void> => {
    const projectId = working.calibrationProjectId;
    const seq = ++methodProgressSeqRef.current;
    if (projectId === null) {
      setMethodProgress({});
      setMethodProgressStatus('ready');
      return;
    }
    setMethodProgressStatus('loading');
    try {
      const response = await calibrationApi().getCalibrationMethodProgress({
        profileId,
        projectId,
      });
      if (unmountedRef.current) return;
      if (response.status === 'ok') {
        // Merge per-method by revision rather than replacing the whole map
        // wholesale. This is what makes it safe to apply this response even
        // if a *newer fetch* has since been kicked off (see
        // `methodProgressSeqRef`) — it may be exactly the reconciliation a
        // different method's rejected write is waiting on (e.g. a
        // stale-revision conflict refetch for method A must still land A's
        // fresher row even if an unrelated write to method B resolved in
        // between; discarding the whole response would leave A's retry
        // stuck resubmitting the same stale revision forever). The
        // per-entry revision comparison is what keeps this safe: it never
        // *downgrades* a method whose locally-known revision is already at
        // least as new — that only happens when a write for that exact
        // method resolved after this read was issued, in which case the
        // write's row is already the freshest available truth for it.
        setMethodProgress((current) => {
          const merged: Record<string, CalibrationMethodProgressRecord> = {
            ...current,
          };
          for (const entry of response.progress) {
            const existing = merged[entry.method];
            if (existing === undefined || entry.revision >= existing.revision) {
              merged[entry.method] = entry;
            }
          }
          return merged;
        });
        // Merging this response's data is always safe (see above) even if a
        // newer fetch has since been kicked off, so it happens
        // unconditionally. Advancing the *status indicator* to `'ready'` is
        // a different claim — "the CURRENT read attempt is known-good" — and
        // must NOT be made by a stale response once a newer fetch is
        // already in flight or has already resolved: if fetch B (started
        // after this one) already landed an `'error'`, this older fetch's
        // late `'ok'` must not clobber that genuine failure back to
        // `'ready'` — the operator would see no failure and no "Retry sync"
        // affordance for a sync that never actually completed for the
        // newest read. Only the fetch that is STILL the latest by sequence
        // number may move the status.
        if (methodProgressSeqRef.current === seq) {
          setMethodProgressStatus('ready');
        }
      } else if (methodProgressSeqRef.current === seq) {
        // A row-shaped error response — treat the same as a thrown error
        // below: we do NOT know the real disposition, so it must not be
        // presented as Pending. Unlike the ok-path above, an error carries
        // no data to merge, so it is only surfaced when nothing fresher is
        // already in flight or already landed (a newer fetch already
        // holds — or will hold — the current truth).
        setMethodProgressStatus('error');
      }
    } catch {
      if (unmountedRef.current) return;
      if (methodProgressSeqRef.current !== seq) return;
      // Unlike the guidance catalog, a progress-read failure is NOT
      // presented as "every step defaults to Pending" — that would make a
      // step skipped from another device silently look Pending here, which
      // is exactly the failure mode issue #797 exists to prevent. `Skip`
      // stays disabled (see `canToggleSkip` in `MethodStep`) until a
      // successful read establishes real state — either the next automatic
      // fetch, or the operator's explicit "Retry sync" action.
      setMethodProgressStatus('error');
    }
  }, [profileId, working.calibrationProjectId]);

  useEffect(() => {
    void fetchMethodProgress();
  }, [fetchMethodProgress]);

  const toggleMethodDisposition = useCallback(
    async (method: CalibrationSliceMethod): Promise<void> => {
      const projectId = working.calibrationProjectId;
      if (projectId === null) return;
      const existing = methodProgress[method] ?? null;
      const nextDisposition =
        existing?.disposition === 'Skipped' ? 'Pending' : 'Skipped';
      setMethodProgressBusyMethods((current) => new Set(current).add(method));
      try {
        const response = await calibrationApi().setCalibrationMethodDisposition(
          {
            profileId,
            projectId,
            method,
            disposition: nextDisposition,
            baseRevision: existing?.revision ?? null,
          },
        );
        if (unmountedRef.current) return;
        if (response.status === 'ok') {
          // No need to invalidate an in-flight progress GET here: the
          // per-method, revision-keyed merge in `fetchMethodProgress` already
          // guarantees a slower read can never clobber this write's fresher
          // row (its revision is definitionally the highest known for this
          // method at the moment it lands). `methodProgressSeqRef` is a
          // fetch-only generation counter — see its declaration — precisely
          // so that a write settling here never suppresses a *different*
          // in-flight fetch's error handling.
          setMethodProgress((current) => ({
            ...current,
            [method]: response.progress,
          }));
        } else {
          setBanner(bannerFromApiError(response.error));
          // A rejection is very often a stale `baseRevision` (someone else
          // skipped/un-skipped this method since our last read) — refetch so
          // the next click retries against the current revision instead of
          // repeating the same conflict forever.
          void fetchMethodProgress();
        }
      } catch (cause) {
        if (unmountedRef.current) return;
        setBanner({
          kind: 'error',
          title: 'The skip status could not be saved.',
          detail:
            cause instanceof Error
              ? cause.message
              : 'The desktop lost contact with the main process.',
          recovery: 'Retry.',
          reference: null,
        });
      } finally {
        if (!unmountedRef.current) {
          setMethodProgressBusyMethods((current) => {
            if (!current.has(method)) return current;
            const next = new Set(current);
            next.delete(method);
            return next;
          });
        }
      }
    },
    [
      profileId,
      working.calibrationProjectId,
      methodProgress,
      fetchMethodProgress,
    ],
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

  // Issue #805: list Spoolman spools for the chosen printer so the operator
  // can pick one in `CloneStep`. `printerId` is required by the server
  // route, so this only fires once a printer has been picked (`cloneName`
  // phase is unreachable without one — see `proceedToCloneName`).
  const loadSpools = useCallback(async (): Promise<void> => {
    if (working.printerId === null) {
      setSpoolList(emptySpoolList);
      return;
    }
    const printerId = working.printerId;
    const epoch = ++spoolListEpochRef.current;
    setSpoolList((current) => ({ ...current, loading: true, error: null }));
    // Issue #805 (reviewer follow-up): if a reload no longer contains the
    // previously selected spool (removed from the farm, or the reload
    // failed outright), the picker's `<select>` would fall back to "No
    // spool" visually while `performClone` still held the stale Guid. Clear
    // the selection whenever the resolved list (successful or empty on
    // failure) doesn't contain it, so the UI and the pending request agree.
    const reconcileSelection = (
      spools: readonly { spoolmanSpoolId: string }[],
    ): void => {
      setWorking((current) =>
        current.selectedSpoolmanSpoolId !== null &&
        !spools.some(
          (spool) => spool.spoolmanSpoolId === current.selectedSpoolmanSpoolId,
        )
          ? { ...current, selectedSpoolmanSpoolId: null }
          : current,
      );
    };
    try {
      const response = await calibrationApi().listCalibrationSpoolmanSpools({
        profileId,
        printerId,
      });
      if (spoolListEpochRef.current !== epoch || unmountedRef.current) return;
      if (response.status === 'error') {
        setSpoolList({
          loading: false,
          error: errorCopy(response.error).title,
          spools: [],
        });
        reconcileSelection([]);
        return;
      }
      setSpoolList({ loading: false, error: null, spools: response.spools });
      reconcileSelection(response.spools);
    } catch (cause) {
      if (spoolListEpochRef.current !== epoch || unmountedRef.current) return;
      const message =
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : 'Spoolman spools could not be loaded.';
      // Non-fatal: the operator can still explicitly proceed without a
      // spool, so this surfaces as a hint in `CloneStep` rather than a
      // blocking banner.
      setSpoolList({ loading: false, error: message, spools: [] });
      reconcileSelection([]);
    }
  }, [profileId, working.printerId]);

  useEffect(() => {
    if (working.phase === 'cloneName') {
      void loadSpools();
    }
  }, [loadSpools, working.phase]);

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
        // A spool list is scoped to a printer (issue #805) — any prior pick
        // no longer applies once the printer changes.
        selectedSpoolmanSpoolId: null,
      }));
    },
    [],
  );

  const handlePickSpool = useCallback(
    (spoolmanSpoolId: string | null): void => {
      setWorking((current) => ({
        ...current,
        selectedSpoolmanSpoolId: spoolmanSpoolId,
      }));
    },
    [],
  );

  const proceedToCloneName = useCallback(() => {
    // A new attempt at naming the clone starts a fresh idempotency key —
    // any project created under the *previous* attempt's key is done with.
    createProjectRequestIdRef.current = null;
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
    const {
      picks,
      printerId,
      printerModelId,
      cloneName,
      selectedSpoolmanSpoolId,
    } = working;
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
      // filament-identity mapping: no material metadata is available
      // client-side for a profile pick, so a documented placeholder is
      // sent — the field just needs to be non-empty.
      //
      // Issue #805: `selectedSpoolmanSpoolId` comes from the spool picker
      // in `CloneStep`. `spoolmanSpoolId` and `spoolmanFilamentId` are
      // distinct PrintFarmer-side Guids (see `CalibrationSpoolmanSpoolCandidate`
      // in `shared/ipc.ts`) — a spool's filament association is only `null`
      // when PrintFarmer's Spoolman mirror hasn't resolved one yet, so the
      // candidate's own `spoolmanFilamentId` is looked up and forwarded
      // rather than duplicating the spool id into both fields.
      // `localSpoolId` stays `null`: this app tracks no local-spool
      // inventory of its own.
      const selectedSpoolCandidate =
        selectedSpoolmanSpoolId === null
          ? null
          : (spoolList.spools.find(
              (spool) => spool.spoolmanSpoolId === selectedSpoolmanSpoolId,
            ) ?? null);
      // `requestId` is memoized in a ref across retries of this same
      // attempt (reset only in `proceedToCloneName`) so a retry after a
      // transient failure hits the server's idempotency key instead of
      // minting an orphaned duplicate project.
      const requestId =
        createProjectRequestIdRef.current ?? environment.createId();
      createProjectRequestIdRef.current = requestId;
      const projectNameSuffix = ' (calibration project)';
      const trimmedCloneName = cloneName.trim();
      const projectName = `${trimmedCloneName}${projectNameSuffix}`.slice(
        0,
        CALIBRATION_MAX_PROJECT_NAME,
      );
      const projectResponse = await calibrationApi().createCalibrationProject({
        profileId,
        requestId,
        name: projectName,
        printerId,
        filamentProvider: 'printfarmer',
        filamentProductId: sourceProfileId,
        filamentProductName: picks.filamentName,
        filamentMaterial: 'unknown',
        spoolmanFilamentId: selectedSpoolCandidate?.spoolmanFilamentId ?? null,
        spoolmanSpoolId: selectedSpoolmanSpoolId,
        localSpoolId: null,
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
        // Issue #797: capture the `CalibrationProject` id created above so
        // it can scope `method-guidance`/`method-progress` calls. Previously
        // dropped entirely — `projectResponse.project.id` was read nowhere.
        // Issue #795 additionally threads this same id into
        // `submitCalibrationObservation`/`completeCalibrationProject` calls
        // from `writeMeasurement`/`finishCalibration` onward.
        calibrationProjectId: projectResponse.project.id,
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
  }, [profileId, working, environment, spoolList]);

  // ------------------ four-phase per-step UI (issue #799) -------------------
  //
  // A method pick no longer submits a slice directly. It now runs through
  // purpose (what this measures/why, before asking for anything) and inputs
  // (the method's declared setup inputs, from the server guidance catalog —
  // issue #797 — falling back to none if that catalog has not loaded) before
  // `beginMethod` below ever runs. Both screens are pure client-side
  // navigation (no network call), so `selectMethod`/`backToMethodPicker`/
  // `advanceToInputs`/`backToPurpose` only ever touch `working.phase` and
  // `working.currentMethod`.
  const selectMethod = useCallback((method: CalibrationSliceMethod): void => {
    setBanner(null);
    setWorking((current) => ({
      ...current,
      phase: 'methodPurpose',
      currentMethod: method,
    }));
  }, []);

  const backToMethodPicker = useCallback((): void => {
    setWorking((current) => ({
      ...current,
      phase: 'methodPicker',
      currentMethod: null,
    }));
  }, []);

  const advanceToInputs = useCallback((): void => {
    setWorking((current) => ({ ...current, phase: 'methodInputs' }));
  }, []);

  const backToPurpose = useCallback((): void => {
    setWorking((current) => ({ ...current, phase: 'methodPurpose' }));
  }, []);

  const beginMethod = useCallback(
    async (
      method: CalibrationSliceMethod,
      params?: Readonly<Record<string, number>>,
    ): Promise<void> => {
      // A synchronous double-submit (double-click, or Enter followed by a
      // click before React commits `busy`) would otherwise fire this twice
      // and dispatch two slice jobs — the same race `sendToPrinterInFlightRef`
      // guards against below. `setBusy(true)` alone is not enough because the
      // state update has not committed by the time a second synchronous
      // handler invocation runs.
      if (beginMethodInFlightRef.current) return;
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
      beginMethodInFlightRef.current = true;
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
          // Issue #799: populate `params` from the setup inputs collected in
          // the inputs phase. Omitted entirely (rather than sent as `{}`)
          // when the method declares none, so a method with no setup inputs
          // leaves `params` absent on the wire rather than vacuously present.
          ...(params !== undefined && Object.keys(params).length > 0
            ? { params }
            : {}),
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
        beginMethodInFlightRef.current = false;
        if (!unmountedRef.current) setBusy(false);
      }
    },
    [profileId, working],
  );

  const submitInputsAndSlice = useCallback(
    (params: Readonly<Record<string, number>>): void => {
      const method = working.currentMethod;
      if (method === null) return;
      void beginMethod(method, params);
    },
    [working.currentMethod, beginMethod],
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
      const { cloneId, currentMethod, calibrationProjectId } = working;
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
        // Issue #795 dual-write: alongside the clone PUT above (kept for
        // slicing continuity — slicing resolves profiles by name, not by
        // project/draft reference), also submit the measurement as a
        // calibration-project observation so the server accumulates it into
        // the project's draft profile. This does not block or interrupt the
        // wizard — the write-back that matters for the NEXT slice (the clone
        // PUT) already landed — but a failure IS tracked in
        // `draftObservationFailures` rather than silently swallowed: an
        // untracked failure here would let "Finish calibration" present a
        // promoted profile as complete when it is silently missing this
        // method's contribution. See `canFinish` and the method-picker hint.
        if (calibrationProjectId !== null) {
          const observedMethod = currentMethod;
          // Mark the observation pending BEFORE the async call is issued
          // (synchronously, in the same tick that flips `completedMethods`
          // below) so there is no window in which `completedMethods`
          // includes this method but neither `draftObservationPending` nor
          // `draftObservationFailures` reflects that its write-back is still
          // unresolved. `canFinish` gates on both sets being empty.
          //
          // Deliberately allows DUPLICATE entries for the same method: if
          // the operator redoes a method while its prior submission is
          // still in flight, each in-flight request gets its own pending
          // marker, and each removes exactly its own marker on settle (see
          // `latestObservationRequestRef` above for how the FAILURE flag,
          // as opposed to the pending count, stays correct across
          // out-of-order settlement).
          const requestToken = Symbol(observedMethod);
          latestObservationRequestRef.current[observedMethod] = requestToken;
          setWorking((current) => ({
            ...current,
            draftObservationPending: [
              ...current.draftObservationPending,
              observedMethod,
            ],
          }));
          // Issue #796: the banner below must obey the SAME
          // latest-request rule as the pending/failure bookkeeping — a
          // stale (superseded) request settling after a newer redo was
          // already issued carries no information about the method's
          // CURRENT state, so it must not overwrite a banner that reflects
          // a newer request's outcome. `markObservation` returns whether
          // it just acted on the latest request so both concerns share one
          // check rather than drifting apart.
          const isLatestObservationRequest = (): boolean =>
            latestObservationRequestRef.current[observedMethod] ===
            requestToken;
          const markObservation = (failed: boolean): boolean => {
            const isLatestRequest = isLatestObservationRequest();
            if (unmountedRef.current) return isLatestRequest;
            setWorking((current) => {
              const pendingIndex =
                current.draftObservationPending.indexOf(observedMethod);
              const nextPending =
                pendingIndex === -1
                  ? current.draftObservationPending
                  : [
                      ...current.draftObservationPending.slice(0, pendingIndex),
                      ...current.draftObservationPending.slice(
                        pendingIndex + 1,
                      ),
                    ];
              // Only the MOST RECENTLY ISSUED request for this method may
              // set/clear the failure flag. A stale (superseded) request
              // settling after a newer redo was already issued carries no
              // information about the method's CURRENT state — accepting
              // its outcome could let an older failure clear a newer one's
              // failure, or (worse) let an older success clear a newer
              // request's still-pending or already-failed status.
              if (!isLatestRequest) {
                return pendingIndex === -1
                  ? current
                  : { ...current, draftObservationPending: nextPending };
              }
              const alreadyFlagged =
                current.draftObservationFailures.includes(observedMethod);
              if (pendingIndex === -1 && failed === alreadyFlagged) {
                return current;
              }
              return {
                ...current,
                draftObservationPending: nextPending,
                draftObservationFailures: failed
                  ? alreadyFlagged
                    ? current.draftObservationFailures
                    : [...current.draftObservationFailures, observedMethod]
                  : current.draftObservationFailures.filter(
                      (method) => method !== observedMethod,
                    ),
              };
            });
            return isLatestRequest;
          };
          void calibrationApi()
            .submitCalibrationObservation({
              profileId,
              projectId: calibrationProjectId,
              requestId: environment.createId(),
              operationId: environment.createId(),
              measurement,
            })
            .then((observationResponse) => {
              const isLatestRequest = markObservation(
                observationResponse.status === 'error',
              );
              // Issue #796: surface the diagnosed rejection (category +
              // #177 opaque reference — see `bannerFromObservationApiError`
              // for why this is not the server's raw validation text)
              // instead of only the generic "N step(s) failed to sync"
              // hint that `draftObservationFailures` alone renders later.
              // Does not block or interrupt the wizard — the phase/banner
              // set right below for the successful clone write-back is
              // untouched; this banner simply replaces it once the
              // (still-latest) background observation settles as an error,
              // same as any other async banner update in this component.
              if (
                observationResponse.status === 'error' &&
                isLatestRequest &&
                !unmountedRef.current
              ) {
                setBanner(
                  bannerFromObservationApiError(
                    observedMethod,
                    observationResponse.error,
                  ),
                );
              }
              // Issue #797's server-authoritative method disposition can
              // transition this method's row to `Completed` as a side
              // effect of the observation the server just accepted. The
              // locally-cached `methodProgress` map has no way to know
              // that happened until the next read — without this refetch,
              // the Skip button would keep showing (and accepting clicks
              // for) a now-stale `Pending`/`Skipped` disposition for a
              // method that was just measured, which could overwrite the
              // server's fresher `Completed` row with a stale-baseRevision
              // Skip request. Fired on FAILURE too, not only success:
              // `submitCalibrationObservation` is two server calls under
              // the hood (create attempt, then append observation) — if
              // only the second fails, the first may already have mutated
              // this method's progress row server-side, so a failure here
              // does not guarantee the disposition is unchanged.
              // `fetchMethodProgress`'s own revision-keyed merge (see its
              // doc comment) makes this safe and idempotent to fire
              // unconditionally, even if a different fetch is concurrently
              // in flight.
              void fetchMethodProgress();
            })
            .catch((cause: unknown) => {
              const isLatestRequest = markObservation(true);
              if (isLatestRequest && !unmountedRef.current) {
                setBanner({
                  kind: 'error',
                  title: `${FILAMENT_METHOD_META[observedMethod].title} — the draft-profile observation could not be recorded.`,
                  detail:
                    cause instanceof Error
                      ? cause.message
                      : 'The desktop lost contact with the main process.',
                  recovery: 'Redo this step to try again.',
                  reference: null,
                });
              }
              void fetchMethodProgress();
            });
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
    [environment, fetchMethodProgress, profileId, working],
  );

  const finishCalibration = useCallback(async (): Promise<void> => {
    const { calibrationProjectId } = working;
    if (calibrationProjectId === null) return;
    setBusy(true);
    setBanner(null);
    try {
      const response = await calibrationApi().completeCalibrationProject({
        profileId,
        projectId: calibrationProjectId,
      });
      if (unmountedRef.current) return;
      if (response.status === 'error') {
        setBanner(bannerFromApiError(response.error));
        return;
      }
      setBanner({
        kind: 'info',
        title: 'Calibration completed.',
        detail:
          response.promotedProfileId !== null
            ? 'The accumulated draft profile was promoted to a new custom filament profile.'
            : 'The project was marked complete, but promotion could not be confirmed yet. Click "Finish calibration" again to retry — completion is idempotent — or check the custom filament profile list directly.',
        recovery:
          response.promotedProfileId !== null
            ? 'Start a new calibration for another spool, or go back to the dashboard.'
            : 'Retry, or start a new calibration once you have confirmed the promotion.',
        reference: null,
      });
      if (response.promotedProfileId === null) {
        // Ambiguous outcome: the project transitioned server-side, but the
        // follow-up promoted-profile read failed or hadn't caught up yet.
        // Keep `calibrationProjectId` (and the rest of the wizard state)
        // alive so the operator can retry this same idempotent call — resetting here
        // would strand them with no way to confirm or re-request promotion.
        return;
      }
      setWorking(initialWorking);
      setSliceJobUi(emptySliceJobUi);
      setConfirmStart('');
      lastPersistedJsonRef.current = null;
      // Issue #795 / PrintFarmer#2203: the working clone's only remaining
      // purpose — slicing continuity during calibration — ends the moment a
      // durable promoted profile exists. Best-effort overall: neither step
      // blocks or re-surfaces an error for the completion the operator
      // already saw confirmed above. But the two steps are CHAINED, not
      // independent: the bookmark is cleared first, and the clone is only
      // deleted once that clear is confirmed to have succeeded. If clearing
      // the bookmark fails, the clone is deliberately left alone — a restart
      // would otherwise resume a persisted bookmark that still names a clone
      // that no longer exists, breaking resume outright instead of just
      // leaving a harmless duplicate.
      const cloneIdToDelete = working.cloneId;
      void calibrationApi()
        .clearFilamentCalibrationWizardState({ profileId })
        .then(() => {
          if (cloneIdToDelete === null) return;
          return calibrationApi()
            .deleteWorkingCloneProfile({
              profileId,
              customProfileId: cloneIdToDelete,
            })
            .then(() => undefined);
        })
        .catch(() => {
          // Best-effort: if clearing failed, the clone is intentionally
          // preserved (see comment above). If clearing succeeded but
          // deletion failed, the stale clone is a harmless orphan.
        });
    } catch (cause) {
      if (unmountedRef.current) return;
      setBanner({
        kind: 'error',
        title: 'The calibration could not be marked complete.',
        detail:
          cause instanceof Error
            ? cause.message
            : 'The desktop lost contact with the main process.',
        recovery: 'Retry.',
        reference: null,
      });
    } finally {
      if (!unmountedRef.current) setBusy(false);
    }
  }, [profileId, working]);

  const restartWizard = useCallback(() => {
    // Issue #795 / PrintFarmer#2203: "Start over" is the operator's explicit
    // abandon action — the only reliable client-side abandon signal that
    // exists (there is no way to distinguish a mere navigate-away from a
    // genuine give-up; see the doc comment on
    // `CalibrationCompleteCalibrationProjectResponse` in `shared/ipc.ts`).
    // Best-effort overall: a failure here must not block restarting. But
    // the bookmark clear and the clone delete are CHAINED, not independent:
    // the bookmark is cleared first, and the clone is only deleted once
    // that clear is confirmed to have succeeded. If clearing fails, the
    // clone is deliberately left alone — otherwise a future restart could
    // resume a stale bookmark that names a clone that no longer exists,
    // breaking resume outright instead of just leaving a harmless orphan.
    const cloneIdToDelete = working.cloneId;
    setWorking(initialWorking);
    setBanner(null);
    setSliceJobUi(emptySliceJobUi);
    setConfirmStart('');
    lastPersistedJsonRef.current = null;
    void calibrationApi()
      .clearFilamentCalibrationWizardState({ profileId })
      .then(() => {
        if (cloneIdToDelete === null) return;
        return calibrationApi()
          .deleteWorkingCloneProfile({
            profileId,
            customProfileId: cloneIdToDelete,
          })
          .then(() => undefined);
      })
      .catch(() => {
        // Best-effort: if clearing failed, the clone is intentionally
        // preserved (see comment above). If clearing succeeded but deletion
        // failed, the stale clone is a harmless orphan; the live wizard has
        // already returned to a clean in-memory state either way.
      });
  }, [profileId, working]);

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
          spoolList={spoolList}
          onPickSpool={handlePickSpool}
        />
      ) : null}

      {working.phase === 'methodPicker' ? (
        <MethodStep
          working={working}
          busy={busy}
          onPickMethod={selectMethod}
          onFinish={() => void finishCalibration()}
          methodProgress={methodProgress}
          methodProgressStatus={methodProgressStatus}
          methodProgressBusyMethods={methodProgressBusyMethods}
          onToggleSkip={(method) => void toggleMethodDisposition(method)}
          onRetrySync={() => void fetchMethodProgress()}
          methodGuidance={methodGuidance}
        />
      ) : null}

      {working.phase === 'methodPurpose' && working.currentMethod !== null ? (
        <MethodPurposeStep
          method={working.currentMethod}
          guidance={methodGuidance[working.currentMethod] ?? null}
          busy={busy}
          onBack={backToMethodPicker}
          onContinue={advanceToInputs}
        />
      ) : null}

      {working.phase === 'methodInputs' && working.currentMethod !== null ? (
        <MethodInputsStep
          method={working.currentMethod}
          guidance={methodGuidance[working.currentMethod] ?? null}
          busy={busy}
          onBack={backToPurpose}
          onSubmit={submitInputsAndSlice}
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
  /** Issue #805: Spoolman spools available for the chosen printer. */
  readonly spoolList: SpoolListState;
  /** `null` explicitly proceeds without a spool. */
  readonly onPickSpool: (spoolmanSpoolId: string | null) => void;
}

const NO_SPOOL_OPTION_VALUE = '';

function CloneStep(props: CloneStepProps): React.JSX.Element {
  const {
    working,
    onCloneNameChange,
    onConfirmClone,
    onBack,
    busy,
    spoolList,
    onPickSpool,
  } = props;
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
      <label>
        Spoolman spool (optional)
        <select
          aria-label="Spoolman spool"
          value={working.selectedSpoolmanSpoolId ?? NO_SPOOL_OPTION_VALUE}
          onChange={(event: ChangeEvent<HTMLSelectElement>) =>
            onPickSpool(
              event.target.value === NO_SPOOL_OPTION_VALUE
                ? null
                : event.target.value,
            )
          }
          disabled={spoolList.loading}
        >
          <option value={NO_SPOOL_OPTION_VALUE}>
            No spool — proceed without Spoolman data
          </option>
          {spoolList.spools.map((spool) => (
            <option key={spool.spoolmanSpoolId} value={spool.spoolmanSpoolId}>
              {spool.displayName}
            </option>
          ))}
        </select>
      </label>
      {spoolList.loading ? (
        <p className="cal-hint">Loading Spoolman spools…</p>
      ) : null}
      {spoolList.error !== null ? (
        <p className="cal-hint">
          Spoolman spools could not be loaded ({spoolList.error}). You can still
          proceed without one.
        </p>
      ) : null}
      <div className="cal-actions">
        <button type="button" className="cal-button" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="cal-button cal-button--primary"
          disabled={!nameValid || busy || spoolList.loading}
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
  readonly onFinish: () => void;
  /**
   * Server-authoritative per-method disposition (issue #797), keyed by
   * method. A method absent here has no progress row yet and is treated as
   * `Pending` — the server only creates a row on the first explicit
   * skip/un-skip.
   */
  readonly methodProgress: Readonly<
    Record<string, CalibrationMethodProgressRecord>
  >;
  /**
   * Whether the last `getMethodProgress` read for the current project
   * succeeded. `'error'` must NOT be presented as "every step is Pending" —
   * that would make a step skipped on another device look Pending here,
   * exactly the failure #797 exists to prevent — so `MethodStep` renders a
   * distinct "Sync failed" state and disables Skip/Un-skip until a
   * subsequent read succeeds.
   */
  readonly methodProgressStatus: 'loading' | 'ready' | 'error';
  /** Methods currently awaiting their own `setMethodDisposition` round trip. */
  readonly methodProgressBusyMethods: ReadonlySet<string>;
  readonly onToggleSkip: (method: CalibrationSliceMethod) => void;
  /**
   * Re-runs `getMethodProgress` on demand. Surfaced as an explicit "Retry
   * sync" action when `methodProgressStatus === 'error'` — reopening the
   * wizard would otherwise be the only way to recover from a failed read.
   */
  readonly onRetrySync: () => void;
  /**
   * Server-sourced method metadata (issue #797), keyed by method. Replaces
   * the client-hardcoded `FILAMENT_METHOD_META` title/purpose text wherever
   * present; a method absent here (catalog fetch still in flight, or the
   * fetch failed) falls back to `FILAMENT_METHOD_META` alone.
   */
  readonly methodGuidance: Readonly<
    Record<string, CalibrationMethodGuidanceRecord>
  >;
}

function MethodStep(props: MethodStepProps): React.JSX.Element {
  const {
    working,
    busy,
    onPickMethod,
    onFinish,
    methodProgress,
    methodProgressStatus,
    methodProgressBusyMethods,
    onToggleSkip,
    onRetrySync,
    methodGuidance,
  } = props;
  const isActive = working.phase === 'methodPicker';
  const hasSyncFailures = working.draftObservationFailures.length > 0;
  const hasSyncPending = working.draftObservationPending.length > 0;
  const canFinish =
    working.calibrationProjectId !== null &&
    working.completedMethods.length > 0 &&
    !hasSyncFailures &&
    !hasSyncPending;

  // Guided order (issue #794): drives which step is disabled/"locked" and
  // which one is the recommended "Next" step, from server-authoritative
  // progress (issue #797) rather than `working.completedMethods` alone.
  // `deriveGuidedMethodStates` returns `null` — meaning "do not gate
  // anything" — until there is a real project AND a successful progress
  // read to gate against; see its docblock for why that degrades safely to
  // the pre-#794 free-choice picker rather than locking against stale or
  // absent data.
  const guidedStates = deriveGuidedMethodStates(FILAMENT_WIZARD_METHODS, {
    completedMethods: working.completedMethods,
    dispositionFor: (method) => methodProgress[method]?.disposition ?? null,
    gatingAvailable:
      working.calibrationProjectId !== null && methodProgressStatus === 'ready',
  });
  const guidedByMethod = new Map<CalibrationSliceMethod, GuidedMethodState>(
    guidedStates?.map((state) => [state.method, state]) ?? [],
  );

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
      {methodProgressStatus === 'error' ? (
        <div className="cal-alert cal-alert--warning" role="status">
          <p>
            Couldn&apos;t read step status from the server. Skip and Un-skip are
            disabled here until this succeeds — the last-known skipped/pending
            state may be stale or unavailable.
          </p>
          <button
            type="button"
            className="cal-button cal-button--secondary"
            onClick={onRetrySync}
            disabled={!isActive || busy}
          >
            Retry sync
          </button>
        </div>
      ) : null}
      <ul className="cal-method-list">
        {FILAMENT_WIZARD_METHODS.map((method) => {
          const meta = FILAMENT_METHOD_META[method];
          const guidance = methodGuidance[method] ?? null;
          // Server guidance (issue #797) replaces the client-hardcoded title
          // and purpose text wherever the catalog supplied a value for this
          // method; FILAMENT_METHOD_META remains the fallback (catalog still
          // loading, or the fetch failed) and stays the source of
          // `measurementSchema` regardless, which is out of this issue's scope.
          const title = guidance?.title ?? meta.title;
          const purpose = guidance?.purpose ?? meta.summary;
          // Issue #795: block redoing a method while ITS draft-profile
          // observation is still in flight. This isn't only a client-side
          // bookkeeping concern — allowing two concurrent
          // submitCalibrationObservation requests for the SAME method means
          // the server could receive them out of order (a network re-order,
          // not just a client re-order), and nothing on the client can
          // guarantee which one lands last in the draft profile. Refusing to
          // start a second request until the first has settled removes the
          // race at its source instead of only reconciling client-side
          // display state after the fact.
          //
          // Also gates Skip/Un-skip (`canToggleSkip` below): a successful
          // observation can transition this method's server-side disposition
          // to `Completed` (issue #797), but `methodProgress` only learns
          // that from the refetch `writeMeasurement` kicks off once the
          // observation settles — until that refetch lands, `disposition`
          // here is stale. Blocking Skip while `syncingThisMethod` closes
          // that window instead of letting an operator skip against a
          // known-stale disposition that the server may already disagree
          // with.
          const syncingThisMethod =
            working.draftObservationPending.includes(method);
          const progress = methodProgress[method] ?? null;
          const disposition = progress?.disposition ?? 'Pending';
          const skipped = disposition === 'Skipped';
          // `done` now recognises a server-Completed disposition in addition
          // to the legacy local `completedMethods` JSON — either one is
          // sufficient, so a method not yet migrated to server-tracked
          // completion still reports done rather than perpetually locking
          // every later guided step (see `deriveGuidedMethodStates`).
          const done =
            disposition === 'Completed' ||
            working.completedMethods.includes(method);
          const skipToggleBusy = methodProgressBusyMethods.has(method);
          const canToggleSkip =
            working.calibrationProjectId !== null &&
            methodProgressStatus === 'ready' &&
            !busy &&
            !skipToggleBusy &&
            !syncingThisMethod &&
            disposition !== 'Completed';
          const dispositionLabel =
            methodProgressStatus === 'error'
              ? 'Sync failed'
              : disposition === 'Completed'
                ? 'Completed'
                : disposition === 'Skipped'
                  ? 'Skipped'
                  : 'Pending';
          // Guided order (issue #794): `guided` is `undefined` whenever
          // gating is unavailable (see `deriveGuidedMethodStates`), in which
          // case the picker renders exactly as it did before this issue —
          // every method reachable, no "Next"/"Locked" badge.
          const guided = guidedByMethod.get(method);
          const locked = guided?.locked ?? false;
          const isNext = guided?.status === 'next';
          const statusClassName =
            guided?.status === 'done'
              ? 'cal-method--done'
              : guided?.status === 'next'
                ? 'cal-method--next'
                : guided?.status === 'pending'
                  ? 'cal-method--locked'
                  : skipped
                    ? 'cal-method--skipped'
                    : '';
          return (
            <li key={method} className={statusClassName}>
              <button
                type="button"
                className="cal-button"
                onClick={() => onPickMethod(method)}
                disabled={!isActive || busy || syncingThisMethod || locked}
                aria-label={`Start ${title}${done ? ' (completed once)' : ''}${skipped ? ' (skipped)' : ''}${isNext ? ' (recommended next step)' : ''}${locked ? ' (locked — finish the earlier guided steps first)' : ''}`}
              >
                {title}
                {done ? ' — completed' : ''}
              </button>
              <p className="cal-hint">{purpose}</p>
              {syncingThisMethod ? (
                <p className="cal-hint">
                  Waiting for the previous run of this step to finish syncing to
                  the draft profile before it can be redone or its Skip status
                  changed.
                </p>
              ) : null}
              {/*
                Server-authoritative Skip/Un-skip (issue #797): distinct from
                the "— completed" suffix above, which is local-JSON-only and
                legacy. `Skipped` never blocks completion — the button stays
                enabled on a skipped step so the operator can still run it.
                `methodProgressStatus === 'error'` overrides `disposition`
                entirely here — an unreadable server state must never be
                presented as the default `Pending`.
              */}
              <span
                className="cal-method-disposition"
                aria-label={
                  methodProgressStatus === 'error'
                    ? `${title} disposition could not be read from the server`
                    : `${title} is ${dispositionLabel.toLowerCase()}`
                }
              >
                {dispositionLabel}
              </span>
              {/*
                Guided-order status (issue #794): a distinct badge from the
                disposition span above, so "next recommended" and "locked
                until an earlier guided step resolves" are structurally
                separate signals from "done/skipped/pending" rather than
                overloading the same text.
              */}
              {isNext ? (
                <span className="cal-method-guided-badge cal-method-guided-badge--next">
                  Next
                </span>
              ) : null}
              {guided?.status === 'pending' ? (
                <span className="cal-method-guided-badge cal-method-guided-badge--locked">
                  Locked
                </span>
              ) : null}
              <button
                type="button"
                className="cal-button cal-button--secondary"
                onClick={() => onToggleSkip(method)}
                disabled={!canToggleSkip}
                aria-label={`${skipped ? 'Un-skip' : 'Skip'} ${title}`}
              >
                {skipToggleBusy ? 'Saving…' : skipped ? 'Un-skip' : 'Skip'}
              </button>
              {guidance?.wikiUrl ? (
                <p className="cal-hint">
                  <a href={guidance.wikiUrl} target="_blank" rel="noreferrer">
                    OrcaSlicer wiki reference
                  </a>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="cal-actions">
        <button
          type="button"
          className="cal-button cal-button--primary"
          onClick={onFinish}
          disabled={!isActive || busy || !canFinish}
        >
          Finish calibration
        </button>
      </p>
      {!canFinish ? (
        <p className="cal-hint">
          {hasSyncFailures
            ? `${working.draftObservationFailures.length} step(s) failed to sync to the draft profile (${working.draftObservationFailures
                .map((method) => FILAMENT_METHOD_META[method].title)
                .join(
                  ', ',
                )}). Redo them before finishing, or the promoted profile will be missing those measurements.`
            : hasSyncPending
              ? `Still syncing ${working.draftObservationPending.length} step(s) to the draft profile (${working.draftObservationPending
                  .map((method) => FILAMENT_METHOD_META[method].title)
                  .join(
                    ', ',
                  )}). Wait for the sync to finish before finishing calibration.`
              : 'Complete at least one calibration step before finishing — the server promotes the accumulated draft profile into a new custom filament profile only when the project is marked complete.'}
        </p>
      ) : null}
    </fieldset>
  );
}

// --------------------------------------------------------------------------
// Four-phase per-step UI (issue #799): purpose → inputs → slice/print →
// results. `MethodStep` above is the "pick a method" screen, not one of the
// four phases itself; once a method is picked these two run before the
// existing slice/print (`SliceProgress`/`SendToPrinterStep`) and results
// (`MeasurementStep`) phases below.
// --------------------------------------------------------------------------

interface MethodPurposeStepProps {
  readonly method: CalibrationSliceMethod;
  /**
   * Server-sourced guidance for this method (issue #797), or `null` while
   * the catalog is still loading/failed — in which case this screen falls
   * back to `FILAMENT_METHOD_META`, same as `MethodStep`.
   */
  readonly guidance: CalibrationMethodGuidanceRecord | null;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}

/**
 * Phase A. Presents what this method measures and why — before the operator
 * is asked for a single input or a slice is submitted, per the acceptance
 * criterion "every step presents a purpose screen before any input or slice
 * action". Purely a confirmation screen: no network call happens here.
 */
function MethodPurposeStep(props: MethodPurposeStepProps): React.JSX.Element {
  const { method, guidance, busy, onBack, onContinue } = props;
  const meta = FILAMENT_METHOD_META[method];
  const title = guidance?.title ?? meta.title;
  const purpose = guidance?.purpose ?? meta.summary;

  return (
    <fieldset
      className="cal-step-fieldset"
      aria-label="Step 3a — purpose"
      disabled={busy}
    >
      <legend>3a. {title} — purpose</legend>
      <p>{purpose}</p>
      {guidance?.wikiUrl ? (
        <p className="cal-hint">
          <a href={guidance.wikiUrl} target="_blank" rel="noreferrer">
            OrcaSlicer wiki reference
          </a>
        </p>
      ) : null}
      <div className="cal-actions">
        <button
          type="button"
          className="cal-button"
          onClick={onBack}
          disabled={busy}
        >
          Back
        </button>
        <button
          type="button"
          className="cal-button cal-button--primary"
          onClick={onContinue}
          disabled={busy}
        >
          Continue to inputs
        </button>
      </div>
    </fieldset>
  );
}

interface MethodInputsStepProps {
  readonly method: CalibrationSliceMethod;
  readonly guidance: CalibrationMethodGuidanceRecord | null;
  readonly busy: boolean;
  readonly onBack: () => void;
  /** Called with the validated, numeric setup-input specification. */
  readonly onSubmit: (params: Readonly<Record<string, number>>) => void;
}

/**
 * Phase B. Collects the method's declared setup inputs (issue #797's
 * `getMethodGuidanceCatalog().setupInputs`) before a slice is submitted —
 * "declared inputs are collected before slicing is invoked". A method that
 * declares none (or whose guidance has not loaded yet — the catalog fetch
 * degrades gracefully, same as `MethodStep`) shows a single continue action
 * and submits with no `params`, which is the acceptance suite's control:
 * `params` must stay empty/absent for a no-input method rather than the
 * assertion on the positive case being vacuously true.
 */
function MethodInputsStep(props: MethodInputsStepProps): React.JSX.Element {
  const { method, guidance, busy, onBack, onSubmit } = props;
  const meta = FILAMENT_METHOD_META[method];
  const title = guidance?.title ?? meta.title;
  const setupInputs = guidance?.setupInputs ?? [];
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(null);
    const parsed: Record<string, number> = {};
    for (const input of setupInputs) {
      const raw = values[input.key] ?? '';
      parsed[input.key] = raw.trim() === '' ? Number.NaN : Number(raw);
    }
    // Validated with the same server-mirroring algorithm #797 shipped for
    // this exact purpose, rather than re-checking bounds ad hoc here — see
    // `validateSetupInputs`'s own docblock.
    const validationError = validateSetupInputs(setupInputs, parsed);
    if (validationError !== null) {
      const { input } = validationError;
      const unitSuffix = input.unit.length > 0 ? ` ${input.unit}` : '';
      setFormError(
        `${input.label} must be a number between ${input.minimum} and ${input.maximum}${unitSuffix}.`,
      );
      return;
    }
    onSubmit(parsed);
  };

  return (
    <fieldset
      className="cal-step-fieldset"
      aria-label="Step 3b — inputs"
      disabled={busy}
    >
      <legend>3b. {title} — inputs</legend>
      {setupInputs.length === 0 ? (
        <p className="cal-hint">
          No additional inputs are required for this step.
        </p>
      ) : null}
      <form onSubmit={submit}>
        {setupInputs.map((input) => (
          <label key={input.key}>
            {input.label} ({input.minimum}–{input.maximum}
            {input.unit.length > 0 ? ` ${input.unit}` : ''})
            <input
              type="number"
              step="any"
              value={values[input.key] ?? ''}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setValues((current) => ({
                  ...current,
                  [input.key]: event.target.value,
                }))
              }
            />
          </label>
        ))}
        {formError !== null ? (
          <p className="cal-alert" role="alert">
            {formError}
          </p>
        ) : null}
        <div className="cal-actions">
          <button
            type="button"
            className="cal-button"
            onClick={onBack}
            disabled={busy}
          >
            Back
          </button>
          <button
            type="submit"
            className="cal-button cal-button--primary"
            disabled={busy}
          >
            Start slicing
          </button>
        </div>
      </form>
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
          heat the bed and nozzle (up to {PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C}{' '}
          °C for some materials) and the toolhead will move. Make sure the bed
          is clear, the spool is loaded, and nothing is in the way of the head.
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
      // Validate by parsing the wire schema rather than re-checking a
      // literal band here, for the same reason the scalar-measurement path
      // above does: the schema is what the IPC boundary actually enforces,
      // and a hand-copied bound is how the UI and the wire drift apart (this
      // is exactly how the band went stale at 300 °C instead of PrintFarmer's
      // real `PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C`).
      const parsed = CalibrationFilamentMeasurement.safeParse({
        method: 'temperature_tower',
        nozzleTemperature: nozzle,
        nozzleTemperatureInitialLayer: initial,
      });
      if (!parsed.success) {
        setFormError(
          `Both temperatures must be integers between 150 and ${PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C} °C.`,
        );
        return;
      }
      onSubmit(parsed.data);
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
