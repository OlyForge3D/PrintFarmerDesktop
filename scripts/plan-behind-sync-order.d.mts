export interface BehindCandidate {
  number: number;
  createdAt: string;
  baseRefName: string;
  behind: boolean;
}

export interface SkippedPr {
  number: number;
  reason: string;
}

export interface SyncPlan {
  next: BehindCandidate | null;
  queued: BehindCandidate[];
}

export interface SyncLease {
  prNumber: number;
  claimedAt: string;
  expiresAt: string;
}

export const SYNC_LEASE_REF: string;
export const LEASE_TTL_MS: number;

export function planSyncOrder(candidates: readonly BehindCandidate[]): SyncPlan;

export function formatPlan(
  plan: SyncPlan,
  skipped: readonly SkippedPr[],
  activeLease?: SyncLease | null,
): string;

export function isLeaseExpired(lease: SyncLease, now: number): boolean;

export function readSyncLease(
  remote: string,
  run: (...args: unknown[]) => unknown,
): { lease: SyncLease | null; oid: string | null };

export function claimSyncLease(
  prNumber: number,
  remote: string,
  run: (...args: unknown[]) => unknown,
  options?: { now?: number; ttlMs?: number },
): { claimed: boolean; reason?: string };

export function surveyBehindPrs(
  opts: { remote?: string },
  env?: NodeJS.ProcessEnv,
  run?: (...args: unknown[]) => unknown,
): { candidates: BehindCandidate[]; skipped: SkippedPr[] } | { error: string };

export function parseArgs(argv: readonly string[]): {
  remote?: string;
  help?: boolean;
  claim?: boolean;
  error?: string;
};

export function main(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  run?: (...args: unknown[]) => unknown,
): number;
