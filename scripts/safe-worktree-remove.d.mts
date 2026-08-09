export const DIAGNOSTIC_PREFIX: string;
export const RECOVERY_FLAG: string;

/**
 * Stable, distinct identifiers for every refusal `safe-worktree-remove.mjs`
 * can throw. Codes are API — do not rename or reuse. Attach as `error.code`.
 */
export const ERROR_CODES: {
  readonly IDENTITY_UNRESOLVED: 'EWT_IDENTITY_UNRESOLVED';
  readonly CALLER_INSIDE_TARGET: 'EWT_CALLER_INSIDE_TARGET';
  readonly RECOVERY_TARGET_NOT_DIRECTORY: 'EWT_RECOVERY_TARGET_NOT_DIRECTORY';
  readonly RECEIPT_CREATE_IDENTITY_MISMATCH: 'EWT_RECEIPT_CREATE_IDENTITY_MISMATCH';
  readonly RECEIPT_UNREADABLE: 'EWT_RECEIPT_UNREADABLE';
  readonly RECEIPT_IDENTITY_MISMATCH: 'EWT_RECEIPT_IDENTITY_MISMATCH';
  readonly STALE_REGISTRY_UNRESOLVED: 'EWT_STALE_REGISTRY_UNRESOLVED';
  readonly STALE_STILL_REGISTERED: 'EWT_STALE_STILL_REGISTERED';
  readonly WORKTREE_ROOT_NOT_DIRECTORY: 'EWT_WORKTREE_ROOT_NOT_DIRECTORY';
  readonly REPARSE_TARGET_UNRESOLVED: 'EWT_REPARSE_TARGET_UNRESOLVED';
  readonly TARGET_DISAPPEARED: 'EWT_TARGET_DISAPPEARED';
  readonly TARGET_IDENTITY_CHANGED: 'EWT_TARGET_IDENTITY_CHANGED';
  readonly REPARSE_POINTS_REMAIN: 'EWT_REPARSE_POINTS_REMAIN';
  readonly STALE_DIRECTORY_BECAME_REPARSE_POINT: 'EWT_STALE_DIRECTORY_BECAME_REPARSE_POINT';
  readonly STALE_REPARSE_POINT_REMAINED: 'EWT_STALE_REPARSE_POINT_REMAINED';
  readonly STALE_UNSUPPORTED_ENTRY: 'EWT_STALE_UNSUPPORTED_ENTRY';
  readonly REGISTRY_UNRESOLVED: 'EWT_REGISTRY_UNRESOLVED';
  readonly NOT_REGISTERED: 'EWT_NOT_REGISTERED';
  readonly AMBIGUOUS_IDENTITY: 'EWT_AMBIGUOUS_IDENTITY';
  readonly MAIN_WORKTREE: 'EWT_MAIN_WORKTREE';
  readonly RECOVERY_WINDOWS_ONLY: 'EWT_RECOVERY_WINDOWS_ONLY';
};

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

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
export function filesystemRealpath(
  platform?: NodeJS.Platform,
): (path: string) => string;
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
export function readRecoveryReceipt(
  repository: string,
  target: string,
  realpathImpl: (path: string) => string,
): { receiptPath: string; resolvedTarget: string };
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
