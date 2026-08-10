export interface BehindCandidate {
  number: number;
  createdAt: string;
  behind: boolean;
}

export interface SyncPlan {
  next: BehindCandidate | null;
  queued: BehindCandidate[];
}

export function planSyncOrder(
  candidates: readonly BehindCandidate[],
): SyncPlan;

export function formatPlan(plan: SyncPlan, baseRefName: string): string;

export function surveyBehindPrs(
  opts: { remote?: string },
  env?: NodeJS.ProcessEnv,
  run?: (...args: unknown[]) => unknown,
):
  | { candidates: BehindCandidate[]; baseRefName: string }
  | { error: string };

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
