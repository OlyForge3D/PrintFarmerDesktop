import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classify, parseArgs } from '../scripts/sha-status.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SCRIPT = path.join(repoRoot, 'scripts', 'sha-status.mjs');

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function configure(cwd: string) {
  git(['config', 'user.email', 'squad@example.test'], cwd);
  git(['config', 'user.name', 'Squad'], cwd);
  git(['config', 'commit.gpgsign', 'false'], cwd);
}

function commit(cwd: string, subject: string, body = subject) {
  writeFileSync(path.join(cwd, 'f.txt'), `${body}\n`, 'utf8');
  git(['add', 'f.txt'], cwd);
  git(['commit', '-q', '-m', subject], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

function gitExit(args: string[], cwd: string) {
  try {
    git(args, cwd);
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

function run(args: string[], cwd: string) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failure.status ?? -1,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    };
  }
}

describe('the instrument everyone reaches for does not answer the question', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'sha-status-verify-'));
    git(['init', '-q', '--initial-branch=development', root], os.tmpdir());
    configure(root);
    commit(root, 'base');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('exits 0 from rev-parse --verify for an object that does not exist', () => {
    // The whole reason this tool uses `cat-file -e`. `--verify` validates the
    // SYNTAX of a rev expression, not the existence of what it names, so the
    // check most people reach for passes on an invented SHA. This is not a
    // claim about our code — it is the git behaviour the code is built around,
    // so it is pinned rather than described in a comment.
    const fabricated = 'a'.repeat(40);

    expect(() =>
      git(['rev-parse', '--verify', fabricated], root),
    ).not.toThrow();
    expect(() =>
      git(['cat-file', '-e', `${fabricated}^{commit}`], root),
    ).toThrow();

    const result = run([fabricated, '--base', 'development'], root);
    expect(result.stdout).toContain('ABSENT');
    expect(result.status).toBe(1);
  });
});

describe('a SHA quoted in a handoff has three failure modes and one instrument each', () => {
  let root: string;
  let remote: string;
  let work: string;
  let live: string;
  let supersededHead: string;
  let twin: string;
  let prHead: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'sha-status-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '-q', '--bare', '--initial-branch=development', remote], root);
    git(['clone', '-q', remote, work], root);
    configure(work);
    live = commit(work, 'base');
    git(['push', '-q', '--no-verify', '-u', 'origin', 'development'], work);

    // A branch with two heads: the first is superseded by the second, exactly
    // as a review round does. The PR ref records the LATER one.
    git(['checkout', '-q', '-b', 'feature'], work);
    supersededHead = commit(work, 'fix(git): refuse the thing (#81)', 'v1');
    const finalHead = commit(work, 'fix(git): refuse the thing (#81)', 'v2');
    prHead = finalHead;
    git(
      ['push', '-q', '--no-verify', 'origin', `${finalHead}:refs/pull/1/head`],
      work,
    );

    // The squash merge: the CONTENT lands on the base under a new object, and
    // the subject is concatenated into the merge body the way GitHub does it.
    git(['checkout', '-q', 'development'], work);
    writeFileSync(path.join(work, 'f.txt'), 'v2\n', 'utf8');
    git(['add', 'f.txt'], work);
    git(
      ['commit', '-q', '-m', 'fix(git): refuse the thing (#81)\n\nSquashed.'],
      work,
    );
    git(['push', '-q', '--no-verify', 'origin', 'development'], work);

    // A twin: a real object, on a real chain, that the PR ref does not contain.
    git(['checkout', '-q', '-b', 'parallel', supersededHead], work);
    twin = commit(work, 'parallel work', 'parallel');

    git(['fetch', '-q', 'origin'], work);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports a commit on the base as live', () => {
    const result = run([live, '--base', 'origin/development'], work);

    expect(result.stdout).toContain('LIVE');
    expect(result.status).toBe(0);
  });

  it('separates a superseded head from a twin, which nothing else does', () => {
    // Both exist, both resolve, neither is an ancestor of the base — and every
    // instrument reached for by reflex agrees they are fine.
    for (const sha of [supersededHead, twin]) {
      expect(gitExit(['cat-file', '-e', `${sha}^{commit}`], work)).toBe(0);
      expect(
        gitExit(
          ['merge-base', '--is-ancestor', sha, 'origin/development'],
          work,
        ),
      ).toBe(1);
    }

    const stale = run(
      [supersededHead, '--base', 'origin/development', '--pr', '1'],
      work,
    );
    expect(stale.stdout).toContain('STALE');

    const parallel = run(
      [twin, '--base', 'origin/development', '--pr', '1'],
      work,
    );
    expect(parallel.stdout).toContain('TWIN');
  });

  it('says it cannot tell them apart when no PR is named, rather than guessing', () => {
    // The refusing half. Without the PR ref the two cases above produce the
    // same observation, and picking either reading would be a claim the
    // evidence does not carry.
    const result = run([twin, '--base', 'origin/development'], work);

    expect(result.stdout).toContain('INDETERMINATE');
    expect(result.stdout).toContain('--pr');
    expect(result.status).toBe(1);
  });

  it('finds the work on the base by subject after a squash discarded the object', () => {
    const result = run(
      [supersededHead, '--base', 'origin/development', '--pr', '1'],
      work,
    );

    // The distinction the whole tool exists for: the OBJECT is gone and the
    // WORK shipped. Reporting only the first is how a merged branch gets
    // declared unmerged, four times in one day.
    const squash = git(['rev-parse', 'origin/development'], work);
    expect(result.stdout).toContain(squash.slice(0, 12));
  });

  it('does not report an open PR\u2019s own head as superseded', () => {
    // The defect this tool found in itself, on its first run against a live PR.
    // `--is-ancestor <sha> refs/pull/N/head` is TRUE for the head, because a
    // commit is its own ancestor — so ancestry alone called the current head
    // stale. Ancestry answers "was this ever on the chain"; the tip is exactly
    // where that stops being the same question as "has this been replaced".
    const head = prHead;

    expect(gitExit(['merge-base', '--is-ancestor', head, head], work)).toBe(0);

    const result = run(
      [head, '--base', 'origin/development', '--pr', '1'],
      work,
    );
    expect(result.stdout).toContain('PR-HEAD');
    expect(result.stdout).not.toContain('STALE');
    // ...and it must not be read as "the PR is open". The ref survives a merge.
    expect(result.stdout).toContain('NOT evidence the PR is open');
    expect(result.status).toBe(0);
  });

  it('reports that the work shipped even for an object no PR chain contains', () => {
    // Ripley's own case, and the commonest real one: the object exists, it
    // resolves, it is not an ancestor of anything, and its content is on trunk
    // regardless. Three different questions, and only the third is the one the
    // reader actually cares about.
    const result = classify({
      exists: true,
      onBase: false,
      onPr: false,
      shipped: 'f'.repeat(40),
    });

    expect(result.verdict).toBe('twin');
    expect(result.summary).toContain('the WORK landed');
  });

  it('does not use -S, which survives a squash but not a reword', () => {
    // The prescription this repo keeps repeating, held against the case it
    // fails on. The branch line was reworded before merging, so the added
    // string is absent from the base while the subject survives. A verdict
    // built on -S would report shipped work as lost.
    git(['checkout', '-q', '-b', 'reworded', 'origin/development'], work);
    writeFileSync(
      path.join(work, 'g.txt'),
      'this clone can answer the\n',
      'utf8',
    );
    git(['add', 'g.txt'], work);
    git(['commit', '-q', '-m', 'docs: state the limit plainly'], work);
    const branchHead = git(['rev-parse', 'HEAD'], work);

    git(['checkout', '-q', 'development'], work);
    writeFileSync(
      path.join(work, 'g.txt'),
      'this worktree can answer\n',
      'utf8',
    );
    git(['add', 'g.txt'], work);
    git(
      ['commit', '-q', '-m', 'docs: state the limit plainly\n\nSquashed.'],
      work,
    );
    git(['push', '-q', '--no-verify', 'origin', 'development'], work);
    git(['fetch', '-q', 'origin'], work);

    const byString = git(
      [
        'log',
        '--format=%H',
        '-S',
        'this clone can answer the',
        'origin/development',
      ],
      work,
    );
    const bySubject = git(
      [
        'log',
        '--format=%H',
        '--fixed-strings',
        '--grep=docs: state the limit plainly',
        'origin/development',
      ],
      work,
    );

    expect(byString).toBe('');
    expect(bySubject).not.toBe('');

    const result = run(
      [branchHead, '--base', 'origin/development', '--pr', '1'],
      work,
    );
    const squashOnBase = bySubject.split('\n')[0] ?? '';
    expect(squashOnBase).not.toBe('');
    expect(result.stdout).toContain(squashOnBase.slice(0, 12));
  });
});

describe('a merge commit\u2019s subject is not evidence about anything', () => {
  // Measured on PR #149, whose head is `Merge branch 'development' into
  // <branch>`. Dozens of unrelated PRs carry that subject verbatim, so a
  // `--grep` hit would be a false positive and a miss says nothing. Answering
  // either way would be the instrument reporting on a neighbouring question —
  // the failure this whole file is about.
  //
  // Its own repository rather than the shared fixture: the first version merged
  // two branches that both touched one file, left a conflicted index behind,
  // and broke the NEXT test in the describe. A fixture mutated by one case is
  // not a fixture.
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'sha-status-merge-'));
    git(['init', '-q', '--initial-branch=development', root], os.tmpdir());
    configure(root);
    commit(root, 'base');

    git(['checkout', '-q', '-b', 'side'], root);
    writeFileSync(path.join(root, 'side.txt'), 'side\n', 'utf8');
    git(['add', 'side.txt'], root);
    git(['commit', '-q', '-m', 'feat: the side work'], root);

    git(['checkout', '-q', 'development'], root);
    writeFileSync(path.join(root, 'trunk.txt'), 'trunk\n', 'utf8');
    git(['add', 'trunk.txt'], root);
    git(['commit', '-q', '-m', 'feat: the trunk work'], root);

    git(['checkout', '-q', 'side'], root);
    git(['merge', '-q', '--no-ff', '--no-edit', 'development'], root);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('declines the subject test instead of answering it', () => {
    const mergeHead = git(['rev-parse', 'HEAD'], root);

    expect(git(['log', '-1', '--format=%s', mergeHead], root)).toMatch(
      /^Merge /,
    );

    // Driven through the CLI with cwd set to the fixture. The helpers take no
    // cwd and inherit process.cwd(), which under vitest is this repository — a
    // direct call would have looked for the fixture's commit in the real repo,
    // failed, returned null, and passed for entirely the wrong reason.
    const result = run([mergeHead, '--base', 'development'], root);

    expect(result.stdout).toContain('could not be tested from the subject');
  });

  it('still answers the subject test for an ordinary commit in the same repo', () => {
    // The discriminator. Without it the assertion above is also satisfied by a
    // tool that never runs the subject test at all.
    const ordinary = git(['rev-parse', 'HEAD^2'], root);

    const result = run([ordinary, '--base', 'development'], root);

    expect(result.stdout).not.toContain('could not be tested from the subject');
  });
});

describe('the classifier does not soften a git failure into an answer', () => {
  it('reports an unresolvable base as unresolved, not as "not an ancestor"', () => {
    // `merge-base --is-ancestor` exits 128 for a missing ref and 1 for false.
    // Folding 128 into false turns "I could not look" into "I looked and it was
    // not there" — a finding manufactured out of an error.
    expect(
      classify({ exists: true, onBase: null, onPr: null, shipped: null })
        .verdict,
    ).toBe('unresolved');
  });

  it('does not call a superseded head a twin when the PR ref could not be fetched', () => {
    expect(
      classify({ exists: true, onBase: false, onPr: null, shipped: null })
        .verdict,
    ).toBe('indeterminate');
  });

  it('still reports stale when the object is on the PR but its work is not on the base', () => {
    const result = classify({
      exists: true,
      onBase: false,
      onPr: true,
      shipped: '',
    });

    expect(result.verdict).toBe('stale');
    expect(result.summary).toContain('may still be unmerged');
  });
});

describe('the arguments cannot be misread into a check that did not run', () => {
  it('rejects an abbreviated object name rather than expanding it', () => {
    // Abbreviations are where the `squad-name-audit` near-miss started: a short
    // prefix extended to full length by invention. A tool whose job is to
    // distrust quoted SHAs must not accept the form that made one up.
    expect(() => parseArgs(['0bc1455'])).toThrow(/full-length/);
  });

  it('rejects an unknown flag rather than silently ignoring it', () => {
    expect(() => parseArgs(['--survives-squash', 'a'.repeat(40)])).toThrow(
      /unknown option/,
    );
  });

  it('rejects a --pr that is not a number', () => {
    expect(() => parseArgs(['--pr', 'HEAD', 'a'.repeat(40)])).toThrow(/number/);
  });

  it('requires at least one object name', () => {
    expect(() => parseArgs(['--pr', '1'])).toThrow(/no object names/);
  });

  it('is reachable as an npm script, not just as a file', () => {
    // A check nobody can invoke is a check nobody runs. #301 is landing a
    // policy that fails the build for exactly this, and a tool arguing that
    // discipline should be executable has no business being the exception.
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts['sha:status']).toBe('node scripts/sha-status.mjs');
  });

  it('defaults the base to the tracking ref rather than the local branch', () => {
    // `development` and `origin/development` differ by exactly the window this
    // tool exists to measure.
    expect(parseArgs(['a'.repeat(40)]).base).toBe('origin/development');
  });
});
