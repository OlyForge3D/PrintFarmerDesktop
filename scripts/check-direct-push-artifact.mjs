// #388, remedy 3: "if an exemption must be retained, make its use leave an
// artifact." `enforce_admins: false` is retained deliberately (#111,
// reasserted by check-protection-assumptions.mjs and by
// tests/protectionAssumptions.test.ts) because `jpapiez` is the sole admin
// collaborator and GitHub refuses self-approval — flipping it is unsafe while
// that remains true, and `.squad/skills/git-workflow/SKILL.md` says so in
// plain language: "This is not a call to flip `enforce_admins`... it belongs
// to #388." check-behind-base.mjs's reachability entry says the same thing
// about the client-side gate it is the same shape as. Neither #1 nor #2 of
// #388's suggested remedies is applied by this file, for those reasons.
//
// What THIS file does: the exemption enforce_admins:false grants is exercised
// silently today. A commit can reach `development` with no pull request and
// nothing records that it happened — the branch's settings read identically
// to a repository where every merge went through review. #388 measured
// exactly two such commits (177dd2d, 8031631, both 2026-08-04) and found no
// artifact anywhere. This closes that specific gap: it finds commits on
// `development` with no associated pull request and posts durable evidence
// naming each one, once, on the tracking issue.
//
// WHY A COMMENT ON AN ISSUE AND NOT A REQUIRED CHECK: a required check runs
// on a pull request or a merge-queue entry and can refuse to let one land.
// The commit this file is about has, by definition, no pull request — it is
// already on the branch before anything here can run. There is no gate left
// to be. This is the same shape as
// scripts/publish-npm-cleanup-evidence.mjs: durable, append-only evidence
// posted to a fixed tracking issue, because a comment on a closed issue is
// still readable and still dated, and neither a fact nor its absence should
// depend on the issue's open/closed state.
//
// WHY IDEMPOTENT: this is meant to be run by hand (see the entry this adds to
// scripts/check-script-reachability.mjs's UNENFORCED_CHECKS, and read that
// entry for the reason it is not wired into a workflow yet) and re-run is the
// expected use, not the exception. Re-posting the same evidence on every run
// would make the tracking issue noise, and noise is what trains a reader to
// stop reading. Each commit gets exactly one comment, found by searching
// existing comments for its full SHA before posting a new one.

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  discoverToken,
  discoverRepository,
} from './check-merge-queue-contexts.mjs';
import { resolveRepository } from './check-pr-closure-scope.mjs';

export const DIRECT_PUSH_TRACKING_ISSUE = 388;

// Bounded so a corrupted or malicious log entry cannot be replayed as an
// arbitrarily large request body; 500 is generous for a subject line.
const MAXIMUM_SUBJECT_LENGTH = 500;

/**
 * Pure. `commits` is one entry per commit reachable on `development` in the
 * scanned range; `pullCounts` maps sha -> number of pull requests GitHub
 * associates with it (0 means "reached the branch with no PR").
 *
 * @param {readonly {sha: string, author: string, authoredDate: string, subject: string}[]} commits
 * @param {ReadonlyMap<string, number>} pullCounts
 * @returns {{sha: string, author: string, authoredDate: string, subject: string}[]}
 */
export function findBareCommits(commits, pullCounts) {
  if (!Array.isArray(commits)) {
    throw new TypeError('commits must be an array');
  }
  if (!(pullCounts instanceof Map)) {
    throw new TypeError('pullCounts must be a Map keyed by full sha');
  }
  return commits.filter((commit) => {
    const count = pullCounts.get(commit.sha);
    if (count === undefined) {
      throw new Error(
        `no pull-request count was looked up for ${commit.sha}; refusing to guess whether it is bare`,
      );
    }
    return count === 0;
  });
}

/**
 * @param {{sha: string, author: string, authoredDate: string, subject: string}} commit
 * @returns {string}
 */
export function formatBareCommitEvidence(commit) {
  if (typeof commit?.sha !== 'string' || commit.sha.length < 7) {
    throw new TypeError('commit.sha must be a full SHA');
  }
  const subject = String(commit.subject ?? '').slice(0, MAXIMUM_SUBJECT_LENGTH);
  return [
    '**Direct-push audit — enforce_admins exemption exercised, per #388 remedy 3.**',
    '',
    `- **Commit:** \`${commit.sha}\``,
    `- **Author:** ${commit.author ?? '(unknown)'}`,
    `- **Authored:** ${commit.authoredDate ?? '(unknown)'}`,
    `- **Subject:** ${subject || '(empty)'}`,
    '- **Pull requests found:** 0',
    '',
    'This commit reached `development` with no associated pull request. That is only ' +
      'possible through the `enforce_admins: false` exemption (or an equivalent bypass), ' +
      'which remains deliberate — see #111 and `.squad/skills/git-workflow/SKILL.md`. ' +
      'This comment is the artifact remedy 3 of #388 asks for: the exemption leaves a ' +
      'record here every time `scripts/check-direct-push-artifact.mjs` finds it used, ' +
      'rather than leaving the branch looking identical to one where every commit went ' +
      'through review.',
  ].join('\n');
}

/**
 * @param {readonly {body?: string}[]} existingComments
 * @param {string} sha
 * @returns {boolean}
 */
export function alreadyRecorded(existingComments, sha) {
  return (existingComments ?? []).some(
    (comment) =>
      typeof comment?.body === 'string' && comment.body.includes(sha),
  );
}

const api = async (fetchImpl, method, url, token, body) => {
  const response = await fetchImpl(url, {
    method,
    headers: {
      authorization: `bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${url} failed: ${response.status} ${response.statusText}`,
    );
  }
  return response.status === 204 ? null : response.json();
};

/**
 * @param {{owner: string, repo: string, sha: string, token: string, fetchImpl?: typeof fetch}} args
 * @returns {Promise<number>}
 */
export async function countAssociatedPullRequests({
  owner,
  repo,
  sha,
  token,
  fetchImpl = fetch,
}) {
  const payload = await api(
    fetchImpl,
    'GET',
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/pulls`,
    token,
  );
  if (!Array.isArray(payload)) {
    throw new Error(`unexpected response shape for commits/${sha}/pulls`);
  }
  return payload.length;
}

/**
 * @param {{owner: string, repo: string, issueNumber: number, token: string, fetchImpl?: typeof fetch}} args
 * @returns {Promise<{body?: string}[]>}
 */
export async function fetchTrackingIssueComments({
  owner,
  repo,
  issueNumber,
  token,
  fetchImpl = fetch,
}) {
  const payload = await api(
    fetchImpl,
    'GET',
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
    token,
  );
  if (!Array.isArray(payload)) {
    throw new Error('unexpected response shape for issue comments');
  }
  return payload;
}

/**
 * @param {{owner: string, repo: string, issueNumber: number, body: string, token: string, fetchImpl?: typeof fetch}} args
 * @returns {Promise<string>}
 */
export async function postTrackingIssueComment({
  owner,
  repo,
  issueNumber,
  body,
  token,
  fetchImpl = fetch,
}) {
  const payload = await api(
    fetchImpl,
    'POST',
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    token,
    { body },
  );
  if (typeof payload?.html_url !== 'string') {
    throw new Error('GitHub REST posted the comment but returned no URL');
  }
  return payload.html_url;
}

/**
 * Reads commits reachable from `ref` that are not reachable from `since`,
 * oldest first, via the local checkout — the same instrument
 * scripts/push-guard.mjs already trusts for commit enumeration, rather than
 * a second, independent implementation of "list commits in a range".
 *
 * @param {string} since
 * @param {string} ref
 * @param {typeof execFileSync} exec
 * @returns {{sha: string, author: string, authoredDate: string, subject: string}[]}
 */
export function readCommitRange(since, ref, exec = execFileSync) {
  const RECORD_SEPARATOR = '\x1e';
  const FIELD_SEPARATOR = '\x1f';
  const format =
    ['%H', '%an', '%aI', '%s'].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;
  const stdout = exec(
    'git',
    ['log', `--format=${format}`, `${since}..${ref}`],
    { encoding: 'utf8' },
  );
  return String(stdout)
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha, author, authoredDate, subject] =
        record.split(FIELD_SEPARATOR);
      return { sha, author, authoredDate, subject };
    })
    .reverse();
}

const USAGE = `usage: node scripts/check-direct-push-artifact.mjs --since <sha> [--ref development]

Finds commits reachable from --ref but not from --since that carry no
associated pull request, and posts durable evidence of each one (once) as a
comment on issue #${DIRECT_PUSH_TRACKING_ISSUE} -- the artifact remedy 3 of
#388 asks for. Exit 0 if none are found or all are already recorded; exit 1
if new evidence was posted, so a human re-reads it; exit 2 if the check could
not run at all (no credential, no repository, git failure).
`;

async function main() {
  const args = process.argv.slice(2);
  const sinceIndex = args.indexOf('--since');
  const refIndex = args.indexOf('--ref');
  if (args.includes('--help') || args.includes('-h') || sinceIndex === -1) {
    console.log(USAGE);
    return sinceIndex === -1 ? 2 : 0;
  }
  const since = args[sinceIndex + 1];
  const ref = refIndex === -1 ? 'development' : args[refIndex + 1];
  if (!since) {
    console.error('--since requires a commit-ish');
    return 2;
  }

  const token = discoverToken(process.env);
  const repositoryName = discoverRepository(process.env);
  if (token === null || repositoryName === null) {
    const missing = [];
    if (token === null) missing.push('no GITHUB_TOKEN and no `gh auth token`');
    if (repositoryName === null)
      missing.push('no GITHUB_REPOSITORY and no origin remote');
    console.log(`Skipped the direct-push audit: ${missing.join('; ')}.`);
    return 2;
  }

  let repository;
  try {
    repository = resolveRepository(
      repositoryName === ''
        ? process.env
        : { ...process.env, GITHUB_REPOSITORY: repositoryName },
    );
  } catch (err) {
    console.log(`Skipped: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  let commits;
  try {
    commits = readCommitRange(since, ref);
  } catch (err) {
    console.error(
      `git log failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  const pullCounts = new Map();
  for (const commit of commits) {
    const count = await countAssociatedPullRequests({
      owner: repository.owner,
      repo: repository.repo,
      sha: commit.sha,
      token,
    });
    pullCounts.set(commit.sha, count);
  }

  const bare = findBareCommits(commits, pullCounts);
  if (bare.length === 0) {
    console.log(
      `No commits between ${since} and ${ref} reached the branch without a pull request.`,
    );
    return 0;
  }

  const existingComments = await fetchTrackingIssueComments({
    owner: repository.owner,
    repo: repository.repo,
    issueNumber: DIRECT_PUSH_TRACKING_ISSUE,
    token,
  });

  let posted = 0;
  for (const commit of bare) {
    if (alreadyRecorded(existingComments, commit.sha)) {
      console.log(
        `${commit.sha} already has an artifact on #${DIRECT_PUSH_TRACKING_ISSUE}.`,
      );
      continue;
    }
    const url = await postTrackingIssueComment({
      owner: repository.owner,
      repo: repository.repo,
      issueNumber: DIRECT_PUSH_TRACKING_ISSUE,
      body: formatBareCommitEvidence(commit),
      token,
    });
    console.log(`Posted evidence for ${commit.sha}: ${url}`);
    posted += 1;
  }

  return posted > 0 ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(
        `check-direct-push-artifact failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 2;
    },
  );
}
