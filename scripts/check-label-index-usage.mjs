// Bans the label-search index as an AUTHORIZING read for scripts and workflows.
//
// No shebang: this module is imported by tests/labelIndexUsage.test.ts, and
// vite's transform does not strip one the way node does — the same lesson
// repeated at the top of check-pr-closure-scope.mjs, check-sequencing-hold.mjs
// and lift-hold-on-close.mjs.
//
// #299, measured over 27+ hours on this repository: `gh pr list --label`, the
// REST `issues?labels=` collection filter, and `search/issues?q=...label:` all
// read the SAME lagged copy of the label field, and that copy has one cell
// that never reconciles — a label REMOVED from a MERGED pull request. Five
// objects with `labels: []` were still returned by that filter more than a day
// after the removal, byte-identical across re-runs. The failure direction is
// over-reporting: a stale row looks like a live one, an audit "confirms" a
// hold that was already lifted, and re-running the query — the normal
// response to distrusting a result — reproduces the same wrong answer.
//
// `.squad/holds.md` already carries this as prose ("current labels are a
// mutable summary of an immutable log; the search index is a lagged copy of
// that summary"). Prose is not a control: nothing stopped the exact pattern
// from being reintroduced by a future script that had not read it. This file
// is the mechanical half — the "lint against --label in scripts" #299 asked
// for as the durable remedy, alongside the documented substitute holds.md
// already states.
//
// WHAT THIS DOES NOT BAN: `scripts/lift-hold-on-close.mjs` queries the search
// API to find CANDIDATES, then re-reads every candidate at the object
// (`GET /repos/.../pulls/{n}`) before deciding to remove anything — the
// object read, not the index read, authorizes the write. That is the correct
// shape and is allowlisted below with the reason recorded. What is banned is
// the shape where a label-index result is trusted directly, with no
// object-level re-read in between the index answer and the decision it feeds.
// A mechanical scan cannot verify "re-reads before acting" for arbitrary
// future code, so the allowlist is deliberately narrow and requires a written
// reason (mirrors UNINVOKED_SCRIPTS in check-script-reachability.mjs) — a
// script that wants to use one of these patterns must say, in the diff, why
// its shape does not repeat #299.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Directories this check scans. Everything else — docs, `.squad/`, markdown
 * discussing the defect — is deliberately out of scope: this guard targets
 * automation that could act on a stale answer, not prose that explains one.
 * `.squad/holds.md` legitimately quotes `gh pr list --label` at length as a
 * worked example of the defect, and a scan that could not tell "documents the
 * bug" from "commits the bug" would either miss real occurrences by excluding
 * markdown everywhere, or nag every retelling of this issue forever.
 */
export const SCANNED_DIRECTORIES = ['scripts/', '.github/workflows/'];

/**
 * Each pattern names one surface that answers "which objects carry this
 * label" from the index rather than the object, per the three-instrument
 * table in `.squad/holds.md`: `issues/{n}/labels` (object, safe, not matched
 * here), `gh pr list --label` / `gh issue list --label` (index), the REST
 * list-filtered-by-label endpoint, and the search API's `label:` qualifier.
 * `gh pr view`/`gh api repos/.../issues/{n}/labels` are per-object reads and
 * are deliberately not matched — they are the safe instrument, not the
 * hazard.
 */
export const LABEL_INDEX_PATTERNS = [
  {
    name: 'gh pr list --label',
    pattern: /\bgh\s+pr\s+list\b[^\n]*--label\b/,
  },
  {
    name: 'gh issue list --label',
    pattern: /\bgh\s+issue\s+list\b[^\n]*--label\b/,
  },
  {
    name: 'REST issues collection filtered by label',
    pattern: /\/issues\?[^\s'"]*\blabels=/,
  },
  {
    name: 'search API label: qualifier',
    pattern: /search\/issues[^\n]*label:|[?&]q=[^\s'"]*label(?:s|%3A|:)/,
  },
];

/**
 * Files permitted to contain a matched pattern, each with a mandatory,
 * non-empty reason. An allowlist entry without a reason is indistinguishable
 * from deleting the check for that file one line at a time — the same
 * requirement `check-script-reachability.mjs` states for `UNINVOKED_SCRIPTS`.
 */
export const ALLOWED_LABEL_INDEX_USAGE = Object.freeze({
  'scripts/lift-hold-on-close.mjs':
    '#299: findMergedPullRequestsCarryingHolds() queries the search API for ' +
    'CANDIDATES only. Every candidate is re-read at the object ' +
    '(fetchPullRequest -> GET /repos/.../pulls/{n}) before evaluateHoldsToLift ' +
    'decides anything, and a backfill that selects N candidates and lifts ' +
    'zero is documented as the expected steady state, not a fault. The index ' +
    'answer never authorizes the write by itself.',
  'scripts/check-dated-measurement.mjs':
    'A comment quotes `gh issue list --label squad --state open` as one of two ' +
    'worked, dated examples of #462 (a stale claim composed between a read and ' +
    "a send). It is prose describing a past incident's output, not a command " +
    'this file executes -- fetchLiveUpdatedAt() reads `issues/{n}` per object, ' +
    'never a label list. A scan that cannot tell "quoted as an example" from ' +
    '"executed" would either need to parse comments out of every scanned ' +
    'language, or exclude this file by name; the latter is cheaper and this is ' +
    'the reason recorded, same as .squad/holds.md is out of scope entirely for ' +
    'quoting the identical CLI shape at length.',
});

/**
 * Scans a set of `{ path, contents }` records for the banned patterns.
 *
 * Pure: takes files as data rather than reading the filesystem itself, so the
 * rule is testable without git or a real checkout — the same shape
 * `evaluateScriptReachability` uses in check-script-reachability.mjs.
 */
export function scanLabelIndexUsage({ files, allowlist } = {}) {
  const known = allowlist ?? ALLOWED_LABEL_INDEX_USAGE;
  const violations = [];
  const allowlisted = [];

  for (const file of files ?? []) {
    const matches = [];
    for (const { name, pattern } of LABEL_INDEX_PATTERNS) {
      if (pattern.test(file.contents)) {
        matches.push(name);
      }
    }
    if (matches.length === 0) continue;

    if (Object.prototype.hasOwnProperty.call(known, file.path)) {
      const reason = known[file.path];
      if (typeof reason !== 'string' || reason.trim() === '') {
        violations.push({
          path: file.path,
          matches,
          reason:
            'allowlisted with an empty reason, which is not a justification — ' +
            'an allowlist entry must say why its shape does not repeat #299',
        });
        continue;
      }
      allowlisted.push({ path: file.path, matches, reason });
      continue;
    }

    violations.push({
      path: file.path,
      matches,
      reason:
        'uses the label search/list index (gh pr list --label, gh issue list ' +
        '--label, or an equivalent REST/search filter) with no allowlist ' +
        'entry. #299: that index does not reconcile a label REMOVED from a ' +
        'MERGED/closed pull request — measured stale for 27+ hours — so a ' +
        'decision fed by its answer alone can act on a label that is already ' +
        'gone. Read per-object (`gh api repos/<r>/issues/<n>/labels`) instead, ' +
        'or add an allowlist entry here explaining the re-read that makes ' +
        'this occurrence safe.',
    });
  }

  return { violations, allowlisted };
}

export function formatViolation({ path: filePath, matches, reason }) {
  return [
    `  ${filePath}`,
    `    matched: ${matches.join(', ')}`,
    `    ${reason}`,
  ].join('\n');
}

function gitLsFiles(directory) {
  return execFileSync('git', ['ls-files', '--', directory], {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

/**
 * Every tracked file under `SCANNED_DIRECTORIES`, excluding this file and its
 * `.d.mts` sibling — a scanner that could flag itself by naming the patterns
 * it forbids would fail on every commit that documents what it does, which is
 * exactly this comment block. `forbiddenJobLiteral.test.ts` names the same
 * hazard for a string literal; here the constants are regular expressions, so
 * the risk is naming the CLI shape in prose (this file's own header), not
 * matching it — kept out of the scan by directory scope alone.
 */
export function collectScannedFiles({
  readFile = (path) => readFileSync(path, 'utf8'),
  listFiles = gitLsFiles,
} = {}) {
  const selfPaths = new Set([
    'scripts/check-label-index-usage.mjs',
    'scripts/check-label-index-usage.d.mts',
  ]);

  const files = [];
  const seen = new Set();
  for (const directory of SCANNED_DIRECTORIES) {
    for (const relativePath of listFiles(directory)) {
      if (seen.has(relativePath) || selfPaths.has(relativePath)) continue;
      seen.add(relativePath);
      files.push({ path: relativePath, contents: readFile(relativePath) });
    }
  }
  return files;
}

async function main() {
  const files = collectScannedFiles();
  const { violations, allowlisted } = scanLabelIndexUsage({ files });

  for (const entry of allowlisted) {
    console.log(
      `[label-index-usage] allowlisted: ${entry.path} (${entry.matches.join(', ')})`,
    );
  }

  if (violations.length > 0) {
    console.error(
      `[label-index-usage] ${violations.length} file(s) query the label search/list ` +
        'index without an allowlist entry:\n',
    );
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    '[label-index-usage] clean: no unlisted use of the label search/list index ' +
      `across ${files.length} file(s) under ${SCANNED_DIRECTORIES.join(', ')}`,
  );
}

export { main };

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[label-index-usage] ${error.message}`);
    process.exitCode = 2;
  });
}
