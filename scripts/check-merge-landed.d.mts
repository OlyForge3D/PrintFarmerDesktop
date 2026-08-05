export const VERDICT_LANDED: 'landed';
export const VERDICT_NOT_LANDED: 'not-landed';
export const VERDICT_UNVERIFIABLE: 'unverifiable';
export const VERDICT_ADJUDICATED: 'adjudicated';

export const EXIT_LANDED: 0;
export const EXIT_NOT_LANDED: 1;
export const EXIT_UNVERIFIABLE: 2;

export interface AdjudicatedLoss {
  prNumber: number;
  restoredBy: number;
  restoredPaths: string[];
  reason: string;
}

export const ADJUDICATED_LOSSES: AdjudicatedLoss[];

export function classifyAdjudication(input?: {
  entry?: AdjudicatedLoss | undefined;
  codes?: number[] | undefined;
}): { discharged: boolean; reason: string };

export type MergeVerdict =
  | typeof VERDICT_LANDED
  | typeof VERDICT_NOT_LANDED
  | typeof VERDICT_UNVERIFIABLE
  | typeof VERDICT_ADJUDICATED;

export interface AncestryReading {
  reached: boolean | null;
  reason: string;
}

export interface FileReading {
  path: string;
  present: boolean | null;
  reason: string;
}

export interface MergeResult {
  prNumber: number;
  verdict: MergeVerdict;
  reason: string;
  files: FileReading[];
}

export interface SweepResult {
  exitCode: 0 | 1 | 2;
  verdict: MergeVerdict;
  notLanded: MergeResult[];
  unverifiable: MergeResult[];
  landed: MergeResult[];
  adjudicated: MergeResult[];
}

export function classifyAncestry(input?: {
  code?: number;
  subject?: string;
}): AncestryReading;

export function classifyFile(input?: {
  path?: string;
  status?: string;
  atHead?: number;
  atTarget?: number;
}): FileReading;

export function classifyMerge(input?: {
  prNumber?: number;
  merged?: boolean;
  mergeCommitSha?: unknown;
  baseRef?: string;
  targetRef?: string;
  ancestry?: AncestryReading;
  files?: FileReading[];
  adjudication?: { discharged: boolean; reason: string };
}): MergeResult;

export function evaluateSweep(results: MergeResult[]): SweepResult;

export function formatSweep(
  sweep: SweepResult,
  options?: { targetRef?: string },
): string;

export function ensureObject(sha: string, remote?: string): boolean;
export function ancestryCode(sha: string, targetRef: string): number;
export function pathCode(ref: string, path: string): number;

export function fetchMergedPulls(input: {
  repository: string;
  token?: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>>;

export function fetchPullFiles(input: {
  repository: string;
  token?: string;
  prNumber: number;
}): Promise<Array<{ path: string; status: string }>>;

export function verifyPull(input: {
  pull: Record<string, unknown>;
  files: Array<{ path: string; status: string }>;
  targetRef: string;
}): MergeResult;
