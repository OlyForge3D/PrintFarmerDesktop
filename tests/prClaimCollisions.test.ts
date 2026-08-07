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
  resolveBranchIssueNumbers,
} from '../scripts/check-pr-claim-collisions.mjs';

interface FixturePr {
  number: number;
  title?: string;
  url?: string;
  headRefName: string;
  closingIssueNumbers: number[];
}

function pr(input: FixturePr) {
  return {
    title: `PR ${input.number}`,
    url: `https://github.test/pull/${input.number}`,
    ...input,
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
              nodes: node.closingIssueNumbers.map((number) => ({ number })),
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
    );

    expect(result.collisions).toEqual([
      {
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
    );

    expect(result.collisions).toEqual([
      {
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
    );
    expect(result.claimedIssueCount).toBe(0);
    expect(result.collisions).toEqual([]);
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
    );
    expect(result.collisions).toEqual([]);
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
    );
    const warnings = formatCollisionWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('::warning');
    expect(warnings[0]).toContain('PR #10');
    expect(warnings[0]).toContain('PR #11');
    expect(warnings[0]).toContain('PR #12');
    expect(warnings[0]).toContain('deliberate replacement PRs are valid');
  });

  it('returns normally when collisions exist because the finding is advisory', () => {
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

    const result = main([], {
      run,
      environment: {
        GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop',
      },
      output,
    });
    expect(result.collisions).toHaveLength(1);
    expect(output).toHaveBeenCalledWith(expect.stringContaining('ADVISORY'));
  });

  it('does not make a type-resolution request for an empty candidate population', () => {
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
    const result = main([], {
      run,
      environment: {
        GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop',
      },
      output: vi.fn(),
    });
    expect(result.collisions).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
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
