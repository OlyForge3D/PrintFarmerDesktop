export interface Repository {
  owner: string;
  repo: string;
}

export interface WorkflowRun {
  id: number;
  name?: string;
  run_attempt: number;
  created_at: string;
}

export interface AttemptJob {
  name?: string;
  conclusion?: string | null;
}

export interface HeadCheckRun {
  app?: { id?: number; slug?: string };
}

export interface MaskedFinding {
  runId: number;
  runName: string | undefined;
  attempt: number;
  currentAttempt: number;
  context: string;
  conclusion: string;
}

export interface ScanResult {
  findings: MaskedFinding[];
  scope: {
    headSha: string;
    requiredContexts: string[];
    runsReturned: number;
    runWindow: { earliest: string | undefined; latest: string | undefined };
    rerunRuns: number;
    attemptsExamined: {
      runId: number;
      runName: string | undefined;
      currentAttempt: number;
      superseded: number[];
    }[];
    runSignature: string[];
  };
}

export declare const EXIT_CLEAN: 0;
export declare const EXIT_FINDINGS: 1;
export declare const EXIT_UNDETERMINED: 2;

export declare function parseArgs(argv: string[]): {
  help?: boolean;
  error?: string;
  pr?: number;
  repo?: string;
};

export declare function parsePullSnapshot(
  payload: unknown,
  expectedNumber: number,
): { number: number; headSha: string; baseRef: string };

export declare function fetchPullSnapshot(input: {
  repository: Repository;
  prNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ number: number; headSha: string; baseRef: string }>;

export declare function listWorkflowRuns(input: {
  repository: Repository;
  headSha: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkflowRun[]>;

export declare function listAttemptJobs(input: {
  repository: Repository;
  runId: number;
  attempt: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<AttemptJob[]>;

export declare function listHeadCheckRuns(input: {
  repository: Repository;
  headSha: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<HeadCheckRun[]>;

export declare function githubActionsAppIds(
  checkRuns: HeadCheckRun[],
): number[];

export declare function requiredActionContexts(
  protection: {
    checks: { context: string; appId: number | null }[];
  },
  actionAppIds: Iterable<number>,
): string[];

export declare function maskedRequiredFailures(
  jobs: AttemptJob[],
  requiredContexts: Iterable<string>,
): AttemptJob[];

export declare function scanHead(input: {
  headSha: string;
  requiredContexts: Iterable<string>;
  listRuns: (headSha: string) => Promise<WorkflowRun[]>;
  listJobs: (runId: number, attempt: number) => Promise<AttemptJob[]>;
}): Promise<ScanResult>;

export declare function scanPullRequest(input: {
  repository: Repository;
  prNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<
  ScanResult & {
    pull: { number: number; headSha: string; baseRef: string };
  }
>;

export declare function formatReport(
  result: ScanResult & {
    pull: { number: number; headSha: string; baseRef: string };
  },
): string;

export declare function main(
  argv: string[],
  env?: NodeJS.ProcessEnv,
  run?: typeof import('node:child_process').spawnSync,
  fetchImpl?: typeof fetch,
): Promise<number>;
