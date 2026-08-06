import type { GhSpawn } from './check-required-contexts.mjs';

export const EXIT_READY: 0;
export const EXIT_DEFERRED: 1;
export const EXIT_UNDETERMINED: 2;

export const VERDICT_READY: 'ready';
export const VERDICT_DRAFT: 'draft';
export const VERDICT_DRAFT_MOVED: 'draft-moved';
export const VERDICT_WAITING_FOR_CHECKS: 'waiting-for-checks';
export const VERDICT_HEAD_MOVED: 'head-moved';
export const VERDICT_BASE_MOVED: 'base-moved';

export interface PullSnapshot {
  number: number;
  state: 'open';
  draft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
}

export interface ReviewComparison {
  mergeBaseSha: string;
  headSha: string;
  range: string;
  parentCount: number | null;
  files: string[];
}

export interface ReadyReviewTarget {
  verdict: typeof VERDICT_READY;
  exitCode: typeof EXIT_READY;
  reason: string;
  pull: PullSnapshot & { draft: false };
  baseSha: string;
  checkRunCount: number;
  comparison: ReviewComparison;
}

export interface DeferredReviewTarget {
  verdict:
    | typeof VERDICT_DRAFT
    | typeof VERDICT_DRAFT_MOVED
    | typeof VERDICT_WAITING_FOR_CHECKS
    | typeof VERDICT_HEAD_MOVED
    | typeof VERDICT_BASE_MOVED;
  exitCode: typeof EXIT_DEFERRED;
  reason: string;
}

export type ReviewTarget = ReadyReviewTarget | DeferredReviewTarget;

export function parseArgs(argv: readonly string[]): {
  help?: boolean;
  pr?: number;
  repo?: string;
  error?: string;
};

export function parsePullSnapshot(
  payload: unknown,
  expectedNumber: number,
): PullSnapshot;

export function parseBaseSha(payload: unknown, baseRef: string): string;

export function parseCheckRunCount(payload: unknown): number;

export function parseComparison(
  payload: unknown,
  expectedHeadSha: string,
): ReviewComparison;

export function classifyReviewTarget(input: {
  initial: PullSnapshot;
  final: PullSnapshot;
  initialBaseSha: string | null;
  finalBaseSha: string | null;
  checkRunCount: number | null;
  comparison: ReviewComparison | null;
}): ReviewTarget;

export function formatReviewBrief(
  result: ReadyReviewTarget,
  options?: { readAt?: string },
): string;

export function formatDeferred(result: DeferredReviewTarget): string;

export function readGhJson(
  run: GhSpawn,
  path: string,
  env: NodeJS.ProcessEnv,
): unknown;

export function main(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  run?: GhSpawn,
  writeOut?: (line: string) => void,
  writeError?: (line: string) => void,
): number;
