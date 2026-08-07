export const verdictContext: string;
export const verdictWorkflowPath: string;

export type VerdictClassification =
  'MISSING' | 'INVALID' | 'SUPERSEDED' | 'APPROVED' | 'CHANGES_REQUESTED';

export interface VerdictResult {
  classification: VerdictClassification;
  reason: string;
  verdict?: string;
  reviewedHeadSha?: string;
  actor?: string;
  workflowRunUrl?: string;
}

export interface PullLike {
  number: number;
  user?: { login?: string };
  head?: { sha?: string };
  base?: {
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
