import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
