// @vitest-environment node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import {
  CLEANUP_FAILURE_ANCHOR,
  createCleanupEvidence,
} from '../scripts/npm-ci-strict.mjs';
import {
  MAXIMUM_EVIDENCE_ARTIFACT_BYTES,
  discoverCleanupEvidenceArtifacts,
  formatCleanupEvidenceComment,
  markArtifactDiscovery,
  publishCleanupEvidence,
  validateCleanupEvidence,
} from '../scripts/publish-npm-cleanup-evidence.mjs';
import {
  DISCHARGE_REF,
  MINIMUM_JUSTIFICATION_LENGTH,
  assertDischargeRef,
  dischargeCleanupFailure,
  validateDischargeRequest,
} from '../scripts/discharge-npm-cleanup-failure.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const sha = 'a'.repeat(40);
const evidence = createCleanupEvidence({
  output: String.raw`
npm warn cleanup Failed to remove some directories [
npm warn cleanup 'D:\repo\node_modules\parse-color'
npm warn cleanup [Error: EPERM: operation not permitted, rmdir 'D:\repo\node_modules\parse-color\node_modules\color-convert']
]`,
  recovery: {
    attempted: true,
    recovered: false,
    directories: ['parse-color'],
    reason: 'retry failed: EPERM still locked',
  },
  environment: {
    GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: sha,
    GITHUB_JOB: 'desktop',
    GITHUB_WORKFLOW: 'CI',
    GITHUB_SERVER_URL: 'https://github.com',
    RUNNER_OS: 'Windows',
  },
  recordedAt: '2026-08-04T14:00:00.000Z',
});

function response(
  payload: unknown,
  {
    ok = true,
    status = 200,
    statusText = 'OK',
    text,
  }: {
    ok?: boolean;
    status?: number;
    statusText?: string;
    text?: string;
  } = {},
): Response {
  return {
    ok,
    status,
    statusText,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(text ?? JSON.stringify(payload)),
  } as unknown as Response;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') {
    throw new TypeError('request body is not a string');
  }
  const parsed: unknown = JSON.parse(init.body);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('body' in parsed) ||
    typeof parsed.body !== 'string'
  ) {
    throw new TypeError('request JSON has no string body');
  }
  return parsed.body;
}

describe('durable cleanup evidence publication', () => {
  it('publishes the exact anchor and failed attempt reference', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        html_url:
          'https://github.com/OlyForge3D/PrintFarmerDesktop/issues/274#issuecomment-1',
      }),
    );

    const url = await publishCleanupEvidence({
      owner: 'OlyForge3D',
      repo: 'PrintFarmerDesktop',
      token: 'token',
      evidence,
      fetchImpl,
    });

    expect(url).toContain('issuecomment-1');
    const body = requestBody(
      fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined,
    );
    expect(body).toContain(CLEANUP_FAILURE_ANCHOR);
    expect(body).toContain('/actions/runs/12345/attempts/1');
    expect(body).toContain('Do not rerun');
  });

  it('rejects evidence carrying a neighbouring or constant-positive anchor', () => {
    expect(() =>
      validateCleanupEvidence({
        ...evidence,
        anchor: 'npm-ci-strict.mjs',
      }),
    ).toThrow(`anchor must be exactly "${CLEANUP_FAILURE_ANCHOR}"`);
  });

  it('fails publication explicitly when GitHub does not record the comment', async () => {
    await expect(
      publishCleanupEvidence({
        owner: 'OlyForge3D',
        repo: 'PrintFarmerDesktop',
        token: 'token',
        evidence,
        fetchImpl: vi
          .fn()
          .mockResolvedValue(
            response({}, { ok: false, status: 403, statusText: 'Forbidden' }),
          ),
      }),
    ).rejects.toThrow(
      'GitHub REST could not publish cleanup evidence: 403 Forbidden',
    );
  });

  it('formats a durable record even after the tracking issue closes', () => {
    const body = formatCleanupEvidenceComment(evidence);
    expect(body).toContain('npm-cleanup-failure run=12345 attempt=1');
    expect(body).toContain('issue #274');
  });

  it('derives links from validated identity and rejects injected runner metadata', () => {
    const body = formatCleanupEvidenceComment({
      ...evidence,
      runUrl: 'https://example.invalid/) injected',
    });
    expect(body).toContain(
      'https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/12345/attempts/1',
    );
    expect(body).not.toContain('example.invalid');
    expect(() =>
      validateCleanupEvidence({
        ...evidence,
        runnerName: 'runner\ninjected',
      }),
    ).toThrow('runnerName is not a bounded line');
  });
});

describe('justified cleanup discharge', () => {
  const run = {
    id: 12345,
    name: 'CI',
    run_attempt: 1,
    html_url:
      'https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/12345',
    head_sha: sha,
    status: 'completed',
    conclusion: 'failure',
  };
  const cleanupJob = {
    id: 7001,
    name: 'Desktop (windows-latest)',
    html_url:
      'https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/12345/job/7001',
    conclusion: 'failure',
    steps: [
      { name: 'Install dependencies', conclusion: 'failure' },
      { name: 'Test', conclusion: 'skipped' },
    ],
  };
  const request = {
    owner: 'OlyForge3D',
    repo: 'PrintFarmerDesktop',
    token: 'token',
    runId: '12345',
    headSha: sha,
    justification:
      'The exact cleanup anchor was diagnosed and evidence is durable.',
    actor: 'maintainer',
  };

  it('requires a substantive justification and the exact full SHA', () => {
    expect(() =>
      validateDischargeRequest({
        runId: '12345',
        headSha: sha,
        justification: 'x'.repeat(MINIMUM_JUSTIFICATION_LENGTH - 1),
      }),
    ).toThrow(`at least ${MINIMUM_JUSTIFICATION_LENGTH}`);
    expect(() =>
      validateDischargeRequest({
        runId: '12345',
        headSha: sha,
        justification: `x${' '.repeat(MINIMUM_JUSTIFICATION_LENGTH)}x`,
      }),
    ).toThrow(`at least ${MINIMUM_JUSTIFICATION_LENGTH}`);
    expect(() =>
      validateDischargeRequest({
        runId: '12345',
        headSha: 'abc123',
        justification: 'x'.repeat(MINIMUM_JUSTIFICATION_LENGTH),
      }),
    ).toThrow('full 40-character commit SHA');
    expect(
      validateDischargeRequest({
        runId: '12345',
        headSha: sha,
        justification: 'x'.repeat(MINIMUM_JUSTIFICATION_LENGTH),
      }).runId,
    ).toBe(12345);
  });

  it('refuses runs outside the workflows that publish cleanup evidence', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({ ...run, name: 'Unrelated privileged workflow' }),
      );

    await expect(
      dischargeCleanupFailure({ ...request, fetchImpl }),
    ).rejects.toThrow(
      'belongs to ineligible workflow Unrelated privileged workflow',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a run that has not completed with failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        response({ ...run, status: 'in_progress', conclusion: null }),
      );

    await expect(
      dischargeCleanupFailure({ ...request, fetchImpl }),
    ).rejects.toThrow(
      'workflow run 12345 must be completed with conclusion failure',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a run for a different head SHA', async () => {
    const differentSha = 'b'.repeat(40);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response({ ...run, head_sha: differentSha }));

    await expect(
      dischargeCleanupFailure({ ...request, fetchImpl }),
    ).rejects.toThrow(
      `workflow run 12345 head ${differentSha} does not match requested ${sha}`,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a run without a positive integer attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response({ ...run, run_attempt: 0 }));

    await expect(
      dischargeCleanupFailure({ ...request, fetchImpl }),
    ).rejects.toThrow('workflow run 12345 has no valid run_attempt');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('records authorization before rerunning verified cleanup failures', async () => {
    const operations: string[] = [];
    const fetchImpl = vi.fn((url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/actions/runs/12345')) {
        return Promise.resolve(response(run));
      }
      if (target.includes('/attempts/1/jobs')) {
        return Promise.resolve(
          response({
            total_count: 2,
            jobs: [
              cleanupJob,
              {
                id: 7002,
                name: 'Desktop (macos-latest)',
                conclusion: 'success',
                steps: [
                  { name: 'Install dependencies', conclusion: 'success' },
                ],
              },
            ],
          }),
        );
      }
      if (target.endsWith('/actions/jobs/7001/logs')) {
        return Promise.resolve(
          response({}, { text: `diagnostic: ${CLEANUP_FAILURE_ANCHOR}` }),
        );
      }
      if (target.endsWith('/issues/274/comments')) {
        operations.push('comment');
        expect(requestBody(init)).toContain(CLEANUP_FAILURE_ANCHOR);
        return Promise.resolve(
          response({
            html_url:
              'https://github.com/OlyForge3D/PrintFarmerDesktop/issues/274#issuecomment-2',
          }),
        );
      }
      if (target.endsWith('/rerun-failed-jobs')) {
        operations.push('rerun');
        return Promise.resolve(
          response({}, { status: 201, statusText: 'Created' }),
        );
      }
      throw new Error(`unexpected request: ${target}`);
    });

    const result = await dischargeCleanupFailure({
      ...request,
      fetchImpl,
    });

    expect(result.failedJobIds).toEqual([7001]);
    expect(operations).toEqual(['comment', 'rerun']);
  });

  it('refuses the entire discharge when any failed job lacks the anchor', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      await Promise.resolve();
      const target = String(url);
      if (target.endsWith('/actions/runs/12345')) return response(run);
      if (target.includes('/attempts/1/jobs')) {
        return response({
          total_count: 2,
          jobs: [
            cleanupJob,
            {
              id: 7003,
              name: 'Dependency advisories',
              conclusion: 'failure',
              steps: [{ name: 'Install dependencies', conclusion: 'failure' }],
            },
          ],
        });
      }
      if (target.endsWith('/actions/jobs/7001/logs')) {
        return response({}, { text: CLEANUP_FAILURE_ANCHOR });
      }
      if (target.endsWith('/actions/jobs/7003/logs')) {
        return response(
          {},
          { text: 'licence policy refused GPL-only dependency' },
        );
      }
      throw new Error(`write request must not occur: ${target}`);
    });

    await expect(
      dischargeCleanupFailure({ ...request, fetchImpl }),
    ).rejects.toThrow(
      'failed jobs lack the exact cleanup anchor: Dependency advisories (7003)',
    );
    expect(
      fetchImpl.mock.calls.some(([url]) =>
        String(url).endsWith('/rerun-failed-jobs'),
      ),
    ).toBe(false);
  });

  it('does not rerun when the durable authorization comment cannot be recorded', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      await Promise.resolve();
      const target = String(url);
      if (target.endsWith('/actions/runs/12345')) return response(run);
      if (target.includes('/attempts/1/jobs')) {
        return response({ total_count: 1, jobs: [cleanupJob] });
      }
      if (target.endsWith('/actions/jobs/7001/logs')) {
        return response({}, { text: CLEANUP_FAILURE_ANCHOR });
      }
      if (target.endsWith('/issues/274/comments')) {
        return response(
          {},
          { ok: false, status: 500, statusText: 'Server Error' },
        );
      }
      throw new Error(`rerun must not occur: ${target}`);
    });

    await expect(
      dischargeCleanupFailure({ ...request, fetchImpl }),
    ).rejects.toThrow('recording cleanup discharge failed: 500 Server Error');
    expect(
      fetchImpl.mock.calls.some(([url]) =>
        String(url).endsWith('/rerun-failed-jobs'),
      ),
    ).toBe(false);
  });

  it('rejects a downstream test failure even when its log quotes the anchor', async () => {
    const testFailureJob = {
      id: 7004,
      name: 'Desktop (windows-latest)',
      conclusion: 'failure',
      steps: [
        { name: 'Install dependencies', conclusion: 'success' },
        { name: 'Test', conclusion: 'failure' },
      ],
    };
    const fetchImpl = vi.fn(async (url: string | URL) => {
      await Promise.resolve();
      const target = String(url);
      if (target.endsWith('/actions/runs/12345')) return response(run);
      if (target.includes('/attempts/1/jobs')) {
        return response({ total_count: 1, jobs: [testFailureJob] });
      }
      throw new Error(`job log or write request must not occur: ${target}`);
    });

    await expect(
      dischargeCleanupFailure({ ...request, fetchImpl }),
    ).rejects.toThrow(
      'Desktop (windows-latest) did not fail at Install dependencies',
    );
    expect(
      fetchImpl.mock.calls.some(([url]) =>
        String(url).includes('/actions/jobs/'),
      ),
    ).toBe(false);
  });

  it('refuses to rerun when the run advances after authorization is recorded', async () => {
    let runReads = 0;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      await Promise.resolve();
      const target = String(url);
      if (target.endsWith('/actions/runs/12345')) {
        runReads += 1;
        return response(runReads < 3 ? run : { ...run, run_attempt: 2 });
      }
      if (target.includes('/attempts/1/jobs')) {
        return response({ total_count: 1, jobs: [cleanupJob] });
      }
      if (target.endsWith('/actions/jobs/7001/logs')) {
        return response({}, { text: CLEANUP_FAILURE_ANCHOR });
      }
      if (target.endsWith('/issues/274/comments')) {
        expect(init?.method).toBe('POST');
        return response({
          html_url:
            'https://github.com/OlyForge3D/PrintFarmerDesktop/issues/274#issuecomment-3',
        });
      }
      throw new Error(`rerun must not occur: ${target}`);
    });

    await expect(
      dischargeCleanupFailure({ ...request, fetchImpl }),
    ).rejects.toThrow(
      'advanced from attempt 1 to 2; refusing to rerun an unverified attempt',
    );
    expect(
      fetchImpl.mock.calls.some(([url]) =>
        String(url).endsWith('/rerun-failed-jobs'),
      ),
    ).toBe(false);
  });
});

describe('trusted artifact discovery', () => {
  it('finds only bounded, unexpired cleanup evidence artifacts', async () => {
    const artifacts = await discoverCleanupEvidenceArtifacts({
      owner: 'OlyForge3D',
      repo: 'PrintFarmerDesktop',
      token: 'token',
      runId: '12345',
      runAttempt: '2',
      fetchImpl: vi.fn().mockResolvedValue(
        response({
          total_count: 4,
          artifacts: [
            {
              id: 101,
              name: 'npm-cleanup-evidence-desktop-Windows-attempt-2',
              size_in_bytes: 4096,
              expired: false,
            },
            {
              id: 102,
              name: 'npm-cleanup-evidence-desktop-Windows-attempt-1',
              size_in_bytes: 4096,
              expired: false,
            },
            {
              id: 103,
              name: 'ordinary-build-output',
              size_in_bytes: 8192,
              expired: false,
            },
            {
              id: 104,
              name: 'npm-cleanup-evidence-expired',
              size_in_bytes: 4096,
              expired: true,
            },
          ],
        }),
      ),
    });

    expect(artifacts.map(({ name }) => name)).toEqual([
      'npm-cleanup-evidence-desktop-Windows-attempt-2',
    ]);
  });

  it('rejects an oversized untrusted evidence artifact before download', async () => {
    await expect(
      discoverCleanupEvidenceArtifacts({
        owner: 'OlyForge3D',
        repo: 'PrintFarmerDesktop',
        token: 'token',
        runId: '12345',
        runAttempt: '1',
        fetchImpl: vi.fn().mockResolvedValue(
          response({
            total_count: 1,
            artifacts: [
              {
                id: 101,
                name: 'npm-cleanup-evidence-hostile-attempt-1',
                size_in_bytes: MAXIMUM_EVIDENCE_ARTIFACT_BYTES + 1,
                expired: false,
              },
            ],
          }),
        ),
      }),
    ).rejects.toThrow('has invalid size');
  });

  it('passes only the discovered immutable artifact ids to the download step', async () => {
    const appendFileImpl = vi.fn().mockResolvedValue(undefined);
    await markArtifactDiscovery(
      [{ id: 101 }, { id: 205 }],
      { GITHUB_OUTPUT: 'github-output.txt' },
      appendFileImpl,
    );

    expect(appendFileImpl).toHaveBeenCalledWith(
      'github-output.txt',
      expect.stringContaining('cleanup_evidence_artifact_ids=101,205'),
      'utf8',
    );
  });
});

describe('workflow enforcement', () => {
  const workflowFiles = [
    'ci.yml',
    'release.yml',
    'release-gpu-qualification.yml',
  ];
  const workflows = workflowFiles.map((file) => ({
    file,
    contents: readFileSync(
      path.join(repositoryRoot, '.github', 'workflows', file),
      'utf8',
    ),
  }));
  const recoveryWorkflow = readFileSync(
    path.join(
      repositoryRoot,
      '.github',
      'workflows',
      'npm-cleanup-recovery.yml',
    ),
    'utf8',
  );
  const publicationWorkflow = readFileSync(
    path.join(
      repositoryRoot,
      '.github',
      'workflows',
      'publish-npm-cleanup-evidence.yml',
    ),
    'utf8',
  );

  it.each(workflows)(
    '$file uploads every strict cleanup failure through the step output',
    ({ contents }) => {
      const installs = contents.match(/run: node scripts\/npm-ci-strict\.mjs/g);
      const uploads = contents.match(
        /name: Upload npm cleanup failure evidence/g,
      );
      expect(installs?.length).toBeGreaterThan(0);
      expect(uploads?.length).toBe(installs?.length);
      expect(contents).toContain(
        "steps.npm_ci.outputs.cleanup_evidence == 'true'",
      );
      expect(contents).toContain('uses: actions/upload-artifact@v4');
      expect(contents).toContain('retention-days: 90');
    },
  );

  it('publishes fork-safe artifacts from reviewed development code', () => {
    expect(publicationWorkflow).toContain('workflow_run:');
    expect(publicationWorkflow).toContain(
      'workflows: [CI, Release (signed), Release GPU qualification]',
    );
    expect(publicationWorkflow).toContain('issues: write');
    expect(publicationWorkflow).toContain('ref: development');
    expect(publicationWorkflow).toContain(
      'node scripts/publish-npm-cleanup-evidence.mjs --discover',
    );
    expect(publicationWorkflow).toContain(
      'SOURCE_WORKFLOW: ${{ github.event.workflow_run.name }}',
    );
    expect(publicationWorkflow).toContain(
      "steps.discover.outputs.has_cleanup_evidence == 'true'",
    );
    expect(publicationWorkflow).toContain(
      'artifact-ids: ${{ steps.discover.outputs.cleanup_evidence_artifact_ids }}',
    );
    expect(publicationWorkflow).not.toContain(
      'pattern: npm-cleanup-evidence-*',
    );
  });

  it('exposes only a manual, justified recovery entry point', () => {
    expect(recoveryWorkflow).toContain('workflow_dispatch:');
    expect(recoveryWorkflow).toContain('justification:');
    expect(recoveryWorkflow).toContain('actions: write');
    expect(recoveryWorkflow).toContain(
      'node scripts/discharge-npm-cleanup-failure.mjs',
    );
    expect(recoveryWorkflow).not.toContain('npm ci');
  });

  // The previous test here read this script as TEXT and asserted it contained
  // `GITHUB_REF !== 'refs/heads/development'`. That assertion goes red if the
  // guard is DELETED and stays green if it is DISABLED: `if (false && …)`
  // preserves the substring, removes the control, and leaves the whole suite
  // passing. Deletion is the failure mode review catches; disablement is the
  // one it does not.
  //
  // These replace it rather than joining it, and they strictly dominate it —
  // each goes red on deletion AND on disablement, because each runs the guard
  // instead of reading it.
  it('refuses to run from any ref but development', () => {
    expect(() =>
      assertDischargeRef({ GITHUB_REF: 'refs/heads/anything-else' }),
    ).toThrow(/must run from refs\/heads\/development/);
    expect(() => assertDischargeRef({})).toThrow(
      /must run from refs\/heads\/development/,
    );
    expect(() =>
      assertDischargeRef({ GITHUB_REF: DISCHARGE_REF }),
    ).not.toThrow();
  });

  // The unit test above binds the exported function. It cannot see whether
  // `main` still CALLS it, which is exactly the gap that let the source-text
  // assertion pass: the defect was never in the predicate, it was in whether
  // the entry point reaches it. So these two spawn the real script.
  //
  // Both arms are hermetic. The wrong-ref arm exits before any credential is
  // read, and the development arm is given no token, so it stops at the token
  // check — one line later, and still before any network call.
  const runDischarge = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [
        path.join(
          repositoryRoot,
          'scripts',
          'discharge-npm-cleanup-failure.mjs',
        ),
      ],
      {
        encoding: 'utf8',
        cwd: repositoryRoot,
        env: { PATH: process.env.PATH ?? '', ...env },
      },
    );

  it('exits non-zero from the wrong ref, naming the ref and not the token', () => {
    // GITHUB_TOKEN is deliberately absent AND the ref is wrong, so the two
    // failures race. Which message wins is the ordering assertion: the ref must
    // be refused before anything reads a credential. Under `if (false && …)`
    // this arm reports 'GITHUB_TOKEN is not set' and fails here.
    const result = runDischarge({ GITHUB_REF: 'refs/heads/attacker-branch' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must run from refs/heads/development');
    expect(result.stderr).not.toContain('GITHUB_TOKEN');
  });

  it('gets past the ref check on development, proving the refusal is the ref', () => {
    // The negative control for the test above. Without this, an arm asserting
    // "wrong ref is refused" would still pass if the script refused every ref
    // for some unrelated reason. Stopping at the NEXT check is what shows the
    // guard admitted this ref.
    const result = runDischarge({ GITHUB_REF: DISCHARGE_REF });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('GITHUB_TOKEN is not set');
    expect(result.stderr).not.toContain('must run from');
  });
});
