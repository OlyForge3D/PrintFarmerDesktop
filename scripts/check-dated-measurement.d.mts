export type MeasurementVerdict = 'fresh' | 'stale' | 'unverifiable';

export const VERDICT_FRESH: 'fresh';
export const VERDICT_STALE: 'stale';
export const VERDICT_UNVERIFIABLE: 'unverifiable';

export const EXIT_OK: 0;
export const EXIT_STALE: 1;
export const EXIT_UNVERIFIABLE: 2;
export const EXIT_CONTROLS_FAILED: 3;

export const SAMPLE_TIMESTAMP_FOR_CONTROLS: string;
export const FABRICATED_LATER_TIMESTAMP: string;

export interface MeasurementFreshnessResult {
  readonly verdict: MeasurementVerdict;
  readonly exitCode:
    | typeof EXIT_OK
    | typeof EXIT_STALE
    | typeof EXIT_UNVERIFIABLE;
  readonly reason: string;
}

export interface ControlReading {
  readonly passed: boolean;
  readonly failures: string[];
}

export interface MeasurementCitation {
  readonly repo?: string;
  readonly number?: number;
  readonly updatedAt?: string;
  readonly fields: Record<string, string>;
  readonly incomplete: boolean;
  readonly missing: string[];
}

export function normalizeTimestamp(value: unknown): number | null;

export function classifyMeasurementFreshness(input?: {
  citedUpdatedAt?: unknown;
  liveUpdatedAt?: unknown;
}): MeasurementFreshnessResult;

export function evaluateControls(): ControlReading;

export function formatResult(
  result: MeasurementFreshnessResult,
  context?: { repo?: string; number?: number },
): string;

export function parseMeasurementCitations(text: unknown): MeasurementCitation[];

export function fetchLiveUpdatedAt(input: {
  repo: string;
  number: number;
  run?: (args: string[]) => string;
}): string | Promise<string>;

export function main(
  argv?: string[],
  deps?: {
    readFile?: (path: string) => string;
    fetchLive?: (input: { repo: string; number: number }) => string | Promise<string>;
  },
): Promise<void>;
