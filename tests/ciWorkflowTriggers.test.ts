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

/** Event names a workflow subscribes to, in file order. */
function triggersOf(workflow: string): string[] {
  return topLevelSection(workflow, 'on').flatMap((line) => {
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
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
 * The check-run names GitHub renders, which is what a branch ruleset matches
 * required contexts against. A rename here is a breaking change.
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
    expect(triggersOf(ciWorkflow)).toEqual([
      'push',
      'pull_request',
      'merge_group',
    ]);
  });

  it('still restricts push runs to the two long-lived branches', () => {
    expect(topLevelSection(ciWorkflow, 'on')).toContain(
      '    branches: [development, main]',
    );
  });

  it('gates no job on the event name, which would skip it under merge_group', () => {
    // A job-level `if:` sits at four spaces; the two `runner.os` guards in
    // `sidecar` are step-level (eight spaces) and are unaffected by the event.
    const jobLevelConditions = jobsOf(ciWorkflow).flatMap(({ key, body }) =>
      body
        .filter((line) => /^ {4}if:/.test(line))
        .map((line) => `${key}:${line}`),
    );
    expect(jobLevelConditions).toEqual([]);
    expect(ciWorkflow).not.toContain('github.event_name');
  });

  it('renders exactly the required contexts a ruleset would pin, byte-identical', () => {
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
      expect(triggersOf(contents)).toEqual(triggers);
      expect(triggersOf(contents)).not.toContain('merge_group');
    },
  );
});
