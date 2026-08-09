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

export interface ClosingIssuesIndeterminateErrorDetails {
  readonly reads: number;
  readonly elapsedMs: number;
}

export class ClosingIssuesIndeterminateError extends Error {
  readonly reads: number;
  readonly elapsedMs: number;
  constructor(details: ClosingIssuesIndeterminateErrorDetails);
}

export interface ResolveClosingIssuesConfidentlyResult {
  readonly value: ClosingIssue[];
  readonly confirmedEmpty: boolean;
  readonly reads: number;
  readonly elapsedMs: number;
}

export function resolveClosingIssuesConfidently(
  read: () => Promise<ClosingIssue[]>,
  options?: {
    maxReads?: number;
    delayMs?: number;
    minEmptyFloorMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<ResolveClosingIssuesConfidentlyResult>;

export interface ArmedReference {
  readonly number: number;
  readonly keyword: string;
  readonly text: string;
}

export interface PullRequestCommit {
  readonly sha: string;
  readonly message: string;
}

export interface ArmingCommit {
  readonly sha: string;
  readonly keyword: string;
  readonly text: string;
}

export const CLOSING_KEYWORDS: readonly string[];

export function extractArmedIssueNumbers(text: string): ArmedReference[];

export function collectArmedCommitReferences(
  commits: readonly PullRequestCommit[],
): Map<number, ArmingCommit[]>;

export function formatCommitViolations(
  violations: readonly ClosureViolation[],
  armedBy: ReadonlyMap<number, readonly ArmingCommit[]>,
): string;

export function fetchPullRequestCommits(options: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<PullRequestCommit[]>;

export function fetchIssuesByNumber(options: {
  owner: string;
  repo: string;
  numbers: readonly number[];
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<ClosingIssue[]>;

export function main(): Promise<void>;

export function reportClosureScopeCliOutcome(error: unknown): void;
