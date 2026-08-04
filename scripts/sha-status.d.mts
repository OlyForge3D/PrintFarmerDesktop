export const SHA_PATTERN: RegExp;

export interface ShaFacts {
  exists: boolean;
  /** False when the base is a remote-tracking ref that could not be refreshed. */
  baseFresh?: boolean;
  /** `null` means git could not answer, which is not the same as `false`. */
  onBase: boolean | null;
  onPr: boolean | null;
  /** Whether this IS the PR head. `onPr` is true for the head too; see `classify`. */
  isPrHead?: boolean | null;
  /** The base commit carrying the same subject, `''` for none, `null` for unasked. */
  shipped: string | null;
}

export type ShaVerdict =
  | 'absent'
  | 'live'
  | 'pr-head'
  | 'stale'
  | 'twin'
  | 'unresolved'
  | 'base-stale'
  | 'indeterminate';

export interface ShaStatus extends ShaFacts {
  sha: string;
  verdict: ShaVerdict;
  summary: string;
}

export interface ShaStatusOptions {
  shas: string[];
  base: string;
  pr: string | null;
  remote: string;
}

export function gitStatus(args: string[]): number | null;
export function objectExists(sha: string): boolean;
export function isAncestor(sha: string, ref: string): boolean | null;
export function contentShipped(sha: string, base: string): string | null;
export function classify(facts: ShaFacts): {
  verdict: ShaVerdict;
  summary: string;
};
export function fetchPrHead(pr: string, remote?: string): string | null;
export function remoteTrackingParts(
  base: string,
  remote?: string,
): { remote: string; branch: string } | null;
export function fetchBase(
  base: string,
  remote?: string,
): { ref: string; fresh: boolean; refreshable: boolean };
export function inspect(
  sha: string,
  options?: { base?: string; prRef?: string | null; baseFresh?: boolean },
): ShaStatus;
export function parseArgs(argv: string[]): ShaStatusOptions;
export function main(
  argv?: string[],
  out?: Pick<Console, 'log' | 'error'>,
): number;
