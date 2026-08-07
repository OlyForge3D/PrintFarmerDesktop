import type { spawnSync } from 'node:child_process';

export declare const EXIT_SUCCESS: 0;
export declare const EXIT_UNUSABLE: 2;
export declare const SHA_INPUT_PATTERN: RegExp;
export declare const FULL_SHA_PATTERN: RegExp;
export declare const USAGE: string;

export type Run = typeof spawnSync;

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

export declare function resolveCommitSha(
  input: string,
  repo: string,
  env: NodeJS.ProcessEnv,
  run: Run,
):
  | { ok: true; sha: string }
  | {
      ok: false;
      reason: string;
    };

export declare function queryActionsRunsForInput(
  input: string,
  repo: string,
  env: NodeJS.ProcessEnv,
  run: Run,
):
  | { ok: true; sha: string; totalCount: number }
  | {
      ok: false;
      stage: 'resolve' | 'query';
      reason: string;
    };

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
