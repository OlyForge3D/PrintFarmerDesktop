export type DispatchVerdict = 'dispatched' | 'silent' | 'unverifiable';

export const VERDICT_DISPATCHED: 'dispatched';
export const VERDICT_SILENT: 'silent';
export const VERDICT_UNVERIFIABLE: 'unverifiable';

export const EXIT_OK: 0;
export const EXIT_SILENT: 1;
export const EXIT_UNVERIFIABLE: 2;

export const FULL_SHA_PATTERN: RegExp;

export interface DispatchResult {
  readonly verdict: DispatchVerdict;
  readonly exitCode:
    typeof EXIT_OK | typeof EXIT_SILENT | typeof EXIT_UNVERIFIABLE;
  readonly reason: string;
}

export interface ControlReading {
  readonly passed: boolean;
  readonly failures: string[];
}

export function normalizeSha(value: unknown): string | null;

export function classifyDispatch(input?: {
  headSha?: unknown;
  totalCount?: unknown;
  prNumber?: number;
}): DispatchResult;

export function evaluateControls(): ControlReading;

export function formatResult(result: DispatchResult): string;

export function parseArgs(argv: readonly string[]): {
  pr?: number;
  sha?: string;
  repo?: string;
};
