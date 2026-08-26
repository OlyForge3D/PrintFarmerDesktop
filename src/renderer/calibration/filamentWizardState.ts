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

import type {
  CalibrationSliceJobStatus,
  CalibrationSliceMethod,
  FilamentWizardStateRecord,
} from '@shared/ipc';

/**
 * The three methods this build supports, ordered to match the OrcaSlicer
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
 * Of those eight categories the PrintFarmer slice pipeline implements two —
 * temperature and flow — so this list is the correct *relative* order of what
 * is available, not the whole guide. Steps 2 and 3 fall between them and are
 * simply absent; the wizard must not imply the sequence is complete.
 *
 * Temperature leads because the dependency is physical and one-way: nozzle
 * temperature changes filament viscosity and therefore how it flows, so a flow
 * ratio measured before the temperature is settled has to be measured again.
 * This list previously ran `flow_rate_pass_1` first while claiming to be in
 * wiki order; it was not, and that ordering discarded its own result.
 *
 * Flow also has more upstream than the two passes here — YOLO (Recommended)
 * and YOLO (Perfectionist). Their absence, and that of categories 2, 3 and
 * 5-8, is a server capability boundary rather than a wizard omission:
 * `Farm.Slicer.Module.Models.CalibrationMethod` declares exactly these three
 * wire names and `CalibrationMethods.TryParse` rejects anything else. See
 * PrintFarmer#2051.
 */
export const FILAMENT_WIZARD_METHODS: readonly CalibrationSliceMethod[] = [
  'temperature_tower',
  'flow_rate_pass_1',
  'flow_rate_pass_2',
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
  readonly measurementSchema: 'flowRatio' | 'temperature';
}

export const FILAMENT_METHOD_META: Record<
  CalibrationSliceMethod,
  FilamentMethodMeta
> = {
  flow_rate_pass_1: {
    method: 'flow_rate_pass_1',
    title: 'Flow rate — pass 1',
    summary:
      'Nine blocks with the flow ratio stepped from −20% to +20%. Pick the block whose top surface is smoothest, then apply the corresponding multiplier to the current flow ratio.',
    measurementPrompt:
      'Enter the corrected filament flow ratio. Multiply the current flow ratio by (1 + selected step ÷ 100). Values outside 0.5–1.5 are physically implausible for pass 1.',
    measurementSchema: 'flowRatio',
  },
  temperature_tower: {
    method: 'temperature_tower',
    title: 'Temperature tower',
    summary:
      'A tower with each block printed at a different nozzle temperature. Identify the temperature that gave the cleanest bridging, retraction, and layer adhesion.',
    measurementPrompt:
      'Enter the best-print nozzle temperature (°C) and the initial-layer nozzle temperature (°C). Both are integers in the 150–300 °C band.',
    measurementSchema: 'temperature',
  },
  flow_rate_pass_2: {
    method: 'flow_rate_pass_2',
    title: 'Flow rate — pass 2',
    summary:
      'Finer flow-ratio steps (±9%) around the value pass 1 landed on. Same selection procedure — pick the smoothest top surface, apply the multiplier.',
    measurementPrompt:
      'Enter the refined filament flow ratio. Same 0.5–1.5 physical band as pass 1.',
    measurementSchema: 'flowRatio',
  },
};

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
    completedMethods: record.completedMethods,
    currentMethod: record.currentMethod,
    inFlightJob: record.inFlightJob,
  };
}
