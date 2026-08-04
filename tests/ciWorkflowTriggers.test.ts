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

describe('CI is safe to run under a merge queue', () => {
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
    // Belt and braces on the specific deadlock: even outside a job-level
    // `if:`, branching on the event name reintroduces it.
    expect(ciWorkflow).not.toContain('github.event_name');
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
