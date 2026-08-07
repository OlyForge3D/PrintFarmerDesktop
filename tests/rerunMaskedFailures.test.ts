import { describe, expect, it, vi } from 'vitest';

import {
  formatReport,
  githubActionsAppIds,
  listAttemptJobs,
  listHeadCheckRuns,
  listWorkflowRuns,
  maskedRequiredFailures,
  parsePullSnapshot,
  requiredActionContexts,
  scanHead,
  scanPullRequest,
} from '../scripts/check-rerun-masked-failures.mjs';
import type {
  AttemptJob,
  WorkflowRun,
} from '../scripts/check-rerun-masked-failures.mjs';

const HEAD = 'b89390fd370b1cb268bc25f234b1be6611007ac8';
const OTHER_HEAD = '0123456789abcdef0123456789abcdef01234567';
const ACTIONS_APP_ID = 15368;
const REQUIRED = [
  'Desktop (windows-latest)',
  'Release package (windows-latest)',
];
const DESKTOP_WINDOWS = 'Desktop (windows-latest)';
const RELEASE_WINDOWS = 'Release package (windows-latest)';
const RUN: WorkflowRun = {
  id: 30917030009,
  name: 'CI',
  run_attempt: 2,
  created_at: '2026-08-04T14:04:20Z',
};

function harness(
  runs: WorkflowRun[],
  jobsByAttempt: Record<number, AttemptJob[]>,
) {
  const calls: string[] = [];
  return {
    calls,
    listRuns: (sha: string) => {
      calls.push(`runs:${sha}`);
      return Promise.resolve(runs);
    },
    listJobs: (runId: number, attempt: number) => {
      calls.push(`jobs:${runId}:${attempt}`);
      return Promise.resolve(jobsByAttempt[attempt] ?? []);
    },
  };
}

describe('required-name discrimination', () => {
  it('includes only requirements attributable to GitHub Actions', () => {
    const protection = {
      checks: [
        { context: 'Same name', appId: 99 },
        { context: DESKTOP_WINDOWS, appId: ACTIONS_APP_ID },
        { context: 'Legacy context', appId: null },
      ],
    };

    expect(requiredActionContexts(protection, [ACTIONS_APP_ID])).toEqual([
      DESKTOP_WINDOWS,
      'Legacy context',
    ]);
    expect(
      githubActionsAppIds([
        { app: { id: 99, slug: 'other-app' } },
        { app: { id: ACTIONS_APP_ID, slug: 'github-actions' } },
      ]),
    ).toEqual([ACTIONS_APP_ID]);
  });

  it('reports the measured required failure from PR #272', async () => {
    const h = harness([RUN], {
      1: [
        {
          name: 'Release package (windows-latest)',
          conclusion: 'failure',
        },
      ],
    });
    const result = await scanHead({
      headSha: HEAD,
      requiredContexts: REQUIRED,
      listRuns: h.listRuns,
      listJobs: h.listJobs,
    });

    expect(result.findings).toEqual([
      {
        runId: 30917030009,
        runName: 'CI',
        attempt: 1,
        currentAttempt: 2,
        context: 'Release package (windows-latest)',
        conclusion: 'failure',
      },
    ]);
    expect(h.calls).toEqual([`runs:${HEAD}`, 'jobs:30917030009:1']);
  });

  it('stays clean for the same failed job when only its name is non-required', async () => {
    const h = harness([RUN], {
      1: [{ name: 'Sequencing hold', conclusion: 'failure' }],
    });
    const result = await scanHead({
      headSha: HEAD,
      requiredContexts: REQUIRED,
      listRuns: h.listRuns,
      listJobs: h.listJobs,
    });

    expect(result.findings).toEqual([]);
    expect(h.calls).toEqual([`runs:${HEAD}`, 'jobs:30917030009:1']);
  });

  it('does not report successful, skipped, or neutral jobs', () => {
    expect(
      maskedRequiredFailures(
        ['success', 'skipped', 'neutral'].map((conclusion) => ({
          name: DESKTOP_WINDOWS,
          conclusion,
        })),
        REQUIRED,
      ),
    ).toEqual([]);
  });

  it.each([
    { name: DESKTOP_WINDOWS, conclusion: null },
    { name: DESKTOP_WINDOWS },
    { conclusion: 'failure' },
    { name: '', conclusion: 'failure' },
    { name: 'Sequencing hold', conclusion: 'bogus' },
  ])('refuses malformed or unfinished historical job row %#', (job) => {
    expect(() => maskedRequiredFailures([job], REQUIRED)).toThrow(
      /no non-empty name or recognized terminal conclusion/,
    );
  });

  it('refuses an empty required set rather than returning a vacuous clean', () => {
    expect(() =>
      maskedRequiredFailures(
        [{ name: DESKTOP_WINDOWS, conclusion: 'failure' }],
        [],
      ),
    ).toThrow(/non-empty set/);
  });
});

describe('attempt and scope coverage', () => {
  it('walks every superseded attempt', async () => {
    const h = harness([{ ...RUN, run_attempt: 4 }], {
      1: [{ name: DESKTOP_WINDOWS, conclusion: 'failure' }],
      2: [{ name: RELEASE_WINDOWS, conclusion: 'timed_out' }],
      3: [{ name: DESKTOP_WINDOWS, conclusion: 'success' }],
    });
    const result = await scanHead({
      headSha: HEAD,
      requiredContexts: REQUIRED,
      listRuns: h.listRuns,
      listJobs: h.listJobs,
    });

    expect(h.calls).toEqual([
      `runs:${HEAD}`,
      'jobs:30917030009:1',
      'jobs:30917030009:2',
      'jobs:30917030009:3',
    ]);
    expect(result.findings.map((finding) => finding.conclusion)).toEqual([
      'failure',
      'timed_out',
    ]);
  });

  it('prints the exact run window and examined attempts on a clean rerun', async () => {
    const h = harness(
      [
        RUN,
        {
          id: 2,
          name: 'PR closure scope',
          run_attempt: 1,
          created_at: '2026-08-04T14:18:21Z',
        },
      ],
      { 1: [{ name: DESKTOP_WINDOWS, conclusion: 'success' }] },
    );
    const result = await scanHead({
      headSha: HEAD,
      requiredContexts: REQUIRED,
      listRuns: h.listRuns,
      listJobs: h.listJobs,
    });
    const report = formatReport({
      ...result,
      pull: { number: 272, headSha: HEAD, baseRef: 'development' },
    });

    expect(report).toContain('2026-08-04T14:04:20Z .. 2026-08-04T14:18:21Z');
    expect(report).toContain('attempt 2 is current; examined 1');
    expect(report).toContain('No required context failed');
    expect(report).toContain('ADVISORY');
  });

  it('distinguishes no reruns from examined clean reruns', async () => {
    const h = harness([{ ...RUN, run_attempt: 1 }], {});
    const result = await scanHead({
      headSha: HEAD,
      requiredContexts: REQUIRED,
      listRuns: h.listRuns,
      listJobs: h.listJobs,
    });
    const report = formatReport({
      ...result,
      pull: { number: 272, headSha: HEAD, baseRef: 'development' },
    });

    expect(report).toContain('none (no run was re-run)');
    expect(report).not.toContain('examined 1');
  });

  it('refuses an empty superseded attempt rather than reporting a vacuous clean', async () => {
    const h = harness([RUN], { 1: [] });
    await expect(
      scanHead({
        headSha: HEAD,
        requiredContexts: REQUIRED,
        listRuns: h.listRuns,
        listJobs: h.listJobs,
      }),
    ).rejects.toThrow(/returned zero jobs/);
  });

  it('refuses zero runs rather than turning an unobserved head green', async () => {
    const h = harness([], {});
    await expect(
      scanHead({
        headSha: HEAD,
        requiredContexts: REQUIRED,
        listRuns: h.listRuns,
        listJobs: h.listJobs,
      }),
    ).rejects.toThrow(/zero workflow runs/);
  });

  it('refuses a SHA prefix', async () => {
    const h = harness([RUN], {});
    await expect(
      scanHead({
        headSha: HEAD.slice(0, 7),
        requiredContexts: REQUIRED,
        listRuns: h.listRuns,
        listJobs: h.listJobs,
      }),
    ).rejects.toThrow(/full value returned by the pull request API/);
  });
});

describe('API pagination', () => {
  function urlOf(input: URL | RequestInfo) {
    if (input instanceof URL) return input.href;
    return typeof input === 'string' ? input : input.url;
  }

  function response(body: unknown) {
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve(body),
    }) as Promise<Response>;
  }

  it('paginates workflow runs to total_count', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      ...RUN,
      id: index + 1,
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() =>
        response({ total_count: 101, workflow_runs: first }),
      )
      .mockImplementationOnce(() =>
        response({ total_count: 101, workflow_runs: [{ ...RUN, id: 101 }] }),
      );

    const runs = await listWorkflowRuns({
      repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
      headSha: HEAD,
      token: 't',
      fetchImpl,
    });

    expect(runs).toHaveLength(101);
    expect(urlOf(fetchImpl.mock.calls[1]![0])).toContain('&page=2');
  });

  it("refuses GitHub's filtered workflow-run ceiling as potentially truncated", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(() =>
      response({
        total_count: 1000,
        workflow_runs: Array.from({ length: 100 }, (_, index) => ({
          ...RUN,
          id: index + 1,
        })),
      }),
    );

    await expect(
      listWorkflowRuns({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        headSha: HEAD,
        token: 't',
        fetchImpl,
      }),
    ).rejects.toThrow(/1000-result filtered-search ceiling/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('paginates jobs to total_count', async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      name: `job-${index}`,
      conclusion: 'success',
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => response({ total_count: 101, jobs: first }))
      .mockImplementationOnce(() =>
        response({
          total_count: 101,
          jobs: [{ name: 'last', conclusion: 'failure' }],
        }),
      );

    const jobs = await listAttemptJobs({
      repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
      runId: 1,
      attempt: 1,
      token: 't',
      fetchImpl,
    });

    expect(jobs).toHaveLength(101);
    expect(urlOf(fetchImpl.mock.calls[1]![0])).toContain('&page=2');
  });

  it('paginates head check runs to total_count', async () => {
    const first = Array.from({ length: 100 }, () => ({
      app: { id: ACTIONS_APP_ID, slug: 'github-actions' },
    }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() =>
        response({ total_count: 101, check_runs: first }),
      )
      .mockImplementationOnce(() =>
        response({
          total_count: 101,
          check_runs: [{ app: { id: ACTIONS_APP_ID, slug: 'github-actions' } }],
        }),
      );

    const checks = await listHeadCheckRuns({
      repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
      headSha: HEAD,
      token: 't',
      fetchImpl,
    });

    expect(checks).toHaveLength(101);
    expect(urlOf(fetchImpl.mock.calls[1]![0])).toContain('&page=2');
  });
});

describe('stable current-head orchestration', () => {
  function apiFixture({
    finalHead = HEAD,
    finalBase = 'development',
    finalAttempt = 2,
    finalRequired = REQUIRED,
    finalProtectionAppId = ACTIONS_APP_ID,
    finalCheckAppId = ACTIONS_APP_ID,
  }: {
    finalHead?: string;
    finalBase?: string;
    finalAttempt?: number;
    finalRequired?: string[];
    finalProtectionAppId?: number;
    finalCheckAppId?: number;
  } = {}) {
    let pullReads = 0;
    let protectionReads = 0;
    let runReads = 0;
    let checkReads = 0;
    return vi.fn<typeof fetch>((input) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === 'string'
            ? input
            : input.url;
      if (/\/pulls\/272$/.test(url)) {
        pullReads += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              number: 272,
              head: { sha: pullReads === 1 ? HEAD : finalHead },
              base: {
                ref: pullReads === 1 ? 'development' : finalBase,
              },
            }),
          ),
        );
      }
      if (/\/branches\/development\/protection$/.test(url)) {
        protectionReads += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              required_status_checks: {
                contexts: protectionReads === 1 ? REQUIRED : finalRequired,
                checks: (protectionReads === 1 ? REQUIRED : finalRequired).map(
                  (context) => ({
                    context,
                    app_id:
                      protectionReads === 1
                        ? ACTIONS_APP_ID
                        : finalProtectionAppId,
                  }),
                ),
                strict: true,
              },
            }),
          ),
        );
      }
      if (/\/commits\/[^/]+\/check-runs\?/.test(url)) {
        checkReads += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              total_count: 1,
              check_runs: [
                {
                  app: {
                    id: checkReads === 1 ? ACTIONS_APP_ID : finalCheckAppId,
                    slug: 'github-actions',
                  },
                },
              ],
            }),
          ),
        );
      }
      if (/\/actions\/runs\?/.test(url)) {
        runReads += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              total_count: 1,
              workflow_runs: [
                {
                  ...RUN,
                  run_attempt: runReads === 1 ? 2 : finalAttempt,
                },
              ],
            }),
          ),
        );
      }
      if (/\/attempts\/1\/jobs\?/.test(url)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              total_count: 1,
              jobs: [
                {
                  name: 'Release package (windows-latest)',
                  conclusion: 'failure',
                },
              ],
            }),
          ),
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });
  }

  it('takes the full head from the PR API and reproduces the live finding', async () => {
    const result = await scanPullRequest({
      repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
      prNumber: 272,
      token: 't',
      fetchImpl: apiFixture(),
    });

    expect(result.pull.headSha).toBe(HEAD);
    expect(result.findings[0]?.context).toBe(
      'Release package (windows-latest)',
    );
  });

  it.each(['runs', 'protection', 'checks'] as const)(
    'does not start the final PR-head read while %s remains unresolved',
    async (lastToResolve) => {
      let pullReads = 0;
      let runReads = 0;
      let protectionReads = 0;
      let checkReads = 0;
      let resolveFinalRuns!: (response: Response) => void;
      let resolveFinalProtection!: (response: Response) => void;
      let resolveFinalChecks!: (response: Response) => void;
      const finalRuns = new Promise<Response>((resolve) => {
        resolveFinalRuns = resolve;
      });
      const finalProtection = new Promise<Response>((resolve) => {
        resolveFinalProtection = resolve;
      });
      const finalChecks = new Promise<Response>((resolve) => {
        resolveFinalChecks = resolve;
      });
      const response = (body: unknown) =>
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
        });
      const fetchImpl = vi.fn<typeof fetch>((input) => {
        const url =
          input instanceof URL
            ? input.href
            : typeof input === 'string'
              ? input
              : input.url;
        if (/\/pulls\/272$/.test(url)) {
          pullReads += 1;
          return Promise.resolve(
            response({
              number: 272,
              head: { sha: HEAD },
              base: { ref: 'development' },
            }),
          );
        }
        if (/\/branches\/development\/protection$/.test(url)) {
          protectionReads += 1;
          if (protectionReads === 2) return finalProtection;
          return Promise.resolve(
            response({
              required_status_checks: {
                contexts: REQUIRED,
                checks: REQUIRED.map((context) => ({
                  context,
                  app_id: ACTIONS_APP_ID,
                })),
                strict: true,
              },
            }),
          );
        }
        if (/\/commits\/[^/]+\/check-runs\?/.test(url)) {
          checkReads += 1;
          if (checkReads === 2) return finalChecks;
          return Promise.resolve(
            response({
              total_count: 1,
              check_runs: [
                {
                  app: {
                    id: ACTIONS_APP_ID,
                    slug: 'github-actions',
                  },
                },
              ],
            }),
          );
        }
        if (/\/actions\/runs\?/.test(url)) {
          runReads += 1;
          if (runReads === 2) return finalRuns;
          return Promise.resolve(
            response({ total_count: 1, workflow_runs: [RUN] }),
          );
        }
        if (/\/attempts\/1\/jobs\?/.test(url)) {
          return Promise.resolve(
            response({
              total_count: 1,
              jobs: [{ name: DESKTOP_WINDOWS, conclusion: 'success' }],
            }),
          );
        }
        throw new Error(`unexpected URL ${url}`);
      });

      const pendingScan = scanPullRequest({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        prNumber: 272,
        token: 't',
        fetchImpl,
      });

      await vi.waitFor(() => {
        expect(runReads).toBe(2);
        expect(protectionReads).toBe(2);
        expect(checkReads).toBe(2);
      });
      expect(pullReads).toBe(1);

      const runsResponse = response({
        total_count: 1,
        workflow_runs: [RUN],
      });
      const protectionResponse = response({
        required_status_checks: {
          contexts: REQUIRED,
          checks: REQUIRED.map((context) => ({
            context,
            app_id: ACTIONS_APP_ID,
          })),
          strict: true,
        },
      });
      const checksResponse = response({
        total_count: 1,
        check_runs: [
          {
            app: { id: ACTIONS_APP_ID, slug: 'github-actions' },
          },
        ],
      });
      if (lastToResolve !== 'runs') {
        resolveFinalRuns(runsResponse);
      }
      if (lastToResolve !== 'protection') {
        resolveFinalProtection(protectionResponse);
      }
      if (lastToResolve !== 'checks') {
        resolveFinalChecks(checksResponse);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(pullReads).toBe(1);

      if (lastToResolve === 'runs') {
        resolveFinalRuns(runsResponse);
      } else if (lastToResolve === 'protection') {
        resolveFinalProtection(protectionResponse);
      } else {
        resolveFinalChecks(checksResponse);
      }
      await pendingScan;

      expect(pullReads).toBe(2);
    },
  );

  it('discards a scan when the PR head moves', async () => {
    await expect(
      scanPullRequest({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        prNumber: 272,
        token: 't',
        fetchImpl: apiFixture({ finalHead: OTHER_HEAD }),
      }),
    ).rejects.toThrow(/head or base moved/);
  });

  it('discards a scan when the PR base branch moves', async () => {
    await expect(
      scanPullRequest({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        prNumber: 272,
        token: 't',
        fetchImpl: apiFixture({ finalBase: 'release' }),
      }),
    ).rejects.toThrow(/head or base moved/);
  });

  it('discards a scan when a workflow advances another attempt', async () => {
    await expect(
      scanPullRequest({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        prNumber: 272,
        token: 't',
        fetchImpl: apiFixture({ finalAttempt: 3 }),
      }),
    ).rejects.toThrow(
      /attempts, required checks, or check-run app identities changed/,
    );
  });

  it('discards a scan when required contexts change', async () => {
    await expect(
      scanPullRequest({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        prNumber: 272,
        token: 't',
        fetchImpl: apiFixture({
          finalRequired: [...REQUIRED, 'New required context'],
        }),
      }),
    ).rejects.toThrow(
      /attempts, required checks, or check-run app identities changed/,
    );
  });

  it('discards a scan when a required context is rebound to another app', async () => {
    await expect(
      scanPullRequest({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        prNumber: 272,
        token: 't',
        fetchImpl: apiFixture({ finalProtectionAppId: 99 }),
      }),
    ).rejects.toThrow(
      /attempts, required checks, or check-run app identities changed/,
    );
  });

  it('discards a scan when the observed GitHub Actions app identity changes', async () => {
    await expect(
      scanPullRequest({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        prNumber: 272,
        token: 't',
        fetchImpl: apiFixture({ finalCheckAppId: 99 }),
      }),
    ).rejects.toThrow(
      /attempts, required checks, or check-run app identities changed/,
    );
  });
});

describe('pull snapshot validation', () => {
  it('requires a full API-provided head', () => {
    expect(() =>
      parsePullSnapshot(
        {
          number: 272,
          head: { sha: HEAD.slice(0, 7) },
          base: { ref: 'development' },
        },
        272,
      ),
    ).toThrow(/no full head SHA/);
  });
});
