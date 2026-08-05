export const VERDICT_COVERED: 'covered';
export const VERDICT_SUPERSEDED: 'superseded';
export const VERDICT_UNREVIEWED: 'unreviewed';
export const VERDICT_UNVERIFIABLE: 'unverifiable';

export const EXIT_OK: 0;
export const EXIT_UNCOVERED: 1;
export const EXIT_UNVERIFIABLE: 2;

export const FABRICATED_HEAD: string;

export type CoverageVerdict =
  | typeof VERDICT_COVERED
  | typeof VERDICT_SUPERSEDED
  | typeof VERDICT_UNREVIEWED
  | typeof VERDICT_UNVERIFIABLE;

export interface ReviewRecord {
  id?: number;
  state?: string;
  commit_id?: unknown;
}

export interface CoverageResult {
  prNumber: number | undefined;
  verdict: CoverageVerdict;
  reason: string;
  reviewCount: number;
  coveringReviews: Array<number | undefined>;
  states: string[];
}

export interface ControlReading {
  passed: boolean;
  falsePositives: number;
  selfMatched: number;
  usableReviews: number;
  failures: string[];
}

export interface CoverageSweep {
  total: number;
  covered: CoverageResult[];
  superseded: CoverageResult[];
  unreviewed: CoverageResult[];
  unverifiable: CoverageResult[];
  reviewed: number;
}

export function normalizeSha(value: unknown): string | null;

export function reviewCoversHead(
  review: ReviewRecord | undefined,
  head: unknown,
): boolean;

export function classifyCoverage(input?: {
  prNumber?: number;
  mergedHead?: unknown;
  reviews?: ReviewRecord[];
}): CoverageResult;

export function evaluateControls(input?: {
  reviews?: ReviewRecord[];
  fabricatedHead?: string;
}): ControlReading;

export function evaluateSweep(results: CoverageResult[]): CoverageSweep;

export function formatSweep(
  sweep: CoverageSweep,
  options?: { readAt?: string },
): string;

export function fetchMergedPulls(input: {
  repository: string;
  token?: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>>;

export function fetchReviews(input: {
  repository: string;
  token?: string;
  prNumber: number;
}): Promise<ReviewRecord[]>;
