import { describe, expect, it } from 'vitest';

import {
  OUTCOMES,
  beginAction,
  classifyField,
  observe,
  parseArgs,
  relayedSnapshot,
  renderLines,
  report,
} from '../scripts/pr-snapshot-report.mjs';

// The fields exactly as the incident in #496 relayed them: PR #349 reported
// OPEN and unmerged more than two hours after it merged. Every value here was
// true when it was read, which is why reading it cannot detect the fault.
const OPEN_FIELDS = {
  number: 349,
  title: 'Narrow the retarget sweep catch to the pending-handle family',
  state: 'OPEN',
  merged: false,
  mergedAt: null,
  headRefOid: '7e1ff139570a84b522f8e5d87e8cb217856d4cac',
  baseRefName: 'development',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BEHIND',
};

const MERGED_FIELDS = {
  number: 349,
  state: 'closed',
  merged: true,
  mergedAt: '2026-08-05T04:43:23Z',
  mergeCommitSha: 'f23364fef80aae2360e0a922d7a99d2dc4211834',
  changedFiles: 2,
};

const outcomesSeen = new Set<string>();

function reportAndRecord(
  snapshot: ReturnType<typeof relayedSnapshot>,
  action: ReturnType<typeof beginAction> | null,
) {
  const result = report(snapshot, action);
  for (const entry of result.entries) outcomesSeen.add(entry.outcome);
  return result;
}

const byField = (result: ReturnType<typeof report>, field: string) => {
  const entry = result.entries.find((candidate) => candidate.field === field);
  if (!entry) throw new Error(`no entry emitted for ${field}`);
  return entry;
};

describe('pr snapshot report', () => {
  // NEGATIVE CONTROL, and it runs in the same file as the positive one on
  // purpose. Without it, an instrument that refuses everything passes by
  // construction: "the stale fixture was refused" is satisfied by a function
  // whose body is `return refused`.
  it('renders a fresh observation in full', () => {
    const action = beginAction();
    const snapshot = observe(() => ({ ...OPEN_FIELDS }), action);
    const result = reportAndRecord(snapshot, action);

    expect(result.sameAction).toBe(true);
    expect(result.entries.filter((entry) => entry.withheld)).toHaveLength(0);
    expect(byField(result, 'state').value).toBe('OPEN');
    expect(byField(result, 'state').outcome).toBe('fresh');
    expect(byField(result, 'number').outcome).toBe('durable');
    // The latch is open here, but the observation is this action's, so the
    // field renders. Refusal must be caused by relay, not by `merged=false`.
    expect(byField(result, 'merged').outcome).toBe('fresh');
    expect(byField(result, 'merged').value).toBe(false);
  });

  // POSITIVE CONTROL: the incident itself.
  it('withholds every volatile field of a relayed observation', () => {
    const action = beginAction();
    const snapshot = relayedSnapshot({
      observedAt: '2026-08-05T02:25:00Z',
      fields: { ...OPEN_FIELDS },
    });
    const result = reportAndRecord(snapshot, action);

    expect(result.sameAction).toBe(false);
    expect(byField(result, 'state').outcome).toBe('refused-stale');
    expect(byField(result, 'state').value).toBeNull();
    expect(byField(result, 'mergeStateStatus').outcome).toBe('refused-stale');
    expect(byField(result, 'merged').outcome).toBe('refused-latch-open');
    // Durable claims survive relay. If they did not, the module would be an
    // age threshold wearing different words.
    expect(byField(result, 'number').outcome).toBe('durable');
    expect(byField(result, 'number').value).toBe(349);
  });

  it('treats merged as a latch: durable once true, even when relayed', () => {
    const action = beginAction();
    const result = reportAndRecord(
      relayedSnapshot({
        observedAt: '2026-08-05T04:43:23Z',
        fields: { ...MERGED_FIELDS },
      }),
      action,
    );

    expect(byField(result, 'merged').outcome).toBe('latched');
    expect(byField(result, 'merged').value).toBe(true);
    expect(byField(result, 'changedFiles').value).toBe(2);
    expect(byField(result, 'mergeCommitSha').value).toBe(
      'f23364fef80aae2360e0a922d7a99d2dc4211834',
    );
    // `state` is NOT rescued by the latch: it answers whether the PR is over,
    // never how it ended, and a closed-unmerged PR can reopen. Measured over
    // the last 100 closed PRs in this repo: 92 merged, 8 closed-and-unmerged.
    expect(byField(result, 'state').outcome).toBe('refused-stale');
  });

  it('refuses a field whose volatility is not classified', () => {
    const action = beginAction();
    const result = reportAndRecord(
      relayedSnapshot({ observedAt: null, fields: { autoMergeRequest: 'x' } }),
      action,
    );

    expect(byField(result, 'autoMergeRequest').outcome).toBe(
      'refused-unclassified',
    );
    expect(byField(result, 'autoMergeRequest').value).toBeNull();
  });

  // The guard must be structural, not temporal. These two assertions fail
  // together the moment anyone reintroduces an age threshold.
  it('does not use elapsed time as the discriminator', () => {
    const action = beginAction();

    const ancientButMine = observe(
      () => ({ ...OPEN_FIELDS }),
      action,
      () => '2019-01-01T00:00:00Z',
    );
    expect(byField(report(ancientButMine, action), 'state').outcome).toBe(
      'fresh',
    );

    const secondsOldButRelayed = relayedSnapshot({
      observedAt: new Date().toISOString(),
      fields: { ...OPEN_FIELDS },
    });
    expect(byField(report(secondsOldButRelayed, action), 'state').outcome).toBe(
      'refused-stale',
    );
  });

  it('emits refusals rather than omitting fields', () => {
    const action = beginAction();
    const snapshot = relayedSnapshot({
      observedAt: '2026-08-05T02:25:00Z',
      fields: { ...OPEN_FIELDS },
    });
    const result = reportAndRecord(snapshot, action);

    expect(result.entries).toHaveLength(Object.keys(OPEN_FIELDS).length);
    const lines = renderLines(result);
    expect(lines[0]).toContain('2026-08-05T02:25:00Z');
    expect(lines.filter((line) => line.includes('REFUSED')).length).toBe(
      result.entries.filter((entry) => entry.withheld).length,
    );
    expect(
      lines.filter((line) => line.includes('REFUSED')).length,
    ).toBeGreaterThan(0);
  });

  it('cannot be relabelled as current by the relayer', () => {
    const action = beginAction();
    const forged = { ...relayedSnapshot({ observedAt: null, fields: {} }) };
    expect(forged.actionId).toBeNull();
    // A snapshot taken under one action is not fresh under another.
    const other = beginAction();
    const mine = observe(() => ({ ...OPEN_FIELDS }), action);
    expect(report(mine, other).sameAction).toBe(false);
  });

  it('rejects malformed invocations rather than defaulting', () => {
    expect(() => parseArgs(['349'])).toThrow(/--repo/);
    expect(() => parseArgs(['--repo', 'a/b'])).toThrow(/number/);
    expect(parseArgs(['--repo', 'a/b', '349'])).toEqual({
      repo: 'a/b',
      number: '349',
    });
  });

  it('requires an action to observe under', () => {
    expect(() =>
      observe(() => ({}), null as unknown as ReturnType<typeof beginAction>),
    ).toThrow(/beginAction/);
  });

  it('classifies against the snapshot it was given', () => {
    const open = relayedSnapshot({ observedAt: null, fields: OPEN_FIELDS });
    const merged = relayedSnapshot({ observedAt: null, fields: MERGED_FIELDS });
    expect(classifyField('mergedAt', open, false).outcome).toBe(
      'refused-latch-open',
    );
    expect(classifyField('mergedAt', merged, false).outcome).toBe('latched');
  });

  // Every declared outcome must be reachable by a fixture. An outcome no
  // fixture produces is a branch nobody has run, and it reads exactly like a
  // branch that always passes. This must be the last test in the file.
  it('exercises every declared outcome', () => {
    expect([...outcomesSeen].sort()).toEqual([...OUTCOMES].sort());
  });
});
