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
// `closingIssuesReferences` is the only field that can disagree with the prose,
// and it acts within a second of merge (#212 merged 06:30:36Z, #205 closed
// 06:30:37Z), so there is no window in which a human could intervene.
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

  if (!ok) {
    console.error(`\n${formatViolations(violations)}`);
    process.exitCode = 1;
    return;
  }

  console.log('No gate issue is armed.');
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
