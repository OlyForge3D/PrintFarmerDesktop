export type ArmState = 'killed' | 'survived' | 'confounded';

export interface TestSummary {
  readonly failed: number;
  readonly passed: number;
}

export interface ApplicationResult {
  readonly applied: boolean;
  readonly reason: string;
}

export interface RestoreResult {
  readonly restored: boolean;
  readonly reason: string;
}

export interface BaselineResult {
  readonly usable: boolean;
  readonly reason: string;
}

export interface ArmResult {
  readonly state: ArmState;
  readonly reason: string;
  readonly label?: string;
  readonly failed?: number;
}

export interface RunResult {
  readonly exitCode: 0 | 1 | 2;
  readonly verdict: 'all-killed' | 'survived' | 'confounded';
  readonly confounded: readonly ArmResult[];
  readonly survived: readonly ArmResult[];
}

export const ARM_KILLED: 'killed';
export const ARM_SURVIVED: 'survived';
export const ARM_CONFOUNDED: 'confounded';

// Re-exported from ./mutationWindowProtocol.mjs so callers that already depend
// on the harness need not know the protocol lives in its own module.
export const MUTATION_TOKEN_VARIABLE: 'PRINTFARMER_MUTATION_TOKEN';
export function lockPathFor(cwd?: string): string;

export function stripAnsi(text: string): string;
export function parseTestSummary(output: string): TestSummary | null;
export function countOccurrences(haystack: string, needle: string): number;
export function resolveCommand(
  command: readonly string[],
  platform?: NodeJS.Platform,
): { file: string; args: string[] };

export function classifyApplication(input?: {
  anchorsBefore?: number;
  replacementsAfter?: number;
  expectedAnchors?: number;
}): ApplicationResult;

export function classifyRestore(input?: {
  pinnedHash?: string;
  actualHash?: string;
  porcelainBefore?: string;
  porcelainAfter?: string;
}): RestoreResult;

export function classifyBaseline(summary: TestSummary | null): BaselineResult;

export function classifyArm(input?: {
  application?: ApplicationResult;
  restore?: RestoreResult;
  summary?: TestSummary | null;
}): ArmResult;

export function evaluateRun(arms: readonly ArmResult[]): RunResult;

export function formatRun(
  result: RunResult,
  arms: readonly ArmResult[],
): string;

export function hashWorkingFile(filePath: string, cwd?: string): string;
export function porcelainStatus(cwd?: string): string;

export function runArm(input: {
  filePath: string;
  original: string;
  pinnedHash: string;
  anchor: string;
  replacement: string;
  expectedAnchors?: number;
  testCommand: readonly string[];
  label?: string;
  cwd?: string;
}): ArmResult;

export interface VitestArgvSplit {
  readonly argv: string[] | null;
  readonly index: number;
}

export interface SelectorGateResult {
  readonly refuse: boolean;
  readonly message: string | null;
}

export function isVitestToken(token: unknown): boolean;

export function vitestArgvOf(command?: readonly string[]): VitestArgvSplit;

export function selectorGate(
  command?: readonly string[],
  options?: {
    check?: typeof import('./vitest-strict.mjs').checkSelectors;
    format?: typeof import('./vitest-strict.mjs').formatRefusal;
  },
): SelectorGateResult;
