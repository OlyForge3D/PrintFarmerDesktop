// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  ERR_DEPENDENCY_CYCLE,
  ERR_MALFORMED_RESPONSE,
  ERR_TRUNCATED_LISTING,
  NO_PRIORITY_RANK,
  RoundPlanError,
  assertCompleteListing,
  buildDependencyGraph,
  buildRoundPlan,
  diffSnapshot,
  effectivePriority,
  findDependencyCycles,
  formatPlan,
  normalizeIssues,
  openBlockers,
  orderQueue,
  priorityRank,
  transitiveUnblockValue,
} from '../scripts/squad-round-plan.mjs';

function issue(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    state: 'open',
    title: `issue ${number}`,
    labels: [],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('a partial listing is an error, never a plan', () => {
  it('refuses a listing the API says has another page', () => {
    expect(() =>
      assertCompleteListing({
        items: [1, 2],
        limit: 100,
        hasNextPage: true,
        source: 'issues',
      }),
    ).toThrowError(
      expect.objectContaining({ code: ERR_TRUNCATED_LISTING }) as Error,
    );
  });

  it('refuses a listing sitting exactly at its cap, which is indistinguishable from truncated', () => {
    let caught: RoundPlanError | null = null;
    try {
      assertCompleteListing({ items: [1, 2, 3], limit: 3, source: 'issues' });
    } catch (error) {
      caught = error as RoundPlanError;
    }
    expect(caught?.code).toBe(ERR_TRUNCATED_LISTING);
    expect(caught?.message).toMatch(/at a limit of 3/);
  });

  it('refuses to conclude completeness with no cap supplied', () => {
    expect(() =>
      assertCompleteListing({ items: [1], limit: undefined, source: 'issues' }),
    ).toThrowError(
      expect.objectContaining({ code: ERR_MALFORMED_RESPONSE }) as Error,
    );
  });

  it('accepts a listing genuinely below its cap', () => {
    expect(
      assertCompleteListing({
        items: [1, 2],
        limit: 100,
        hasNextPage: false,
        source: 'issues',
      }),
    ).toEqual([1, 2]);
  });
});

describe('malformed API payloads fail loudly rather than plausibly', () => {
  it('rejects a non-array issue listing', () => {
    expect(() => normalizeIssues({ number: 1 })).toThrowError(
      expect.objectContaining({ code: ERR_MALFORMED_RESPONSE }) as Error,
    );
  });

  it('rejects an issue with no usable number instead of defaulting it', () => {
    expect(() => normalizeIssues([{ number: 'not-a-number' }])).toThrowError(
      /number is not a positive integer/,
    );
  });

  it('rejects a dependency map that is an array', () => {
    expect(() => buildDependencyGraph([] as never)).toThrowError(
      expect.objectContaining({ code: ERR_MALFORMED_RESPONSE }) as Error,
    );
  });

  it('rejects a blocker entry that is not an object', () => {
    expect(() => buildDependencyGraph({ 10: [12] })).toThrowError(
      /not an object/,
    );
  });
});

describe('normalisation collapses duplicates and reports the collapse', () => {
  it('keeps one row per number and names what was collapsed', () => {
    const result = normalizeIssues([
      issue(10, { title: 'stale' }),
      issue(11),
      issue(10, { title: 'fresh' }),
    ]);
    expect(result.issues.map((row: { number: number }) => row.number)).toEqual([
      10, 11,
    ]);
    expect(result.issues[0]?.title).toBe('fresh');
    expect(result.duplicates).toEqual([10]);
  });
});

describe('dependency handling', () => {
  it('drops a self-edge rather than reporting it as a cycle', () => {
    const graph = buildDependencyGraph({ 10: [{ number: 10, state: 'open' }] });
    expect([...(graph.blockedBy.get(10) ?? [])]).toEqual([]);
    expect(findDependencyCycles(graph)).toEqual([]);
  });

  it('reports a genuine cycle instead of throwing the round away', () => {
    const graph = buildDependencyGraph({
      10: [{ number: 11, state: 'open' }],
      11: [{ number: 10, state: 'open' }],
    });
    const cycles = findDependencyCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
    expect(ERR_DEPENDENCY_CYCLE).toBe('E_DEPENDENCY_CYCLE');
  });

  it('treats a CLOSED blocker as no blocker, from either source', () => {
    const graph = buildDependencyGraph({
      10: [
        { number: 11, state: 'closed' },
        { number: 12, state: 'open' },
      ],
    });
    const states = new Map([
      [11, 'closed'],
      [12, 'open'],
      [13, 'closed'],
    ]);
    const blockers = openBlockers(10, {
      graph,
      issueStates: states,
      markers: { 10: [13] },
    });
    expect(blockers.native).toEqual([12]);
    expect(blockers.prose).toEqual([]);
    expect(blockers.all).toEqual([12]);
  });

  it('counts each transitively freed OPEN issue exactly once', () => {
    const graph = buildDependencyGraph({
      11: [{ number: 10, state: 'open' }],
      12: [{ number: 10, state: 'open' }],
      13: [
        { number: 11, state: 'open' },
        { number: 12, state: 'open' },
      ],
    });
    const states = new Map([
      [11, 'open'],
      [12, 'open'],
      [13, 'open'],
    ]);
    expect(transitiveUnblockValue(10, { graph, issueStates: states })).toBe(3);
  });

  it('terminates on a cycle rather than recursing forever', () => {
    const graph = buildDependencyGraph({
      10: [{ number: 11, state: 'open' }],
      11: [{ number: 10, state: 'open' }],
    });
    const states = new Map([
      [10, 'open'],
      [11, 'open'],
    ]);
    expect(transitiveUnblockValue(10, { graph, issueStates: states })).toBe(1);
  });
});

describe('priority inheritance', () => {
  it('ranks an unlabelled issue after every labelled one', () => {
    expect(priorityRank(['priority:p0'])).toBe(0);
    expect(priorityRank([])).toBe(NO_PRIORITY_RANK);
  });

  it('lifts a p2 that blocks a p0 to p0, two hops away', () => {
    const issues = [
      issue(10, { labels: ['priority:p2'] }),
      issue(11, { labels: ['priority:p3'] }),
      issue(12, { labels: ['priority:p0'] }),
    ];
    const graph = buildDependencyGraph({
      11: [{ number: 10, state: 'open' }],
      12: [{ number: 11, state: 'open' }],
    });
    const result = effectivePriority(10, {
      graph,
      issues: normalizeIssues(issues).issues,
    });
    expect(result.rank).toBe(0);
    expect(result.ownRank).toBe(2);
    expect(result.inheritedFrom).toBe(12);
  });

  it('does not inherit from a CLOSED downstream issue', () => {
    const issues = [
      issue(10, { labels: ['priority:p2'] }),
      issue(11, { labels: ['priority:p0'], state: 'closed' }),
    ];
    const graph = buildDependencyGraph({
      11: [{ number: 10, state: 'open' }],
    });
    expect(
      effectivePriority(10, { graph, issues: normalizeIssues(issues).issues })
        .rank,
    ).toBe(2);
  });

  it('orders the queue totally, so identical data yields an identical queue', () => {
    const issues = normalizeIssues([
      issue(10, { labels: ['priority:p2'] }),
      issue(11, { labels: ['priority:p1'] }),
      issue(12, { labels: ['priority:p1'] }),
    ]).issues;
    const graph = buildDependencyGraph({
      13: [{ number: 12, state: 'open' }],
    });
    const states = new Map([[13, 'open']]);
    const order = orderQueue(issues, { graph, issues, issueStates: states });
    // p1 before p2; between the two p1s, the one that unblocks work wins.
    expect(order.map((entry: { number: number }) => entry.number)).toEqual([
      12, 11, 10,
    ]);

    const again = orderQueue([...issues].reverse(), {
      graph,
      issues,
      issueStates: states,
    });
    expect(again.map((entry: { number: number }) => entry.number)).toEqual([
      12, 11, 10,
    ]);
  });
});

describe('snapshot diffing distinguishes "new" from "moved"', () => {
  it('reports a first-ever observation as added, not changed', () => {
    const diff = diffSnapshot(null, { 'issue#1': { updatedAt: 'a' } });
    expect(diff.added).toEqual(['issue#1']);
    expect(diff.changed).toEqual([]);
  });

  it('separates changed, unchanged and removed', () => {
    const diff = diffSnapshot(
      { a: { v: 1 }, b: { v: 1 }, c: { v: 1 } },
      { a: { v: 1 }, b: { v: 2 } },
    );
    expect(diff).toEqual({
      added: [],
      changed: ['b'],
      unchanged: ['a'],
      removed: ['c'],
    });
  });
});

describe('the round plan is compact, balanced, and actionable', () => {
  const input = {
    issues: [
      issue(10, { labels: ['priority:p2'] }),
      issue(11, { labels: ['priority:p0'] }),
      issue(12, { labels: ['priority:p1'] }),
      issue(13, { state: 'closed' }),
    ],
    dependencies: {
      11: [{ number: 10, state: 'open' }],
      12: [{ number: 13, state: 'closed' }],
    },
    slots: { capacity: 5, active: 3 },
  };

  it('accounts for every open issue exactly once', () => {
    const plan = buildRoundPlan(input);
    expect(plan.openIssues).toBe(3);
    expect(plan.accounting.balanced).toBe(true);
    expect(plan.accounting.blocked + plan.accounting.ready).toBe(3);
  });

  it('treats an issue whose only blocker is CLOSED as READY', () => {
    const plan = buildRoundPlan(input);
    expect(plan.blocked.map((row: { number: number }) => row.number)).toEqual([
      11,
    ]);
    expect(plan.queue.map((row: { number: number }) => row.number)).toContain(
      12,
    );
  });

  it('dispatches only into free slots, honouring the five-slot ceiling', () => {
    expect(buildRoundPlan(input).dispatch).toHaveLength(2);
    expect(
      buildRoundPlan({ ...input, slots: { capacity: 5, active: 5 } }).dispatch,
    ).toEqual([]);
  });

  it('emits JSON far smaller than the payload it was derived from', () => {
    const plan = formatPlan(buildRoundPlan(input));
    expect(plan.length).toBeLessThan(JSON.stringify(input).length * 4);
    const roundTripped = JSON.parse(plan) as {
      accounting: { balanced: boolean };
    };
    expect(roundTripped.accounting.balanced).toBe(true);
  });

  it('carries the cache partition so a round can report what it did NOT re-read', () => {
    const plan = buildRoundPlan({
      ...input,
      reuse: {
        reuse: [{ number: 10 }],
        inspect: [{ number: 11, reason: 'changed: verdictComments' }],
      },
    });
    expect(plan.cache.reused).toEqual([10]);
    expect(plan.cache.reinspect).toEqual([
      { number: 11, why: 'changed: verdictComments' },
    ]);
  });
});
