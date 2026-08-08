import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  HOLD_CONTEXT_NAME,
  HOLD_WORKFLOW_FILE,
  evaluateHoldGateReadiness,
  formatReadiness,
} from '../scripts/check-hold-gate-readiness.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const liveWorkflowContents = readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', HOLD_WORKFLOW_FILE),
  'utf8',
);

const reportingWorkflow = [
  '# merge-queue: reports',
  'on:',
  '  pull_request:',
  '    types: [opened, synchronize, reopened, labeled, unlabeled]',
  '  merge_group:',
  'jobs:',
  '  sequencing-hold:',
  '    name: Sequencing hold',
  '    runs-on: ubuntu-latest',
  '    steps: []',
].join('\n');

const advisoryWorkflow = [
  '# merge-queue: advisory',
  'on:',
  '  pull_request:',
  '    types: [opened, synchronize, reopened, labeled, unlabeled]',
  'jobs:',
  '  sequencing-hold:',
  '    name: Sequencing hold',
  '    runs-on: ubuntu-latest',
  '    steps: []',
].join('\n');

/**
 * #480 chose (a) — `Sequencing hold` as a required status context — over
 * (b) — required approving reviews — because (b) is categorically
 * impossible while `jpapiez` is the sole collaborator (self-review 422s;
 * #206, #187). This suite pins the two remaining prerequisites for (a) so
 * neither can be silently declared done: the workflow must actually
 * subscribe to merge_group and declare itself "reports", AND branch
 * protection must actually list the context. Either alone is a trap that
 * reads as fixed and is not — the same shape #388's ruleset and #206's
 * review-count findings both name.
 */
describe('evaluateHoldGateReadiness', () => {
  it('is NOT ready today: the live workflow is still classified advisory', () => {
    // Pinned against the real file on disk, not a fixture, so this fails the
    // day someone changes the workflow without updating this expectation —
    // the same reason mergeQueueReadiness.test.ts reads real workflow files
    // rather than a copy.
    const result = evaluateHoldGateReadiness({
      workflowContents: liveWorkflowContents,
      requiredContexts: [
        'Desktop (windows-latest)',
        'Desktop (macos-latest)',
        'Sidecar (windows-latest)',
        'Sidecar (macos-latest)',
        'Release package (windows-latest)',
        'Release package (macos-latest)',
        'Dependency advisories',
        'Closing-reference declaration',
      ],
      rulesets: [
        { name: 'development merge queue', target: 'BRANCH', enforcement: 'disabled' },
      ],
    });
    expect(result.workflowReports).toBe(false);
    expect(result.contextRequired).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.id)).toEqual([
      'workflow-merge-group',
      'branch-protection-context',
    ]);
  });

  it('reports ready only once both prerequisites hold', () => {
    const result = evaluateHoldGateReadiness({
      workflowContents: reportingWorkflow,
      requiredContexts: [HOLD_CONTEXT_NAME],
      rulesets: [],
    });
    expect(result.workflowReports).toBe(true);
    expect(result.contextRequired).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('still blocks when only the workflow is fixed and the context is not required', () => {
    const result = evaluateHoldGateReadiness({
      workflowContents: reportingWorkflow,
      requiredContexts: [],
      rulesets: [],
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.id)).toEqual([
      'branch-protection-context',
    ]);
  });

  it('still blocks when only the context is required and the workflow stays advisory', () => {
    const result = evaluateHoldGateReadiness({
      workflowContents: advisoryWorkflow,
      requiredContexts: [HOLD_CONTEXT_NAME],
      rulesets: [],
    });
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.id)).toEqual(['workflow-merge-group']);
  });

  it('escalates to an urgent live-deadlock finding if that unsafe combination is ever live', () => {
    // The one combination that must never be silently "fine": required,
    // advisory, and the merge queue actually turned on. This is the exact
    // #122/#388 hazard, and it must announce itself rather than rely on
    // someone remembering to check.
    const result = evaluateHoldGateReadiness({
      workflowContents: advisoryWorkflow,
      requiredContexts: [HOLD_CONTEXT_NAME],
      rulesets: [
        { name: 'development merge queue', target: 'BRANCH', enforcement: 'active' },
      ],
    });
    expect(result.blockers.map((b) => b.id)).toContain('live-deadlock');
  });

  it('rejects non-string workflow contents rather than reporting readiness for a value that cannot show it', () => {
    expect(() =>
      evaluateHoldGateReadiness({
        workflowContents: undefined as unknown as string,
        requiredContexts: [],
      }),
    ).toThrow(/workflowContents must be/);
  });

  it('rejects a non-array requiredContexts', () => {
    expect(() =>
      evaluateHoldGateReadiness({
        workflowContents: advisoryWorkflow,
        requiredContexts: undefined as unknown as string[],
      }),
    ).toThrow(/requiredContexts must be an array/);
  });
});

describe('formatReadiness', () => {
  it('names every blocker and its owner', () => {
    const result = evaluateHoldGateReadiness({
      workflowContents: advisoryWorkflow,
      requiredContexts: [],
      rulesets: [],
    });
    const message = formatReadiness(result);
    expect(message).toContain('NOT yet enforcing');
    expect(message).toContain('workflow-merge-group');
    expect(message).toContain('branch-protection-context');
  });

  it('reports enforcement is live once ready', () => {
    const result = evaluateHoldGateReadiness({
      workflowContents: reportingWorkflow,
      requiredContexts: [HOLD_CONTEXT_NAME],
      rulesets: [],
    });
    expect(formatReadiness(result)).toContain('The #480 gate is enforcing');
  });
});
