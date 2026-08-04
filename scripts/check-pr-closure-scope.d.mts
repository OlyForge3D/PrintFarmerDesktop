export interface ProtectedGateIssue {
  readonly number: number;
  readonly reason: string;
}

export interface ClosingIssue {
  readonly number: number;
  readonly title?: string;
  readonly labels?: readonly string[];
}

export interface ClosureViolation {
  readonly number: number;
  readonly title: string;
  readonly rules: readonly string[];
  readonly reason: string;
}

export interface ClosureScopeResult {
  readonly ok: boolean;
  readonly violations: readonly ClosureViolation[];
}

export const PROTECTED_GATE_ISSUES: readonly ProtectedGateIssue[];
export const EXPECTED_PROTECTED_GATE_ISSUE_COUNT: number;
export const PROTECTED_LABELS: readonly string[];

export function evaluateClosureScope(
  closingIssues: readonly ClosingIssue[],
  options?: {
    protectedIssues?: readonly ProtectedGateIssue[];
    protectedLabels?: readonly string[];
  },
): ClosureScopeResult;

export function formatViolations(
  violations: readonly ClosureViolation[],
): string;

export function resolvePullRequestNumber(
  environment: NodeJS.ProcessEnv,
): number;

export function resolveRepository(environment: NodeJS.ProcessEnv): {
  owner: string;
  repo: string;
};

export function fetchClosingIssues(options: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<ClosingIssue[]>;
