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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DIAGNOSTIC_PREFIX = 'safe-worktree-remove';
export const RECOVERY_FLAG = '--recover-stale';
const RECOVERY_DIRECTORY = 'printfarmer-worktree-removal';
const RECOVERY_VERSION = 1;

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

function resolveNativePath(value, realpathImpl = realpathSync.native) {
  try {
    return realpathImpl(value);
  } catch (error) {
    throw new Error(
      `${DIAGNOSTIC_PREFIX}: refusing because filesystem identity cannot be resolved for ${value}\n${String(error)}`,
    );
  }
}

export function validateCallerLocation(
  cwd,
  target,
  platform = process.platform,
  realpathImpl = realpathSync.native,
) {
  const resolvedCwd =
    platform === 'win32' ? resolveNativePath(cwd, realpathImpl) : cwd;
  const resolvedTarget =
    platform === 'win32' ? resolveNativePath(target, realpathImpl) : target;
  if (
    normalizedPath(resolvedCwd, platform) ===
      normalizedPath(resolvedTarget, platform) ||
    isPathInside(resolvedCwd, resolvedTarget, platform)
  ) {
    throw new Error(
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
  const resolvedCommonDirectory = resolveNativePath(
    commonDirectory,
    realpathImpl,
  );
  const resolvedTarget = resolveNativePath(target, realpathImpl);
  const targetStats = lstatSync(resolvedTarget, { bigint: true });
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new Error(
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
    throw new Error(
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

function readRecoveryReceipt(repository, target, realpathImpl) {
  const commonDirectory = resolveNativePath(
    gitCommonDirectory(repository),
    realpathImpl,
  );
  const resolvedTarget = resolveNativePath(target, realpathImpl);
  const receiptPath = recoveryReceiptPath(commonDirectory, resolvedTarget);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(
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
    throw new Error(
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
  const resolvedTarget = resolveNativePath(target, realpathImpl);
  for (const worktree of worktrees) {
    let resolvedWorktree;
    try {
      resolvedWorktree = realpathImpl(worktree);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(
        `${DIAGNOSTIC_PREFIX}: refusing ambiguous stale recovery because registered worktree identity cannot be resolved for ${worktree}\n${String(error)}`,
      );
    }
    if (
      normalizedPath(resolvedWorktree, 'win32') ===
      normalizedPath(resolvedTarget, 'win32')
    ) {
      throw new Error(
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
    throw new Error(
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
    throw new Error(
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
    throw new Error(
      `${DIAGNOSTIC_PREFIX}: target disappeared after unlinking ${point.linkPath}: ${point.targetPath}\n${String(error)}`,
    );
  }

  if (
    stats.dev !== point.targetDev ||
    stats.ino !== point.targetIno ||
    targetKind(stats) !== point.targetKind
  ) {
    throw new Error(
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
    throw new Error(
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
      throw new Error(
        `${DIAGNOSTIC_PREFIX}: refusing stale recovery because a directory became a reparse point or changed type: ${directory}`,
      );
    }
    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stats = lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `${DIAGNOSTIC_PREFIX}: refusing stale recovery because a reparse point remained: ${entryPath}`,
        );
      }
      if (stats.isDirectory()) {
        pending.push(entryPath);
      } else if (stats.isFile()) {
        files.push(entryPath);
      } else {
        throw new Error(
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
) {
  const targetKey = normalizedPath(target, platform);
  const index = worktrees.findIndex(
    (worktree) => normalizedPath(worktree, platform) === targetKey,
  );
  if (index < 0) {
    throw new Error(
      `${DIAGNOSTIC_PREFIX}: refusing because this is not a registered linked worktree: ${target}`,
    );
  }
  if (index === 0) {
    // git-worktree(1) defines the main worktree as the first list entry, followed
    // by linked worktrees. The integration test pins that ordering against Git.
    throw new Error(
      `${DIAGNOSTIC_PREFIX}: refusing to remove the repository's main worktree: ${target}`,
    );
  }
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
    realpathImpl = realpathSync.native,
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

  const target = path.resolve(cwd, options.target);
  let receiptPath = null;
  let gitStarted = false;
  try {
    const worktrees = listWorktrees(cwd);

    if (options.mode === 'recover') {
      if (platform !== 'win32') {
        throw new Error(
          `${DIAGNOSTIC_PREFIX}: ${RECOVERY_FLAG} is restricted to Windows`,
        );
      }
      validateCallerLocation(cwd, target, platform, realpathImpl);
      validateStaleRecoveryTarget(target, worktrees, realpathImpl);
      const receipt = readReceipt(cwd, target, realpathImpl);
      const prepared = prepareWindows(receipt.resolvedTarget);
      removeStale(receipt.resolvedTarget);
      cleanupReceipt(receipt.receiptPath, removeReceipt, writeStderr, true);
      writeStdout(
        `[${DIAGNOSTIC_PREFIX}] recovered stale worktree; unlinked ${prepared.unlinked.length} reparse point(s), verified ${prepared.externalTargets.length} external target(s), and removed ${receipt.resolvedTarget}.\n`,
      );
      return 0;
    }

    validateRemovalTarget(target, worktrees, platform);
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
    writeStderr(`${String(error)}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
