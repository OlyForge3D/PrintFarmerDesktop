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

export function planSyncOrder(
  candidates: readonly BehindCandidate[],
): Map<string, SyncPlan>;

export function formatPlan(
  plans: Map<string, SyncPlan>,
  skipped: readonly SkippedPr[],
): string;

export function surveyBehindPrs(
  opts: { remote?: string },
  env?: NodeJS.ProcessEnv,
  run?: (...args: unknown[]) => unknown,
): { candidates: BehindCandidate[]; skipped: SkippedPr[] } | { error: string };

export function parseArgs(argv: readonly string[]): {
  remote?: string;
  help?: boolean;
  error?: string;
};

export function main(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  run?: (...args: unknown[]) => unknown,
): number;
