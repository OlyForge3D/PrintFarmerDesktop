export const VERDICT_NO_GATE_NEEDED: 'no-gate-needed';
export const VERDICT_GATE_REQUIRED: 'gate-required';
export const VERDICT_UNVERIFIABLE: 'unverifiable';

export const EXIT_OK: 0;
export const EXIT_GATE_REQUIRED: 1;
export const EXIT_UNVERIFIABLE: 2;
export const EXIT_REDERIVE: 3;

export type GateVerdict =
  | typeof VERDICT_NO_GATE_NEEDED
  | typeof VERDICT_GATE_REQUIRED
  | typeof VERDICT_UNVERIFIABLE;

export interface TerminalStateResult {
  verdict: GateVerdict;
  reason: string;
}

export function classifyTerminalState(input?: {
  prNumber?: number;
  state?: string;
  merged?: boolean;
}): TerminalStateResult;

export interface PositionResult {
  verdict: GateVerdict;
  reason: string;
}

export function classifyPosition(input?: {
  sourceA?: string;
  valueA?: string | null;
  sourceB?: string;
  valueB?: string | null;
}): PositionResult;

export interface RoundBudgetResult {
  verdict: 'within-budget' | 'rederive' | typeof VERDICT_UNVERIFIABLE;
  reason: string;
  consecutive: number;
}

export function classifyRoundBudget(input?: {
  history?: string[];
  currentHash?: string;
  threshold?: number;
}): RoundBudgetResult;

export function formatVerdict(
  label: string,
  result: { reason: string },
): string;

export function resolveRemoteUrl(remote?: string): string | null;
export function resolveRemoteBranchHead(
  remote: string,
  branch: string,
): string | null;

export function parseArgs(argv: string[]): {
  pr?: number;
  repo?: string;
  branch?: string;
};
