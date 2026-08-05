import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const read = (...segments: string[]) =>
  readFileSync(path.join(repositoryRoot, ...segments), 'utf8');

const workflowsDir = path.join(repositoryRoot, '.github', 'workflows');

// The path the workflow was parked at while it could not be pushed. Named once
// so the denial case and the staleness case cannot drift apart, and asserted
// absent rather than assumed gone.
const stagedWorkflowPath = path.join(
  '.squad',
  'fact-checker',
  'citation-reachability.workflow.yml',
);
const liveWorkflows = readdirSync(workflowsDir)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({
    file: f,
    text: readFileSync(path.join(workflowsDir, f), 'utf8'),
  }));

const HARNESS = 'scripts/check-citation-reachability.mjs';
const SCRIPT_NAME = 'check:citation-reachability';

const invokers = liveWorkflows.filter((w) =>
  w.text.includes(`npm run ${SCRIPT_NAME}`),
);
const enforcingWorkflow = invokers[0];
const isEnforced = enforcingWorkflow !== undefined;
// Read from the live workflow only. While the workflow was staged in `.squad/`,
// every case below fell back to the staged copy, so `isEnforced` was false in a
// working tree that had not yet merged the wiring commit and true in CI, whose
// `pull_request` checkout is a merge with the base - the same suite testing two
// different files at one commit and reporting one verdict. The two copies had
// already drifted by twenty lines when this was measured. An empty string here
// fails every matcher loudly rather than silently substituting another file.
const workflowText = enforcingWorkflow?.text ?? '';

/**
 * #121. The harness that checks citation reachability was landed complete,
 * controlled, and with zero call sites: no npm script, no workflow, no test,
 * and none of the check runs at that head was this one. It had executed exactly
 * once - on the author's machine, at authoring time, which is precisely the
 * position it exists to compensate for. A revision orphaned by a rebase keeps
 * resolving for whoever wrote the citation and resolves for no reader, so an
 * instrument aimed at the author's blind spot cannot be run only by the author.
 *
 * Three artifacts simultaneously asserted, in the present tense, that the check
 * was "Enforced by" that file. Those sentences were false, and nothing could
 * have reported them false: a green pull request reads identically whether a
 * check passed or was never invoked. The harness was correct, and correctness
 * is what made the omission invisible.
 *
 * The workflow could not be pushed from the branch that wrote the harness - that
 * token lacks the `workflow` OAuth scope, and the Contents API refuses the same
 * path - so it was staged in `.squad/` for a maintainer to move. A maintainer
 * has since moved it: `.github/workflows/citation-reachability.yml` is live and
 * runs `npm run check:citation-reachability` on every pull request, and the
 * live copy has since gained a step the staged one never had. The staged copy
 * is therefore removed rather than kept as a second source that can drift, and
 * its header - which asserted in the present tense that nothing enforced the
 * check - is removed with it. The final case below still revokes the licence to
 * claim enforcement automatically if the live workflow ever disappears.
 */
describe('the citation-reachability harness is invoked, not merely present', () => {
  it('is exposed as an npm script pointing at the harness', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts[SCRIPT_NAME]).toBe(`node ${HARNESS}`);
  });

  it('is enforced by a live workflow rather than a staged copy', () => {
    expect(isEnforced).toBe(true);
  });

  it('subscribes to pull_request, the only event carrying the branch to check', () => {
    const workflow = workflowText;

    // `\r?` because the working tree is CRLF on Windows checkouts and LF in CI;
    // a regex that passes on one and fails on the other reports the platform
    // rather than the workflow. Found by the negative control, not by review.
    expect(workflow).toMatch(/^on:\r?\n\s+pull_request:/m);
    // synchronize is load-bearing: without it the check would run on a branch's
    // first commit and never again, so a citation orphaned by a later rebase -
    // the exact mechanism in scope - would never be examined.
    expect(workflow).toMatch(/types:\s*\[[^\]]*\bsynchronize\b[^\]]*\]/);
  });

  it('checks out the graph it needs rather than a depth-1 merge commit', () => {
    const workflow = workflowText;

    // Reachability, the patch-id twin index and the declared-route probes all
    // read history. A shallow checkout would report orphans a reader can in
    // fact reach, and a check that fails for the wrong reason gets ignored.
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('github.event.pull_request.head.sha');
    expect(workflow).toContain('refs/remotes/origin/development');
  });

  it('declares a merge-queue class, and does not claim to report for a queued entry', () => {
    const workflow = workflowText;

    // advisory: emits a check run on pull_request, does not report under
    // merge_group, and therefore must never become a required context - a
    // required context nothing emits sits Pending forever and blocks the queue.
    expect(workflow).toMatch(/^#\s*merge-queue:\s*advisory$/m);
    expect(workflow).not.toMatch(/^\s+merge_group:/m);
  });

  it('lets no artifact claim enforcement while nothing enforces it', () => {
    const claimants = [
      '.squad/fact-checker/policy.md',
      '.squad/fact-checker/audit-trail.md',
      '.squad/decisions/inbox/sha-reporting-rule.md',
      '.squad/decisions/inbox/fact-checker-symmetric-diff.md',
    ].filter((f) =>
      // Quotation spans are stripped first. Run I of the audit trail measured
      // `_"..."_` as this repository's in-use mention marker, and the entry
      // recording this very defect necessarily quotes the false sentence it is
      // withdrawing. A detector that cannot tell a retraction from the claim it
      // retracts scores a hit on the document doing the retracting - which is
      // the failure this suite exists to prevent, arriving in the suite itself.
      /Enforced (by|on every pull request)/.test(
        read(...f.split('/')).replace(/_"[^"]*"_/g, ''),
      ),
    );

    // One-directional. An artifact is free to say nothing; what it may not do is
    // assert enforcement that does not exist. This is the exact defect the entry
    // above records, expressed so that it fails a test instead of a reader.
    if (!isEnforced) {
      expect(claimants).toEqual([]);
    }
  });

  // The other direction, added after it fired. While `isEnforced` was false the
  // case above carried the whole burden; the moment a maintainer moved the
  // workflow it became `if (false)`, an assertion whose outcome is decided by a
  // condition outside its subject - the same shape as a guard that is constantly
  // true, only quieter, because a vacuous test reports success.
  //
  // What it left uncovered is the reverse claim. Three normative documents went
  // on stating that the check was *not* enforced, and naming a staged path that
  // had been deleted, for hours after the live workflow began passing on every
  // pull request. Nothing failed, because denial was never the modelled failure.
  //
  // A stale denial is the more dangerous of the two: an over-claim invites the
  // reader to check and be disappointed, while an under-claim invites them not
  // to rely on a control that is in fact protecting them, and it decays silently
  // toward *do the work by hand*.
  //
  // The ledger is deliberately not a subject here, and the asymmetry is the
  // point rather than an exemption. `audit-trail.md` records dated observations
  // that were true when taken; a present-tense detector run over a historical
  // record would demand the record be falsified to pass. A policy asserts what
  // is true now and must track the object. Only the normative documents are
  // checked, and the trail records the transition in a new entry instead.
  it('lets no artifact deny enforcement while something enforces it', () => {
    const deniers = [
      '.squad/fact-checker/policy.md',
      '.squad/decisions/inbox/sha-reporting-rule.md',
      '.squad/decisions/inbox/fact-checker-symmetric-diff.md',
    ].filter((f) => {
      const text = read(...f.split('/')).replace(/_"[^"]*"_/g, '');
      return (
        /Not yet enforced/.test(text) ||
        /citation-reachability\.workflow\.yml/.test(text)
      );
    });

    if (isEnforced) {
      expect(deniers).toEqual([]);
    }
  });

  // Neither case above can fail while `isEnforced` is misread, so the flag gets
  // its own assertion rather than being trusted by the two that branch on it.
  it('decides enforcement from a workflow that actually invokes the harness', () => {
    expect(isEnforced).toBe(true);
    expect(workflowText).toContain('check:citation-reachability');
    expect(existsSync(path.join(repositoryRoot, stagedWorkflowPath))).toBe(
      false,
    );
  });
});

/**
 * #445. A declared twin was accepted on reachability alone. The verdict string named its own
 * two properties - "(declared, reachable)" - and twinship was not among them, so the single
 * claim the line made was the one claim nothing had checked. The whole route is
 * `patch-id hint -> a human writes a declaration -> the checker trusts it`, and no step in it
 * compared any content: a mistyped SHA, or any reachable commit at all, passed.
 *
 * The obvious repair is the wrong one, and it is worth stating why it is not used here.
 * `patch-id` hashes the diff *including context*, so the same appended lines landing on
 * different neighbours after a rebase produce different ids - and a rebase is exactly what
 * orphans the citation that makes a twin declaration necessary in the first place. Comparing
 * patch-ids would therefore reject genuine twins, most often on the busiest files. Arm B below
 * is that hazard as a test rather than as a claim: its twin is real but its context has moved.
 *
 * The check also may not simply *require* a content match, because the reader it speaks for
 * does not hold the orphaned object and never can. Presence is consulted in the refuting
 * direction only: it can withdraw a pass, never manufacture one. Arm C is that boundary - the
 * same declaration, from a position with no object, still passes, and now says so.
 */
describe('a declared twin is checked for being a twin', () => {
  const made: string[] = [];

  const run = (dir: string, args: string[] = []) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

  const commit = (dir: string, message: string) => {
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-qm', message], {
      stdio: 'ignore',
    });
    return run(dir, ['rev-parse', 'HEAD']);
  };

  const ledger = (dir: string, citedSha: string, twinSha: string | null) =>
    writeFileSync(
      path.join(dir, '.squad', 'fact-checker', 'audit-trail.md'),
      [
        '# Audit trail',
        '',
        `The finding was recorded at \`${citedSha}\`.`,
        '',
        ...(twinSha
          ? [
              '## Superseded citations and their live twins',
              '',
              `- \`${citedSha}\` - \`${twinSha}\` rebased onto the current base.`,
              '',
            ]
          : []),
      ].join('\n'),
    );

  const runHarness = (dir: string) => {
    const r = spawnSync('node', ['scripts/check-citation-reachability.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  /**
   * One repository carries all three arms, so nothing separates them but the declaration
   * under test. `cited` is appended, then reset away: the object is still in the store and
   * still resolves, and is reachable from nothing - the exact position of a citation orphaned
   * by a rebase. `genuineTwin` re-adds those identical lines after a padding commit has moved
   * the context beneath them, so it is a true twin whose patch-id differs.
   */
  const fixture = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'twin-'));
    made.push(dir);
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C',
      dir,
      'config',
      'user.email',
      't@example.invalid',
    ]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, '.squad', 'fact-checker'), { recursive: true });
    copyFileSync(
      path.join(repositoryRoot, HARNESS),
      path.join(dir, 'scripts', 'check-citation-reachability.mjs'),
    );
    writeFileSync(path.join(dir, '.squad', 'fact-checker', 'policy.md'), '');

    const notes = path.join(dir, 'notes.md');
    writeFileSync(notes, 'opening line\n');
    ledger(dir, '0'.repeat(40), null);
    commit(dir, 'seed');

    const FINDING = 'the sidecar was absent\nand the control could not fire\n';
    writeFileSync(notes, `opening line\n${FINDING}`);
    const cited = commit(dir, 'the finding');

    execFileSync('git', ['-C', dir, 'reset', '-q', '--hard', 'HEAD~1'], {
      stdio: 'ignore',
    });

    writeFileSync(notes, 'opening line\ncontext that arrived in between\n');
    commit(dir, 'padding that moves the context');

    writeFileSync(
      notes,
      `opening line\ncontext that arrived in between\n${FINDING}`,
    );
    const genuineTwin = commit(dir, 'the finding, rebased');

    writeFileSync(path.join(dir, 'other.md'), 'an entirely unrelated change\n');
    const unrelated = commit(dir, 'unrelated work');

    return { dir, cited, genuineTwin, unrelated };
  };

  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('holds the fixture to its own premises before anything is asserted on it', () => {
    const { dir, cited, genuineTwin, unrelated } = fixture();

    // Unless the cited object is present AND unreachable, arm A cannot fail for the reason
    // it claims, and a green would mean nothing.
    expect(run(dir, ['cat-file', '-t', cited])).toBe('commit');
    expect(
      spawnSync('git', [
        '-C',
        dir,
        'merge-base',
        '--is-ancestor',
        cited,
        'HEAD',
      ]).status,
    ).not.toBe(0);
    for (const reachableSha of [genuineTwin, unrelated]) {
      expect(
        spawnSync('git', [
          '-C',
          dir,
          'merge-base',
          '--is-ancestor',
          reachableSha,
          'HEAD',
        ]).status,
      ).toBe(0);
    }

    // And the twin must be one `patch-id` cannot see, or arm B passes without exercising the
    // hazard it exists for.
    const patchId = (rev: string) =>
      execFileSync('git', ['patch-id', '--stable'], {
        input: execFileSync('git', ['-C', dir, 'show', rev], {
          encoding: 'utf8',
          maxBuffer: 1 << 28,
        }),
        encoding: 'utf8',
      }).split(' ')[0];
    expect(patchId(cited)).not.toBe(patchId(genuineTwin));
  });

  it('ARM A: does not claim twinship for a reachable commit that is not a twin', () => {
    const { dir, cited, unrelated } = fixture();
    ledger(dir, cited, unrelated);

    const { status, out } = runHarness(dir);

    // The defect: the old verdict read "(declared, reachable)" here, naming two properties
    // while the reader took it as asserting a third. The pass itself is not withdrawn - see
    // ARM D for why refusing it is not available - but it no longer claims what nothing checked.
    expect(out).toContain('TWINSHIP UNVERIFIED');
    expect(out).not.toContain('content verified');
    expect(status).toBe(0);
  });

  it('ARM B: recognises a real twin whose context moved under it', () => {
    const { dir, cited, genuineTwin } = fixture();
    ledger(dir, cited, genuineTwin);

    const { status, out } = runHarness(dir);

    // The arm that makes ARM A attributable. Without it, "ARM A says unverified" is equally
    // consistent with a check that can never verify anything.
    expect(out).toContain('content verified');
    expect(out).not.toContain('TWINSHIP UNVERIFIED');
    expect(status).toBe(0);
  });

  it('ARM C: says unverified from a position that holds no object at all', () => {
    const { dir, genuineTwin } = fixture();
    ledger(dir, 'a'.repeat(40), genuineTwin);

    const { status, out } = runHarness(dir);

    // The reader's position, and the reason a content match may never be *required*: the
    // reader cannot hold the orphaned object, so requiring one reports ORPHAN for everyone
    // but the author - the asymmetry this harness exists to avoid.
    expect(status).toBe(0);
    expect(out).toContain('TWINSHIP UNVERIFIED');
  });

  /**
   * The regression guard for the fix that was nearly shipped instead of this one.
   *
   * Every twin declaration in this repository names a squash - 41 commits of #162 collapsed
   * into one - so the twin's content is the union of its inputs and identical to none of them.
   * Measured against the live ledger, requiring equality refused 34 of 44 correct rows and
   * requiring containment still refused 30, because a long squash legitimately loses the
   * intermediate states when a later commit edits a line an earlier one added.
   *
   * This fixture is that shape at small scale: `beta` is added by the cited revision and no
   * longer present in the squash, so containment fails and the row is still correct. A check
   * that reddens it is worse than one that says nothing.
   */
  it('ARM D: never reddens a squash whose intermediate lines did not survive', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'squash-'));
    made.push(dir);
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C',
      dir,
      'config',
      'user.email',
      't@example.invalid',
    ]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, '.squad', 'fact-checker'), { recursive: true });
    copyFileSync(
      path.join(repositoryRoot, HARNESS),
      path.join(dir, 'scripts', 'check-citation-reachability.mjs'),
    );
    writeFileSync(path.join(dir, '.squad', 'fact-checker', 'policy.md'), '');

    const notes = path.join(dir, 'notes.md');
    writeFileSync(notes, 'opening line\n');
    ledger(dir, '0'.repeat(40), null);
    commit(dir, 'seed');

    writeFileSync(notes, 'opening line\nalpha\nbeta\n');
    const citedOnBranch = commit(dir, 'work, later revised');

    execFileSync('git', ['-C', dir, 'reset', '-q', '--hard', 'HEAD~1'], {
      stdio: 'ignore',
    });

    // The squash: `alpha` survived, `beta` was revised away before the merge.
    writeFileSync(notes, 'opening line\nalpha\ngamma\n');
    const squash = commit(dir, 'squashed #162');

    ledger(dir, citedOnBranch, squash);
    const { status, out } = runHarness(dir);

    expect(status).toBe(0);
    expect(out).not.toContain('ORPHANED CITATIONS');
    expect(out).toContain('TWINSHIP UNVERIFIED');
  });

  it('carries a control proving the comparison can separate two revisions', () => {
    const { dir, cited, genuineTwin } = fixture();
    ledger(dir, cited, genuineTwin);

    // A comparison that always matched would stamp "content verified" on every declaration -
    // the same false reassurance in a new costume - so it is measured in-band, not assumed.
    expect(runHarness(dir).out).toContain(
      'control: the twin comparison separates two distinct revisions true',
    );
  });

  /**
   * The control above is only worth having if it runs where the harness runs. It did not.
   * `git show` renders a merge as a combined diff - one column per parent, every line
   * `++`-prefixed - so the added-line reader reports null for one, and the first version of
   * this control read HEAD and HEAD~1 directly. On any checkout of a branch that has been
   * updated from its base, both are merge commits, so the block was skipped, printed nothing,
   * and the run passed. Measured on this repository: with the broken comparison installed, the
   * old selection exits 0 and the current one exits 2.
   *
   * That is the failure this suite exists to catch, committed inside the fix for it, so the
   * guard is a merge commit at HEAD and the assertion is that the control was exercised at all.
   * The negative half matters as much as the positive: `NOT EXERCISED` must not appear, because
   * a skip that announces itself still leaves the comparison unmeasured.
   */
  it('ARM E: exercises that control from a checkout whose HEAD is a merge commit', () => {
    const { dir, cited, genuineTwin } = fixture();
    ledger(dir, cited, genuineTwin);

    const mainline = run(dir, ['rev-parse', 'HEAD']);
    run(dir, ['checkout', '-q', '-b', 'side', 'HEAD~1']);
    writeFileSync(path.join(dir, 'side.md'), 'work done in parallel\n');
    commit(dir, 'side work');
    run(dir, ['checkout', '-q', '-']);
    execFileSync(
      'git',
      ['-C', dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'],
      { stdio: 'ignore' },
    );

    // The premise: without it the arm proves nothing, because a non-merge HEAD passes trivially.
    const parents = run(dir, [
      'rev-list',
      '--parents',
      '-n',
      '1',
      'HEAD',
    ]).split(' ').length;
    expect(parents).toBe(3);
    expect(run(dir, ['rev-parse', 'HEAD'])).not.toBe(mainline);

    const { status, out } = runHarness(dir);
    expect(out).toContain(
      'control: the twin comparison separates two distinct revisions true',
    );
    expect(out).not.toContain('NOT EXERCISED');
    expect(status).toBe(0);
  });
});

/**
 * A reviewer raised a hazard about three-valued answers read through two-valued
 * tests: `git merge-base --is-ancestor` exits 0 for yes, 1 for no, and 128 when
 * the object or the ref is absent, so any caller testing truthiness collapses
 * "cannot tell" into "no". Measured here, all four shapes reproduce - including
 * one the report did not name, an absent *second* argument, which also gives 128.
 *
 * The harness has the structural precondition for that bug: its `git()` helper
 * catches every failure and returns null, so 1 and 128 are one value to it. What
 * it does not have is the bug, and the reason is worth pinning rather than
 * trusting. When the instrument goes blind the positive control goes with it -
 * a known-present SHA stops classifying REACHABLE - and the run withholds the
 * verdict instead of publishing one. That covers failure modes nobody
 * enumerated, which branching on exit codes by value cannot do, because it only
 * covers the codes someone thought of.
 *
 * The pair below is the discrimination, in both directions, over identical
 * artifacts and the identical script. A repository whose HEAD is unborn is the
 * blind case: note that the shallow-clone guard does *not* fire there, so this
 * is a genuinely different way to be unable to see. A repository with a single
 * commit is the sighted case; it reaches a verdict, and that verdict is a
 * failing one, which is the point - the check is allowed to say no, and is not
 * allowed to say no when it means it could not look.
 */
describe('the harness refuses to publish a verdict it cannot support', () => {
  const made: string[] = [];

  const stage = (dir: string) => {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    mkdirSync(path.join(dir, '.squad', 'fact-checker'), { recursive: true });
    copyFileSync(
      path.join(repositoryRoot, HARNESS),
      path.join(dir, 'scripts', 'check-citation-reachability.mjs'),
    );
    for (const f of ['audit-trail.md', 'policy.md']) {
      copyFileSync(
        path.join(repositoryRoot, '.squad', 'fact-checker', f),
        path.join(dir, '.squad', 'fact-checker', f),
      );
    }
  };

  const newRepo = (prefix: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    made.push(dir);
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    stage(dir);
    return dir;
  };

  const runHarness = (dir: string) => {
    const r = spawnSync('node', ['scripts/check-citation-reachability.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  const publishedAVerdict = (out: string) =>
    /OK - every cited|ORPHANED CITATIONS/.test(out);

  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('withholds the verdict where no reader revision resolves at all', () => {
    const { status, out } = runHarness(newRepo('blind-'));

    // 2, not 1: "I could not look" must not be reported through the same channel
    // as "these citations are broken", or the repair instruction sends someone
    // to fix citations that are fine.
    expect(status).toBe(2);
    expect(out).toContain('CONTROL FAILED');
    expect(out).toContain('verdict withheld');
    expect(publishedAVerdict(out)).toBe(false);

    // The shallow guard is a different instrument and is silent here, so this
    // case is not covered by it - the control arm is what catches this one.
    expect(out).not.toContain('INCONCLUSIVE: this is a shallow clone');
  });

  it('reaches a verdict, and states its reader model, once it can see', () => {
    const dir = newRepo('sighted-');
    execFileSync('git', [
      '-C',
      dir,
      'config',
      'user.email',
      't@example.invalid',
    ]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'T']);
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed'], {
      stdio: 'ignore',
    });

    const { status, out } = runHarness(dir);

    expect(status).not.toBe(2);
    expect(out).not.toContain('verdict withheld');
    expect(publishedAVerdict(out)).toBe(true);

    // A count decides nothing until its scope is stated, so the verdict carries
    // the revisions it was computed against rather than leaving them implied.
    expect(out).toMatch(/reader revisions: .+\(\d+ commits reachable\)/);
  });
});
