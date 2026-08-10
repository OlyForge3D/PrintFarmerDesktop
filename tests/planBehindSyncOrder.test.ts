import { describe, expect, it, vi } from 'vitest';

import {
  planSyncOrder,
  formatPlan,
  parseArgs,
  main,
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
  it('returns no next candidate when nothing is BEHIND', () => {
    const plan = planSyncOrder([
      { number: 1, createdAt: '2026-08-01T00:00:00Z', behind: false },
      { number: 2, createdAt: '2026-08-02T00:00:00Z', behind: false },
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
      { number: 10, createdAt: '2026-08-04T09:00:00Z', behind: true },
      { number: 11, createdAt: '2026-08-04T10:00:00Z', behind: true },
      { number: 12, createdAt: '2026-08-04T11:00:00Z', behind: true },
    ]);
    expect(plan.next?.number).toBe(10);
    expect(plan.queued.map((c) => c.number)).toEqual([11, 12]);
  });

  it('orders the oldest-createdAt BEHIND PR first regardless of input order', () => {
    const plan = planSyncOrder([
      { number: 30, createdAt: '2026-08-04T11:00:00Z', behind: true },
      { number: 10, createdAt: '2026-08-04T09:00:00Z', behind: true },
      { number: 20, createdAt: '2026-08-04T10:00:00Z', behind: true },
    ]);
    expect(plan.next?.number).toBe(10);
    expect(plan.queued.map((c) => c.number)).toEqual([20, 30]);
  });

  it('breaks a createdAt tie on the lower PR number, deterministically', () => {
    const plan = planSyncOrder([
      { number: 42, createdAt: '2026-08-04T09:00:00Z', behind: true },
      { number: 7, createdAt: '2026-08-04T09:00:00Z', behind: true },
    ]);
    expect(plan.next?.number).toBe(7);
    expect(plan.queued.map((c) => c.number)).toEqual([42]);
  });

  it('ignores PRs that are not BEHIND when choosing the next sync', () => {
    const plan = planSyncOrder([
      { number: 1, createdAt: '2026-08-04T08:00:00Z', behind: false },
      { number: 2, createdAt: '2026-08-04T09:00:00Z', behind: true },
    ]);
    expect(plan.next?.number).toBe(2);
    expect(plan.queued).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [
      { number: 2, createdAt: '2026-08-04T09:00:00Z', behind: true },
      { number: 1, createdAt: '2026-08-04T08:00:00Z', behind: true },
    ];
    const copy = input.map((c) => ({ ...c }));
    planSyncOrder(input);
    expect(input).toEqual(copy);
  });
});

describe('formatPlan', () => {
  it('says nothing to sync when there is no next candidate', () => {
    const text = formatPlan({ next: null, queued: [] }, 'development');
    expect(text).toContain('No open pull request is BEHIND development');
  });

  it('names exactly one PR to sync next and warns against firing multiple', () => {
    const text = formatPlan(
      {
        next: { number: 5, createdAt: '2026-08-04T09:00:00Z', behind: true },
        queued: [],
      },
      'development',
    );
    expect(text).toContain('Sync PR #5 next');
    expect(text).toContain('contention');
  });

  it('lists queued PRs as not-yet, distinct from the one to sync now', () => {
    const text = formatPlan(
      {
        next: { number: 5, createdAt: '2026-08-04T09:00:00Z', behind: true },
        queued: [
          { number: 6, createdAt: '2026-08-04T10:00:00Z', behind: true },
          { number: 7, createdAt: '2026-08-04T11:00:00Z', behind: true },
        ],
      },
      'development',
    );
    expect(text).toContain('do not sync these yet');
    expect(text).toContain('#6');
    expect(text).toContain('#7');
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
});
