// @vitest-environment node

// #382: "The hook guard reaches only worktrees with an npm install left to
// spend: nothing enumerates the population, and hooks:verify is invoked by
// nothing." `install-git-hooks.mjs --verify` (`npm run hooks:verify`) only
// ever answers for the current process working directory's own worktree.
// This suite drives the coverage check added in
// `scripts/check-hooks-coverage.mjs`: enumerate EVERY worktree via
// `git worktree list --porcelain` (including the main checkout), report
// armed/unarmed per worktree with its branch, and exit non-zero the instant
// any worktree is unarmed.
//
// Every fixture below is a REAL git repository with a REAL linked worktree,
// built with actual `git worktree add`, matching this repo's own convention
// (`tests/strandedBranches.test.ts`, `tests/installGitHooks.test.ts`) of
// exercising git plumbing directly rather than mocking it, since a mocked
// `worktree list` could not falsify a broken porcelain parse or a broken
// separator comparison.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  EXIT_CLEAN,
  EXIT_UNARMED,
  EXIT_UNDETERMINED,
  assertMainCheckoutPresent,
  enumerateWorktrees,
  evaluateCoverage,
  evaluatePopulation,
  formatReport,
  normalizeSeparators,
  parsePorcelainWorktreeList,
  runCheck,
} from '../scripts/check-hooks-coverage.mjs';
import {
  HOOKS_PATH,
  REQUIRED_HOOK,
  installGitHooks,
} from '../scripts/install-git-hooks.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const checker = path.join(repoRoot, 'scripts', 'check-hooks-coverage.mjs');

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const temps: string[] = [];

// `realpathSync.native`, not `realpathSync`: on Windows only the native form
// expands an 8.3 short name, matching `tests/installGitHooks.test.ts`'s own
// rationale — git's `rev-parse --show-toplevel`/`--git-common-dir` return
// the canonical long form, so a short-name temp dir would disagree with it.
function tempRepo() {
  const dir = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), 'hookscov-')),
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

/** Writes a real, executable hook — the same shape `installGitHooks.test.ts` uses. */
function armWorktree(worktree: string) {
  installGitHooks(worktree);
  const dir = path.join(worktree, HOOKS_PATH);
  mkdirSync(dir, { recursive: true });
  const hook = path.join(dir, REQUIRED_HOOK);
  writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  chmodSync(hook, 0o755);
}

function addLinkedWorktree(mainRepo: string, branch: string) {
  const sibling = path.join(mainRepo, '..', `${path.basename(mainRepo)}-${branch}`);
  temps.push(sibling);
  git(['worktree', 'add', '--quiet', '-b', branch, sibling, 'HEAD'], mainRepo);
  return realpathSync.native(sibling);
}

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  const nowhere = path.join(os.tmpdir(), 'hookscov-no-such-gitconfig');
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

describe('normalizeSeparators — the Windows path caution', () => {
  it('folds backslashes to forward slashes so both spellings compare equal', () => {
    expect(normalizeSeparators('D:\\s\\PrintFarmerDesktop')).toBe(
      'D:/s/PrintFarmerDesktop',
    );
    expect(normalizeSeparators('D:/s/PrintFarmerDesktop')).toBe(
      'D:/s/PrintFarmerDesktop',
    );
    expect(normalizeSeparators('D:\\s\\PrintFarmerDesktop')).toBe(
      normalizeSeparators('D:/s/PrintFarmerDesktop'),
    );
  });

  it('strips a trailing slash so a directory and its slash-suffixed form match', () => {
    expect(normalizeSeparators('D:/s/repo/')).toBe(
      normalizeSeparators('D:/s/repo'),
    );
  });
});

describe('parsePorcelainWorktreeList', () => {
  it('parses a main checkout and a branch worktree from real porcelain output', () => {
    const repo = tempRepo();
    const sibling = addLinkedWorktree(repo, 'feature');

    const output = git(['worktree', 'list', '--porcelain'], repo);
    const entries = parsePorcelainWorktreeList(output);

    expect(entries).toHaveLength(2);
    const main = entries[0];
    expect(main?.normalizedPath).toBe(normalizeSeparators(repo));
    expect(main?.branch).toBe('main');
    expect(main?.detached).toBe(false);

    const linked = entries.find((e) => e.branch === 'feature');
    expect(linked).toBeDefined();
    expect(linked?.normalizedPath).toBe(normalizeSeparators(sibling));
  });

  it('marks a detached-HEAD worktree as detached with a null branch', () => {
    const repo = tempRepo();
    const detachedDir = path.join(repo, '..', `${path.basename(repo)}-detached`);
    temps.push(detachedDir);
    const headSha = git(['rev-parse', 'HEAD'], repo);
    git(['worktree', 'add', '--quiet', '--detach', detachedDir, headSha], repo);

    const output = git(['worktree', 'list', '--porcelain'], repo);
    const entries = parsePorcelainWorktreeList(output);
    const detached = entries.find((e) =>
      e.normalizedPath.endsWith('-detached'),
    );

    expect(detached?.detached).toBe(true);
    expect(detached?.branch).toBeNull();
  });

  it('returns an empty array for output with no worktree line at all', () => {
    expect(parsePorcelainWorktreeList('')).toEqual([]);
    expect(parsePorcelainWorktreeList('garbage, not porcelain output\n')).toEqual(
      [],
    );
  });
});

describe('evaluatePopulation — fail loud on an empty denominator', () => {
  it('refuses (not-ok) when zero worktrees were parsed', () => {
    const result = evaluatePopulation([]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('zero');
  });

  it('is ok once at least one worktree is present', () => {
    expect(
      evaluatePopulation([
        {
          path: '/repo',
          normalizedPath: '/repo',
          headSha: 'a'.repeat(40),
          branch: 'main',
          detached: false,
        },
      ]).ok,
    ).toBe(true);
  });
});

describe('assertMainCheckoutPresent — proven, not assumed', () => {
  const worktrees = [
    {
      path: 'D:/s/PrintFarmerDesktop',
      normalizedPath: 'D:/s/PrintFarmerDesktop',
      headSha: 'a'.repeat(40),
      branch: 'development',
      detached: false,
    },
  ];

  it('finds the main checkout when the comparison path uses backslashes', () => {
    // Reproduces the issue's own false negative directly: a Windows
    // backslash path held against porcelain output, which is always
    // forward-slash. Without normalization this membership test silently
    // fails.
    const result = assertMainCheckoutPresent(
      worktrees,
      'D:\\s\\PrintFarmerDesktop',
    );
    expect(result.ok).toBe(true);
    expect(result.match?.branch).toBe('development');
  });

  it('finds the main checkout when the comparison path already uses forward slashes', () => {
    expect(
      assertMainCheckoutPresent(worktrees, 'D:/s/PrintFarmerDesktop').ok,
    ).toBe(true);
  });

  it('reports not-ok, naming the searched paths, when the main checkout truly is absent', () => {
    const result = assertMainCheckoutPresent(worktrees, 'D:/s/SomewhereElse');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('D:/s/SomewhereElse');
    expect(result.reason).toContain('D:/s/PrintFarmerDesktop');
  });
});

describe('evaluateCoverage — both arms', () => {
  it('is CLEAN (exit 0) when every worktree is armed', () => {
    const result = evaluateCoverage([
      {
        path: '/repo',
        branch: 'main',
        detached: false,
        status: { armed: true, reason: null, configured: HOOKS_PATH, hooksDir: null, hookPath: null, toplevel: null },
      },
    ]);
    expect(result.exitCode).toBe(EXIT_CLEAN);
    expect(result.unarmed).toEqual([]);
  });

  it('is UNARMED (exit 1) when even one worktree is unarmed, and names it', () => {
    const result = evaluateCoverage([
      {
        path: '/repo/main',
        branch: 'main',
        detached: false,
        status: { armed: true, reason: null, configured: HOOKS_PATH, hooksDir: null, hookPath: null, toplevel: null },
      },
      {
        path: '/repo/feature-wt',
        branch: 'feature',
        detached: false,
        status: {
          armed: false,
          reason: 'core.hooksPath is not set',
          configured: null,
          hooksDir: null,
          hookPath: null,
          toplevel: null,
        },
      },
    ]);
    expect(result.exitCode).toBe(EXIT_UNARMED);
    expect(result.unarmed).toHaveLength(1);
    expect(result.unarmed[0]?.path).toBe('/repo/feature-wt');

    const report = formatReport(result);
    expect(report).toContain('/repo/feature-wt');
    expect(report).toContain('feature');
  });
});

describe('the falsifier (#382): a real linked worktree missing .githooks/pre-push', () => {
  it('THE FALSIFIER — reports EXIT_UNARMED and names the offending worktree path', () => {
    const repo = tempRepo();
    armWorktree(repo);
    // Deliberately NOT armed: a linked worktree checked out on a branch with
    // no .githooks/pre-push present on disk.
    const sibling = addLinkedWorktree(repo, 'unarmed-branch');

    const outcome = runCheck(repo);

    expect(outcome.exitCode).toBe(EXIT_UNARMED);
    expect(outcome.report).toContain(normalizeSeparators(sibling));
    expect(outcome.report).toContain('unarmed-branch');
  });

  it('POSITIVE CONTROL — every worktree armed reports EXIT_CLEAN', () => {
    const repo = tempRepo();
    armWorktree(repo);
    const sibling = addLinkedWorktree(repo, 'armed-branch');
    armWorktree(sibling);

    const outcome = runCheck(repo);

    expect(outcome.exitCode).toBe(EXIT_CLEAN);
    expect(outcome.report).toContain('CLEAN');
  });

  it('the main checkout itself is asserted present in the enumeration', () => {
    const repo = tempRepo();
    armWorktree(repo);
    addLinkedWorktree(repo, 'sibling-branch');

    const worktrees = enumerateWorktrees(repo);
    const presence = assertMainCheckoutPresent(worktrees, repo);

    expect(presence.ok).toBe(true);
    expect(presence.match?.normalizedPath).toBe(normalizeSeparators(repo));
  });

  it('an unarmed main checkout (not just a linked worktree) is caught too', () => {
    const repo = tempRepo();
    // Main checkout left UNARMED — the exact scenario the issue's own
    // reading found ("the main checkout is unarmed").
    const sibling = addLinkedWorktree(repo, 'armed-only-here');
    armWorktree(sibling);

    const outcome = runCheck(repo);

    expect(outcome.exitCode).toBe(EXIT_UNARMED);
    expect(outcome.report).toContain(normalizeSeparators(repo));
  });

  it('reports UNDETERMINED, not clean, if the population cannot be resolved', () => {
    // A directory with no git repository at all: `git worktree list
    // --porcelain` fails outright, which must not read as EXIT_CLEAN.
    const notARepo = realpathSync.native(
      mkdtempSync(path.join(os.tmpdir(), 'hookscov-norepo-')),
    );
    temps.push(notARepo);

    const outcome = runCheck(notARepo);

    expect(outcome.exitCode).toBe(EXIT_UNDETERMINED);
    expect(outcome.report).not.toContain('CLEAN');
  });
});

describe('the CLI', () => {
  const run = (cwd: string) =>
    spawnSync(process.execPath, [checker], { cwd, encoding: 'utf8' });

  it('exits non-zero when a linked worktree is unarmed', () => {
    const repo = tempRepo();
    armWorktree(repo);
    const sibling = addLinkedWorktree(repo, 'cli-unarmed');

    const result = run(repo);

    expect(result.status).toBe(EXIT_UNARMED);
    expect(result.stderr).toContain(normalizeSeparators(sibling));
  });

  it('exits zero once every worktree is armed', () => {
    const repo = tempRepo();
    armWorktree(repo);
    const sibling = addLinkedWorktree(repo, 'cli-armed');
    armWorktree(sibling);

    const result = run(repo);

    expect(result.status).toBe(EXIT_CLEAN);
    expect(result.stdout).toContain('CLEAN');
  });
});
