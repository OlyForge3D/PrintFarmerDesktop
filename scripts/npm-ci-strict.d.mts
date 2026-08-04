export const CLEANUP_WARNING_MARKER: string;
export const NPM_PRODUCTION_TREE_COMMAND: string;
export function hasCleanupFailure(output: unknown): boolean;
export function extractCleanupPaths(output: unknown): string[];
export function findTreeProblems(tree: unknown): string[];
export function findUnresolvedPackages(tree: unknown): string[];
export function npmInvocation(commandLine: string): {
  command: string;
  args: string[];
};
