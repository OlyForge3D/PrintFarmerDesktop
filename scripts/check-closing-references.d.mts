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

export function formatUnsettled(input: {
  prNumber: number | string;
  reads: number;
  elapsedMs: number;
  value: number[];
}): string;

export interface MainDeps {
  run?: (args: string[]) => string;
  readClosures?: (
    read: () => number[] | Promise<number[]>,
    options?: SettleOptions,
  ) => Promise<SettledRead>;
}

export function main(
  argv: string[],
  deps?: MainDeps,
): Promise<{ ok: boolean; settled: boolean }>;
