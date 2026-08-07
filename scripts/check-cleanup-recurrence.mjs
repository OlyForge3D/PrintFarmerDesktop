// Classifies whether the npm-ci-strict Windows cleanup signature has recurred
// across distinct commit SHAs on first-attempt (run_attempt=1) workflow runs.
//
// This is deliberately a manual advisory, not a required status context. It
// must not become required until its workflow is demonstrated to emit at every
// position it would gate, including merge_group. Advisory does not mean
// success-shaped: findings exit 1, while an unreadable or moving scan exits 2.
//
// The canonical source of evidence is the durable cleanup-failure record
// published by publish-npm-cleanup-evidence.mjs onto tracking issue #274.
// Reading from there reuses the existing evidence-publication infrastructure
// rather than introducing a second unbounded query path. Comments are permanent;
// a later green run on any commit never removes or relabels an earlier entry.
//
// How this differs from check-rerun-masked-failures.mjs (#356/#580):
//   That tool asks: "did a required context fail on a superseded attempt of
//   THIS run?" — the hazard is a rerun laundering one run's red into green.
//   This tool asks: "does the cleanup failure appear on TWO OR MORE distinct
//   commit SHAs, each on its own first attempt?" — the hazard is that the
//   next commit's green launders a prior commit's true positive into a flake.
//   The two laundering agents, and the two tools that detect them, are
//   deliberately separate.
//
// Fail-closed contract:
//   A positive recurrence claim requires unambiguous evidence. Any API
//   failure, malformed payload, partial response, or ambiguous zero causes
//   this tool to exit 2 (UNDETERMINED) rather than 0 (clean). The only
//   safe-to-call-clean state is a complete, well-formed, non-empty page
//   sequence that produced fewer than RECURRENCE_THRESHOLD distinct SHAs.

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { CLEANUP_TRACKING_ISSUE } from './publish-npm-cleanup-evidence.mjs';
import { resolveRepository } from './check-pr-closure-scope.mjs';

export const EXIT_CLEAN = 0;
export const EXIT_RECURRENCE = 1;
export const EXIT_UNDETERMINED = 2;

// Minimum number of distinct first-attempt commit SHAs carrying the cleanup
// signature required to report recurrence. At 1 the tool would fire on a
// single isolated occurrence; at 2 it requires at least two separate commits
// to be affected, matching the statistical claim in issue #450.
export const RECURRENCE_THRESHOLD = 2;

// Maximum number of issue comments to examine. The value is large enough to
// cover historical data while keeping the scan bounded. Pagination is handled
// within this limit.
export const HISTORY_COMMENT_LIMIT = 200;

const API_ROOT = 'https://api.github.com';
const PAGE_SIZE = 100;

// The HTML comment marker written by formatCleanupEvidenceComment. It carries
// the run ID and attempt in a machine-parseable form so classification does
// not depend on scraping the human-readable body.
// Example: <!-- npm-cleanup-failure run=30898288869 attempt=1 job=desktop -->
const COMMENT_MARKER_PATTERN =
  /<!--\s*npm-cleanup-failure\s+run=(\d+)\s+attempt=(\d+)\s+job=([A-Za-z0-9_-]+)\s*-->/;

// The head SHA line written by formatCleanupEvidenceComment.
// Example: - **Head:** `a3edb245687cc85f1cacdaf9b09e72e38fd67d70`
const HEAD_LINE_PATTERN = /\*\*Head:\*\*\s+`([0-9a-f]{40})`/i;

function apiHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
}

async function requestJson(url, token, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, { headers: apiHeaders(token) });
  } catch (error) {
    throw new Error(
      `GitHub API network error at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `GitHub API rate-limited or forbidden: ${response.status} ${response.statusText} (${url})`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText} (${url})`,
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `GitHub API returned unparseable JSON at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return payload;
}

/**
 * Parse one issue comment body.
 *
 * Returns null if the comment does not carry the cleanup-failure marker —
 * non-cleanup comments are common on the tracking issue and are not errors.
 *
 * Throws if the marker IS present but the body is malformed, because a
 * marker with a missing or broken head SHA is ambiguous: we cannot confirm
 * the entry is harmless and must treat it as an obstacle (fail closed).
 *
 * @param {string} body
 * @returns {{ runId: string; runAttempt: string; job: string; headSha: string } | null}
 */
export function parseCleanupComment(body) {
  if (typeof body !== 'string') {
    throw new TypeError('comment body must be a string');
  }
  const markerMatch = COMMENT_MARKER_PATTERN.exec(body);
  if (!markerMatch) return null;

  const runId = markerMatch[1];
  const runAttempt = markerMatch[2];
  const job = markerMatch[3];

  const headMatch = HEAD_LINE_PATTERN.exec(body);
  if (!headMatch) {
    throw new Error(
      `cleanup comment for run ${runId} attempt ${runAttempt} has the cleanup-failure marker but no parseable 40-char head SHA`,
    );
  }

  return {
    runId,
    runAttempt,
    job,
    headSha: headMatch[1].toLowerCase(),
  };
}

/**
 * Fetch cleanup-evidence issue comments in reverse-chronological order,
 * bounded to at most `limit` comments.
 *
 * Pagination is handled within the bound; each page is validated before
 * the next is requested. An empty response on the first page is NOT
 * automatically an error — the tracking issue may be new or have no
 * cleanup evidence yet. Callers distinguish "empty history" from errors
 * by inspecting the returned array length and the `bounded` flag.
 *
 * @returns {{ comments: object[]; bounded: boolean }}
 *   bounded: true if the scan reached the limit without exhausting the issue;
 *            false if the scan exhausted the issue before the limit.
 */
export async function fetchCleanupHistory({
  owner,
  repo,
  issueNumber = CLEANUP_TRACKING_ISSUE,
  limit = HISTORY_COMMENT_LIMIT,
  token,
  fetchImpl = fetch,
}) {
  const comments = [];
  let page = 1;
  let bounded = false;

  while (comments.length < limit) {
    const remaining = limit - comments.length;
    const perPage = Math.min(PAGE_SIZE, remaining);
    const url =
      `${API_ROOT}/repos/${owner}/${repo}/issues/${issueNumber}/comments` +
      `?per_page=${perPage}&page=${page}&direction=desc`;

    const payload = await requestJson(url, token, fetchImpl);

    if (!Array.isArray(payload)) {
      throw new Error(
        `cleanup history page ${page} returned a non-array response; body type: ${typeof payload}`,
      );
    }

    for (const comment of payload) {
      if (typeof comment?.body !== 'string') {
        throw new Error(
          `cleanup history page ${page} comment ${comment?.id ?? 'unknown'} has no string body`,
        );
      }
      comments.push(comment);
    }

    if (payload.length < perPage) {
      // This is the last page; the issue has no more comments.
      break;
    }

    if (comments.length >= limit) {
      // We reached the scan bound without exhausting the issue.
      bounded = true;
      break;
    }

    page += 1;
  }

  return { comments, bounded };
}

/**
 * Parse all comments and classify recurrence.
 *
 * Only first-attempt (run_attempt === "1") entries contribute to the
 * distinct-SHA count. Later reruns of the same run on the same SHA do not
 * add evidence of cross-commit recurrence, even if the rerun also failed.
 *
 * A later successful run on a different commit does NOT remove or relabel
 * any prior entry from the tracking issue; the history is permanent.
 *
 * @param {object[]} comments Raw issue comment objects with .body strings.
 * @returns {{
 *   parsed: Array<{runId:string,runAttempt:string,job:string,headSha:string}>;
 *   firstAttemptEntries: Array<{runId:string,runAttempt:string,job:string,headSha:string}>;
 *   distinctShas: string[];
 *   recurring: boolean;
 * }}
 */
export function classifyRecurrence(comments) {
  const parsed = [];
  const firstAttemptBySha = new Map();

  for (const comment of comments) {
    const entry = parseCleanupComment(comment.body);
    if (!entry) continue;

    parsed.push(entry);

    if (entry.runAttempt !== '1') continue;

    if (!firstAttemptBySha.has(entry.headSha)) {
      firstAttemptBySha.set(entry.headSha, []);
    }
    firstAttemptBySha.get(entry.headSha).push({
      runId: entry.runId,
      job: entry.job,
    });
  }

  const distinctShas = [...firstAttemptBySha.keys()];
  const recurring = distinctShas.length >= RECURRENCE_THRESHOLD;

  return {
    parsed,
    firstAttemptEntries: parsed.filter((e) => e.runAttempt === '1'),
    distinctShas,
    firstAttemptBySha,
    recurring,
  };
}

/**
 * Format a human-readable advisory report.
 */
export function formatRecurrenceReport({
  classification,
  scope: { commentsExamined, bounded, issueNumber, owner, repo },
}) {
  const { parsed, firstAttemptEntries, distinctShas, recurring } =
    classification;

  const lines = [
    `npm-ci-strict cleanup recurrence advisory`,
    `  tracking issue               : ${owner}/${repo}#${issueNumber}`,
    `  comments examined            : ${commentsExamined}${bounded ? ` (bounded at ${HISTORY_COMMENT_LIMIT})` : ''}`,
    `  cleanup evidence comments    : ${parsed.length}`,
    `  first-attempt entries        : ${firstAttemptEntries.length}`,
    `  distinct SHAs (attempt=1)    : ${distinctShas.length}`,
    `  recurrence threshold         : ${RECURRENCE_THRESHOLD}`,
    '',
  ];

  if (distinctShas.length === 0) {
    lines.push('No cleanup-evidence comments found in the examined window.');
    lines.push(
      'This does not rule out recurrence outside the window; it records absence of evidence in scope.',
    );
  } else if (!recurring) {
    lines.push(
      `Cleanup failure found on ${distinctShas.length} distinct first-attempt SHA(s) — below the recurrence threshold of ${RECURRENCE_THRESHOLD}.`,
    );
    lines.push('Result: isolated — not classified as recurring.');
    for (const sha of distinctShas) {
      const runs = classification.firstAttemptBySha.get(sha) ?? [];
      lines.push(
        `  ${sha}  (${runs.map((r) => `run=${r.runId} job=${r.job}`).join(', ')})`,
      );
    }
  } else {
    lines.push(
      `RECURRENCE CONFIRMED: cleanup failure on ${distinctShas.length} distinct first-attempt SHA(s) ≥ threshold ${RECURRENCE_THRESHOLD}.`,
    );
    lines.push(
      'This is an environmental signal, not a code defect in any of these commits.',
    );
    lines.push('Affected SHAs (first-attempt only):');
    for (const sha of distinctShas) {
      const runs = classification.firstAttemptBySha.get(sha) ?? [];
      lines.push(
        `  ${sha}  (${runs.map((r) => `run=${r.runId} job=${r.job}`).join(', ')})`,
      );
    }
  }

  lines.push(
    '',
    'ADVISORY: this command emits no status context and is not part of branch protection.',
    'See docs/cleanup-recurrence-advisory.md for operational interpretation.',
  );

  return lines.join('\n');
}

const USAGE = `usage: npm run report:cleanup-recurrence -- [--repo owner/name] [--issue N] [--limit N]

Scans the published cleanup-failure record on the tracking issue and classifies
whether the npm-ci-strict cleanup signature has recurred across distinct commit
SHAs on run_attempt=1 workflow runs.

Exit 0 no recurrence · 1 recurrence confirmed · 2 undetermined

Options:
  --repo owner/name   Override the repository slug (default: GITHUB_REPOSITORY or gh repo view)
  --issue N           Override the tracking issue number (default: ${CLEANUP_TRACKING_ISSUE})
  --limit N           Maximum number of comments to examine (default: ${HISTORY_COMMENT_LIMIT}, max: ${HISTORY_COMMENT_LIMIT})`;

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (argument === '--repo') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
        parsed.error = '--repo requires owner/name';
      } else {
        parsed.repo = value;
      }
      continue;
    }
    if (argument === '--issue') {
      const value = argv[index + 1];
      index += 1;
      const num = Number(value);
      if (!Number.isInteger(num) || num <= 0) {
        parsed.error = '--issue requires a positive integer';
      } else {
        parsed.issueNumber = num;
      }
      continue;
    }
    if (argument === '--limit') {
      const value = argv[index + 1];
      index += 1;
      const num = Number(value);
      if (!Number.isInteger(num) || num <= 0 || num > HISTORY_COMMENT_LIMIT) {
        parsed.error = `--limit requires a positive integer not exceeding ${HISTORY_COMMENT_LIMIT}`;
      } else {
        parsed.limit = num;
      }
      continue;
    }
    parsed.error ??= `unrecognised argument ${JSON.stringify(argument)}`;
  }
  return parsed;
}

export async function main(argv, env = process.env, fetchImpl = fetch) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(USAGE);
      return EXIT_CLEAN;
    }
    if (args.error !== undefined) {
      console.error(args.error);
      console.error(USAGE);
      return EXIT_UNDETERMINED;
    }

    const token = env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN is not set');
    }

    let slug = args.repo;
    if (!slug) {
      const { owner, repo } = resolveRepository(env);
      slug = `${owner}/${repo}`;
    }
    const [owner, repo] = slug.split('/');

    const issueNumber = args.issueNumber ?? CLEANUP_TRACKING_ISSUE;
    const limit = args.limit ?? HISTORY_COMMENT_LIMIT;

    const { comments, bounded } = await fetchCleanupHistory({
      owner,
      repo,
      issueNumber,
      limit,
      token,
      fetchImpl,
    });

    const classification = classifyRecurrence(comments);
    const report = formatRecurrenceReport({
      classification,
      scope: {
        commentsExamined: comments.length,
        bounded,
        issueNumber,
        owner,
        repo,
      },
    });

    console.log(report);

    return classification.recurring ? EXIT_RECURRENCE : EXIT_CLEAN;
  } catch (error) {
    console.error(
      `cleanup-recurrence scan undetermined: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return EXIT_UNDETERMINED;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
