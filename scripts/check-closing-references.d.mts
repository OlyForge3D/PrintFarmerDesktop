/**
 * Types for scripts/check-closing-references.mjs. The script stays plain ESM so
 * CI can run it with bare `node`, without a build step standing between a
 * failure and the person reading it.
 */

export interface DeclaredClosures {
  hasBlock: boolean;
  declared: number[];
}

export interface ClosureComparison {
  ok: boolean;
  unexpected: number[];
  missing: number[];
}

export interface SettledRead {
  value: number[];
  /** Total attempts, including explicitly classified retryable failures. */
  reads: number;
  settled: boolean;
  elapsedMs: number;
  /** Time the returned value has held still. The floor is measured on this. */
  stableMs: number;
  retryableFailures: number;
}

/**
 * What `main` will accept from an injected reader.
 *
 * `stableMs` and `retryableFailures` are optional here and required above,
 * which is the honest pair: `readSettled` always populates them, but a stub
 * standing in for `readSettled` is not obliged to model internals of the
 * function it replaces. Relaxing them on `SettledRead` itself would have been
 * the easier edit and would have weakened every real caller to
 * `number | undefined` to spare the stubs.
 */
export type InjectedSettledRead = Omit<
  SettledRead,
  'stableMs' | 'retryableFailures'
> & {
  stableMs?: number;
  retryableFailures?: number;
};

export interface SettleOptions {
  requiredAgreements?: number;
  maxReads?: number;
  delayMs?: number;
  minElapsedMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface GitHubCliErrorDetails {
  args: string[];
  status: number | null;
  stderr: string;
  stdout: string;
  code: string | number | null;
  signal: string | null;
  cause: unknown;
}

export class GitHubCliError extends Error {
  constructor(details: GitHubCliErrorDetails);
  readonly args: string[];
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly code: string | number | null;
  readonly signal: string | null;
  readonly cause: unknown;
}

export function toGitHubCliError(
  args: string[],
  cause: unknown,
): GitHubCliError;

export type MalformedClosingReferenceResponseReason =
  'invalid-json' | 'invalid-shape';

export class MalformedClosingReferenceResponseError extends Error {
  constructor(
    reason: MalformedClosingReferenceResponseReason,
    responseLength: number,
    cause?: unknown,
  );
  readonly reason: MalformedClosingReferenceResponseReason;
  readonly responseLength: number;
  readonly cause: unknown;
}

export interface ClosingReferenceResponse {
  body: string;
  refs: number[];
}

export function parseClosingReferenceResponse(
  raw: string,
): ClosingReferenceResponse;

export type RetryableClosingReferenceReadReason =
  'malformed-response' | 'rate-limit' | 'server' | 'transport';

export type AbortedClosingReferenceReadReason =
  'authentication' | 'invalid-response-shape' | 'terminal-gh' | 'unknown';

export type RetryableClosingReferenceReadError =
  GitHubCliError | MalformedClosingReferenceResponseError;

export type ClosingReferenceReadErrorClassification =
  | {
      disposition: 'retry';
      reason: RetryableClosingReferenceReadReason;
      error: RetryableClosingReferenceReadError;
    }
  | {
      disposition: 'abort';
      reason: AbortedClosingReferenceReadReason;
      error: unknown;
    };

export function classifyClosingReferenceReadError(
  error: unknown,
): ClosingReferenceReadErrorClassification;

export interface ClosingReferenceReadBudgetErrorDetails {
  attempts: number;
  successfulReads: number;
  retryableFailures: number;
  elapsedMs: number;
  lastFailure: RetryableClosingReferenceReadError;
  lastFailureReason: RetryableClosingReferenceReadReason;
  lastValue: number[] | null;
}

export class ClosingReferenceReadBudgetError extends Error {
  constructor(details: ClosingReferenceReadBudgetErrorDetails);
  readonly attempts: number;
  readonly successfulReads: number;
  readonly retryableFailures: number;
  readonly elapsedMs: number;
  readonly lastFailureReason: RetryableClosingReferenceReadReason;
  readonly lastValue: number[] | null;
  readonly cause: RetryableClosingReferenceReadError;
}

export function parseDeclaredClosures(body: string): DeclaredClosures;

/** Relative path (from the repository root) of the tracked declaration file. */
export const DECLARATION_FILE_PATH: string;

export function readDeclarationFile(filePath?: string): string;

export function parseBoundClosures(body: string): number[];

export function parseCommitClosures(messages: string[]): number[];

export function parsePullRequestCommitResponse(raw: string): string[];

export function readPullRequestCommitClosures(
  prNumber: number | string,
  run: (args: string[]) => string,
): number[];

export function witnessContradiction(body: string, derived: number[]): number[];

export function witnessUnreadableBinding(
  body: string,
  derived: number[],
): number[];

export function compareClosures(
  declared: number[],
  actual: number[],
): ClosureComparison;

export function readSettled(
  read: () => number[] | Promise<number[]>,
  options?: SettleOptions,
): Promise<SettledRead>;

export function formatFailure(input: {
  unexpected: number[];
  missing: number[];
  hasBlock: boolean;
  prNumber: number | string;
}): string;

export function formatUnsettled(input: {
  prNumber: number | string;
  reads: number;
  elapsedMs: number;
  value: number[];
  retryableFailures?: number;
}): string;

export interface MainDeps {
  run?: (args: string[]) => string;
  readCommitClosures?: (
    prNumber: number | string,
    run: (args: string[]) => string,
  ) => number[];
  readDeclaration?: () => string;
  environment?: Record<string, string | undefined>;
  readClosures?: (
    read: () => number[] | Promise<number[]>,
    options?: SettleOptions,
  ) => Promise<InjectedSettledRead>;
}

export function main(
  argv: string[],
  deps?: MainDeps,
): Promise<{ ok: boolean; settled: boolean; stale: boolean }>;
