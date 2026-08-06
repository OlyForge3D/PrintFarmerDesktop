import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  changedPaths,
  classify,
  controlsFrom,
  diffIsEmpty,
  evaluateMergeSurvival,
  firstParent,
  parseArgs,
  patchIdOf,
  runComparatorControls,
} from '../scripts/merge-survival.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SCRIPT = path.join(repoRoot, 'scripts', 'merge-survival.mjs');

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function write(cwd: string, file: string, lines: string[]) {
  writeFileSync(path.join(cwd, file), `${lines.join('\n')}\n`, 'utf8');
}

function commitAll(cwd: string, subject: string) {
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', subject], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

/** Ten lines of filler so a change can be moved without touching its own context. */
const filler = (tag: string) =>
  Array.from({ length: 10 }, (_, i) => `${tag}-${i}`);

/**
 * A repository shaped like this one: a branch that changes two files, a trunk that
 * moves underneath it, and several different ways of landing the branch on trunk.
 *
 * Every landing below is built with ordinary git rather than by asserting against a
 * fixture, because the whole subject is what real merge strategies do to objects.
 */
describe('merge survival: the change, not the graph', () => {
  let root: string;
  let branchHead: string;
  let trunkAhead: string;
  let squashLanding: string;
  let mergeLanding: string;
  let partialLanding: string;
  let unrelatedHead: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'merge-survival-'));
    git(['init', '-q', '--initial-branch=development', root], os.tmpdir());
    git(['config', 'user.email', 'squad@example.test'], root);
    git(['config', 'user.name', 'Squad'], root);
    git(['config', 'commit.gpgsign', 'false'], root);

    write(root, 'a.txt', [...filler('a'), 'ORIGINAL A']);
    write(root, 'b.txt', [...filler('b'), 'ORIGINAL B']);
    write(root, 'c.txt', ['untouched']);
    const base = commitAll(root, 'base');

    // The branch changes the LAST line of each file.
    git(['checkout', '-q', '-b', 'feature'], root);
    write(root, 'a.txt', [...filler('a'), 'BRANCH A']);
    commitAll(root, 'feat: change a');
    write(root, 'b.txt', [...filler('b'), 'BRANCH B']);
    branchHead = commitAll(root, 'feat: change b');

    // Trunk moves underneath it, including by prepending to a file the branch also
    // edits. Every line number in a.txt shifts; not one context line of the branch's
    // own change does.
    git(['checkout', '-q', 'development'], root);
    write(root, 'a.txt', ['PREPENDED BY TRUNK', ...filler('a'), 'ORIGINAL A']);
    write(root, 'c.txt', ['trunk moved on']);
    trunkAhead = commitAll(root, 'chore: trunk advances');

    // A squash landing: one parent, new object, the branch's whole change applied.
    write(root, 'a.txt', ['PREPENDED BY TRUNK', ...filler('a'), 'BRANCH A']);
    write(root, 'b.txt', [...filler('b'), 'BRANCH B']);
    squashLanding = commitAll(root, 'feat: change a and b (#1)');

    // A merge-commit landing of the same work, from the same trunk tip.
    git(['checkout', '-q', '-b', 'merge-lane', trunkAhead], root);
    git(
      ['merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'feature'],
      root,
    );
    mergeLanding = git(['rev-parse', 'HEAD'], root);

    // A landing that silently drops one of the two files. This is the case the whole
    // instrument exists for, and nothing else in this repository detects it.
    git(['checkout', '-q', '-b', 'partial-lane', trunkAhead], root);
    write(root, 'a.txt', ['PREPENDED BY TRUNK', ...filler('a'), 'BRANCH A']);
    partialLanding = commitAll(root, 'feat: change a and b (#1)');

    git(['checkout', '-q', '--orphan', 'unrelated'], root);
    git(['rm', '-q', '-r', '-f', '.'], root);
    write(root, 'unrelated.txt', ['separate root']);
    unrelatedHead = commitAll(root, 'unrelated root');

    expect(base).toMatch(/^[0-9a-f]{40}$/);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports INTACT for a squash merge, whose object is not an ancestor at all', () => {
    // The instrument everyone reaches for, on the same pair, for contrast.
    let ancestorExit = -1;
    try {
      git(['merge-base', '--is-ancestor', branchHead, squashLanding], root);
      ancestorExit = 0;
    } catch (error) {
      ancestorExit = (error as { status?: number }).status ?? -1;
    }
    expect(ancestorExit).toBe(1);

    const outcome = evaluateMergeSurvival(branchHead, squashLanding, root);
    expect(outcome.verdict).toBe('INTACT');
  });

  it('reports INTACT for a merge commit carrying the same change', () => {
    expect(evaluateMergeSurvival(branchHead, mergeLanding, root).verdict).toBe(
      'INTACT',
    );
  });

  it('survives a base that moved under the branch, which raw patch text does not', () => {
    // Trunk prepended a line to a.txt, so every hunk header in the branch's own change
    // is at a different offset in the landing. Whole-patch comparison calls this
    // DIVERGENT — three of thirty real pull requests, all of them merely stale.
    const branchDiff = execFileSync(
      'git',
      ['diff', '--no-color', trunkAhead, branchHead],
      { cwd: root, encoding: 'utf8' },
    );
    const mergeDiff = execFileSync(
      'git',
      ['diff', '--no-color', trunkAhead, squashLanding],
      { cwd: root, encoding: 'utf8' },
    );
    expect(branchDiff).not.toEqual(mergeDiff);

    expect(evaluateMergeSurvival(branchHead, squashLanding, root).verdict).toBe(
      'INTACT',
    );
  });

  it('reports DIVERGENT when the landing silently drops one file', () => {
    const outcome = evaluateMergeSurvival(branchHead, partialLanding, root);
    expect(outcome.verdict).toBe('DIVERGENT');
    expect(outcome.code).toBe(1);
  });

  it('exits 1 from the entry point on the dropped-file landing and 0 on the full one', () => {
    const run = (merge: string) =>
      execFileSync(
        process.execPath,
        [SCRIPT, '--head', branchHead, '--merge', merge],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );

    expect(run(squashLanding)).toContain('INTACT');

    let status = -1;
    let stdout = '';
    try {
      run(partialLanding);
      status = 0;
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      status = failure.status ?? -1;
      stdout = failure.stdout ?? '';
    }
    expect(status).toBe(1);
    expect(stdout).toContain('DIVERGENT');
  });

  it('does not claim the commit objects survived, because under squash they did not', () => {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, '--head', branchHead, '--merge', squashLanding],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(out).toContain('Commit objects are NOT claimed to survive');
  });

  it('runs both comparator arms on real objects, and the negative one can fail', () => {
    expect(runComparatorControls(trunkAhead, branchHead, root)).toBeNull();
    // The arm that matters: a change and its inverse must not hash alike, or the
    // comparator is incapable of returning DIVERGENT and every INTACT is worthless.
    expect(patchIdOf(trunkAhead, branchHead, root)).not.toEqual(
      patchIdOf(branchHead, trunkAhead, root),
    );
  });

  it('can report a control failure, so the passing case above is not vacuous', () => {
    // A `toBeNull()` assertion is satisfied by a function that returns null always —
    // which is precisely the shape of the checks this file exists to replace. Drive it
    // to the other answer with a range that has no patch identity at all.
    expect(runComparatorControls(branchHead, branchHead, root)).toMatch(
      /positive control/,
    );
  });

  it('separates an empty diff from an unreadable one', () => {
    expect(diffIsEmpty(branchHead, branchHead, root)).toBe(true);
    // patch-id prints nothing for an empty patch, so this is null for BOTH — which is
    // why classify() consults diffIsEmpty instead of inferring emptiness from null.
    expect(patchIdOf(branchHead, branchHead, root)).toBeNull();
    expect(patchIdOf('0'.repeat(40), branchHead, root)).toBeNull();
  });

  it('reads the base side of a merge commit as its first parent', () => {
    expect(firstParent(mergeLanding, root)).toBe(trunkAhead);
    expect(firstParent(squashLanding, root)).toBe(trunkAhead);
  });

  it('retains the no-common-ancestor reason when complete histories are unrelated', () => {
    const outcome = evaluateMergeSurvival(unrelatedHead, squashLanding, root);
    expect(outcome.verdict).toBe('INDETERMINATE');
    expect(outcome.reason).toBe('head and merge share no common ancestor');
    expect(outcome.facts.repositoryShallow).toBe(false);
  });
});

describe('a verdict this instrument has not earned', () => {
  const facts = {
    headKnown: true,
    mergeKnown: true,
    parent: 'p'.padEnd(40, '0'),
    base: 'b'.padEnd(40, '0'),
    repositoryShallow: null,
    branchEmpty: false,
    mergeEmpty: false,
    branchPatchId: 'a'.repeat(40),
    mergePatchId: 'a'.repeat(40),
  };

  it('is INTACT only when both patch identities were actually computed', () => {
    expect(classify(facts).verdict).toBe('INTACT');
    expect(classify({ ...facts, branchPatchId: null }).verdict).toBe(
      'INDETERMINATE',
    );
    expect(classify({ ...facts, mergePatchId: null }).verdict).toBe(
      'INDETERMINATE',
    );
  });

  it('never renders "I could not look" as destroyed work', () => {
    // Each of these is a failure to read. None may exit 1, because the remedy for a
    // false report of loss is to stop believing the instrument.
    const unreadable = [
      { ...facts, headKnown: false },
      { ...facts, mergeKnown: false },
      { ...facts, parent: null },
      { ...facts, base: null },
      { ...facts, branchEmpty: null },
      { ...facts, mergeEmpty: null },
    ];
    for (const variant of unreadable) {
      const outcome = classify(variant);
      expect(outcome.verdict).toBe('INDETERMINATE');
      expect(outcome.code).toBe(2);
    }
  });

  it('refuses to call an empty branch change INTACT', () => {
    // Two nothings comparing equal is how the ref-pair detector reported a deleted
    // branch as healthy. An empty branch means the head was misidentified.
    expect(classify({ ...facts, branchEmpty: true }).verdict).toBe(
      'INDETERMINATE',
    );
  });

  it('does call an empty merge against a non-empty branch DIVERGENT', () => {
    expect(classify({ ...facts, mergeEmpty: true }).verdict).toBe('DIVERGENT');
  });

  it('demands full object names, because a prefix silently resolves to something else', () => {
    expect(() =>
      parseArgs(['--head', 'abc', '--merge', 'b'.repeat(40)]),
    ).toThrow(/40-character/);
    expect(() => parseArgs(['--head', 'a'.repeat(40)])).toThrow(/usage/);
    expect(
      parseArgs(['--head', 'A'.repeat(40), '--merge', 'b'.repeat(40)]).head,
    ).toBe('a'.repeat(40));
  });

  it('fires every control arm, including the one real objects cannot provoke', () => {
    // No pair of commits makes a change equal its own inverse, so this arm is
    // unreachable from the repository and was unbound until it was split out. An arm
    // no test can reach is indistinguishable from an arm that was deleted.
    expect(
      controlsFrom('a'.repeat(40), 'a'.repeat(40), 'a'.repeat(40)),
    ).toMatch(/negative control: a change and its inverse compared equal/);
    expect(controlsFrom(null, null, 'b'.repeat(40))).toMatch(
      /positive control/,
    );
    expect(
      controlsFrom('a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)),
    ).toMatch(/hashed two ways/);
    expect(controlsFrom('a'.repeat(40), 'a'.repeat(40), null)).toMatch(
      /negative control: the inverse change has no patch identity/,
    );
    expect(
      controlsFrom('a'.repeat(40), 'a'.repeat(40), 'b'.repeat(40)),
    ).toBeNull();
  });
});

describe('merge survival with incomplete history', () => {
  let root: string;
  let source: string;
  let shallowVerdict: string;
  let shallowDiff: string;
  let branchHead: string;
  let mergeParent: string;
  let squashLanding: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'merge-survival-shallow-'));
    source = path.join(root, 'source');
    shallowVerdict = path.join(root, 'shallow-verdict');
    shallowDiff = path.join(root, 'shallow-diff');
    mkdirSync(source);

    git(['init', '-q', '--initial-branch=development', source], root);
    git(['config', 'user.email', 'squad@example.test'], source);
    git(['config', 'user.name', 'Squad'], source);
    git(['config', 'commit.gpgsign', 'false'], source);

    write(source, 'base.txt', ['base']);
    commitAll(source, 'base');

    git(['checkout', '-q', '-b', 'feature'], source);
    write(source, 'feature.txt', ['feature']);
    branchHead = commitAll(source, 'feature');

    git(['checkout', '-q', 'development'], source);
    write(source, 'trunk.txt', ['trunk']);
    mergeParent = commitAll(source, 'trunk advances');
    write(source, 'feature.txt', ['feature']);
    squashLanding = commitAll(source, 'feature lands');

    for (const destination of [shallowVerdict, shallowDiff]) {
      git(
        [
          'clone',
          '-q',
          '--depth',
          '2',
          '--branch',
          'development',
          pathToFileURL(source).href,
          destination,
        ],
        root,
      );
      git(
        [
          'fetch',
          '-q',
          '--depth',
          '1',
          'origin',
          'feature:refs/remotes/origin/feature',
        ],
        destination,
      );
    }
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('names incomplete clone history and the full-history remedy', () => {
    const outcome = evaluateMergeSurvival(
      branchHead,
      squashLanding,
      shallowVerdict,
    );
    expect(outcome.verdict).toBe('INDETERMINATE');
    expect(outcome.code).toBe(2);
    expect(outcome.facts.repositoryShallow).toBe(true);
    expect(outcome.reason).toContain('shallow clone');
    expect(outcome.reason).toContain('git fetch --unshallow');
    expect(outcome.reason).not.toContain('no common ancestor');

    git(['fetch', '-q', '--unshallow', 'origin'], shallowVerdict);
    expect(
      evaluateMergeSurvival(branchHead, squashLanding, shallowVerdict).verdict,
    ).toBe('INTACT');
  });

  it('surfaces a failing path-scoped three-dot diff instead of returning clean', () => {
    let failure: unknown;
    try {
      changedPaths(mergeParent, branchHead, ['feature.txt'], shallowDiff);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 128 });
    expect(String((failure as { stderr?: string }).stderr)).toContain(
      'no merge base',
    );

    git(['fetch', '-q', '--unshallow', 'origin'], shallowDiff);
    expect(
      changedPaths(mergeParent, branchHead, ['feature.txt'], shallowDiff),
    ).toEqual(['feature.txt']);
  });
});
