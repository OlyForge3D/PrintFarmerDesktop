/**
 * Client-side interlock for calibration actions that mutate server state or
 * move a machine.
 *
 * ## Why this exists
 *
 * The merged discovery fix (#715) correctly stopped requiring `safety` and
 * `permissions` from `CalibrationContextDto` — PrintFarmer has never published
 * either member, so requiring them made every real context incomplete and
 * silently disabled profile listing rather than gating anything.
 *
 * What that fix left behind was a gap it described in prose but never closed.
 * It stated that generate and print start "stay gated by
 * `isCalibrationContextSafetyAssured` and the server capability flags", but
 * {@link isCalibrationContextSafetyAssured} had *zero* call sites: nothing in
 * the product ever invoked it. `checkOnlineActionPrerequisites` covers outbox
 * depth, context freshness and unresolved conflicts, none of which is a
 * permission, capability or binding check. So the only thing standing between a
 * click and a machine-moving request was the server's own refusal.
 *
 * Relying on the server alone is not fail-closed. A desktop build that dispatches
 * first and discovers it was not allowed afterwards has already sent the request.
 *
 * ## What this gate uses as evidence
 *
 * Only evidence that actually exists in the real contract:
 *
 * - **Canonical effective permissions.** `calibration:read` / `:create` /
 *   `:update` / `:generate`, exactly as the capability payload spells them in
 *   `effectivePermissions`. Never the PascalCase JWT vocabulary earlier builds
 *   asserted, which no PrintFarmer build has ever emitted.
 * - **Server capability flags** from the same negotiated payload.
 * - **The selected printer's context binding** — printer, configuration
 *   revision, snapshot and tool — so an action cannot run against a snapshot
 *   other than the one the operator actually selected and saw.
 * - **A main-process bed-clear acknowledgement** for machine-moving actions,
 *   taken from a single-use ledger rather than asserted by the renderer.
 *
 * It deliberately does **not** require the absent `safety`/`permissions`
 * members for discovery, creation or generation, because that would reintroduce
 * the exact unsatisfiable predicate #715 removed.
 */

import {
  CALIBRATION_PERMISSIONS,
  hasCalibrationPermission,
  type CalibrationPermission,
} from '../shared/ipc.js';
import {
  isExplicitCalibrationContextComplete,
  type RemoteCalibrationPrinterContext,
} from './calibrationWire.js';

/** Actions this interlock guards. */
export type CalibrationGatedAction =
  /** Create a calibration project bound to a selected printer context. */
  | 'createProject'
  /** Request profile generation. Server-side compute; moves no machine. */
  | 'generate'
  /** Enqueue a calibration print. Leads to machine movement once dispatched. */
  | 'startPrint'
  /** Acknowledge bed-clear and release a queued job for dispatch. */
  | 'acknowledgeBedClear';

/** Machine-moving actions require ledger-backed operator acknowledgement. */
const MACHINE_MOVING_ACTIONS: ReadonlySet<CalibrationGatedAction> = new Set([
  // Enqueuing is deliberately absent. `createQueueJob` places a job in the
  // queue; it is `acknowledge-bed-clear-and-start` that releases it for
  // dispatch, and that is the call after which a machine actually moves.
  // Requiring a bed-clear acknowledgement to *enqueue* would be unsatisfiable,
  // because the job the operator acknowledges does not exist until enqueue has
  // already succeeded.
  'acknowledgeBedClear',
]);

/** The exact canonical permission each action requires. */
const REQUIRED_PERMISSION: Readonly<
  Record<CalibrationGatedAction, CalibrationPermission>
> = {
  createProject: CALIBRATION_PERMISSIONS.create,
  generate: CALIBRATION_PERMISSIONS.generate,
  startPrint: CALIBRATION_PERMISSIONS.update,
  acknowledgeBedClear: CALIBRATION_PERMISSIONS.update,
};

export type CalibrationGateBlockCode =
  /** Capability was never negotiated, so nothing has been authorised. */
  | 'capabilityUnknown'
  /** The account lacks the exact canonical permission this action needs. */
  | 'permissionDenied'
  /** The server has the feature switched off for this deployment. */
  | 'capabilityDisabled'
  /** No selected printer context is available to bind the action to. */
  | 'contextUnavailable'
  /** The context lacks identities the calibration contract defines. */
  | 'contextIncomplete'
  /** The server marked the snapshot superseded. */
  | 'contextStale'
  /** The action names a printer, revision, snapshot or tool the context does not. */
  | 'bindingMismatch'
  /** A machine-moving action with neither operator nor server safety evidence. */
  | 'safetyNotAssured';

export interface CalibrationGateResult {
  readonly allowed: boolean;
  readonly code: CalibrationGateBlockCode | null;
  /** Operator-facing explanation. Never contains credentials, paths or URLs. */
  readonly message: string | null;
}

const ALLOWED: CalibrationGateResult = {
  allowed: true,
  code: null,
  message: null,
};

function block(
  code: CalibrationGateBlockCode,
  message: string,
): CalibrationGateResult {
  return { allowed: false, code, message };
}

/** The binding an action claims to act against. */
export interface CalibrationActionBinding {
  readonly printerId: string;
  readonly configurationRevision: number | null;
  readonly snapshotId: string | null;
  readonly toolId: string | null;
}

/**
 * Negotiated capability evidence. Structurally minimal on purpose so the gate
 * can be exercised directly in tests without standing up a whole diagnostics
 * recorder, and so it cannot read anything it has no business reading.
 */
export interface CalibrationCapabilityEvidence {
  readonly grantedScopes: readonly string[] | null;
  readonly flags: {
    readonly calibrationApiEnabled: boolean;
    readonly calibrationGenerationEnabled: boolean;
    readonly [flag: string]: boolean;
  };
}

export interface CalibrationGateInput {
  readonly action: CalibrationGatedAction;
  /** Null when capability negotiation has not happened or failed. */
  readonly capability: CalibrationCapabilityEvidence | null;
  /** The authoritative context for the selected printer. */
  readonly context: RemoteCalibrationPrinterContext | null;
  /** What the action claims to act on. */
  readonly binding: CalibrationActionBinding | null;
  /**
   * Whether a live, single-use bed-clear acknowledgement was found in the
   * main-process ledger for this exact binding.
   *
   * Supplied by the caller after consuming it, never by the renderer. Only
   * consulted for machine-moving actions.
   */
  readonly operatorAcknowledgement?: boolean;
}

/**
 * Decide whether one calibration action may proceed.
 *
 * Fail-closed at every branch: missing evidence blocks. The order matters only
 * for the quality of the message; any single failing check refuses.
 */
export function evaluateCalibrationActionGate(
  input: CalibrationGateInput,
): CalibrationGateResult {
  const { action, capability, context, binding } = input;

  if (capability === null) {
    return block(
      'capabilityUnknown',
      'PrintFarmer capabilities have not been negotiated, so this action is not authorised.',
    );
  }

  const permission = REQUIRED_PERMISSION[action];
  if (!hasCalibrationPermission(capability.grantedScopes, permission)) {
    return block(
      'permissionDenied',
      `This PrintFarmer account does not grant ${permission}, which this action requires.`,
    );
  }

  if (!capability.flags.calibrationApiEnabled) {
    return block(
      'capabilityDisabled',
      'Calibration APIs are disabled on this PrintFarmer deployment.',
    );
  }

  if (action === 'generate' && !capability.flags.calibrationGenerationEnabled) {
    return block(
      'capabilityDisabled',
      'Profile generation is not enabled on this PrintFarmer deployment.',
    );
  }

  if (context === null) {
    return block(
      'contextUnavailable',
      'No printer context is loaded for the selected printer, so this action cannot be bound to a snapshot.',
    );
  }

  if (!isExplicitCalibrationContextComplete(context)) {
    return block(
      'contextIncomplete',
      'The selected printer context is missing identities the calibration contract requires.',
    );
  }

  if (!context.isCurrent) {
    return block(
      'contextStale',
      'The selected printer context has been superseded. Refresh it before continuing.',
    );
  }

  if (binding === null) {
    return block(
      'bindingMismatch',
      'This action names no printer binding, so it cannot be verified against the selected context.',
    );
  }

  // Selection fencing and action fencing share this comparison deliberately.
  // A response accepted for printer A must never authorise an action on B, and
  // an action pinned to a revision the operator never saw is not the action the
  // operator agreed to.
  if (binding.printerId !== context.printerId) {
    return block(
      'bindingMismatch',
      'This action targets a different printer than the loaded context.',
    );
  }
  if (
    binding.configurationRevision !== null &&
    binding.configurationRevision !== context.configurationRevision
  ) {
    return block(
      'bindingMismatch',
      'The printer configuration changed after this action was prepared. Reload the printer context.',
    );
  }
  if (binding.snapshotId !== null && binding.snapshotId !== context.snapshotId) {
    return block(
      'bindingMismatch',
      'This action references a printer snapshot that is no longer current.',
    );
  }
  if (
    binding.toolId !== null &&
    !context.toolheads.some((toolhead) => toolhead.toolId === binding.toolId)
  ) {
    return block(
      'bindingMismatch',
      'The selected tool is not present on the printer in the loaded context.',
    );
  }

  if (MACHINE_MOVING_ACTIONS.has(action)) {
    // The only acceptable evidence is a main-process ledger record, minted after
    // main itself observed the server reporting this job as awaiting a bed-clear
    // acknowledgement. `context.safety` is deliberately *not* consulted:
    // `CalibrationContextDto` has no safety member, so a server assurance is
    // never present, and writing `serverAssured || operatorSaidSo` produced a
    // condition whose first half was permanently false and whose second half was
    // a boolean the gated party supplied about itself.
    if (input.operatorAcknowledgement !== true) {
      return block(
        'safetyNotAssured',
        'No current operator confirmation that the machine is clear was recorded for this job, so it cannot be dispatched.',
      );
    }
  }

  return ALLOWED;
}
