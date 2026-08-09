import type { spawnSync } from 'node:child_process';

export declare const EXIT_CLEAN: 0;
export declare const EXIT_FAILED: 1;
export declare const EXIT_UNDETERMINED: 2;

export declare const VERDICT_PASSED: 'passed';
export declare const VERDICT_FAILED: 'failed';
export declare const VERDICT_SUPERSEDED: 'superseded';
export declare const VERDICT_PENDING: 'pending';

export declare const USAGE: string;

export type Run = typeof spawnSync;

export type Verdict = 'passed' | 'failed' | 'superseded' | 'pending';

export interface CheckRunVerdict {
  name: string;
  conclusion: string | null;
  verdict: Verdict;
}

export interface LatestCheckRun {
  name: string;
  conclusion: string | null;
  status: string;
  startedAt: string;
  id: number;
}

export declare function classifyConclusion(conclusion: string | null): Verdict;

export declare function latestCheckRunsByName(
  checkRuns: readonly unknown[],
): Map<string, LatestCheckRun>;

export declare function buildVerdicts(
  checkRuns: readonly unknown[],
): CheckRunVerdict[];

export declare function parseArgs(argv: readonly string[]): {
  repo?: string;
  sha?: string;
  help?: boolean;
  error?: string;
};

export declare function resolveRepo(
  requested: string | undefined,
  env: NodeJS.ProcessEnv,
  run: Run,
): string | null;

export declare function fetchCheckRuns(
  repo: string,
  sha: string,
  env: NodeJS.ProcessEnv,
  run: Run,
): { ok: true; checkRuns: unknown[] } | { ok: false; reason: string };

export declare function formatReport(
  sha: string,
  verdicts: readonly CheckRunVerdict[],
): string;

export declare function runMain(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  run: Run,
  write: (text: string) => void,
): number;

export declare function main(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  run?: Run,
  write?: (text: string) => void,
): number;
