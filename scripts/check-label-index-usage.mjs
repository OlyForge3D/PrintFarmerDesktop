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

import { lstatSync, readFileSync } from 'node:fs';
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
    // `-l` is documented by `gh pr list --help` as the short form of
    // `--label` -- not a guess -- so a call written as `gh pr list -l
    // hold:sequenced` reads the same lagged index under a shorter spelling.
    // Excluding it would let #299 back in through an alias of the exact flag
    // this pattern already names.
    name: 'gh pr list --label',
    pattern: /\bgh\s+pr\s+list\b[^\n]*(?:--label\b|-l\b)/,
  },
  {
    // Same short form, documented by `gh issue list --help`.
    name: 'gh issue list --label',
    pattern: /\bgh\s+issue\s+list\b[^\n]*(?:--label\b|-l\b)/,
  },
  {
    // `gh pr list --search "label:x"` and `gh issue list --search "label:x"`
    // hand the label filter to the same search index `search/issues?q=...`
    // reads directly (`--search` *is* the `q=` query, just spelled through
    // the CLI instead of the REST URL) -- the exact bypass Hicks named:
    // `--label`/`-l` were covered above, but `--search "label:..."` is a
    // third spelling of "ask the index a label question" that neither of
    // those two patterns, nor the REST/search-API patterns below (which
    // anchor on a URL, not a CLI flag), would catch.
    name: 'gh pr/issue list --search label:',
    pattern: /\bgh\s+(?:pr|issue)\s+list\b[^\n]*--search\b[^\n]*label:/,
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
 * Files permitted to contain a matched pattern. Each entry names the
 * SPECIFIC pattern(s) it excuses (`patterns`) and a mandatory, non-empty
 * `reason`.
 *
 * Scoping by pattern name, not blanket-by-file, matters because the file is
 * the unit a human reviews but not the unit the hazard occurs at: a file
 * allowlisted for one shape (say, the search API's `label:` qualifier,
 * re-read before use) offers no evidence at all about a DIFFERENT shape
 * (say, `gh pr list --label`) added to that same file next month. A
 * blanket per-file allow would let that second, unreviewed shape ride in on
 * the first shape's justification -- silently, since the file already
 * "has an allowlist entry". Requiring the entry to name which matches it
 * covers means a new match name appearing in an already-allowlisted file is
 * still reported as a violation, with its own reason required, exactly as
 * it would be in a file with no entry at all. (Line-level scoping would be
 * tighter still, but this is a text scan, not a parser: a line number is
 * only as stable as the next unrelated edit above it, so scoping on the
 * pattern's stable name -- not a position that moves under it -- is what a
 * mechanical check like this one can actually keep honest.)
 */
export const ALLOWED_LABEL_INDEX_USAGE = Object.freeze({
  'scripts/lift-hold-on-close.mjs': Object.freeze({
    patterns: Object.freeze(['search API label: qualifier']),
    reason:
      '#299: findMergedPullRequestsCarryingHolds() queries the search API for ' +
      'CANDIDATES only. Every candidate is re-read at the object ' +
      '(fetchPullRequest -> GET /repos/.../pulls/{n}) before evaluateHoldsToLift ' +
      'decides anything, and a backfill that selects N candidates and lifts ' +
      'zero is documented as the expected steady state, not a fault. The index ' +
      'answer never authorizes the write by itself. This covers ONLY the ' +
      'search-API shape measured here -- a `gh pr list --label` or `--search ' +
      'label:` call added to this file later is a different, unreviewed shape ' +
      'and must earn its own allowlist entry.',
  }),
  'scripts/check-dated-measurement.mjs': Object.freeze({
    patterns: Object.freeze(['gh issue list --label']),
    reason:
      'A comment quotes `gh issue list --label squad --state open` as one of two ' +
      'worked, dated examples of #462 (a stale claim composed between a read and ' +
      "a send). It is prose describing a past incident's output, not a command " +
      'this file executes -- fetchLiveUpdatedAt() reads `issues/{n}` per object, ' +
      'never a label list. A scan that cannot tell "quoted as an example" from ' +
      '"executed" would either need to parse comments out of every scanned ' +
      'language, or exclude this file by name; the latter is cheaper and this is ' +
      'the reason recorded, same as .squad/holds.md is out of scope entirely for ' +
      'quoting the identical CLI shape at length. Covers only the one quoted ' +
      'shape named above.',
  }),
});

/**
 * Normalizes `execFile(Sync)`/`spawn(Sync)`-style argv-array invocations of
 * `gh` into the same plain-text command shape `LABEL_INDEX_PATTERNS` already
 * matches, so `execFileSync('gh', ['pr', 'list', '--label', name])` is not
 * invisible just because its tokens are array elements instead of one
 * contiguous string. Vasquez (round 1): a scan that only read contiguous
 * text missed this shape entirely -- a script that builds argv as an array
 * (the safer pattern for shell-injection reasons, and the one this repo's
 * own scripts already use for `gh`/`git` calls) would pass through
 * undetected.
 *
 * Handles two shapes:
 *   1. The array literal written directly at the call site:
 *      `execFileSync('gh', ['pr', 'list', '--label', name])`.
 *   2. The array literal assigned to a variable first, then passed by name:
 *      `const args = ['pr', 'list', '--label', name]; execFileSync('gh',
 *      args);`. Vasquez (round 2): shape 1 alone is bypassable by the
 *      single-step refactor of naming the array before passing it -- an
 *      argument-injection-shaped evasion of the intended check, not a
 *      different feature. Resolved by finding the identifier passed as the
 *      second argument to a `'gh'` call, then locating that identifier's
 *      MOST RECENT array-literal assignment (`NAME = [...]`, with or
 *      without a `const`/`let`/`var` declarator) that appears BEFORE the
 *      call site in the file, and flattening THAT array's tokens instead.
 *      Vasquez (round 3): "most recent in the whole file" is not the same
 *      as "most recent before the call" -- a binding declared safely and
 *      then REASSIGNED to a banned form before the call (`let ghArgs =
 *      ['pr', 'list']; ghArgs = ['pr', 'list', '--label', name];
 *      execFileSync('gh', ghArgs);`) resolved to the first (safe)
 *      assignment under the original single-match `exec()`, silently
 *      ignoring the reassignment that actually reaches the call. Fixed by
 *      scanning ALL `NAME = [...]` assignments in the file and keeping the
 *      last one whose position precedes the call site -- source order is
 *      the only ordering a text scan can use as a stand-in for control
 *      flow, but it is enough to catch the reassignment shape a reviewer
 *      demonstrated without becoming a real data-flow analysis.
 *
 * Deliberately narrow beyond these two shapes: an argv assembled through
 * `.push()`, `.concat()`, spread from another variable, or any interpolated
 * (non-literal) token cannot be resolved by a text scan without executing
 * the program, so it remains unmatched -- the same limit
 * `LABEL_INDEX_PATTERNS` already has for any interpolated value, stated in
 * this file's own header comment. Widening indefinitely would turn this
 * lint into a JavaScript interpreter; the two shapes handled here are the
 * ones actually observed to matter -- the literal-at-call-site shape this
 * repo's own scripts use, and the variable-indirection (including
 * reassignment) evasions of it a reviewer demonstrated.
 */
export function flattenGhArgvInvocations(contents) {
  const flattened = [];

  const tokensFromArrayBody = (arrayBody) =>
    [...arrayBody.matchAll(/['"`]([^'"`]*)['"`]/g)].map(
      (tokenMatch) => tokenMatch[1],
    );

  // Shape 1: the array literal written directly at the call site.
  const directCallPattern = /['"]gh['"]\s*,\s*\[([\s\S]*?)]/g;
  let directCall;
  while ((directCall = directCallPattern.exec(contents)) !== null) {
    const tokens = tokensFromArrayBody(directCall[1]);
    if (tokens.length > 0) {
      flattened.push(`gh ${tokens.join(' ')}`);
    }
  }

  // Shape 2: an identifier passed as the second argument, resolved back to
  // its own array-literal assignment. `[),]` after the identifier requires
  // it to end an argument (a bare call `execFileSync('gh', args)`) or be
  // followed by another argument (an options object), not merely appear as
  // a substring of a longer expression.
  const variableCallPattern = /['"]gh['"]\s*,\s*([A-Za-z_$][\w$]*)\s*[),]/g;
  let variableCall;
  while ((variableCall = variableCallPattern.exec(contents)) !== null) {
    const varName = variableCall[1];
    const callIndex = variableCall.index;

    // Vasquez (round 3): a binding can be declared safely and then
    // REASSIGNED to a banned form before the call reads it. Scanning for
    // the first (or only) `NAME = [...]` in the whole file would resolve to
    // the original, safe declaration and miss the reassignment that
    // actually feeds `execFileSync`. Instead, walk every `NAME = [...]`
    // assignment in the file and keep the LAST one that appears before the
    // call site -- source order is the only stand-in for control flow a
    // text scan has, but it is enough to catch "declare safe, reassign
    // unsafe, then call" without becoming a real data-flow analysis.
    const assignmentPattern = new RegExp(
      `\\b${varName}\\s*=\\s*\\[([\\s\\S]*?)]`,
      'g',
    );
    let assignment;
    let mostRecentBeforeCall = null;
    while ((assignment = assignmentPattern.exec(contents)) !== null) {
      if (assignment.index >= callIndex) break;
      mostRecentBeforeCall = assignment;
    }
    if (!mostRecentBeforeCall) continue;
    const tokens = tokensFromArrayBody(mostRecentBeforeCall[1]);
    if (tokens.length > 0) {
      flattened.push(`gh ${tokens.join(' ')}`);
    }
  }

  return flattened.join('\n');
}

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
    const searchText = [file.contents, flattenGhArgvInvocations(file.contents)]
      .filter(Boolean)
      .join('\n');

    const matches = [];
    for (const { name, pattern } of LABEL_INDEX_PATTERNS) {
      if (pattern.test(searchText)) {
        matches.push(name);
      }
    }
    if (matches.length === 0) continue;

    if (Object.prototype.hasOwnProperty.call(known, file.path)) {
      const entry = known[file.path];
      const reason = typeof entry === 'string' ? entry : entry?.reason;
      const coveredPatterns =
        typeof entry === 'string' ? null : entry?.patterns;

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

      if (
        coveredPatterns == null ||
        !Array.isArray(coveredPatterns) ||
        coveredPatterns.length === 0
      ) {
        violations.push({
          path: file.path,
          matches,
          reason:
            'allowlisted with no `patterns` list naming which specific ' +
            'match(es) it covers, so it cannot be checked against future ' +
            'matches in this file — an allowlist entry must name the exact ' +
            'pattern(s) it excuses, not excuse the whole file',
        });
        continue;
      }

      const uncovered = matches.filter((m) => !coveredPatterns.includes(m));
      if (uncovered.length > 0) {
        violations.push({
          path: file.path,
          matches: uncovered,
          reason:
            `allowlisted for ${coveredPatterns.join(', ')} only, with the ` +
            `reason: "${reason}". This match is a DIFFERENT pattern the ` +
            'existing entry does not name and its reason does not address — ' +
            'a file already excused for one label-index shape earns no ' +
            'excuse for a new one added to it later. Add this pattern to the ' +
            "file's `patterns` list with its own justification, or remove it.",
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
 *
 * Vasquez: `readFileSync` follows a symbolic link to wherever it points --
 * including outside this repository -- so a tracked symlink under a scanned
 * directory could smuggle an arbitrary file's content into this scan without
 * that content ever having been reviewed as part of `scripts/` or
 * `.github/workflows/`. Every candidate is `lstat`-ed (which reports the
 * link itself, not its target) BEFORE it is read; a symlink is refused --
 * never followed -- and reported in `refusedSymlinks` instead of being
 * silently skipped or silently read. Same shape `check-calibration-
 * provenance.mjs`'s `listFiles`/`collectMarkedFiles` already use: detect via
 * `lstatSync(...).isSymbolicLink()`, refuse, report -- not resolve-and-
 * contain, which would still open and read a file this scan has no business
 * reading.
 */
export function collectScannedFiles({
  readFile = (path) => readFileSync(path, 'utf8'),
  listFiles = gitLsFiles,
  lstat = lstatSync,
} = {}) {
  const selfPaths = new Set([
    'scripts/check-label-index-usage.mjs',
    'scripts/check-label-index-usage.d.mts',
  ]);

  const files = [];
  const refusedSymlinks = [];
  const seen = new Set();
  for (const directory of SCANNED_DIRECTORIES) {
    for (const relativePath of listFiles(directory)) {
      if (seen.has(relativePath) || selfPaths.has(relativePath)) continue;
      seen.add(relativePath);

      if (lstat(relativePath).isSymbolicLink()) {
        refusedSymlinks.push(relativePath);
        continue;
      }

      files.push({ path: relativePath, contents: readFile(relativePath) });
    }
  }
  return { files, refusedSymlinks };
}

async function main() {
  const { files, refusedSymlinks } = collectScannedFiles();
  const { violations, allowlisted } = scanLabelIndexUsage({ files });

  for (const entry of allowlisted) {
    console.log(
      `[label-index-usage] allowlisted: ${entry.path} (${entry.matches.join(', ')})`,
    );
  }

  if (refusedSymlinks.length > 0) {
    console.error(
      `[label-index-usage] ${refusedSymlinks.length} tracked symbolic link(s) ` +
        'under a scanned directory were refused, not read (a symlink can ' +
        "point outside this repository, and following it isn't reviewable " +
        'as part of this scan):\n',
    );
    for (const symlinkPath of refusedSymlinks) {
      console.error(`  ${symlinkPath}`);
    }
    process.exitCode = 1;
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
  }

  if (refusedSymlinks.length > 0 || violations.length > 0) {
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
