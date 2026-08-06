export const DIAGNOSTIC_PREFIX: string;
export const RECOVERY_FLAG: string;

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
  createReceipt?: (
    repository: string,
    target: string,
    options: { realpathImpl: (path: string) => string },
  ) => string;
  removeReceipt?: (receiptPath: string | null) => void;
  readReceipt?: (
    repository: string,
    target: string,
    realpathImpl: (path: string) => string,
  ) => { receiptPath: string; resolvedTarget: string };
  removeStale?: (target: string) => void;
  realpathImpl?: (path: string) => string;
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
  realpathImpl?: (path: string) => string,
): void;
export function gitCommonDirectory(cwd?: string): string;
export function createRecoveryReceipt(
  repository: string,
  target: string,
  options?: {
    commonDirectory?: string;
    realpathImpl?: (path: string) => string;
  },
): string;
export function removeRecoveryReceipt(receiptPath: string | null): void;
export function validateStaleRecoveryTarget(
  target: string,
  worktrees: string[],
  realpathImpl?: (path: string) => string,
): string;
export function prepareWindowsWorktreeForRemoval(
  worktreePath: string,
): PreparedWorktree;
export function removeStaleDirectory(root: string): void;
export function validateRemovalTarget(
  target: string,
  worktrees: string[],
  platform?: NodeJS.Platform,
  realpathImpl?: (path: string) => string,
): string;
export function main(
  argv: string[],
  dependencies?: SafeWorktreeRemoveDependencies,
): number;
