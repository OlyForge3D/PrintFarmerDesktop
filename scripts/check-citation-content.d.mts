export const FILES: string[];
export const ASSERTION_HEADING: string;
export const CONTENT_ASSERTION_FLOOR: number;

export type AncestorStatus = 'ANCESTOR' | 'NOT_ANCESTOR' | 'NO_ANSWER';

export function ancestorStatus(candidate: string, of: string): AncestorStatus;
export function reachabilityOf(
  sha: string,
  readerRevs: readonly string[],
): AncestorStatus;
export function addedLinesOf(commit: string): string[] | null;

export interface Verdict {
  verdict: 'PASS' | 'FAIL' | 'WITHHOLD';
  detail: string;
}

export function classify(
  sha: string,
  assertion: string,
  readerRevs: readonly string[],
): Verdict;

export interface AssertionRow {
  file: string;
  sha: string;
  assertion: string;
}

export function parseAssertions(
  sources: ReadonlyMap<string, string>,
): AssertionRow[];

export function readerRevisions(): string[];

export function findLiveControlCommit(
  depth?: number,
): { commit: string; line: string } | null;
