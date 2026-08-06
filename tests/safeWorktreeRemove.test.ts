// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DIAGNOSTIC_PREFIX,
  RECOVERY_FLAG,
  createRecoveryReceipt,
  listLinkedWorktrees,
  main,
  prepareWindowsWorktreeForRemoval,
  validateCallerLocation,
  validateRemovalTarget,
  validateStaleRecoveryTarget,
} from '../scripts/safe-worktree-remove.mjs';

const SENTINEL_COUNT = 12;
const onWindows = process.platform === 'win32';
const gitVersion = onWindows
  ? spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim()
  : '';
const unitRepository = path.resolve('unit-repository');
const unitLinkedWorktree = path.resolve('unit-linked-worktree');
const unitStaleWorktree = path.resolve('unit-stale-worktree');
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

function unlinkJunction(junction: string) {
  try {
    if (!lstatSync(junction).isSymbolicLink()) return;
  } catch {
    return;
  }
  execFileSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', 'rmdir', junction],
    { stdio: 'ignore' },
  );
}

function registeredWorktree(repository: string, worktree: string) {
  const expected = path.resolve(worktree).toLowerCase();
  return listLinkedWorktrees(repository).some(
    (entry) => path.resolve(entry).toLowerCase() === expected,
  );
}

function pathIsAbsent(target: string) {
  try {
    lstatSync(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

interface RawRemovalState {
  gitVersion: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  targetCount: number | null;
  junctionAbsent: boolean;
  worktreeAbsent: boolean;
  registered: boolean;
}

function rawRemovalContext(state: RawRemovalState) {
  return [
    state.gitVersion,
    `exit=${String(state.status)}`,
    `signal=${state.signal ?? '<none>'}`,
    `error=${state.error ?? '<none>'}`,
    `sentinels=${String(state.targetCount)}/${SENTINEL_COUNT}`,
    `junctionAbsent=${String(state.junctionAbsent)}`,
    `worktreeAbsent=${String(state.worktreeAbsent)}`,
    `registered=${String(state.registered)}`,
  ].join('; ');
}

function classifyRawRemoval(state: RawRemovalState) {
  const completeRemoval =
    state.status === 0 &&
    state.signal === null &&
    state.error === null &&
    state.junctionAbsent &&
    state.worktreeAbsent &&
    !state.registered;
  if (!completeRemoval) {
    throw new Error(
      `unknown raw Git removal state: ${rawRemovalContext(state)}`,
    );
  }
  if (state.targetCount === 0) return 'vulnerable' as const;
  if (state.targetCount === SENTINEL_COUNT) return 'fixed' as const;
  throw new Error(`unknown raw Git removal state: ${rawRemovalContext(state)}`);
}

function removeFixtureWorktreeAdmin(worktree: string) {
  const pointer = readFileSync(path.join(worktree, '.git'), 'utf8').trim();
  expect(pointer.startsWith('gitdir: ')).toBe(true);
  const admin = pointer.slice('gitdir: '.length);
  rmSync(admin, { recursive: true, force: true });
}

function availableSubstDrive() {
  for (const letter of ['Z', 'Y', 'X', 'W', 'V']) {
    if (!existsSync(`${letter}:\\`)) return letter;
  }
  throw new Error('no free drive letter is available for the subst fixture');
}

describe('safe worktree removal validation', () => {
  const completeRawState = {
    gitVersion: 'git version fixture',
    status: 0,
    signal: null,
    error: null,
    junctionAbsent: true,
    worktreeAbsent: true,
    registered: false,
  } satisfies Omit<RawRemovalState, 'targetCount'>;

  it('classifies both supported complete raw Git outcomes', () => {
    expect(classifyRawRemoval({ ...completeRawState, targetCount: 0 })).toBe(
      'vulnerable',
    );
    expect(
      classifyRawRemoval({
        ...completeRawState,
        targetCount: SENTINEL_COUNT,
      }),
    ).toBe('fixed');
  });

  it('rejects partial counts and inconsistent raw Git removal states', () => {
    const ambiguous: RawRemovalState[] = [
      { ...completeRawState, targetCount: 6 },
      { ...completeRawState, targetCount: 0, status: 1 },
      { ...completeRawState, targetCount: 0, signal: 'SIGTERM' },
      { ...completeRawState, targetCount: 0, junctionAbsent: false },
      { ...completeRawState, targetCount: 0, worktreeAbsent: false },
      { ...completeRawState, targetCount: 0, registered: true },
      { ...completeRawState, targetCount: null },
    ];
    for (const state of ambiguous) {
      expect(() => classifyRawRemoval(state)).toThrow(
        'unknown raw Git removal state',
      );
    }
  });

  it('refuses a path absent from the linked-worktree registry', () => {
    expect(() =>
      validateRemovalTarget(
        path.resolve('unit-outside'),
        [unitRepository],
        'win32',
      ),
    ).toThrow('not a registered linked worktree');
  });

  it('refuses the main worktree instead of treating it as removable', () => {
    expect(() =>
      validateRemovalTarget(
        unitRepository,
        [unitRepository, unitLinkedWorktree],
        'win32',
      ),
    ).toThrow("repository's main worktree");
  });

  it('does not invoke git when Windows preflight refuses', () => {
    const runGit = vi.fn(() => ({ stdout: '', stderr: '', status: 0 }));
    const removeReceipt = vi.fn();
    const stderr: string[] = [];
    const status = main([unitLinkedWorktree], {
      cwd: unitRepository,
      platform: 'win32',
      listWorktrees: () => [unitRepository, unitLinkedWorktree],
      prepareWindows: () => {
        throw new Error(`${DIAGNOSTIC_PREFIX}: unresolved reparse point`);
      },
      createReceipt: () => path.resolve('unit-receipt.json'),
      removeReceipt,
      realpathImpl: (value) => value,
      runGit,
      writeStdout: () => undefined,
      writeStderr: (message) => stderr.push(message),
    });

    expect(status).toBe(1);
    expect(runGit).not.toHaveBeenCalled();
    expect(removeReceipt).toHaveBeenCalledWith(
      path.resolve('unit-receipt.json'),
    );
    expect(stderr.join('')).toContain('unresolved reparse point');
  });

  it.each([unitLinkedWorktree, path.join(unitLinkedWorktree, 'nested')])(
    'refuses caller location %s before Windows preflight',
    (cwd) => {
      const prepareWindows = vi.fn();
      const runGit = vi.fn(() => ({ stdout: '', stderr: '', status: 0 }));
      const stderr: string[] = [];
      const status = main([unitLinkedWorktree], {
        cwd,
        platform: 'win32',
        listWorktrees: () => [unitRepository, unitLinkedWorktree],
        prepareWindows,
        realpathImpl: (value) => value,
        runGit,
        writeStdout: () => undefined,
        writeStderr: (message) => stderr.push(message),
      });

      expect(status).toBe(1);
      expect(prepareWindows).not.toHaveBeenCalled();
      expect(runGit).not.toHaveBeenCalled();
      expect(stderr.join('')).toContain(
        'current directory is inside the worktree being removed',
      );
    },
  );

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

  it('fails closed when native identity resolution fails', () => {
    expect(() =>
      validateCallerLocation('C:\\alias', 'C:\\target', 'win32', () => {
        throw new Error('identity unavailable');
      }),
    ).toThrow('filesystem identity cannot be resolved');
  });

  it('ignores only missing unrelated registry entries during stale recovery', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const realpathImpl = vi.fn((value: string) => {
      if (value === 'C:\\missing') throw missing;
      return value;
    });

    expect(
      validateStaleRecoveryTarget(
        'C:\\stale',
        ['C:\\repo', 'C:\\missing'],
        realpathImpl,
      ),
    ).toBe('C:\\stale');

    expect(() =>
      validateStaleRecoveryTarget(
        'C:\\stale',
        ['C:\\repo', 'C:\\unreadable'],
        (value) => {
          if (value === 'C:\\unreadable') {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          return value;
        },
      ),
    ).toThrow('registered worktree identity cannot be resolved');
  });

  it('keeps a successful removal status when receipt cleanup fails visibly', () => {
    const stderr: string[] = [];
    const receiptPath = path.resolve('unit-receipt.json');
    const status = main([unitLinkedWorktree], {
      cwd: unitRepository,
      platform: 'win32',
      listWorktrees: () => [unitRepository, unitLinkedWorktree],
      prepareWindows: () => ({ unlinked: [], externalTargets: [] }),
      createReceipt: () => receiptPath,
      removeReceipt: () => {
        throw new Error('receipt locked');
      },
      realpathImpl: (value) => value,
      runGit: () => ({ stdout: '', stderr: '', status: 0 }),
      writeStdout: () => undefined,
      writeStderr: (message) => stderr.push(message),
    });

    expect(status).toBe(0);
    expect(stderr.join('')).toContain(
      'WARNING: recovery receipt cleanup failed after removal completed',
    );
  });

  it('keeps a successful recovery status when receipt cleanup fails visibly', () => {
    const stderr: string[] = [];
    const removeStale = vi.fn();
    const receiptPath = path.resolve('unit-receipt.json');
    const status = main([RECOVERY_FLAG, unitStaleWorktree], {
      cwd: unitRepository,
      platform: 'win32',
      listWorktrees: () => [unitRepository],
      prepareWindows: () => ({ unlinked: [], externalTargets: [] }),
      readReceipt: () => ({
        receiptPath,
        resolvedTarget: unitStaleWorktree,
      }),
      removeReceipt: () => {
        throw new Error('receipt locked');
      },
      removeStale,
      realpathImpl: (value) => value,
      writeStdout: () => undefined,
      writeStderr: (message) => stderr.push(message),
    });

    expect(status).toBe(0);
    expect(removeStale).toHaveBeenCalledWith(unitStaleWorktree);
    expect(stderr.join('')).toContain(
      'WARNING: recovery receipt cleanup failed after removal completed',
    );
  });
});

describe('linked-worktree registry contract', () => {
  it('keeps the main worktree first as required by validateRemovalTarget', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-worktree-order-'));
    const repository = path.join(root, 'repo');
    const linked = path.join(root, 'linked');
    try {
      mkdirSync(repository);
      git(['init', '--initial-branch=development'], repository);
      git(['config', 'user.name', 'Worktree fixture'], repository);
      git(['config', 'user.email', 'fixture@example.invalid'], repository);
      writeFileSync(path.join(repository, 'tracked.txt'), 'fixture\n');
      git(['add', 'tracked.txt'], repository);
      git(['commit', '-m', 'fixture'], repository);
      git(['worktree', 'add', '-b', 'linked', linked], repository);

      expect(
        listLinkedWorktrees(linked).map((entry) => path.resolve(entry)),
      ).toEqual([repository, linked]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!onWindows)(
  'Windows Git junction teardown observed-behavior regression (#546)',
  () => {
    it('classifies the complete raw Git result as vulnerable or fixed', () => {
      const root = mkdtempSync(
        path.join(os.tmpdir(), 'pfd-junction-teardown-'),
      );
      let raw: ReturnType<typeof makeArm> | null = null;
      try {
        raw = makeArm(root, 'raw');

        const rawRemoval = spawnSync(
          'git',
          ['worktree', 'remove', '--force', raw.worktree],
          { cwd: raw.repository, encoding: 'utf8' },
        );
        const state: RawRemovalState = {
          gitVersion,
          status: rawRemoval.status,
          signal: rawRemoval.signal,
          error: rawRemoval.error ? String(rawRemoval.error) : null,
          targetCount: existsSync(raw.target)
            ? readdirSync(raw.target).length
            : null,
          junctionAbsent: pathIsAbsent(raw.junction),
          worktreeAbsent: pathIsAbsent(raw.worktree),
          registered: registeredWorktree(raw.repository, raw.worktree),
        };
        const outcome = classifyRawRemoval(state);
        console.info(
          `[junction-teardown raw outcome] ${outcome}; ${rawRemovalContext(state)}`,
        );
      } finally {
        if (raw) {
          unlinkJunction(raw.junction);
          if (registeredWorktree(raw.repository, raw.worktree)) {
            git(
              ['worktree', 'remove', '--force', raw.worktree],
              raw.repository,
            );
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('always verifies guarded removal with all 12 sentinels surviving', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-guarded-teardown-'));
      let guarded: ReturnType<typeof makeArm> | null = null;
      try {
        guarded = makeArm(root, 'guarded');
        const guardedRemoval = spawnSync(
          process.execPath,
          [scriptPath, guarded.worktree],
          { cwd: guarded.repository, encoding: 'utf8' },
        );
        expect(guardedRemoval.error).toBeUndefined();
        expect(guardedRemoval.signal).toBeNull();
        expect(guardedRemoval.status).toBe(0);
        expect(guardedRemoval.stdout).toContain(
          'unlinked 1 reparse point(s); verified 1 external target(s) remain',
        );
        expect(existsSync(guarded.junction)).toBe(false);
        expect(existsSync(guarded.worktree)).toBe(false);
        expect(readdirSync(guarded.target)).toHaveLength(SENTINEL_COUNT);
        expect(registeredWorktree(guarded.repository, guarded.worktree)).toBe(
          false,
        );
      } finally {
        if (guarded) {
          unlinkJunction(guarded.junction);
          if (registeredWorktree(guarded.repository, guarded.worktree)) {
            git(
              ['worktree', 'remove', '--force', guarded.worktree],
              guarded.repository,
            );
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(!onWindows)('Windows junction removal guard', () => {
  it('uses native identity for case, separators, extended paths, and prefix siblings', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-native-paths-'));
    const target = path.join(root, 'worktree');
    const child = path.join(target, 'nested');
    const sibling = `${target}-sibling`;
    mkdirSync(child, { recursive: true });
    mkdirSync(sibling);
    try {
      const targetForms = [
        target.toUpperCase(),
        `${target}${path.sep}`,
        target.replaceAll('\\', '/'),
        `\\\\?\\${target}`,
      ];
      for (const targetForm of targetForms) {
        expect(() =>
          validateCallerLocation(child, targetForm, 'win32'),
        ).toThrow('current directory is inside');
      }
      expect(() =>
        validateCallerLocation(sibling, target, 'win32'),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('refuses invocation from inside the target without unlinking the junction', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-junction-cwd-'));
    try {
      const arm = makeArm(root, 'caller');
      const removal = spawnSync(process.execPath, [scriptPath, arm.worktree], {
        cwd: arm.worktree,
        encoding: 'utf8',
      });

      expect(removal.status).toBe(1);
      expect(removal.stderr).toContain(
        'current directory is inside the worktree being removed',
      );
      expect(lstatSync(arm.junction).isSymbolicLink()).toBe(true);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);
      expect(existsSync(arm.worktree)).toBe(true);

      execFileSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', 'rmdir', arm.junction],
        { stdio: 'ignore' },
      );
      git(['worktree', 'remove', '--force', arm.worktree], arm.repository);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a junction-alias cwd before preflight or git', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-junction-alias-'));
    let alias = '';
    let arm: ReturnType<typeof makeArm> | null = null;
    try {
      arm = makeArm(root, 'junction-alias');
      alias = path.join(root, 'caller-alias');
      execFileSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', 'mklink', '/J', alias, arm.worktree],
        { stdio: 'ignore' },
      );

      const removal = spawnSync(process.execPath, [scriptPath, arm.worktree], {
        cwd: alias,
        encoding: 'utf8',
      });

      expect(removal.status).toBe(1);
      expect(removal.stderr).toContain(
        'current directory is inside the worktree being removed',
      );
      expect(lstatSync(arm.junction).isSymbolicLink()).toBe(true);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);
      expect(existsSync(arm.worktree)).toBe(true);
      expect(registeredWorktree(arm.repository, arm.worktree)).toBe(true);
    } finally {
      unlinkJunction(alias);
      if (arm) {
        unlinkJunction(arm.junction);
        if (registeredWorktree(arm.repository, arm.worktree)) {
          git(['worktree', 'remove', '--force', arm.worktree], arm.repository);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a subst cwd before preflight or git and removes the mapping', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-subst-alias-'));
    const drive = availableSubstDrive();
    let mapped = false;
    let arm: ReturnType<typeof makeArm> | null = null;
    try {
      arm = makeArm(root, 'subst-alias');
      execFileSync('subst', [`${drive}:`, arm.worktree], { stdio: 'ignore' });
      mapped = true;

      const removal = spawnSync(process.execPath, [scriptPath, arm.worktree], {
        cwd: `${drive}:\\`,
        encoding: 'utf8',
      });

      expect(removal.status).toBe(1);
      expect(removal.stderr).toContain(
        'current directory is inside the worktree being removed',
      );
      expect(lstatSync(arm.junction).isSymbolicLink()).toBe(true);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);
      expect(existsSync(arm.worktree)).toBe(true);
      expect(registeredWorktree(arm.repository, arm.worktree)).toBe(true);
    } finally {
      if (mapped) execFileSync('subst', [`${drive}:`, '/d']);
      expect(existsSync(`${drive}:\\`)).toBe(false);
      if (arm) {
        unlinkJunction(arm.junction);
        if (registeredWorktree(arm.repository, arm.worktree)) {
          git(['worktree', 'remove', '--force', arm.worktree], arm.repository);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!onWindows)('Windows stale worktree recovery', () => {
  it('uses an identity receipt to remove only a deregistered stale worktree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-stale-recovery-'));
    let arm: ReturnType<typeof makeArm> | null = null;
    try {
      arm = makeArm(root, 'recoverable');
      const receipt = createRecoveryReceipt(arm.repository, arm.worktree);
      expect(existsSync(receipt)).toBe(true);
      const recordedIdentity = JSON.parse(readFileSync(receipt, 'utf8')) as {
        targetDev: string;
        targetIno: string;
      };
      const liveIdentity = lstatSync(arm.worktree, { bigint: true });
      expect(recordedIdentity.targetDev).toBe(liveIdentity.dev.toString());
      expect(recordedIdentity.targetIno).toBe(liveIdentity.ino.toString());
      removeFixtureWorktreeAdmin(arm.worktree);
      expect(registeredWorktree(arm.repository, arm.worktree)).toBe(false);

      const recovery = spawnSync(
        process.execPath,
        [scriptPath, RECOVERY_FLAG, arm.worktree],
        { cwd: arm.repository, encoding: 'utf8' },
      );

      expect(recovery.status).toBe(0);
      expect(recovery.stdout).toContain('recovered stale worktree');
      expect(existsSync(arm.worktree)).toBe(false);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);
      expect(existsSync(receipt)).toBe(false);
    } finally {
      if (arm) unlinkJunction(arm.junction);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an unregistered directory without an identity receipt before preflight', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-stale-ambiguous-'));
    let arm: ReturnType<typeof makeArm> | null = null;
    try {
      arm = makeArm(root, 'ambiguous');
      removeFixtureWorktreeAdmin(arm.worktree);
      expect(registeredWorktree(arm.repository, arm.worktree)).toBe(false);

      const recovery = spawnSync(
        process.execPath,
        [scriptPath, RECOVERY_FLAG, arm.worktree],
        { cwd: arm.repository, encoding: 'utf8' },
      );

      expect(recovery.status).toBe(1);
      expect(recovery.stderr).toContain(
        'refusing ambiguous stale recovery; no readable identity receipt',
      );
      expect(lstatSync(arm.junction).isSymbolicLink()).toBe(true);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);
      expect(existsSync(arm.worktree)).toBe(true);
    } finally {
      if (arm) unlinkJunction(arm.junction);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses recovery of a still-registered linked worktree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-stale-registered-'));
    let arm: ReturnType<typeof makeArm> | null = null;
    try {
      arm = makeArm(root, 'registered');
      const recovery = spawnSync(
        process.execPath,
        [scriptPath, RECOVERY_FLAG, arm.worktree],
        { cwd: arm.repository, encoding: 'utf8' },
      );

      expect(recovery.status).toBe(1);
      expect(recovery.stderr).toContain('path is still a registered worktree');
      expect(lstatSync(arm.junction).isSymbolicLink()).toBe(true);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);
      expect(registeredWorktree(arm.repository, arm.worktree)).toBe(true);
    } finally {
      if (arm) {
        unlinkJunction(arm.junction);
        if (registeredWorktree(arm.repository, arm.worktree)) {
          git(['worktree', 'remove', '--force', arm.worktree], arm.repository);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses recovery of the current main worktree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-stale-main-'));
    const repository = path.join(root, 'repo');
    mkdirSync(repository);
    git(['init', '--initial-branch=development'], repository);
    try {
      const recovery = spawnSync(
        process.execPath,
        [scriptPath, RECOVERY_FLAG, repository],
        { cwd: repository, encoding: 'utf8' },
      );
      expect(recovery.status).toBe(1);
      expect(recovery.stderr).toContain('current directory is inside');
      expect(existsSync(repository)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps recovery receipts when git fails after preflight', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-stale-receipt-'));
    let arm: ReturnType<typeof makeArm> | null = null;
    try {
      arm = makeArm(root, 'receipt');
      const receipt = createRecoveryReceipt(arm.repository, arm.worktree);
      const stderr: string[] = [];
      const status = main([arm.worktree], {
        cwd: arm.repository,
        platform: 'win32',
        runGit: () => ({ stdout: '', stderr: 'git failed\n', status: 255 }),
        writeStdout: () => undefined,
        writeStderr: (message) => stderr.push(message),
      });

      expect(status).toBe(255);
      expect(existsSync(receipt)).toBe(true);
      expect(stderr.join('')).toContain(RECOVERY_FLAG);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);
    } finally {
      if (arm) {
        unlinkJunction(arm.junction);
        if (registeredWorktree(arm.repository, arm.worktree)) {
          git(['worktree', 'remove', '--force', arm.worktree], arm.repository);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
