// @vitest-environment node

// #336: the ownership census `push-guard.mjs` relies on
// (`ownershipEvidence` / `authoredHere()`) drains on `gc.reflogExpireUnreachable`
// (30 days), and the 2026-08-04 baseline (worktrees=24, true=18, false=6,
// wrongly-accused=0) was a one-time photograph of a population that moves.
// This suite drives `scripts/census-ownership-evidence.mjs` against REAL git
// worktrees — a worktree that created a commit here must read
// `ownershipEvidence: true`; a worktree that only checked out history it did
// not create must read `false` — matching this repo's own convention
// (`pushGuard.test.ts`, `strandedBranches.test.ts`) of exercising git plumbing
// directly rather than mocking it.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatReport,
  listWorktreePaths,
  measureWorktree,
  runCensus,
  summarizeCensus,
} from '../scripts/census-ownership-evidence.mjs';

function git(args: string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function configure(cwd: string) {
  git(['config', 'user.name', 'Census fixture'], cwd);
  git(['config', 'user.email', 'fixture@example.invalid'], cwd);
  // The guard's evidence is read from HEAD's own reflog file
  // (logs/HEAD), which only exists when this is on — matching the
  // repo default this hook relies on in a real clone.
  git(['config', 'core.logAllRefUpdates', 'true'], cwd);
}

function commit(cwd: string, filename: string, message: string) {
  writeFileSync(path.join(cwd, filename), `${message}\n`);
  git(['add', filename], cwd);
  git(['commit', '-q', '-m', message], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe('measuring a single worktree', () => {
  it('reads ownershipEvidence=true for a worktree that created a commit here', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'census-fixture-'));
    const repoPath = path.join(tempRoot, 'repo');
    git(['init', '--quiet', '--initial-branch=trunk', repoPath], tempRoot);
    configure(repoPath);
    const sha = commit(repoPath, 'a.txt', 'authored here');

    const result = measureWorktree(repoPath);

    expect(result.ok).toBe(true);
    expect(result.ownershipEvidence).toBe(true);
    expect(result.ownCommits).toContain(sha);
  });

  it('reads ownershipEvidence=false for a linked worktree that only checked out history', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'census-fixture-'));
    const repoPath = path.join(tempRoot, 'repo');
    git(['init', '--quiet', '--initial-branch=trunk', repoPath], tempRoot);
    configure(repoPath);
    commit(repoPath, 'a.txt', 'authored in the main worktree');

    const linkedPath = path.join(tempRoot, 'linked');
    git(['worktree', 'add', '--quiet', linkedPath, '-b', 'linked'], repoPath);
    // The linked worktree's own HEAD reflog gets exactly one entry from the
    // `worktree add` checkout itself — an arrival, not a creation — so
    // `authoredHere()` must still read false there.

    const result = measureWorktree(linkedPath);

    expect(result.ok).toBe(true);
    expect(result.ownershipEvidence).toBe(false);
    expect(result.ownCommits).toEqual([]);
  });

  it('reports a missing worktree path as unreadable rather than false', () => {
    const result = measureWorktree(
      path.join(os.tmpdir(), 'census-nonexistent-path-xyz'),
    );

    expect(result.ok).toBe(false);
    expect(result.ownershipEvidence).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });

  it('restores the original process cwd even when the worktree is unreadable', () => {
    const before = process.cwd();

    measureWorktree(path.join(os.tmpdir(), 'census-nonexistent-path-xyz'));

    expect(process.cwd()).toBe(before);
  });
});

describe('listing worktrees for a real repo', () => {
  it('includes the main worktree and every linked one', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'census-fixture-'));
    const repoPath = path.join(tempRoot, 'repo');
    git(['init', '--quiet', '--initial-branch=trunk', repoPath], tempRoot);
    configure(repoPath);
    commit(repoPath, 'a.txt', 'init');
    const linkedPath = path.join(tempRoot, 'linked');
    git(['worktree', 'add', '--quiet', linkedPath, '-b', 'linked'], repoPath);

    const paths = listWorktreePaths(repoPath);

    expect(paths.some((p) => realpathSync(p) === realpathSync(repoPath))).toBe(
      true,
    );
    expect(
      paths.some((p) => realpathSync(p) === realpathSync(linkedPath)),
    ).toBe(true);
  });
});

describe('summarizing a census', () => {
  it('counts the four numbers #336 asks for', () => {
    const summary = summarizeCensus([
      { path: '/a', ok: true, ownershipEvidence: true, ownCommits: ['sha1'] },
      { path: '/b', ok: true, ownershipEvidence: true, ownCommits: ['sha2'] },
      { path: '/c', ok: true, ownershipEvidence: false, ownCommits: [] },
      {
        path: '/d',
        ok: false,
        ownershipEvidence: false,
        ownCommits: [],
        error: 'boom',
      },
    ]);

    expect(summary.worktreesTotal).toBe(4);
    expect(summary.ownershipEvidenceTrue).toBe(2);
    expect(summary.ownershipEvidenceFalse).toBe(1);
    expect(summary.unreadable).toBe(1);
    expect(summary.wronglyAccused).toBe(0);
  });

  it('flags a sha claimed as created-here by two different worktrees as wrongly accused', () => {
    // Impossible under correct git semantics (a commit object is created in
    // exactly one place); constructed here as the falsifier for the
    // collision check itself, not as a state that should occur naturally.
    const summary = summarizeCensus([
      {
        path: '/a',
        ok: true,
        ownershipEvidence: true,
        ownCommits: ['collided-sha'],
      },
      {
        path: '/b',
        ok: true,
        ownershipEvidence: true,
        ownCommits: ['collided-sha'],
      },
    ]);

    expect(summary.wronglyAccused).toBe(2);
    expect(summary.collisions).toHaveLength(1);
    expect(summary.collisions[0]?.[0]).toBe('collided-sha');
  });

  it('formats a report naming all four numbers', () => {
    const summary = summarizeCensus([
      { path: '/a', ok: true, ownershipEvidence: true, ownCommits: ['sha1'] },
      { path: '/b', ok: true, ownershipEvidence: false, ownCommits: [] },
    ]);

    const report = formatReport(summary);

    expect(report).toContain('worktrees total          2');
    expect(report).toContain('ownershipEvidence = true  1');
    expect(report).toContain('ownershipEvidence = false 1');
    expect(report).toContain('wrongly ACCUSED           0');
  });
});

describe('running the census end to end', () => {
  it('produces consistent totals against a real multi-worktree repo', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'census-fixture-'));
    const repoPath = path.join(tempRoot, 'repo');
    git(['init', '--quiet', '--initial-branch=trunk', repoPath], tempRoot);
    configure(repoPath);
    commit(repoPath, 'a.txt', 'authored in the main worktree');
    const linkedPath = path.join(tempRoot, 'linked');
    git(['worktree', 'add', '--quiet', linkedPath, '-b', 'linked'], repoPath);

    const { summary } = runCensus(repoPath);

    expect(summary.worktreesTotal).toBe(2);
    expect(summary.ownershipEvidenceTrue).toBe(1);
    expect(summary.ownershipEvidenceFalse).toBe(1);
    expect(summary.wronglyAccused).toBe(0);
  });
});
