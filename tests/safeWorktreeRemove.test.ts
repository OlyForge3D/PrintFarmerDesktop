// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DIAGNOSTIC_PREFIX,
  main,
  prepareWindowsWorktreeForRemoval,
  validateRemovalTarget,
} from '../scripts/safe-worktree-remove.mjs';

const SENTINEL_COUNT = 12;
const AFFECTED_GIT_VERSION = 'git version 2.53.0.windows.3';
const onWindows = process.platform === 'win32';
const gitVersion = onWindows
  ? spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim()
  : '';
const onAffectedGit = onWindows && gitVersion === AFFECTED_GIT_VERSION;
const scriptPath = path.resolve(
  import.meta.dirname,
  '..',
  'scripts',
  'safe-worktree-remove.mjs',
);

function git(args: string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeArm(root: string, name: string) {
  const repository = path.join(root, `${name}-repo`);
  const worktree = path.join(root, `${name}-worktree`);
  const target = path.join(root, `${name}-shared-target`);
  mkdirSync(repository);
  mkdirSync(target);
  git(['init', '--initial-branch=development'], repository);
  git(['config', 'user.name', 'Junction fixture'], repository);
  git(['config', 'user.email', 'fixture@example.invalid'], repository);
  writeFileSync(path.join(repository, 'tracked.txt'), 'fixture\n');
  git(['add', 'tracked.txt'], repository);
  git(['commit', '-m', 'fixture'], repository);
  git(['worktree', 'add', '-b', name, worktree], repository);

  for (let index = 0; index < SENTINEL_COUNT; index += 1) {
    writeFileSync(path.join(target, `sentinel-${index}.txt`), `${index}\n`);
  }

  const junction = path.join(worktree, 'node_modules');
  execFileSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', 'mklink', '/J', junction, target],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  expect(readdirSync(target)).toHaveLength(SENTINEL_COUNT);
  return { junction, repository, target, worktree };
}

describe('safe worktree removal validation', () => {
  it('refuses a path absent from the linked-worktree registry', () => {
    expect(() =>
      validateRemovalTarget('C:\\outside', ['C:\\repo'], 'win32'),
    ).toThrow('not a registered linked worktree');
  });

  it('refuses the main worktree instead of treating it as removable', () => {
    expect(() =>
      validateRemovalTarget('C:\\repo', ['C:\\repo', 'C:\\linked'], 'win32'),
    ).toThrow("repository's main worktree");
  });

  it('does not invoke git when Windows preflight refuses', () => {
    const runGit = vi.fn(() => ({ stdout: '', stderr: '', status: 0 }));
    const stderr: string[] = [];
    const status = main(['C:\\linked'], {
      cwd: 'C:\\repo',
      platform: 'win32',
      listWorktrees: () => ['C:\\repo', 'C:\\linked'],
      prepareWindows: () => {
        throw new Error(`${DIAGNOSTIC_PREFIX}: unresolved reparse point`);
      },
      runGit,
      writeStdout: () => undefined,
      writeStderr: (message) => stderr.push(message),
    });

    expect(status).toBe(1);
    expect(runGit).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('unresolved reparse point');
  });

  it('leaves non-Windows removal to git without running the NTFS preflight', () => {
    const prepareWindows = vi.fn();
    const runGit = vi.fn(() => ({ stdout: '', stderr: '', status: 0 }));
    const status = main(['/linked'], {
      cwd: '/',
      platform: 'linux',
      listWorktrees: () => ['/repo', '/linked'],
      prepareWindows,
      runGit,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(status).toBe(0);
    expect(prepareWindows).not.toHaveBeenCalled();
    expect(runGit).toHaveBeenCalledWith('/', path.resolve('/linked'));
  });
});

describe.skipIf(!onAffectedGit)(
  `git-for-windows ${AFFECTED_GIT_VERSION} junction teardown regression (#546)`,
  () => {
    it('reproduces target loss in the raw arm and preserves all 12 sentinels through the guarded arm', () => {
      const root = mkdtempSync(
        path.join(os.tmpdir(), 'pfd-junction-teardown-'),
      );
      try {
        const raw = makeArm(root, 'raw');
        const guarded = makeArm(root, 'guarded');

        const rawRemoval = spawnSync(
          'git',
          ['worktree', 'remove', '--force', raw.worktree],
          { cwd: raw.repository, encoding: 'utf8' },
        );
        expect(rawRemoval.status).toBe(0);
        expect(readdirSync(raw.target)).toHaveLength(0);

        const guardedRemoval = spawnSync(
          process.execPath,
          [scriptPath, guarded.worktree],
          { cwd: guarded.repository, encoding: 'utf8' },
        );
        expect(guardedRemoval.status).toBe(0);
        expect(guardedRemoval.stdout).toContain(
          'unlinked 1 reparse point(s); verified 1 external target(s) remain',
        );
        expect(existsSync(guarded.junction)).toBe(false);
        expect(existsSync(guarded.worktree)).toBe(false);
        expect(readdirSync(guarded.target)).toHaveLength(SENTINEL_COUNT);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(!onWindows)('Windows junction removal guard', () => {
  it('verifies target survival after unlink and before git removal', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-junction-order-'));
    try {
      const arm = makeArm(root, 'ordered');
      const prepared = prepareWindowsWorktreeForRemoval(arm.worktree);

      expect(prepared.unlinked).toEqual([arm.junction]);
      expect(prepared.externalTargets).toEqual([arm.target]);
      expect(existsSync(arm.junction)).toBe(false);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);

      git(['worktree', 'remove', '--force', arm.worktree], arm.repository);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a broken junction without starting git removal', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-junction-broken-'));
    try {
      const arm = makeArm(root, 'broken');
      rmSync(arm.target, { recursive: true });

      const removal = spawnSync(process.execPath, [scriptPath, arm.worktree], {
        cwd: arm.repository,
        encoding: 'utf8',
      });

      expect(removal.status).toBe(1);
      expect(removal.stderr).toContain(
        'refusing because reparse target cannot be resolved',
      );
      expect(existsSync(arm.worktree)).toBe(true);
      expect(lstatSync(arm.junction).isSymbolicLink()).toBe(true);

      execFileSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', 'rmdir', arm.junction],
        { stdio: 'ignore' },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
