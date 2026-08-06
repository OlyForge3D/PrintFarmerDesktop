export const DIAGNOSTIC_PREFIX: string;

export interface PreparedWorktree {
  unlinked: string[];
  externalTargets: string[];
}

export interface CommandResult {
  stdout?: string;
  stderr?: string;
  status: number | null;
  error?: Error;
}

export interface SafeWorktreeRemoveDependencies {
  cwd?: string;
  platform?: NodeJS.Platform;
  listWorktrees?: (cwd: string) => string[];
  prepareWindows?: (target: string) => PreparedWorktree;
  runGit?: (repository: string, target: string) => CommandResult;
  writeStdout?: (message: string) => void;
  writeStderr?: (message: string) => void;
}

export function parseWorktreeList(output: string): string[];
export function listLinkedWorktrees(cwd?: string): string[];
export function findReparsePoints(worktreePath: string): string[];
export function validateCallerLocation(
  cwd: string,
  target: string,
  platform?: NodeJS.Platform,
): void;
export function prepareWindowsWorktreeForRemoval(
  worktreePath: string,
): PreparedWorktree;
export function validateRemovalTarget(
  target: string,
  worktrees: string[],
  platform?: NodeJS.Platform,
): void;
export function main(
  argv: string[],
  dependencies?: SafeWorktreeRemoveDependencies,
): number;
