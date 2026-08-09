/**
 * Companion audit for #670: verify every non-merge commit reachable from
 * `development` carries a well-formed `Copilot-Session` trailer, and flag any
 * value that repeats across a span wider than a single session's lifetime
 * could plausibly be.
 *
 * WHY A SEPARATE CHECK FROM `check-copilot-session-trailers.mjs`
 *
 * That check judges one pull request's commits for SHAPE only -- is each
 * trailer value a canonical UUID. It cannot see collisions, because a
 * collision is a property of the trailer's HISTORY across many commits and
 * many merges, not of any one commit or any one PR. The measured defect this
 * issue exists for (`.squad/decisions.md`, 2026-08-07) was invisible to a
 * per-PR shape check by construction: 74 commits each carried a
 * perfectly-well-formed UUID, and the defect was that all 74 carried the
 * SAME one, across 39h33m -- longer than any single session runs. This
 * script is the audit that measurement needed and did not have.
 *
 * WHAT "NON-MERGE, NON-SQUASH-FLATTENED" MEANS HERE
 *
 * `git log --no-merges` already excludes merge commits (>1 parent), which
 * covers "non-merge" directly. "Squash-flattened" needs an explanation
 * because this repository's own merge settings make it non-obvious:
 * `squash_merge_commit_message: "COMMIT_MESSAGES"` (measured via
 * `gh api repos/{owner}/{repo}`) means GitHub builds a squashed commit's body
 * by CONCATENATING every squashed commit's full message, trailers included.
 * But `git interpret-trailers` -- the same tool
 * `check-copilot-session-trailers.mjs` delegates to, deliberately kept
 * consistent here -- only recognises the LAST contiguous paragraph of a
 * message as its trailer block:
 *
 *   commit1 msg\n\nCopilot-Session: AAAA\n\ncommit2 msg\n\nCopilot-Session: BBBB
 *   -> `git interpret-trailers --parse` reports ONLY "Copilot-Session: BBBB"
 *
 * So every squashed commit that reaches `development` already has its
 * pre-squash sub-history's trailers flattened down to the one trailer git
 * itself will still recognise -- there is no earlier, richer signal this
 * script could dig out of a squash commit's body, and there is no separate
 * "was this squash-flattened" test to write: `git interpret-trailers` IS that
 * flattening, applied uniformly to every commit `git log` returns, squashed
 * or not. This script therefore does not special-case squash commits at all;
 * treating every non-merge commit identically already gives the right
 * answer for both shapes.
 *
 * THE COLLISION HEURISTIC
 *
 * Well-formed trailer values are grouped, and for each value the span between
 * its earliest and latest commit's AUTHOR date is compared against a
 * configurable session-lifetime bound. A span past the bound cannot be one
 * session's own work sharing its own id honestly -- it is either the
 * hand-typed-and-stale-copied pattern #670 exists to end, or a regression
 * back into it -- so it is flagged. The bound is deliberately generous rather
 * than tight: this audit's job is to catch a REGRESSION to the 39h33m
 * pattern, not to police every session's actual working hours, and a bound
 * that is too eager to flag legitimate variance trains the same
 * override-and-ignore reflex `.squad/decisions/inbox/vasquez-override-is-a-global-habit.md`
 * documents for other checks.
 *
 * WHY `--since` EXISTS AND WHY THE WORKFLOW THAT RUNS THIS MUST PASS IT
 *
 * #670 explicitly leaves existing collided history alone (acceptance
 * criterion 5) -- it is a prevention mechanism, not a backfill. An unbounded
 * `git log origin/development` still contains the measured 74-commit,
 * 39h33m collision from before this hook existed, so running this script
 * over the branch's full lifetime would fail on day one and stay failed
 * forever on history nothing here can fix, which is exactly the "permanently
 * red check" failure mode `scripts/check-merge-landed.mjs`'s own header
 * warns about. `--since` (forwarded to `git log --since=<expr>`) bounds the
 * audit to a recent window; the scheduled workflow that runs this script in
 * CI is responsible for passing a `--since` no older than this check's own
 * introduction, the same way `merge-landed.yml` passes `--limit` rather than
 * this script hardcoding a policy value that would need a code change to
 * retune.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

import { COPILOT_SESSION_UUID } from './check-copilot-session-trailers.mjs';

/** Default session-lifetime bound, in hours. Overridable via `--max-hours`
 * or the `COPILOT_SESSION_LIFETIME_HOURS` environment variable -- the CLI
 * flag wins if both are given. 39h33m was the measured collision this issue
 * responds to; 24h is comfortably below that while still well above how long
 * this repository's sessions are observed to run in practice. */
export const DEFAULT_MAX_SESSION_HOURS = 24;

const FIELD = '\x1f';
const RECORD = '\x1e';

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

/**
 * @param {string} ref
 * @param {typeof run} [git]
 * @param {string} [since] Passed through to `git log --since=<since>`.
 *   Bounds the audit to a recent window rather than the full lifetime of the
 *   branch -- see the module header on why an unbounded run would
 *   permanently fail on the collided history #670 deliberately leaves alone.
 * @returns {{ sha: string, authorDate: Date, message: string }[]}
 */
export function readNonMergeCommits(ref, git = run, since) {
  const args = [
    'log',
    '--no-merges',
    `--format=%H${FIELD}%aI${FIELD}%B${RECORD}`,
  ];
  if (since) {
    args.push(`--since=${since}`);
  }
  args.push(ref);
  const output = git('git', args);
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, '').replace(/\n+$/, ''))
    .filter((record) => record.length > 0)
    .map((record) => {
      const separatorA = record.indexOf(FIELD);
      const separatorB = record.indexOf(FIELD, separatorA + 1);
      const sha = record.slice(0, separatorA);
      const authorDateRaw = record.slice(separatorA + 1, separatorB);
      const message = record.slice(separatorB + 1);
      const authorDate = new Date(authorDateRaw);
      if (Number.isNaN(authorDate.getTime())) {
        throw new Error(
          `commit ${sha} has an unparseable author date: ${JSON.stringify(authorDateRaw)}`,
        );
      }
      return { sha, authorDate, message };
    });
}

/**
 * Every `Copilot-Session` trailer value on a commit, classified well-formed
 * or not. A commit with zero trailers is reported separately by the caller
 * (missing is not the same finding as malformed).
 *
 * @param {string} message
 * @param {typeof run} [interpret]
 * @returns {string[]}
 */
export function parseSessionTrailerValues(message, interpret = run) {
  const parsed = interpret('git', ['interpret-trailers', '--parse'], {
    input: message,
  });
  const values = [];
  for (const line of parsed.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key.toLowerCase() === 'copilot-session') {
      values.push(line.slice(separator + 1).trim());
    }
  }
  return values;
}

/**
 * @param {{ sha: string, authorDate: Date, message: string }[]} commits
 * @param {typeof run} [interpret]
 * @returns {{
 *   missing: { sha: string }[],
 *   malformed: { sha: string, value: string }[],
 * }}
 */
export function findFormednessFindings(commits, interpret = run) {
  const missing = [];
  const malformed = [];
  for (const commit of commits) {
    const values = parseSessionTrailerValues(commit.message, interpret);
    if (values.length === 0) {
      missing.push({ sha: commit.sha });
      continue;
    }
    for (const value of values) {
      if (!COPILOT_SESSION_UUID.test(value)) {
        malformed.push({ sha: commit.sha, value });
      }
    }
  }
  return { missing, malformed };
}

/**
 * Groups commits by well-formed trailer value and flags any value whose
 * earliest and latest commit author dates are farther apart than
 * `maxSessionHours`.
 *
 * @param {{ sha: string, authorDate: Date, message: string }[]} commits
 * @param {number} maxSessionHours
 * @param {typeof run} [interpret]
 * @returns {{
 *   value: string,
 *   count: number,
 *   spanHours: number,
 *   firstSha: string,
 *   lastSha: string,
 * }[]}
 */
export function findSessionLifetimeViolations(
  commits,
  maxSessionHours,
  interpret = run,
) {
  if (!Number.isFinite(maxSessionHours) || maxSessionHours <= 0) {
    throw new Error(
      `max session hours must be a positive number, got ${JSON.stringify(maxSessionHours)}`,
    );
  }

  const byValue = new Map();
  for (const commit of commits) {
    for (const value of parseSessionTrailerValues(commit.message, interpret)) {
      if (!COPILOT_SESSION_UUID.test(value)) {
        continue; // malformed values are `findFormednessFindings`'s finding
      }
      if (!byValue.has(value)) {
        byValue.set(value, []);
      }
      byValue.get(value).push(commit);
    }
  }

  const violations = [];
  for (const [value, groupCommits] of byValue) {
    const sorted = [...groupCommits].sort(
      (a, b) => a.authorDate.getTime() - b.authorDate.getTime(),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const spanHours =
      (last.authorDate.getTime() - first.authorDate.getTime()) /
      (60 * 60 * 1000);
    if (spanHours > maxSessionHours) {
      violations.push({
        value,
        count: sorted.length,
        spanHours,
        firstSha: first.sha,
        lastSha: last.sha,
      });
    }
  }
  return violations.sort((a, b) => b.spanHours - a.spanHours);
}

export function formatReport({
  missing,
  malformed,
  violations,
  maxSessionHours,
}) {
  const lines = [];
  if (missing.length > 0) {
    lines.push(
      `${missing.length} commit(s) with no Copilot-Session trailer at all:`,
      ...missing.map(({ sha }) => `  ${sha.slice(0, 12)}`),
      '',
    );
  }
  if (malformed.length > 0) {
    lines.push(
      `${malformed.length} malformed Copilot-Session trailer value(s):`,
      ...malformed.map(
        ({ sha, value }) => `  ${sha.slice(0, 12)}  ${JSON.stringify(value)}`,
      ),
      '',
    );
  }
  if (violations.length > 0) {
    lines.push(
      `${violations.length} Copilot-Session value(s) spanning more than ${maxSessionHours}h (regression toward the measured collision pattern):`,
      ...violations.map(
        ({ value, count, spanHours, firstSha, lastSha }) =>
          `  ${value}  ${count} commit(s)  ${spanHours.toFixed(1)}h  ${firstSha.slice(0, 12)}..${lastSha.slice(0, 12)}`,
      ),
      '',
    );
  }
  return lines.join('\n').trim();
}

function parseArgs(argv) {
  let ref = 'origin/development';
  let since;
  let maxSessionHours =
    Number.parseFloat(process.env.COPILOT_SESSION_LIFETIME_HOURS ?? '') ||
    DEFAULT_MAX_SESSION_HOURS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--max-hours') {
      maxSessionHours = Number.parseFloat(argv[index + 1]);
      index += 1;
    } else if (arg === '--ref') {
      ref = argv[index + 1];
      index += 1;
    } else if (arg === '--since') {
      since = argv[index + 1];
      index += 1;
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)}; usage: check-copilot-session-collisions.mjs [--ref <ref>] [--since <git-log-since-expr>] [--max-hours <n>]`,
      );
    }
  }
  return { ref, since, maxSessionHours };
}

export function main(argv, deps = {}) {
  const {
    readCommits = readNonMergeCommits,
    interpretTrailers = run,
    log = console.log,
    error = console.error,
  } = deps;

  const { ref, since, maxSessionHours } = parseArgs(argv);
  const commits = readCommits(ref, undefined, since);
  const { missing, malformed } = findFormednessFindings(
    commits,
    interpretTrailers,
  );
  const violations = findSessionLifetimeViolations(
    commits,
    maxSessionHours,
    interpretTrailers,
  );

  const ok =
    missing.length === 0 && malformed.length === 0 && violations.length === 0;

  if (!ok) {
    error(formatReport({ missing, malformed, violations, maxSessionHours }));
    process.exitCode = 1;
  } else {
    log(
      `Copilot-Session trailers are well-formed and non-colliding. commits=${commits.length} maxSessionHours=${maxSessionHours}`,
    );
  }

  return { ok, commits: commits.length, missing, malformed, violations };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
