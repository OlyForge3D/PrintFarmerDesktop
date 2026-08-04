export const CLEANUP_WARNING_MARKER: string;
export const NPM_PRODUCTION_TREE_COMMAND: string;
export const MAX_INSTALL_ATTEMPTS: number;
export const REMOVAL_RETRY: { maxRetries: number; retryDelay: number };
export function hasCleanupFailure(output: unknown): boolean;
export function extractCleanupPaths(output: unknown): string[];
export function findTreeProblems(tree: unknown): string[];
export function findUnresolvedPackages(tree: unknown): string[];
export function planInstallOutcome(
  output: unknown,
  attempt: number,
  maxAttempts?: number,
): { action: 'accept' | 'retry' | 'fail'; paths: string[] };
export function recoveryNotice(
  paths: string[],
  attempt: number,
  maxAttempts: number,
): string[];
export function exhaustedFailureLines(
  paths: string[],
  maxAttempts: number,
): string[];
export function npmInvocation(commandLine: string): {
  command: string;
  args: string[];
};
