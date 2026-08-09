export type CensusFreshnessVerdict = 'fresh' | 'due' | 'stale' | 'unverifiable';

export const VERDICT_FRESH: 'fresh';
export const VERDICT_DUE: 'due';
export const VERDICT_STALE: 'stale';
export const VERDICT_UNVERIFIABLE: 'unverifiable';

export const EXIT_OK: 0;
export const EXIT_DUE: 1;
export const EXIT_STALE: 2;
export const EXIT_UNVERIFIABLE: 3;

export const RECOMMENDED_REMEASUREMENT_DAYS: 7;
export const REFLOG_EXPIRY_DAYS: 30;

export const SAMPLE_TIMESTAMP_FOR_CONTROLS: string;
export const FABRICATED_ANCIENT_TIMESTAMP: string;

export interface CensusFreshnessResult {
  readonly verdict: CensusFreshnessVerdict;
  readonly exitCode:
    | typeof EXIT_OK
    | typeof EXIT_DUE
    | typeof EXIT_STALE
    | typeof EXIT_UNVERIFIABLE;
  readonly ageDays: number | null;
  readonly reason: string;
}

export interface ControlReading {
  readonly passed: boolean;
  readonly failures: string[];
}

export interface CensusCitation {
  readonly worktrees?: number;
  readonly trueCount?: number;
  readonly falseCount?: number;
  readonly accused?: number;
  readonly measuredAt?: string;
  readonly fields: Record<string, string>;
  readonly incomplete: boolean;
  readonly missing: string[];
  readonly missingFields?: string[];
  readonly invalidFields?: string[];
}

export function normalizeInstant(value: unknown): number | null;

export function resolveNow(now?: unknown): number | null;

export function classifyCensusFreshness(input?: {
  measuredAt?: unknown;
  now?: unknown;
}): CensusFreshnessResult;

export function evaluateControls(): ControlReading;

export function formatResult(
  result: CensusFreshnessResult,
  citation?: {
    worktrees?: number;
    trueCount?: number;
    falseCount?: number;
    accused?: number;
  },
): string;

export function parseCensusCitations(text: unknown): CensusCitation[];

export function parseArgs(argv: string[]): {
  measuredAt?: string;
  now?: string;
  file?: string;
};

export function main(
  argv?: string[],
  deps?: {
    readFile?: (path: string) => string;
  },
): Promise<void>;
