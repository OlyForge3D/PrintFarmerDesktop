import { describe, expect, it, vi } from 'vitest';

import {
  planSyncOrder,
  formatPlan,
  parseArgs,
  main,
  surveyBehindPrs,
  isLeaseExpired,
  readSyncLease,
  claimSyncLease,
  SYNC_LEASE_REF,
} from '../scripts/plan-behind-sync-order.mjs';

// The git-level primitives come from scripts/sha-status.mjs and
// scripts/check-behind-base.mjs and are already exercised in their own test
// files. main()/surveyBehindPrs integration tests below stub them so this
// file tests ordering logic, not git plumbing.
vi.mock('../scripts/sha-status.mjs', () => ({
  isAncestor: vi.fn(),
  fetchBase: vi.fn(),
  fetchPrHead: vi.fn(),
  resolveCommit: vi.fn(),
}));

const shaStatus = await import('../scripts/sha-status.mjs');

describe('planSyncOrder', () => {
  it('returns a null next when nothing is BEHIND', () => {
    const plan = planSyncOrder([
      {
        number: 1,
        createdAt: '2026-08-01T00:00:00Z',
        baseRefName: 'development',
        behind: false,
      },
      {
        number: 2,
        createdAt: '2026-08-02T00:00:00Z',
        baseRefName: 'development',
        behind: false,
      },
    ]);
    expect(plan.next).toBeNull();
    expect(plan.queued).toEqual([]);
  });

  it('picks exactly one next candidate, never the whole BEHIND set at once', () => {
    // This is the property #263 is about: a caller that syncs everything
    // returned at once has reintroduced the contention burst that was
    // measured (six CI runs entering within eleven seconds). The shape of
    // the return value -- one `next`, the rest `queued` -- is what makes
    // "sync all of these" the wrong thing to read off it.
    const plan = planSyncOrder([
      {
        number: 10,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      {
        number: 11,
        createdAt: '2026-08-04T10:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      {
        number: 12,
        createdAt: '2026-08-04T11:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
    ]);
    expect(plan.next?.number).toBe(10);
    expect(plan.queued.map((c) => c.number)).toEqual([11, 12]);
  });

  it('orders the oldest-createdAt BEHIND PR first regardless of input order', () => {
    const plan = planSyncOrder([
      {
        number: 30,
        createdAt: '2026-08-04T11:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      {
        number: 10,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      {
        number: 20,
        createdAt: '2026-08-04T10:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
    ]);
    expect(plan.next?.number).toBe(10);
    expect(plan.queued.map((c) => c.number)).toEqual([20, 30]);
  });

  it('breaks a createdAt tie on the lower PR number, deterministically', () => {
    const plan = planSyncOrder([
      {
        number: 42,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      {
        number: 7,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
    ]);
    expect(plan.next?.number).toBe(7);
    expect(plan.queued.map((c) => c.number)).toEqual([42]);
  });

  it('ignores PRs that are not BEHIND when choosing the next sync', () => {
    const plan = planSyncOrder([
      {
        number: 1,
        createdAt: '2026-08-04T08:00:00Z',
        baseRefName: 'development',
        behind: false,
      },
      {
        number: 2,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
    ]);
    expect(plan.next?.number).toBe(2);
    expect(plan.queued).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [
      {
        number: 2,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      {
        number: 1,
        createdAt: '2026-08-04T08:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
    ];
    const copy = input.map((c) => ({ ...c }));
    planSyncOrder(input);
    expect(input).toEqual(copy);
  });

  it('serializes globally across base branches, not one queue per base', () => {
    // Hicks and Vasquez, external review round on PR #681: the previous
    // version grouped by baseRefName and returned an independent `next` PER
    // BASE, so #10 (development) and #99 (release/1.x) could both be
    // recommended as "next" in the same round. That reintroduces the
    // contention #263 measured -- both syncs still launch a full CI fan-out
    // into the SAME shared runner pool, regardless of which branch either
    // targets. Only ONE candidate, across every base combined, may come back
    // as `next`; the other two -- even though one targets a different base
    // entirely -- must be `queued`.
    const plan = planSyncOrder([
      {
        number: 10,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      {
        number: 99,
        createdAt: '2026-08-04T08:00:00Z',
        baseRefName: 'release/1.x',
        behind: true,
      },
      {
        number: 11,
        createdAt: '2026-08-04T10:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
    ]);
    expect(plan.next?.number).toBe(99);
    expect(plan.next?.baseRefName).toBe('release/1.x');
    expect(plan.queued.map((c) => c.number)).toEqual([10, 11]);
  });
});

describe('formatPlan', () => {
  it('says nothing to sync when there is no next candidate anywhere', () => {
    const text = formatPlan({ next: null, queued: [] }, []);
    expect(text).toContain('No open pull request is BEHIND its base');
  });

  it('names exactly one PR to sync next and warns against firing multiple', () => {
    const plan = {
      next: {
        number: 5,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      queued: [],
    };
    const text = formatPlan(plan, []);
    expect(text).toContain('Sync PR #5 next');
    expect(text).toContain('contention');
  });

  it("warns that the cross-base guarantee holds even when queued PRs share the next one's base", () => {
    const plan = {
      next: {
        number: 5,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      queued: [],
    };
    const text = formatPlan(plan, []);
    expect(text).toMatch(/ACROSS base branches/i);
  });

  it('lists queued PRs as not-yet, distinct from the one to sync now', () => {
    const plan = {
      next: {
        number: 5,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      queued: [
        {
          number: 6,
          createdAt: '2026-08-04T10:00:00Z',
          baseRefName: 'development',
          behind: true,
        },
        {
          number: 7,
          createdAt: '2026-08-04T11:00:00Z',
          baseRefName: 'release/1.x',
          behind: true,
        },
      ],
    };
    const text = formatPlan(plan, []);
    expect(text).toContain('do not sync these yet');
    expect(text).toContain('#6');
    expect(text).toContain('#7');
  });

  it('reports skipped/undetermined PRs distinctly, never as a silent clear', () => {
    // The bug this guards: an earlier draft dropped undetermined PRs from
    // the candidate list entirely, so an incomplete survey printed the
    // exact same "nothing to sync" as a genuinely clean one. Undetermined
    // must never read as all-clear.
    const text = formatPlan({ next: null, queued: [] }, [
      {
        number: 42,
        reason: 'base development could not be refreshed from origin.',
      },
    ]);
    expect(text).toContain('Could not determine BEHIND status');
    expect(text).toContain('#42');
    expect(text).toContain('could not be refreshed');
    expect(text).not.toContain('No open pull request is BEHIND');
  });

  it('reports skipped PRs alongside a real plan, not instead of it', () => {
    const plan = {
      next: {
        number: 5,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      queued: [],
    };
    const text = formatPlan(plan, [
      { number: 42, reason: 'moved mid-survey.' },
    ]);
    expect(text).toContain('Sync PR #5 next');
    expect(text).toContain('Could not determine BEHIND status');
    expect(text).toContain('#42');
  });

  it('reports an active lease instead of a new recommendation, even if the leased PR is not in this survey', () => {
    // Vasquez, external review round on PR #681: advisory-only ordering
    // does not stop two concurrent sessions/rounds from both reading the
    // same "sync next" recommendation and both acting on it. Once a lease
    // is active, formatPlan must report THAT instead of computing a fresh
    // "next" -- otherwise a second invocation mid-sync would recommend a
    // second, concurrent base-sync anyway, defeating the whole point of the
    // lease.
    const plan = {
      next: {
        number: 5,
        createdAt: '2026-08-04T09:00:00Z',
        baseRefName: 'development',
        behind: true,
      },
      queued: [],
    };
    const lease = {
      prNumber: 3,
      claimedAt: '2026-08-04T09:00:00.000Z',
      expiresAt: '2026-08-04T09:30:00.000Z',
    };
    const text = formatPlan(plan, [], lease);
    expect(text).toContain('already in flight for PR #3');
    expect(text).not.toContain('Sync PR #5 next');
    expect(text).toContain('#5');
    expect(text).toContain('do not sync these yet');
  });
});

describe('isLeaseExpired', () => {
  it('is false strictly before expiresAt', () => {
    const lease = {
      prNumber: 1,
      claimedAt: '2026-08-04T09:00:00.000Z',
      expiresAt: '2026-08-04T09:30:00.000Z',
    };
    const now = new Date('2026-08-04T09:29:00.000Z').getTime();
    expect(isLeaseExpired(lease, now)).toBe(false);
  });

  it('is true at or after expiresAt', () => {
    const lease = {
      prNumber: 1,
      claimedAt: '2026-08-04T09:00:00.000Z',
      expiresAt: '2026-08-04T09:30:00.000Z',
    };
    const now = new Date('2026-08-04T09:30:00.000Z').getTime();
    expect(isLeaseExpired(lease, now)).toBe(true);
  });

  it('is true for an unparsable expiresAt, never treated as "never expires"', () => {
    const lease = {
      prNumber: 1,
      claimedAt: '2026-08-04T09:00:00.000Z',
      expiresAt: 'not-a-date',
    };
    expect(isLeaseExpired(lease, Date.now())).toBe(true);
  });
});

describe('readSyncLease', () => {
  it('reports no lease when the ref has never been claimed (fetch fails)', () => {
    // Verified empirically against a scratch bare repository: fetching a
    // ref that has never been pushed exits 128 ("couldn't find remote
    // ref"), not 0 with empty output. That must read as "no lease", not an
    // error to surface.
    const run = vi
      .fn()
      .mockReturnValue({ status: 128, stdout: '', stderr: '' });
    const result = readSyncLease('origin', run as never);
    expect(result).toEqual({ lease: null, oid: null });
    expect(run).toHaveBeenCalledWith(
      'git',
      [
        'fetch',
        '--quiet',
        'origin',
        `${SYNC_LEASE_REF}:refs/tmp/behind-sync-lease/read`,
      ],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('fetches into a private local ref, then reads oid and message from it', () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'log') {
        return {
          status: 0,
          stdout:
            '{"prNumber":7,"claimedAt":"2026-08-04T09:00:00.000Z","expiresAt":"2026-08-04T09:30:00.000Z"}\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const result = readSyncLease('origin', run as never);
    expect(result.oid).toBe('abc123');
    expect(result.lease).toEqual({
      prNumber: 7,
      claimedAt: '2026-08-04T09:00:00.000Z',
      expiresAt: '2026-08-04T09:30:00.000Z',
    });
    expect(calls[0]).toEqual([
      'fetch',
      '--quiet',
      'origin',
      `${SYNC_LEASE_REF}:refs/tmp/behind-sync-lease/read`,
    ]);
    expect(calls[1]).toEqual(['rev-parse', 'refs/tmp/behind-sync-lease/read']);
    expect(calls[2]).toEqual([
      'log',
      '-1',
      '--format=%B',
      'refs/tmp/behind-sync-lease/read',
    ]);
  });

  it('returns oid with a null lease when the message is not valid lease JSON', () => {
    const run = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse')
        return { status: 0, stdout: 'abc123\n', stderr: '' };
      if (args[0] === 'log')
        return { status: 0, stdout: 'not json', stderr: '' };
      throw new Error('unexpected');
    });
    const result = readSyncLease('origin', run as never);
    expect(result).toEqual({ lease: null, oid: 'abc123' });
  });
});

describe('claimSyncLease', () => {
  it('claims an empty ref with an empty --force-with-lease expect value', () => {
    // Verified empirically: `--force-with-lease=<ref>:` (empty expect)
    // succeeds only if the ref does not yet exist remotely on GitHub.
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'fetch') return { status: 128, stdout: '', stderr: '' };
      if (args[0] === 'commit-tree') {
        return { status: 0, stdout: 'newoid123\n', stderr: '' };
      }
      if (args[0] === 'push') return { status: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const result = claimSyncLease(5, 'origin', run as never, {
      now: new Date('2026-08-04T09:00:00.000Z').getTime(),
      ttlMs: 30 * 60 * 1000,
    });
    expect(result).toEqual({ claimed: true });
    const pushCall = calls.find((c) => c[0] === 'push');
    expect(pushCall).toEqual([
      'push',
      'origin',
      `newoid123:${SYNC_LEASE_REF}`,
      `--force-with-lease=${SYNC_LEASE_REF}:`,
    ]);
    const commitCall = calls.find((c) => c[0] === 'commit-tree');
    expect(commitCall?.[1]).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    expect(commitCall?.[2]).toBe('-m');
    const payload: unknown = JSON.parse(commitCall?.[3] as string);
    expect(payload).toEqual({
      prNumber: 5,
      claimedAt: '2026-08-04T09:00:00.000Z',
      expiresAt: '2026-08-04T09:30:00.000Z',
    });
  });

  it('refuses without pushing when a DIFFERENT PR already holds an unexpired lease', () => {
    const run = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse')
        return { status: 0, stdout: 'oldoid\n', stderr: '' };
      if (args[0] === 'log') {
        return {
          status: 0,
          stdout:
            '{"prNumber":3,"claimedAt":"2026-08-04T08:00:00.000Z","expiresAt":"2026-08-04T09:30:00.000Z"}\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const result = claimSyncLease(5, 'origin', run as never, {
      now: new Date('2026-08-04T09:00:00.000Z').getTime(),
    });
    expect(result.claimed).toBe(false);
    expect(result.reason).toContain('PR #3');
    expect(run).not.toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['push']),
      expect.anything(),
    );
  });

  it('allows re-claiming for the SAME PR that already holds the lease', () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse')
        return { status: 0, stdout: 'oldoid\n', stderr: '' };
      if (args[0] === 'log') {
        return {
          status: 0,
          stdout:
            '{"prNumber":5,"claimedAt":"2026-08-04T08:00:00.000Z","expiresAt":"2026-08-04T08:30:00.000Z"}\n',
          stderr: '',
        };
      }
      if (args[0] === 'commit-tree')
        return { status: 0, stdout: 'newoid\n', stderr: '' };
      if (args[0] === 'push') return { status: 0, stdout: '', stderr: '' };
      throw new Error('unexpected');
    });
    const result = claimSyncLease(5, 'origin', run as never, {
      now: new Date('2026-08-04T09:00:00.000Z').getTime(),
    });
    expect(result).toEqual({ claimed: true });
    const pushCall = calls.find((c) => c[0] === 'push');
    expect(pushCall).toEqual([
      'push',
      'origin',
      `newoid:${SYNC_LEASE_REF}`,
      `--force-with-lease=${SYNC_LEASE_REF}:oldoid`,
    ]);
  });

  it('allows claiming after the previous lease has expired, using its oid as the expect value', () => {
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse')
        return { status: 0, stdout: 'expiredoid\n', stderr: '' };
      if (args[0] === 'log') {
        return {
          status: 0,
          stdout:
            '{"prNumber":3,"claimedAt":"2026-08-04T07:00:00.000Z","expiresAt":"2026-08-04T07:30:00.000Z"}\n',
          stderr: '',
        };
      }
      if (args[0] === 'commit-tree')
        return { status: 0, stdout: 'newoid\n', stderr: '' };
      if (args[0] === 'push') return { status: 0, stdout: '', stderr: '' };
      throw new Error('unexpected');
    });
    const result = claimSyncLease(9, 'origin', run as never, {
      now: new Date('2026-08-04T09:00:00.000Z').getTime(),
    });
    expect(result).toEqual({ claimed: true });
    const pushCall = calls.find((c) => c[0] === 'push');
    expect(pushCall).toEqual([
      'push',
      'origin',
      `newoid:${SYNC_LEASE_REF}`,
      `--force-with-lease=${SYNC_LEASE_REF}:expiredoid`,
    ]);
  });

  it('reports losing the race when the push is rejected as stale', () => {
    // Verified empirically: a stale/wrong expect value is rejected by the
    // remote ("! [rejected] ... (stale info)"), exit 1 -- this is what makes
    // the lease an actual mutual-exclusion primitive rather than a
    // best-effort suggestion: a losing racer's push does NOT silently
    // overwrite the winner's claim.
    const run = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === 'fetch') return { status: 128, stdout: '', stderr: '' };
      if (args[0] === 'commit-tree')
        return { status: 0, stdout: 'newoid\n', stderr: '' };
      if (args[0] === 'push') {
        return { status: 1, stdout: '', stderr: '! [rejected] (stale info)' };
      }
      throw new Error('unexpected');
    });
    const result = claimSyncLease(5, 'origin', run as never, {
      now: new Date('2026-08-04T09:00:00.000Z').getTime(),
    });
    expect(result.claimed).toBe(false);
    expect(result.reason).toMatch(/lost the race/);
  });
});

describe('parseArgs', () => {
  it('defaults remote to origin', () => {
    expect(parseArgs([]).remote).toBe('origin');
  });

  it('reads an explicit remote', () => {
    expect(parseArgs(['--remote', 'upstream']).remote).toBe('upstream');
  });

  it('reads help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('reads --claim', () => {
    expect(parseArgs(['--claim']).claim).toBe(true);
  });

  it('defaults claim to falsy when not passed', () => {
    expect(parseArgs([]).claim).toBeFalsy();
  });

  it('rejects an unknown argument', () => {
    expect(parseArgs(['--wat']).error).toMatch(/unrecognised/);
  });

  it('rejects a missing remote value', () => {
    expect(parseArgs(['--remote']).error).toMatch(/needs a value/);
  });
});

describe('surveyBehindPrs', () => {
  it('skips a PR whose ancestry is inconclusive, never reporting it as not-behind', () => {
    // Hicks, pre-PR review round 2: isAncestor(...) === null (merge-base
    // --is-ancestor exited neither 0 nor 1) previously reached
    // evaluateBehindBase, which reports 'undetermined' -- but the caller here
    // read only `result.state === 'behind'`, so 'undetermined' silently
    // became `behind: false`, i.e. treated as confirmed clear.
    vi.mocked(shaStatus.fetchBase).mockReturnValue({
      ref: 'refs/tmp/sha-status/base',
      fresh: true,
      refreshable: true,
    });
    vi.mocked(shaStatus.resolveCommit).mockImplementation((rev: string) =>
      rev === 'refs/tmp/sha-status/base' ? 'base-sha' : 'sha-current',
    );
    vi.mocked(shaStatus.fetchPrHead).mockReturnValue('refs/tmp/head');
    vi.mocked(shaStatus.isAncestor).mockReturnValue(null);

    const run = (
      _command: string,
      args: readonly string[],
    ): { status: number; stdout: string; stderr: string } => {
      if (args.includes('list')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 42,
              createdAt: '2026-08-04T09:00:00Z',
              baseRefName: 'development',
              headRefOid: 'sha-current',
            },
          ]),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const survey = surveyBehindPrs(
      {},
      { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
      run as never,
    );
    expect('error' in survey).toBe(false);
    if ('error' in survey) return;
    expect(survey.candidates).toEqual([]);
    expect(survey.skipped).toHaveLength(1);
    expect(survey.skipped[0]?.number).toBe(42);
    expect(survey.skipped[0]?.reason).toContain('could not determine whether');
  });

  it('does not cross-contaminate ancestry checks across two different bases', () => {
    // Hicks, pre-PR review round 2: fetchBase always refreshes the SAME
    // shared local ref (refs/tmp/sha-status/base) regardless of which base
    // it fetched. Caching only the returned ref *name* per baseRefName meant
    // that once a second, different base was fetched, the first base's
    // cached entry silently pointed at the second base's commit. This test
    // uses two PRs against two different bases and asserts the survey only
    // fetches (and therefore resolves) each distinct base once, and each PR
    // is correctly labeled with its own base.
    let fetchBaseCalls = 0;
    vi.mocked(shaStatus.fetchBase).mockImplementation(() => {
      fetchBaseCalls += 1;
      return {
        ref: 'refs/tmp/sha-status/base',
        fresh: true,
        refreshable: true,
      };
    });
    vi.mocked(shaStatus.resolveCommit).mockImplementation((rev: string) => {
      if (rev === 'refs/tmp/sha-status/base') {
        // Resolves to whichever base was JUST fetched -- models the shared
        // ref's current target at the moment resolveCommit is called, right
        // after that base's own fetchBase call and before any other base is
        // fetched.
        return fetchBaseCalls === 1 ? 'development-sha' : 'release-sha';
      }
      return 'sha-current';
    });
    vi.mocked(shaStatus.fetchPrHead).mockReturnValue('refs/tmp/head');
    // Neither base is an ancestor of the (different) head -> both BEHIND.
    // Record every (sha, ref) pair isAncestor is actually called with, so the
    // assertions below can prove each PR was compared against its OWN
    // resolved base SHA -- not the shared, unresolved ref name the buggy
    // implementation passed for every PR regardless of which base it was
    // fetched from (Hicks, pre-PR review round 3: the prior version of this
    // test only varied resolveCommit's *return value* by call count and never
    // checked what isAncestor was actually invoked with, so it would have
    // passed unchanged against the old bug too).
    const ancestorCalls: Array<[string, string]> = [];
    vi.mocked(shaStatus.isAncestor).mockImplementation(
      (sha: string, ref: string) => {
        ancestorCalls.push([sha, ref]);
        return false;
      },
    );

    const run = (
      _command: string,
      args: readonly string[],
    ): { status: number; stdout: string; stderr: string } => {
      if (args.includes('list')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 10,
              createdAt: '2026-08-04T09:00:00Z',
              baseRefName: 'development',
              headRefOid: 'sha-current',
            },
            {
              number: 99,
              createdAt: '2026-08-04T08:00:00Z',
              baseRefName: 'release/1.x',
              headRefOid: 'sha-current',
            },
          ]),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const survey = surveyBehindPrs(
      {},
      { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
      run as never,
    );
    expect('error' in survey).toBe(false);
    if ('error' in survey) return;
    // Both bases are only fetched (and therefore resolved) once each --
    // proving the survey resolves and caches each base's SHA once, rather
    // than re-reading the shared ref name after a later base's fetch.
    expect(fetchBaseCalls).toBe(2);
    expect(survey.skipped).toEqual([]);
    expect(survey.candidates.map((c) => c.number).sort()).toEqual([10, 99]);
    expect(survey.candidates.find((c) => c.number === 10)?.baseRefName).toBe(
      'development',
    );
    expect(survey.candidates.find((c) => c.number === 99)?.baseRefName).toBe(
      'release/1.x',
    );
    // The decisive assertion: PR #10 (base development) must have been
    // compared against development-sha, and PR #99 (base release/1.x)
    // against release-sha -- two DIFFERENT sha arguments. Under the bug this
    // regression-tests, both calls would instead receive the same literal,
    // unresolved ref string 'refs/tmp/sha-status/base' (or, after a partial
    // fix that resolves but shares one cache key, the same single resolved
    // value for both), so this distinguishes the fix from every buggy
    // variant, not just from the specific shape of the original bug.
    expect(ancestorCalls).toHaveLength(2);
    expect(ancestorCalls).toContainEqual(['development-sha', 'refs/tmp/head']);
    expect(ancestorCalls).toContainEqual(['release-sha', 'refs/tmp/head']);
  });

  it('errors rather than silently surveying a partial set when gh pr list hits its --limit cap', () => {
    // Hicks, pre-PR review round 4: gh pr list --limit 200 returns at most
    // 200 results with no signal about whether more open PRs exist. If the
    // real open-PR count happens to be >= 200, a survey that trusted exactly
    // 200 results as "all of them" would recommend a next-to-sync PR based on
    // a possibly-partial view -- the same "undetermined read as measured"
    // shape this whole module exists to avoid, just at the list-fetch layer
    // instead of the per-PR layer.
    const run = (
      _command: string,
      args: readonly string[],
    ): { status: number; stdout: string; stderr: string } => {
      if (args.includes('list')) {
        const prs = Array.from({ length: 200 }, (_, i) => ({
          number: i + 1,
          createdAt: '2026-08-04T09:00:00Z',
          baseRefName: 'development',
          headRefOid: 'sha-current',
        }));
        return { status: 0, stdout: JSON.stringify(prs), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const survey = surveyBehindPrs(
      {},
      { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
      run as never,
    );
    expect('error' in survey).toBe(true);
    if (!('error' in survey)) return;
    expect(survey.error).toContain('--limit 200');
  });

  it('surveys normally when the open PR count is comfortably under the --limit cap', () => {
    vi.mocked(shaStatus.fetchBase).mockReturnValue({
      ref: 'refs/tmp/sha-status/base',
      fresh: true,
      refreshable: true,
    });
    vi.mocked(shaStatus.resolveCommit).mockImplementation((rev: string) =>
      rev === 'refs/tmp/sha-status/base' ? 'base-sha' : 'sha-current',
    );
    vi.mocked(shaStatus.fetchPrHead).mockReturnValue('refs/tmp/head');
    vi.mocked(shaStatus.isAncestor).mockReturnValue(true);

    const run = (
      _command: string,
      args: readonly string[],
    ): { status: number; stdout: string; stderr: string } => {
      if (args.includes('list')) {
        const prs = Array.from({ length: 199 }, (_, i) => ({
          number: i + 1,
          createdAt: '2026-08-04T09:00:00Z',
          baseRefName: 'development',
          headRefOid: 'sha-current',
        }));
        return { status: 0, stdout: JSON.stringify(prs), stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const survey = surveyBehindPrs(
      {},
      { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
      run as never,
    );
    expect('error' in survey).toBe(false);
    if ('error' in survey) return;
    expect(survey.candidates).toHaveLength(199);
  });
});

describe('main', () => {
  it('returns non-zero without a credential, rather than a false "nothing to sync"', () => {
    expect(
      main([], {}, () => ({
        status: 0,
        stdout: '',
        stderr: '',
      })),
    ).not.toBe(0);
  });

  it('AN EXCEPTION IS NOT A FINDING: a throw becomes 2, never a verdict', () => {
    expect(
      main([], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, () => {
        throw new Error('boom');
      }),
    ).toBe(2);
  });

  it('reports help and exits 0 without touching gh at all', () => {
    let called = false;
    expect(
      main(['--help'], {}, () => {
        called = true;
        return { status: 0, stdout: '', stderr: '' };
      }),
    ).toBe(0);
    expect(called).toBe(false);
  });

  it('rejects an unrecognised argument before ever calling gh', () => {
    let called = false;
    expect(
      main(['--nope'], {}, () => {
        called = true;
        return { status: 0, stdout: '', stderr: '' };
      }),
    ).toBe(2);
    expect(called).toBe(false);
  });

  it('surveys open PRs and reports the oldest BEHIND one to sync next', () => {
    vi.mocked(shaStatus.fetchPrHead).mockReturnValue('refs/tmp/head');
    vi.mocked(shaStatus.resolveCommit).mockImplementation((rev: string) =>
      rev === 'refs/tmp/head' ? 'sha-current' : rev,
    );
    vi.mocked(shaStatus.fetchBase).mockReturnValue({
      ref: 'refs/tmp/base',
      fresh: true,
      refreshable: true,
    });
    // Every PR is BEHIND for this run of the stub.
    vi.mocked(shaStatus.isAncestor).mockReturnValue(false);

    const run = (
      command: string,
      args: readonly string[],
    ): { status: number; stdout: string; stderr: string } => {
      if (args.includes('list')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 20,
              createdAt: '2026-08-04T10:00:00Z',
              baseRefName: 'development',
              headRefOid: 'sha-current',
            },
            {
              number: 10,
              createdAt: '2026-08-04T09:00:00Z',
              baseRefName: 'development',
              headRefOid: 'sha-current',
            },
          ]),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logged.push(msg);
    });
    try {
      expect(
        main([], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, run as never),
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(logged.join('\n')).toContain('Sync PR #10 next');
    expect(logged.join('\n')).toContain('#20');
  });

  it('reports nothing to sync when gh pr list returns no open PRs', () => {
    const run = (
      _command: string,
      args: readonly string[],
    ): { status: number; stdout: string; stderr: string } => {
      if (args.includes('list')) {
        return { status: 0, stdout: '[]', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logged.push(msg);
    });
    try {
      expect(
        main([], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, run as never),
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(logged.join('\n')).toContain('Nothing to sync');
  });

  it('reports a skipped PR instead of a false "nothing to sync" when its base cannot be refreshed', () => {
    // Regression test for Hicks's pre-PR review finding: a PR whose base
    // could not be refreshed used to be dropped silently, so this exact
    // scenario (one open PR, undetermined) used to print "Nothing to sync" --
    // identical to the genuinely-clean case above -- collapsing "could not
    // tell" into "confirmed clear".
    vi.mocked(shaStatus.fetchBase).mockReturnValue({
      ref: 'refs/tmp/base',
      fresh: false,
      refreshable: true,
    });

    const run = (
      _command: string,
      args: readonly string[],
    ): { status: number; stdout: string; stderr: string } => {
      if (args.includes('list')) {
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              number: 42,
              createdAt: '2026-08-04T09:00:00Z',
              baseRefName: 'development',
              headRefOid: 'sha-current',
            },
          ]),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logged.push(msg);
    });
    try {
      expect(
        main([], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, run as never),
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const out = logged.join('\n');
    expect(out).toContain('Could not determine BEHIND status');
    expect(out).toContain('#42');
    expect(out).not.toContain('Nothing to sync');
  });
});
