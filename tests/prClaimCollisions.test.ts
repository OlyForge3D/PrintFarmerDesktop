import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  collectBranchIssueCandidates,
  evaluateClaimCollisions,
  formatCollisionWarnings,
  main,
  parseBranchIssueCandidates,
  parseBranchIssueTypes,
  parseOpenPullRequestPages,
  readOpenPullRequests,
  readSettledOpenPullRequests,
  resolveBranchIssueNumbers,
  runGitHub,
} from '../scripts/check-pr-claim-collisions.mjs';

interface FixturePr {
  number: number;
  title?: string;
  url?: string;
  headRefName: string;
  closingIssueNumbers: number[];
}

const REPOSITORY = 'OlyForge3D/PrintFarmerDesktop';

function pr(input: FixturePr) {
  const { closingIssueNumbers, ...rest } = input;
  return {
    title: `PR ${input.number}`,
    url: `https://github.test/pull/${input.number}`,
    ...rest,
    closingIssues: closingIssueNumbers.map((number) => ({
      number,
      repository: REPOSITORY,
    })),
  };
}

function page(
  nodes: ReturnType<typeof pr>[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      repository: {
        pullRequests: {
          nodes: nodes.map((node) => ({
            number: node.number,
            title: node.title,
            url: node.url,
            headRefName: node.headRefName,
            closingIssuesReferences: {
              nodes: node.closingIssues.map((issue) => ({
                number: issue.number,
                repository: { nameWithOwner: issue.repository },
              })),
              pageInfo: { hasNextPage: false },
            },
          })),
          pageInfo: { hasNextPage, endCursor },
        },
      },
    },
  };
}

describe('historical collision fixtures', () => {
  it('detects #432/#444 through their shared GitHub closing reference', () => {
    const result = evaluateClaimCollisions(
      [
        pr({
          number: 432,
          headRefName: 'squad/cancel-rejection-logging',
          closingIssueNumbers: [314],
        }),
        pr({
          number: 444,
          headRefName: 'dev/jpapiez/alternate-cancel-rejection',
          closingIssueNumbers: [314],
        }),
      ],
      [],
      REPOSITORY,
    );

    expect(result.collisions).toEqual([
      {
        repository: REPOSITORY,
        issueNumber: 314,
        pullRequests: [
          expect.objectContaining({
            number: 432,
            sources: ['closingIssuesReferences'],
          }),
          expect.objectContaining({
            number: 444,
            sources: ['closingIssuesReferences'],
          }),
        ],
      },
    ]);
  });

  it('detects #495/#498 when only one PR declares the issue but both branches carry it', () => {
    const result = evaluateClaimCollisions(
      [
        pr({
          number: 495,
          headRefName: 'dev/jpapiez/hicks-481-citation-corpus-floor',
          closingIssueNumbers: [],
        }),
        pr({
          number: 498,
          headRefName: 'squad/481-citation-corpus-floor',
          closingIssueNumbers: [481],
        }),
      ],
      [481],
      REPOSITORY,
    );

    expect(result.collisions).toEqual([
      {
        repository: REPOSITORY,
        issueNumber: 481,
        pullRequests: [
          expect.objectContaining({ number: 495, sources: ['branch'] }),
          expect.objectContaining({
            number: 498,
            sources: ['branch', 'closingIssuesReferences'],
          }),
        ],
      },
    ]);
  });
});

describe('branch issue candidates', () => {
  it('reads isolated issue-number segments in the branch shapes used by the repository', () => {
    expect(
      parseBranchIssueCandidates('dev/jpapiez/hicks-481-citation-corpus-floor'),
    ).toEqual([481]);
    expect(
      parseBranchIssueCandidates('jpapiez-review-head-coverage-280'),
    ).toEqual([280]);
    expect(parseBranchIssueCandidates('squad/438-sha-status')).toEqual([438]);
  });

  it('does not turn ISO date fragments, semantic versions, or hashes into candidates', () => {
    expect(
      parseBranchIssueCandidates('experiment-2026-08-07-v1.2.3-deadbeef123'),
    ).toEqual([]);
  });

  it('unions and sorts candidates across the population', () => {
    expect(
      collectBranchIssueCandidates([
        pr({
          number: 1,
          headRefName: 'squad/481-a',
          closingIssueNumbers: [],
        }),
        pr({
          number: 2,
          headRefName: 'dev/hicks-314-b-481',
          closingIssueNumbers: [],
        }),
      ]),
    ).toEqual([314, 481]);
  });

  it('accepts only forge objects whose typename is Issue', () => {
    expect(
      parseBranchIssueTypes(
        JSON.stringify({
          data: {
            repository: {
              n481: { __typename: 'Issue' },
              n495: { __typename: 'PullRequest' },
              n9999: null,
            },
          },
          errors: [
            {
              type: 'NOT_FOUND',
              path: ['repository', 'n9999'],
              message: 'Could not resolve to an Issue or PullRequest',
            },
          ],
        }),
        [481, 495, 9999],
      ),
    ).toEqual([481]);
  });

  it('rejects a partial type-resolution response instead of treating omissions as nonexistent', () => {
    expect(() =>
      parseBranchIssueTypes(
        JSON.stringify({
          data: { repository: { n481: { __typename: 'Issue' } } },
        }),
        [481, 9999],
      ),
    ).toThrow(/omitted candidate #9999/);
  });

  it('rejects a null alias without its matching NOT_FOUND error', () => {
    expect(() =>
      parseBranchIssueTypes(
        JSON.stringify({
          data: { repository: { n9999: null } },
        }),
        [9999],
      ),
    ).toThrow(/unexplained null/);
  });

  it('rejects GraphQL errors that are not an expected alias-specific NOT_FOUND', () => {
    expect(() =>
      parseBranchIssueTypes(
        JSON.stringify({
          data: { repository: { n481: { __typename: 'Issue' } } },
          errors: [
            {
              type: 'FORBIDDEN',
              path: ['repository', 'n481'],
              message: 'Resource not accessible',
            },
          ],
        }),
        [481],
      ),
    ).toThrow(/unexpected error/);
  });

  it('does not let a branch PR number or nonexistent number create a collision', () => {
    const result = evaluateClaimCollisions(
      [
        pr({
          number: 600,
          headRefName: 'replace-pr-495-for-9999',
          closingIssueNumbers: [],
        }),
        pr({
          number: 601,
          headRefName: 'another-495-and-9999',
          closingIssueNumbers: [],
        }),
      ],
      [],
      REPOSITORY,
    );
    expect(result.claimedIssueCount).toBe(0);
    expect(result.collisions).toEqual([]);
  });

  it('preserves partial GraphQL stdout when gh exits nonzero for NOT_FOUND aliases', () => {
    const response = JSON.stringify({
      data: { repository: { n9999: null } },
      errors: [
        {
          type: 'NOT_FOUND',
          path: ['repository', 'n9999'],
          message: 'Could not resolve',
        },
      ],
    });
    const execute = vi.fn(() => {
      throw Object.assign(new Error('gh exited 1'), { stdout: response });
    });
    expect(runGitHub(['api', 'graphql'], execute)).toBe(response);
  });

  it('does not reinterpret an ordinary gh failure as a GraphQL response', () => {
    const failure = Object.assign(new Error('gh exited 1'), { stdout: '' });
    expect(() =>
      runGitHub(['pr', 'list'], () => {
        throw failure;
      }),
    ).toThrow(failure);
  });
});

describe('open pull request pagination', () => {
  it('reads every page and requests GraphQL pagination explicitly', () => {
    const raw = JSON.stringify([
      page(
        [
          pr({
            number: 10,
            headRefName: 'squad/100-a',
            closingIssueNumbers: [100],
          }),
        ],
        true,
        'cursor-1',
      ),
      page([
        pr({
          number: 11,
          headRefName: 'squad/101-b',
          closingIssueNumbers: [],
        }),
      ]),
    ]);
    const run = vi.fn<(args: string[]) => string>(() => raw);

    expect(
      readOpenPullRequests({
        owner: 'OlyForge3D',
        repo: 'PrintFarmerDesktop',
        run,
      }).map(({ number }) => number),
    ).toEqual([10, 11]);
    expect(run.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['graphql', '--paginate', '--slurp']),
    );
  });

  it('accepts a complete empty population', () => {
    expect(parseOpenPullRequestPages(JSON.stringify([page([])]))).toEqual([]);
  });

  it('rejects a response that stops while another page is promised', () => {
    expect(() =>
      parseOpenPullRequestPages(
        JSON.stringify([page([], true, 'missing-next-page')]),
      ),
    ).toThrow(/ended before/);
  });

  it('rejects a page after the connection already reported its terminal page', () => {
    expect(() =>
      parseOpenPullRequestPages(JSON.stringify([page([]), page([])])),
    ).toThrow(/after a terminal page/);
  });

  it('rejects a truncated nested closing-reference connection', () => {
    const response = page([
      pr({
        number: 10,
        headRefName: 'squad/100-a',
        closingIssueNumbers: [100],
      }),
    ]);
    response.data.repository.pullRequests.nodes[0]!.closingIssuesReferences.pageInfo.hasNextPage = true;
    expect(() => parseOpenPullRequestPages(JSON.stringify([response]))).toThrow(
      /more than 100/,
    );
  });

  it('rejects GraphQL errors even when an empty data-shaped response accompanies them', () => {
    expect(() =>
      parseOpenPullRequestPages(
        JSON.stringify([
          {
            ...page([]),
            errors: [{ message: 'resource unavailable' }],
          },
        ]),
      ),
    ).toThrow(/reported errors/);
  });
});

describe('eventually consistent population reads', () => {
  function fakeClock() {
    let time = 0;
    return {
      sleep: (ms: number) => {
        time += ms;
        return Promise.resolve();
      },
      now: () => time,
    };
  }

  it('waits for a newly armed claim to arrive and then hold for the stability floor', async () => {
    const stale = [
      pr({
        number: 10,
        headRefName: 'no-number',
        closingIssueNumbers: [],
      }),
    ];
    const fresh = [
      pr({
        number: 10,
        headRefName: 'no-number',
        closingIssueNumbers: [452],
      }),
    ];
    const readings = [stale, stale, fresh, fresh];
    let index = 0;
    const result = await readSettledOpenPullRequests(
      () => readings[Math.min(index++, readings.length - 1)]!,
      {
        ...fakeClock(),
        delayMs: 20_000,
        minStableMs: 60_000,
      },
    );

    expect(result.value).toEqual(fresh);
    expect(result.settled).toBe(true);
    expect(result.stableMs).toBeGreaterThanOrEqual(60_000);
  });

  it('demonstrates that agreement without the floor would certify the stale population', async () => {
    const stale = [
      pr({
        number: 10,
        headRefName: 'no-number',
        closingIssueNumbers: [],
      }),
    ];
    const fresh = [
      pr({
        number: 10,
        headRefName: 'no-number',
        closingIssueNumbers: [452],
      }),
    ];
    const readings = [stale, stale, fresh, fresh];
    let index = 0;
    const result = await readSettledOpenPullRequests(() => readings[index++]!, {
      ...fakeClock(),
      delayMs: 20_000,
      minStableMs: 0,
    });

    expect(result.value).toEqual(stale);
    expect(result.settled).toBe(true);
  });

  it('reports unsettled rather than trusting the last population when the budget expires', async () => {
    let number = 0;
    const result = await readSettledOpenPullRequests(
      () => [
        pr({
          number: 10,
          headRefName: 'no-number',
          closingIssueNumbers: [number++ + 1],
        }),
      ],
      {
        ...fakeClock(),
        delayMs: 20_000,
        minStableMs: 60_000,
        maxReads: 3,
      },
    );
    expect(result.settled).toBe(false);
    expect(result.reads).toBe(3);
  });

  it('restarts the stability floor when the population changes after time accrued', async () => {
    const first = [
      pr({
        number: 10,
        headRefName: 'no-number',
        closingIssueNumbers: [],
      }),
    ];
    const second = [
      pr({
        number: 10,
        headRefName: 'no-number',
        closingIssueNumbers: [452],
      }),
    ];
    const readings = [first, first, first, second, second, second, second];
    let index = 0;
    const result = await readSettledOpenPullRequests(
      () => readings[Math.min(index++, readings.length - 1)]!,
      {
        ...fakeClock(),
        delayMs: 20_000,
        minStableMs: 60_000,
      },
    );
    expect(result.value).toEqual(second);
    expect(result.reads).toBe(7);
    expect(result.stableMs).toBe(60_000);
  });
});

describe('population discrimination and advisory output', () => {
  it('counts single claims without reporting them as collisions', () => {
    const result = evaluateClaimCollisions(
      [
        pr({
          number: 10,
          headRefName: 'squad/100-only',
          closingIssueNumbers: [],
        }),
        pr({
          number: 11,
          headRefName: 'unrelated',
          closingIssueNumbers: [101],
        }),
      ],
      [100],
      REPOSITORY,
    );
    expect(result).toMatchObject({
      claimedIssueCount: 2,
      singleClaimCount: 2,
      collisions: [],
    });
  });

  it('reports no collisions for multiple PRs with distinct claims', () => {
    const result = evaluateClaimCollisions(
      [
        pr({
          number: 10,
          headRefName: 'squad/100-only',
          closingIssueNumbers: [100],
        }),
        pr({
          number: 11,
          headRefName: 'squad/101-only',
          closingIssueNumbers: [101],
        }),
      ],
      [100, 101],
      REPOSITORY,
    );
    expect(result.collisions).toEqual([]);
  });

  it('does not conflate equal issue numbers from different repositories', () => {
    const first = pr({
      number: 10,
      headRefName: 'no-number',
      closingIssueNumbers: [100],
    });
    const second = pr({
      number: 11,
      headRefName: 'no-number',
      closingIssueNumbers: [100],
    });
    second.closingIssues[0]!.repository = 'OlyForge3D/PrintFarmer';

    const result = evaluateClaimCollisions([first, second], [], REPOSITORY);
    expect(result).toMatchObject({
      claimedIssueCount: 2,
      singleClaimCount: 2,
      collisions: [],
    });
  });

  it('names every conflicting PR in one advisory warning', () => {
    const result = evaluateClaimCollisions(
      [
        pr({
          number: 10,
          headRefName: 'squad/100-a',
          closingIssueNumbers: [],
        }),
        pr({
          number: 11,
          headRefName: 'squad/100-b',
          closingIssueNumbers: [100],
        }),
        pr({
          number: 12,
          headRefName: 'squad/100-c',
          closingIssueNumbers: [],
        }),
      ],
      [100],
      REPOSITORY,
    );
    const warnings = formatCollisionWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('::warning');
    expect(warnings[0]).toContain('PR #10');
    expect(warnings[0]).toContain('PR #11');
    expect(warnings[0]).toContain('PR #12');
    expect(warnings[0]).toContain('deliberate replacement PRs are valid');
  });

  it('returns normally when collisions exist because the finding is advisory', async () => {
    const output = vi.fn();
    const run = vi
      .fn<(args: string[]) => string>()
      .mockReturnValueOnce(
        JSON.stringify([
          page([
            pr({
              number: 10,
              headRefName: 'squad/100-a',
              closingIssueNumbers: [],
            }),
            pr({
              number: 11,
              headRefName: 'squad/100-b',
              closingIssueNumbers: [100],
            }),
          ]),
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            repository: { n100: { __typename: 'Issue' } },
          },
        }),
      );

    const result = await main([], {
      run,
      environment: {
        GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop',
      },
      output,
      readPopulation: async (read) => ({
        value: await read(),
        reads: 13,
        settled: true,
        elapsedMs: 60_000,
        stableMs: 60_000,
      }),
    });
    expect(result.collisions).toHaveLength(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('ADVISORY'));
  });

  it('does not make a type-resolution request for an empty candidate population', async () => {
    const run = vi.fn(() =>
      JSON.stringify([
        page([
          pr({
            number: 10,
            headRefName: 'no-number',
            closingIssueNumbers: [],
          }),
        ]),
      ]),
    );
    const result = await main([], {
      run,
      environment: {
        GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop',
      },
      output: vi.fn(),
      readPopulation: async (read) => ({
        value: await read(),
        reads: 13,
        settled: true,
        elapsedMs: 60_000,
        stableMs: 60_000,
      }),
    });
    expect(result.collisions).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fails instead of evaluating the last value from an unsettled population', async () => {
    await expect(
      main([], {
        run: vi.fn(),
        environment: {
          GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop',
        },
        output: vi.fn(),
        readPopulation: () =>
          Promise.resolve({
            value: [],
            reads: 40,
            settled: false,
            elapsedMs: 195_000,
            stableMs: 5_000,
          }),
      }),
    ).rejects.toThrow(/did not hold stable/);
  });

  it('batches branch issue type resolution rather than building an unbounded query', () => {
    const numbers = Array.from({ length: 51 }, (_, index) => index + 1);
    const run = vi
      .fn<(args: string[]) => string>()
      .mockImplementationOnce(() =>
        JSON.stringify({
          data: {
            repository: Object.fromEntries(
              numbers
                .slice(0, 50)
                .map((number) => [`n${number}`, { __typename: 'Issue' }]),
            ),
          },
        }),
      )
      .mockImplementationOnce(() =>
        JSON.stringify({
          data: {
            repository: { n51: { __typename: 'PullRequest' } },
          },
        }),
      );
    expect(
      resolveBranchIssueNumbers({
        owner: 'OlyForge3D',
        repo: 'PrintFarmerDesktop',
        numbers,
        run,
      }),
    ).toEqual(numbers.slice(0, 50));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('queries issueOrPullRequest typename under a stable alias for each candidate', () => {
    const run = vi.fn<(args: string[]) => string>(() =>
      JSON.stringify({
        data: {
          repository: { n481: { __typename: 'Issue' } },
        },
      }),
    );
    resolveBranchIssueNumbers({
      owner: 'OlyForge3D',
      repo: 'PrintFarmerDesktop',
      numbers: [481],
      run,
    });
    const args = run.mock.calls[0]?.[0] ?? [];
    const query = args.find((argument) => argument.startsWith('query='));
    expect(query).toContain(
      'n481: issueOrPullRequest(number: 481) { __typename }',
    );
  });
});

describe('workflow wiring', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const workflow = readFileSync(
    path.join(root, '.github', 'workflows', 'pr-claim-collisions.yml'),
    'utf8',
  );
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  it('runs the tested npm entry point as an advisory PR-population check', () => {
    expect(manifest.scripts['check:pr-claim-collisions']).toBe(
      'node scripts/check-pr-claim-collisions.mjs',
    );
    expect(workflow).toContain('# merge-queue: advisory');
    expect(workflow).toContain('npm run check:pr-claim-collisions');
    expect(workflow).not.toContain('continue-on-error');
  });

  it('re-runs for every event that can change claim membership or body-derived claims', () => {
    expect(workflow).toContain(
      'types: [opened, synchronize, reopened, edited, closed]',
    );
  });

  it('grants read-only access to both pull request and issue identity data', () => {
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('issues: read');
    expect(workflow).toContain('pull-requests: read');
    expect(workflow).not.toMatch(/\bwrite\b/);
  });
});
