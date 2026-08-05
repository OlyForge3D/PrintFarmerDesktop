import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  classify,
  parseArgs,
  remoteTrackingParts,
} from '../scripts/sha-status.mjs';

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

  it('needs the ^{commit} peel, because a bare cat-file passes on a tree', () => {
    // `cat-file -e` is usually described as "the existence test", which is true
    // and answers a NEIGHBOURING question. A SHA in a handoff is claimed to be
    // a COMMIT; the bare form accepts any object, so a tree hash — which is a
    // 40-hex string indistinguishable from a commit in a message — reports
    // present. The peel is load-bearing, and this pins that rather than
    // trusting the `^{commit}` suffix to look decorative to a future reader.
    const tree = git(['rev-parse', 'development^{tree}'], root);

    expect(gitExit(['cat-file', '-e', tree], root)).toBe(0);
    expect(gitExit(['cat-file', '-e', `${tree}^{commit}`], root)).not.toBe(0);

    const result = run([tree, '--base', 'development'], root);
    expect(result.stdout).toContain('ABSENT');
    expect(result.status).toBe(1);
  });

  it('does not let a peeled miss be read as the exit code 1 everyone expects', () => {
    // The absent case changes exit code depending on the form: bare is 1,
    // peeled is 128. Code that branches on `=== 1` to mean "absent" therefore
    // reads a peeled miss as neither absent nor present. The tool tests `=== 0`
    // and treats everything else as "not a commit I can see", which is why this
    // asserts the two codes DIFFER rather than asserting either value alone.
    const fabricated = 'b'.repeat(40);

    expect(gitExit(['cat-file', '-e', fabricated], root)).toBe(1);
    expect(gitExit(['cat-file', '-e', `${fabricated}^{commit}`], root)).toBe(
      128,
    );
  });

  it('exits 0 from ls-remote for a branch that does not exist', () => {
    // Prescribed repeatedly here as the authoritative currency check. On a
    // deleted branch it prints nothing and SUCCEEDS, so a caller testing the
    // status rather than the output is told "fine" in the exact case the check
    // existed for. This tool never uses it; the pin exists so the prescription
    // cannot come back on the strength of it sounding authoritative.
    const bare = mkdtempSync(path.join(os.tmpdir(), 'sha-status-remote-'));
    try {
      git(['init', '-q', '--bare', bare], os.tmpdir());
      git(['remote', 'add', 'origin', bare], root);
      git(['push', '-q', 'origin', 'development'], root);

      expect(
        git(['ls-remote', 'origin', 'refs/heads/development'], root),
      ).not.toBe('');
      expect(gitExit(['ls-remote', 'origin', 'refs/heads/gone'], root)).toBe(0);
      expect(git(['ls-remote', 'origin', 'refs/heads/gone'], root)).toBe('');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('reports an orphan by succeeding with no output, and an absent object with 129', () => {
    // `for-each-ref --contains` is the cheapest orphan test available and needs
    // no network, which is why it belongs in the documented set. It has the
    // same shape as `ls-remote` above: the ANSWER IS THE OUTPUT, and the status
    // only says the query ran. Pinned together with the absent case because the
    // family has no convention to intuit — this command uses 129 where
    // `cat-file -e` uses 1 and `--is-ancestor` uses 128, and all three are
    // routinely read through a single boolean.
    git(['checkout', '-q', '-b', 'doomed'], root);
    commit(root, 'work on a branch about to vanish');
    const orphan = git(['rev-parse', 'HEAD'], root);
    git(['checkout', '-q', 'development'], root);
    git(['branch', '-q', '-D', 'doomed'], root);

    // The object is fine. That is exactly why an orphan is hard to see.
    expect(gitExit(['cat-file', '-e', `${orphan}^{commit}`], root)).toBe(0);

    expect(gitExit(['for-each-ref', '--contains', orphan], root)).toBe(0);
    expect(git(['for-each-ref', '--contains', orphan], root)).toBe('');

    const live = git(['rev-parse', 'development'], root);
    expect(git(['for-each-ref', '--contains', live], root)).not.toBe('');

    expect(gitExit(['for-each-ref', '--contains', 'c'.repeat(40)], root)).toBe(
      129,
    );
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

describe('the base is a cache, and this tool shipped trusting it', () => {
  // Question 2 is "is it live on the trunk", and it was asked against
  // `refs/remotes/origin/development` — a local ref that only `fetch` writes.
  // Measured in a clone thirty commits behind: a commit that IS on the trunk
  // came back `INDETERMINATE - exists, is not on the base`. That is the defect
  // of `--force-with-lease` reproduced inside the tool written to catch stale
  // claims, so these tests exist to keep it caught.
  let root: string;

  const staleClone = (name: string) => {
    const remote = path.join(root, `${name}.git`);
    const work = path.join(root, name);
    git(['init', '-q', '--bare', '--initial-branch=development', remote], root);
    git(['clone', '-q', remote, work], root);
    configure(work);
    commit(work, 'first');
    git(['push', '-q', '--no-verify', '-u', 'origin', 'development'], work);
    const landed = commit(work, 'landed after this clone last fetched');
    git(['push', '-q', '--no-verify', 'origin', 'development'], work);
    // Rewind only the remote-tracking ref: the object is on the branch, and
    // this clone's cached view predates it. No fetch has happened since.
    git(
      [
        'update-ref',
        'refs/remotes/origin/development',
        'refs/heads/development~1',
      ],
      work,
    );
    return { remote, work, landed };
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'sha-status-base-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports a commit that landed since the last fetch as live, not as missing', () => {
    const { work, landed } = staleClone('fresh');

    // Without this the test passes for the wrong reason: if the cached ref
    // already contained the commit, every implementation looks correct.
    expect(
      gitExit(
        [
          'merge-base',
          '--is-ancestor',
          landed,
          'refs/remotes/origin/development',
        ],
        work,
      ),
    ).toBe(1);

    const result = run([landed, '--base', 'origin/development'], work);

    // TIP rather than LIVE since #438. `landed` is the tip of `development` by
    // construction two lines above, and the tip is now reported as such: the
    // ancestry answer could not tell a head from its predecessors, so all of
    // them printed "Current." What this test is about is unchanged - the commit
    // must come back as on the trunk rather than as missing - and TIP is that
    // answer stated more precisely, not a different one.
    expect(result.stdout).toContain('TIP');
    expect(result.stdout).not.toContain('INDETERMINATE');
    expect(result.status).toBe(0);
  });

  it('refuses to convict when the base is stale and cannot be refreshed', () => {
    const { work, landed } = staleClone('offline');
    // A path that does not exist fails immediately and without prompting,
    // which a bad URL does not reliably do on every runner.
    git(['remote', 'set-url', 'origin', path.join(root, 'gone.git')], work);

    expect(
      gitExit(
        [
          'merge-base',
          '--is-ancestor',
          landed,
          'refs/remotes/origin/development',
        ],
        work,
      ),
    ).toBe(1);

    const result = run([landed, '--base', 'origin/development'], work);

    expect(result.stdout).toContain('BASE-STALE');
    expect(result.stderr).toContain('could not refresh');
    // The failure that matters is not the refusal, it is the alternative: the
    // tool must not go on to hunt for the subject and report the work lost.
    expect(result.stdout).not.toContain('never landed');
    expect(result.status).toBe(1);
  });

  it('leaves a base that is not a remote-tracking ref alone', () => {
    const { work, landed } = staleClone('localbase');

    // `development` here is the local branch, which is not a cache of anything
    // and is already correct. Refreshing is not this tool's business.
    const result = run([landed, '--base', 'development'], work);

    // TIP rather than LIVE since #438, for the same reason as above: `landed`
    // is the tip of the local `development` this run is pointed at. The
    // property under test is the one in the title - a non-remote-tracking base
    // is left alone - and it is untouched by which of the two on-trunk verdicts
    // comes back.
    expect(result.stdout).toContain('TIP');
    expect(result.stderr).not.toContain('could not refresh');
    expect(result.status).toBe(0);
  });

  it('names the remote-tracking refs and only those', () => {
    expect(remoteTrackingParts('origin/development')).toEqual({
      remote: 'origin',
      branch: 'development',
    });
    expect(remoteTrackingParts('refs/remotes/origin/development')).toEqual({
      remote: 'origin',
      branch: 'development',
    });
    expect(remoteTrackingParts('upstream/main', 'upstream')).toEqual({
      remote: 'upstream',
      branch: 'main',
    });
    // A local branch and a raw SHA are not caches.
    expect(remoteTrackingParts('development')).toBeNull();
    expect(remoteTrackingParts('a'.repeat(40))).toBeNull();
    // Right shape, wrong remote.
    expect(remoteTrackingParts('origin/development', 'upstream')).toBeNull();
  });

  it('guards only the direction that can be wrong', () => {
    // What this pins is the observable behaviour, and specifically that the
    // refusal never swallows a sound answer. It would catch someone moving the
    // stale-base block above the `onBase === true` arm. It does NOT pin the
    // `onBase === false` clause itself: widening that condition is equivalent
    // today, and a mutation doing so survives this suite. Said out loud because
    // a surviving mutation reported is worth more than a green not examined.
    expect(
      classify({
        exists: true,
        baseFresh: false,
        onBase: false,
        onPr: null,
        shipped: null,
      }).verdict,
    ).toBe('base-stale');

    // An ancestor of a stale base is still an ancestor of the live one, because
    // the live tip descends from the cached tip. Guarding this direction too
    // would refuse to answer a question it can answer.
    expect(
      classify({
        exists: true,
        baseFresh: false,
        onBase: true,
        onPr: null,
        shipped: null,
      }).verdict,
    ).toBe('live');
  });
});

/**
 * #438. `--is-ancestor` is true of the tip and of every commit behind it, which
 * is what ancestry is for, so the trunk tip and a commit forty behind it came
 * back byte-identical - same verdict, same summary, both ending "Current." Two
 * sessions quoted an interior commit as the live head within one hour.
 *
 * The assertions here are properties, not strings. Every subject is built from
 * the base at runtime and every expected distance is measured by an independent
 * `rev-list --count`, so nothing here can be satisfied by a hard-coded verdict
 * and nothing rots into a false red when the wording changes. A fixed-string
 * guard on this file would reproduce `supplyChainPolicy.test.ts`, which reddens
 * correct work without gaining safety.
 */
describe('the tip and its ancestors are told apart, which ancestry alone cannot do', () => {
  let root: string;
  let work: string;
  let tip: string;
  let mid: string;
  let old: string;

  const BEHIND = 6;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'sha-status-tip-'));
    const remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');
    git(['init', '-q', '--bare', '--initial-branch=development', remote], root);
    git(['clone', '-q', remote, work], root);
    configure(work);
    for (let i = 0; i <= BEHIND; i += 1) commit(work, `commit ${i}`);
    git(['push', '-q', '--no-verify', '-u', 'origin', 'development'], work);
    git(['fetch', '-q', 'origin'], work);

    tip = git(['rev-parse', 'origin/development'], work);
    mid = git(['rev-parse', `origin/development~${BEHIND - 1}`], work);
    old = git(['rev-parse', `origin/development~${BEHIND}`], work);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** The verdict and summary for one SHA, with the SHA itself removed. */
  const reportFor = (stdout: string, sha: string) => {
    const lines = stdout.split('\n');
    const index = lines.findIndex((l) => l.includes(sha.slice(0, 12)));
    expect(index).toBeGreaterThanOrEqual(0);
    return `${lines[index]}\n${lines[index + 1]}`
      .replace(sha.slice(0, 12), '')
      .trim();
  };

  /** The verdict token alone, read from the line rather than named here. */
  const verdictFor = (stdout: string, sha: string) => {
    const [line] = reportFor(stdout, sha).split('\n');
    // Asserted rather than defaulted. A silent `?? ''` would make two missing
    // lines compare equal, so the inequality below could pass on nothing.
    expect(line).toBeDefined();
    return (line ?? '').trim();
  };

  it('holds its own premises: all three are ancestors, and only one is the tip', () => {
    // Without this the block proves nothing. If a subject were not an ancestor
    // it would take a different arm entirely, and the reports would differ for
    // a reason that has nothing to do with the defect.
    for (const sha of [tip, mid, old]) {
      expect(
        gitExit(
          ['merge-base', '--is-ancestor', sha, 'origin/development'],
          work,
        ),
      ).toBe(0);
    }
    expect(git(['rev-parse', 'origin/development'], work)).toBe(tip);
    expect(mid).not.toBe(tip);
    expect(old).not.toBe(tip);
    expect(
      Number(git(['rev-list', '--count', `${old}..origin/development`], work)),
    ).toBe(BEHIND);
  });

  it('does not give the tip and an ancestor the same report', () => {
    const { stdout, status } = run(
      [tip, mid, old, '--base', 'origin/development'],
      work,
    );

    const atTip = reportFor(stdout, tip);
    const atMid = reportFor(stdout, mid);
    const atOld = reportFor(stdout, old);

    // The anti-vacuity control, and it is the whole reason this test is worth
    // having: every report differs by the SHA it names, so comparing raw lines
    // would pass against the defect it is written for. The comparison is only
    // meaningful once the SHA is gone, so that removal is asserted rather than
    // assumed.
    for (const [report, sha] of [
      [atTip, tip],
      [atMid, mid],
      [atOld, old],
    ] as const) {
      expect(report).not.toContain(sha.slice(0, 12));
    }

    expect(atTip).not.toBe(atOld);
    expect(atTip).not.toBe(atMid);
    // The two ancestors must differ from each other too. Without this, a fix
    // that said "not the head" and stopped would pass - and a reader still
    // could not tell one commit behind from forty.
    expect(atMid).not.toBe(atOld);

    // The verdicts themselves must differ, and this is the assertion that
    // actually pins the repair. Measured, not assumed: with the tip arm removed
    // the tip falls through to the ancestor arm at distance zero and prints
    // "an unmeasured distance behind the tip", which still differs textually
    // from an ancestor's line - so the three comparisons above all pass against
    // the defect. They establish that the reports are distinguishable; only
    // this one establishes that the tip is identified as the tip. Neither
    // token is named here, so the wording stays free to change.
    expect(verdictFor(stdout, tip)).not.toBe(verdictFor(stdout, mid));
    expect(verdictFor(stdout, mid)).toBe(verdictFor(stdout, old));

    // The tip stays a clean bill. `tip` was carved out of `live`, and the exit
    // code tests verdicts by value, so the head itself was one omission away
    // from exiting 1 while its own predecessors exited 0.
    expect(status).toBe(0);
  });

  it('reports the measured distance, not merely that there is one', () => {
    const { stdout } = run([mid, old, '--base', 'origin/development'], work);

    // Measured independently, so the expectation cannot drift with the fixture.
    for (const sha of [mid, old]) {
      const distance = git(
        ['rev-list', '--count', `${sha}..origin/development`],
        work,
      );
      expect(Number(distance)).toBeGreaterThan(0);
      expect(reportFor(stdout, sha)).toContain(distance);
    }
  });

  it('withdraws the claim of currency from everything that is not the head', () => {
    const { stdout } = run([tip, old, '--base', 'origin/development'], work);

    // The word two sessions acted on. It may appear for the tip, which is the
    // only subject it was ever true of.
    expect(reportFor(stdout, old)).not.toContain('Current.');
  });

  it('says so rather than guessing when the tip cannot be resolved by equality', () => {
    // classify is pure, so the arm that has ancestry but no equality answer is
    // reachable without contriving a repository state to produce it.
    const undecided = classify({
      exists: true,
      onBase: true,
      onPr: null,
      isBaseTip: null,
      behind: null,
      shipped: null,
    });

    expect(undecided.verdict).toBe('live');
    expect(undecided.summary).not.toContain('Current.');
    // Not "0 commits behind": unknown and zero are different answers, and the
    // second is the one a reader would act on.
    expect(undecided.summary).not.toMatch(/\b0 commits?\b/);
  });
});
