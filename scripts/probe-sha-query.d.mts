import type { spawnSync } from 'node:child_process';

export declare const EXIT_REPRODUCES: 0;
export declare const EXIT_CHANGED: 1;
export declare const EXIT_UNDETERMINED: 2;

export declare const FABRICATED_SHA: string;
export declare const SHA_PATTERN: RegExp;

export interface Arm {
  id: string;
  control: boolean;
  endpoint: 'filter' | 'deref';
  truncate: boolean;
  expect: string;
  describe: string;
}

export declare const ARMS: readonly Arm[];

export interface Reading {
  label: string;
  reading: string | null;
}

export interface JudgedArm {
  id: string;
  control: boolean;
  describe: string;
  expected: string;
  observed: string;
  matches: boolean;
  readings: Reading[];
}

export interface Verdict {
  exitCode: number;
  summary: string;
}

/**
 * Deliberately narrow. A stub that has to lie about a signature is evidence the
 * signature is wrong, so this asks for the two fields the code reads and no
 * more — the same reasoning as GhSpawn in check-required-contexts.d.mts.
 */
export type Run = typeof spawnSync;

export declare function presentSha(sha: string, truncate: boolean): string;

export declare function apiPath(
  arm: { endpoint: string },
  repo: string,
  sha: string,
): string;

export declare function countExpression(): string;

export declare function readCount(
  run: Run,
  path: string,
  env: NodeJS.ProcessEnv,
): string | null;

export declare function readArm(
  arm: { endpoint: string; truncate: boolean },
  ctx: { repo: string; realSha: string; run: Run; env: NodeJS.ProcessEnv },
): Reading[];

export declare function judgeArm(
  arm: { id: string; expect: string; control: boolean; describe: string },
  cases: readonly Reading[],
): JudgedArm;

export declare function overallVerdict(
  judged: readonly {
    id: string;
    control: boolean;
    expected: string;
    observed: string;
    matches: boolean;
  }[],
): Verdict;

export declare function formatReport(
  judged: readonly JudgedArm[],
  verdict: Verdict,
): string;

export declare function parseArgs(argv: readonly string[]): {
  repo?: string;
  sha?: string;
  help?: boolean;
};

export declare function resolveSubject(
  requested: string | undefined,
  run: Run,
): { ok: true; sha: string } | { ok: false; reason: string };

export declare function resolveRepo(
  requested: string | undefined,
  env: NodeJS.ProcessEnv,
  run: Run,
): string | null;

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

export declare const USAGE: string;
