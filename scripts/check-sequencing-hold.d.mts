export interface SequencingHold {
  readonly label: string;
  readonly reason: string;
}

export interface SequencingHoldResult {
  readonly held: boolean;
  readonly holds: readonly SequencingHold[];
}

export const HOLD_LABEL_PREFIX: string;
export const DOCUMENTED_HOLDS: Readonly<Record<string, string>>;

export function evaluateSequencingHold(
  labels: readonly (string | { name?: unknown })[],
): SequencingHoldResult;

export function formatHold(
  holds: readonly SequencingHold[],
  prNumber: number,
): string;

export function fetchPullRequestLabels(options: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]>;

export function resolvePullRequestNumber(
  environment: NodeJS.ProcessEnv,
): number;

export function resolveRepository(environment: NodeJS.ProcessEnv): {
  owner: string;
  repo: string;
};
