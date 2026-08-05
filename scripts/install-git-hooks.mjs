// Points git at the versioned hooks in `.githooks/`.
//
// Wired to the `prepare` npm script, so it runs on `npm install` and `npm ci`
// rather than depending on anyone remembering to run it.
//
// It never fails a build: outside a git checkout (packaged tarballs, CI caches
// restored without `.git`) it reports and exits 0.
//
// SETTING THE PATH IS NOT ARMING THE HOOK (issue #164). `core.hooksPath` is
// written to the clone-wide `.git/config`, so one install does cover every
// worktree of the clone — but `.githooks/` is a *tracked directory*, so whether
// it exists is decided per worktree by the branch checked out there. The value
// is relative, and git resolves it against each worktree's own top level
// (measured: a push from a subdirectory still resolves to the top level, so cwd
// is not the variable — the checked-out tree is).
//
// The two compose badly, and in the unsafe direction: when `core.hooksPath`
// names a directory that does not exist, git runs no hook, prints nothing and
// exits 0. A push through an unarmed worktree is indistinguishable from a push
// the guard examined and allowed. So the install-time report below is not
// decoration — install is the only moment anyone is looking, and every later
// moment is a push whose failure mode is silence.
//
// `verifyHooksArmed` is therefore the check that matters, and it is deliberately
// separated from `installGitHooks`: one writes configuration, the other reads
// the filesystem back. Asking the same code that just set a value whether the
// value is right is not a control.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOOKS_PATH = '.githooks';

// The hook the guard ships. Its absence is what makes a worktree unguarded, so
// the directory merely existing is not enough to report `armed`.
export const REQUIRED_HOOK = 'pre-push';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export function installGitHooks(cwd = repoRoot) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd,
      stdio: 'ignore',
    });
  } catch {
    return { installed: false, reason: 'not a git checkout' };
  }

  execFileSync('git', ['config', 'core.hooksPath', HOOKS_PATH], {
    cwd,
    stdio: 'ignore',
  });
  return { installed: true, reason: null };
}

/**
 * Reads back what git will actually run, from the filesystem rather than from
 * the value just written.
 *
 * Resolution mirrors git's own: an absolute `core.hooksPath` is used as given, a
 * relative one is resolved against the top level of the worktree the caller is
 * in — not against the process cwd, and not against the clone's main checkout.
 *
 * @param {string} [cwd]
 * @returns {{
 *   armed: boolean,
 *   reason: string | null,
 *   configured: string | null,
 *   hooksDir: string | null,
 *   hookPath: string | null,
 *   toplevel: string | null,
 * }}
 */
export function verifyHooksArmed(cwd = repoRoot) {
  const unarmed = (reason, rest = {}) => ({
    armed: false,
    reason,
    configured: null,
    hooksDir: null,
    hookPath: null,
    toplevel: null,
    ...rest,
  });

  let toplevel;
  try {
    toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    return unarmed('not a git checkout');
  }

  let configured;
  try {
    configured = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    // `git config --get` exits 1 when the key is unset. That is a real state,
    // not an error: nothing points at the hooks at all.
    return unarmed('core.hooksPath is not set', { toplevel });
  }

  if (!configured) {
    return unarmed('core.hooksPath is set to an empty value', { toplevel });
  }

  const hooksDir = path.isAbsolute(configured)
    ? configured
    : path.resolve(toplevel, configured);
  const hookPath = path.join(hooksDir, REQUIRED_HOOK);

  if (!fs.existsSync(hookPath)) {
    return unarmed(
      `core.hooksPath resolves to ${hooksDir}, which contains no ${REQUIRED_HOOK}`,
      { configured, hooksDir, hookPath, toplevel },
    );
  }

  return {
    armed: true,
    reason: null,
    configured,
    hooksDir,
    hookPath,
    toplevel,
  };
}

/**
 * The report a human sees. Kept separate from the check so a test can assert the
 * words without spawning a process, and so the exit code is decided in exactly
 * one place.
 *
 * @param {ReturnType<typeof verifyHooksArmed>} status
 */
export function describeUnarmed(status) {
  return [
    '[install-git-hooks] WARNING: this worktree is NOT guarded.',
    `[install-git-hooks]   ${status.reason}`,
    status.toplevel
      ? `[install-git-hooks]   worktree: ${status.toplevel}`
      : null,
    '[install-git-hooks]   git skips a missing hook silently and exits 0, so a',
    '[install-git-hooks]   force-push from here will destroy commits without',
    '[install-git-hooks]   any refusal and without any message (issue #164).',
    `[install-git-hooks]   core.hooksPath is clone-wide, so other worktrees may`,
    `[install-git-hooks]   be armed while this one is not. Check out a branch`,
    `[install-git-hooks]   containing ${HOOKS_PATH}/${REQUIRED_HOOK}, or push with`,
    '[install-git-hooks]   npm run push:force, which does its own checking.',
  ]
    .filter(Boolean)
    .join('\n');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // `--verify` is the same check with teeth. `prepare` must not fail a build —
  // most worktrees on this clone were unarmed when #164 was measured (22 of 27 at
  // that reading; the ratio moves within hours as worktrees are created and
  // deleted, so the decision record carries the timestamped readings and this
  // comment should not be trusted as a current figure) — and failing their
  // `npm ci` would block work rather than surface a risk, so the lifecycle path
  // reports and exits 0 while the explicit path exits non-zero and can be used
  // as a gate.
  //
  // The verification reads `process.cwd()` rather than this file's own root:
  // the question is whether the worktree the operator is standing in is armed.
  // npm runs lifecycle scripts from the package root, so the two agree on the
  // `prepare` path, and they differ only when someone runs this script at a
  // worktree other than its own — where cwd is the one they meant.
  const verifyOnly = process.argv.includes('--verify');

  if (!verifyOnly) {
    try {
      const result = installGitHooks(process.cwd());
      console.log(
        result.installed
          ? `[install-git-hooks] core.hooksPath = ${HOOKS_PATH}`
          : `[install-git-hooks] skipped: ${result.reason}`,
      );
    } catch (error) {
      console.log(`[install-git-hooks] skipped: ${error.message}`);
    }
  }

  const status = verifyHooksArmed(process.cwd());

  if (status.armed) {
    console.log(`[install-git-hooks] armed: ${status.hookPath}`);
    process.exit(0);
  }

  if (status.reason === 'not a git checkout') {
    console.log(`[install-git-hooks] skipped: ${status.reason}`);
    process.exit(0);
  }

  console.error(describeUnarmed(status));
  process.exit(verifyOnly ? 1 : 0);
}
