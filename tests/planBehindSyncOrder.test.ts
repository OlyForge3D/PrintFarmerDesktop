import { describe, expect, it, vi } from 'vitest';

import {
  planSyncOrder,
  formatPlan,
  parseArgs,
  main,
  surveyBehindPrs,
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
  it('returns an empty plan map when nothing is BEHIND', () => {
    const plans = planSyncOrder([
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
    expect(plans.size).toBe(0);
  });

  it('picks exactly one next candidate, never the whole BEHIND set at once', () => {
    // This is the property #263 is about: a caller that syncs everything
    // returned at once has reintroduced the contention burst that was
    // measured (six CI runs entering within eleven seconds). The shape of
    // the return value -- one `next`, the rest `queued` -- is what makes
    // "sync all of these" the wrong thing to read off it.
    const plans = planSyncOrder([
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
    const plan = plans.get('development');
    expect(plan?.next?.number).toBe(10);
    expect(plan?.queued.map((c) => c.number)).toEqual([11, 12]);
  });

  it('orders the oldest-createdAt BEHIND PR first regardless of input order', () => {
    const plans = planSyncOrder([
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
    const plan = plans.get('development');
    expect(plan?.next?.number).toBe(10);
    expect(plan?.queued.map((c) => c.number)).toEqual([20, 30]);
  });

  it('breaks a createdAt tie on the lower PR number, deterministically', () => {
    const plans = planSyncOrder([
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
    const plan = plans.get('development');
    expect(plan?.next?.number).toBe(7);
    expect(plan?.queued.map((c) => c.number)).toEqual([42]);
  });

  it('ignores PRs that are not BEHIND when choosing the next sync', () => {
    const plans = planSyncOrder([
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
    const plan = plans.get('development');
    expect(plan?.next?.number).toBe(2);
    expect(plan?.queued).toEqual([]);
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

  it('groups BEHIND PRs by their own base, never serializing across bases', () => {
    // Two open PRs targeting different bases are not the same queue: #10
    // being BEHIND development says nothing about whether #99 (targeting
    // release/1.x) is safe to sync next, or vice versa.
    const plans = planSyncOrder([
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
    expect(plans.size).toBe(2);
    expect(plans.get('development')?.next?.number).toBe(10);
    expect(plans.get('development')?.queued.map((c) => c.number)).toEqual([
      11,
    ]);
    expect(plans.get('release/1.x')?.next?.number).toBe(99);
    expect(plans.get('release/1.x')?.queued).toEqual([]);
  });
});

describe('formatPlan', () => {
  it('says nothing to sync when there is no next candidate anywhere', () => {
    const text = formatPlan(new Map(), []);
    expect(text).toContain('No open pull request is BEHIND its base');
  });

  it('names exactly one PR to sync next and warns against firing multiple', () => {
    const plans = new Map([
      [
        'development',
        {
          next: {
            number: 5,
            createdAt: '2026-08-04T09:00:00Z',
            baseRefName: 'development',
            behind: true,
          },
          queued: [],
        },
      ],
    ]);
    const text = formatPlan(plans, []);
    expect(text).toContain('Sync PR #5 next');
    expect(text).toContain('contention');
  });

  it('lists queued PRs as not-yet, distinct from the one to sync now', () => {
    const plans = new Map([
      [
        'development',
        {
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
              baseRefName: 'development',
              behind: true,
            },
          ],
        },
      ],
    ]);
    const text = formatPlan(plans, []);
    expect(text).toContain('do not sync these yet');
    expect(text).toContain('#6');
    expect(text).toContain('#7');
  });

  it('prints one labeled section per base when multiple bases have a plan', () => {
    const plans = new Map([
      [
        'development',
        {
          next: {
            number: 5,
            createdAt: '2026-08-04T09:00:00Z',
            baseRefName: 'development',
            behind: true,
          },
          queued: [],
        },
      ],
      [
        'release/1.x',
        {
          next: {
            number: 99,
            createdAt: '2026-08-04T08:00:00Z',
            baseRefName: 'release/1.x',
            behind: true,
          },
          queued: [],
        },
      ],
    ]);
    const text = formatPlan(plans, []);
    expect(text).toContain('Sync PR #5 next (BEHIND development');
    expect(text).toContain('Sync PR #99 next (BEHIND release/1.x');
  });

  it('reports skipped/undetermined PRs distinctly, never as a silent clear', () => {
    // The bug this guards: an earlier draft dropped undetermined PRs from
    // the candidate list entirely, so an incomplete survey printed the
    // exact same "nothing to sync" as a genuinely clean one. Undetermined
    // must never read as all-clear.
    const text = formatPlan(new Map(), [
      { number: 42, reason: 'base development could not be refreshed from origin.' },
    ]);
    expect(text).toContain('Could not determine BEHIND status');
    expect(text).toContain('#42');
    expect(text).toContain('could not be refreshed');
    expect(text).not.toContain('No open pull request is BEHIND');
  });

  it('reports skipped PRs alongside a real plan, not instead of it', () => {
    const plans = new Map([
      [
        'development',
        {
          next: {
            number: 5,
            createdAt: '2026-08-04T09:00:00Z',
            baseRefName: 'development',
            behind: true,
          },
          queued: [],
        },
      ],
    ]);
    const text = formatPlan(plans, [
      { number: 42, reason: 'moved mid-survey.' },
    ]);
    expect(text).toContain('Sync PR #5 next');
    expect(text).toContain('Could not determine BEHIND status');
    expect(text).toContain('#42');
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
    vi.mocked(shaStatus.isAncestor).mockReturnValue(false);

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
    vi.mocked(shaStatus.resolveCommit).mockImplementation(
      (rev: string) => (rev === 'refs/tmp/head' ? 'sha-current' : rev),
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
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((msg: string) => {
        logged.push(msg);
      });
    try {
      expect(
        main(
          [],
          { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
          run as never,
        ),
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
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((msg: string) => {
        logged.push(msg);
      });
    try {
      expect(
        main(
          [],
          { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
          run as never,
        ),
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
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((msg: string) => {
        logged.push(msg);
      });
    try {
      expect(
        main(
          [],
          { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' },
          run as never,
        ),
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
