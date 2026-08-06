// Safely force-removes a linked worktree.
//
// Git for Windows 2.53.0.windows.3 follows NTFS directory junctions while
// removing a worktree and recursively deletes the junction target, even when
// that target is outside the worktree. It then exits 0. The only repository-
// owned force-removal path is therefore this wrapper:
//
//   npm run worktree:remove -- <worktree-path>
//
// On Windows, every symbolic link or junction is resolved before any mutation,
// unlinked without recursion, and its target identity is checked before Git is
// allowed to remove the worktree. Any unreadable link or failed check refuses
// the removal.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DIAGNOSTIC_PREFIX = 'safe-worktree-remove';

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
    stats = lstatSync(targetPath);
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
    stats = lstatSync(point.targetPath);
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
    throw new Error(
      `${DIAGNOSTIC_PREFIX}: refusing to remove the repository's main worktree: ${target}`,
    );
  }
}

export function main(
  argv,
  {
    cwd = process.cwd(),
    platform = process.platform,
    listWorktrees = listLinkedWorktrees,
    prepareWindows = prepareWindowsWorktreeForRemoval,
    runGit = (repository, target) =>
      spawnSync('git', ['worktree', 'remove', '--force', target], {
        cwd: repository,
        encoding: 'utf8',
      }),
    writeStdout = (message) => process.stdout.write(message),
    writeStderr = (message) => process.stderr.write(message),
  } = {},
) {
  if (argv.length !== 1) {
    writeStderr(
      `Usage: npm run worktree:remove -- <registered-linked-worktree-path>\n`,
    );
    return 2;
  }

  const target = path.resolve(cwd, argv[0]);
  try {
    const worktrees = listWorktrees(cwd);
    validateRemovalTarget(target, worktrees, platform);

    if (platform === 'win32') {
      const prepared = prepareWindows(target);
      writeStdout(
        `[${DIAGNOSTIC_PREFIX}] unlinked ${prepared.unlinked.length} reparse point(s); verified ${prepared.externalTargets.length} external target(s) remain.\n`,
      );
    }

    const result = runGit(cwd, target);
    if (result.stdout) writeStdout(result.stdout);
    if (result.stderr) writeStderr(result.stderr);
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
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
