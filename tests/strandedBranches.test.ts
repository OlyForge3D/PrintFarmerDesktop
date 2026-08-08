// @vitest-environment node

// #543: "9 local branches carry commits that exist on no remote ref at
// all... nothing detects it." This suite drives the falsifier the issue
// names explicitly: create a local commit on a branch with no remote ref and
// require the check to report it. A check that reports zero on a tree that
// has one is measuring branch names, not reachability — the same mistake
// that makes `git worktree list` look like an answer here (it enumerates
// checkouts, not unpushed work).
//
// Every fixture below is a REAL git repository with a REAL bare "origin",
// built with actual `git commit`/`git push`, matching this repo's own
// convention (`safeWorktreeRemove.test.ts`) of exercising git plumbing
// directly rather than mocking it — a mocked `rev-list` could not falsify a
// broken reachability walk.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EXIT_CLEAN,
  EXIT_STRANDED,
  EXIT_UNDETERMINED,
  countRemoteRefs,
  evaluateRemoteRefPresence,
  evaluateStrandedBranches,
  extractIssueReferences,
  formatReport,
  listLocalBranches,
  listStrandedCommits,
  runCheck,
} from '../scripts/check-stranded-branches.mjs';

function git(args: string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(cwd: string, filename: string, message: string) {
  writeFileSync(path.join(cwd, filename), `${message}\n`);
  git(['add', filename], cwd);
  git(['commit', '-q', '-m', message], cwd);
}

/**
 * A real clone with a real bare "origin", the same topology the issue's own
 * repro used (`git ls-remote --heads origin`, `git branch -r --contains
 * <sha>`). Returns the clone's path; `origin` lives alongside it.
 */
function makeRepoWithOrigin(root: string) {
  const originPath = path.join(root, 'origin.git');
  const repoPath = path.join(root, 'repo');
  execFileSync('git', ['init', '--quiet', '--bare', originPath], {
    cwd: root,
  });
  execFileSync('git', ['clone', '--quiet', originPath, repoPath], {
    cwd: root,
  });
  git(['config', 'user.name', 'Stranded fixture'], repoPath);
  git(['config', 'user.email', 'fixture@example.invalid'], repoPath);
  git(['checkout', '-q', '-b', 'development'], repoPath);
  commit(repoPath, 'trunk.txt', 'trunk init');
  git(['push', '-q', '-u', 'origin', 'development'], repoPath);
  return repoPath;
}

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe('extracting issue references from a commit message', () => {
  it('finds every #<number> mention, de-duplicated and sorted', () => {
    expect(
      extractIssueReferences('fixes #478, also touches #478 and #486'),
    ).toEqual([478, 486]);
  });

  it('returns an empty array when there is no reference', () => {
    expect(extractIssueReferences('unrelated commit message')).toEqual([]);
  });
});

describe('evaluating remote-ref presence — the control against a false-positive flood', () => {
  it('refuses (not-ok) when the clone has zero remote-tracking refs', () => {
    const result = evaluateRemoteRefPresence(0);
    expect(result.ok).toBe(false);
  });

  it('is ok once at least one remote-tracking ref exists', () => {
    expect(evaluateRemoteRefPresence(1).ok).toBe(true);
    expect(evaluateRemoteRefPresence(190).ok).toBe(true);
  });
});

describe('evaluating stranded branches — the pure judgement', () => {
  it('is CLEAN when every branch has zero stranded commits', () => {
    const result = evaluateStrandedBranches([
      { name: 'development', sha: 'a'.repeat(40), commits: [] },
      { name: 'feature', sha: 'b'.repeat(40), commits: [] },
    ]);
    expect(result.exitCode).toBe(EXIT_CLEAN);
    expect(result.stranded).toEqual([]);
    expect(result.branchesExamined).toBe(2);
  });

  it('reports STRANDED for a branch carrying at least one unreachable commit', () => {
    const result = evaluateStrandedBranches([
      { name: 'development', sha: 'a'.repeat(40), commits: [] },
      {
        name: 'feature',
        sha: 'b'.repeat(40),
        commits: [
          { sha: 'c'.repeat(40), subject: 'stranded work', issues: [] },
        ],
      },
    ]);
    expect(result.exitCode).toBe(EXIT_STRANDED);
    expect(result.stranded).toHaveLength(1);
    const [entry] = result.stranded;
    expect(entry?.branch).toBe('feature');
    expect(entry?.ahead).toBe(1);
  });
});

describe('formatting the report', () => {
  it('names the branch, the ahead count, and referenced issues when STRANDED', () => {
    const rendered = formatReport({
      branchesExamined: 2,
      exitCode: EXIT_STRANDED,
      stranded: [
        {
          branch: 'dev/jpapiez/issue-486-guard-tests',
          headSha: 'c1c5dfaa'.padEnd(40, '0'),
          ahead: 1,
          commits: [
            {
              sha: 'c1c5dfaa'.padEnd(40, '0'),
              subject: 'test(ci): pin cleanup discharge run guards (#486)',
              issues: [486],
            },
          ],
        },
      ],
    });
    expect(rendered).toContain('dev/jpapiez/issue-486-guard-tests');
    expect(rendered).toContain('ahead=1');
    expect(rendered).toContain('#486');
  });

  it('says CLEAN and names the count examined when there is nothing stranded', () => {
    const rendered = formatReport({
      branchesExamined: 46,
      exitCode: EXIT_CLEAN,
      stranded: [],
    });
    expect(rendered).toContain('CLEAN');
    expect(rendered).toContain('46');
  });
});

describe('the falsifier (#543): a real repo with a real unpushed commit', () => {
  it('THE FALSIFIER — a branch with no remote ref at all is reported STRANDED', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pfd-stranded-falsifier-'));
    const repoPath = makeRepoWithOrigin(tempRoot);

    git(['checkout', '-q', '-b', 'squad/543-never-pushed'], repoPath);
    commit(
      repoPath,
      'never-pushed.txt',
      'work that was never pushed, references #543',
    );
    // Deliberately no `git push` — this branch exists on no remote ref.

    const outcome = runCheck(repoPath);

    expect(outcome.exitCode).toBe(EXIT_STRANDED);
    expect(outcome.report).toContain('squad/543-never-pushed');
    expect(outcome.report).toContain('#543');
  });

  it('POSITIVE CONTROL — a branch fully pushed to origin reports CLEAN', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pfd-stranded-control-'));
    const repoPath = makeRepoWithOrigin(tempRoot);

    git(['checkout', '-q', '-b', 'squad/543-pushed'], repoPath);
    commit(repoPath, 'pushed.txt', 'work that was pushed');
    git(['push', '-q', '-u', 'origin', 'squad/543-pushed'], repoPath);

    const outcome = runCheck(repoPath);

    expect(outcome.exitCode).toBe(EXIT_CLEAN);
    expect(outcome.report).toContain('CLEAN');
    expect(outcome.report).not.toContain('squad/543-pushed');
  });

  it('distinguishes the two: one clone, one pushed branch, one unpushed branch', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pfd-stranded-mixed-'));
    const repoPath = makeRepoWithOrigin(tempRoot);

    git(['checkout', '-q', '-b', 'squad/543-pushed'], repoPath);
    commit(repoPath, 'pushed.txt', 'pushed work');
    git(['push', '-q', '-u', 'origin', 'squad/543-pushed'], repoPath);

    git(['checkout', '-q', 'development'], repoPath);
    git(['checkout', '-q', '-b', 'squad/543-unpushed'], repoPath);
    commit(repoPath, 'unpushed.txt', 'unpushed work');

    const outcome = runCheck(repoPath);

    expect(outcome.exitCode).toBe(EXIT_STRANDED);
    expect(outcome.report).toContain('squad/543-unpushed');
    expect(outcome.report).not.toContain('squad/543-pushed  ');
  });

  it('reports UNDETERMINED, not clean, when the clone has no remote refs at all', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pfd-stranded-no-remote-'));
    const repoPath = path.join(tempRoot, 'lone-repo');
    execFileSync('git', [
      'init',
      '--quiet',
      '--initial-branch=development',
      repoPath,
    ]);
    git(['config', 'user.name', 'Stranded fixture'], repoPath);
    git(['config', 'user.email', 'fixture@example.invalid'], repoPath);
    commit(repoPath, 'trunk.txt', 'trunk init, never fetched from any remote');

    const outcome = runCheck(repoPath);

    // Without the control, `--not --remotes` would exclude nothing and this
    // repo's own single commit would read "stranded" — a false positive from
    // an empty exclusion set, not a finding about unpushed work.
    expect(outcome.exitCode).toBe(EXIT_UNDETERMINED);
    expect(outcome.report).not.toContain('CLEAN');
  });

  it('listLocalBranches and listStrandedCommits agree with runCheck on the same repo', () => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pfd-stranded-direct-'));
    const repoPath = makeRepoWithOrigin(tempRoot);
    git(['checkout', '-q', '-b', 'squad/543-direct'], repoPath);
    commit(repoPath, 'direct.txt', 'direct-read work');

    const branches = listLocalBranches(repoPath);
    const target = branches.find((b) => b.name === 'squad/543-direct');
    expect(target).toBeDefined();

    const stranded = listStrandedCommits('squad/543-direct', repoPath);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]?.subject).toBe('direct-read work');
    expect(countRemoteRefs(repoPath)).toBeGreaterThan(0);
  });
});
