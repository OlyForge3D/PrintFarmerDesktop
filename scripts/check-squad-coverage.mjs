// #410: 61% of one night's issues (51 of 84) carried no `squad:*` label. Each
// one still had a real, reproducible finding behind it -- what was skipped was
// the cheap final step. `squad:{member}` is the only mechanism this squad has
// for finding work: a member looking for their queue runs a label filter, and
// an issue with none is not unassigned, it is undiscoverable. Manual triage in
// prior rounds has since routed all 51 (verified live below, not re-done
// here); this script exists so that class of regression cannot recur
// silently.
//
// SCOPE, stated as narrowly as the issue itself states it: this enforces
// COVERAGE, not correctness. It fails when an open issue carries neither
// exactly one `squad:*` label nor `triage`. It takes no position on whether
// the assigned `squad:*` label is the RIGHT one -- that judgment belongs to
// review and to a member declining work that is not theirs, per
// `.squad/routing.md`. A check that tried to grade routing correctness would
// be exactly the kind of vacuous assertion #410 warns against.
//
// This is unrelated to #299 (label-index staleness on removals reconciling
// late in a search index) -- that mechanism is untouched by this file.
//
// Negative arm: `--fixture <path>` reads a JSON array of {number, labels}
// instead of calling `gh`, so the failing case can be demonstrated without
// filing a disruptive real issue onto the live board. `labels` may be either
// an array of strings or an array of `{name: string}` objects, mirroring both
// a hand-written fixture and a `gh`-shaped label list.
//
// Live reads use `gh api --paginate --slurp repos/{owner}/{repo}/issues` (not
// `gh issue list --limit N`): the REST issues endpoint mixes in pull requests
// (filtered out below via the `pull_request` key), and a fixed `--limit`
// silently drops issue 501 onward the moment the open board crosses it --
// exactly the kind of undetectable coverage gap #410 exists to prevent.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SQUAD_LABEL_PATTERN = /^squad:/;
const TRIAGE_LABEL = 'triage';

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : undefined;
}

function positiveInteger(value, description) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${description} must be a positive safe integer`);
  }
  return value;
}

/**
 * Normalize one issue's label list to plain strings. Accepts both
 * `gh issue list --json ...labels` shape (`{name, id, ...}[]`) and a bare
 * `string[]`, so the same evaluator can be driven by a live read or a
 * hand-written fixture without a translation layer in between.
 */
export function normalizeLabels(rawLabels, description) {
  if (!Array.isArray(rawLabels)) {
    throw new TypeError(`${description} must be an array`);
  }
  return rawLabels.map((label, index) => {
    if (typeof label === 'string') {
      if (label.trim() === '') {
        throw new TypeError(`${description}[${index}] is an empty string`);
      }
      return label;
    }
    const record = asRecord(label);
    const name = record?.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError(`${description}[${index}] has no string "name"`);
    }
    return name;
  });
}

/**
 * Parse and validate a JSON payload of open issues, from either `gh issue
 * list --json number,labels,url` (a single JSON array) or a fixture file of
 * the same shape.
 */
export function parseOpenIssues(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('open issue payload is not valid JSON', { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError('open issue payload must be a JSON array');
  }
  const seen = new Set();
  return parsed.map((value, index) => {
    const record = asRecord(value);
    const number = positiveInteger(
      record?.number,
      `open issue payload[${index}].number`,
    );
    if (seen.has(number)) {
      throw new Error(`open issue payload repeats issue #${number}`);
    }
    seen.add(number);
    const labels = normalizeLabels(
      record?.labels,
      `open issue #${number} labels`,
    );
    const url = typeof record?.url === 'string' ? record.url : undefined;
    return { number, labels, url };
  });
}

/**
 * Whether one issue carries exactly one `squad:*` label, or `triage`.
 * Neither of the two is treated as sufficient on its own beyond what the
 * issue specifies: two `squad:*` labels with no `triage` still fails, because
 * "exactly one" is the stated bar, not "at least one".
 */
export function classifyIssueCoverage(issue) {
  const squadLabels = issue.labels.filter((label) =>
    SQUAD_LABEL_PATTERN.test(label),
  );
  const hasTriage = issue.labels.includes(TRIAGE_LABEL);
  const covered = squadLabels.length === 1 || hasTriage;
  return { number: issue.number, labels: issue.labels, squadLabels, covered };
}

/**
 * Enumerate every open issue and report which ones carry neither exactly one
 * `squad:*` label nor `triage`.
 */
export function evaluateSquadCoverage(issues) {
  if (!Array.isArray(issues)) {
    throw new TypeError('issues must be an array');
  }
  const classifications = issues.map(classifyIssueCoverage);
  const offenders = classifications
    .filter((entry) => !entry.covered)
    .map(({ number, labels }) => ({ number, labels }))
    .sort((a, b) => a.number - b.number);
  return {
    totalOpenIssues: issues.length,
    coveredCount: classifications.length - offenders.length,
    offenders,
  };
}

export function formatOffenderLine(offender) {
  const labelList =
    offender.labels.length > 0 ? offender.labels.join(', ') : '(no labels)';
  return `  #${offender.number}: ${labelList}`;
}

export function formatReport(result) {
  const lines = [
    `[squad-coverage] open issues ${result.totalOpenIssues}; covered ${result.coveredCount}; offenders ${result.offenders.length}`,
  ];
  if (result.offenders.length === 0) {
    lines.push(
      '[squad-coverage] OK: every open issue carries exactly one squad:* label or triage',
    );
    return lines.join('\n');
  }
  lines.push(
    `[squad-coverage] FAILED: ${result.offenders.length} open issue(s) carry neither exactly one squad:* label nor triage:`,
  );
  for (const offender of result.offenders) {
    lines.push(formatOffenderLine(offender));
  }
  return lines.join('\n');
}

/**
 * Run a `gh` invocation and return its stdout.
 *
 * A non-zero exit is always a failure, even when `gh` happened to write
 * something to stdout first (a partial page, a warning line, etc.) --
 * treating "there was some stdout" as "the read succeeded" is exactly the
 * kind of silent-truncation failure this script exists to prevent one layer
 * up in `readOpenIssues`, so it must not also be present here.
 */
export function runGitHub(args, execute = execFileSync) {
  const options = {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  return execute('gh', args, options);
}

function defaultRun(args) {
  return runGitHub(args);
}

/**
 * Parse every page returned by `gh api --paginate --slurp`, and drop the
 * pull requests that GitHub's `/issues` endpoint mixes into the same list.
 *
 * Keeping the page boundary in the response (an array of arrays) rather than
 * flattening at the `gh` layer makes truncation visible to a test the same
 * way `check-closing-references.mjs`'s `parsePullRequestCommitResponse` does
 * for PR commits -- a `--limit`-style cap here would silently miss issue 501
 * onward the moment the open-issue count crosses it, which is precisely the
 * "undiscoverable, and now undetectably so" failure #410 exists to prevent.
 */
export function parsePaginatedIssuesResponse(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('expected the open issues response to be a string');
  }
  let pages;
  try {
    pages = JSON.parse(raw);
  } catch (cause) {
    throw new Error('open issues response is not valid JSON', { cause });
  }
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new TypeError(
      'open issues response is not an array of pages; refusing to report zero offenders from an unreadable response',
    );
  }
  const seen = new Set();
  return pages.flatMap((page) =>
    page
      .filter((entry) => asRecord(entry)?.pull_request === undefined)
      .map((entry) => {
        const record = asRecord(entry);
        const number = positiveInteger(
          record?.number,
          'open issues response entry.number',
        );
        if (seen.has(number)) {
          throw new Error(`open issues response repeats issue #${number}`);
        }
        seen.add(number);
        const labels = normalizeLabels(
          record?.labels,
          `open issue #${number} labels`,
        );
        const url =
          typeof record?.html_url === 'string' ? record.html_url : undefined;
        return { number, labels, url };
      }),
  );
}

export function readOpenIssues({ run }) {
  const raw = run([
    'api',
    '--paginate',
    '--slurp',
    'repos/{owner}/{repo}/issues?state=open&per_page=100',
  ]);
  return parsePaginatedIssuesResponse(raw);
}

export function readFixtureIssues(path) {
  return parseOpenIssues(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  const fixtureIndex = argv.indexOf('--fixture');
  if (fixtureIndex < 0) {
    return { fixturePath: undefined };
  }
  const fixturePath = argv[fixtureIndex + 1];
  if (!fixturePath) {
    throw new Error('--fixture requires a path to a JSON fixture file');
  }
  return { fixturePath };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const run = deps.run ?? defaultRun;
  const output = deps.output ?? console.log;
  const readFixture = deps.readFixture ?? readFixtureIssues;
  const readLive = deps.readLive ?? readOpenIssues;
  const { fixturePath } = parseArgs(argv);

  const issues = fixturePath ? readFixture(fixturePath) : readLive({ run });

  const result = evaluateSquadCoverage(issues);
  output(formatReport(result));
  if (result.offenders.length > 0) {
    process.exitCode = 1;
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `[squad-coverage] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
