export const HOLD_CONTEXT_NAME: string;
export const HOLD_WORKFLOW_FILE: string;

export interface HoldGateBlocker {
  readonly id: 'workflow-merge-group' | 'branch-protection-context' | 'live-deadlock';
  readonly owner: string;
  readonly detail: string;
}

export interface HoldGateReadiness {
  readonly workflowReports: boolean;
  readonly contextRequired: boolean;
  readonly mergeQueueActive: boolean;
  readonly ready: boolean;
  readonly blockers: readonly HoldGateBlocker[];
}

export interface RulesetLike {
  readonly enforcement?: unknown;
  readonly target?: unknown;
  readonly name?: unknown;
}

export function evaluateHoldGateReadiness(options: {
  workflowContents: string;
  requiredContexts: readonly string[];
  rulesets?: readonly RulesetLike[];
}): HoldGateReadiness;

export function formatReadiness(result: HoldGateReadiness): string;
