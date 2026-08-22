export const verdictContext: string;
export const verdictWorkflowPath: string;

export type VerdictClassification =
  | 'MISSING'
  | 'INVALID'
  | 'SUPERSEDED'
  | 'APPROVED'
  | 'REVIEWED'
  | 'CHANGES_REQUESTED'
  | 'NOT_APPLICABLE';

export interface VerdictResult {
  classification: VerdictClassification;
  reason: string;
  verdict?: string;
  reviewedHeadSha?: string;
  actor?: string;
  workflowRunUrl?: string;
  blockedReason?: string;
  carriedAcrossSync?: boolean;
}

export interface PullLike {
  number: number;
  user?: { login?: string };
  head?: { sha?: string };
  base?: {
    ref?: string;
    repo?: {
      full_name?: string;
      default_branch?: string;
    };
  };
}

export interface StatusLike {
  id?: number;
  context?: string;
  state?: string;
  sha?: string;
  description?: string;
  target_url?: string;
  creator?: { login?: string };
  created_at?: string;
}

export interface RunLike {
  id?: number;
  html_url?: string;
  path?: string;
  event?: string;
  run_attempt?: number;
  head_branch?: string;
  head_sha?: string;
  default_branch_contains_run?: boolean;
  /**
   * Only meaningful for `pull_request_review` runs, whose workflow definition
   * GitHub does NOT guarantee comes from the default branch. Computed by
   * comparing the workflow file's blob SHA at the reviewed commit against the
   * default branch's copy; must fail closed when unproven.
   */
  workflow_definition_matches_default_branch?: boolean;
  pull_requests?: unknown[];
  repository?: { full_name?: string };
  actor?: { login?: string };
  triggering_actor?: { login?: string };
  display_title?: string;
  status?: string;
  conclusion?: string;
  run_started_at?: string;
  updated_at?: string;
  created_at?: string;
}

export function bindStatusToHead(
  status: StatusLike,
  headSha: string,
): StatusLike & { sha: string };

/**
 * Process exit code for a classification. 0 only for usable merge evidence;
 * anything unrecognised falls to 3 so a future classification cannot fail open.
 */
export function exitCodeFor(classification: string | undefined): number;

export function verifySquadVerdict(input: {
  pull: PullLike;
  status?: StatusLike;
  run?: RunLike;
  comments?: Array<{ user?: { login?: string }; body?: string }>;
}): VerdictResult;

export function selectSquadVerdict(input: {
  pull: PullLike;
  statuses: StatusLike[];
  statusHeadSha?: string;
  loadRun: (runId: number) => RunLike;
}): VerdictResult;
