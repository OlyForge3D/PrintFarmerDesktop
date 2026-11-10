// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  QUEUE_PARAMETERS,
  REQUIRED_CONTEXT_NAMES,
  evaluateQueuePolicy,
  validQueueRuleset,
} from '../scripts/merge-queue-policy.mjs';
import {
  assertGroupBinding,
  assertQueuePull,
  checkDevelopmentQueue,
  checkQueueRuns,
  main as queueMain,
  verifyQueueEvent,
  type QueueApi,
  type QueuePull,
  type QueueRun,
  type QueueRunner,
} from '../scripts/check-development-queue.mjs';
import {
  evaluateRequiredContexts,
  readWorkflows,
} from '../scripts/check-merge-queue-contexts.mjs';
import {
  evaluateProtectionAssumptions,
  fetchPrivilegedRepositoryFacts,
} from '../scripts/check-protection-assumptions.mjs';
import {
  main as behindMain,
  EXIT_QUEUE_REQUIRED,
} from '../scripts/check-behind-base.mjs';
import { surveyBehindPrs } from '../scripts/plan-behind-sync-order.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const groupHead = 'c'.repeat(40);
const checks = REQUIRED_CONTEXT_NAMES.map((context) => ({
  context,
  appId: 15368,
}));
const protection = (strict = false) => ({
  required_status_checks: {
    strict,
    checks: checks.map(({ context, appId }) => ({ context, app_id: appId })),
    contexts: [...REQUIRED_CONTEXT_NAMES],
  },
});
const ruleset = () => ({
  id: 1,
  enforcement: 'active',
  target: 'branch',
  conditions: {
    ref_name: { include: ['refs/heads/development'], exclude: [] },
  },
  bypass_actors: [],
  rules: [{ type: 'merge_queue', parameters: { ...QUEUE_PARAMETERS } }],
});
const rules = () => [{ ...ruleset().rules[0], ruleset_id: 1 }];
const group = () => ({
  base_ref: 'refs/heads/development',
  base_sha: base,
  head_sha: groupHead,
  head_ref: `refs/heads/gh-readonly-queue/development/pr-10-${base}`,
});
const pull = (): QueuePull => ({
  id: 'PR_test',
  state: 'OPEN',
  isDraft: false,
  headRefOid: head,
  baseRefName: 'development',
  baseSha: base,
  mergeable: 'MERGEABLE',
  labels: [],
  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
  mergeQueueEntry: null,
});
const entry = () => ({
  id: 'MQ_test',
  state: 'AWAITING_CHECKS',
  position: 1,
  baseCommit: { oid: base },
  headCommit: { oid: groupHead },
});
const runs = (commit = head): (QueueRun & { details_url: string })[] =>
  checks.map(({ context }) => ({
    id: 1,
    name: context,
    head_sha: commit,
    app: { id: 15368 },
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-11-10T00:00:00Z',
    completed_at: '2026-11-10T00:01:00Z',
    details_url:
      'https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/99/job/1',
  }));

function fixture() {
  const state = {
    pull: pull(),
    active: true,
    strict: false,
    checks: runs(),
    groupChecks: runs(groupHead),
    requests: [] as string[],
    mutationCount: 0,
    pullReads: 0,
    groupEvent: 'merge_group',
  };
  const api: QueueApi = (endpoint, fields) => {
    state.requests.push(endpoint);
    if (endpoint === 'graphql') {
      if (fields?.query?.includes('mutation')) {
        state.mutationCount += 1;
        state.pull.mergeQueueEntry = entry();
        return {
          data: {
            enqueuePullRequest: {
              mergeQueueEntry: {
                id: 'MQ_test',
                pullRequest: { headRefOid: head },
              },
            },
          },
        };
      }
      state.pullReads += 1;
      return {
        data: {
          repository: {
            pullRequest: structuredClone(state.pull),
            mergeQueue: {
              entries: {
                nodes: state.pull.mergeQueueEntry
                  ? [
                      {
                        id: state.pull.mergeQueueEntry.id,
                        headCommit: state.pull.mergeQueueEntry.headCommit,
                        pullRequest: {
                          number: 10,
                          headRefOid: state.pull.headRefOid,
                        },
                      },
                    ]
                  : [],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      };
    }
    if (endpoint.includes('/protection')) return protection(state.strict);
    if (endpoint.includes('/rules/branches'))
      return state.active ? rules() : [];
    if (endpoint.includes('/rulesets/')) return ruleset();
    if (endpoint.includes('/pulls/'))
      return {
        state: 'open',
        head: { sha: state.pull.headRefOid },
        base: { ref: 'development' },
        labels: state.pull.labels,
      };
    if (endpoint.includes('/git/ref/'))
      return { object: { sha: state.pull.baseSha } };
    if (endpoint.includes(`/commits/${groupHead}/check-runs`))
      return { check_runs: state.groupChecks };
    if (endpoint.includes('/check-runs')) return { check_runs: state.checks };
    if (endpoint.includes('/actions/runs/'))
      return {
        event: state.groupEvent,
        head_sha: groupHead,
        status: 'completed',
        conclusion: 'success',
      };
    throw new Error(`Unexpected request ${endpoint}`);
  };
  return { state, api };
}

describe('staged development policy', () => {
  it.each([false, true, undefined])(
    'corroborates omitted REST reviews using the matching rule enabled-state (%s)',
    async (enabled) => {
      const fetchImpl: typeof fetch = (input) => {
        if (typeof input !== 'string') throw new Error('Expected string URL');
        const url = input;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              url.endsWith('/graphql')
                ? {
                    data: {
                      repository: {
                        ref: {
                          branchProtectionRule: {
                            id: 'BPR_test',
                            pattern: 'development',
                            requiresApprovingReviews: enabled,
                            requiredApprovingReviewCount: enabled ? 1 : null,
                          },
                        },
                      },
                    },
                  }
                : url.endsWith('/collaborators')
                  ? []
                  : protection(true),
            ),
            { status: 200 },
          ),
        );
      };
      const request = fetchPrivilegedRepositoryFacts({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        token: 'test',
        fetchImpl,
      });
      if (enabled === undefined)
        await expect(request).rejects.toThrow(/could not be corroborated/);
      else {
        const facts = await request;
        expect(facts.protection.required_pull_request_reviews).toEqual(
          enabled ? { required_approving_review_count: 1 } : null,
        );
      }
    },
  );
  it('pins all nine contexts including Design detector with Actions bindings', () => {
    expect(REQUIRED_CONTEXT_NAMES).toHaveLength(9);
    expect(REQUIRED_CONTEXT_NAMES).toContain('Design detector');
    expect(
      evaluateQueuePolicy({
        protection: protection(),
        rules: rules(),
        rulesets: [ruleset()],
      }).mode,
    ).toBe('queue');
  });
  it('retains strict protection before activation and tolerates safe activation overlap', () => {
    expect(
      evaluateQueuePolicy({
        protection: protection(true),
        rules: [],
        rulesets: [],
      }).mode,
    ).toBe('strict');
    expect(
      evaluateQueuePolicy({
        protection: protection(true),
        rules: rules(),
        rulesets: [ruleset()],
      }).mode,
    ).toBe('queue');
    expect(() =>
      evaluateQueuePolicy({
        protection: protection(),
        rules: [],
        rulesets: [],
      }),
    ).toThrow(/Unsafe transition/);
  });
  it.each([
    ['bypass', { bypass_actors: [{ actor_type: 'OrganizationAdmin' }] }],
    [
      'wildcard',
      { conditions: { ref_name: { include: ['~ALL'], exclude: [] } } },
    ],
    ['disabled', { enforcement: 'disabled' }],
    [
      'batch',
      {
        rules: [
          {
            type: 'merge_queue',
            parameters: { ...QUEUE_PARAMETERS, max_entries_to_merge: 5 },
          },
        ],
      },
    ],
    [
      'HEADGREEN',
      {
        rules: [
          {
            type: 'merge_queue',
            parameters: { ...QUEUE_PARAMETERS, grouping_strategy: 'HEADGREEN' },
          },
        ],
      },
    ],
    [
      'nonlinear',
      {
        rules: [
          {
            type: 'merge_queue',
            parameters: { ...QUEUE_PARAMETERS, merge_method: 'MERGE' },
          },
        ],
      },
    ],
  ])('refuses %s queue configuration', (_name, override) => {
    expect(validQueueRuleset({ ...ruleset(), ...override })).toBe(false);
    expect(() =>
      evaluateQueuePolicy({
        protection: protection(),
        rules: rules(),
        rulesets: [{ ...ruleset(), ...override }],
      }),
    ).toThrow(/Queue must/);
  });
  it('does not drop an effective ruleset-required context or app binding', () => {
    const effective = [
      ...rules(),
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [{ context: 'Extra', integration_id: 15368 }],
        },
      },
    ];
    expect(
      evaluateQueuePolicy({
        protection: protection(),
        rules: effective,
        rulesets: [ruleset()],
      }).checks,
    ).toContainEqual({ context: 'Extra', appId: 15368 });
    const wrongApp = protection();
    wrongApp.required_status_checks.checks =
      wrongApp.required_status_checks.checks.map((check) => ({
        ...check,
        app_id: 1,
      }));
    expect(() =>
      evaluateQueuePolicy({
        protection: wrongApp,
        rules: rules(),
        rulesets: [ruleset()],
      }),
    ).toThrow(/app binding/);
  });
  it('accepts explicit null review requirements but only accepts loose checks with a valid active queue', () => {
    const facts = {
      protection: {
        ...protection(),
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        enforce_admins: { enabled: false },
        required_linear_history: { enabled: true },
        required_pull_request_reviews: null,
      },
      rulesets: [ruleset()],
      collaborators: [{ login: 'jpapiez', role: 'admin' }],
      protectedBranches: ['development'],
    };
    expect(evaluateProtectionAssumptions(facts)).toEqual([]);
    expect(
      evaluateProtectionAssumptions({ ...facts, rulesets: [] }).map(
        (v) => v.assumption,
      ),
    ).toContain('development.required_status_checks.strict');
  });
});

describe('source review and combined-result evidence stay separate', () => {
  it('routes the legacy merge guard and sync planner through live queue policy without manual syncs', () => {
    const { api } = fixture();
    const env = {
      GITHUB_TOKEN: 'test',
      GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop',
    };
    const run = (_command: unknown, rawArgs: unknown) => {
      if (!Array.isArray(rawArgs)) throw new Error('Expected argument vector');
      const args: unknown[] = rawArgs;
      const value =
        args[0] === 'api'
          ? api(String(args[1]))
          : args[1] === 'list'
            ? [
                {
                  number: 10,
                  createdAt: '2026-11-10T00:00:00Z',
                  headRefOid: head,
                  baseRefName: 'development',
                },
              ]
            : { headRefOid: head, baseRefName: 'development' };
      return { status: 0, stdout: JSON.stringify(value), stderr: '' };
    };
    expect(behindMain(['--pr', '10'], env, run)).toBe(EXIT_QUEUE_REQUIRED);
    expect(surveyBehindPrs({}, env, run)).toEqual({
      candidates: [],
      skipped: [],
    });
    const unavailable = () => ({
      status: 1,
      stderr: 'unavailable',
      stdout: '',
    });
    expect(behindMain(['--pr', '10'], env, unavailable)).toBe(2);
  });
  it('allows conflict-free behind sources to enqueue without updating them', () => {
    // Different source and base; no ancestry precondition or branch write.
    const { state, api } = fixture();
    const verify = vi.fn();
    expect(
      checkDevelopmentQueue({ number: 10, head, enqueue: true }, api, verify),
    ).toMatch(/Enqueued/);
    expect(verify).toHaveBeenCalledWith(10, head);
    expect(state.mutationCount).toBe(1);
    expect(state.pull.headRefOid).toBe(head);
    expect(state.requests.some((request) => request.includes('/merge'))).toBe(
      false,
    );
  });
  it('is read-only unless --enqueue is explicit', () => {
    const { state, api } = fixture();
    expect(checkDevelopmentQueue({ number: 10, head }, api, vi.fn())).toMatch(
      /Eligible to enqueue/,
    );
    expect(state.mutationCount).toBe(0);
  });
  it('refuses pre-activation enqueue rather than weakening the legacy guard', () => {
    const { state, api } = fixture();
    state.active = false;
    state.strict = true;
    expect(() =>
      checkDevelopmentQueue({ number: 10, head, enqueue: true }, api, vi.fn()),
    ).toThrow(/not activated/);
    expect(state.mutationCount).toBe(0);
  });
  it.each(['CONFLICTING', 'UNKNOWN'])(
    'refuses %s mergeability',
    (mergeable) => {
      expect(() => assertQueuePull({ ...pull(), mergeable }, head)).toThrow(
        /mergeability/,
      );
    },
  );
  it('refuses holds, draft, unreadable/unresolved threads and stale reviews', () => {
    const p = pull();
    expect(() =>
      assertQueuePull({ ...p, labels: [{ name: 'hold:new-kind' }] }, head),
    ).toThrow(/hold/);
    expect(() => assertQueuePull({ ...p, isDraft: true }, head)).toThrow(
      /non-draft/,
    );
    expect(() =>
      assertQueuePull(
        { ...p, reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } },
        head,
      ),
    ).toThrow(/threads/);
    expect(() =>
      assertQueuePull(
        {
          ...p,
          reviewThreads: {
            nodes: [{ isResolved: false }],
            pageInfo: { hasNextPage: false },
          },
        },
        head,
      ),
    ).toThrow(/threads/);
    expect(() => assertQueuePull(p, groupHead)).toThrow(/Source head/);
    const { api, state } = fixture();
    expect(() =>
      checkDevelopmentQueue({ number: 10, head, enqueue: true }, api, () => {
        throw new Error('Review rejected');
      }),
    ).toThrow(/Review rejected/);
    expect(state.mutationCount).toBe(0);
  });
  it.each(['failure', null, 'skipped', 'cancelled'])(
    'refuses %s group conclusion',
    (conclusion) => {
      const rs = runs(groupHead);
      for (const run of rs) run.conclusion = conclusion;
      expect(() => checkQueueRuns(checks, rs, groupHead)).toThrow(
        /not successful/,
      );
    },
  );
  it('refuses pending, missing, wrong-app and wrong-SHA group contexts', () => {
    for (const bad of [
      runs(groupHead).slice(1),
      runs(groupHead).map((run) => ({ ...run, status: 'in_progress' })),
      runs(groupHead).map((run) => ({ ...run, app: { id: 1 } })),
      runs(head),
    ])
      expect(() => checkQueueRuns(checks, bad, groupHead)).toThrow(
        /not successful/,
      );
    expect(() =>
      checkQueueRuns(checks, runs(groupHead), groupHead),
    ).not.toThrow();
  });
  it('never accepts source green as group green and attributes group checks to merge_group', () => {
    const { state, api } = fixture();
    state.pull.mergeQueueEntry = entry();
    state.groupChecks = [];
    expect(() =>
      checkDevelopmentQueue({ number: 10, head }, api, vi.fn(), vi.fn()),
    ).toThrow(/not successful/);
    state.groupChecks = runs(groupHead);
    state.groupEvent = 'pull_request';
    expect(() =>
      checkDevelopmentQueue({ number: 10, head }, api, vi.fn(), vi.fn()),
    ).toThrow(/merge_group workflow/);
    state.groupEvent = 'merge_group';
    expect(
      checkDevelopmentQueue({ number: 10, head }, api, vi.fn(), vi.fn()),
    ).toMatch(/group checks passed/);
  });
  it('distinguishes a normal waiting entry from invalid group evidence without granting readiness', () => {
    const { state, api } = fixture();
    state.pull.mergeQueueEntry = { ...entry(), position: 2, state: 'QUEUED' };
    expect(() =>
      checkDevelopmentQueue({ number: 10, head }, api, vi.fn()),
    ).toThrow(/waiting its turn/);
    state.pull.mergeQueueEntry = {
      ...entry(),
      state: 'QUEUED',
      headCommit: null,
    };
    expect(() =>
      checkDevelopmentQueue({ number: 10, head }, api, vi.fn()),
    ).toThrow(/waiting its turn/);
    state.pull.mergeQueueEntry = { ...entry(), state: 'QUEUED' };
    expect(() =>
      checkDevelopmentQueue({ number: 10, head }, api, vi.fn()),
    ).toThrow(/waiting its turn/);
    state.pull.mergeQueueEntry = { ...entry(), state: 'UNMERGEABLE' };
    expect(() =>
      checkDevelopmentQueue({ number: 10, head }, api, vi.fn()),
    ).toThrow(/stale or unknown/);
  });
  it('does not let an older completion hide a newer pending attempt', () => {
    const old = runs(groupHead);
    const latest = old.map((run) => ({
      ...run,
      id: 2,
      status: 'in_progress',
      conclusion: null,
      started_at: '2026-11-10T00:00:30Z',
      completed_at: null,
    }));
    expect(() =>
      checkQueueRuns(checks, [...old, ...latest], groupHead),
    ).toThrow(/not successful/);
  });
  it('invalidates cached source/base/group membership and refuses unknown entries', () => {
    const p = { ...pull(), mergeQueueEntry: entry() };
    expect(() => assertGroupBinding(p, group())).not.toThrow();
    for (const changed of [
      { ...p, baseSha: head },
      { ...p, mergeQueueEntry: null },
      { ...p, mergeQueueEntry: { ...entry(), position: 2 } },
      { ...p, mergeQueueEntry: { ...entry(), state: 'UNMERGEABLE' } },
      { ...p, mergeQueueEntry: { ...entry(), headCommit: { oid: head } } },
    ])
      expect(() => assertGroupBinding(changed, group())).toThrow(
        /stale or unknown/,
      );
    const { state, api } = fixture();
    const movingApi: QueueApi = (endpoint, fields) => {
      if (endpoint === 'graphql' && state.pullReads === 1)
        state.pull.baseSha = head;
      return api(endpoint, fields);
    };
    expect(() =>
      checkDevelopmentQueue(
        { number: 10, head, enqueue: true },
        movingApi,
        vi.fn(),
      ),
    ).toThrow(/changed during/);
    expect(state.mutationCount).toBe(0);
  });
  it('fails closed on transport errors and malformed policy', () => {
    expect(() =>
      checkDevelopmentQueue(
        { number: 10, head },
        () => {
          throw new Error('network');
        },
        vi.fn(),
      ),
    ).toThrow(/network/);
    expect(() =>
      evaluateQueuePolicy({ protection: {}, rules: [], rulesets: [] }),
    ).toThrow(/could not be read/);
  });
});

describe('actual merge-group workflow contract', () => {
  it('all nine effective required names have real merge-group triggers', () => {
    const workflows = readWorkflows(
      path.resolve(import.meta.dirname, '../.github/workflows'),
    );
    expect(
      evaluateRequiredContexts({
        workflows,
        requiredContexts: [...REQUIRED_CONTEXT_NAMES],
      }),
    ).toEqual([]);
    const broken = workflows.map((workflow) => ({
      ...workflow,
      contents: workflow.contents.replace(
        /^ {2}merge_group:/m,
        '  ignored_event:',
      ),
    }));
    expect(
      evaluateRequiredContexts({
        workflows: broken,
        requiredContexts: [...REQUIRED_CONTEXT_NAMES],
      }),
    ).toHaveLength(9);
  });
  it('binds trusted event verification to membership, squash proof and source review', () => {
    const { state, api } = fixture();
    state.pull.mergeQueueEntry = entry();
    const verify = vi.fn();
    const proof = vi.fn();
    expect(
      verifyQueueEvent({ merge_group: group() }, api, verify, proof),
    ).toMatch(/source-head review/);
    expect(verify).toHaveBeenCalledWith(10, head);
    expect(() =>
      verifyQueueEvent(
        { merge_group: { ...group(), head_sha: head } },
        api,
        verify,
        proof,
      ),
    ).toThrow(/stale or unknown/);
    expect(proof).toHaveBeenCalledWith({
      base,
      head,
      group: groupHead,
      number: 10,
    });
    expect(() =>
      verifyQueueEvent({ merge_group: group() }, api, verify, () => {
        throw new Error('Squash tree mismatch');
      }),
    ).toThrow(/tree mismatch/);
  });
  it.each(['omitted', 'empty'] as const)(
    '--event accepts the live %s bypass shape without claiming invisible evidence',
    (shape) => {
      const { state, api } = fixture();
      state.pull.mergeQueueEntry = entry();
      const detail: Record<string, unknown> = ruleset();
      if (shape === 'omitted') delete detail.bypass_actors;
      const eventApi: QueueApi = (endpoint, fields) =>
        endpoint.includes('/rulesets/') ? detail : api(endpoint, fields);
      const directory = mkdtempSync(path.join(tmpdir(), 'queue-event-'));
      const eventPath = path.join(directory, 'event.json');
      writeFileSync(eventPath, JSON.stringify({ merge_group: group() }));
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      const run = vi.fn<QueueRunner>((command, args) => {
        const fields: Record<string, string> = {};
        for (let index = 2; index < args.length; index += 1) {
          if (args[index] === '-f') {
            const field = args[++index] ?? '';
            const equals = field.indexOf('=');
            fields[field.slice(0, equals)] = field.slice(equals + 1);
          }
        }
        const value =
          command === process.execPath
            ? { classification: 'REVIEWED', reviewedHeadSha: head }
            : eventApi(String(args[1]), fields);
        const stdout = JSON.stringify(value);
        return {
          status: 0,
          stdout,
          stderr: '',
        };
      });
      try {
        expect(
          queueMain(
            ['--event'],
            {
              GH_TOKEN: 'ci-read-only',
              GITHUB_EVENT_NAME: 'merge_group',
              GITHUB_EVENT_PATH: eventPath,
            },
            run,
            vi.fn(),
          ),
        ).toBe(0);
        expect(output).toHaveBeenCalledWith(
          expect.stringContaining(
            shape === 'omitted'
              ? 'not-checked-no-scope: bypass actors'
              : 'explicit empty bypass_actors observed',
          ),
        );
        expect(state.requests.some((url) => url.includes('/protection'))).toBe(
          false,
        );
        expect(state.mutationCount).toBe(0);
        const reviewCall = run.mock.calls.find(
          ([command]) => command === process.execPath,
        );
        expect(reviewCall?.[1]).toEqual(
          expect.arrayContaining(['--expected-head', head]),
        );
        expect(reviewCall?.[2].env.GH_TOKEN).toBe('ci-read-only');
      } finally {
        output.mockRestore();
        rmSync(directory, { recursive: true });
      }
    },
  );
  it.each([
    { bypass_actors: null },
    { bypass_actors: [{ actor_type: 'OrganizationAdmin' }] },
    { enforcement: 'disabled' },
    { id: 2 },
    { conditions: { ref_name: { include: ['~ALL'], exclude: [] } } },
    { rules: [{ type: 'merge_queue', parameters: {} }] },
  ])('refuses ambiguous or unsafe event policy %j', (override) => {
    const { state, api } = fixture();
    state.pull.mergeQueueEntry = entry();
    const verify = vi.fn();
    const changed: QueueApi = (endpoint, fields) =>
      endpoint.includes('/rulesets/')
        ? { ...ruleset(), ...override }
        : api(endpoint, fields);
    expect(() =>
      verifyQueueEvent({ merge_group: group() }, changed, verify),
    ).toThrow(/bypass|unverified/);
    expect(verify).not.toHaveBeenCalled();
  });
  it('refuses policy drift during event verification and malformed effective parameters', () => {
    const { state, api } = fixture();
    state.pull.mergeQueueEntry = entry();
    let reads = 0;
    const drifting: QueueApi = (endpoint, fields) =>
      endpoint.includes('/rulesets/')
        ? { ...ruleset(), name: `read-${++reads}` }
        : api(endpoint, fields);
    expect(() =>
      verifyQueueEvent({ merge_group: group() }, drifting, vi.fn(), vi.fn()),
    ).toThrow(/policy changed/);
    const badRules: QueueApi = (endpoint, fields) =>
      endpoint.includes('/rules/branches')
        ? [{ ...rules()[0], parameters: {} }]
        : api(endpoint, fields);
    expect(() =>
      verifyQueueEvent({ merge_group: group() }, badRules, vi.fn()),
    ).toThrow(/not active/);
  });
  it('checks out the base-owned guard, never supplies an admin secret or runs it on source events', () => {
    const workflow = readFileSync(
      path.resolve(
        import.meta.dirname,
        '../.github/workflows/sequencing-hold.yml',
      ),
      'utf8',
    );
    expect(workflow).toContain('ref: ${{ github.event.merge_group.base_sha }}');
    expect(workflow).toContain('npm run check:development-queue -- --event');
    expect(workflow).toContain(
      "if: github.event_name == 'merge_group' && github.event.merge_group.base_ref == 'refs/heads/development'",
    );
    expect(workflow).not.toContain('MERGE_QUEUE_CONTEXTS_TOKEN');
    expect(workflow).not.toContain('pull-requests: write');
    expect(workflow).toContain('actions: read');
    const sourceJob = workflow.split('  sequencing-hold:')[0] ?? '';
    expect(sourceJob).not.toContain('actions: read');
    const trustedJob = workflow.split('  sequencing-hold:')[1] ?? '';
    expect(trustedJob).toContain('    if: always()');
    expect(trustedJob).toContain('test "$SOURCE_POLICY_RESULT" = success');
    expect(trustedJob).not.toContain('github.event.pull_request.head.sha');
  });
});
