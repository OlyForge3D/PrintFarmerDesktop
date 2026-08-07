// Reports when multiple open pull requests claim the same issue.
//
// This is deliberately separate from check-closing-references.mjs. That guard
// compares one PR's declarations with the closures GitHub armed for that PR.
// This advisory reads the whole open-PR population and asks a different
// question: whether two or more PRs claim the same issue.

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const OPEN_PULL_REQUESTS_QUERY = `
  query OpenPullRequestClaims($owner: String!, $repo: String!, $endCursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: OPEN, first: 100, after: $endCursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        nodes {
          number
          title
          url
          headRefName
          closingIssuesReferences(first: 100) {
            nodes {
              number
            }
            pageInfo {
              hasNextPage
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const DATE_FRAGMENT =
  /(?:^|[-_/])(?:19|20)\d{2}[-_](?:0?[1-9]|1[0-2])[-_](?:0?[1-9]|[12]\d|3[01])(?=$|[-_/])/g;
const NUMBER_SEGMENT = /(?:^|[-_/])(\d+)(?=$|[-_/])/g;
const RESOLUTION_BATCH_SIZE = 50;

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : undefined;
}

function positiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${description} must be a positive safe integer`);
  }
  return value;
}

function parseJson(raw, description) {
  if (typeof raw !== 'string') {
    throw new TypeError(`${description} must be a string`);
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${description} is not valid JSON`, { cause });
  }
}

function assertNoGraphQlErrors(page, description) {
  if (Array.isArray(page?.errors) && page.errors.length > 0) {
    throw new Error(
      `${description} reported errors: ${page.errors
        .map((error) => error?.message ?? JSON.stringify(error))
        .join('; ')}`,
    );
  }
}

export function parseOpenPullRequestPages(raw) {
  const pages = parseJson(raw, 'open pull request response');
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new TypeError(
      'open pull request response must be a non-empty array of paginated GraphQL responses',
    );
  }

  const pullRequests = [];
  const seenPullRequests = new Set();
  let reachedTerminalPage = false;

  for (const [pageIndex, pageValue] of pages.entries()) {
    const page = asRecord(pageValue);
    assertNoGraphQlErrors(page, `open pull request page ${pageIndex + 1}`);
    const connection = asRecord(
      asRecord(asRecord(page?.data)?.repository)?.pullRequests,
    );
    const nodes = connection?.nodes;
    const pageInfo = asRecord(connection?.pageInfo);

    if (
      !Array.isArray(nodes) ||
      typeof pageInfo?.hasNextPage !== 'boolean' ||
      (pageInfo.hasNextPage && typeof pageInfo.endCursor !== 'string')
    ) {
      throw new TypeError(
        `open pull request page ${pageIndex + 1} has an invalid or partial connection`,
      );
    }
    if (reachedTerminalPage) {
      throw new Error(
        `open pull request response contains page ${pageIndex + 1} after a terminal page`,
      );
    }

    for (const nodeValue of nodes) {
      const node = asRecord(nodeValue);
      const number = positiveInteger(node?.number, 'pull request node number');
      if (seenPullRequests.has(number)) {
        throw new Error(
          `open pull request response repeats PR #${number} across pages`,
        );
      }
      if (
        typeof node?.title !== 'string' ||
        typeof node.url !== 'string' ||
        typeof node.headRefName !== 'string'
      ) {
        throw new TypeError(
          `open pull request #${number} is missing title, url, or headRefName`,
        );
      }

      const closingConnection = asRecord(node.closingIssuesReferences);
      const closingNodes = closingConnection?.nodes;
      const closingPageInfo = asRecord(closingConnection?.pageInfo);
      if (
        !Array.isArray(closingNodes) ||
        typeof closingPageInfo?.hasNextPage !== 'boolean'
      ) {
        throw new TypeError(
          `open pull request #${number} has a partial closingIssuesReferences connection`,
        );
      }
      if (closingPageInfo.hasNextPage) {
        throw new Error(
          `open pull request #${number} has more than 100 closing issue references; refusing to report from a truncated claim set`,
        );
      }

      const closingIssueNumbers = closingNodes.map((issueValue) =>
        positiveInteger(
          asRecord(issueValue)?.number,
          `closing issue number on PR #${number}`,
        ),
      );
      pullRequests.push({
        number,
        title: node.title,
        url: node.url,
        headRefName: node.headRefName,
        closingIssueNumbers: [...new Set(closingIssueNumbers)].sort(
          (a, b) => a - b,
        ),
      });
      seenPullRequests.add(number);
    }

    reachedTerminalPage = !pageInfo.hasNextPage;
  }

  if (!reachedTerminalPage) {
    throw new Error(
      'open pull request response ended before pageInfo.hasNextPage became false',
    );
  }
  return pullRequests;
}

/**
 * Extract numeric path segments while excluding ISO-like dates.
 *
 * The result is only a candidate set. A separate forge lookup accepts candidates
 * whose issueOrPullRequest typename is Issue and rejects pull request numbers
 * and nonexistent values.
 */
export function parseBranchIssueCandidates(headRefName) {
  if (typeof headRefName !== 'string') {
    throw new TypeError('headRefName must be a string');
  }
  const withoutDates = headRefName.replace(DATE_FRAGMENT, '/');
  const candidates = new Set();
  for (const match of withoutDates.matchAll(NUMBER_SEGMENT)) {
    const number = Number(match[1]);
    if (Number.isSafeInteger(number) && number > 0) {
      candidates.add(number);
    }
  }
  return [...candidates].sort((a, b) => a - b);
}

export function collectBranchIssueCandidates(pullRequests) {
  if (!Array.isArray(pullRequests)) {
    throw new TypeError('pullRequests must be an array');
  }
  const candidates = new Set();
  for (const pullRequest of pullRequests) {
    for (const number of parseBranchIssueCandidates(pullRequest?.headRefName)) {
      candidates.add(number);
    }
  }
  return [...candidates].sort((a, b) => a - b);
}

export function branchIssueTypeQuery(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) {
    throw new TypeError('branch issue type query requires at least one number');
  }
  const fields = numbers
    .map((number) => {
      positiveInteger(number, 'branch issue candidate');
      return `n${number}: issueOrPullRequest(number: ${number}) { __typename }`;
    })
    .join('\n');
  return `
    query BranchIssueTypes($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        ${fields}
      }
    }
  `;
}

export function parseBranchIssueTypes(raw, expectedNumbers) {
  const response = asRecord(parseJson(raw, 'branch issue type response'));
  assertNoGraphQlErrors(response, 'branch issue type response');
  const repository = asRecord(asRecord(response?.data)?.repository);
  if (!repository) {
    throw new TypeError(
      'branch issue type response has no repository object; refusing to treat candidates as nonexistent',
    );
  }

  const issueNumbers = [];
  for (const number of expectedNumbers) {
    positiveInteger(number, 'expected branch issue candidate');
    const key = `n${number}`;
    if (!Object.hasOwn(repository, key)) {
      throw new Error(
        `branch issue type response omitted candidate #${number}; refusing to report from a partial response`,
      );
    }
    const value = repository[key];
    if (value === null) {
      continue;
    }
    const typename = asRecord(value)?.__typename;
    if (typename === 'Issue') {
      issueNumbers.push(number);
    } else if (typename !== 'PullRequest') {
      throw new TypeError(
        `branch issue candidate #${number} has unexpected typename ${JSON.stringify(typename)}`,
      );
    }
  }
  return issueNumbers;
}

export function readOpenPullRequests({ owner, repo, run }) {
  const raw = run([
    'api',
    'graphql',
    '--paginate',
    '--slurp',
    '-f',
    `query=${OPEN_PULL_REQUESTS_QUERY}`,
    '-F',
    `owner=${owner}`,
    '-F',
    `repo=${repo}`,
  ]);
  return parseOpenPullRequestPages(raw);
}

export function resolveBranchIssueNumbers({ owner, repo, numbers, run }) {
  const issueNumbers = [];
  for (let index = 0; index < numbers.length; index += RESOLUTION_BATCH_SIZE) {
    const batch = numbers.slice(index, index + RESOLUTION_BATCH_SIZE);
    const raw = run([
      'api',
      'graphql',
      '-f',
      `query=${branchIssueTypeQuery(batch)}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${repo}`,
    ]);
    issueNumbers.push(...parseBranchIssueTypes(raw, batch));
  }
  return issueNumbers;
}

export function evaluateClaimCollisions(pullRequests, branchIssueNumbers) {
  if (!Array.isArray(pullRequests) || !Array.isArray(branchIssueNumbers)) {
    throw new TypeError(
      'pullRequests and branchIssueNumbers must both be arrays',
    );
  }
  const validBranchIssues = new Set(
    branchIssueNumbers.map((number) =>
      positiveInteger(number, 'resolved branch issue number'),
    ),
  );
  const claimsByIssue = new Map();

  for (const pullRequest of pullRequests) {
    const prNumber = positiveInteger(
      pullRequest?.number,
      'pull request number',
    );
    const sourcesByIssue = new Map();
    for (const issueNumber of pullRequest.closingIssueNumbers ?? []) {
      positiveInteger(issueNumber, `closing issue number on PR #${prNumber}`);
      sourcesByIssue.set(issueNumber, new Set(['closingIssuesReferences']));
    }
    for (const issueNumber of parseBranchIssueCandidates(
      pullRequest.headRefName,
    )) {
      if (!validBranchIssues.has(issueNumber)) {
        continue;
      }
      const sources = sourcesByIssue.get(issueNumber) ?? new Set();
      sources.add('branch');
      sourcesByIssue.set(issueNumber, sources);
    }

    for (const [issueNumber, sources] of sourcesByIssue) {
      const claims = claimsByIssue.get(issueNumber) ?? [];
      claims.push({
        number: prNumber,
        title: pullRequest.title,
        url: pullRequest.url,
        headRefName: pullRequest.headRefName,
        sources: [...sources].sort(),
      });
      claimsByIssue.set(issueNumber, claims);
    }
  }

  const collisions = [...claimsByIssue]
    .filter(([, claims]) => claims.length > 1)
    .map(([issueNumber, claims]) => ({
      issueNumber,
      pullRequests: claims.sort((a, b) => a.number - b.number),
    }))
    .sort((a, b) => a.issueNumber - b.issueNumber);

  return {
    openPullRequestCount: pullRequests.length,
    claimedIssueCount: claimsByIssue.size,
    singleClaimCount: [...claimsByIssue.values()].filter(
      (claims) => claims.length === 1,
    ).length,
    collisions,
  };
}

function escapeWorkflowCommand(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

export function formatCollisionWarnings(result) {
  return result.collisions.map((collision) => {
    const claimants = collision.pullRequests
      .map(
        (pullRequest) =>
          `PR #${pullRequest.number} (${pullRequest.url}; ${pullRequest.sources.join('+')})`,
      )
      .join(', ');
    return `::warning title=Duplicate issue claim #${collision.issueNumber}::${escapeWorkflowCommand(
      `Issue #${collision.issueNumber} is claimed by ${claimants}. This is advisory: deliberate replacement PRs are valid, but every conflicting PR must be reviewed together.`,
    )}`;
  });
}

function parseRepository(value) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(value ?? '');
  if (!match) {
    throw new Error(
      'repository must be OWNER/REPO; pass --repo or set GITHUB_REPOSITORY',
    );
  }
  return { owner: match[1], repo: match[2] };
}

function parseArgs(argv, environment, run) {
  const repoIndex = argv.indexOf('--repo');
  if (repoIndex >= 0 && !argv[repoIndex + 1]) {
    throw new Error('--repo requires OWNER/REPO');
  }
  const repository =
    repoIndex >= 0
      ? argv[repoIndex + 1]
      : (environment.GITHUB_REPOSITORY ??
        run([
          'repo',
          'view',
          '--json',
          'nameWithOwner',
          '--jq',
          '.nameWithOwner',
        ]).trim());
  return parseRepository(repository);
}

function defaultRun(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const run = deps.run ?? defaultRun;
  const environment = deps.environment ?? process.env;
  const output = deps.output ?? console.log;
  const { owner, repo } = parseArgs(argv, environment, run);
  const pullRequests = readOpenPullRequests({ owner, repo, run });
  const candidates = collectBranchIssueCandidates(pullRequests);
  const branchIssueNumbers =
    candidates.length === 0
      ? []
      : resolveBranchIssueNumbers({
          owner,
          repo,
          numbers: candidates,
          run,
        });
  const result = evaluateClaimCollisions(pullRequests, branchIssueNumbers);

  output(
    `[pr-claim-collisions] open PRs ${result.openPullRequestCount}; claimed issues ${result.claimedIssueCount}; collisions ${result.collisions.length}; singly claimed ${result.singleClaimCount}`,
  );
  for (const warning of formatCollisionWarnings(result)) {
    output(warning);
  }
  if (result.collisions.length === 0) {
    output('[pr-claim-collisions] OK: no duplicate open-PR issue claims');
  } else {
    output(
      `[pr-claim-collisions] ADVISORY: ${result.collisions.length} duplicate issue claim(s) found; the workflow remains green because replacement PRs can be deliberate`,
    );
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[pr-claim-collisions] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
