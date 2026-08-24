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
 * ## Restart resilience — declared gap
 *
 * `submitCalibrationSlice` returns a `jobId` and there is no
 * `listSliceJobs` verb. A crash between submit and first poll strands the
 * operator with an unpollable job. To defend against that we WOULD persist
 * the clone id, completion set, and in-flight `jobId` off the renderer.
 *
 * The renderer is presentation-only — no renderer-scoped browser
 * storage, no filesystem, no capability except Zod-validated IPC.
 * That is a repo invariant asserted by
 * `tests/calibration.workspace.test.tsx > keeps the calibration renderer
 * inside the narrow` (the forbidden-imports control).
 *
 * The existing `saveCalibrationWorkspaceState` IPC surface does NOT fit:
 * its Zod contract requires `projectId`, `printerId`-bound
 * `CalibrationWorkspacePayload`, and derived `completedStepCount /
 * totalStepCount` — all of which are printer-calibration domain concepts
 * that #750 stripped from the feature. Any attempt to encode a filament-
 * clone id inside that payload would require a schema drift Zod refuses
 * at the IPC boundary, and the persistence would then re-appear as
 * spurious "workspace" records the printer-calibration UI no longer
 * renders.
 *
 * Vasquez's brief for this task said: **"use the existing workspace-state
 * persistence if it fits, and if it does not, say so rather than working
 * around it."** So this build ships restart resilience as:
 *
 *   - **In-memory only** for the wizard's phase, current method, in-flight
 *     jobId, and completion set. Closing the wizard mid-calibration loses
 *     that state.
 *   - **Durable on the server** for the clone itself. A crashed wizard
 *     leaves the clone in place; the operator can resume by starting a
 *     fresh wizard and picking the same clone as their base — or, when
 *     that friction becomes real, we extend either the workspace-state
 *     surface to be filament-clone-aware or add a `listSliceJobs` verb.
 *
 * The gap is called out on the decision record; nothing here works
 * around the renderer-purity invariant.
 */

import type {
  CalibrationSliceJobStatus,
  CalibrationSliceMethod,
} from '@shared/ipc';

/** The three methods this build supports, in the recommended wiki order. */
export const FILAMENT_WIZARD_METHODS: readonly CalibrationSliceMethod[] = [
  'flow_rate_pass_1',
  'temperature_tower',
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
 * Persisted state shape. Currently unused at runtime — see the module
 * docblock. Kept as the target shape any future persistence surface
 * would satisfy.
 */
export interface FilamentWizardPersistedState {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly printerId: string;
  readonly printerModelId: string | null;
  readonly machineName: string;
  readonly processName: string;
  readonly baseFilamentName: string;
  readonly baseFilamentGuid: string;
  readonly cloneId: string;
  readonly cloneName: string;
  readonly completedMethods: readonly CalibrationSliceMethod[];
  readonly inFlightJob: FilamentWizardInFlightJob | null;
  readonly phase: FilamentWizardPhase;
  readonly currentMethod: CalibrationSliceMethod | null;
}

export interface FilamentWizardInFlightJob {
  readonly jobId: string;
  readonly method: CalibrationSliceMethod;
  readonly submittedAt: string;
  readonly pollAttempt: number;
  readonly lastStatus: CalibrationSliceJobStatus;
}
