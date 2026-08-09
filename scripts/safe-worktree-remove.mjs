// Safely force-removes a linked worktree.
//
// Git for Windows 2.53.0.windows.3 follows NTFS directory junctions while
// removing a worktree and recursively deletes the junction target, even when
// that target is outside the worktree. It then exits 0. The only repository-
// owned force-removal path is therefore this wrapper:
//
//   npm run worktree:remove -- <worktree-path>
//   npm run worktree:remove -- --recover-stale <worktree-path>
//
// On Windows, every symbolic link or junction is resolved before any mutation,
// unlinked without recursion, and its target identity is checked before Git is
// allowed to remove the worktree. A normal removal records filesystem identity
// outside the worktree so explicit stale recovery can distinguish a failed
// teardown from an arbitrary unregistered directory. Any unreadable link or
// failed check refuses the removal.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DIAGNOSTIC_PREFIX = 'safe-worktree-remove';
export const RECOVERY_FLAG = '--recover-stale';
const RECOVERY_DIRECTORY = 'printfarmer-worktree-removal';
const RECOVERY_VERSION = 1;

// Stable, distinct identifiers for every refusal this module can throw. Codes
// are API: they must not be renamed or reused for a different cause. Prose in
// the accompanying Error message is free to change; the code is not.
export const ERROR_CODES = Object.freeze({
  IDENTITY_UNRESOLVED: 'EWT_IDENTITY_UNRESOLVED',
  CALLER_INSIDE_TARGET: 'EWT_CALLER_INSIDE_TARGET',
  RECOVERY_TARGET_NOT_DIRECTORY: 'EWT_RECOVERY_TARGET_NOT_DIRECTORY',
  RECEIPT_CREATE_IDENTITY_MISMATCH: 'EWT_RECEIPT_CREATE_IDENTITY_MISMATCH',
  RECEIPT_UNREADABLE: 'EWT_RECEIPT_UNREADABLE',
  RECEIPT_IDENTITY_MISMATCH: 'EWT_RECEIPT_IDENTITY_MISMATCH',
  STALE_REGISTRY_UNRESOLVED: 'EWT_STALE_REGISTRY_UNRESOLVED',
  STALE_STILL_REGISTERED: 'EWT_STALE_STILL_REGISTERED',
  WORKTREE_ROOT_NOT_DIRECTORY: 'EWT_WORKTREE_ROOT_NOT_DIRECTORY',
  REPARSE_TARGET_UNRESOLVED: 'EWT_REPARSE_TARGET_UNRESOLVED',
  TARGET_DISAPPEARED: 'EWT_TARGET_DISAPPEARED',
  TARGET_IDENTITY_CHANGED: 'EWT_TARGET_IDENTITY_CHANGED',
  REPARSE_POINTS_REMAIN: 'EWT_REPARSE_POINTS_REMAIN',
  STALE_DIRECTORY_BECAME_REPARSE_POINT:
    'EWT_STALE_DIRECTORY_BECAME_REPARSE_POINT',
  STALE_REPARSE_POINT_REMAINED: 'EWT_STALE_REPARSE_POINT_REMAINED',
  STALE_UNSUPPORTED_ENTRY: 'EWT_STALE_UNSUPPORTED_ENTRY',
  REGISTRY_UNRESOLVED: 'EWT_REGISTRY_UNRESOLVED',
  NOT_REGISTERED: 'EWT_NOT_REGISTERED',
  AMBIGUOUS_IDENTITY: 'EWT_AMBIGUOUS_IDENTITY',
  MAIN_WORKTREE: 'EWT_MAIN_WORKTREE',
  RECOVERY_WINDOWS_ONLY: 'EWT_RECOVERY_WINDOWS_ONLY',
});

/** Throws an Error carrying a stable `code` alongside its prose message. */
function refuse(code, message) {
  throw Object.assign(new Error(message), { code });
}

function normalizedPath(value, platform = process.platform) {
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPathInside(candidate, parent, platform = process.platform) {
  const relative = path.relative(
    normalizedPath(parent, platform),
    normalizedPath(candidate, platform),
  );
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

export function parseWorktreeList(output) {
  const records = output.split('\0').filter(Boolean);
  return records
    .filter((record) => record.startsWith('worktree '))
    .map((record) => record.slice('worktree '.length));
}

export function listLinkedWorktrees(cwd = process.cwd()) {
  const output = execFileSync(
    'git',
    ['worktree', 'list', '--porcelain', '-z'],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return parseWorktreeList(output);
}

export function filesystemRealpath(platform = process.platform) {
  return platform === 'win32' ? realpathSync.native : realpathSync;
}

function resolveFilesystemPath(
  value,
  platform,
  realpathImpl = filesystemRealpath(platform),
) {
  try {
    return realpathImpl(value);
  } catch (error) {
    refuse(
      ERROR_CODES.IDENTITY_UNRESOLVED,
      `${DIAGNOSTIC_PREFIX}: refusing because filesystem identity cannot be resolved for ${value}\n${String(error)}`,
    );
  }
}

// `realpathSync.native` canonicalises a path within its own filesystem
// namespace (drive letter, UNC, `\\?\` extended-length) but does not fold one
// namespace onto another. Two spellings of the same physical directory — a
// drive-letter path and its `\\localhost\<drive>$\...` UNC admin-share
// equivalent — therefore canonicalise to different strings even though they
// name the same device/inode. Comparing device and inode identity (already
// used elsewhere in this module, e.g. the recovery receipt) is
// namespace-independent, so it catches that case where string comparison
// cannot. Returns null, rather than throwing, when identity cannot be read:
// this is an additional check layered on top of the lexical comparison, so a
// failure here must not mask the lexical result or newly refuse a caller the
// lexical check would have allowed.
function tryFilesystemIdentity(resolvedPath) {
  try {
    const stats = statSync(resolvedPath, { bigint: true });
    return `${stats.dev.toString()}/${stats.ino.toString()}`;
  } catch {
    return null;
  }
}

// Walks from `candidate` up to its filesystem root, comparing device/inode
// identity against `parent` at each level. This mirrors `isPathInside` but is
// robust to `candidate` and `parent` being canonicalised in different
// namespaces (e.g. one is a UNC admin-share spelling and the other a drive
// letter), where lexical prefix/ancestor comparison cannot detect containment.
function isPathInsideByIdentity(candidate, parentIdentity) {
  if (parentIdentity === null) return false;
  let current = candidate;
  for (;;) {
    const ancestor = path.dirname(current);
    if (ancestor === current) return false;
    current = ancestor;
    if (tryFilesystemIdentity(current) === parentIdentity) return true;
  }
}

export function validateCallerLocation(
  cwd,
  target,
  platform = process.platform,
  realpathImpl = filesystemRealpath(platform),
) {
  const resolvedCwd = resolveFilesystemPath(cwd, platform, realpathImpl);
  const resolvedTarget = resolveFilesystemPath(target, platform, realpathImpl);
  const lexicalEqual =
    normalizedPath(resolvedCwd, platform) ===
    normalizedPath(resolvedTarget, platform);
  const lexicalInside =
    !lexicalEqual && isPathInside(resolvedCwd, resolvedTarget, platform);
  // Cross-namespace identity (UNC vs. drive letter) is a Windows-specific
  // aliasing vector, so this extra check is scoped to platform === 'win32'
  // to avoid statting synthetic/non-filesystem-backed paths used by
  // cross-platform unit tests and callers on POSIX, where realpath already
  // canonicalises to a single namespace.
  let identityEqual = false;
  let identityInside = false;
  if (!lexicalEqual && !lexicalInside && platform === 'win32') {
    const targetIdentity = tryFilesystemIdentity(resolvedTarget);
    identityEqual =
      targetIdentity !== null &&
      tryFilesystemIdentity(resolvedCwd) === targetIdentity;
    identityInside =
      !identityEqual && isPathInsideByIdentity(resolvedCwd, targetIdentity);
  }
  if (lexicalEqual || lexicalInside || identityEqual || identityInside) {
    refuse(
      ERROR_CODES.CALLER_INSIDE_TARGET,
      `${DIAGNOSTIC_PREFIX}: refusing because the current directory is inside the worktree being removed: ${cwd}`,
    );
  }
}

export function gitCommonDirectory(cwd = process.cwd()) {
  return execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function recoveryReceiptPath(commonDirectory, targetPath) {
  const key = createHash('sha256')
    .update(normalizedPath(targetPath, 'win32'))
    .digest('hex');
  return path.join(commonDirectory, RECOVERY_DIRECTORY, `${key}.json`);
}

export function createRecoveryReceipt(
  repository,
  target,
  {
    commonDirectory = gitCommonDirectory(repository),
    realpathImpl = realpathSync.native,
  } = {},
) {
  const resolvedCommonDirectory = resolveFilesystemPath(
    commonDirectory,
    'win32',
    realpathImpl,
  );
  const resolvedTarget = resolveFilesystemPath(target, 'win32', realpathImpl);
  const targetStats = lstatSync(resolvedTarget, { bigint: true });
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    refuse(
      ERROR_CODES.RECOVERY_TARGET_NOT_DIRECTORY,
      `${DIAGNOSTIC_PREFIX}: recovery target must be a real directory: ${target}`,
    );
  }

  const receiptPath = recoveryReceiptPath(
    resolvedCommonDirectory,
    resolvedTarget,
  );
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  if (existsSync(receiptPath)) {
    const existing = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (
      existing.version === RECOVERY_VERSION &&
      normalizedPath(existing.commonDirectory, 'win32') ===
        normalizedPath(resolvedCommonDirectory, 'win32') &&
      normalizedPath(existing.targetPath, 'win32') ===
        normalizedPath(resolvedTarget, 'win32') &&
      existing.targetDev === targetStats.dev.toString() &&
      existing.targetIno === targetStats.ino.toString()
    ) {
      return receiptPath;
    }
    refuse(
      ERROR_CODES.RECEIPT_CREATE_IDENTITY_MISMATCH,
      `${DIAGNOSTIC_PREFIX}: refusing because an existing recovery receipt has different filesystem identity: ${receiptPath}`,
    );
  }
  writeFileSync(
    receiptPath,
    `${JSON.stringify(
      {
        version: RECOVERY_VERSION,
        commonDirectory: resolvedCommonDirectory,
        targetPath: resolvedTarget,
        targetDev: targetStats.dev.toString(),
        targetIno: targetStats.ino.toString(),
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  return receiptPath;
}

export function removeRecoveryReceipt(receiptPath) {
  if (!receiptPath || !existsSync(receiptPath)) return;
  unlinkSync(receiptPath);
}

export function readRecoveryReceipt(repository, target, realpathImpl) {
  const commonDirectory = resolveFilesystemPath(
    gitCommonDirectory(repository),
    'win32',
    realpathImpl,
  );
  const resolvedTarget = resolveFilesystemPath(target, 'win32', realpathImpl);
  const receiptPath = recoveryReceiptPath(commonDirectory, resolvedTarget);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    refuse(
      ERROR_CODES.RECEIPT_UNREADABLE,
      `${DIAGNOSTIC_PREFIX}: refusing ambiguous stale recovery; no readable identity receipt exists for ${target}\n${String(error)}`,
    );
  }

  const targetStats = lstatSync(resolvedTarget, { bigint: true });
  if (
    receipt.version !== RECOVERY_VERSION ||
    normalizedPath(receipt.commonDirectory, 'win32') !==
      normalizedPath(commonDirectory, 'win32') ||
    normalizedPath(receipt.targetPath, 'win32') !==
      normalizedPath(resolvedTarget, 'win32') ||
    receipt.targetDev !== targetStats.dev.toString() ||
    receipt.targetIno !== targetStats.ino.toString()
  ) {
    refuse(
      ERROR_CODES.RECEIPT_IDENTITY_MISMATCH,
      `${DIAGNOSTIC_PREFIX}: refusing ambiguous stale recovery because the identity receipt does not match ${target}`,
    );
  }
  return { receiptPath, resolvedTarget };
}

export function validateStaleRecoveryTarget(
  target,
  worktrees,
  realpathImpl = realpathSync.native,
) {
  const resolvedTarget = resolveFilesystemPath(target, 'win32', realpathImpl);
  for (const worktree of worktrees) {
    let resolvedWorktree;
    try {
      resolvedWorktree = realpathImpl(worktree);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      refuse(
        ERROR_CODES.STALE_REGISTRY_UNRESOLVED,
        `${DIAGNOSTIC_PREFIX}: refusing ambiguous stale recovery because registered worktree identity cannot be resolved for ${worktree}\n${String(error)}`,
      );
    }
    if (
      normalizedPath(resolvedWorktree, 'win32') ===
      normalizedPath(resolvedTarget, 'win32')
    ) {
      refuse(
        ERROR_CODES.STALE_STILL_REGISTERED,
        `${DIAGNOSTIC_PREFIX}: refusing stale recovery because the path is still a registered worktree: ${target}`,
      );
    }
  }
  return resolvedTarget;
}

function cleanupReceipt(receiptPath, removeReceipt, writeStderr, completed) {
  try {
    removeReceipt(receiptPath);
  } catch (error) {
    writeStderr(
      `[${DIAGNOSTIC_PREFIX}] WARNING: recovery receipt cleanup failed ${completed ? 'after removal completed' : 'while refusing removal'}: ${String(error)}\n`,
    );
  }
}

function targetKind(stats) {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'other';
}

/**
 * Enumerates links without traversing them. On Windows, Node reports NTFS
 * junctions and directory symbolic links through lstat().isSymbolicLink().
 */
export function findReparsePoints(worktreePath) {
  const rootStats = lstatSync(worktreePath);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    refuse(
      ERROR_CODES.WORKTREE_ROOT_NOT_DIRECTORY,
      `${DIAGNOSTIC_PREFIX}: worktree root must be a real directory: ${worktreePath}`,
    );
  }

  const found = [];
  const pending = [worktreePath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const entryStats = lstatSync(entryPath);
      if (entryStats.isSymbolicLink()) {
        found.push(entryPath);
      } else if (entryStats.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
  return found.sort();
}

function describeReparsePoint(linkPath, worktreePath) {
  let targetPath;
  let stats;
  try {
    targetPath = realpathSync(linkPath);
    stats = lstatSync(targetPath, { bigint: true });
  } catch (error) {
    refuse(
      ERROR_CODES.REPARSE_TARGET_UNRESOLVED,
      `${DIAGNOSTIC_PREFIX}: refusing because reparse target cannot be resolved: ${linkPath}\n${String(error)}`,
    );
  }

  return {
    linkPath,
    targetPath,
    targetDev: stats.dev,
    targetIno: stats.ino,
    targetKind: targetKind(stats),
    external: !isPathInside(targetPath, worktreePath),
  };
}

function verifyTarget(point) {
  let stats;
  try {
    stats = lstatSync(point.targetPath, { bigint: true });
  } catch (error) {
    refuse(
      ERROR_CODES.TARGET_DISAPPEARED,
      `${DIAGNOSTIC_PREFIX}: target disappeared after unlinking ${point.linkPath}: ${point.targetPath}\n${String(error)}`,
    );
  }

  if (
    stats.dev !== point.targetDev ||
    stats.ino !== point.targetIno ||
    targetKind(stats) !== point.targetKind
  ) {
    refuse(
      ERROR_CODES.TARGET_IDENTITY_CHANGED,
      `${DIAGNOSTIC_PREFIX}: target identity changed after unlinking ${point.linkPath}: ${point.targetPath}`,
    );
  }
}

export function prepareWindowsWorktreeForRemoval(worktreePath) {
  const points = findReparsePoints(worktreePath).map((linkPath) =>
    describeReparsePoint(linkPath, worktreePath),
  );

  for (const point of points) {
    if (point.targetKind === 'directory') {
      rmdirSync(point.linkPath);
    } else {
      unlinkSync(point.linkPath);
    }
    verifyTarget(point);
  }

  const remaining = findReparsePoints(worktreePath);
  if (remaining.length > 0) {
    refuse(
      ERROR_CODES.REPARSE_POINTS_REMAIN,
      `${DIAGNOSTIC_PREFIX}: refusing because reparse points remain:\n${remaining.join('\n')}`,
    );
  }

  return {
    unlinked: points.map((point) => point.linkPath),
    externalTargets: points
      .filter((point) => point.external)
      .map((point) => point.targetPath),
  };
}

function planStaleDirectoryRemoval(root) {
  const files = [];
  const directories = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const directoryStats = lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      refuse(
        ERROR_CODES.STALE_DIRECTORY_BECAME_REPARSE_POINT,
        `${DIAGNOSTIC_PREFIX}: refusing stale recovery because a directory became a reparse point or changed type: ${directory}`,
      );
    }
    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stats = lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        refuse(
          ERROR_CODES.STALE_REPARSE_POINT_REMAINED,
          `${DIAGNOSTIC_PREFIX}: refusing stale recovery because a reparse point remained: ${entryPath}`,
        );
      }
      if (stats.isDirectory()) {
        pending.push(entryPath);
      } else if (stats.isFile()) {
        files.push(entryPath);
      } else {
        refuse(
          ERROR_CODES.STALE_UNSUPPORTED_ENTRY,
          `${DIAGNOSTIC_PREFIX}: refusing stale recovery because an unsupported filesystem entry remained: ${entryPath}`,
        );
      }
    }
  }
  return {
    files,
    directories: directories.sort(
      (left, right) =>
        right.split(path.sep).length - left.split(path.sep).length,
    ),
  };
}

export function removeStaleDirectory(root) {
  const plan = planStaleDirectoryRemoval(root);
  for (const file of plan.files) unlinkSync(file);
  for (const directory of plan.directories) rmdirSync(directory);
}

export function validateRemovalTarget(
  target,
  worktrees,
  platform = process.platform,
  realpathImpl = filesystemRealpath(platform),
) {
  const resolvedTarget = resolveFilesystemPath(target, platform, realpathImpl);
  const matches = [];
  for (const [index, worktree] of worktrees.entries()) {
    let resolvedWorktree;
    try {
      resolvedWorktree = realpathImpl(worktree);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      refuse(
        ERROR_CODES.REGISTRY_UNRESOLVED,
        `${DIAGNOSTIC_PREFIX}: refusing because registered worktree identity cannot be resolved for ${worktree}\n${String(error)}`,
      );
    }
    if (
      normalizedPath(resolvedWorktree, platform) ===
      normalizedPath(resolvedTarget, platform)
    ) {
      matches.push({ index, resolvedWorktree });
    }
  }
  if (matches.length === 0) {
    refuse(
      ERROR_CODES.NOT_REGISTERED,
      `${DIAGNOSTIC_PREFIX}: refusing because this is not a registered linked worktree: ${target}`,
    );
  }
  if (matches.length > 1) {
    refuse(
      ERROR_CODES.AMBIGUOUS_IDENTITY,
      `${DIAGNOSTIC_PREFIX}: refusing because multiple registered worktrees resolve to the same filesystem identity: ${target}`,
    );
  }
  const [match] = matches;
  if (match.index === 0) {
    // git-worktree(1) defines the main worktree as the first list entry, followed
    // by linked worktrees. The integration test pins that ordering against Git.
    refuse(
      ERROR_CODES.MAIN_WORKTREE,
      `${DIAGNOSTIC_PREFIX}: refusing to remove the repository's main worktree: ${target}`,
    );
  }
  return match.resolvedWorktree;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] !== RECOVERY_FLAG) {
    return { mode: 'remove', target: argv[0] };
  }
  if (argv.length === 2 && argv[0] === RECOVERY_FLAG) {
    return { mode: 'recover', target: argv[1] };
  }
  return null;
}

export function main(
  argv,
  {
    cwd = process.cwd(),
    platform = process.platform,
    listWorktrees = listLinkedWorktrees,
    prepareWindows = prepareWindowsWorktreeForRemoval,
    createReceipt = createRecoveryReceipt,
    removeReceipt = removeRecoveryReceipt,
    readReceipt = readRecoveryReceipt,
    removeStale = removeStaleDirectory,
    realpathImpl = filesystemRealpath(platform),
    runGit = (repository, target) =>
      spawnSync('git', ['worktree', 'remove', '--force', target], {
        cwd: repository,
        encoding: 'utf8',
      }),
    writeStdout = (message) => process.stdout.write(message),
    writeStderr = (message) => process.stderr.write(message),
  } = {},
) {
  const options = parseArgs(argv);
  if (!options) {
    writeStderr(
      [
        'Usage:',
        '  npm run worktree:remove -- <registered-linked-worktree-path>',
        `  npm run worktree:remove -- ${RECOVERY_FLAG} <stale-worktree-path>`,
        '',
      ].join('\n'),
    );
    return 2;
  }

  const requestedTarget = path.resolve(cwd, options.target);
  let receiptPath = null;
  let gitStarted = false;
  try {
    const worktrees = listWorktrees(cwd);

    if (options.mode === 'recover') {
      if (platform !== 'win32') {
        refuse(
          ERROR_CODES.RECOVERY_WINDOWS_ONLY,
          `${DIAGNOSTIC_PREFIX}: ${RECOVERY_FLAG} is restricted to Windows`,
        );
      }
      validateCallerLocation(cwd, requestedTarget, platform, realpathImpl);
      validateStaleRecoveryTarget(requestedTarget, worktrees, realpathImpl);
      const receipt = readReceipt(cwd, requestedTarget, realpathImpl);
      const prepared = prepareWindows(receipt.resolvedTarget);
      removeStale(receipt.resolvedTarget);
      cleanupReceipt(receipt.receiptPath, removeReceipt, writeStderr, true);
      writeStdout(
        `[${DIAGNOSTIC_PREFIX}] recovered stale worktree; unlinked ${prepared.unlinked.length} reparse point(s), verified ${prepared.externalTargets.length} external target(s), and removed ${receipt.resolvedTarget}.\n`,
      );
      return 0;
    }

    const target = validateRemovalTarget(
      requestedTarget,
      worktrees,
      platform,
      realpathImpl,
    );
    validateCallerLocation(cwd, target, platform, realpathImpl);
    if (platform === 'win32') {
      receiptPath = createReceipt(cwd, target, { realpathImpl });
      const prepared = prepareWindows(target);
      writeStdout(
        `[${DIAGNOSTIC_PREFIX}] unlinked ${prepared.unlinked.length} reparse point(s); verified ${prepared.externalTargets.length} external target(s) remain.\n`,
      );
    }

    gitStarted = true;
    const result = runGit(cwd, target);
    if (result.stdout) writeStdout(result.stdout);
    if (result.stderr) writeStderr(result.stderr);
    if (result.error) throw result.error;
    const status = result.status ?? 1;
    if (status === 0) {
      cleanupReceipt(receiptPath, removeReceipt, writeStderr, true);
    } else if (receiptPath) {
      writeStderr(
        `[${DIAGNOSTIC_PREFIX}] Git failed after preflight. If the worktree is no longer registered, recover only with:\n  npm run worktree:remove -- ${RECOVERY_FLAG} "${target}"\n`,
      );
    }
    return status;
  } catch (error) {
    if (receiptPath && !gitStarted) {
      cleanupReceipt(receiptPath, removeReceipt, writeStderr, false);
    }
    const code = error?.code;
    const prefix =
      typeof code === 'string' && code.startsWith('EWT_') ? `[${code}] ` : '';
    writeStderr(`${prefix}${String(error)}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
