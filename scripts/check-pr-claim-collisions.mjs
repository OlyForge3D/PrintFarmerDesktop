// Reports when multiple open pull requests claim the same issue.
//
// This is deliberately separate from check-closing-references.mjs. That guard
// compares one PR's declarations with the closures GitHub armed for that PR.
// This advisory reads the whole open-PR population and asks a different
// question: whether two or more PRs claim the same issue.

import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
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
              closed
              repository {
                nameWithOwner
              }
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

      const closingIssues = closingNodes.map((issueValue) => {
        const issue = asRecord(issueValue);
        const repository = asRecord(issue?.repository)?.nameWithOwner;
        if (typeof repository !== 'string' || repository.trim() === '') {
          throw new TypeError(
            `closing issue on PR #${number} has no repository identity`,
          );
        }
        if (typeof issue?.closed !== 'boolean') {
          throw new TypeError(
            `closing issue on PR #${number} is missing its closed state`,
          );
        }
        return {
          number: positiveInteger(
            issue?.number,
            `closing issue number on PR #${number}`,
          ),
          repository,
          closed: issue.closed,
        };
      });
      const uniqueClosingIssues = [
        ...new Map(
          closingIssues.map((issue) => [
            `${issue.repository}#${issue.number}`,
            issue,
          ]),
        ).values(),
      ].sort(
        (a, b) =>
          a.repository.localeCompare(b.repository) || a.number - b.number,
      );
      pullRequests.push({
        number,
        title: node.title,
        url: node.url,
        headRefName: node.headRefName,
        closingIssues: uniqueClosingIssues,
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
      return `n${number}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { closed } }`;
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
  const repository = asRecord(asRecord(response?.data)?.repository);
  if (!repository) {
    throw new TypeError(
      'branch issue type response has no repository object; refusing to treat candidates as nonexistent',
    );
  }

  const expectedKeys = new Set(expectedNumbers.map((number) => `n${number}`));
  const notFoundKeys = new Set();
  for (const errorValue of response?.errors ?? []) {
    const error = asRecord(errorValue);
    const path = error?.path;
    const key =
      Array.isArray(path) &&
      path.length === 2 &&
      path[0] === 'repository' &&
      typeof path[1] === 'string'
        ? path[1]
        : null;
    const expectedNotFound =
      error?.type === 'NOT_FOUND' &&
      key !== null &&
      expectedKeys.has(key) &&
      Object.hasOwn(repository, key) &&
      repository[key] === null;
    if (!expectedNotFound) {
      throw new Error(
        `branch issue type response reported an unexpected error: ${
          error?.message ?? JSON.stringify(errorValue)
        }`,
      );
    }
    notFoundKeys.add(key);
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
      if (!notFoundKeys.has(key)) {
        throw new Error(
          `branch issue type response returned an unexplained null for candidate #${number}`,
        );
      }
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

/**
 * Sibling to `parseBranchIssueTypes`, reading the *same* raw response (the
 * type-resolution query now also requests `... on Issue { closed }`) to
 * report which branch-derived candidates are Issues that are already closed.
 * A separate function, not a changed return shape on `parseBranchIssueTypes`,
 * so every existing caller and assertion of that function is untouched.
 */
export function parseBranchIssueClosedNumbers(raw, expectedNumbers) {
  const response = asRecord(parseJson(raw, 'branch issue type response'));
  const repository = asRecord(asRecord(response?.data)?.repository);
  if (!repository) {
    throw new TypeError(
      'branch issue type response has no repository object; refusing to treat candidates as nonexistent',
    );
  }

  const closedNumbers = [];
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
    const record = asRecord(value);
    if (record?.__typename === 'Issue') {
      if (typeof record.closed !== 'boolean') {
        throw new TypeError(
          `branch issue candidate #${number} is an Issue but the response omitted its closed state; refusing to report "not closed" from a partial response`,
        );
      }
      if (record.closed === true) {
        closedNumbers.push(number);
      }
    }
  }
  return closedNumbers;
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

/**
 * Wait for the complete population snapshot to hold still for the measured
 * closingIssuesReferences propagation interval.
 *
 * Agreement alone is insufficient: a stale pre-edit value is stable while the
 * derived field catches up. The stability floor is therefore measured from the
 * first read of the current agreement run, not from the start of polling.
 */
export async function readSettledOpenPullRequests(read, options = {}) {
  const {
    requiredAgreements = 2,
    maxReads = 40,
    delayMs = 5000,
    minStableMs = 60000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;

  const start = now();
  let agreementStart = start;
  let previousKey;
  let agreements = 0;
  let reads = 0;
  let value = [];

  for (let index = 0; index < maxReads; index += 1) {
    if (index > 0) {
      await sleep(delayMs);
    }
    reads += 1;
    value = await read();
    const key = JSON.stringify(value);
    if (key === previousKey) {
      agreements += 1;
    } else {
      previousKey = key;
      agreements = 1;
      agreementStart = now();
    }
    const stableMs = now() - agreementStart;
    if (agreements >= requiredAgreements && stableMs >= minStableMs) {
      return {
        value,
        reads,
        settled: true,
        elapsedMs: now() - start,
        stableMs,
      };
    }
  }

  return {
    value,
    reads,
    settled: false,
    elapsedMs: now() - start,
    stableMs: now() - agreementStart,
  };
}

/**
 * Batches the type-resolution call once per `RESOLUTION_BATCH_SIZE` numbers
 * and reads both which candidates are Issues and which of those are already
 * closed from the same response, since `branchIssueTypeQuery` requests both
 * `__typename` and `... on Issue { closed }` in one round trip.
 */
export function resolveBranchIssueDetails({ owner, repo, numbers, run }) {
  const issueNumbers = [];
  const closedIssueNumbers = [];
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
    closedIssueNumbers.push(...parseBranchIssueClosedNumbers(raw, batch));
  }
  return { issueNumbers, closedIssueNumbers };
}

/**
 * Kept for its existing signature and callers: delegates to
 * `resolveBranchIssueDetails` so the batching and gh-call count are shared
 * with the closed-issue lookup rather than doubled.
 */
export function resolveBranchIssueNumbers({ owner, repo, numbers, run }) {
  return resolveBranchIssueDetails({ owner, repo, numbers, run }).issueNumbers;
}

export function evaluateClaimCollisions(
  pullRequests,
  branchIssueNumbers,
  branchIssueRepository,
  closedBranchIssueNumbers = [],
) {
  if (
    !Array.isArray(pullRequests) ||
    !Array.isArray(branchIssueNumbers) ||
    typeof branchIssueRepository !== 'string' ||
    branchIssueRepository.trim() === '' ||
    !Array.isArray(closedBranchIssueNumbers)
  ) {
    throw new TypeError(
      'pullRequests, branchIssueNumbers and closedBranchIssueNumbers must be arrays and branchIssueRepository must identify OWNER/REPO',
    );
  }
  const validBranchIssues = new Set(
    branchIssueNumbers.map((number) =>
      positiveInteger(number, 'resolved branch issue number'),
    ),
  );
  const closedBranchIssues = new Set(
    closedBranchIssueNumbers.map((number) =>
      positiveInteger(number, 'closed branch issue number'),
    ),
  );
  const claimsByIssue = new Map();

  for (const pullRequest of pullRequests) {
    const prNumber = positiveInteger(
      pullRequest?.number,
      'pull request number',
    );
    const sourcesByIssue = new Map();
    for (const issue of pullRequest.closingIssues ?? []) {
      const issueNumber = positiveInteger(
        issue?.number,
        `closing issue number on PR #${prNumber}`,
      );
      if (
        typeof issue.repository !== 'string' ||
        issue.repository.trim() === ''
      ) {
        throw new TypeError(
          `closing issue #${issueNumber} on PR #${prNumber} has no repository identity`,
        );
      }
      const key = `${issue.repository}#${issueNumber}`;
      sourcesByIssue.set(key, {
        repository: issue.repository,
        issueNumber,
        sources: new Set(['closingIssuesReferences']),
        closed: issue.closed === true,
      });
    }
    for (const issueNumber of parseBranchIssueCandidates(
      pullRequest.headRefName,
    )) {
      if (!validBranchIssues.has(issueNumber)) {
        continue;
      }
      const key = `${branchIssueRepository}#${issueNumber}`;
      const claim = sourcesByIssue.get(key) ?? {
        repository: branchIssueRepository,
        issueNumber,
        sources: new Set(),
        closed: false,
      };
      claim.sources.add('branch');
      claim.closed = claim.closed || closedBranchIssues.has(issueNumber);
      sourcesByIssue.set(key, claim);
    }

    for (const [key, issueClaim] of sourcesByIssue) {
      const existing = claimsByIssue.get(key);
      const claims = existing?.pullRequests ?? [];
      claims.push({
        number: prNumber,
        title: pullRequest.title,
        url: pullRequest.url,
        headRefName: pullRequest.headRefName,
        sources: [...issueClaim.sources].sort(),
      });
      claimsByIssue.set(key, {
        repository: issueClaim.repository,
        issueNumber: issueClaim.issueNumber,
        pullRequests: claims,
        closed: Boolean(existing?.closed) || issueClaim.closed,
      });
    }
  }

  const collisions = [...claimsByIssue]
    .map(([, claim]) => claim)
    .filter(({ pullRequests }) => pullRequests.length > 1)
    .map(({ repository, issueNumber, pullRequests }) => ({
      repository,
      issueNumber,
      pullRequests: pullRequests.sort((a, b) => a.number - b.number),
    }))
    .sort(
      (a, b) =>
        a.repository.localeCompare(b.repository) ||
        a.issueNumber - b.issueNumber,
    );

  // Separate from `collisions`: a closed-issue claim is a defect on its own,
  // even when exactly one open PR claims it -- that PR's declaration matches
  // nothing observable precisely because nothing else claims it either.
  const closedClaims = [...claimsByIssue]
    .map(([, claim]) => claim)
    .filter(({ closed }) => closed)
    .map(({ repository, issueNumber, pullRequests }) => ({
      repository,
      issueNumber,
      pullRequests: pullRequests.sort((a, b) => a.number - b.number),
    }))
    .sort(
      (a, b) =>
        a.repository.localeCompare(b.repository) ||
        a.issueNumber - b.issueNumber,
    );

  return {
    openPullRequestCount: pullRequests.length,
    claimedIssueCount: claimsByIssue.size,
    singleClaimCount: [...claimsByIssue.values()].filter(
      ({ pullRequests: claims }) => claims.length === 1,
    ).length,
    collisions,
    closedClaims,
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
    const issue = `${collision.repository}#${collision.issueNumber}`;
    return `::warning title=Duplicate issue claim ${issue}::${escapeWorkflowCommand(
      `Issue ${issue} is claimed by ${claimants}. This is advisory: deliberate replacement PRs are valid, but every conflicting PR must be reviewed together.`,
    )}`;
  });
}

/**
 * #520 AC2: an open PR claiming an issue that is already closed is the same
 * defect after the fact as two open PRs claiming the same issue -- the
 * claim matches nothing observable, quietly. Reported for every closed
 * claim, independent of `collisions`: a single PR claiming a closed issue
 * is a finding on its own, not only when another PR also claims it.
 */
export function formatClosedIssueClaimWarnings(result) {
  return result.closedClaims.map((claim) => {
    const claimants = claim.pullRequests
      .map(
        (pullRequest) =>
          `PR #${pullRequest.number} (${pullRequest.url}; ${pullRequest.sources.join('+')})`,
      )
      .join(', ');
    const issue = `${claim.repository}#${claim.issueNumber}`;
    return `::warning title=Closed issue claimed ${issue}::${escapeWorkflowCommand(
      `Issue ${issue} is already closed but is still claimed by ${claimants}. This is advisory: the claim may be stale, or the issue may have been reopened since; either way, it no longer describes what the claim asserts.`,
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

export function runGitHub(args, execute = execFileSync) {
  const options = {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  try {
    return execute('gh', args, options);
  } catch (error) {
    const stdout =
      typeof error?.stdout === 'string'
        ? error.stdout
        : error?.stdout instanceof Uint8Array
          ? Buffer.from(error.stdout).toString('utf8')
          : '';
    if (args[0] === 'api' && args.includes('graphql') && stdout.trim() !== '') {
      // GraphQL returns useful partial data with a nonzero gh exit when one
      // issueOrPullRequest alias is NOT_FOUND. The response parser, not the
      // process status, decides whether those errors are expected.
      return stdout;
    }
    throw error;
  }
}

function defaultRun(args) {
  return runGitHub(args);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const run = deps.run ?? defaultRun;
  const environment = deps.environment ?? process.env;
  const output = deps.output ?? console.log;
  const readPopulation = deps.readPopulation ?? readSettledOpenPullRequests;
  const { owner, repo } = parseArgs(argv, environment, run);
  const population = await readPopulation(() =>
    readOpenPullRequests({ owner, repo, run }),
  );
  if (!population.settled) {
    throw new Error(
      `open pull request population did not hold stable for the required interval ` +
        `(${population.reads} reads over ${Math.round(population.elapsedMs / 1000)}s; ` +
        `last stable interval ${Math.round(population.stableMs / 1000)}s)`,
    );
  }
  const pullRequests = population.value;
  const candidates = collectBranchIssueCandidates(pullRequests);
  const { issueNumbers: branchIssueNumbers, closedIssueNumbers } =
    candidates.length === 0
      ? { issueNumbers: [], closedIssueNumbers: [] }
      : (deps.resolveBranchIssueDetails ?? resolveBranchIssueDetails)({
          owner,
          repo,
          numbers: candidates,
          run,
        });
  const result = evaluateClaimCollisions(
    pullRequests,
    branchIssueNumbers,
    `${owner}/${repo}`,
    closedIssueNumbers,
  );

  output(
    `[pr-claim-collisions] open PRs ${result.openPullRequestCount}; claimed issues ${result.claimedIssueCount}; collisions ${result.collisions.length}; closed-issue claims ${result.closedClaims.length}; singly claimed ${result.singleClaimCount}; population reads ${population.reads}; stable ${Math.round(population.stableMs / 1000)}s`,
  );
  for (const warning of formatCollisionWarnings(result)) {
    output(warning);
  }
  for (const warning of formatClosedIssueClaimWarnings(result)) {
    output(warning);
  }
  if (result.collisions.length === 0) {
    output('[pr-claim-collisions] OK: no duplicate open-PR issue claims');
  } else {
    output(
      `[pr-claim-collisions] ADVISORY: ${result.collisions.length} duplicate issue claim(s) found; the workflow remains green because replacement PRs can be deliberate`,
    );
  }
  if (result.closedClaims.length === 0) {
    output(
      '[pr-claim-collisions] OK: no open PR claims an already-closed issue',
    );
  } else {
    output(
      `[pr-claim-collisions] ADVISORY: ${result.closedClaims.length} closed-issue claim(s) found; the workflow remains green because a claim may be stale rather than wrong`,
    );
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `[pr-claim-collisions] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
