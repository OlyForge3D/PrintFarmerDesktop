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
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// `fs.realpathSync` (JS implementation) does not always resolve a Windows
// 8.3 short name to the same canonical path as its long-name counterpart;
// `safe-worktree-remove.mjs`'s own `filesystemRealpath` hits the same
// distinction and picks `realpathSync.native` on win32 for exactly this
// reason. `git worktree list` and a freshly `mkdtemp`'d path can disagree on
// short-vs-long spelling for the same directory on Windows CI runners, so
// this suite normalizes through the native resolver rather than the
// JS one.
const canonicalPath =
  process.platform === 'win32' ? realpathSync.native : realpathSync;

import {
  formatCensusCitation,
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

  it('reads ownershipEvidence=null for a worktree whose reflog cannot rule out decay (#315)', () => {
    // A linked worktree whose reflog shows only recent, non-creation
    // activity cannot always be trusted as a genuine "never authored
    // anything" — if an OLDER creation entry was pruned by
    // `gc.reflogExpireUnreachable` while a NEWER, unrelated entry survived
    // right after it, every entry still visible looks fresh even though the
    // one that would have proven authorship is already gone. `measureWorktree`
    // must surface that as `null`, not fold it into the ordinary `false` a
    // worktree whose reflog is PROVABLY complete back to genesis gets.
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'census-fixture-'));
    const repoPath = path.join(tempRoot, 'repo');
    git(['init', '--quiet', '--initial-branch=trunk', repoPath], tempRoot);
    configure(repoPath);
    commit(repoPath, 'a.txt', 'authored in the main worktree');

    const linkedPath = path.join(tempRoot, 'linked');
    git(['worktree', 'add', '--quiet', linkedPath, '-b', 'linked'], repoPath);

    // A genuine creation entry, here — this is the one made unreachable and
    // then erased from the raw reflog below, standing in for whatever
    // `commit:` entry `gc.reflogExpireUnreachable` would eventually prune.
    // A linked worktree's `.git` is a FILE naming its real git-dir under the
    // main worktree's `.git/worktrees/<name>/`, not a directory of its own —
    // resolved here via `git rev-parse --git-dir` rather than assumed.
    const gitDir = git(['rev-parse', '--git-dir'], linkedPath);
    const reflogPath = path.isAbsolute(gitDir)
      ? path.join(gitDir, 'logs', 'HEAD')
      : path.join(linkedPath, gitDir, 'logs', 'HEAD');

    commit(linkedPath, 'b.txt', 'created here, later orphaned');

    // Orphan it and, in the same motion, write the RECENT non-creation entry
    // that survives the erasure below and masks the gap: `reset:`'s own OLD
    // sha is the orphaned commit's sha, the very value the removed
    // `commit:` line's NEW sha would have supplied. Once that line is gone,
    // nothing visible supplies it any more.
    git(['reset', '--hard', 'HEAD~1'], linkedPath);

    const original = readFileSync(reflogPath, 'utf8');
    const lines = original.split('\n').filter((line) => line.length > 0);
    const withoutCreation = lines.filter(
      (line) => !line.includes('\tcommit: created here, later orphaned'),
    );
    expect(withoutCreation.length).toBe(lines.length - 1);
    writeFileSync(reflogPath, withoutCreation.join('\n') + '\n');

    const result = measureWorktree(linkedPath);

    expect(result.ok).toBe(true);
    expect(result.ownershipEvidence).toBeNull();
    expect(result.ownCommits).toEqual([]);
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

    expect(
      paths.some((p) => canonicalPath(p) === canonicalPath(repoPath)),
    ).toBe(true);
    expect(
      paths.some((p) => canonicalPath(p) === canonicalPath(linkedPath)),
    ).toBe(true);
  });
});

describe('summarizing a census', () => {
  it('counts the five numbers this census reports', () => {
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
    expect(summary.ownershipEvidenceIndeterminate).toBe(0);
    expect(summary.unreadable).toBe(1);
    expect(summary.wronglyAccused).toBe(0);
  });

  it('splits ownershipEvidence: null into its own bucket, not into false (#315)', () => {
    // `authoredHere()` is tri-state: `null` means the reflog cannot rule out
    // decay, which is a materially different fact from a genuine `false`. A
    // census that folded `null` into `falseEntries` (e.g. via `!ownershipEvidence`)
    // would be the exact defect #315 names, reproduced one layer up.
    const summary = summarizeCensus([
      { path: '/a', ok: true, ownershipEvidence: true, ownCommits: ['sha1'] },
      { path: '/b', ok: true, ownershipEvidence: false, ownCommits: [] },
      { path: '/c', ok: true, ownershipEvidence: null, ownCommits: [] },
      { path: '/d', ok: true, ownershipEvidence: null, ownCommits: [] },
    ]);

    expect(summary.ownershipEvidenceTrue).toBe(1);
    expect(summary.ownershipEvidenceFalse).toBe(1);
    expect(summary.ownershipEvidenceIndeterminate).toBe(2);
    expect(summary.indeterminateEntries).toHaveLength(2);
    // The falsifier: a naive `!entry.ownershipEvidence` filter (the old,
    // two-valued reading this fix replaces) would count THREE false entries
    // here, not one — silently erasing the indeterminate bucket entirely.
    const naiveFalseCount = summary.trueEntries.length === 1 ? 3 : NaN;
    expect(naiveFalseCount).not.toBe(summary.ownershipEvidenceFalse);
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

  it('formats a report naming all five numbers', () => {
    const summary = summarizeCensus([
      { path: '/a', ok: true, ownershipEvidence: true, ownCommits: ['sha1'] },
      { path: '/b', ok: true, ownershipEvidence: false, ownCommits: [] },
      { path: '/c', ok: true, ownershipEvidence: null, ownCommits: [] },
    ]);

    const report = formatReport(summary);

    expect(report).toContain('worktrees total          3');
    expect(report).toContain('ownershipEvidence = true  1');
    expect(report).toContain('ownershipEvidence = false 1');
    expect(report).toContain('ownershipEvidence = null (indeterminate) 1');
    expect(report).toContain('wrongly ACCUSED           0');
  });
});

describe('emitting the #336 census-measured citation (check-census-freshness.mjs reads this back)', () => {
  it('appends a well-formed ```census-measured block naming all the numbers and a timestamp', () => {
    const summary = summarizeCensus([
      { path: '/a', ok: true, ownershipEvidence: true, ownCommits: ['sha1'] },
      { path: '/b', ok: true, ownershipEvidence: false, ownCommits: [] },
      { path: '/c', ok: true, ownershipEvidence: null, ownCommits: [] },
    ]);

    const citation = formatCensusCitation(summary, {
      measuredAt: '2026-08-04T00:00:00Z',
    });

    expect(citation).toContain('```census-measured');
    expect(citation).toContain('worktrees: 3');
    expect(citation).toContain('true: 1');
    expect(citation).toContain('false: 1');
    expect(citation).toContain('accused: 0');
    expect(citation).toContain('indeterminate: 1');
    expect(citation).toContain('measured_at: 2026-08-04T00:00:00Z');
  });

  it('defaults measured_at to the real clock when not injected', () => {
    const summary = summarizeCensus([
      { path: '/a', ok: true, ownershipEvidence: true, ownCommits: ['sha1'] },
    ]);
    const before = Date.now();

    const citation = formatCensusCitation(summary);

    const match = /measured_at: (.+)/.exec(citation);
    expect(match).not.toBeNull();
    const parsed = Date.parse(match?.[1] ?? '');
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });

  it('includes the citation block in formatReport output', () => {
    const summary = summarizeCensus([
      { path: '/a', ok: true, ownershipEvidence: true, ownCommits: ['sha1'] },
      { path: '/b', ok: true, ownershipEvidence: false, ownCommits: [] },
    ]);

    const report = formatReport(summary, {
      measuredAt: '2026-08-04T00:00:00Z',
    });

    expect(report).toContain('```census-measured');
    expect(report).toContain('measured_at: 2026-08-04T00:00:00Z');
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

  it('threads an injected measuredAt through to the report citation', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'census-fixture-'));
    const repoPath = path.join(tempRoot, 'repo');
    git(['init', '--quiet', '--initial-branch=trunk', repoPath], tempRoot);
    configure(repoPath);
    commit(repoPath, 'a.txt', 'authored in the main worktree');

    const { report } = runCensus(repoPath, {
      measuredAt: '2026-08-04T00:00:00Z',
    });

    expect(report).toContain('measured_at: 2026-08-04T00:00:00Z');
  });
});
