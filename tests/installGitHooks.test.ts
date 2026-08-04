// @vitest-environment node

// Hook COVERAGE (issue #164), which is a different question from whether the
// guard's decision logic is right — that is `tests/pushGuard.test.ts`.
//
// The property under test: `core.hooksPath` is written to the clone-wide
// `.git/config`, but `.githooks/` is a tracked directory, so whether it exists
// is decided per worktree by the branch checked out there. When the path names
// a directory that is not there, git runs no hook, prints nothing, and exits 0.
// A push through an unarmed worktree therefore looks exactly like a push the
// guard examined and allowed.
//
// Two consequences shape this suite:
//
//   1. Every assertion here drives the FAILURE direction first — hooksPath
//      pointed at a missing directory — because a test that only confirms the
//      happy path cannot tell a working guard from an absent one, which is the
//      exact defect being fixed.
//   2. The end-to-end block uses a STUB hook that writes a marker file, not the
//      real push-guard. What is being measured is whether git ran anything at
//      all; borrowing push-guard's refusal would make a silent no-op and a
//      deliberate allow share an outcome again.
//
// Note on why `tests/pushGuard.test.ts` cannot cover this: every integration
// case there sets `core.hooksPath` to `path.join(repoRoot, HOOKS_PATH)`, an
// ABSOLUTE path, while `installGitHooks` writes a RELATIVE one. That suite is
// structurally blind to per-worktree resolution because it overwrites the very
// value whose production form causes the defect.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  HOOKS_PATH,
  REQUIRED_HOOK,
  describeUnarmed,
  installGitHooks,
  verifyHooksArmed,
} from '../scripts/install-git-hooks.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const installer = path.join(repoRoot, 'scripts', 'install-git-hooks.mjs');

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const temps: string[] = [];

// `realpathSync.native`, not `realpathSync`: on Windows only the native form
// expands an 8.3 short name. `os.tmpdir()` yields `C:\Users\RUNNER~1\...` on a
// runner whose account name exceeds eight characters, while git's
// `rev-parse --show-toplevel` returns the canonical long form, so the two
// disagree on a path that names the same directory.
function tempRepo() {
  const dir = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'hookcov-')),
  );
  temps.push(dir);
  git(['init', '--quiet', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  writeFileSync(path.join(dir, 'file.txt'), 'seed\n');
  git(['add', '.'], dir);
  git(['commit', '--quiet', '-m', 'seed'], dir);
  return dir;
}

/** Writes a hook that records that it ran. Absence of the marker means git ran nothing. */
function writeStubHook(worktree: string, marker: string) {
  const dir = path.join(worktree, HOOKS_PATH);
  mkdirSync(dir, { recursive: true });
  const hook = path.join(dir, REQUIRED_HOOK);
  writeFileSync(
    hook,
    `#!/bin/sh\nprintf 'ran' > "${marker.replace(/\\/g, '/')}"\nexit 0\n`,
  );
  chmodSync(hook, 0o755);
  return hook;
}

// Isolate every git invocation — including the ones inside verifyHooksArmed —
// from the developer's own global config, so "unset" is a state this suite
// creates rather than one it inherits.
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  const nowhere = path.join(os.tmpdir(), 'hookcov-no-such-gitconfig');
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[key] = process.env[key];
    process.env[key] = nowhere;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop()!, { recursive: true, force: true });
  }
});

describe('verifyHooksArmed reports an unarmed worktree', () => {
  it('is NOT armed when core.hooksPath names a directory that does not exist', () => {
    const repo = tempRepo();
    installGitHooks(repo);

    expect(existsSync(path.join(repo, HOOKS_PATH))).toBe(false);

    const status = verifyHooksArmed(repo);

    expect(status.armed).toBe(false);
    expect(status.configured).toBe(HOOKS_PATH);
    expect(status.reason).toContain(REQUIRED_HOOK);
    expect(status.hooksDir).toBe(path.resolve(repo, HOOKS_PATH));
  });

  it('is armed once the hook is actually present — the same call, opposite verdict', () => {
    const repo = tempRepo();
    installGitHooks(repo);
    const hook = writeStubHook(repo, path.join(repo, 'marker'));

    const status = verifyHooksArmed(repo);

    expect(status.armed).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.hookPath).toBe(hook);
  });

  it('is NOT armed when the directory exists but the hook does not', () => {
    const repo = tempRepo();
    installGitHooks(repo);
    mkdirSync(path.join(repo, HOOKS_PATH), { recursive: true });

    const status = verifyHooksArmed(repo);

    // An existence check on the directory alone would pass here. That is the
    // point of checking for the hook file instead.
    expect(status.armed).toBe(false);
    expect(status.reason).toContain(REQUIRED_HOOK);
  });

  it('distinguishes "never configured" from "configured at a missing directory"', () => {
    const repo = tempRepo();

    const unset = verifyHooksArmed(repo);
    expect(unset.armed).toBe(false);
    expect(unset.reason).toBe('core.hooksPath is not set');

    installGitHooks(repo);
    const dangling = verifyHooksArmed(repo);
    expect(dangling.armed).toBe(false);

    // Two unarmed states that must not reach the same diagnostic, or one
    // working check is being demonstrated twice.
    expect(dangling.reason).not.toBe(unset.reason);
  });

  it('resolves a relative path against the worktree, so one clone reports both verdicts', () => {
    const repo = tempRepo();
    installGitHooks(repo);
    writeStubHook(repo, path.join(repo, 'marker'));

    // A second worktree of the SAME clone, on a branch with no .githooks/.
    const sibling = path.join(repo, '..', path.basename(repo) + '-wt');
    temps.push(sibling);
    git(['worktree', 'add', '--quiet', '-b', 'sibling', sibling, 'HEAD'], repo);

    expect(git(['config', '--get', 'core.hooksPath'], sibling)).toBe(
      HOOKS_PATH,
    );

    // This is issue #164 in two assertions: identical clone-wide setting,
    // opposite coverage, decided by the checked-out tree.
    expect(verifyHooksArmed(repo).armed).toBe(true);
    expect(verifyHooksArmed(sibling).armed).toBe(false);
  });
});

describe('the unarmed report names the risk', () => {
  it('says the push is unguarded and that git will be silent about it', () => {
    const repo = tempRepo();
    installGitHooks(repo);

    const message = describeUnarmed(verifyHooksArmed(repo));

    expect(message).toContain('NOT guarded');
    expect(message).toContain('silently');
    expect(message).toContain('#164');
  });
});

describe('the installer CLI', () => {
  const run = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [installer, ...args], {
      cwd,
      encoding: 'utf8',
    });

  it('exits non-zero under --verify when the worktree is unarmed', () => {
    const repo = tempRepo();
    installGitHooks(repo);

    const result = run(['--verify'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NOT guarded');
  });

  it('exits zero under --verify once the hook is present', () => {
    const repo = tempRepo();
    installGitHooks(repo);
    writeStubHook(repo, path.join(repo, 'marker'));

    const result = run(['--verify'], repo);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('armed');
  });

  it('warns but still exits zero on the prepare path, so npm ci is not broken', () => {
    const repo = tempRepo();

    const result = run([], repo);

    // The lifecycle path must report without failing the build: 22 of 27
    // worktrees were unarmed when #164 was measured, and failing their install
    // would block work rather than surface a risk.
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('NOT guarded');
  });
});

describe('the coverage property, driven through a real push', () => {
  function remoteFor(work: string) {
    const bare = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), 'hookcov-remote-')),
    );
    temps.push(bare);
    git(['init', '--bare', '--quiet'], bare);
    git(['remote', 'add', 'origin', bare], work);
    return bare;
  }

  it('runs NOTHING and succeeds when the hook directory is missing', () => {
    const repo = tempRepo();
    installGitHooks(repo);
    remoteFor(repo);
    const marker = path.join(repo, 'marker');

    const push = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/probe'], {
      cwd: repo,
      encoding: 'utf8',
    });

    expect(push.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('runs the hook when it is present — the control for the assertion above', () => {
    const repo = tempRepo();
    installGitHooks(repo);
    remoteFor(repo);
    const marker = path.join(repo, 'marker');
    writeStubHook(repo, marker);

    const push = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/probe'], {
      cwd: repo,
      encoding: 'utf8',
    });

    expect(push.status).toBe(0);
    // Without this arm, the missing marker above would be evidence of nothing:
    // it could equally mean the marker mechanism does not work.
    expect(existsSync(marker)).toBe(true);
  });
});
