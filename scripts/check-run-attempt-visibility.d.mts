import type {
  Repository,
  WorkflowRun,
} from './check-rerun-masked-failures.mjs';

export declare const EXIT_CLEAN: 0;
export declare const EXIT_FINDINGS: 1;
export declare const EXIT_UNDETERMINED: 2;

export declare function parseArgs(argv: string[]): {
  help?: boolean;
  error?: string;
  sha?: string;
  pr?: number;
  repo?: string;
};

export declare function maxRunAttempt(runs: WorkflowRun[]): number;

export declare function resolveHeadSha(input: {
  args: { sha?: string; pr?: number };
  repository: Repository;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ headSha: string; source: string }>;

export declare function verifyHeadStillCurrent(input: {
  args: { sha?: string; pr?: number };
  repository: Repository;
  token: string;
  fetchImpl?: typeof fetch;
  headSha: string;
}): Promise<void>;

export declare function formatReport(input: {
  headSha: string;
  source: string;
  runs: WorkflowRun[];
  maxAttempt: number;
}): string;

export declare function main(
  argv: string[],
  env?: NodeJS.ProcessEnv,
  run?: typeof import('node:child_process').spawnSync,
  fetchImpl?: typeof fetch,
): Promise<number>;
