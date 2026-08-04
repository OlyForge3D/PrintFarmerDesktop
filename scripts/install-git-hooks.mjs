// Points git at the versioned hooks in `.githooks/`.
//
// Wired to the `prepare` npm script, so it runs on `npm install` and `npm ci`
// rather than depending on anyone remembering to run it. `core.hooksPath` is a
// repository-level setting, so one install covers every worktree of the clone.
//
// It never fails a build: outside a git checkout (packaged tarballs, CI caches
// restored without `.git`) it reports and exits 0.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOOKS_PATH = '.githooks';

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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = installGitHooks();
    console.log(
      result.installed
        ? `[install-git-hooks] core.hooksPath = ${HOOKS_PATH}`
        : `[install-git-hooks] skipped: ${result.reason}`,
    );
  } catch (error) {
    console.log(`[install-git-hooks] skipped: ${error.message}`);
  }
}
