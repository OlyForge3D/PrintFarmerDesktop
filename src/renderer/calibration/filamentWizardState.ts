/**
 * State model for the filament calibration wizard.
 *
 * ## Owner directive
 *
 * The wizard implements the OrcaSlicer wiki filament calibration loop
 * (owner reframe 2026-08-23,
 * `.squad/decisions/inbox/vasquez-filament-calibration-reframe.md`).
 * The artifact calibrated is a **filament profile** — never a printer, and
 * never anything on the server side. The operator picks a base profile,
 * clones it under a spool-specific name, then repeatedly:
 *
 *     submit slice → poll → send-to-printer → measure → write-back → next
 *
 * Each write-back lands on the SAME clone. Step sequencing carries the
 * updated profile forward — a second step reads the corrected value the
 * first step wrote back. This module is what makes that observable
 * outcome inevitable rather than emergent.
 *
 * ## Restart resilience (issue #754)
 *
 * `submitCalibrationSlice` returns a `jobId` and there is no
 * `listSliceJobs` verb, so a crash between submit and first poll would
 * strand the operator with an unpollable job if nothing tracked it
 * anywhere else. PR #753 shipped the wizard with that gap: in-flight
 * state (phase, current method, in-flight `jobId`, completion set) lived
 * only in renderer memory, so an app restart mid-calibration lost the
 * bookmark even though the clone and any written-back measurements are
 * durable on the server.
 *
 * The existing `saveCalibrationWorkspaceState` IPC surface does NOT fit:
 * its Zod contract requires `projectId`, `printerId`-bound
 * `CalibrationWorkspacePayload`, and derived `completedStepCount /
 * totalStepCount` — all of which are printer-calibration domain concepts
 * that #750 stripped from the filament feature. Any attempt to encode a
 * filament-clone id inside that payload would require a schema drift Zod
 * refuses at the IPC boundary, and the persistence would then re-appear as
 * spurious "workspace" records the printer-calibration UI no longer
 * renders.
 *
 * So #754 ships an additive, filament-shaped channel pair instead
 * (`saveFilamentCalibrationWizardState` / `getFilamentCalibrationWizardState`
 * / `clearFilamentCalibrationWizardState` — see `ipc.ts`), backed by a
 * simple main-process JSON file per profile
 * (`calibrationFilamentWizardState.ts`), the same on-disk-store shape as
 * `UpdateStateStore`. The renderer stays presentation-only — no
 * renderer-scoped browser storage, no filesystem, no capability except
 * Zod-validated IPC, still asserted by
 * `tests/calibration.workspace.test.tsx > keeps the calibration renderer
 * inside the narrow` — persistence is delegated to main via the new
 * channels, exactly like every other piece of wizard state.
 *
 * `FilamentWizardPersistedState` below is the renderer-side mirror of the
 * wire `FilamentWizardStateRecord` schema. Only four phases are ever
 * persisted (`methodPicker`, `pollingSlice`, `sliceReady`,
 * `awaitingMeasurement`) — the phases where nothing is actually in flight
 * over the network. `mapPhaseForPersistence` folds every transient phase
 * (`select`, `cloneName`, `cloning`, `submittingSlice`, `sendingToPrinter`,
 * `writingBack`) onto its nearest stable predecessor before a save, so
 * "did the in-flight request land before the crash" is never a question
 * a restored record has to answer — the operator just retries the
 * interrupted step.
 */

import { PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C } from '@shared/ipc';
import type {
  CalibrationFilamentMeasurement,
  CalibrationMethodProgressDisposition,
  CalibrationSliceJobStatus,
  CalibrationSliceMethod,
  FilamentWizardStateRecord,
} from '@shared/ipc';

/**
 * The methods this build supports, ordered to match the OrcaSlicer
 * calibration guide.
 *
 * The guide's full recommended order is:
 *
 *   1. Temperature           5. Retraction
 *   2. Max volumetric speed  6. Cornering (jerk / junction deviation)
 *   3. Pressure advance      7. Input shaping
 *   4. Flow                  8. VFA
 *
 * (plus Tolerance, listed outside the numbered sequence.)
 * https://www.orcaslicer.com/wiki/guides/calibration_guide
 *
 * Of those eight categories this list now covers five: temperature (1), max
 * volumetric speed (2), pressure advance (3), flow (4) and retraction (5), in
 * exactly that order.
 *
 * Categories 6-8 (cornering, input shaping, VFA) are deliberately excluded and
 * are not coming: they are *machine* calibrations whose results are firmware
 * motion settings, and this wizard's only output is a patched filament profile,
 * so there is nowhere to write them. See #786 and OlyForge3D/PrintFarmer#2162.
 *
 * Temperature leads because the dependency is physical and one-way: nozzle
 * temperature changes filament viscosity and therefore how it flows, so a flow
 * ratio measured before the temperature is settled has to be measured again.
 * This list previously ran `flow_rate_pass_1` first while claiming to be in
 * wiki order; it was not, and that ordering discarded its own result.
 *
 * Within flow (4) upstream offers four entries, all present here: YOLO
 * (Recommended) and YOLO (Perfectionist) — the current method — plus the legacy
 * Pass 1 / Pass 2 pair, kept because operators mid-workflow depend on them.
 * They are alternatives, not a sequence: the wizard's `methodPicker` phase
 * offers this list and the operator chooses one per round. Recommended is
 * listed before the legacy passes because it is the default choice.
 *
 * Pressure advance is Tower only. PA Line and PA Pattern stay unsupported
 * upstream on licensing grounds (GPL-3.0 provenance and vendor-specific
 * respectively), so the summary names the variant rather than "pressure
 * advance" generally.
 */
export const FILAMENT_WIZARD_METHODS: readonly CalibrationSliceMethod[] = [
  'temperature_tower',
  'max_volumetric_speed',
  'pressure_advance_tower',
  'flow_rate_yolo_recommended',
  'flow_rate_yolo_perfectionist',
  'flow_rate_pass_1',
  'flow_rate_pass_2',
  'retraction',
];

/**
 * Human-readable metadata for each method — used by the wizard for
 * dropdown labels, per-method measurement guidance, and the input schema
 * the operator fills in after the print completes.
 *
 * The measurement guidance is drawn from the OrcaSlicer wiki calibration
 * pages. It stays short and directional: the operator is expected to have
 * the wiki open anyway; the wizard's job is to be the workflow bookkeeper,
 * not the tutorial.
 */
export interface FilamentMethodMeta {
  readonly method: CalibrationSliceMethod;
  readonly title: string;
  readonly summary: string;
  readonly measurementPrompt: string;
  readonly measurementSchema: FilamentMeasurementSchema;
}

/**
 * Which physical quantity a method's measurement step collects.
 *
 * Everything except `temperature` is a single bounded number, which is why the
 * measurement step renders them from one generic branch rather than one branch
 * per method — the shape that made every earlier method addition touch the
 * component.
 */
export type FilamentMeasurementSchema =
  | 'flowRatio'
  | 'temperature'
  | 'maxVolumetricSpeed'
  | 'pressureAdvance'
  | 'retractionLength';

/**
 * Presentation for a single-value measurement.
 *
 * `min`/`max` here are for the operator-facing label and nothing else —
 * enforcement is the wire schema's job, and the measurement step validates by
 * parsing through `CalibrationFilamentMeasurement` rather than re-checking
 * these numbers. `filamentCalibrationMethodOrder.test.ts` asserts the two
 * agree at both edges, so a label that drifts from the enforced band fails
 * rather than misleading the operator.
 */
export interface ScalarMeasurementSpec {
  /** Property name on the wire measurement branch. */
  readonly field:
    | 'filamentFlowRatio'
    | 'maxVolumetricSpeed'
    | 'pressureAdvance'
    | 'retractionLength';
  readonly label: string;
  readonly ariaLabel: string;
  readonly step: string;
  readonly min: number;
  readonly max: number;
  /** Shown when the entered value falls outside the band. */
  readonly rangeMessage: string;
}

export const SCALAR_MEASUREMENT_SPECS: Readonly<
  Record<
    Exclude<FilamentMeasurementSchema, 'temperature'>,
    ScalarMeasurementSpec
  >
> = {
  flowRatio: {
    field: 'filamentFlowRatio',
    label: 'Corrected filament flow ratio (0.5–1.5)',
    ariaLabel: 'Flow ratio',
    step: '0.001',
    min: 0.5,
    max: 1.5,
    rangeMessage:
      'The flow ratio must be between 0.5 and 1.5 — values outside that band are physically implausible.',
  },
  maxVolumetricSpeed: {
    field: 'maxVolumetricSpeed',
    label: 'Observed maximum volumetric speed (1–60 mm³/s)',
    ariaLabel: 'Maximum volumetric speed',
    step: '0.1',
    min: 1,
    max: 60,
    rangeMessage:
      'The maximum volumetric speed must be between 1 and 60 mm³/s. The slicing-time ceiling is 50 mm³/s; the band allows a little above it for filaments that tolerate more.',
  },
  pressureAdvance: {
    field: 'pressureAdvance',
    label: 'Pressure advance coefficient (0.0–2.0)',
    ariaLabel: 'Pressure advance',
    step: '0.001',
    min: 0,
    max: 2,
    rangeMessage:
      'The pressure advance coefficient must be between 0.0 and 2.0.',
  },
  retractionLength: {
    field: 'retractionLength',
    label: 'Retraction length (0–10 mm)',
    ariaLabel: 'Retraction length',
    step: '0.05',
    min: 0,
    max: 10,
    rangeMessage: 'The retraction length must be between 0 and 10 mm.',
  },
};

/** The scalar spec for a schema, or `null` for the two-field temperature case. */
export function scalarSpecFor(
  schema: FilamentMeasurementSchema,
): ScalarMeasurementSpec | null {
  return schema === 'temperature' ? null : SCALAR_MEASUREMENT_SPECS[schema];
}

export const FILAMENT_METHOD_META: Record<
  CalibrationSliceMethod,
  FilamentMethodMeta
> = {
  flow_rate_pass_1: {
    method: 'flow_rate_pass_1',
    title: 'Flow rate — pass 1',
    summary:
      'Legacy two-pass method, kept for continuity — prefer YOLO (Recommended) for new work. Nine blocks with the flow ratio stepped from −20% to +20%. Pick the block whose top surface is smoothest, then apply the corresponding multiplier to the current flow ratio.',
    measurementPrompt:
      'Enter the corrected filament flow ratio. Multiply the current flow ratio by (1 + selected step ÷ 100). Values outside 0.5–1.5 are physically implausible for pass 1.',
    measurementSchema: 'flowRatio',
  },
  flow_rate_yolo_recommended: {
    method: 'flow_rate_yolo_recommended',
    title: 'Flow rate — YOLO (Recommended)',
    summary:
      'The current OrcaSlicer flow method and the default choice: a single print that resolves the flow ratio in one pass, with no second print to centre. Pick the band with the smoothest top surface and apply its modifier. Use this unless you have a specific reason not to.',
    measurementPrompt:
      'Enter the corrected filament flow ratio — the current ratio adjusted by the selected band modifier. Values outside 0.5–1.5 are physically implausible.',
    measurementSchema: 'flowRatio',
  },
  flow_rate_yolo_perfectionist: {
    method: 'flow_rate_yolo_perfectionist',
    title: 'Flow rate — YOLO (Perfectionist)',
    summary:
      'A finer sweep than Recommended, in smaller steps. Run it after Recommended to squeeze out the remaining error — it refines that result rather than replacing it, so running it alone wastes the finer resolution.',
    measurementPrompt:
      'Enter the refined filament flow ratio from the finer sweep. Same 0.5–1.5 physical band as Recommended.',
    measurementSchema: 'flowRatio',
  },
  temperature_tower: {
    method: 'temperature_tower',
    title: 'Temperature tower',
    summary:
      'A tower with each block printed at a different nozzle temperature. Identify the temperature that gave the cleanest bridging, retraction, and layer adhesion.',
    measurementPrompt:
      'Enter the best-print nozzle temperature (°C) and the initial-layer nozzle temperature (°C). ' +
      `Both are integers between 150 and ${PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C} °C.`,
    measurementSchema: 'temperature',
  },
  flow_rate_pass_2: {
    method: 'flow_rate_pass_2',
    title: 'Flow rate — pass 2',
    summary:
      'Second half of the legacy two-pass method — finer flow-ratio steps (±9%) around the value pass 1 landed on. Same selection procedure. Prefer YOLO (Perfectionist) for new work.',
    measurementPrompt:
      'Enter the refined filament flow ratio. Same 0.5–1.5 physical band as pass 1.',
    measurementSchema: 'flowRatio',
  },
  max_volumetric_speed: {
    method: 'max_volumetric_speed',
    title: 'Max volumetric speed',
    summary:
      'A tower whose extrusion rate climbs with height, printed with the flow ceiling lifted so the slicer does not clamp the sweep. Find the height where extrusion first degrades and read off the rate below it.',
    measurementPrompt:
      'Enter the highest volumetric speed that still extruded cleanly, in mm³/s. The band is 1–60; the slice itself runs against a 50 mm³/s ceiling.',
    measurementSchema: 'maxVolumetricSpeed',
  },
  pressure_advance_tower: {
    method: 'pressure_advance_tower',
    title: 'Pressure advance — tower',
    summary:
      'A tower stepping the pressure-advance coefficient per band, emitted as Klipper SET_PRESSURE_ADVANCE or Marlin M900 K. Pick the band with the sharpest corners and least bulging. Tower only — PA Line and PA Pattern are not available upstream.',
    measurementPrompt:
      'Enter the pressure advance coefficient from the best band (0.0–2.0). Saving also enables pressure advance on the profile, since a coefficient alone leaves it switched off.',
    measurementSchema: 'pressureAdvance',
  },
  retraction: {
    method: 'retraction',
    title: 'Retraction',
    summary:
      'A tower stepping retraction length per band. Pick the shortest length that still leaves no stringing between the towers — longer is not better, and over-retraction causes its own defects.',
    measurementPrompt:
      'Enter the chosen retraction length in millimetres (0–10). This is written as a per-filament override, not to the machine profile.',
    measurementSchema: 'retractionLength',
  },
};

/**
 * The methods whose measurement is a flow ratio, derived from the wire union
 * rather than listed. A flow method added to `CalibrationFilamentMeasurement`
 * joins this automatically, so no call site has to be found and updated.
 */
export type FlowRatioMethod = Extract<
  CalibrationFilamentMeasurement,
  { filamentFlowRatio: number }
>['method'];

/**
 * Narrowing predicate for "does this method measure a flow ratio".
 *
 * The runtime answer comes from the method catalogue and the *type* comes from
 * the wire union, so the two are independent sources that must agree.
 * `filamentCalibrationMethodOrder.test.ts` asserts they do, in both directions
 * — a metadata entry that disagrees with the schema becomes a test failure
 * rather than an input that silently asks the operator for the wrong quantity.
 *
 * Call sites must use this rather than comparing against method literals: the
 * literal form is what caused every flow method added after the original two
 * to fall through to the temperature branch.
 */
export function isFlowRatioMethod(
  method: CalibrationSliceMethod,
): method is FlowRatioMethod {
  return FILAMENT_METHOD_META[method].measurementSchema === 'flowRatio';
}

/**
 * Guided-sequence status the picker renders for a single method (issue
 * #794). This is layered ON TOP of the existing per-method disposition
 * (Pending/Skipped/Completed, issue #797) rather than replacing it — the
 * disposition label keeps rendering exactly as before, and `status` here
 * only adds the "which one is recommended/locked right now" dimension.
 *
 * - `done` — resolved, either via a server-authoritative `Completed`
 *   disposition or the legacy local `completedMethods` JSON. Kept reachable
 *   (never locked) so the operator can rerun a step.
 * - `skipped` — server-authoritative `Skipped` disposition (issue #797).
 *   Also never locked — skipping never blocks completion.
 * - `next` — the first method in `FILAMENT_WIZARD_METHODS` order that is
 *   neither done nor skipped. The one the operator is recommended to run.
 * - `pending` — unresolved, but not `next` — an earlier method in guided
 *   order is still unresolved, so this one locks until that resolves.
 */
export type GuidedMethodStatus = 'done' | 'skipped' | 'next' | 'pending';

export interface GuidedMethodState {
  readonly method: CalibrationSliceMethod;
  readonly status: GuidedMethodStatus;
  /**
   * Whether the picker should block starting this method right now. Only a
   * `pending` (non-`next`) method locks; `done` and `skipped` methods stay
   * reachable, matching the "skip never blocks completion" rule #797
   * shipped and the same rerun affordance a completed step already has.
   */
  readonly locked: boolean;
}

/**
 * Derives the guided order's per-method status from server-authoritative
 * progress (issue #797) plus the legacy local `completedMethods` set, so a
 * method not yet migrated to server-tracked completion still reports as
 * `done` rather than perpetually blocking every method after it.
 *
 * Returns `null` — meaning "do not gate anything" — when the caller has no
 * trustworthy server state to gate against: no `CalibrationProject` yet, or
 * the last `getMethodProgress` read failed/is still loading. Locking against
 * stale or absent data would either strand a first-run operator with no
 * project yet, or make a step someone else resolved on a different device
 * look falsely locked. A `null` result is exactly the local-JSON-only,
 * ungated behaviour this issue requires to keep working in parallel for
 * methods/projects not yet on the server-authoritative path.
 */
export function deriveGuidedMethodStates(
  methods: readonly CalibrationSliceMethod[],
  options: {
    readonly completedMethods: readonly CalibrationSliceMethod[];
    readonly dispositionFor: (
      method: CalibrationSliceMethod,
    ) => CalibrationMethodProgressDisposition | null;
    readonly gatingAvailable: boolean;
  },
): readonly GuidedMethodState[] | null {
  if (!options.gatingAvailable) return null;

  const completedLocally = new Set(options.completedMethods);
  let nextAssigned = false;
  return methods.map((method) => {
    const disposition = options.dispositionFor(method);
    const done = disposition === 'Completed' || completedLocally.has(method);
    if (done) return { method, status: 'done', locked: false };
    const skipped = disposition === 'Skipped';
    if (skipped) return { method, status: 'skipped', locked: false };
    if (!nextAssigned) {
      nextAssigned = true;
      return { method, status: 'next', locked: false };
    }
    return { method, status: 'pending', locked: true };
  });
}

/**
 * Where the operator is in the loop right now. The wizard is a linear
 * state machine, so this is a small enum rather than a general graph.
 */
export type FilamentWizardPhase =
  /** Step 0. Base profile + machine + process + printer picking. */
  | 'select'
  /** Step 1. Operator has picked; entering a name for the clone. */
  | 'cloneName'
  /** Cloning in flight. */
  | 'cloning'
  /** Step 2. Clone exists; pick the next method. */
  | 'methodPicker'
  /** Submitting the slice job. */
  | 'submittingSlice'
  /** Step 3. Polling the slice job for a terminal status. */
  | 'pollingSlice'
  /** Step 4. Slice completed; presenting the send-to-printer confirmation. */
  | 'sliceReady'
  /** Sending to printer. */
  | 'sendingToPrinter'
  /** Step 5. Print sent; asking the operator to measure. */
  | 'awaitingMeasurement'
  /** Writing measurement back onto the clone. */
  | 'writingBack';

/**
 * Renderer-side alias of the wire `FilamentWizardStateRecord` schema
 * (`ipc.ts`) — kept as a distinct name here so call sites in the wizard
 * read as "the persisted record" rather than "a Zod-inferred wire type".
 * Built from `WizardWorkingState` by `buildPersistedState` once `cloneId`
 * exists, and turned back into a partial working state on mount by
 * `restoredWorkingState`.
 */
export type FilamentWizardPersistedState = FilamentWizardStateRecord;

export interface FilamentWizardInFlightJob {
  readonly jobId: string;
  readonly method: CalibrationSliceMethod;
  readonly submittedAt: string;
  readonly pollAttempt: number;
  readonly lastStatus: CalibrationSliceJobStatus;
}

/**
 * The subset of `WizardWorkingState` (defined in
 * `FilamentCalibrationWizard.tsx`) that persistence cares about, plus the
 * profile-selection fields it needs to fold in. Kept as a separate shape
 * here (rather than importing `WizardWorkingState`) to avoid a circular
 * import between the component and this state module.
 */
export interface FilamentWizardWorkingSnapshot {
  readonly phase: FilamentWizardPhase;
  readonly printerId: string | null;
  readonly printerModelId: string | null;
  readonly machineName: string | null;
  readonly processName: string | null;
  readonly baseFilamentName: string | null;
  readonly baseFilamentGuid: string | null;
  readonly cloneId: string | null;
  readonly cloneName: string;
  /**
   * The server `CalibrationProject` created at wizard start (issue #798),
   * used to scope method-guidance/method-progress calls (issue #797). `null`
   * before the clone step runs, or if creation was skipped/failed and the
   * wizard proceeded without one (see `performClone`).
   */
  readonly calibrationProjectId: string | null;
  readonly completedMethods: readonly CalibrationSliceMethod[];
  readonly currentMethod: CalibrationSliceMethod | null;
  readonly inFlightJob: FilamentWizardInFlightJob | null;
}

/**
 * The four phases a restored wizard may resume into. A transient
 * (in-flight-network) phase folds onto its nearest stable predecessor;
 * the pre-clone phases (`select`, `cloneName`, `cloning`) have nothing to
 * resume into yet and return `null`.
 */
export function mapPhaseForPersistence(
  phase: FilamentWizardPhase,
):
  | 'methodPicker'
  | 'pollingSlice'
  | 'sliceReady'
  | 'awaitingMeasurement'
  | null {
  switch (phase) {
    case 'select':
    case 'cloneName':
    case 'cloning':
      return null;
    case 'submittingSlice':
      return 'methodPicker';
    case 'sendingToPrinter':
      return 'sliceReady';
    case 'writingBack':
      return 'awaitingMeasurement';
    case 'methodPicker':
    case 'pollingSlice':
    case 'sliceReady':
    case 'awaitingMeasurement':
      return phase;
  }
}

/**
 * Builds the record to persist for the current working state, or `null`
 * when there is nothing worth persisting yet (before the clone exists, or
 * the profile-selection fields the clone step resolved are not all
 * populated — which in practice only happens transiently during the
 * `select`/`cloneName`/`cloning` phases this never gets called for).
 *
 * `submittingSlice` folds to `methodPicker` and drops `currentMethod` /
 * `inFlightJob` — the submit never got a `jobId` back, so there is nothing
 * about that attempt worth resuming; the operator just picks the method
 * again.
 */
export function buildPersistedState(
  snapshot: FilamentWizardWorkingSnapshot,
  nowIso: string,
): FilamentWizardPersistedState | null {
  const stablePhase = mapPhaseForPersistence(snapshot.phase);
  if (
    stablePhase === null ||
    snapshot.cloneId === null ||
    snapshot.printerId === null ||
    snapshot.machineName === null ||
    snapshot.processName === null ||
    snapshot.baseFilamentName === null ||
    snapshot.baseFilamentGuid === null
  ) {
    return null;
  }
  const submitNeverLanded = snapshot.phase === 'submittingSlice';
  return {
    schemaVersion: 1,
    printerId: snapshot.printerId,
    printerModelId: snapshot.printerModelId,
    machineName: snapshot.machineName,
    processName: snapshot.processName,
    baseFilamentName: snapshot.baseFilamentName,
    baseFilamentGuid: snapshot.baseFilamentGuid,
    cloneId: snapshot.cloneId,
    cloneName: snapshot.cloneName,
    calibrationProjectId: snapshot.calibrationProjectId,
    completedMethods: [...snapshot.completedMethods],
    currentMethod: submitNeverLanded ? null : snapshot.currentMethod,
    inFlightJob: submitNeverLanded ? null : snapshot.inFlightJob,
    phase: stablePhase,
    updatedAt: nowIso,
  };
}

/**
 * The fields `restoredWorkingState` reconstructs from a persisted record
 * — a partial `WizardWorkingState` the wizard merges over `initialWorking`
 * on mount, plus the reconstructed `ProfileSelectionSnapshot` the picker
 * step needs so a subsequent `beginMethod` call still has a
 * `machineProfileName` / `processProfileName` to submit with.
 */
export interface RestoredFilamentWizardState {
  readonly phase: FilamentWizardPhase;
  readonly picks: {
    readonly machineName: string;
    readonly processName: string;
    readonly filamentName: string;
    readonly filamentGuid: string;
    readonly filamentOrigin: 'custom';
    readonly readyForClone: true;
  };
  readonly printerId: string;
  readonly printerModelId: string | null;
  readonly cloneId: string;
  readonly cloneName: string;
  readonly calibrationProjectId: string | null;
  readonly completedMethods: readonly CalibrationSliceMethod[];
  readonly currentMethod: CalibrationSliceMethod | null;
  readonly inFlightJob: FilamentWizardInFlightJob | null;
}

export function restoredWorkingState(
  record: FilamentWizardPersistedState,
): RestoredFilamentWizardState {
  return {
    phase: record.phase,
    picks: {
      machineName: record.machineName,
      processName: record.processName,
      filamentName: record.baseFilamentName,
      filamentGuid: record.baseFilamentGuid,
      filamentOrigin: 'custom',
      readyForClone: true,
    },
    printerId: record.printerId,
    printerModelId: record.printerModelId,
    cloneId: record.cloneId,
    cloneName: record.cloneName,
    calibrationProjectId: record.calibrationProjectId,
    completedMethods: record.completedMethods,
    currentMethod: record.currentMethod,
    inFlightJob: record.inFlightJob,
  };
}

// --- Server-authoritative setup-input validation (issue #797) --------------
//
// `CalibrationMethodGuidanceCatalog.ValidateSetupInputs` (PrintFarmer,
// `Farm.Modules.Calibration.Services.Calibration.CalibrationMethodClassification`,
// verified at commit `b6a754c989e76edd71891e632bd940f1a81f3918`) is the
// server's authoritative gate: for each setup input a method declares, the
// operator-supplied specification must carry a finite number at that input's
// `key`, within `[minimum, maximum]` inclusive. It runs server-side inside
// `CreateAttemptAsync` (`POST /api/calibration-projects/{id}/attempts`) — a
// route the desktop does not call anywhere yet (slice submission goes
// through the unrelated `SliceJobController` path). `validateSetupInputs`
// below is a client-side mirror of that same algorithm: plumbing for a
// setup-collection UI that does not exist yet (that's issue #799's job), so
// an operator gets the same rejection reasoning inline instead of only
// discovering an out-of-range value after a round trip once #799 wires a
// submission path through it.
//
// Deliberately independent of `ScalarMeasurementSpec` — that describes the
// *measurement* step's client-owned bands (`SCALAR_MEASUREMENT_SPECS`), a
// different phase of the wizard than the *setup* inputs a method's server
// guidance record declares here.

/** Renderer-side mirror of `CalibrationMethodSetupInput` (see `shared/ipc.ts`). */
export interface CalibrationGuidanceSetupInput {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly minimum: number;
  readonly maximum: number;
}

/** Mirrors the three rejection codes `ValidateSetupInputs` returns server-side. */
export type SetupInputValidationErrorCode =
  'setup_input_missing' | 'setup_input_invalid' | 'setup_input_out_of_range';

export interface SetupInputValidationError {
  readonly code: SetupInputValidationErrorCode;
  readonly input: CalibrationGuidanceSetupInput;
}

/**
 * Validates a setup-input specification against a method's declared inputs,
 * mirroring `CalibrationMethodGuidanceCatalog.ValidateSetupInputs` exactly:
 * for each declared input, `specification[input.key]` must be a finite
 * number within `[input.minimum, input.maximum]` inclusive. Returns the
 * first failing input (server semantics evaluate in declaration order and
 * return on first failure) or `null` if every declared input passes — or if
 * the method declares none.
 */
export function validateSetupInputs(
  setupInputs: readonly CalibrationGuidanceSetupInput[],
  specification: Readonly<Record<string, unknown>>,
): SetupInputValidationError | null {
  for (const input of setupInputs) {
    if (!Object.hasOwn(specification, input.key)) {
      return { code: 'setup_input_missing', input };
    }
    const value = specification[input.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { code: 'setup_input_invalid', input };
    }
    if (value < input.minimum || value > input.maximum) {
      return { code: 'setup_input_out_of_range', input };
    }
  }
  return null;
}
