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
function concurrencyDeclarations(
  workflow: string,
): Array<{ line: string; group: string | undefined; cancels: boolean }> {
  const lines = workflow.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    if (!/^\s*concurrency:/.test(line)) return [];
    const block = lines.slice(index + 1, index + 6);
    const group = block
      .flatMap((entry) => {
        const match = /^\s*group:\s*(.+)$/.exec(entry);
        return match?.[1] === undefined ? [] : [match[1].trim()];
      })
      .at(0);
    const cancels = block.some((entry) =>
      /^\s*cancel-in-progress:\s*true\s*$/.test(entry),
    );
    return [{ line: line.trim(), group, cancels }];
  });
}

describe('CI is safe to run under a merge queue', () => {
  it('declares no `concurrency:` group, which could cancel a queued entry’s required contexts', () => {
    // Third way to break a merge queue from this file, and the only one not
    // already guarded above. The other two are a workflow that never runs
    // (Pending forever, #122) and a job that is skipped (`skipped` counts as
    // success, so a false green). This one is a third outcome again:
    //
    //   A `concurrency:` group whose key is not unique per merge group, with
    //   `cancel-in-progress: true`, cancels the in-flight run for an earlier
    //   queued entry when a later one is dispatched. A cancelled check run has
    //   conclusion `cancelled`, which is not a success conclusion, so the
    //   entry is removed from the queue — for a reason that has nothing to do
    //   with its own changes, and that reads on the pull request as a CI
    //   failure rather than as a configuration problem.
    //
    // The queue dispatches one `merge_group` build per entry and does not
    // combine them ("Merge limits do not combine merge_group builds" —
    // GitHub, "Managing a merge queue"), so concurrent in-flight runs of this
    // workflow for the same base branch are the normal steady state under a
    // queue, not an edge case.
    //
    // Banning the key outright rather than trying to validate it, for the same
    // reason the job-level `if:` test bans the category: deciding which keys
    // are unique per merge group is harder to get right than requiring the
    // question be asked. A safe form does exist and this repository already
    // uses it — see the positive control below. A legitimate `concurrency:` in
    // ci.yml is therefore not forbidden by policy; it just has to arrive with
    // this question answered, and failing here is how it gets asked.
    //
    // Not verified: no merge queue has run on this repository, so the
    // cancellation behaviour above is from documentation, not observation.
    //
    // The three mutations were taken rather than assumed. Adding
    // `group: ci-${{ github.workflow }}` with `cancel-in-progress: true`
    // fails this test and nothing else; deleting the block below fails the
    // positive control and nothing else; and adding a *safe*
    // `group: ci-${{ github.sha }}` with `cancel-in-progress: false` also
    // fails here — deliberately — with `"cancels": false` in the diagnostic.
    // So the failure hands the reviewer the evidence needed to answer the
    // question it asks, rather than only telling them to look.
    expect(concurrencyDeclarations(ciWorkflow)).toEqual([]);
  });

  it('finds a `concurrency:` block when one is present, so the guard above is not vacuous', () => {
    // Positive control on the extractor. Without it, `toEqual([])` above would
    // pass just as well against a matcher that can never match anything, and
    // the guard would be green for the wrong reason for as long as it lived.
    //
    // release-gpu-qualification.yml carries the only `concurrency:` block in
    // the repository, and it is in the shape that would be safe under a queue:
    // keyed on github.sha, so unique per merge group, and not cancelling.
    expect(concurrencyDeclarations(gpuQualificationWorkflow)).toEqual([
      {
        line: 'concurrency:',
        group: 'release-gpu-qualification-${{ github.sha }}',
        cancels: false,
      },
    ]);
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
    const eventNameLines = ciWorkflow
      .split('\n')
      .filter((line: string) => line.includes('github.event_name'));
    const notOnAStepCondition = eventNameLines.filter(
      (line: string) => !/^ {8}if:/.test(line),
    );
    expect(notOnAStepCondition).toEqual([]);
  });

  it('guards every step that reads PR context, so none can run under a queue entry', () => {
    // The dual of the assertion above, and the one that actually fails closed.
    //
    // Narrowing the `github.event_name` ban to step level opens a gap that the
    // narrowed assertion cannot see: DELETING a step's guard leaves the file
    // with no event branching at all, so that test goes green. The step then
    // runs under `merge_group`, where `github.event.pull_request` expands to
    // nothing, the step fails, and the job fails -- so a required context
    // reports failure on every queued entry and the queue never drains. That
    // is #122's deadlock arriving through the fix for #231.
    //
    // Stated as a property over the file rather than as a list of known steps:
    // a new step added later gets the same treatment without anyone
    // remembering this test exists. A list would have to be maintained to keep
    // working, and the failure of an unmaintained list here is a merge queue
    // that hangs.
    const steps: string[][] = [];
    ciWorkflow.split('\n').forEach((line) => {
      if (/^ {6}- /.test(line)) steps.push([line]);
      else if (steps.length > 0 && /^ {8}\S/.test(line))
        steps[steps.length - 1]?.push(line);
    });

    const unguarded = steps
      .filter((step) =>
        step.some((line) => line.includes('github.event.pull_request')),
      )
      .filter(
        (step) =>
          !step.some(
            (line) =>
              /^ {8}if:/.test(line) &&
              line.includes("github.event_name == 'pull_request'"),
          ),
      )
      .map((step) => step[0]?.trim() ?? '');

    expect(unguarded).toEqual([]);

    // Harness control, and it has already earned its place: the first draft of
    // the splitter reset on each job header, which discarded every step of
    // every job but the last. `unguarded` was [] -- not because the steps were
    // guarded, but because the only PR-context step in the file lives in the
    // FIRST job and was never collected. An empty result reads identically
    // whether nothing is wrong or nothing was examined.
    expect(steps.length).toBeGreaterThan(10);
    expect(
      steps.filter((step) =>
        step.some((line) => line.includes('github.event.pull_request')),
      ).length,
    ).toBeGreaterThan(0);
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
 * ("named a job that never existed, omitted `Dependency advisories`") raised
 * against a file that is right, which sends the next maintainer to edit the
 * correct artifact.
 *
 * Throws rather than returning `[]` when the anchor is gone, so a renamed
 * heading fails by name instead of by an empty set that reads as agreement.
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
  for (const line of lines.slice(heading + 1)) {
    const match = /^-\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      bullets.push(match[1]);
      continue;
    }
    // Blank lines inside the run are tolerated; the first prose line after a
    // bullet has been seen ends it.
    if (bullets.length > 0 && line.trim() !== '') break;
  }
  return bullets.sort();
}

describe('the testing skill transcribes the contexts ci.yml emits', () => {
  // #152: this list named a packaging job that has never existed, and omitted
  // `Dependency advisories`. Nothing read the file, so the correction could
  // regress without any test going red — three references to SKILL.md exist in
  // `tests/`, all of them prose inside docblocks, none of them a read.
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
      renderedContexts(ciWorkflow),
    );
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
