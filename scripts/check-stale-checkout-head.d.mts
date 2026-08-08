export type FreshnessVerdict = 'fresh' | 'stale' | 'untracked' | 'unverifiable';

export const VERDICT_FRESH: 'fresh';
export const VERDICT_STALE: 'stale';
export const VERDICT_UNTRACKED: 'untracked';
export const VERDICT_UNVERIFIABLE: 'unverifiable';

export const EXIT_OK: 0;
export const EXIT_STALE: 1;
export const EXIT_UNTRACKED: 2;
export const EXIT_UNVERIFIABLE: 3;

export const FABRICATED_SHA: string;

export interface FreshnessResult {
  readonly verdict: FreshnessVerdict;
  readonly exitCode:
    | typeof EXIT_OK
    | typeof EXIT_STALE
    | typeof EXIT_UNTRACKED
    | typeof EXIT_UNVERIFIABLE;
  readonly reason: string;
}

export interface ControlReading {
  readonly passed: boolean;
  readonly failures: string[];
}

export function normalizeSha(value: unknown): string | null;

export function classifyHeadFreshness(input?: {
  localSha?: unknown;
  liveSha?: unknown;
  upstream?: string | null | undefined;
}): FreshnessResult;

export function evaluateControls(input?: {
  localSha?: unknown;
}): ControlReading;

export function formatResult(
  result: FreshnessResult,
  context?: { branch?: string; prNumber?: number },
): string;

export function currentBranch(): string;

export function readLocalSha(branch: string): string | null;

export function readUpstream(branch: string): string;

export function readRemoteBranchHead(
  branch: string,
  remote?: string,
): string | null;

export function fetchPrHeadSha(input: {
  repository: string;
  prNumber: number;
  token?: string;
}): Promise<string | null>;
