export const MINIMUM_JUSTIFICATION_LENGTH: number;

export interface DischargeRequest {
  runId: string | number | undefined;
  headSha: string | undefined;
  justification: string | undefined;
}

export interface WorkflowRun {
  id: number;
  name: string;
  run_attempt: number;
  html_url: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

export interface FailedWorkflowJob {
  id: number;
  name: string;
  html_url: string;
  conclusion: string | null;
  steps?: Array<{
    name?: string;
    conclusion?: string | null;
  }>;
}

export function validateDischargeRequest(request: DischargeRequest): {
  runId: number;
  headSha: string;
  justification: string;
};
export function failedJobStepViolations(
  failedJobs: FailedWorkflowJob[],
): string[];
export function formatDischargeComment(input: {
  run: WorkflowRun;
  failedJobs: FailedWorkflowJob[];
  justification: string;
  actor: string;
}): string;
export function dischargeCleanupFailure(input: {
  owner: string;
  repo: string;
  token: string;
  runId: string | number | undefined;
  headSha: string | undefined;
  justification: string | undefined;
  actor: string;
  issueNumber?: number;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): Promise<{ commentUrl: string; failedJobIds: number[] }>;

/**
 * The only ref the write-capable discharge script may run from.
 */
export const DISCHARGE_REF: 'refs/heads/development';

/**
 * Throws unless `env.GITHUB_REF` is `DISCHARGE_REF`.
 *
 * Exported so the guard can be tested by calling it. It takes the environment
 * as a parameter rather than reading `process.env` itself so a test can state
 * the ref it is testing instead of mutating global state — and so the wrong-ref
 * case is reachable without a subprocess, while the subprocess tests cover the
 * separate question of whether `main` still calls it.
 */
export function assertDischargeRef(env: NodeJS.ProcessEnv): void;
