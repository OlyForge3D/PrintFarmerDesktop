import { describe, expect, it, vi } from 'vitest';

import {
  EXIT_CLEAN,
  EXIT_FINDINGS,
  EXIT_UNDETERMINED,
  formatReport,
  main,
  maxRunAttempt,
  parseArgs,
  resolveHeadSha,
  verifyHeadStillCurrent,
} from '../scripts/check-run-attempt-visibility.mjs';
import type { WorkflowRun } from '../scripts/check-rerun-masked-failures.mjs';

// #340's own falsifier: PR #185's head must report attempt 3, PR #333's head
// must report 1. Confirmed live against the GitHub API before this file was
// written (see the script's header comment) and reproduced here so the
// discriminator stays pinned without a network call on every test run.
const HEAD_185 = '4e1510dde84e01e3921eb66abb31cb7f7080f9aa';
const HEAD_333 = '30f69f549659c115eec60c9e2c746418e5f9c258';

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  });
}

function runsPage(runs: WorkflowRun[]) {
  return jsonResponse({ total_count: runs.length, workflow_runs: runs });
}

describe('maxRunAttempt', () => {
  it('reports the highest attempt among the runs observed', () => {
    const runs: WorkflowRun[] = [
      { id: 1, run_attempt: 1, created_at: '2026-08-04T14:00:00Z' },
      { id: 2, run_attempt: 3, created_at: '2026-08-04T14:01:00Z' },
      { id: 3, run_attempt: 2, created_at: '2026-08-04T14:02:00Z' },
    ];
    expect(maxRunAttempt(runs)).toBe(3);
  });

  it('reports 1 for a head that was never re-run', () => {
    const runs: WorkflowRun[] = [
      { id: 10, run_attempt: 1, created_at: '2026-08-04T14:00:00Z' },
    ];
    expect(maxRunAttempt(runs)).toBe(1);
  });

  it('refuses an empty run list rather than guessing', () => {
    expect(() => maxRunAttempt([])).toThrow(/no workflow runs/);
  });

  it('refuses a run with no positive integer run_attempt', () => {
    const runs = [
      { id: 1, run_attempt: 0, created_at: '2026-08-04T14:00:00Z' },
    ];
    expect(() => maxRunAttempt(runs as WorkflowRun[])).toThrow(
      /no positive integer run_attempt/,
    );
  });
});

describe('#340 falsifier', () => {
  it('reports attempt 3 for PR #185 head (positive control: re-run occurred)', async () => {
    const fetchImpl = vi.fn(() =>
      runsPage([
        { id: 100, run_attempt: 1, created_at: '2026-01-01T00:00:00Z' },
        { id: 100, run_attempt: 2, created_at: '2026-01-01T00:05:00Z' },
        { id: 100, run_attempt: 3, created_at: '2026-01-01T00:10:00Z' },
      ]),
    );
    const exitCode = await main(
      ['--sha', HEAD_185, '--repo', 'OlyForge3D/PrintFarmerDesktop'],
      { GITHUB_TOKEN: 'test-token' },
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    expect(exitCode).toBe(EXIT_FINDINGS);
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain(`head_sha=${HEAD_185}`);
  });

  it('reports attempt 1 for PR #333 head (negative control: never re-run)', async () => {
    const fetchImpl = vi.fn(() =>
      runsPage([
        { id: 200, run_attempt: 1, created_at: '2026-01-02T00:00:00Z' },
      ]),
    );
    const exitCode = await main(
      ['--sha', HEAD_333, '--repo', 'OlyForge3D/PrintFarmerDesktop'],
      { GITHUB_TOKEN: 'test-token' },
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    expect(exitCode).toBe(EXIT_CLEAN);
  });
});

describe('error handling contract', () => {
  it('exits 2 (undetermined) rather than reporting clean when GitHub returns zero workflow runs', async () => {
    const fetchImpl = vi.fn(() => runsPage([]));
    const exitCode = await main(
      ['--sha', HEAD_185, '--repo', 'OlyForge3D/PrintFarmerDesktop'],
      { GITHUB_TOKEN: 'test-token' },
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    // A head with zero workflow runs is not a "no re-run" negative -- it is
    // an unreadable input (checks have not attached yet, or the SHA is
    // wrong). Reporting EXIT_CLEAN here would be indistinguishable from a
    // genuine attempt-1 pass, exactly the near-miss #340 disclosed against
    // its own survey ("a survey that cannot see the thing it is counting
    // reports absence"). It must not be silently folded into "no reruns".
    expect(exitCode).toBe(EXIT_UNDETERMINED);
    expect(exitCode).not.toBe(EXIT_CLEAN);
  });

  it('exits 2 (undetermined) when the GitHub API responds with an HTTP error, rather than reporting clean', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      }),
    );
    const exitCode = await main(
      ['--sha', HEAD_185, '--repo', 'OlyForge3D/PrintFarmerDesktop'],
      { GITHUB_TOKEN: 'test-token' },
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    // A failed API call must surface as undetermined, not as a silent
    // "attempt 1 / no re-run" result -- the same asymmetry #340 names: a
    // checker that reports clean when it could not actually look is worse
    // than no checker at all, because it converts an unknown into a false
    // assurance.
    expect(exitCode).toBe(EXIT_UNDETERMINED);
    expect(exitCode).not.toBe(EXIT_CLEAN);
  });

  it('exits 2 (undetermined) when the network request itself rejects', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.reject(new Error('network unreachable'));
    const exitCode = await main(
      ['--sha', HEAD_185, '--repo', 'OlyForge3D/PrintFarmerDesktop'],
      { GITHUB_TOKEN: 'test-token' },
      undefined,
      fetchImpl,
    );
    expect(exitCode).toBe(EXIT_UNDETERMINED);
    expect(exitCode).not.toBe(EXIT_CLEAN);
  });

  it('exits 2 (undetermined) resolving a --pr when the pulls API responds with an HTTP error', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({}),
      }),
    );
    const exitCode = await main(
      ['--pr', '185', '--repo', 'OlyForge3D/PrintFarmerDesktop'],
      { GITHUB_TOKEN: 'test-token' },
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    expect(exitCode).toBe(EXIT_UNDETERMINED);
    expect(exitCode).not.toBe(EXIT_CLEAN);
  });

  it('exits 2 (undetermined) end-to-end when a --pr head moves during the workflow-run scan (Hicks review, #694)', async () => {
    // Resolving --pr reads the PR head once, then the workflow-run scan runs
    // against that SHA. If a push lands mid-scan, the SHA the report was
    // scanned against is no longer the PR's current head -- reporting it as
    // "PR #185" would be exactly the false assurance #340 exists to
    // eliminate. Simulate this by having the pulls API return a different
    // head SHA on its second call (the post-scan recheck) than on its first.
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/pulls/')) {
        const isFirstPullsCall = !calls.includes('/pulls/');
        calls.push('/pulls/');
        return jsonResponse({
          number: 185,
          head: { sha: isFirstPullsCall ? HEAD_185 : HEAD_333 },
          base: { ref: 'development' },
        }) as unknown as ReturnType<typeof fetch>;
      }
      return runsPage([
        { id: 100, run_attempt: 1, created_at: '2026-01-01T00:00:00Z' },
      ]) as unknown as ReturnType<typeof fetch>;
    };
    const exitCode = await main(
      ['--pr', '185', '--repo', 'OlyForge3D/PrintFarmerDesktop'],
      { GITHUB_TOKEN: 'test-token' },
      undefined,
      fetchImpl,
    );
    expect(exitCode).toBe(EXIT_UNDETERMINED);
    expect(exitCode).not.toBe(EXIT_CLEAN);
    expect(exitCode).not.toBe(EXIT_FINDINGS);
  });
});

describe('formatReport', () => {
  it('warns a reviewer when the max attempt exceeds 1', () => {
    const runs: WorkflowRun[] = [
      { id: 1, run_attempt: 3, created_at: '2026-08-04T14:00:00Z' },
    ];
    const report = formatReport({
      headSha: HEAD_185,
      source: `--sha ${HEAD_185}`,
      runs,
      maxAttempt: 3,
    });
    expect(report).toContain('re-run');
    expect(report).toContain('green-on-some-attempt');
  });

  it('does not warn when the max attempt is 1', () => {
    const runs: WorkflowRun[] = [
      { id: 1, run_attempt: 1, created_at: '2026-08-04T14:00:00Z' },
    ];
    const report = formatReport({
      headSha: HEAD_333,
      source: `--sha ${HEAD_333}`,
      runs,
      maxAttempt: 1,
    });
    expect(report).toContain('no re-run occurred');
    expect(report).not.toContain('green-on-some-attempt');
  });
});

describe('resolveHeadSha', () => {
  it('uses --sha directly without any API call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await resolveHeadSha({
      args: { sha: HEAD_185 },
      repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
      token: 'test-token',
      fetchImpl,
    });
    expect(result.headSha).toBe(HEAD_185);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves --pr to its current head via the pulls API', async () => {
    const fetchImpl = vi.fn(() =>
      jsonResponse({
        number: 185,
        head: { sha: HEAD_185 },
        base: { ref: 'development' },
      }),
    );
    const result = await resolveHeadSha({
      args: { pr: 185 },
      repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
      token: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.headSha).toBe(HEAD_185);
    expect(result.source).toBe('PR #185');
  });
});

describe('verifyHeadStillCurrent', () => {
  it('is a no-op for --sha, since there is no PR head to move', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      verifyHeadStillCurrent({
        args: { sha: HEAD_185 },
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        token: 'test-token',
        fetchImpl,
        headSha: HEAD_185,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes silently when a --pr head has not moved', async () => {
    const fetchImpl = vi.fn(() =>
      jsonResponse({
        number: 185,
        head: { sha: HEAD_185 },
        base: { ref: 'development' },
      }),
    );
    await expect(
      verifyHeadStillCurrent({
        args: { pr: 185 },
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        token: 'test-token',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        headSha: HEAD_185,
      }),
    ).resolves.toBeUndefined();
  });

  it('throws when a --pr head moved since it was resolved (Hicks review, #694)', async () => {
    const fetchImpl = vi.fn(() =>
      jsonResponse({
        number: 185,
        head: { sha: HEAD_333 },
        base: { ref: 'development' },
      }),
    );
    await expect(
      verifyHeadStillCurrent({
        args: { pr: 185 },
        repository: { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' },
        token: 'test-token',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        headSha: HEAD_185,
      }),
    ).rejects.toThrow(/head moved/);
  });
});

describe('parseArgs', () => {
  it('accepts --sha with a full 40-hex SHA', () => {
    expect(parseArgs(['--sha', HEAD_185])).toEqual({ sha: HEAD_185 });
  });

  it('rejects a truncated SHA rather than silently normalising it', () => {
    expect(parseArgs(['--sha', '4e1510dd']).error).toMatch(/40-hex/);
  });

  it('rejects --sha and --pr together', () => {
    expect(parseArgs(['--sha', HEAD_185, '--pr', '185']).error).toMatch(
      /mutually exclusive/,
    );
  });

  it('requires --sha or --pr', async () => {
    const exitCode = await main([], { GITHUB_TOKEN: 'test-token' });
    expect(exitCode).toBe(EXIT_UNDETERMINED);
  });
});
