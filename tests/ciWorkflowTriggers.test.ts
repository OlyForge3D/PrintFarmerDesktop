// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowsDir = path.resolve(
  import.meta.dirname,
  '..',
  '.github',
  'workflows',
);

function readWorkflow(file: string): string {
  return readFileSync(path.join(workflowsDir, file), 'utf8');
}

const ciWorkflow = readWorkflow('ci.yml');
const releaseWorkflow = readWorkflow('release.yml');
const gpuQualificationWorkflow = readWorkflow('release-gpu-qualification.yml');

const skillDoc = readFileSync(
  path.resolve(
    import.meta.dirname,
    '..',
    '.squad',
    'skills',
    'testing',
    'SKILL.md',
  ),
  'utf8',
);

/**
 * Lines of a column-0 mapping (`on:`, `jobs:`) up to the next column-0 key.
 * Deliberately textual: the repository ships no YAML parser and this PR does
 * not add one, matching `releaseWorkflow.test.ts`.
 */
function topLevelSection(workflow: string, key: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const start = lines.indexOf(`${key}:`);
  if (start < 0) throw new Error(`workflow has no top-level "${key}:" block`);
  const body = lines.slice(start + 1);
  const end = body.findIndex((line) => /^\S/.test(line));
  return end < 0 ? body : body.slice(0, end);
}

/**
 * Event names a workflow subscribes to, sorted.
 *
 * Sorted rather than in file order because declaration order carries no
 * meaning to GitHub: `on: {pull_request, push, merge_group}` is the same
 * subscription however it is written. Comparing sorted arrays keeps the
 * failure diff naming the offending event — dropping `merge_group:` still
 * reports `- "merge_group"` — without failing a harmless reordering.
 */
function triggersOf(workflow: string): string[] {
  return topLevelSection(workflow, 'on')
    .flatMap((line) => {
      const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    })
    .sort();
}

interface WorkflowJob {
  key: string;
  name: string;
  operatingSystems: string[];
  body: string[];
}

function jobsOf(workflow: string): WorkflowJob[] {
  const section = topLevelSection(workflow, 'jobs');
  const starts: Array<{ key: string; index: number }> = [];
  section.forEach((line, index) => {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match?.[1] !== undefined) starts.push({ key: match[1], index });
  });

  return starts.map(({ key, index }, position) => {
    const next = starts[position + 1]?.index ?? section.length;
    const body = section.slice(index + 1, next);
    const name = body
      .flatMap((line) => {
        const match = /^ {4}name:\s*(.+)$/.exec(line);
        return match?.[1] === undefined ? [] : [match[1].trim()];
      })
      .at(0);
    if (name === undefined) throw new Error(`job "${key}" has no name`);
    const matrix = body
      .flatMap((line) => {
        const match = /^ {8}os:\s*\[(.+)\]\s*$/.exec(line);
        return match?.[1] === undefined ? [] : [match[1]];
      })
      .at(0);
    const operatingSystems =
      matrix === undefined
        ? []
        : matrix.split(',').map((value) => value.trim());
    return { key, name, operatingSystems, body };
  });
}

/**
 * The check-run names GitHub renders from this workflow — the *emitted* side.
 * A branch ruleset matches its required contexts against strings of this shape,
 * so a rename here is a breaking change for any ruleset that pins the old name.
 * This function does not read branch protection and cannot tell you which of
 * these are actually required.
 */
function renderedContexts(workflow: string): string[] {
  return jobsOf(workflow)
    .flatMap(({ name, operatingSystems }) =>
      operatingSystems.length === 0
        ? [name]
        : operatingSystems.map((os) => name.replaceAll('${{ matrix.os }}', os)),
    )
    .sort();
}

/**
 * Every `concurrency:` key in a workflow, at any nesting depth, with the two
 * lines that decide whether it is dangerous.
 *
 * Textual for the same reason as everything else here: the repository ships no
 * YAML parser and this change does not add one.
 */
function concurrencyDeclarations(workflow: string): Array<{
  line: string;
  group: string | undefined;
  cancel: string | undefined;
  cancels: boolean;
}> {
  const lines = workflow.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    if (!/^\s*concurrency:/.test(line)) return [];
    // The block runs to the first line indented no deeper than the key itself.
    //
    // This replaced a fixed `slice(index + 1, index + 6)` window, which read a
    // block's safety off its comment density: six comment lines pushed `group:`
    // and `cancel-in-progress:` out of the window, and a block carrying
    // `group: ci-${{ github.workflow }}` (constant across merge-group entries)
    // with a literal `cancel-in-progress: true` -- the exact configuration the
    // test below exists to reject -- extracted as `group: undefined,
    // cancels: false`, which is the signature of a safe one. Taken, not
    // assumed: the same block with the comments deleted extracted as
    // `cancels: true`. That was harmless only while the assertion was
    // `toEqual([])` and every shape failed alike; it becomes load-bearing the
    // moment a specific safe shape is allowed through, which is what this
    // change does.
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const entry = lines[cursor] ?? '';
      if (entry.trim() === '') continue;
      const entryIndent = /^(\s*)/.exec(entry)?.[1]?.length ?? 0;
      if (entryIndent <= indent) break;
      if (/^\s*#/.test(entry)) continue;
      block.push(entry);
    }
    const group = block
      .flatMap((entry) => {
        const match = /^\s*group:\s*(.+)$/.exec(entry);
        return match?.[1] === undefined ? [] : [match[1].trim()];
      })
      .at(0);
    // Captured raw as well as reduced to a boolean: `cancels` answers "is this
    // unconditionally cancelling", which an expression form always answers
    // `false`, so on its own it cannot distinguish the event-scoped expression
    // below from `${{ true }}`. The assertion reads `cancel`.
    const cancel = block
      .flatMap((entry) => {
        const match = /^\s*cancel-in-progress:\s*(.+)$/.exec(entry);
        return match?.[1] === undefined ? [] : [match[1].trim()];
      })
      .at(0);
    return [{ line: line.trim(), group, cancel, cancels: cancel === 'true' }];
  });
}

describe('CI is safe to run under a merge queue', () => {
  it('keys `concurrency:` per merge-group entry and cancels only pull requests', () => {
    // This test used to assert `toEqual([])` -- no `concurrency:` at all. That
    // ban was a tripwire rather than a policy, and said so: "a legitimate
    // `concurrency:` is not forbidden; it just has to arrive with this question
    // answered, and failing here is how it gets asked." #405 and #540 are the
    // two halves of the reason to answer it, and this is the answer.
    //
    // The danger the ban existed for is unchanged and is what the shape below
    // rules out:
    //
    //   A `concurrency:` group whose key is not unique per merge group, with
    //   `cancel-in-progress: true`, cancels the in-flight run for an earlier
    //   queued entry when a later one is dispatched. A cancelled check run has
    //   conclusion `cancelled`, which is not a success conclusion, so the entry
    //   is removed from the queue -- for a reason that has nothing to do with
    //   its own changes.
    //
    // Two independent properties make that unreachable here, and the assertion
    // pins both because either alone would be enough to make the other look
    // unnecessary:
    //
    //   group  `github.ref` is `refs/pull/N/merge` under pull_request and
    //          `refs/heads/gh-readonly-queue/<base>/pr-N-<sha>` under
    //          merge_group. It is distinct per queued entry, so no two entries
    //          ever share a group and the cancellation cannot be expressed.
    //   cancel scoped to `pull_request` by event name, so a merge_group or
    //          push run is not a candidate for cancellation regardless.
    //
    // Asserted as an exact string rather than via the `cancels` boolean: every
    // expression form reduces to `cancels: false`, so the boolean cannot tell
    // this apart from `${{ true }}`, which would be unsafe. See the extractor.
    //
    // Still not verified: no merge queue has run on this repository, so the
    // cancellation behaviour above remains documentation, not observation.
    // What changed is that the configuration no longer depends on it.
    expect(concurrencyDeclarations(ciWorkflow)).toEqual([
      {
        line: 'concurrency:',
        group: 'ci-${{ github.ref }}',
        cancel: "${{ github.event_name == 'pull_request' }}",
        cancels: false,
      },
    ]);
  });

  it('cancels no run that a merge queue or a trunk push dispatched', () => {
    // Stated honestly: for DETECTION this test is subsumed. The assertion above
    // is an exact `toEqual`, so every mutation that fails this one fails that
    // one too -- taken, not assumed: four mutations of the block (group made
    // constant, cancel made unconditional, cancel rescoped to merge_group, and
    // the block deleted) each reddened both, and none reddened this alone.
    //
    // It is kept for the case the exact assertion cannot cover: that assertion
    // has to be edited for any legitimate change to the block -- a group rename,
    // a comment reflow that moves nothing semantic -- and the editor's easiest
    // correct-looking move is to paste in whatever the extractor now reports.
    // That is a shape assertion re-derived from the artifact it checks. These
    // four properties are the ones that must survive such an edit, so they are
    // written as properties and not as a string.
    const [declaration] = concurrencyDeclarations(ciWorkflow);
    expect(declaration).toBeDefined();
    // Unconditional cancellation is the banned form outright.
    expect(declaration?.cancels).toBe(false);
    // And the condition names the one event for which cancellation is correct.
    expect(declaration?.cancel).toContain('pull_request');
    expect(declaration?.cancel).not.toContain('merge_group');
    // A group that does not vary with the ref is shared across queue entries.
    expect(declaration?.group).toContain('github.ref');
  });

  it('finds a `concurrency:` block when one is present, so the guard above is not vacuous', () => {
    // Positive control on the extractor. Without it, the assertion above would
    // pass just as well against a matcher that can never match anything, and
    // the guard would be green for the wrong reason for as long as it lived.
    //
    // release-gpu-qualification.yml carries the repository's other
    // `concurrency:` block, and it is in the shape that would be safe under a
    // queue: keyed on github.sha, so unique per merge group, and not cancelling.
    expect(concurrencyDeclarations(gpuQualificationWorkflow)).toEqual([
      {
        line: 'concurrency:',
        group: 'release-gpu-qualification-${{ github.sha }}',
        cancel: 'false',
        cancels: false,
      },
    ]);
  });

  it('gives the two merge_group refs this repository actually produced distinct groups', () => {
    // Not a constructed fixture. These are the `head_branch` values of the only
    // two `merge_group` runs in this repository's history, both of workflow CI,
    // both conclusion `cancelled`, 54 seconds apart:
    //
    //   30889162530  pr-227-db03fbf1...  2026-08-04T07:46:33Z  cancelled
    //   30889221719  pr-221-db03fbf1...  2026-08-04T07:47:27Z  cancelled
    //
    // They share a base SHA and differ only in the PR number, which is the
    // collision case the ban was written about: two entries queued against the
    // same base, close enough in time to overlap.
    //
    // What cancelled those two runs is NOT established -- ci.yml declared no
    // `concurrency:` then and declares one now that cannot cancel them, so it
    // was some other route (a dequeue, or the queue being disabled with entries
    // in flight; `required_merge_queue` is absent from branch protection
    // today). The runs are cited for the ref SHAPE, which is all this test
    // reads, and because they establish that `merge_group` dispatch here is
    // observed rather than hypothetical.
    const observedQueueRefs = [
      'refs/heads/gh-readonly-queue/development/pr-227-db03fbf1f5555dd0419c58ceb39615b7e89d946d',
      'refs/heads/gh-readonly-queue/development/pr-221-db03fbf1f5555dd0419c58ceb39615b7e89d946d',
    ];
    const [declaration] = concurrencyDeclarations(ciWorkflow);
    const group = declaration?.group ?? '';
    // Substitute each real ref into the real group expression.
    const resolved = observedQueueRefs.map((ref) =>
      group.replace('${{ github.ref }}', ref),
    );
    expect(new Set(resolved).size).toBe(observedQueueRefs.length);
    // Counterfactual on the same two refs: the key the ban names -- constant
    // across entries -- collapses them onto one group, which is the eviction.
    const banned = observedQueueRefs.map(() => 'ci-CI');
    expect(new Set(banned).size).toBe(1);
  });

  it('reads a block whose keys sit behind comments, not just a tight one', () => {
    // Both real blocks in this repository would extract correctly under a fixed
    // five-line window: the gpu one is tight, and ci.yml's would fail the
    // assertion above on any reading. So neither is a control on the window,
    // and the defect it hides is specifically a *dangerous* block presenting as
    // a safe one.
    //
    // Constructed rather than reasoned about: this is the banned configuration
    // exactly -- a group constant across merge-group entries, cancelling
    // unconditionally -- with its keys pushed past the old window by comments.
    const padded = [
      'concurrency:',
      '  # one',
      '  # two',
      '  # three',
      '  # four',
      '  # five',
      '  # six',
      '  group: ci-${{ github.workflow }}',
      '  cancel-in-progress: true',
      '',
      'jobs:',
      '  build:',
      '    concurrency: not-a-block',
    ].join('\n');
    const [declaration] = concurrencyDeclarations(padded);
    // The old window returned `group: undefined, cancels: false` here, which is
    // indistinguishable from a safe declaration.
    expect(declaration?.group).toBe('ci-${{ github.workflow }}');
    expect(declaration?.cancels).toBe(true);
  });

  it('ends a block at the first line that dedents, rather than running on', () => {
    // The other direction of the same boundary: widening the window must not
    // let a block absorb keys that belong to a later top-level section, which
    // would let an unrelated `cancel-in-progress: true` elsewhere in the file
    // be attributed to a safe block.
    const bounded = [
      'concurrency:',
      '  group: safe-${{ github.sha }}',
      '  cancel-in-progress: false',
      '',
      '# a top-level comment does not continue the block',
      'jobs:',
      '  build:',
      '    cancel-in-progress: true',
    ].join('\n');
    const [declaration] = concurrencyDeclarations(bounded);
    expect(declaration?.group).toBe('safe-${{ github.sha }}');
    expect(declaration?.cancel).toBe('false');
    expect(declaration?.cancels).toBe(false);
  });

  it('subscribes to merge_group alongside the existing push and pull_request triggers', () => {
    // Without this the required contexts of a queued entry are never reported,
    // so the queue waits permanently instead of failing.
    expect(triggersOf(ciWorkflow)).toEqual(
      ['push', 'pull_request', 'merge_group'].sort(),
    );
  });

  it('still restricts push runs to the two long-lived branches', () => {
    expect(topLevelSection(ciWorkflow, 'on')).toContain(
      '    branches: [development, main]',
    );
  });

  it('declares no job-level `if:` and no event-name branching, so no job can be skipped under a merge queue', () => {
    // Deliberately broader than the deadlock it guards, and the harm here is
    // the opposite of the one the trigger test guards. Two distinct mechanisms:
    //
    //   Workflow never runs (no `merge_group:` trigger, or a path/branch
    //   filter excludes the event) — its checks stay Pending forever and the
    //   entry blocks. That is #122, and the trigger test above guards it.
    //
    //   Job skipped by a job-level `if:` in a workflow that *does* run — the
    //   check run is reported with a `skipped` conclusion, and `skipped`
    //   counts as success. The required context is *satisfied by a job that
    //   never executed*: a green merge with the check silently not run.
    //
    // So this test does not guard a hang. It guards a false green, which is
    // the worse of the two because nothing waits to be investigated.
    //
    // Verified, not inferred. GitHub, "Troubleshooting required status
    // checks" — "Successful check statuses are `success`, `skipped`, and
    // `neutral`", and under "Handling skipped but required checks": a job
    // skipped by a conditional "reports Success", while a workflow skipped by
    // path/branch filtering "stays in a Pending state and blocks merging".
    // Observed in this repository: release.yml run 30838613800 skipped the
    // conditional `publish` job, and the check-runs API for that commit lists
    // it as `conclusion=skipped` — a reported check run, not an absent one.
    //
    // Not verified: the behaviour of a `skipped` required context inside a
    // real merge queue specifically. It is documented for branch protection;
    // no merge queue has run on this repository yet to confirm it there.
    //
    // Enumerating which conditions are safe under `merge_group` is harder to
    // get right than banning the category, so the category is banned. A
    // legitimate job-level `if:` is not forbidden by policy — it just has to
    // arrive with the required-contexts question answered, and failing here is
    // how that question gets asked.
    //
    // A job-level `if:` sits at four spaces; the two `runner.os` guards in
    // `sidecar` are step-level (eight spaces) and are unaffected by the event.
    const jobLevelConditions = jobsOf(ciWorkflow).flatMap(({ key, body }) =>
      body
        .filter((line) => /^ {4}if:/.test(line))
        .map((line) => `${key}:${line}`),
    );
    expect(jobLevelConditions).toEqual([]);
    // Belt and braces on the specific deadlock: branching on the event name at
    // job level reintroduces it even without a job-level `if:`.
    //
    // Narrowed from a whole-file substring ban on 2026-08-04 (#231). The ban
    // was over-broad relative to the mechanism it names. The deadlock is
    // JOB SKIPPING: a skipped job reports its required context as `skipped`,
    // which branch protection does not accept, and the queue entry hangs. A
    // STEP-level `if:` cannot skip a job -- the job still runs, still reports,
    // and still passes or fails -- so it cannot produce that state.
    //
    // The residual hazard of a step-level guard is the opposite one: a step
    // that is skipped under `merge_group` is not enforcing anything there, so
    // the job can go green without it. That is a false green, not a deadlock,
    // and it is acceptable only for a check whose subject does not exist under
    // `merge_group` at all. `github.event.pull_request` is that case: there is
    // no pull request in a queue entry, so there is nothing to check.
    //
    // Enumerating the permitted guards by name would be a count-based
    // assertion of the kind that has already produced one false red on a
    // correct change in this repository. The property is asserted instead.
    // Narrowed a second time on the same principle, for `concurrency:` (#405,
    // #540). A top-level `cancel-in-progress:` cannot skip a job either: it
    // decides whether an already-dispatched run is CANCELLED, which is a
    // different conclusion from `skipped` and arrives by a different mechanism.
    // The hazard it does carry -- cancelling a queued entry's in-flight run --
    // is real, and is not left to this test: it is asserted directly, by shape
    // and by property, in 'keys `concurrency:` per merge-group entry and
    // cancels only pull requests' above. Widening the exemption to the whole
    // block, or to any line mentioning the key, would swallow a job-level
    // guard, so it is pinned to the top-level key at two spaces.
    const eventNameLines = ciWorkflow
      .split('\n')
      .filter((line: string) => line.includes('github.event_name'));
    const notOnAStepCondition = eventNameLines.filter(
      (line: string) =>
        !/^ {8}if:/.test(line) && !/^ {2}cancel-in-progress:/.test(line),
    );
    expect(notOnAStepCondition).toEqual([]);
  });

  it('still rejects event-name branching at job level, so the exemption above is narrow', () => {
    // Control on the two exemptions. Without it, the filter above would pass
    // just as well if it exempted every line, and the ban would be green for
    // the wrong reason -- the failure mode that made the #231 narrowing worth
    // asserting rather than trusting.
    const withJobLevelBranch = [
      'jobs:',
      '  desktop:',
      "    if: ${{ github.event_name != 'merge_group' }}",
      '    steps:',
      '      - name: permitted step-level guard',
      "        if: github.event_name == 'pull_request'",
      '        run: echo step-level, permitted',
      'concurrency:',
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    ];
    const offenders = withJobLevelBranch.filter(
      (line) =>
        line.includes('github.event_name') &&
        !/^ {8}if:/.test(line) &&
        !/^ {2}cancel-in-progress:/.test(line),
    );
    // Exactly the job-level one, and neither exempted form.
    expect(offenders).toEqual([
      "    if: ${{ github.event_name != 'merge_group' }}",
    ]);
  });

  it('contains no PR-context step that would fail on a merge-queue entry', () => {
    const steps: string[][] = [];
    ciWorkflow.split('\n').forEach((line) => {
      if (/^ {6}- /.test(line)) steps.push([line]);
      else if (steps.length > 0 && /^ {8}\S/.test(line))
        steps[steps.length - 1]?.push(line);
    });

    expect(steps.length).toBeGreaterThan(10);
    expect(
      steps.filter((step) =>
        step.some((line) => line.includes('github.event.pull_request')),
      ).length,
    ).toBe(0);
  });

  it('emits exactly the seven check-run names ci.yml produces, byte-identical', () => {
    // The emitted side only. Whether these are the *required* contexts lives in
    // branch protection, which this test does not read:
    //   gh api repos/{owner}/{repo}/branches/development/protection \
    //     --jq '.required_status_checks.contexts[]'
    //
    // The two sets can diverge in both directions, and one direction is the
    // deadlock #122 is about: a required context that no workflow emits is
    // never reported and waits forever. This test cannot see that — it only
    // pins what ci.yml produces, so a rename here is caught before it can
    // silently orphan a required context.
    expect(renderedContexts(ciWorkflow)).toEqual([
      'Dependency advisories',
      'Desktop (macos-latest)',
      'Desktop (windows-latest)',
      'Release package (macos-latest)',
      'Release package (windows-latest)',
      'Sidecar (macos-latest)',
      'Sidecar (windows-latest)',
    ]);
  });
});

/**
 * The CI context list as `.squad/skills/testing/SKILL.md` states it.
 *
 * Anchored on the `## CI gate` heading and the first contiguous bullet run
 * beneath it — never on line offsets. A positional extractor drifts silently
 * the moment anything above the list changes length, and its failure mode is
 * the worst one available: it reports contexts as omitted or fictional while
 * the list is correct and only the reader moved. That is #152's own symptom
 * ("named a job `ci.yml` no longer emits, omitted `Dependency advisories`")
 * raised against a file that is right, which sends the next maintainer to edit
 * the correct artifact.
 *
 * Throws rather than returning `[]` when the anchor is gone, so a renamed
 * heading fails by name instead of by an empty set that reads as agreement.
 *
 * The same applies one level down, and #266 is the case: the terminator used to
 * be guarded on `bullets.length > 0`, so an EMPTY list under a present heading
 * never ended the run and the loop scanned to EOF, harvesting bullets from
 * unrelated sections. `.squad/skills/testing/SKILL.md` has carried a second
 * bullet list since #149, so the extractor returned SBOM fixture guidance as CI
 * contexts — and, worse, that harvest DISARMED the non-vacuity guard below,
 * which passed on three bullets it should never have seen. The failure was red,
 * but named the wrong section and sent the reader to a file that is correct.
 *
 * The gate could not simply be dropped: prose sits between this heading and its
 * list, so an ungated terminator ends the run before it starts. The bound is
 * the SECTION — heading to the next `## ` — and the first contiguous run within
 * it. An empty section then throws by name, because the distinction that
 * matters is "the run ended" versus "the run never started", and only the first
 * has an empty-set-shaped answer.
 */
function documentedCiContexts(doc: string): string[] {
  const lines = doc.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##\s+CI gate\s*$/.test(line));
  if (heading < 0) {
    throw new Error(
      'SKILL.md has no "## CI gate" heading, which this extractor is anchored on',
    );
  }
  const bullets: string[] = [];
  // Bound the search to the CI gate SECTION -- heading to the next `## ` -- and
  // only then take the first contiguous bullet run inside it. #266 was that the
  // run had no outer bound: the terminator was gated on `bullets.length > 0`,
  // which is necessary because prose sits between this heading and its list
  // ("Eight required checks must pass:"), but with an EMPTY list nothing ever
  // sets that gate, so the scan left the section and ran to EOF. Removing the
  // gate breaks the prose case; bounding the section fixes both.
  const nextHeading = lines.findIndex(
    (line, index) => index > heading && /^##\s/.test(line),
  );
  const section = lines.slice(
    heading + 1,
    nextHeading < 0 ? lines.length : nextHeading,
  );
  for (const line of section) {
    const match = /^-\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      bullets.push(match[1]);
      continue;
    }
    // A heading of ANY level ends the search, whether or not a bullet has been
    // seen. The section bound above is `/^##\s/`, which deliberately does not
    // match `### ` because a subsection belongs to its section -- but a
    // subsection's bullets are not the gate's list. With the gate list empty,
    // nothing sets the `bullets.length > 0` gate below, so the prose-tolerant
    // scan walks past the prose and harvests the first subsection instead:
    // #266's exact failure -- a non-empty answer that disarms the non-vacuity
    // guard -- surviving inside the bound that #266 added to stop it.
    if (/^#{1,6}\s/.test(line)) break;
    // Blank lines inside the run are tolerated; the first prose line after a
    // bullet has been seen ends it.
    if (bullets.length > 0 && line.trim() !== '') break;
  }
  if (bullets.length === 0) {
    throw new Error(
      'the "## CI gate" section of SKILL.md contains no bullet list. ' +
        'Reported by name because the alternative -- an empty array -- is ' +
        'indistinguishable from a list that was read and found to disagree',
    );
  }
  return bullets.sort();
}

describe('the testing skill transcribes the contexts ci.yml emits', () => {
  // #152: this list named a packaging job that `ci.yml` had renamed days
  // earlier, and omitted `Dependency advisories`. The transcription was correct
  // when written — a rename in an unrelated commit orphaned it, and nothing
  // read the file, so the correction could regress without any test going red.
  // Three references to SKILL.md exist in `tests/`, all of them prose inside
  // docblocks, none of them a read. A rename is the mechanism this guards.
  //
  // This pins the doc against what ci.yml *emits*, which is in turn pinned
  // byte-identically above. Whether those are the *required* contexts lives in
  // branch protection and is not read here, for the same reason as the test
  // above — the doc says so itself and tells the reader to re-verify.
  it('extracts a non-empty list, so the comparison below cannot pass vacuously', () => {
    expect(documentedCiContexts(skillDoc).length).toBeGreaterThan(0);
  });

  it('names exactly those contexts, with no fictional and no omitted entry', () => {
    expect(documentedCiContexts(skillDoc)).toEqual(
      [...renderedContexts(ciWorkflow), 'Closing-reference declaration'].sort(),
    );
  });

  // Both assertions above read one real document, and that is why #266 survived
  // them for as long as it did: the defect only becomes visible when the file
  // carries a SECOND bullet list, and whether SKILL.md does is not a property
  // this suite controls -- #149 added one, silently arming the bug, and #234's
  // subject is that a mutation table is evidence about the code only at the
  // fixture it ran on. These build the document instead.
  const withTrailingList = (ciGateBody: string): string =>
    [
      '# Testing',
      '',
      '## CI gate',
      ciGateBody,
      '## Fixtures',
      '',
      '- Pad with incompressible bytes (a seeded PRNG)',
      '- Size the fixture to the named constant',
      '- Assert the violating part name alongside the diagnostic code',
    ].join('\n');

  it('ends the run at the first prose line and never reaches a later list', () => {
    expect(
      documentedCiContexts(
        withTrailingList(
          [
            '',
            'Seven required checks must pass:',
            '',
            '- Desktop (windows-latest)',
            '- Dependency advisories',
            '',
            'Re-verify these against branch protection before relying on them.',
            '',
          ].join('\n'),
        ),
      ),
    ).toEqual(['Dependency advisories', 'Desktop (windows-latest)']);
  });

  // The discriminating case. Before #266 this returned the three `## Fixtures`
  // bullets: a non-empty answer, so the non-vacuity assertion above PASSED, and
  // the equality assertion failed naming SBOM guidance as a CI context. Red for
  // a false cause is worse than green, because it is acted on.
  it('throws when the section holds no list, instead of filling from further down', () => {
    expect(() =>
      documentedCiContexts(
        withTrailingList(
          ['', 'Seven required checks must pass:', ''].join('\n'),
        ),
      ),
    ).toThrow(/contains no bullet list/);
  });

  // Regression pin for the first attempt at this fix, which dropped the
  // `bullets.length > 0` gate outright. That terminates an empty run correctly
  // and breaks the real document, where prose separates the heading from its
  // list -- both real-file assertions above went red at once. The repair has to
  // keep the gate and bound the section instead.
  it('reaches a list that prose separates from the heading', () => {
    expect(
      documentedCiContexts(
        withTrailingList(
          [
            '',
            'Seven required checks must pass:',
            '',
            '- Dependency advisories',
            '',
          ].join('\n'),
        ),
      ),
    ).toEqual(['Dependency advisories']);
  });

  it('still reports a missing heading by name, not as an empty run', () => {
    expect(() =>
      documentedCiContexts('# Testing\n\n- Desktop (macos-latest)'),
    ).toThrow(/no "## CI gate" heading/);
  });

  // #266 bounded the scan at the next `## `, and every fixture above proves that
  // bound holds. None of them can say anything about what happens INSIDE it,
  // because all four are built by `withTrailingList`, which always appends a
  // `## Fixtures` heading and never puts a subheading in the section. The
  // section bound is the only thing they vary, so it is the only thing they
  // test -- a discriminator measured where it does not vary has been assumed.
  //
  // `/^##\s/` does not match `### `, by construction: a subsection belongs to
  // its section. So a `### ` inside the CI gate section does not end it, and
  // with the gate's own list empty the run search walks straight past the prose
  // into the subsection's bullets. That is #266 exactly -- a non-empty answer
  // that disarms the non-vacuity guard and reports the wrong section's content
  // as CI contexts -- surviving inside the bound that was added to stop it.
  //
  // SKILL.md carries two `### ` subheadings inside this section today (neither
  // has bullets, which is the only reason this is latent rather than live), so
  // the arming edit is now "add a bullet under an existing subheading" -- a
  // smaller and more ordinary change than the second `## ` list that armed #266.
  const withSubheading = (ciGateBody: string): string =>
    [
      '# Testing',
      '',
      '## CI gate',
      ciGateBody,
      '### Reading a failing job log after a re-run',
      '',
      '- Open the run that the check links to, not the newest run',
      '- Read the first failing step, not the last',
      '',
      '## Fixtures',
      '',
      '- Pad with incompressible bytes (a seeded PRNG)',
    ].join('\n');

  it('throws rather than harvesting a subsection when the gate list is empty', () => {
    expect(() =>
      documentedCiContexts(
        withSubheading(['', 'Seven required checks must pass:', ''].join('\n')),
      ),
    ).toThrow(/contains no bullet list/);
  });

  // The control the assertion above cannot supply for itself. It would also
  // hold for an extractor that threw on every document, and for a fixture whose
  // subsection bullets were unreachable for some unrelated reason. This asserts
  // the wrong answer really is available in this exact fixture: move one bullet
  // up under the heading and the subsection bullets must NOT join it.
  it('takes only the gate list when a subsection with bullets follows it', () => {
    expect(
      documentedCiContexts(
        withSubheading(
          [
            '',
            'Seven required checks must pass:',
            '',
            '- Dependency advisories',
            '',
          ].join('\n'),
        ),
      ),
    ).toEqual(['Dependency advisories']);
  });

  // Coverage pin, deliberately NOT labelled a defect. `nextHeading < 0` falls
  // back to `lines.length`, and no fixture above reaches it because every one
  // appends a trailing `## `. Scanning to EOF is the CORRECT reading when the
  // gate genuinely is the last section, so there is nothing to fix here -- but
  // an unexercised branch that is correct today is one edit from not being, and
  // nothing would have gone red. This pins the semantic, not a bug.
  it('reads its own list when the gate is the last section in the file', () => {
    expect(
      documentedCiContexts(
        [
          '# Testing',
          '',
          '## CI gate',
          '',
          'Seven required checks must pass:',
          '',
          '- Desktop (macos-latest)',
          '- Dependency advisories',
          '',
          'Re-verify these against branch protection before relying on them.',
          '',
        ].join('\n'),
      ),
    ).toEqual(['Dependency advisories', 'Desktop (macos-latest)']);
  });
});

describe('publication workflows stay outside the merge queue', () => {
  // Negative control on the extractor itself: an empty trigger list would make
  // "does not subscribe to merge_group" pass for a workflow it cannot parse.
  it.each([
    {
      file: 'release.yml',
      contents: releaseWorkflow,
      triggers: ['push', 'workflow_dispatch'],
    },
    {
      file: 'release-gpu-qualification.yml',
      contents: gpuQualificationWorkflow,
      triggers: ['workflow_dispatch'],
    },
  ])(
    '$file publishes from a tag or a human, never per queued entry',
    ({ contents, triggers }) => {
      expect(triggersOf(contents)).toEqual([...triggers].sort());
      expect(triggersOf(contents)).not.toContain('merge_group');
    },
  );
});

describe('ci.yml remains commit-driven', () => {
  /**
   * Event types listed under a subscribed event, sorted.
   *
   * The forward scan stops at the next sibling key. An earlier version sliced
   * to the end of the `on:` section, so an event with no `types:` of its own
   * silently reported the NEXT event's list: adding a `pull_request_target:`
   * carrying the standard types, then dropping `types:` from `pull_request:`,
   * left both tests below green with the fix entirely absent. Anchoring on
   * `  ${event}:` rather than `.trim()` likewise stops a nested key matching.
   */
  function typesOf(workflow: string, event: string): string[] {
    const section = topLevelSection(workflow, 'on');
    const start = section.findIndex((line) => line === `  ${event}:`);
    if (start < 0) throw new Error(`workflow does not subscribe to ${event}`);
    const body = section.slice(start + 1);
    const end = body.findIndex((entry) => /^ {2}\S/.test(entry));
    const block = end < 0 ? body : body.slice(0, end);
    const line = block.find((entry) => /^ {4}types:/.test(entry));
    if (line === undefined) return [];
    return [...line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)]
      .map((match) => match[0])
      .filter((token) => token !== 'types')
      .sort();
  }

  it('uses the default code-changing events rather than rebuilding after body edits', () => {
    // The PR-body checks now run in pr-closure-scope.yml. Keeping `edited` here
    // would rerun two full platform builds for metadata they no longer read.
    expect(typesOf(ciWorkflow, 'pull_request')).toEqual([]);
  });

  /**
   * The control the two tests above cannot supply for themselves.
   *
   * Both run against the real ci.yml, where `pull_request:` does carry
   * `types:`. Neither can therefore distinguish "read the right block" from
   * "read a block that happened to hold the right answer". This one asserts
   * the absence directly, on a workflow built so the wrong answer is
   * available and attributable: only `pull_request_target:` carries `types:`,
   * so an unbounded scan returns its list and a bounded scan returns [].
   *
   * Guarding an extractor against returning NOTHING is not the same as
   * guarding it against returning SOMEONE ELSE'S ANSWER, and the second is
   * the failure mode that stays green.
   */
  it('does not read types from a sibling event block', () => {
    const crafted = [
      'name: CI',
      'on:',
      '  pull_request:',
      '  pull_request_target:',
      '    types: [opened, synchronize, reopened, edited]',
      'jobs:',
      '  desktop:',
    ].join('\n');

    expect(typesOf(crafted, 'pull_request')).toEqual([]);
    // The wrong answer really is reachable in this fixture -- without this,
    // the assertion above would also hold for a workflow with no `types:`
    // anywhere, and would prove nothing about the bound.
    expect(typesOf(crafted, 'pull_request_target')).toContain('edited');
  });
});
