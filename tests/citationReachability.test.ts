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
const liveWorkflows = readdirSync(workflowsDir)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({
    file: f,
    text: readFileSync(path.join(workflowsDir, f), 'utf8'),
  }));

const HARNESS = 'scripts/check-citation-reachability.mjs';
const SCRIPT_NAME = 'check:citation-reachability';
const STAGED = ['.squad', 'fact-checker', 'citation-reachability.workflow.yml'];

const invokers = liveWorkflows.filter((w) =>
  w.text.includes(`npm run ${SCRIPT_NAME}`),
);
const enforcingWorkflow = invokers[0];
const isEnforced = enforcingWorkflow !== undefined;

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
 * The workflow cannot be pushed from this branch - the authoring token lacks the
 * `workflow` OAuth scope, and the Contents API refuses the same path - so it is
 * staged in `.squad/` for a maintainer to move. That makes the honesty of the
 * prose the thing under test, and the final case here is the load-bearing one:
 * it is satisfied while nothing claims enforcement, and again once enforcement
 * exists, and never in between. Moving the file into `.github/workflows/` is
 * what licenses the word "enforced", and removing it revokes that licence
 * automatically rather than leaving the claim to drift.
 */
describe('the citation-reachability harness is invoked, not merely present', () => {
  it('is exposed as an npm script pointing at the harness', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts[SCRIPT_NAME]).toBe(`node ${HARNESS}`);
  });

  it('keeps the workflow that runs it reachable, whether staged or live', () => {
    expect(isEnforced || existsSync(path.join(repositoryRoot, ...STAGED))).toBe(
      true,
    );
  });

  it('subscribes to pull_request, the only event carrying the branch to check', () => {
    const workflow = enforcingWorkflow
      ? enforcingWorkflow.text
      : read(...STAGED);

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
    const workflow = enforcingWorkflow
      ? enforcingWorkflow.text
      : read(...STAGED);

    // Reachability, the patch-id twin index and the declared-route probes all
    // read history. A shallow checkout would report orphans a reader can in
    // fact reach, and a check that fails for the wrong reason gets ignored.
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('github.event.pull_request.head.sha');
    expect(workflow).toContain('refs/remotes/origin/development');
  });

  it('declares a merge-queue class, and does not claim to report for a queued entry', () => {
    const workflow = enforcingWorkflow
      ? enforcingWorkflow.text
      : read(...STAGED);

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
