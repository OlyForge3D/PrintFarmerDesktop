export type StackedBaseVerdict =
  'not-stacked' | 'base-live' | 'base-landed' | 'base-unknown';

export interface BasePullRequest {
  readonly number: number;
  readonly state: string;
  readonly mergedAt?: string | null;
}

export interface StackedBaseResult {
  readonly verdict: StackedBaseVerdict;
  readonly exitCode: 0 | 1 | 2;
  readonly reason: string;
}

export const VERDICT_NOT_STACKED: 'not-stacked';
export const VERDICT_BASE_LIVE: 'base-live';
export const VERDICT_BASE_LANDED: 'base-landed';
export const VERDICT_BASE_UNKNOWN: 'base-unknown';

export function classifyStackedBase(input?: {
  baseRef?: string;
  defaultBranch?: string;
  basePullRequest?: BasePullRequest | null;
}): StackedBaseResult;

export function formatVerdict(
  result: StackedBaseResult,
  context?: { prNumber?: number; baseRef?: string },
): string;

export function fetchPullRequest(input: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ baseRef: string; defaultBranch: string }>;

export function fetchBranchPullRequest(input: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<BasePullRequest | null>;
