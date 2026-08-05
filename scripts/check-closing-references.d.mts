/**
 * Types for scripts/check-closing-references.mjs. The script stays plain ESM so
 * CI can run it with bare `node`, without a build step standing between a
 * failure and the person reading it.
 */

export interface DeclaredClosures {
  hasBlock: boolean;
  declared: number[];
}

export interface ClosureComparison {
  ok: boolean;
  unexpected: number[];
  missing: number[];
}

export interface SettledRead {
  value: number[];
  reads: number;
  settled: boolean;
  elapsedMs: number;
}

export interface SettleOptions {
  requiredAgreements?: number;
  maxReads?: number;
  delayMs?: number;
  minElapsedMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function parseDeclaredClosures(body: string): DeclaredClosures;

export function compareClosures(
  declared: number[],
  actual: number[],
): ClosureComparison;

export function readSettled(
  read: () => number[] | Promise<number[]>,
  options?: SettleOptions,
): Promise<SettledRead>;

export function formatFailure(input: {
  unexpected: number[];
  missing: number[];
  hasBlock: boolean;
  prNumber: number | string;
}): string;

/** #513. Commit-message surface. */

export interface CommitClosure {
  keyword: string;
  issue: number;
}

export interface CommitClosureSource {
  oid: string;
  keyword: string;
}

export interface ScannedCommitClosure {
  issue: number;
  sources: CommitClosureSource[];
}

export interface ScannedCommit {
  oid?: string;
  message?: string;
}

export const CLOSING_KEYWORDS: readonly string[];

export function parseCommitClosures(message: string): CommitClosure[];

export function scanCommitMessages(
  commits: readonly ScannedCommit[] | undefined,
): ScannedCommitClosure[];

export function compareCommitClosures(
  declared: number[],
  scanned: readonly ScannedCommitClosure[],
): ScannedCommitClosure[];

export function formatCommitFailure(input: {
  unexpected: readonly ScannedCommitClosure[];
  prNumber: number | string;
}): string;
