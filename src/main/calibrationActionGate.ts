/**
 * Client-side interlock for calibration actions that mutate server state or
 * move a machine.
 *
 * ## Why this exists
 *
 * Before this module the only thing standing between a click and a
 * machine-moving request was the server's own refusal.
 * `checkOnlineActionPrerequisites` covers outbox depth, context freshness and
 * unresolved conflicts — none of which is a permission, capability or binding
 * check — and a since-removed predicate named in comments as the safety
 * interlock had zero call sites, so the protection it described never ran.
 *
 * Relying on the server alone is not fail-closed. A desktop build that
 * dispatches first and discovers it was not allowed afterwards has already sent
 * the request. Server refusal is the final defence here, never the first.
 *
 * ## What gates what, exactly
 *
 * Permissions are matched to the route each action actually calls, because
 * PrintFarmer enforces them per resource and a principal may hold one family
 * and not another:
 *
 * | Action               | Route                                   | Requires |
 * | -------------------- | --------------------------------------- | -------- |
 * | `createProject`      | calibration project create              | `calibration:create` |
 * | `updateProject`      | calibration project mutate              | `calibration:update` |
 * | `sync`               | calibration sync apply                  | `calibration:update` |
 * | `generate`           | generate-job                            | `calibration:generate` **and** `slicing:submit` |
 * | `startPrint`         | `POST /api/job-queue`                   | `queue:write` |
 * | `acknowledgeBedClear`| `{jobId}/acknowledge-bed-clear-and-start` | `queue:acknowledge-bed-clear` **and** `queue:start` |
 *
 * Every member of a requirement must be present; there is no substitution
 * between resources. Capability flags are likewise scoped to the action they
 * describe: **`calibrationGenerationEnabled` is consulted for `generate` and
 * for nothing else.** It is a switch for profile generation, and reading it as
 * a gate on print start would both refuse dispatch on deployments that simply
 * do not generate profiles and imply a protection that flag never provided.
 * Print start is gated by `queue:write`, the calibration API flag, and the
 * authoritative selected-context binding; bed-clear dispatch additionally
 * consumes a single-use main-process acknowledgement ledger.
 *
 * `calibrationArtifactPromotionEnabled` is a separate, distinct flag covering
 * promotion of a produced artifact (issue #785). It is carried on
 * {@link CalibrationCapabilityEvidence} so the evidence this gate receives is
 * complete, but this gate has no `applyPatch` action to apply it to — no
 * main-process channel dispatches profile-patch application through this
 * interlock today. The renderer's own eligibility gate
 * (`src/renderer/calibration/domain/eligibility.ts`) is what actually decides
 * `applyPatch` eligibility, and consults this flag directly rather than
 * through here.
 *
 * ## What this gate uses as evidence
 *
 * Only evidence that actually exists in the real contract:
 *
 * - **Canonical effective permissions**, exactly as the capability payload
 *   spells them in `effectivePermissions`. Never the PascalCase JWT vocabulary
 *   earlier builds asserted, which no PrintFarmer build has ever emitted.
 * - **Server capability flags** from the same negotiated payload, each applied
 *   only to the action it describes.
 * - **The selected printer's context binding** — printer, configuration
 *   revision, snapshot and tool — so an action cannot run against a snapshot
 *   other than the one the operator actually selected and saw.
 * - **A main-process bed-clear acknowledgement** for machine-moving actions,
 *   taken from a single-use ledger rather than asserted by the renderer.
 *
 * It deliberately does **not** require the absent `safety`/`permissions`
 * members of `CalibrationContextDto` for discovery, creation or generation,
 * because that would reintroduce the exact unsatisfiable predicate #715
 * removed.
 */

import {
  CALIBRATION_PERMISSIONS,
  hasCalibrationPermission,
  type CalibrationPermission,
} from '../shared/ipc.js';
import {
  isAuthoritativeCalibrationContext,
  isExplicitCalibrationContextComplete,
  type RemoteCalibrationPrinterContext,
} from './calibrationWire.js';

/** Actions this interlock guards. */
export type CalibrationGatedAction =
  /** Create a calibration project bound to a selected printer context. */
  | 'createProject'
  /** Mutate an existing calibration project. */
  | 'updateProject'
  /** Apply the local outbox to the server. */
  | 'sync'
  /**
   * Resolve a conflict returned by the server's revision check. Mutates
   * server state (accepts a server revision, records a new local revision, or
   * applies a manual field merge) but is not scoped to one printer, so it is
   * gated the same way as `sync` rather than through the printer-context
   * binding checks.
   */
  | 'resolveConflict'
  /** Request profile generation. Server-side compute; moves no machine. */
  | 'generate'
  /** Enqueue a calibration print via `POST /api/job-queue`. */
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

/**
 * Every permission each action requires, matched to the route it calls.
 *
 * All members are required. Server enforcement is per resource and exact, so a
 * principal holding `calibration:update` but not `queue:write` may record
 * results and still be refused an enqueue — and a gate that accepted one for
 * the other would send that request anyway.
 */
const REQUIRED_PERMISSIONS: Readonly<
  Record<CalibrationGatedAction, readonly CalibrationPermission[]>
> = {
  createProject: [CALIBRATION_PERMISSIONS.create],
  updateProject: [CALIBRATION_PERMISSIONS.update],
  sync: [CALIBRATION_PERMISSIONS.update],
  // Conflict resolution is an update to the calibration project/step/draft the
  // conflict names -- the same permission `sync` requires to push the outbox.
  resolveConflict: [CALIBRATION_PERMISSIONS.update],
  // Generation both records against the calibration project and submits a
  // slicing job; the server requires both, so both are required here.
  generate: [
    CALIBRATION_PERMISSIONS.generate,
    CALIBRATION_PERMISSIONS.slicingSubmit,
  ],
  // `POST /api/job-queue` is a queue write, not a calibration update.
  startPrint: [CALIBRATION_PERMISSIONS.queueWrite],
  // `acknowledge-bed-clear-and-start` enforces the latter two on the POST route
  // itself. `queue:read` is required because *this client* reads the job first,
  // to establish that it is genuinely awaiting acknowledgement before minting
  // the ledger record — an interactive or custom role can hold ack and start
  // without read, and that read must not be attempted unauthorised.
  acknowledgeBedClear: [
    CALIBRATION_PERMISSIONS.queueRead,
    CALIBRATION_PERMISSIONS.queueAcknowledgeBedClear,
    CALIBRATION_PERMISSIONS.queueStart,
  ],
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
  | 'safetyNotAssured'
  /**
   * The selected profile changed, or evidence was discarded, while this action
   * was being verified.
   *
   * Verification is not instantaneous: it awaits an authoritative context read.
   * A profile switch, a delete, or a 403-driven discard during that await leaves
   * a decision that was correct when it started and wrong by the time it
   * returns. Refusing is the only safe answer, because the alternative is
   * dispatching against a profile the operator has already moved away from.
   */
  | 'selectionChanged';

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
    /**
     * Server switch for promoting a produced calibration artifact. Distinct
     * from `calibrationGenerationEnabled`: a deployment can have slicing
     * operational (so `generate` succeeds) while promotion is unavailable.
     * Not consulted by this gate today — no `applyPatch` action is dispatched
     * through the main process yet — but carried here so capability evidence
     * stays complete and any future gated action can read it without a
     * separate plumbing change.
     */
    readonly calibrationArtifactPromotionEnabled: boolean;
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

  // Every member is required, and the first missing one is named. Reporting the
  // exact permission matters: "you may not do this" sends an operator to an
  // administrator with nothing to ask for.
  const missing = REQUIRED_PERMISSIONS[action].find(
    (permission) =>
      !hasCalibrationPermission(capability.grantedScopes, permission),
  );
  if (missing !== undefined) {
    return block(
      'permissionDenied',
      `This PrintFarmer account does not grant ${missing}, which this action requires.`,
    );
  }

  if (!capability.flags.calibrationApiEnabled) {
    return block(
      'capabilityDisabled',
      'Calibration APIs are disabled on this PrintFarmer deployment.',
    );
  }

  // Scoped to `generate` alone. This flag is the deployment's switch for profile
  // generation; applying it to print start would refuse dispatch on every farm
  // that simply does not generate profiles, and would imply the flag protects
  // machine movement, which it has never done.
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
      isAuthoritativeCalibrationContext(context)
        ? 'The selected printer context is missing identities the calibration contract requires.'
        : // Distinguished because the remedy differs. Missing identities are a
          // data problem; an unevaluated or refused context means PrintFarmer
          // has not agreed to calibrate this printer at all, and no amount of
          // retrying the action will change that.
          'PrintFarmer has not fully evaluated this printer, so this action cannot be bound to it.',
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
  if (
    binding.snapshotId !== null &&
    binding.snapshotId !== context.snapshotId
  ) {
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
