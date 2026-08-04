// Verifies that a pull request is not armed to close a gate issue on merge.
//
// No shebang: this module is imported by tests/prClosureScope.test.ts, and
// vite's transform does not strip one the way node does. `npm run
// check:closure-scope` invokes it through `node`, so the shebang bought
// nothing and cost the whole file.

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Issues that a pull request must never close automatically.
//
// GitHub's closing-keyword parser does not read negation. A body that says
// "this does not close #57" still contains `close #57`, so the reference is
// armed and the issue closes on merge. The hazard therefore targets authors who
// know about it, because writing the disclaimer is what creates it.
//
// `closingIssuesReferences` acts within a second of merge (#212 merged
// 06:30:36Z, #205 closed 06:30:37Z), so there is no window in which a human
// could intervene.
//
// It is NOT the only field that can disagree with the prose. This file said it
// was, and the gate it protects was closed by the other one. GitHub honours
// closing keywords through two independent channels:
//
//   1. the pull request BODY, surfaced as `closingIssuesReferences`
//   2. any COMMIT MESSAGE that lands on the default branch
//
// This repository is configured `squash_merge_commit_message = COMMIT_MESSAGES`,
// so the squash body is composed from the branch's commit messages and the
// second channel is not hypothetical: it is the normal path.
//
// Measured, on the pull request that added this guard: #241's body-derived
// `closingIssuesReferences` was `[]` and this check passed honestly, while its
// commit b136caa6 carried the sentence `"this does not close #57" still
// contains a closing keyword in front of #57` — written to WARN about the
// hazard. That text entered f436eb51 on `development` and closed #57.
//
// So the trap is not only negation. Quotation is the same trap, and it selects
// for the author documenting the rule.
//
// Each entry states why the issue is a gate rather than ordinary work. A gate
// closes when its children close, by a deliberate human action — never as a
// side effect of merging one child.
export const PROTECTED_GATE_ISSUES = Object.freeze([
  Object.freeze({
    number: 42,
    reason:
      'Epic: First-class Printer Calibration. Closes only once every child closes.',
  }),
  Object.freeze({
    number: 57,
    reason:
      'Calibration release gate. Tracks its own children and closes only once they do.',
  }),
]);

export const EXPECTED_PROTECTED_GATE_ISSUE_COUNT = 2;

// Any issue carrying one of these labels is a gate by construction, so new
// epics are covered without editing the list above. #57 is the reason the named
// list also exists: it is a gate that tracks children but is not labelled
// `epic`, so a label-only rule would miss the exact issue that was armed.
export const PROTECTED_LABELS = Object.freeze(['epic']);

// GitHub's closing keywords, exactly as documented. Case-insensitive.
export const CLOSING_KEYWORDS = Object.freeze([
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
]);

// A keyword, optional colon, whitespace, then a same-repository issue
// reference. `#57` and `GH-57` are the two forms GitHub honours without an
// owner/repo prefix.
//
// No attempt is made to skip fenced code or block quotes. A commit message is
// not rendered as markdown, so GitHub's parser does not skip them either — and
// the quotation in b136caa6 is precisely the case that must be caught. A guard
// that excused quoted text would have excused the commit that closed the gate.
const ARMED_REFERENCE_PATTERN = new RegExp(
  String.raw`\b(${CLOSING_KEYWORDS.join('|')})\b\s*:?\s+(?:#|[Gg][Hh]-)(\d+)`,
  'gi',
);

/**
 * Find every issue number a piece of text arms for closure.
 *
 * Pure: no environment, no I/O. Returns one entry per match, in order, so a
 * caller can report which keyword did it rather than only that something did.
 */
export function extractArmedIssueNumbers(text) {
  if (typeof text !== 'string') {
    throw new TypeError(
      `expected text to scan, received ${typeof text}; refusing to report "nothing armed" from a value that cannot hold a reference`,
    );
  }

  const matches = [];
  for (const match of text.matchAll(ARMED_REFERENCE_PATTERN)) {
    const number = Number(match[2]);
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    matches.push({
      number,
      keyword: match[1].toLowerCase(),
      text: match[0],
    });
  }
  return matches;
}

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

const CLOSING_ISSUES_QUERY = `
  query ClosingIssues($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 50) {
          nodes {
            number
            title
            labels(first: 50) {
              nodes {
                name
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Decide whether a pull request's closing references are in scope.
 *
 * Pure: it reads no environment and performs no I/O, so the rule can be tested
 * without a network or a repository.
 */
export function evaluateClosureScope(closingIssues, options = {}) {
  if (!Array.isArray(closingIssues)) {
    throw new TypeError(
      'closingIssues must be an array; refusing to report a scope decision from a value that cannot hold one',
    );
  }

  const gates = options.protectedIssues ?? PROTECTED_GATE_ISSUES;
  const labels = options.protectedLabels ?? PROTECTED_LABELS;
  const reasonByNumber = new Map(
    gates.map((gate) => [gate.number, gate.reason]),
  );
  const protectedLabels = new Set(
    labels.map((label) => String(label).toLowerCase()),
  );

  const violations = [];
  for (const issue of closingIssues) {
    const number = issue?.number;
    if (!Number.isInteger(number)) {
      throw new TypeError(
        `closing issue entry has no integer number: ${JSON.stringify(issue)}`,
      );
    }

    const issueLabels = Array.isArray(issue.labels) ? issue.labels : [];
    const matchedLabels = issueLabels
      .map((label) => String(label))
      .filter((label) => protectedLabels.has(label.toLowerCase()));

    const rules = [];
    if (reasonByNumber.has(number)) {
      rules.push('named-gate');
    }
    for (const label of matchedLabels) {
      rules.push(`label:${label.toLowerCase()}`);
    }

    if (rules.length === 0) {
      continue;
    }

    violations.push({
      number,
      title: typeof issue.title === 'string' ? issue.title : '',
      rules,
      reason:
        reasonByNumber.get(number) ??
        `Carries a protected label (${matchedLabels.join(', ')}).`,
    });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Collect every issue armed by a pull request's commit messages.
 *
 * Pure. Returns a Map of issue number to the commits that arm it, so the caller
 * can name the offending commit rather than only the issue.
 */
export function collectArmedCommitReferences(commits) {
  if (!Array.isArray(commits)) {
    throw new TypeError(
      'commits must be an array; refusing to report a scope decision from a value that cannot hold one',
    );
  }

  const armed = new Map();
  for (const commit of commits) {
    const message = commit?.message;
    if (typeof message !== 'string') {
      throw new TypeError(
        `commit ${commit?.sha ?? '(unknown)'} has no message string; refusing to treat an unreadable commit as "nothing armed"`,
      );
    }

    for (const reference of extractArmedIssueNumbers(message)) {
      const existing = armed.get(reference.number) ?? [];
      existing.push({
        sha: typeof commit.sha === 'string' ? commit.sha : '(unknown)',
        keyword: reference.keyword,
        text: reference.text,
      });
      armed.set(reference.number, existing);
    }
  }
  return armed;
}

export function formatCommitViolations(violations, armedBy) {
  const lines = [
    'This pull request is armed to close a gate issue through a COMMIT MESSAGE.',
    '',
    `This repository squashes with squash_merge_commit_message = COMMIT_MESSAGES,`,
    'so these commit messages become the merge commit message and GitHub acts on',
    'them exactly as it acts on the pull request body.',
    '',
  ];

  for (const violation of violations) {
    lines.push(`  #${violation.number} ${violation.title}`.trimEnd());
    lines.push(`    matched: ${violation.rules.join(', ')}`);
    lines.push(`    why protected: ${violation.reason}`);
    for (const source of armedBy.get(violation.number) ?? []) {
      lines.push(
        `    armed by commit ${source.sha.slice(0, 8)}: ${JSON.stringify(source.text)}`,
      );
    }
    lines.push('');
  }

  lines.push(
    'Quoting the anti-pattern arms it. A commit message that says a closing',
    'keyword in front of a gate number counts, even when the sentence exists to',
    'warn against doing so. Reword to put the number first, or name it without a',
    'keyword: "Parent: #NNN", "the gate issue (#NNN)".',
    '',
    'Rewrite the commit messages (interactive rebase or amend) and force-push;',
    'editing the pull request body does not clear this one.',
  );

  return lines.join('\n');
}

export function formatViolations(violations) {
  const lines = [
    'This pull request is armed to close a gate issue on merge.',
    '',
  ];

  for (const violation of violations) {
    lines.push(
      `  #${violation.number} ${violation.title}`.trimEnd(),
      `    matched: ${violation.rules.join(', ')}`,
      `    why protected: ${violation.reason}`,
      '',
    );
  }

  lines.push(
    'GitHub does not read negation in closing keywords: "does not close #57"',
    'still arms #57. Rewrite the body so no closing keyword precedes the issue',
    'number — for example "is not a closure of #57", or "Parent: #57".',
    '',
    'Check the field, not the prose:',
    '  gh pr view <number> --json closingIssuesReferences',
  );

  return lines.join('\n');
}

export function resolvePullRequestNumber(environment) {
  const direct = environment.PR_NUMBER ?? environment.PULL_REQUEST_NUMBER;
  if (direct !== undefined && direct !== '') {
    const parsed = Number(direct);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`PR_NUMBER is not a positive integer: ${direct}`);
    }
    return parsed;
  }

  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error(
      'no pull request number available: set PR_NUMBER or provide GITHUB_EVENT_PATH',
    );
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const number = event?.pull_request?.number;
  if (!Number.isInteger(number)) {
    throw new Error(
      `event payload at ${eventPath} has no pull_request.number; this check must run on a pull_request event`,
    );
  }
  return number;
}

export function resolveRepository(environment) {
  const slug = environment.GITHUB_REPOSITORY;
  if (!slug) {
    throw new Error('GITHUB_REPOSITORY is not set');
  }
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY is not owner/repo: ${slug}`);
  }
  return { owner, repo };
}

export async function fetchClosingIssues({
  owner,
  repo,
  prNumber,
  token,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      query: CLOSING_ISSUES_QUERY,
      variables: { owner, repo, number: prNumber },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL returned ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  if (payload.errors) {
    throw new Error(
      `GitHub GraphQL reported errors: ${JSON.stringify(payload.errors)}`,
    );
  }

  const nodes =
    payload?.data?.repository?.pullRequest?.closingIssuesReferences?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(
      'GitHub GraphQL response has no closingIssuesReferences.nodes; refusing to treat an unreadable response as "nothing is armed"',
    );
  }

  return nodes.map((node) => ({
    number: node.number,
    title: node.title,
    labels: (node.labels?.nodes ?? []).map((label) => label.name),
  }));
}

export async function fetchPullRequestCommits({
  owner,
  repo,
  prNumber,
  token,
  fetchImpl = fetch,
}) {
  const commits = [];
  let page = 1;

  // Paginated deliberately. A truncated first page would under-report commits,
  // and under-reporting here reads exactly like "nothing armed".
  for (;;) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `bearer ${token}`,
          accept: 'application/vnd.github+json',
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `GitHub REST returned ${response.status} ${response.statusText} for pull request commits`,
      );
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error(
        'GitHub REST response for pull request commits is not an array; refusing to treat an unreadable response as "nothing is armed"',
      );
    }

    for (const entry of payload) {
      commits.push({
        sha: entry?.sha,
        message: entry?.commit?.message,
      });
    }

    if (payload.length < 100) {
      return commits;
    }
    page += 1;
  }
}

export async function fetchIssuesByNumber({
  owner,
  repo,
  numbers,
  token,
  fetchImpl = fetch,
}) {
  const issues = [];
  for (const number of numbers) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
      {
        headers: {
          authorization: `bearer ${token}`,
          accept: 'application/vnd.github+json',
        },
      },
    );

    // A reference to something that is not an issue in this repository cannot
    // close a gate. 404 is a real answer, not a failure to read.
    if (response.status === 404) {
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `GitHub REST returned ${response.status} ${response.statusText} for issue #${number}`,
      );
    }

    const payload = await response.json();
    if (!Number.isInteger(payload?.number)) {
      throw new Error(
        `GitHub REST response for issue #${number} has no number; refusing to treat an unreadable response as "not a gate"`,
      );
    }

    issues.push({
      number: payload.number,
      title: typeof payload.title === 'string' ? payload.title : '',
      labels: (payload.labels ?? []).map((label) =>
        typeof label === 'string' ? label : (label?.name ?? ''),
      ),
    });
  }
  return issues;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is not set');
  }

  const { owner, repo } = resolveRepository(process.env);
  const prNumber = resolvePullRequestNumber(process.env);
  const closingIssues = await fetchClosingIssues({
    owner,
    repo,
    prNumber,
    token,
  });

  const { ok, violations } = evaluateClosureScope(closingIssues);
  const armed = closingIssues.map((issue) => `#${issue.number}`).join(', ');
  console.log(
    `Pull request #${prNumber} is armed to close: ${armed || '(nothing)'}`,
  );

  // Second channel. Checked unconditionally, not as an else-branch of the
  // first: the gate was closed by a pull request whose body channel was clean,
  // so a body pass must never stand in for a commit pass.
  const commits = await fetchPullRequestCommits({
    owner,
    repo,
    prNumber,
    token,
  });
  const armedByCommit = collectArmedCommitReferences(commits);
  console.log(
    `Scanned ${commits.length} commit message(s); closing keywords found for: ${
      [...armedByCommit.keys()].map((number) => `#${number}`).join(', ') ||
      '(nothing)'
    }`,
  );

  const referencedIssues = await fetchIssuesByNumber({
    owner,
    repo,
    numbers: [...armedByCommit.keys()],
    token,
  });
  const commitScope = evaluateClosureScope(referencedIssues);

  if (!ok) {
    console.error(`\n${formatViolations(violations)}`);
  }
  if (!commitScope.ok) {
    console.error(
      `\n${formatCommitViolations(commitScope.violations, armedByCommit)}`,
    );
  }

  if (!ok || !commitScope.ok) {
    process.exitCode = 1;
    return;
  }

  console.log('No gate issue is armed, in either channel.');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // An inability to run this check fails the job. A guard that cannot read the
  // field must not report the same result as a guard that read it and found
  // nothing armed.
  main().catch((error) => {
    console.error(
      `Unable to verify pull request closure scope: ${error.message}`,
    );
    process.exitCode = 1;
  });
}
