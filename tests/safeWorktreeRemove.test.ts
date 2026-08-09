// @vitest-environment node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  DIAGNOSTIC_PREFIX,
  ERROR_CODES,
  RECOVERY_FLAG,
  createRecoveryReceipt,
  filesystemRealpath,
  listLinkedWorktrees,
  main,
  prepareWindowsWorktreeForRemoval,
  readRecoveryReceipt,
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

function worktreeIdentity(value: string) {
  let resolved: string;
  try {
    resolved = filesystemRealpath()(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    resolved = path.resolve(value);
  }
  return onWindows ? resolved.toLowerCase() : resolved;
}

function registeredWorktree(repository: string, worktree: string) {
  const expected = worktreeIdentity(worktree);
  return listLinkedWorktrees(repository).some(
    (entry) => worktreeIdentity(entry) === expected,
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

/**
 * Invokes `fn`, expecting it to throw, and returns the `code` carried by the
 * thrown error. Fails the test if `fn` does not throw, so an assertion using
 * this helper cannot silently pass on an implementation that stopped
 * refusing.
 */
function codeOfThrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  throw new Error('expected function to throw, but it did not');
}

/**
 * Extracts the `[EWT_...]` code prefix `main()` writes to stderr ahead of the
 * refusal's prose, per the `${prefix}${String(error)}` format in its catch
 * handler. Returns undefined when stderr carries no such prefix.
 */
function extractStderrCode(stderr: string): string | undefined {
  return /^\[(EWT_[A-Z_]+)\]/.exec(stderr)?.[1];
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
  const successfulProcess =
    state.status === 0 && state.signal === null && state.error === null;
  const deregistered = !state.registered;
  const completeRemoval =
    successfulProcess &&
    deregistered &&
    state.junctionAbsent &&
    state.worktreeAbsent;
  if (completeRemoval && state.targetCount === 0) {
    return 'vulnerable-complete' as const;
  }
  if (completeRemoval && state.targetCount === SENTINEL_COUNT) {
    return 'target-safe-complete' as const;
  }
  if (
    successfulProcess &&
    deregistered &&
    !state.junctionAbsent &&
    !state.worktreeAbsent &&
    state.targetCount === SENTINEL_COUNT
  ) {
    return 'target-safe-incomplete' as const;
  }
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

// Builds the `\\localhost\<drive>$\...` UNC admin-share spelling of a local
// drive-letter path. Returns null when the path is not drive-letter rooted
// (e.g. already UNC), in which case the caller should treat the vector as
// unreachable.
function uncAdminSharePath(target: string) {
  const parsed = path.parse(target);
  const driveLetter = parsed.root.replace(/[:\\]/g, '');
  if (!/^[a-zA-Z]$/.test(driveLetter)) return null;
  const rest = target.slice(parsed.root.length);
  return `\\\\localhost\\${driveLetter}$\\${rest}`;
}

// Probed once at collection time (not inside a test body) so
// `it.skipIf(!uncAdminShareAvailable)` can report an explicit, visible skip
// in the run summary when the loopback SMB admin share is unreachable (e.g.
// disabled administrative shares, blocked loopback SMB, a restricted CI
// runner). A test body that only warns-and-returns on this condition would
// still report "passed" with zero assertions executed, silently certifying
// the #566 fix without ever exercising it -- `it.skipIf` avoids that by
// making the non-exercise show up as a skipped test, not a passing one.
const uncAdminShareAvailable = (() => {
  if (!onWindows) return false;
  let probeRoot: string | null = null;
  try {
    probeRoot = mkdtempSync(path.join(os.tmpdir(), 'pfd-unc-capability-'));
    const uncProbe = uncAdminSharePath(probeRoot);
    if (!uncProbe) return false;
    return statSync(uncProbe).isDirectory();
  } catch {
    return false;
  } finally {
    if (probeRoot) rmSync(probeRoot, { recursive: true, force: true });
  }
})();
if (onWindows && !uncAdminShareAvailable) {
  console.warn(
    '[safe-worktree-remove #566 UNC regression] the \\\\localhost\\<drive>$ ' +
      'admin share did not resolve to the local volume in this environment ' +
      '(disabled administrative shares, blocked loopback SMB, or a ' +
      'restricted runner). The UNC caller-location regression test is ' +
      'skipped -- see the skipped-test count in the run summary -- rather ' +
      'than passing without exercising the fix.',
  );
}

function windowsShortPath(target: string) {
  const script = path.join(path.dirname(target), '.short-path.cmd');
  writeFileSync(script, '@for %%I in ("%~1") do @echo %%~sI\r\n');
  try {
    return execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/c', script, target],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } finally {
    rmSync(script, { force: true });
  }
}

describe('safe worktree removal validation', () => {
  it('selects native Windows and POSIX filesystem resolvers explicitly', () => {
    expect(filesystemRealpath('win32')).toBe(realpathSync.native);
    expect(filesystemRealpath('darwin')).toBe(realpathSync);
    expect(filesystemRealpath('linux')).toBe(realpathSync);
  });

  it.skipIf(!onWindows)(
    'canonical test identity equates an 8.3 alias without equating distinct directories',
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-test-identity-'));
      const target = path.join(root, 'long-worktree-directory-name');
      const distinct = path.join(root, 'other-worktree-directory-name');
      try {
        mkdirSync(target);
        mkdirSync(distinct);
        const shortTarget = windowsShortPath(target);

        expect(path.resolve(shortTarget).toLowerCase()).not.toBe(
          path.resolve(target).toLowerCase(),
        );
        expect(worktreeIdentity(shortTarget)).toBe(worktreeIdentity(target));
        expect(worktreeIdentity(distinct)).not.toBe(worktreeIdentity(target));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  const completeRawState = {
    gitVersion: 'git version fixture',
    status: 0,
    signal: null,
    error: null,
    junctionAbsent: true,
    worktreeAbsent: true,
    registered: false,
  } satisfies Omit<RawRemovalState, 'targetCount'>;

  it('classifies the supported complete and CI-measured incomplete raw Git outcomes', () => {
    expect(classifyRawRemoval({ ...completeRawState, targetCount: 0 })).toBe(
      'vulnerable-complete',
    );
    expect(
      classifyRawRemoval({
        ...completeRawState,
        targetCount: SENTINEL_COUNT,
      }),
    ).toBe('target-safe-complete');
    expect(
      classifyRawRemoval({
        ...completeRawState,
        targetCount: SENTINEL_COUNT,
        junctionAbsent: false,
        worktreeAbsent: false,
      }),
    ).toBe('target-safe-incomplete');
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
    expect(
      codeOfThrown(() =>
        validateRemovalTarget(
          path.resolve('unit-outside'),
          [unitRepository],
          'win32',
          (value) => value,
        ),
      ),
    ).toBe(ERROR_CODES.NOT_REGISTERED);
  });

  it('refuses the main worktree instead of treating it as removable', () => {
    expect(
      codeOfThrown(() =>
        validateRemovalTarget(
          unitRepository,
          [unitRepository, unitLinkedWorktree],
          'win32',
          (value) => value,
        ),
      ),
    ).toBe(ERROR_CODES.MAIN_WORKTREE);
  });

  it('matches registered and main worktrees by native identity and returns the canonical target', () => {
    const aliases = new Map([
      ['C:\\SHORT\\main', 'C:\\Users\\runneradmin\\main'],
      ['C:\\SHORT\\linked', 'C:\\Users\\runneradmin\\linked'],
      ['C:\\Users\\runneradmin\\main', 'C:\\Users\\runneradmin\\main'],
      ['C:\\Users\\runneradmin\\linked', 'C:\\Users\\runneradmin\\linked'],
    ]);
    const realpathImpl = (value: string) => {
      const resolved = aliases.get(value);
      if (!resolved)
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return resolved;
    };

    expect(
      validateRemovalTarget(
        'C:\\SHORT\\linked',
        ['C:\\Users\\runneradmin\\main', 'C:\\Users\\runneradmin\\linked'],
        'win32',
        realpathImpl,
      ),
    ).toBe('C:\\Users\\runneradmin\\linked');
    expect(
      codeOfThrown(() =>
        validateRemovalTarget(
          'C:\\SHORT\\main',
          ['C:\\Users\\runneradmin\\main', 'C:\\Users\\runneradmin\\linked'],
          'win32',
          realpathImpl,
        ),
      ),
    ).toBe(ERROR_CODES.MAIN_WORKTREE);
  });

  it('skips only missing unrelated registry entries and refuses ambiguous identities', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(
      validateRemovalTarget(
        unitLinkedWorktree,
        [unitRepository, path.resolve('missing-worktree'), unitLinkedWorktree],
        'win32',
        (value) => {
          if (value.includes('missing-worktree')) throw missing;
          return value;
        },
      ),
    ).toBe(unitLinkedWorktree);

    expect(
      codeOfThrown(() =>
        validateRemovalTarget(
          unitLinkedWorktree,
          [unitRepository, unitLinkedWorktree, path.resolve('alias-linked')],
          'win32',
          (value) =>
            value.includes('alias-linked') ? unitLinkedWorktree : value,
        ),
      ),
    ).toBe(ERROR_CODES.AMBIGUOUS_IDENTITY);

    expect(
      codeOfThrown(() =>
        validateRemovalTarget(
          unitLinkedWorktree,
          [
            unitRepository,
            path.resolve('unreadable-worktree'),
            unitLinkedWorktree,
          ],
          'win32',
          (value) => {
            if (value.includes('unreadable-worktree')) {
              throw Object.assign(new Error('denied'), { code: 'EACCES' });
            }
            return value;
          },
        ),
      ),
    ).toBe(ERROR_CODES.REGISTRY_UNRESOLVED);
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
      expect(extractStderrCode(stderr.join(''))).toBe(
        ERROR_CODES.CALLER_INSIDE_TARGET,
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
      realpathImpl: (value) => value,
      runGit,
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(status).toBe(0);
    expect(prepareWindows).not.toHaveBeenCalled();
    expect(runGit).toHaveBeenCalledWith('/', '/linked');
  });

  it('fails closed when native identity resolution fails', () => {
    expect(
      codeOfThrown(() =>
        validateCallerLocation('C:\\alias', 'C:\\target', 'win32', () => {
          throw new Error('identity unavailable');
        }),
      ),
    ).toBe(ERROR_CODES.IDENTITY_UNRESOLVED);
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

    expect(
      codeOfThrown(() =>
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
      ),
    ).toBe(ERROR_CODES.STALE_REGISTRY_UNRESOLVED);
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
        listLinkedWorktrees(linked).map((entry) => worktreeIdentity(entry)),
      ).toEqual([worktreeIdentity(repository), worktreeIdentity(linked)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(onWindows)('POSIX canonical worktree aliases', () => {
  it('matches a symlink target spelling to the canonical registered worktree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-posix-target-alias-'));
    const repository = path.join(root, 'repo');
    const linked = path.join(root, 'linked');
    const alias = path.join(root, 'linked-alias');
    try {
      mkdirSync(repository);
      git(['init', '--initial-branch=development'], repository);
      git(['config', 'user.name', 'Worktree fixture'], repository);
      git(['config', 'user.email', 'fixture@example.invalid'], repository);
      writeFileSync(path.join(repository, 'tracked.txt'), 'fixture\n');
      git(['add', 'tracked.txt'], repository);
      git(['commit', '-m', 'fixture'], repository);
      git(['worktree', 'add', '-b', 'linked', linked], repository);
      symlinkSync(linked, alias, 'dir');

      const removal = spawnSync(process.execPath, [scriptPath, alias], {
        cwd: repository,
        encoding: 'utf8',
      });

      expect(removal.error).toBeUndefined();
      expect(removal.signal).toBeNull();
      expect(removal.status, removal.stderr).toBe(0);
      expect(removal.stderr).not.toContain('not a registered linked worktree');
      expect(pathIsAbsent(linked)).toBe(true);
      expect(
        listLinkedWorktrees(repository).map((entry) => realpathSync(entry)),
      ).toEqual([realpathSync(repository)]);
    } finally {
      rmSync(alias, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses equal and descendant caller aliases by resolved identity', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-posix-caller-alias-'));
    const target = path.join(root, 'target');
    const nested = path.join(target, 'nested');
    const alias = path.join(root, 'target-alias');
    mkdirSync(nested, { recursive: true });
    symlinkSync(target, alias, 'dir');
    try {
      expect(
        codeOfThrown(() =>
          validateCallerLocation(alias, target, process.platform),
        ),
      ).toBe(ERROR_CODES.CALLER_INSIDE_TARGET);
      expect(
        codeOfThrown(() =>
          validateCallerLocation(
            path.join(alias, 'nested'),
            target,
            process.platform,
          ),
        ),
      ).toBe(ERROR_CODES.CALLER_INSIDE_TARGET);
    } finally {
      unlinkSync(alias);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!onWindows)(
  'Windows Git junction teardown observed-behavior regression (#546)',
  () => {
    it('classifies the full raw Git result without equating target survival with complete teardown', () => {
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
        expect(
          codeOfThrown(() =>
            validateCallerLocation(child, targetForm, 'win32'),
          ),
        ).toBe(ERROR_CODES.CALLER_INSIDE_TARGET);
      }
      expect(() =>
        validateCallerLocation(sibling, target, 'win32'),
      ).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!uncAdminShareAvailable)(
    'refuses a UNC admin-share caller aliasing a registered worktree by ' +
      'physical identity (#566)',
    () => {
      // `realpathSync.native` canonicalises within a filesystem namespace but
      // does not fold the UNC admin-share namespace onto the drive-letter
      // namespace for the same physical directory (issue #566, measured
      // vector D). This exercises the real Windows filesystem and cannot be
      // mocked: it needs the loopback SMB admin share (`\\localhost\<drive>$`)
      // to actually resolve to the local volume. `uncAdminShareAvailable` is
      // probed once at collection time, so when that share is disabled or
      // unreachable this test is `skipIf`-skipped -- visible in the run's
      // skipped-test count -- rather than executing a body that would pass
      // vacuously with no assertions run.
      const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-unc-caller-'));
      const target = path.join(root, 'worktree');
      const unrelated = path.join(root, 'unrelated');
      mkdirSync(target);
      mkdirSync(unrelated);
      const uncTarget = uncAdminSharePath(target);
      const uncUnrelated = uncAdminSharePath(unrelated);
      try {
        if (!uncTarget || !uncUnrelated) {
          throw new Error(
            'uncAdminShareAvailable was true but uncAdminSharePath ' +
              `returned null for a drive-letter temp directory: ${root}`,
          );
        }

        // Positive: the caller cwd is the same physical directory as the
        // worktree being removed, spelled through the UNC admin share. The
        // guard must still refuse, matching the drive-letter-spelled case.
        const code = codeOfThrown(() =>
          validateCallerLocation(uncTarget, target, 'win32'),
        );
        expect(code).toBe(ERROR_CODES.CALLER_INSIDE_TARGET);

        // Negative control: a genuinely unrelated directory, reached through
        // the same UNC namespace, must still be allowed — the guard must not
        // simply refuse every UNC-spelled caller.
        expect(() =>
          validateCallerLocation(uncUnrelated, target, 'win32'),
        ).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
      expect(extractStderrCode(removal.stderr)).toBe(
        ERROR_CODES.REPARSE_TARGET_UNRESOLVED,
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
      expect(extractStderrCode(removal.stderr)).toBe(
        ERROR_CODES.CALLER_INSIDE_TARGET,
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
      expect(extractStderrCode(removal.stderr)).toBe(
        ERROR_CODES.CALLER_INSIDE_TARGET,
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
      expect(extractStderrCode(removal.stderr)).toBe(
        ERROR_CODES.CALLER_INSIDE_TARGET,
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

  it('accepts a registered target alias and removes the canonical worktree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-target-alias-'));
    let alias = '';
    let arm: ReturnType<typeof makeArm> | null = null;
    try {
      arm = makeArm(root, 'target-alias');
      alias = path.join(root, 'short-target');
      execFileSync(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', 'mklink', '/J', alias, arm.worktree],
        { stdio: 'ignore' },
      );

      const removal = spawnSync(process.execPath, [scriptPath, alias], {
        cwd: arm.repository,
        encoding: 'utf8',
      });

      expect(removal.error).toBeUndefined();
      expect(removal.signal).toBeNull();
      expect(removal.status, removal.stderr).toBe(0);
      expect(removal.stderr).not.toContain('not a registered linked worktree');
      expect(pathIsAbsent(arm.worktree)).toBe(true);
      expect(registeredWorktree(arm.repository, arm.worktree)).toBe(false);
      expect(readdirSync(arm.target)).toHaveLength(SENTINEL_COUNT);
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

  it('accepts a distinct 8.3 target spelling and removes the canonical worktree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-short-target-'));
    let arm: ReturnType<typeof makeArm> | null = null;
    try {
      arm = makeArm(root, 'short-target');
      const shortTarget = windowsShortPath(arm.worktree);
      expect(shortTarget.toLowerCase()).not.toBe(arm.worktree.toLowerCase());

      const removal = spawnSync(process.execPath, [scriptPath, shortTarget], {
        cwd: arm.repository,
        encoding: 'utf8',
      });

      expect(removal.error).toBeUndefined();
      expect(removal.signal).toBeNull();
      expect(removal.status, removal.stderr).toBe(0);
      expect(removal.stderr).not.toContain('not a registered linked worktree');
      expect(pathIsAbsent(arm.worktree)).toBe(true);
      expect(registeredWorktree(arm.repository, arm.worktree)).toBe(false);
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
      expect(extractStderrCode(recovery.stderr)).toBe(
        ERROR_CODES.RECEIPT_UNREADABLE,
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
      expect(extractStderrCode(recovery.stderr)).toBe(
        ERROR_CODES.STALE_STILL_REGISTERED,
      );
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
      expect(extractStderrCode(recovery.stderr)).toBe(
        ERROR_CODES.CALLER_INSIDE_TARGET,
      );
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

describe('error code discoverability (#567)', () => {
  const moduleSource = readFileSync(scriptPath, 'utf8');

  it('carries a code on every throw site and none bypass it', () => {
    // Every refusal in the module must go through refuse(), which attaches a
    // code. A bare `throw new Error(` outside refuse()'s own definition would
    // be a throw site with no code — this fails the moment one is added.
    const bareThrows = moduleSource.match(/throw new Error\(/g) ?? [];
    expect(bareThrows).toEqual([]);
  });

  it('enumerates every throw site with a distinct, non-empty code', () => {
    // Statically enumerates every `refuse(ERROR_CODES.X, ...)` call site in
    // the source. This is the guard against #561/#566-class silent growth:
    // 19 throw sites became 21 without any test noticing, because none of
    // them asserted anything about the *count* or *distinctness* of causes.
    // A new throw site with no code, or one that reuses an existing code
    // instead of defining its own, fails this test.
    const siteMatches = [
      ...moduleSource.matchAll(/refuse\(\s*ERROR_CODES\.(\w+)\s*,/g),
    ];
    const referencedCodeNames = siteMatches.map((match) => match[1]);

    expect(referencedCodeNames.length).toBeGreaterThan(0);
    expect(new Set(referencedCodeNames).size).toBe(referencedCodeNames.length);

    const definedCodeNames = Object.keys(ERROR_CODES);
    expect(new Set(referencedCodeNames)).toEqual(new Set(definedCodeNames));

    const definedCodeValues = Object.values(ERROR_CODES);
    expect(new Set(definedCodeValues).size).toBe(definedCodeValues.length);
  });
});

describe('pairwise code discrimination (#567 acceptance)', () => {
  // A shared fixture used by all four required pairs, so `not-registered`
  // (and identity-unresolvable, which arises from the same call) only needs
  // setting up once. Each `it` below asserts two codes from two arms that
  // both exit 1 are actually different — the property `expect(status).toBe(1)`
  // could never discriminate.
  const root = mkdtempSync(path.join(os.tmpdir(), 'pfd-pairwise-codes-'));
  const repository = path.join(root, 'repo');
  const worktree = path.join(root, 'worktree');
  const unregistered = path.join(root, 'unregistered');
  const missingTarget = path.join(root, 'does-not-exist');

  mkdirSync(repository);
  git(['init', '--initial-branch=development'], repository);
  git(['config', 'user.name', 'Pairwise fixture'], repository);
  git(['config', 'user.email', 'fixture@example.invalid'], repository);
  writeFileSync(path.join(repository, 'tracked.txt'), 'fixture\n');
  git(['add', 'tracked.txt'], repository);
  git(['commit', '-m', 'fixture'], repository);
  git(['worktree', 'add', '-b', 'pairwise', worktree], repository);
  mkdirSync(unregistered);

  const notRegisteredCode = codeOfThrown(() =>
    validateRemovalTarget(unregistered, [repository, worktree]),
  );

  afterAll(() => {
    if (registeredWorktree(repository, worktree)) {
      git(['worktree', 'remove', '--force', worktree], repository);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('distinguishes caller-inside-target from not-registered', () => {
    const callerInsideCode = codeOfThrown(() =>
      validateCallerLocation(worktree, worktree),
    );

    expect(callerInsideCode).toBe(ERROR_CODES.CALLER_INSIDE_TARGET);
    expect(notRegisteredCode).toBe(ERROR_CODES.NOT_REGISTERED);
    expect(callerInsideCode).not.toBe(notRegisteredCode);
  });

  it('distinguishes not-registered from identity-unresolvable', () => {
    const identityUnresolvedCode = codeOfThrown(() =>
      validateRemovalTarget(missingTarget, [repository, worktree]),
    );

    expect(identityUnresolvedCode).toBe(ERROR_CODES.IDENTITY_UNRESOLVED);
    expect(notRegisteredCode).toBe(ERROR_CODES.NOT_REGISTERED);
    expect(identityUnresolvedCode).not.toBe(notRegisteredCode);
  });

  it('distinguishes main-worktree from not-registered', () => {
    const mainWorktreeCode = codeOfThrown(() =>
      validateRemovalTarget(repository, [repository, worktree]),
    );

    expect(mainWorktreeCode).toBe(ERROR_CODES.MAIN_WORKTREE);
    expect(notRegisteredCode).toBe(ERROR_CODES.NOT_REGISTERED);
    expect(mainWorktreeCode).not.toBe(notRegisteredCode);
  });

  it('distinguishes receipt-identity-mismatch from not-registered', () => {
    const receiptPath = createRecoveryReceipt(repository, worktree);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      targetIno: string;
    };
    receipt.targetIno = `${BigInt(receipt.targetIno) + 1n}`;
    writeFileSync(receiptPath, JSON.stringify(receipt));

    const receiptMismatchCode = codeOfThrown(() =>
      readRecoveryReceipt(repository, worktree, filesystemRealpath()),
    );

    expect(receiptMismatchCode).toBe(ERROR_CODES.RECEIPT_IDENTITY_MISMATCH);
    expect(notRegisteredCode).toBe(ERROR_CODES.NOT_REGISTERED);
    expect(receiptMismatchCode).not.toBe(notRegisteredCode);
  });
});

describe.skipIf(!onWindows)(
  'mutation control: containment fires ahead of membership on an alias (#561 regression class)',
  () => {
    it('reports the containment code, not the membership code, when the requested path is a registered alias', () => {
      // Pins the ordering fix from #561: `main()` calls validateRemovalTarget
      // (membership) before validateCallerLocation (containment), but
      // validateRemovalTarget resolves identity through realpathImpl before
      // comparing, so an aliased spelling that is NOT a literal match for any
      // registered worktree string still resolves to the registered
      // worktree's canonical identity, and containment is then evaluated
      // against that canonical target. If a future change reordered these
      // checks to run containment before resolving membership by identity —
      // or reverted to comparing raw, unresolved strings for membership as
      // #561 did — the caller-inside-target arm below would instead observe
      // EWT_NOT_REGISTERED, and this assertion would fail.
      const canonical = 'C:\\Users\\runneradmin\\pairwise-linked';
      const alias = 'C:\\PAIRW~1\\pairwise-linked';
      const realpathImpl = (value: string) => {
        if (value === alias || value === canonical) return canonical;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      };
      const stderr: string[] = [];

      const status = main([alias], {
        cwd: alias,
        platform: 'win32',
        listWorktrees: () => ['C:\\Users\\runneradmin\\main', canonical],
        realpathImpl,
        runGit: () => ({ stdout: '', stderr: '', status: 0 }),
        writeStdout: () => undefined,
        writeStderr: (message) => stderr.push(message),
      });

      expect(status).toBe(1);
      expect(extractStderrCode(stderr.join(''))).toBe(
        ERROR_CODES.CALLER_INSIDE_TARGET,
      );
      expect(stderr.join('')).not.toContain(ERROR_CODES.NOT_REGISTERED);
    });
  },
);
