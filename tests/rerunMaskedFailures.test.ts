import { describe, expect, it, vi } from 'vitest';

import {
  formatReport,
  listAttemptJobs,
  listWorkflowRuns,
  maskedRequiredFailures,
  parsePullSnapshot,
  scanHead,
  scanPullRequest,
} from '../scripts/check-rerun-masked-failures.mjs';
import type {
  AttemptJob,
  WorkflowRun,
} from '../scripts/check-rerun-masked-failures.mjs';

const HEAD = 'b89390fd370b1cb268bc25f234b1be6611007ac8';
const OTHER_HEAD = '0123456789abcdef0123456789abcdef01234567';
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
});

describe('stable current-head orchestration', () => {
  function apiFixture({
    finalHead = HEAD,
    finalAttempt = 2,
    onRequest = () => {},
  }: {
    finalHead?: string;
    finalAttempt?: number;
    onRequest?: (url: string) => void;
  } = {}) {
    let pullReads = 0;
    let runReads = 0;
    return vi.fn<typeof fetch>((input) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === 'string'
            ? input
            : input.url;
      onRequest(url);
      if (/\/pulls\/272$/.test(url)) {
        pullReads += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              number: 272,
              head: { sha: pullReads === 1 ? HEAD : finalHead },
              base: { ref: 'development' },
            }),
          ),
        );
      }
      if (/\/branches\/development\/protection$/.test(url)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              required_status_checks: {
                contexts: REQUIRED,
                strict: true,
              },
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

  it('reads the final PR head after the dependent run and protection reads', async () => {
    const requests: string[] = [];
    await scanPullRequest({
      repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
      prNumber: 272,
      token: 't',
      fetchImpl: apiFixture({
        onRequest: (url) => requests.push(url),
      }),
    });

    expect(requests.at(-1)).toMatch(/\/pulls\/272$/);
    expect(
      requests.slice(-3, -1).some((url) => /\/actions\/runs\?/.test(url)),
    ).toBe(true);
    expect(
      requests
        .slice(-3, -1)
        .some((url) => /\/branches\/development\/protection$/.test(url)),
    ).toBe(true);
  });

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

  it('discards a scan when a workflow advances another attempt', async () => {
    await expect(
      scanPullRequest({
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        prNumber: 272,
        token: 't',
        fetchImpl: apiFixture({ finalAttempt: 3 }),
      }),
    ).rejects.toThrow(/attempts or required contexts changed/);
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
