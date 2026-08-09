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
import path from 'node:path';
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
    // Ripley: `gh search issues`/`gh search prs` are a THIRD gh subcommand
    // family (distinct from `gh pr list`/`gh issue list`) that reads the
    // same search index directly -- `gh search issues --help` documents
    // `--label` as "Filter on label" against the search endpoint, and the
    // bare `label:x` query keyword (e.g. `gh search issues label:bug`) is
    // the identical qualifier the search-API pattern below already catches
    // when spelled as a URL query string. Neither `gh pr list`/`gh issue
    // list` patterns above nor the URL-anchored REST/search patterns below
    // would match `gh search issues --label hold:sequenced`, since it is
    // neither `pr list`/`issue list` nor a URL.
    name: 'gh search issues/prs --label',
    pattern: /\bgh\s+search\s+(?:issues|prs)\b[^\n]*(?:--label\b|\blabel:)/,
  },
  {
    name: 'REST issues collection filtered by label',
    pattern: /\/issues\?[^\s'"]*\blabels=/,
  },
  {
    name: 'search API label: qualifier',
    pattern: /search\/issues[^\n]*label:|[?&]q=[^\s'"]*label(?:s|%3A|:)/,
  },
  {
    // Hicks: `gh api repos/<owner>/<repo>/issues -f labels=bug` (or the
    // typed `-F` form) passes the label filter to the REST issues
    // collection endpoint through `gh api`'s own field-flag syntax rather
    // than a URL query string -- the identical REST filter the pattern
    // above already catches when spelled as `/issues?...labels=`, just
    // handed to the endpoint through gh's CLI wrapper instead of a raw
    // fetch/URL. `gh api --help`: `-f/--raw-field` and `-F/--field` both
    // add a `key=value` request parameter, so either flag spelling reaches
    // the same lagged collection filter.
    name: 'gh api ... -f/-F labels=',
    pattern: /\bgh\s+api\b[^\n]*(?:-f|-F|--(?:raw-)?field)\s+labels?=/,
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
 * Detects a TWO-STEP label-index query construction: a `label:` qualifier
 * is assembled into a string/template-literal VARIABLE first, and that
 * variable is only later interpolated into a SEPARATE outbound network
 * call (`fetch(...)`) -- so neither the `label:` text nor the request URL
 * ever appears together in one matched span the way `LABEL_INDEX_PATTERNS`'
 * `search API label: qualifier` pattern (anchored on `search/issues` and
 * `label:` co-occurring within one line) expects.
 *
 * Hicks (round 10): a repo script that builds its search query as
 * ```
 * const query = `repo:owner/repo label:${label}`;
 * fetch(`https://api.github.com/search/issues?q=${encodeURIComponent(query)}`);
 * ```
 * produces NO violation today, since `label:` and the outbound call are on
 * different lines with no `[^\n]*`-bridgeable text between them -- this
 * is the same lagged label-search-index hazard #299 describes, just
 * spelled through an intermediate variable rather than inline. Rather than
 * chase indirection depth indefinitely (each round of review has found a
 * new indirection shape), this recognizes the underlying TWO-FACT pattern
 * directly: (1) some variable's initializer is a string/template literal
 * containing the literal text `label:`, and (2) that variable's name is
 * referenced inside a `fetch(...)` call whose own argument text names a
 * GitHub host (`github.com`) -- i.e. the file both KNOWS a label qualifier
 * and MAKES a GitHub network call built from it, regardless of how many
 * assignments sit between the two. When found, this synthesizes the
 * canonical text `search/issues label:` so the EXISTING `search API
 * label: qualifier` pattern fires on it, the same composition style
 * `flattenGhArgvInvocations` already uses for wrapped gh calls, rather
 * than adding a parallel, six-pattern-list-sized bespoke check.
 *
 * Deliberately narrow: requires a literal `label:` substring in the
 * variable's OWN initializer (not itself further indirected through
 * another variable -- chasing that would be unbounded), and requires the
 * `fetch(...)` argument text to name `github.com` literally, to avoid
 * flagging an unrelated `fetch` call that happens to reference a
 * same-named variable holding unrelated text. A `label:` fragment built
 * from `.push()`/string concatenation across multiple statements, or
 * passed through a wrapper function rather than a literal `fetch(...)`
 * call, remains out of reach -- the same "text scan, not an interpreter"
 * limit stated throughout this file.
 */
export function flattenIndirectLabelQueryConstruction(contents) {
  const flattened = [];

  const labelVariablePattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(`[^`]*label:[^`]*`|'[^']*label:[^']*'|"[^"]*label:[^"]*")/g;
  const labelVariableNames = new Set();
  let labelMatch;
  while ((labelMatch = labelVariablePattern.exec(contents)) !== null) {
    labelVariableNames.add(labelMatch[1]);
  }
  if (labelVariableNames.size === 0) return '';

  const escapedNames = [...labelVariableNames].map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const nameReferencePattern = new RegExp(
    `\\b(?:${escapedNames.join('|')})\\b`,
  );

  const fetchCallPattern = /\bfetch\s*\(/g;
  let header;
  while ((header = fetchCallPattern.exec(contents)) !== null) {
    const argsStart = header.index + header[0].length;
    let depth = 1;
    let index = argsStart;
    for (; index < contents.length && depth > 0; index++) {
      if (contents[index] === '(') depth++;
      else if (contents[index] === ')') depth--;
    }
    if (depth !== 0) continue; // unbalanced -- do not guess.
    const argsText = contents.slice(argsStart, index - 1);

    if (/github\.com/i.test(argsText) && nameReferencePattern.test(argsText)) {
      flattened.push('search/issues label: (indirect, via variable)');
    }
  }

  return flattened.join('\n');
}

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
 *   3. A LOCAL WRAPPER FUNCTION that itself shells out to `gh` (matches
 *      shape 1's generic `'gh', ...` text), called elsewhere in the file
 *      with an argv array literal or variable: `const gh = (args) =>
 *      execFileSync('gh', args); gh(['pr', 'list', '--label', name]);`.
 *      Ripley (round 4): the lint only pattern-matched a `'gh'` string
 *      literal at the call site itself, so indirection through ANY
 *      differently-named helper -- `gh(...)`, `invokeGh(...)`, a repo's own
 *      wrapper of whatever name -- bypassed it entirely, since the actual
 *      `'gh'` string only ever appears inside the wrapper's own definition,
 *      never at the call site the lint was reading. Resolved by first
 *      finding every function/arrow definition in the file whose OWN BODY
 *      contains shape 1's `'gh', ...` shape (i.e. it truly shells out to
 *      the real binary, detected by behavior, not by guessing conventional
 *      names like `gh` or `invokeGh`), then re-running the same argv-
 *      resolution logic against each such wrapper's own call sites.
 *      Ripley (round 5): the FIRST implementation of this only looked at a
 *      wrapper's FIRST argument, so a real repo-style wrapper with a
 *      different signature -- `runGh(run, args, env)`, argv in the SECOND
 *      position -- still bypassed it. Fixed by scanning every argument in
 *      a wrapper call's full, paren-balanced argument list, not just the
 *      first, and resolving each array-literal or array-variable argument
 *      found anywhere in that list -- see `flattenArgvAcrossCallArguments`
 *      below.
 *
 * Deliberately narrow beyond these shapes: an argv assembled through
 * `.push()`, `.concat()`, spread from another variable, or any interpolated
 * (non-literal) token cannot be resolved by a text scan without executing
 * the program, so it remains unmatched -- the same limit
 * `LABEL_INDEX_PATTERNS` already has for any interpolated value, stated in
 * this file's own header comment. Widening indefinitely would turn this
 * lint into a JavaScript interpreter; the shapes handled here are the ones
 * actually observed to matter -- the literal-at-call-site shape this
 * repo's own scripts use, the variable-indirection (including
 * reassignment) evasions of it, and the wrapper-function indirection
 * (including cross-file and nested wrappers, resolved project-wide by
 * `collectProjectGhWrapperNames` and passed in as `extraWrapperNames`) a
 * reviewer demonstrated.
 *
 * `extraWrapperNames` lets a caller that has already resolved wrapper
 * names ACROSS the whole scanned file set (nested wrappers, or a wrapper
 * imported from another scanned file -- see `collectProjectGhWrapperNames`)
 * feed those names in alongside the ones this function can find on its
 * own by reading only `contents`. Kept optional so every existing direct
 * caller/test that only cares about a single file's own text keeps working
 * unchanged.
 *
 * Vasquez (round 11): comments are stripped from `contents` FIRST, before
 * any of the call-site scans below run. Every wrapper-DEFINITION test in
 * this file already strips comments from an extracted body before testing
 * it (`stripCommentsForWrapperBodyScan`, used by
 * `collectDirectGhWrapperDefinitions`/`findNestedGhWrapperNames`/etc.), but
 * this function's own CALL-SITE scans (`flattenArgvAfter`,
 * `flattenArgvAcrossCallArguments`, `flattenArgvFromRestParams`) read raw
 * `contents` directly -- so a comment merely QUOTING the direct-call shape
 * (`// example: execFileSync('gh', ['pr', 'list', '--label', name]);`,
 * written to document the pattern, not to execute it) still flattened into
 * a violation. Reproduced locally: a comment-only snippet with no real
 * call produced a match. Stripping comments once, up front, for every scan
 * this function performs closes that false positive; positions used
 * internally (`resolveVariableArrayBefore`'s `beforeIndex`, call-site
 * `index`s) stay self-consistent because every scan in this function reads
 * from this same, single stripped string -- this function never reports
 * character offsets back to a caller, only a flattened token stream, so
 * the length change a stripped line-comment produces cannot desync a
 * position a caller holds against the ORIGINAL text.
 */
// Extracts every quoted string TOKEN from inside an array-literal's body
// text (the part between `[` and `]`) -- e.g. `'pr', 'list', "--label"` ->
// `['pr', 'list', '--label']`. A pure, contents-independent helper, so it
// is hoisted to module scope and shared by `flattenGhArgvInvocations` and
// `findUnresolvedGhWrapperCalls` (round 12) rather than duplicated.
function tokensFromArrayBody(arrayBody) {
  return [...arrayBody.matchAll(/['"`]([^'"`]*)['"`]/g)].map(
    (tokenMatch) => tokenMatch[1],
  );
}

// Splits a call's argument-list text on TOP-LEVEL commas only (depth-0
// relative to the argument list itself), so a nested array/object/call
// argument's internal commas are not mistaken for argument separators. A
// pure, contents-independent helper, hoisted to module scope for the same
// reason as `tokensFromArrayBody`.
function splitTopLevelArguments(argsText) {
  const args = [];
  let depth = 0;
  let current = '';
  for (const character of argsText) {
    if (character === '(' || character === '[' || character === '{') {
      depth++;
    } else if (character === ')' || character === ']' || character === '}') {
      depth--;
    }
    if (character === ',' && depth === 0) {
      args.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim() !== '') args.push(current);
  return args;
}

// Resolves a SCALAR (non-array) variable to its most recent string/
// template-literal assignment (`NAME = 'x'`/`NAME = \`x\``) BEFORE
// `beforeIndex` -- the same reassignment-aware, most-recent-before-the-
// reference logic `resolveVariableArrayBefore` uses for an array-valued
// variable, applied here to a single scalar value instead. Returns the
// literal's inner text (delimiters stripped) or `null` if no such
// assignment precedes `beforeIndex`.
function resolveScalarVariableBefore(contents, varName, beforeIndex) {
  const assignmentPattern = new RegExp(
    `\\b${varName}\\s*=\\s*(\`[^\`]*\`|'[^']*'|"[^"]*")`,
    'g',
  );
  let assignment;
  let mostRecentBefore = null;
  while ((assignment = assignmentPattern.exec(contents)) !== null) {
    if (assignment.index >= beforeIndex) break;
    mostRecentBefore = assignment;
  }
  return mostRecentBefore ? mostRecentBefore[1].slice(1, -1) : null;
}

// Resolves an array LITERAL's own top-level elements into tokens: a
// quoted string/template element resolves to its own inner text (same as
// `tokensFromArrayBody`), but a BARE IDENTIFIER element additionally
// resolves against a preceding SCALAR variable assignment via
// `resolveScalarVariableBefore`. Hicks (round 9/13): the array literal
// argument to a direct `gh` call (or a wrapper call) can be fully static
// in SHAPE while mixing quoted elements with one bare-identifier element
// whose VALUE is built from a separately-declared variable --
// `const query = \`label:\${label}\`; execFileSync('gh', ['search',
// 'issues', query]);` -- the array literal itself is never variable-
// valued as a WHOLE (so `resolveVariableArrayBefore` never applies to
// it), but its one non-literal element is exactly the shape that carries
// the interesting `label:` text. Reproduced locally: this shape scanned
// clean before this resolver existed. An element that resolves to
// neither is simply omitted from the returned tokens (not guessed),
// matching this file's existing conservative-omission convention for any
// value it cannot statically pin down.
function resolveArrayLiteralElementTokens(arrayBody, contents, beforeIndex) {
  const tokens = [];
  for (const rawElement of splitTopLevelArguments(arrayBody)) {
    const element = rawElement.trim();
    if (element === '') continue;

    const stringLiteralMatch = /^['"`]([^'"`]*)['"`]$/.exec(element);
    if (stringLiteralMatch) {
      tokens.push(stringLiteralMatch[1]);
      continue;
    }

    const identifierMatch = /^([A-Za-z_$][\w$]*)$/.exec(element);
    if (identifierMatch) {
      const resolved = resolveScalarVariableBefore(
        contents,
        identifierMatch[1],
        beforeIndex,
      );
      if (resolved !== null) tokens.push(resolved);
    }
  }
  return tokens;
}

export function flattenGhArgvInvocations(rawContents, extraWrapperNames = []) {
  const flattened = [];
  const contents = stripCommentsForWrapperBodyScan(rawContents);

  // Resolves an identifier to its most recent array-literal assignment
  // (`NAME = [...]`) BEFORE `beforeIndex` in the file -- the reassignment-
  // aware logic Vasquez's round-3 finding required: scanning for the
  // first (or only) `NAME = [...]` in the whole file would resolve to an
  // original, safe declaration and miss a later reassignment that
  // actually feeds the call it is resolved for.
  const resolveVariableArrayBefore = (varName, beforeIndex) => {
    const assignmentPattern = new RegExp(
      `\\b${varName}\\s*=\\s*\\[([\\s\\S]*?)]`,
      'g',
    );
    let assignment;
    let mostRecentBefore = null;
    while ((assignment = assignmentPattern.exec(contents)) !== null) {
      if (assignment.index >= beforeIndex) break;
      mostRecentBefore = assignment;
    }
    return mostRecentBefore
      ? resolveArrayLiteralElementTokens(
          mostRecentBefore[1],
          contents,
          mostRecentBefore.index,
        )
      : null;
  };

  // Resolves an array-literal argv passed either directly at a call site
  // (`prefix[...]`) or by name (`prefix identifierName`, resolved via
  // `resolveVariableArrayBefore`), for an arbitrary `prefix` regex source.
  // Used only for shape 1/2: the literal `'gh'` string followed by a
  // comma then its SECOND argument -- a fixed position, unlike a wrapper
  // call's argv, which can be at any parameter position (see
  // `flattenArgvAcrossCallArguments` below for that shape).
  const flattenArgvAfter = (prefix) => {
    const directPattern = new RegExp(`${prefix}\\s*\\[([\\s\\S]*?)]`, 'g');
    let directCall;
    while ((directCall = directPattern.exec(contents)) !== null) {
      const tokens = resolveArrayLiteralElementTokens(
        directCall[1],
        contents,
        directCall.index,
      );
      if (tokens.length > 0) {
        flattened.push(`gh ${tokens.join(' ')}`);
      }
    }

    // `[),]` after the identifier requires it to end an argument (a bare
    // call) or be followed by another argument (e.g. an options object),
    // not merely appear as a substring of a longer expression.
    const variablePattern = new RegExp(
      `${prefix}\\s*([A-Za-z_$][\\w$]*)\\s*[),]`,
      'g',
    );
    let variableCall;
    while ((variableCall = variablePattern.exec(contents)) !== null) {
      const tokens = resolveVariableArrayBefore(
        variableCall[1],
        variableCall.index,
      );
      if (tokens && tokens.length > 0) {
        flattened.push(`gh ${tokens.join(' ')}`);
      }
    }
  };

  // Shape 3 (Ripley, round 5): a wrapper's argv is not always its FIRST
  // parameter -- a real repo-style wrapper like `runGh(run, args, env)`
  // takes it second. Rather than assuming a fixed position, this finds
  // every call site of `wrapperName(...)`, extracts its FULL, paren-
  // balanced argument list, splits that list on top-level commas, and
  // resolves EVERY argument that is itself an array literal or an
  // identifier resolving to a preceding array assignment -- wherever in
  // the parameter list it falls.
  // Vasquez (round 9): once a wrapper NAME is known, this scan must not
  // conflate it with an UNRELATED call sharing the same bare identifier --
  // e.g. an unrelated object's own method, `client.runGh(...)`, which has
  // nothing to do with a real `function runGh(args) { execFileSync('gh',
  // args); }` wrapper elsewhere in the same file. `matchMode` scopes the
  // call-site pattern to the SHAPE the wrapper name was actually DEFINED
  // with: `'bare'` requires the call NOT be preceded by `.` (a bare
  // function/arrow wrapper is only ever legitimately called as a bare
  // identifier); `'method'` requires the call BE preceded by `.` OR be a
  // computed-property (bracket) access naming the SAME wrapper as a
  // quoted string (`['invokeGh'](...)`/`["invokeGh"](...)`) -- Vasquez
  // (round 11): a method-shorthand wrapper called through BRACKET property
  // access (`helpers['invokeGh']([...])`) is exactly as legitimate a call
  // site as dot access, and the dot-only pattern missed it entirely,
  // reproduced locally; `'any'` keeps the original, unscoped match (used
  // for `extraWrapperNames` -- nested/cross-file/aliased names this
  // function cannot itself classify by definition shape, since they were
  // resolved from a project-wide pass rather than this file's own text).
  //
  // Vasquez (round 12): the comma-operator indirect-call idiom --
  // `(0, runGh)([...])`, a well-known pattern for stripping a call's `this`
  // binding -- neither `.` precedes it (so it fails a `'method'`-mode
  // check) nor does the bare identifier appear directly before `(` (so it
  // fails a `'bare'`-mode check too): `runGh` sits inside its own group,
  // followed by `)`, THEN `(`. This is scanned as a SEPARATE header
  // pattern, alongside whichever direct pattern `matchMode` already
  // selects, since a wrapper legitimately called directly could ALSO be
  // called this way elsewhere in the same file -- both call shapes must be
  // found, not just one.
  const flattenArgvAcrossCallArguments = (wrapperName, matchMode = 'any') => {
    const escapedName = wrapperName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const directHeaderPattern =
      matchMode === 'bare'
        ? new RegExp(`(?<!\\.)\\b${escapedName}\\s*\\(`, 'g')
        : matchMode === 'method'
          ? new RegExp(
              `(?:\\.${escapedName}|\\[\\s*['"]${escapedName}['"]\\s*])\\s*\\(`,
              'g',
            )
          : new RegExp(`\\b${escapedName}\\s*\\(`, 'g');
    const commaOperatorHeaderPattern = new RegExp(
      `\\(\\s*0\\s*,\\s*${escapedName}\\s*\\)\\s*\\(`,
      'g',
    );

    const processHeaderPattern = (headerPattern) => {
      let header;
      while ((header = headerPattern.exec(contents)) !== null) {
        const callIndex = header.index;
        const argsStart = header.index + header[0].length;

        let depth = 1;
        let index = argsStart;
        for (; index < contents.length && depth > 0; index++) {
          if (contents[index] === '(') depth++;
          else if (contents[index] === ')') depth--;
        }
        if (depth !== 0) continue; // unbalanced -- do not guess.
        const argsText = contents.slice(argsStart, index - 1);

        for (const rawArgument of splitTopLevelArguments(argsText)) {
          const argument = rawArgument.trim();
          if (argument === '') continue;

          const arrayLiteralMatch = /^\[([\s\S]*)]$/.exec(argument);
          if (arrayLiteralMatch) {
            const tokens = resolveArrayLiteralElementTokens(
              arrayLiteralMatch[1],
              contents,
              callIndex,
            );
            if (tokens.length > 0) flattened.push(`gh ${tokens.join(' ')}`);
            continue;
          }

          const identifierMatch = /^([A-Za-z_$][\w$]*)$/.exec(argument);
          if (identifierMatch) {
            const tokens = resolveVariableArrayBefore(
              identifierMatch[1],
              callIndex,
            );
            if (tokens && tokens.length > 0) {
              flattened.push(`gh ${tokens.join(' ')}`);
            }
          }
        }
      }
    };

    processHeaderPattern(directHeaderPattern);
    processHeaderPattern(commaOperatorHeaderPattern);
  };

  // Ripley (round 9): a wrapper whose SOLE parameter is a REST parameter
  // (`function runGh(...args) { execFileSync('gh', args); }`) never
  // receives its argv as one array-typed argument at the call site at
  // all -- the language itself builds `args` from however many individual
  // positional arguments the call used (`runGh('issue', 'list', '--label',
  // 'x')`). The per-argument scan above cannot find that shape (no single
  // argument IS an array). This synthesizes ONE array from the wrapper
  // call's ENTIRE argument list instead: each top-level argument is
  // resolved as a plain string/template literal token, or (if itself an
  // array literal or an array-valued variable) spread into the same
  // token list. If ANY argument cannot be resolved this way, the whole
  // call site is skipped rather than reconstructed partially -- guessing
  // a half-formed command risks a false negative OR a misleading false
  // positive, either worse than the narrow miss of skipping it.
  const flattenArgvFromRestParams = (wrapperName) => {
    const escapedName = wrapperName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callHeaderPattern = new RegExp(
      `(?<!\\.)\\b${escapedName}\\s*\\(`,
      'g',
    );
    let header;
    while ((header = callHeaderPattern.exec(contents)) !== null) {
      const callIndex = header.index;
      const argsStart = header.index + header[0].length;

      let depth = 1;
      let index = argsStart;
      for (; index < contents.length && depth > 0; index++) {
        if (contents[index] === '(') depth++;
        else if (contents[index] === ')') depth--;
      }
      if (depth !== 0) continue; // unbalanced -- do not guess.
      const argsText = contents.slice(argsStart, index - 1);

      const tokens = [];
      let unresolved = false;
      for (const rawArgument of splitTopLevelArguments(argsText)) {
        const argument = rawArgument.trim();
        if (argument === '') continue;

        const stringLiteralMatch = /^['"`]([^'"`]*)['"`]$/.exec(argument);
        if (stringLiteralMatch) {
          tokens.push(stringLiteralMatch[1]);
          continue;
        }

        const arrayLiteralMatch = /^\[([\s\S]*)]$/.exec(argument);
        if (arrayLiteralMatch) {
          tokens.push(
            ...resolveArrayLiteralElementTokens(
              arrayLiteralMatch[1],
              contents,
              callIndex,
            ),
          );
          continue;
        }

        const identifierMatch = /^([A-Za-z_$][\w$]*)$/.exec(argument);
        if (identifierMatch) {
          const resolved = resolveVariableArrayBefore(
            identifierMatch[1],
            callIndex,
          );
          if (resolved && resolved.length > 0) {
            tokens.push(...resolved);
            continue;
          }
        }

        unresolved = true;
      }

      if (!unresolved && tokens.length > 0) {
        flattened.push(`gh ${tokens.join(' ')}`);
      }
    }
  };

  // Shapes 1 and 2: the literal `'gh'` string at a direct execFile(Sync)/
  // spawn(Sync)-style call site, where the argv is the SECOND argument
  // (`'gh', [...]` / `'gh', varName`) -- a comma separates `'gh'` from it.
  flattenArgvAfter(`['"]gh['"]\\s*,\\s*`);

  // Shape 3: every wrapper this file's own text can find by behavior,
  // classified by definition shape (`classifyGhWrapperDefinitionKinds`) so
  // the call-site scan for each name is scoped to how it was actually
  // defined, PLUS every name a project-wide caller already resolved
  // (nested-in-file wrappers found via fixed-point iteration, wrappers
  // imported/re-exported from another scanned file, or default-exported
  // wrappers) and passed in via `extraWrapperNames` -- see
  // `collectProjectGhWrapperNames`. The sentinel `'default'` entry
  // `collectProjectGhWrapperNames` may add to a file's OWN set is never a
  // real callable identifier, so it is excluded here.
  const { bareNames, methodNames } = classifyGhWrapperDefinitionKinds(contents);
  for (const wrapperName of bareNames) {
    flattenArgvAcrossCallArguments(wrapperName, 'bare');
  }
  for (const wrapperName of methodNames) {
    flattenArgvAcrossCallArguments(wrapperName, 'method');
  }
  for (const wrapperName of extraWrapperNames) {
    if (wrapperName === 'default') continue;
    if (bareNames.has(wrapperName) || methodNames.has(wrapperName)) continue;
    flattenArgvAcrossCallArguments(wrapperName, 'any');
  }

  // Shape 4: rest-param wrappers, resolved only from THIS file's own text
  // (a behavioral, same-file check like `findGhWrapperNames`) -- a
  // rest-param wrapper name may ALSO appear in `bareNames` above (its
  // definition matches the generic function/arrow pattern too), but the
  // per-argument scan there simply finds nothing to resolve for a call
  // site with no single array-typed argument, so the two passes do not
  // double-count a call site that only one of them can actually resolve.
  for (const wrapperName of findRestParamGhWrapperNames(contents)) {
    flattenArgvFromRestParams(wrapperName);
  }

  return flattened.join('\n');
}

/**
 * Companion to `flattenGhArgvInvocations`'s Shape-4 (rest-param wrapper)
 * resolution. Ripley + Vasquez (round 12): when a rest-param wrapper call's
 * argv canNOT be statically resolved -- e.g. one of its positional
 * arguments is a DYNAMIC/computed value, not a string/array literal and not
 * resolvable to a preceding array assignment (`runGh('pr', 'list',
 * '--label', dynamicLabel)`) -- `flattenArgvFromRestParams` deliberately
 * discards the WHOLE call site rather than guessing a half-formed command
 * (see that function's own comment). But that discard is itself silent:
 * `scanLabelIndexUsage`'s caller has no way to tell "this call was checked
 * and found safe" apart from "this call could not be checked at all" --
 * both currently look identical (no violation reported). Reproduced
 * locally: a rest-param wrapper call with one dynamic argument produced
 * `{ violations: [], allowlisted: [] }`, exactly as if the call never
 * existed.
 *
 * This function independently re-scans every rest-param-wrapper call site
 * (found the same way `flattenArgvFromRestParams` finds them) and reports
 * `{ name, snippet }` for each one whose argv could not be fully resolved,
 * so `scanLabelIndexUsage` can surface it as a THIRD, distinct category --
 * `needsReview` -- neither a silent pass nor a definite violation (the
 * unresolved argument may well be innocuous; the point is a human, not the
 * mechanical check, must be the one to decide that).
 *
 * Deliberately scoped to the same rest-param-wrapper shape
 * `flattenArgvFromRestParams` already resolves (same-file only, not
 * project-wide) -- widening this to every possible unresolvable argument
 * shape across the whole file (e.g. `flattenArgvAcrossCallArguments`'s
 * per-argument scan, which also silently skips an argument it cannot
 * resolve) is a larger change than what was reported and reproduced this
 * round; left for a future round if a reviewer demonstrates a concrete gap
 * there too.
 */
export function findUnresolvedGhWrapperCalls(rawContents) {
  const contents = stripCommentsForWrapperBodyScan(rawContents);
  const needsReview = [];

  const resolveVariableArrayBefore = (varName, beforeIndex) => {
    const assignmentPattern = new RegExp(
      `\\b${varName}\\s*=\\s*\\[([\\s\\S]*?)]`,
      'g',
    );
    let assignment;
    let mostRecentBefore = null;
    while ((assignment = assignmentPattern.exec(contents)) !== null) {
      if (assignment.index >= beforeIndex) break;
      mostRecentBefore = assignment;
    }
    return mostRecentBefore ? tokensFromArrayBody(mostRecentBefore[1]) : null;
  };

  for (const wrapperName of findRestParamGhWrapperNames(contents)) {
    const escapedName = wrapperName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callHeaderPattern = new RegExp(
      `(?<!\\.)\\b${escapedName}\\s*\\(`,
      'g',
    );

    let header;
    while ((header = callHeaderPattern.exec(contents)) !== null) {
      const callIndex = header.index;

      // The bare-call pattern also matches this wrapper's OWN definition
      // header (`function runGh(...args)`), since "runGh(" there is
      // syntactically identical to a real call site "runGh(" -- the only
      // form where this happens, since an arrow-function wrapper's name is
      // followed by `=`, not directly by `(`. Skip it: a definition's own
      // rest-parameter list (`...args`) is never itself a "call this
      // lint could not verify," it is simply how the wrapper receives its
      // arguments.
      const precedingText = contents.slice(
        Math.max(0, header.index - 20),
        header.index,
      );
      if (/\bfunction\s*$/.test(precedingText)) continue;

      const argsStart = header.index + header[0].length;

      let depth = 1;
      let index = argsStart;
      for (; index < contents.length && depth > 0; index++) {
        if (contents[index] === '(') depth++;
        else if (contents[index] === ')') depth--;
      }
      if (depth !== 0) continue; // unbalanced -- do not guess.
      const argsText = contents.slice(argsStart, index - 1);

      let hasAnyArgument = false;
      let unresolved = false;
      for (const rawArgument of splitTopLevelArguments(argsText)) {
        const argument = rawArgument.trim();
        if (argument === '') continue;
        hasAnyArgument = true;

        if (/^['"`][^'"`]*['"`]$/.test(argument)) continue;
        if (/^\[[\s\S]*]$/.test(argument)) continue;

        const identifierMatch = /^([A-Za-z_$][\w$]*)$/.exec(argument);
        if (identifierMatch) {
          const resolved = resolveVariableArrayBefore(
            identifierMatch[1],
            callIndex,
          );
          if (resolved && resolved.length > 0) continue;
        }

        unresolved = true;
      }

      if (hasAnyArgument && unresolved) {
        const snippetEnd = Math.min(contents.length, index, header.index + 160);
        needsReview.push({
          name: wrapperName,
          snippet: contents.slice(header.index, snippetEnd).trim(),
        });
      }
    }
  }

  return needsReview;
}

/**
 * Shared by `findGhWrapperNames` and `findNestedGhWrapperNames`: matches a
 * function-like definition header -- `function NAME(...)`, `const NAME =
 * (...) => `, `const NAME = (...) => ` (`const` replaceable by
 * `let`/`var`), `const NAME = function (...) `, `const NAME = async (...)
 * => `, OR a class/object METHOD SHORTHAND (`NAME(...) {`, with an
 * optional leading `async`/`static`) -- capturing `NAME` in group 1, 2, or
 * 3. A fresh `RegExp` instance must be built per scan (via `new
 * RegExp(DEFINITION_HEADER_PATTERN_SOURCE, 'g')`) rather than sharing one
 * stateful global-flagged instance across calls, since each caller
 * advances its own `lastIndex`.
 *
 * Vasquez (round 8): a wrapper written as a CLASS METHOD --
 * `class Runner { invokeGh(args) { return execFileSync('gh', args); } }`,
 * called as `runner.invokeGh([...])` -- was invisible, since neither
 * `function NAME(...)` nor `const NAME = ...` matched a bare `NAME(...) {`
 * shorthand. The third alternative below matches that shorthand while
 * excluding JS control-flow keywords that share the same `KEYWORD (...) {`
 * shape (`if`, `for`, `while`, `switch`, `catch`) via a negative lookahead,
 * and requires the identifier not be preceded by `.`/a word character (so
 * it does not also match at the CALL site `runner.invokeGh(` -- only at an
 * actual definition, which is never preceded by `.`). The `(?=\{)` at the
 * end is a lookahead, not a consumed match: like the other two
 * alternatives, this leaves `definition[0].length` pointing just BEFORE
 * the opening `{`, which is what `extractDefinitionBody` expects.
 */
const DEFINITION_HEADER_PATTERN_SOURCE =
  '(?:function\\s+([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)\\s*)|' +
  '(?:(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s+)?' +
  '(?:function\\b[^(]*\\([^)]*\\)\\s*|\\([^)]*\\)\\s*=>\\s*|' +
  '[A-Za-z_$][\\w$]*\\s*=>\\s*))|' +
  '(?:(?<![\\w$.])' +
  '(?!(?:if|for|while|switch|catch|function|else|return|typeof|new|await|yield|do)\\b)' +
  '(?:static\\s+)?(?:async\\s+)?([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)\\s*(?=\\{))';

/**
 * Strips `//line` and `/* block *\/` comments before a body is tested for
 * "does this shell out to `gh`/call another wrapper" -- Ripley (round 8):
 * without this, a comment merely QUOTING that shape (e.g. `// example:
 * execFileSync('gh', args)` written to document the pattern, the same
 * kind of prose this file's own header comment already has to avoid
 * self-matching) would be indistinguishable from actually calling it.
 *
 * Vasquez (round 10): a NAIVE regex-based strip (treating every `//` as a
 * line-comment start) produces the OPPOSITE mistake -- a real wrapper is
 * missed (false NEGATIVE) if a string literal containing `//` (e.g. a URL,
 * `console.log('https://example.com')`) appears on the SAME LINE before
 * the wrapper's actual `execFileSync('gh', ...)` call: the naive strip
 * would treat that `//` as starting a comment and discard the rest of the
 * line, including the real call. This is a lightweight, single-pass
 * scanner (not a full tokenizer) that tracks single/double/backtick
 * STRING-LITERAL boundaries (with basic backslash-escape awareness) and
 * only treats `//`/`/* *\/` as a comment start OUTSIDE of one -- so a `//`
 * inside a string is preserved (and left in the output verbatim, along
 * with the rest of the string), while a genuine comment is still removed.
 * String contents are deliberately NOT otherwise altered: this keeps round
 * 8's fix intact, since `DIRECT_GH_CALL_PATTERN`'s own `(?<=\()` --
 * requiring `'gh'` be immediately preceded by `(` -- still prevents a bare
 * quoted string (even one left untouched here) from being mistaken for an
 * actual call.
 *
 * Ripley (round 11): a REGEX LITERAL containing escaped slashes (e.g.
 * `/^https:\/\//`, matching a URL scheme) is not a quoted string -- none
 * of `'`/`"`/`` ` `` delimit it -- so the round-10 fix's quote-tracking
 * does not protect it. The escaped-slash pair `\/` in `\/\/ ` was still
 * read one character at a time OUTSIDE any tracked quote, and the SECOND
 * `/` of that pair was then seen adjacent to the regex's own CLOSING `/`
 * delimiter, so the scanner mistook that boundary for a `//` line-comment
 * start and discarded the rest of the line -- including a real
 * `execFileSync('gh', ...)` call written after the regex literal on the
 * same line. Reproduced locally: `const re = /^https:\/\//; return
 * execFileSync('gh', args);` on one line left the wrapper undetected.
 * Fixed narrowly, without adding full regex-literal-boundary tracking (a
 * `/.../ ` delimiter is genuinely ambiguous with division without knowing
 * the preceding token, which this scanner does not track): a backslash
 * OUTSIDE a string is now treated the same escape-pair way one INSIDE a
 * string already was -- the backslash and the character immediately after
 * it are consumed and copied TOGETHER, so that character is never
 * separately re-examined as a potential comment-start. This resolves the
 * `\/` case (the escaped character can no longer pair with a following
 * unescaped `/` to look like `//`) without needing to know whether a given
 * `/` opens/closes a regex literal at all.
 */
function stripCommentsForWrapperBodyScan(text) {
  let result = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quote) {
      result += ch;
      if (ch === '\\' && i + 1 < text.length) {
        result += text[i + 1];
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      result += ch;
      continue;
    }

    // Ripley (round 11): consume an escaped-character pair even OUTSIDE a
    // tracked string/quote, so the character right after a backslash (as
    // in a regex literal's `\/`) can never be separately re-examined as
    // the start of a `//`/`/* */` comment.
    if (ch === '\\' && i + 1 < text.length) {
      result += ch + text[i + 1];
      i++;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      result += '\n';
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i++; // land on the closing `/`, loop's own i++ advances past it.
      result += ' ';
      continue;
    }

    result += ch;
  }
  return result;
}

/**
 * Finds every function-like definition in `contents` -- `function NAME(...)
 * { ... }`, `const NAME = (...) => { ... }`, `const NAME = (...) =>
 * expression;`, `const NAME = function (...) { ... }` (with `const`
 * replaceable by `let`/`var`), or a class/object method shorthand -- whose
 * OWN BODY actually CALLS `execFileSync`/`spawnSync`/similar with `'gh'` as
 * its first argument (the same shape `flattenGhArgvInvocations` recognizes
 * as "shells out to the real `gh` binary"). Returns the set of such names.
 *
 * Ripley (round 4): a wrapper can be named ANYTHING -- `gh`, `invokeGh`,
 * `runGh`, a repo-specific helper -- so detecting it by name would either
 * miss real wrappers under unguessed names or (if the name list were
 * widened speculatively) flag unrelated functions that merely share a
 * common name. Detecting it by BEHAVIOR -- does its body actually invoke
 * the real binary -- avoids both failure modes without parsing the file
 * into a real AST: this is a text scan using balanced-brace/paren depth to
 * find the definition's own body text, not a JavaScript interpreter.
 *
 * Ripley (round 8): the original body test, `/['"]gh['"]\s*,/`, matched
 * that literal text ANYWHERE in a body -- inside a plain string
 * (`"success: 'gh', done"`) or a comment (`// calls 'gh', badly`) -- and
 * flagged an unrelated function as a wrapper. Reproduced locally.
 * Tightened two ways: (1) comments are stripped first (see
 * `stripCommentsForWrapperBodyScan`); (2) the pattern now requires an
 * OPEN PAREN immediately before the quoted `'gh'` (`\(\s*['"]gh['"]\s*,`),
 * matching only an actual call-argument shape (`execFileSync('gh', ...)`,
 * `foo('gh', ...)`) rather than any occurrence of the substring. A value
 * like `logMessage('gh', 'ok')`, where `'gh'` is coincidentally the first
 * argument to an unrelated call, can still produce a false positive --
 * that is the same "detected by textual call-shape, not by executing the
 * program" limit this file states throughout, just narrower than before.
 *
 * Deliberately narrow, ON ITS OWN: a wrapper that only calls ANOTHER
 * wrapper (never `'gh'` directly), an alias of another wrapper's own
 * reference (`const myGh = invokeGh;`), or one imported from a different
 * module, is not found by this function alone -- see
 * `findNestedGhWrapperNames`, `findAliasedGhWrapperNames`, and
 * `collectProjectGhWrapperNames`, which extend this same text-scan-only
 * detection to nested, aliased, and cross-file cases by iterating these
 * behavioral tests to a fixed point across the whole scanned file set,
 * rather than widening this function itself into something that reads
 * more than one file's own text.
 */
const DIRECT_GH_CALL_PATTERN = /\(\s*['"]gh['"]\s*,/;

/**
 * Shared by `findGhWrapperNames` and `classifyGhWrapperDefinitionKinds`:
 * scans `contents` for every function-like (or method-shorthand)
 * definition whose own body directly shells out to `gh` (per
 * `DIRECT_GH_CALL_PATTERN`), returning `{ name, kind }` entries where
 * `kind` is `'method'` for a class/object method-shorthand definition
 * (group 3 of `DEFINITION_HEADER_PATTERN_SOURCE`) or `'bare'` for a plain
 * function declaration/arrow/function-expression assignment (groups 1/2).
 * Kept as a single scan so the two callers cannot drift out of sync with
 * each other about which definitions count.
 */
function collectDirectGhWrapperDefinitions(contents) {
  const entries = [];

  const definitionHeaderPattern = new RegExp(
    DEFINITION_HEADER_PATTERN_SOURCE,
    'g',
  );

  let definition;
  while ((definition = definitionHeaderPattern.exec(contents)) !== null) {
    const bareName = definition[1] ?? definition[2];
    const methodName = definition[3];
    const name = bareName ?? methodName;
    if (!name) continue;

    const body = stripCommentsForWrapperBodyScan(
      extractDefinitionBody(contents, definition.index + definition[0].length),
    );
    if (DIRECT_GH_CALL_PATTERN.test(body)) {
      entries.push({ name, kind: methodName ? 'method' : 'bare' });
    }
  }

  return entries;
}

export function findGhWrapperNames(contents) {
  const wrapperNames = new Set();
  for (const { name } of collectDirectGhWrapperDefinitions(contents)) {
    wrapperNames.add(name);
  }
  return wrapperNames;
}

/**
 * Classifies the names `findGhWrapperNames` would return by HOW each was
 * defined -- a BARE function/arrow/function-expression definition versus a
 * class/object METHOD SHORTHAND -- returning `{ bareNames, methodNames }`.
 *
 * Vasquez (round 9): once a name is known to be a wrapper,
 * `flattenGhArgvInvocations`' call-site scan (`\bNAME\s*\(`) matched EVERY
 * occurrence of that bare identifier immediately before `(` -- including
 * an UNRELATED method of the same name on a completely different object
 * (`client.runGh(...)`, where that `runGh` has nothing to do with an
 * actual `function runGh(args) { execFileSync('gh', args); }` wrapper
 * elsewhere in the same file). Reproduced locally: a same-file collision
 * between a real bare wrapper and an unrelated same-named method produced
 * an extra, wrong violation. A BARE wrapper can only ever be legitimately
 * CALLED as a bare identifier, never through property access; a METHOD
 * wrapper can only legitimately be called through property access, never
 * as a bare identifier -- scoping each name's call-site scan to the shape
 * matching how it was DEFINED closes that specific collision (see
 * `flattenGhArgvInvocations`'s use of this). A same-named METHOD on a
 * genuinely different, unrelated class remains a residual limitation
 * this scoping does not resolve -- the same "shape, not semantics" limit
 * this file states throughout -- and is deliberately not extended to
 * `extraWrapperNames` (nested/cross-file/aliased names), which keep the
 * older, unscoped call-site match to avoid missing those resolved calls.
 */
function classifyGhWrapperDefinitionKinds(contents) {
  const bareNames = new Set();
  const methodNames = new Set();

  for (const { name, kind } of collectDirectGhWrapperDefinitions(contents)) {
    if (kind === 'method') methodNames.add(name);
    else bareNames.add(name);
  }

  return { bareNames, methodNames };
}

/**
 * Extends `findGhWrapperNames`' single-hop, "calls `'gh'` directly"
 * detection to NESTED wrappers: a function whose own body does not shell
 * out to `gh` directly, but instead calls one of the names already in
 * `knownWrapperNames` (itself possibly a wrapper found this same way, one
 * level down -- `collectProjectGhWrapperNames` iterates this to a fixed
 * point so a chain of wrappers of any depth is eventually resolved, not
 * just one hop). Vasquez/Ripley (round 6): a wrapper that calls ANOTHER
 * wrapper, with neither one calling the real `gh` binary directly in its
 * own body, bypassed `findGhWrapperNames` entirely, since it only ever
 * tested a body against the literal `'gh', ...` shape.
 */
function findNestedGhWrapperNames(contents, knownWrapperNames) {
  const nested = new Set();
  if (knownWrapperNames.size === 0) return nested;

  const escapedKnownNames = [...knownWrapperNames].map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const callsKnownWrapperPattern = new RegExp(
    `\\b(?:${escapedKnownNames.join('|')})\\s*\\(`,
  );

  const definitionHeaderPattern = new RegExp(
    DEFINITION_HEADER_PATTERN_SOURCE,
    'g',
  );

  let definition;
  while ((definition = definitionHeaderPattern.exec(contents)) !== null) {
    const name = definition[1] ?? definition[2] ?? definition[3];
    if (!name || knownWrapperNames.has(name)) continue;

    const body = stripCommentsForWrapperBodyScan(
      extractDefinitionBody(contents, definition.index + definition[0].length),
    );
    if (callsKnownWrapperPattern.test(body)) {
      nested.add(name);
    }
  }

  return nested;
}

/**
 * Extends wrapper detection to a plain REFERENCE ALIAS: `const myGh =
 * invokeGh;` (no call, no parens -- just the bare function value assigned
 * to another binding), later called as `myGh([...])`. Vasquez (round 8):
 * this is a different shape from both `findGhWrapperNames` (which only
 * ever looks for a body that itself shells out) and `findNestedGhWrapperNames`
 * (which looks for a body that CALLS another wrapper) -- an alias
 * assignment is neither a function definition nor a call, just a name-to-
 * name binding, so neither existing pass could see it. `knownWrapperNames`
 * may include names resolved so far in `collectProjectGhWrapperNames`'s
 * fixed-point loop (same-file, nested, or already-aliased), so an alias of
 * an alias is resolved too, one iteration later.
 */
function findAliasedGhWrapperNames(contents, knownWrapperNames) {
  const aliased = new Set();
  if (knownWrapperNames.size === 0) return aliased;

  const escapedKnownNames = [...knownWrapperNames].map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const aliasPattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*` +
      `(?:${escapedKnownNames.join('|')})\\s*(?=[;,)\\n]|$)`,
    'g',
  );

  let match;
  while ((match = aliasPattern.exec(contents)) !== null) {
    const name = match[1];
    if (!knownWrapperNames.has(name)) {
      aliased.add(name);
    }
  }

  return aliased;
}

/**
 * Extends wrapper detection to a FACTORY-RETURNED wrapper: `const runGh =
 * makeGhRunner();`, where `makeGhRunner` is itself already known as a
 * wrapper (because its own body -- textually, per `collectDirectGhWrapperDefinitions`'s
 * substring test -- contains a direct `execFileSync('gh', ...)` call,
 * typically nested inside the CLOSURE it `return`s: `function
 * makeGhRunner() { return (args) => execFileSync('gh', args); }`).
 * Vasquez (round 10): `runGh` -- the name actually CALLED with the
 * label-index argv -- is neither a function/arrow DEFINITION (so
 * `findGhWrapperNames` cannot see it) nor a bare reference to a known name
 * (so `findAliasedGhWrapperNames`'s no-parens alias pattern cannot see it
 * either, since here there IS a call, just to the FACTORY, not to `gh`) --
 * the factory's return value, not the factory itself, is what `runGh`
 * actually holds, and text-scanning cannot execute the factory to find
 * that out. Treating `makeGhRunner` as already-known (which it already
 * is, structurally, once its body substring-matches the direct-call
 * shape) and simply recognizing `NAME = FACTORY(...)` as a SECOND
 * aliasing shape alongside the no-parens one above is the same
 * "shape, not semantics" compromise this file makes throughout: it
 * resolves the exact repro'd case, and any name assigned from a CALL to
 * an already-known wrapper name, without attempting real interprocedural
 * return-value tracking.
 */
function findFactoryReturnedGhWrapperNames(contents, knownWrapperNames) {
  const factoryAliased = new Set();
  if (knownWrapperNames.size === 0) return factoryAliased;

  const escapedKnownNames = [...knownWrapperNames].map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const factoryCallPattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*` +
      `(?:${escapedKnownNames.join('|')})\\s*\\([^)]*\\)`,
    'g',
  );

  let match;
  while ((match = factoryCallPattern.exec(contents)) !== null) {
    const name = match[1];
    if (!knownWrapperNames.has(name)) {
      factoryAliased.add(name);
    }
  }

  return factoryAliased;
}

/**
 * Matches an anonymous default-export whose OWN body directly shells out
 * to `gh` -- `export default (args) => execFileSync('gh', args);`,
 * `export default function (args) { execFileSync('gh', args); }`, `export
 * default async (args) => { ... }` -- returning whether the module's
 * default export is itself a gh-wrapper. Ripley (round 9): a wrapper
 * exposed only as a module's DEFAULT export (`import invokeGh from
 * './gh-utils.mjs'`) has no name of its own inside the defining module, so
 * neither `findGhWrapperNames` (which requires a NAME to bind) nor a named
 * import/re-export resolution sees it; this is a companion, name-less
 * check for exactly that shape. See `collectProjectGhWrapperNames`, which
 * folds a `true` result from this function into the sentinel `'default'`
 * entry of that file's own wrapper-name set, and `findDefaultImportBindings`,
 * which resolves an `import NAME from './path'` binding against that
 * sentinel.
 */
function hasGhWrapperDefaultExportFunction(contents) {
  const pattern = new RegExp(
    'export\\s+default\\s+(?:async\\s+)?(?:function\\b[^(]*\\([^)]*\\)\\s*|' +
      '\\([^)]*\\)\\s*=>\\s*|[A-Za-z_$][\\w$]*\\s*=>\\s*)',
    'g',
  );

  let match;
  while ((match = pattern.exec(contents)) !== null) {
    const body = stripCommentsForWrapperBodyScan(
      extractDefinitionBody(contents, match.index + match[0].length),
    );
    if (DIRECT_GH_CALL_PATTERN.test(body)) return true;
  }
  return false;
}

/**
 * Matches a BARE-IDENTIFIER default export -- `export default NAME;`, no
 * call, no definition, just re-exporting an existing binding under the
 * default name -- returning that identifier, or `null` if the file has no
 * such export. Used alongside `hasGhWrapperDefaultExportFunction` in
 * `collectProjectGhWrapperNames`'s fixed-point loop: if `NAME` is already
 * a known wrapper by the time this runs, the module's default export is
 * one too. Deliberately distinct from the function-like case above --
 * `export default function ...`/`export default (args) => ...` never
 * matches this (an identifier immediately followed by `(` fails the
 * `[;\n]`-or-end lookahead this requires), so the two checks cannot
 * double-count the same export.
 */
function findDefaultExportAliasTarget(contents) {
  const match = /export\s+default\s+([A-Za-z_$][\w$]*)\s*(?=[;\n]|$)/.exec(
    contents,
  );
  return match ? match[1] : null;
}

/**
 * Matches a DEFAULT import binding -- `import NAME from './relative/path'`
 * -- returning `{ localName, specifier }` for each. Deliberately narrow,
 * matching this file's other import-parsing limits: a NAMED import
 * (`import { a } from ...`) never matches (`{` is not an identifier
 * character), a namespace import (`import * as ns from ...`) never
 * matches (`*` is not an identifier character), and a combined
 * default-plus-named import (`import Default, { Named } from ...`) is
 * left unrecognized too (`from` does not immediately follow the default
 * identifier there) -- out of scope, the same way `findImportedBindings`
 * only recognizes a pure named-import form.
 */
function findDefaultImportBindings(contents) {
  const bindings = [];
  const pattern = /import\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g;

  let match;
  while ((match = pattern.exec(contents)) !== null) {
    bindings.push({ localName: match[1], specifier: match[2] });
  }

  return bindings;
}

/**
 * Extends wrapper detection to a DESTRUCTURED property binding -- `const {
 * runGh: rg } = someObj;` (renamed) or `const { runGh } = someObj;`
 * (bare) -- where `runGh` is already known as a wrapper (typically a
 * class/object METHOD-shorthand property, since that is what destructuring
 * pulls a value off of). Vasquez (round 12): this is a different shape
 * from `findAliasedGhWrapperNames` (a plain `NAME = OTHER_NAME` reference
 * assignment, no braces) -- a destructured binding names the SOURCE
 * property inside `{ ... }` on the left of `=`, not the whole right-hand
 * expression, so neither that pass nor `findNestedGhWrapperNames` (which
 * looks for a CALL, not a binding) recognizes it. `rg([...])`, once bound
 * this way, is called exactly like any other bare wrapper reference --
 * `collectProjectGhWrapperNames`'s fixed-point loop feeds the resulting
 * name in as an ordinary known name, resolved with `'any'` matchMode like
 * every other project-wide-resolved alias.
 *
 * Deliberately narrow: only a SINGLE-LEVEL destructuring pattern is
 * parsed (`const { a, b: c } = expr;`), matching this file's other
 * import/alias-parsing limits -- nested destructuring (`const { a: { b }
 * } = expr;`), default values (`const { a = fallback } = expr;`), and rest
 * elements (`const { a, ...rest } = expr;`) are not specially handled and
 * simply do not match either sub-pattern below, so they are silently
 * skipped rather than mis-parsed.
 */
function findDestructuredGhWrapperNames(contents, knownWrapperNames) {
  const destructured = new Set();
  if (knownWrapperNames.size === 0) return destructured;

  const destructurePattern = /\b(?:const|let|var)\s*\{([^}]*)}\s*=/g;

  let destructureMatch;
  while ((destructureMatch = destructurePattern.exec(contents)) !== null) {
    for (const rawProperty of destructureMatch[1].split(',')) {
      const trimmed = rawProperty.trim();
      if (trimmed === '') continue;

      const renameMatch = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(
        trimmed,
      );
      if (renameMatch) {
        const [, sourceName, localName] = renameMatch;
        if (
          knownWrapperNames.has(sourceName) &&
          !knownWrapperNames.has(localName)
        ) {
          destructured.add(localName);
        }
      }
      // A bare (no-rename) destructured property (`const { runGh } = obj;`)
      // binds a local name IDENTICAL to the source name -- already in
      // `knownWrapperNames` if it is a wrapper, so no new name is produced.
    }
  }

  return destructured;
}

/**
 * Matches a wrapper whose SOLE parameter is a rest parameter --
 * `function runGh(...args) { execFileSync('gh', args); }`, `const runGh =
 * (...args) => execFileSync('gh', args)` -- and whose own body directly
 * shells out to `gh`. Ripley (round 9): a rest-param wrapper's argv is not
 * passed to it as a single array value at the call site at all -- it is
 * reconstructed BY THE LANGUAGE from however many individual positional
 * arguments the call actually used (`runGh('issue', 'list', '--label',
 * 'x')`), never as one array literal/variable argument the existing
 * per-argument scan (`flattenArgvAcrossCallArguments`) looks for. Returns
 * the set of such names so `flattenGhArgvInvocations` can apply a
 * different resolution shape for them -- synthesizing one array from the
 * ENTIRE call-argument list, rather than looking for a single array-typed
 * argument within it (see `flattenArgvFromRestParams`).
 */
function findRestParamGhWrapperNames(contents) {
  const names = new Set();

  const pattern = new RegExp(
    '(?:function\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\s*\\.\\.\\.[A-Za-z_$][\\w$]*\\s*\\)\\s*)|' +
      '(?:(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s+)?' +
      '(?:function\\b[^(]*\\(\\s*\\.\\.\\.[A-Za-z_$][\\w$]*\\s*\\)\\s*|' +
      '\\(\\s*\\.\\.\\.[A-Za-z_$][\\w$]*\\s*\\)\\s*=>\\s*))',
    'g',
  );

  let match;
  while ((match = pattern.exec(contents)) !== null) {
    const name = match[1] ?? match[2];
    if (!name) continue;

    const body = stripCommentsForWrapperBodyScan(
      extractDefinitionBody(contents, match.index + match[0].length),
    );
    if (DIRECT_GH_CALL_PATTERN.test(body)) names.add(name);
  }

  return names;
}

/**
 * Parses ES-module named-import AND named-RE-EXPORT bindings -- `import {
 * a, b as c } from './relative/path'` and `export { a, b as c } from
 * './relative/path'` -- returning `{ localName, importedName, specifier }`
 * for each named specifier. A re-export is treated identically to an
 * import for this file's purposes: `export { invokeGh } from
 * './gh-utils.mjs'` gives the RE-EXPORTING file its own local binding
 * named `invokeGh`, resolved against the same source file, the same way an
 * `import` would -- Vasquez/Ripley (round 9): a wrapper re-exported
 * through an intermediate "barrel" file (`export { invokeGh } from
 * './gh-utils.mjs';` in an index module, then `import { invokeGh } from
 * './index.mjs'` elsewhere) was invisible, since only the `import` form
 * was recognized. Folding the re-export form into this same function lets
 * `collectProjectGhWrapperNames`'s existing fixed-point loop chain through
 * a barrel file automatically -- the barrel's OWN entry in
 * `wrapperNamesByPath` gains `invokeGh` (as if it had imported and never
 * used it) in one pass, and the second file's `import` of it from the
 * barrel resolves in the following pass, with no additional wiring.
 * Deliberately narrow, matching this file's other import-parsing limits:
 * only a named list (`{ ... }`) of a quoted RELATIVE specifier is
 * recognized; a default import/re-export, a namespace
 * (`export * from ...`) re-export, and dynamic `import(...)` remain out
 * of scope. `specifier` is returned UNRESOLVED (as written in the source)
 * -- resolving it against the scanned file set is `resolveRelativeModulePath`'s
 * job, kept separate so this function stays a pure syntax read.
 */
function findImportedBindings(contents) {
  const bindings = [];
  const importPattern =
    /(?:import|export)\s*\{([^}]*)}\s*from\s*['"]([^'"]+)['"]/g;

  let importMatch;
  while ((importMatch = importPattern.exec(contents)) !== null) {
    const specifier = importMatch[2];
    for (const rawSpecifier of importMatch[1].split(',')) {
      const trimmed = rawSpecifier.trim();
      if (trimmed === '') continue;

      const aliasMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(
        trimmed,
      );
      if (aliasMatch) {
        bindings.push({
          importedName: aliasMatch[1],
          localName: aliasMatch[2],
          specifier,
        });
        continue;
      }

      const nameMatch = /^([A-Za-z_$][\w$]*)$/.exec(trimmed);
      if (nameMatch) {
        bindings.push({
          importedName: nameMatch[1],
          localName: nameMatch[1],
          specifier,
        });
      }
    }
  }

  return bindings;
}

/**
 * Resolves a relative import specifier (`./gh-utils.mjs`, `../lib/gh`) to
 * one of the paths in `knownPaths`, relative to the importing file's OWN
 * path (`fromPath`) -- both must use POSIX-style `/` separators, which is
 * what `git ls-files` (this file's own `listFiles` default) and every
 * `ScannedFile.path` in this module already use. Returns `null` for a
 * bare/package specifier (does not start with `./`/`../`) or one that does
 * not resolve to any path this scan already has the text for -- an import
 * from outside the scanned directories, or from a file this scan does not
 * track, is out of reach for the same reason a wrapper defined in an
 * unscanned file always has been.
 */
function resolveRelativeModulePath(fromPath, specifier, knownPaths) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return null;
  }

  const fromDirectory = path.posix.dirname(fromPath);
  const joined = path.posix
    .normalize(path.posix.join(fromDirectory, specifier))
    .replace(/\\/g, '/');

  const candidates = [joined, `${joined}.mjs`, `${joined}.js`, `${joined}.cjs`];
  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves gh-wrapper names PROJECT-WIDE across every file in `files`,
 * returning a `Map<path, Set<wrapperName>>` -- the names each file's own
 * `flattenGhArgvInvocations(contents, extraWrapperNames)` call should treat
 * as wrappers, beyond what it can already find unaided by reading only its
 * own text via `findGhWrapperNames`.
 *
 * Extends single-file, single-hop wrapper detection in FIVE directions,
 * found across rounds 6, 8, 9, and 10 review (Vasquez/Ripley):
 *   1. NESTED wrappers: a wrapper that calls another already-known wrapper
 *      rather than `gh` directly, resolved to a FIXED POINT so a chain of
 *      any depth is eventually found, not just one hop.
 *   2. ALIASED wrappers: a bare reference assignment (`const myGh =
 *      invokeGh;`, no call, no parens) to an already-known wrapper, later
 *      called under the new name (`myGh([...])`) -- a name-to-name binding
 *      neither of the other two passes recognizes on its own. A
 *      FACTORY-RETURNED variant of the same idea -- `const runGh =
 *      makeGhRunner();`, a CALL to an already-known wrapper whose return
 *      value (not the wrapper itself) is the one actually invoked later --
 *      is resolved the same way, via `findFactoryReturnedGhWrapperNames`.
 *      A DESTRUCTURED-PROPERTY variant -- `const { runGh: rg } = someObj;`
 *      -- binding a NEW local name to an already-known wrapper's PROPERTY
 *      (typically a class/object method-shorthand), rather than to the
 *      whole right-hand expression, is resolved the same way too, via
 *      `findDestructuredGhWrapperNames`. The no-rename form (`const {
 *      runGh } = someObj;`) intentionally produces no NEW name (the local
 *      binding is identical to the already-known source name), and remains
 *      out of scope for the same reason a bare call to an existing
 *      method-classified name already is: closing it would require
 *      widening that name's call-site scan beyond `'method'` mode
 *      (`.runGh(`/`['runGh'](`) to also match a BARE call
 *      (`runGh(...)`), which risks reintroducing the exact
 *      unrelated-bare-identifier false positive `'method'`-mode scoping
 *      was added to prevent (round 9/Vasquez) -- left for a future round
 *      if a reviewer demonstrates this specific shape.
 *   3. CROSS-FILE wrappers: a wrapper defined in one scanned file and
 *      imported OR RE-EXPORTED (by name, with an optional alias) into
 *      another -- `import { invokeGh } from './gh-utils.mjs';
 *      invokeGh([...])`, or the same wrapper re-exported through an
 *      intermediate barrel file (`export { invokeGh } from
 *      './gh-utils.mjs';` in an index module) and imported from THAT --
 *      is invisible to a per-file scan that only reads its own text, since
 *      the wrapper's defining body never appears in the importing file.
 *      `findImportedBindings` treats both forms identically, so the SAME
 *      fixed-point loop below chains through any number of re-export hops
 *      without extra plumbing.
 *   4. DEFAULT-EXPORTED wrappers: `export default (args) =>
 *      execFileSync('gh', args);`, imported as `import invokeGh from
 *      './gh-utils.mjs'`. A default export has no name of its own inside
 *      the defining module, so it cannot be folded into the same
 *      name-keyed `Set` the other three cases use directly -- it is
 *      tracked via the sentinel entry `'default'` in that file's own
 *      wrapper-name `Set` instead (added at INIT time if the default
 *      export shells out to `gh` directly, per
 *      `hasGhWrapperDefaultExportFunction`, or during the fixed-point loop
 *      if it is a bare-identifier re-export of an already-known wrapper,
 *      per `findDefaultExportAliasTarget`), and a default IMPORT resolves
 *      against that sentinel via `findDefaultImportBindings`. The literal
 *      string `'default'` is never itself scanned as a callable identifier
 *      by `flattenGhArgvInvocations` (`default(...)` is not valid call
 *      syntax in JavaScript), so leaving the sentinel in a file's own
 *      `Set` alongside real names is harmless.
 *
 * Still deliberately narrow beyond these: a wrapper imported from a file
 * OUTSIDE `SCANNED_DIRECTORIES` (this function only knows about the paths
 * it is given), a namespace import/re-export (`import * as ns`/`export *
 * from`), a combined default-plus-named import, a getter/setter method, or
 * an argv threaded through anything past what `flattenGhArgvInvocations`
 * itself can resolve (`.push()`, `.concat()`, a computed/interpolated
 * call) remains out of reach -- the same limits stated throughout this
 * file.
 */
export function collectProjectGhWrapperNames(files) {
  const knownPaths = new Set(files.map((file) => file.path));
  const wrapperNamesByPath = new Map(
    files.map((file) => {
      const names = findGhWrapperNames(file.contents);
      if (hasGhWrapperDefaultExportFunction(file.contents)) {
        names.add('default');
      }
      return [file.path, names];
    }),
  );

  let changed = true;
  while (changed) {
    changed = false;

    for (const file of files) {
      const known = wrapperNamesByPath.get(file.path);

      for (const nestedName of findNestedGhWrapperNames(file.contents, known)) {
        if (!known.has(nestedName)) {
          known.add(nestedName);
          changed = true;
        }
      }

      for (const aliasedName of findAliasedGhWrapperNames(
        file.contents,
        known,
      )) {
        if (!known.has(aliasedName)) {
          known.add(aliasedName);
          changed = true;
        }
      }

      for (const factoryAliasedName of findFactoryReturnedGhWrapperNames(
        file.contents,
        known,
      )) {
        if (!known.has(factoryAliasedName)) {
          known.add(factoryAliasedName);
          changed = true;
        }
      }

      for (const destructuredName of findDestructuredGhWrapperNames(
        file.contents,
        known,
      )) {
        if (!known.has(destructuredName)) {
          known.add(destructuredName);
          changed = true;
        }
      }

      const defaultExportAliasTarget = findDefaultExportAliasTarget(
        file.contents,
      );
      if (
        defaultExportAliasTarget &&
        known.has(defaultExportAliasTarget) &&
        !known.has('default')
      ) {
        known.add('default');
        changed = true;
      }

      for (const { localName, importedName, specifier } of findImportedBindings(
        file.contents,
      )) {
        if (known.has(localName)) continue;
        const resolvedPath = resolveRelativeModulePath(
          file.path,
          specifier,
          knownPaths,
        );
        if (!resolvedPath) continue;
        const sourceWrapperNames = wrapperNamesByPath.get(resolvedPath);
        if (sourceWrapperNames?.has(importedName)) {
          known.add(localName);
          changed = true;
        }
      }

      for (const { localName, specifier } of findDefaultImportBindings(
        file.contents,
      )) {
        if (known.has(localName)) continue;
        const resolvedPath = resolveRelativeModulePath(
          file.path,
          specifier,
          knownPaths,
        );
        if (!resolvedPath) continue;
        const sourceWrapperNames = wrapperNamesByPath.get(resolvedPath);
        if (sourceWrapperNames?.has('default')) {
          known.add(localName);
          changed = true;
        }
      }
    }
  }

  return wrapperNamesByPath;
}

/**
 * Reads one function/arrow definition's body starting just after its
 * header (`function NAME(...)`, `NAME = (...) =>`, ...): a `{ ... }` block
 * body is read out via brace-depth balancing; an expression-bodied arrow
 * (`NAME = (...) => execFileSync('gh', args)`) is read out via paren/
 * bracket/brace-depth balancing up to the first depth-0 statement
 * terminator, since it may itself contain nested call parentheses.
 */
function extractDefinitionBody(contents, afterHeaderIndex) {
  let index = afterHeaderIndex;
  while (index < contents.length && /\s/.test(contents[index])) index++;

  if (contents[index] === '{') {
    let depth = 0;
    for (let i = index; i < contents.length; i++) {
      if (contents[i] === '{') depth++;
      else if (contents[i] === '}') {
        depth--;
        if (depth === 0) return contents.slice(index + 1, i);
      }
    }
    return contents.slice(index + 1);
  }

  let depth = 0;
  const start = index;
  for (; index < contents.length; index++) {
    const character = contents[index];
    if (character === '(' || character === '[' || character === '{') {
      depth++;
    } else if (character === ')' || character === ']' || character === '}') {
      depth--;
    } else if (depth === 0 && (character === ';' || character === '\n')) {
      break;
    }
  }
  return contents.slice(start, index);
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
  const needsReview = [];
  const fileList = files ?? [];
  const projectWrapperNames = collectProjectGhWrapperNames(fileList);

  for (const file of fileList) {
    for (const { name, snippet } of findUnresolvedGhWrapperCalls(
      file.contents,
    )) {
      needsReview.push({ path: file.path, name, snippet });
    }

    const searchText = [
      file.contents,
      flattenGhArgvInvocations(
        file.contents,
        projectWrapperNames.get(file.path),
      ),
      flattenIndirectLabelQueryConstruction(file.contents),
    ]
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

  return { violations, allowlisted, needsReview };
}

export function formatNeedsReview({ path: filePath, name, snippet }) {
  return [
    `  ${filePath}`,
    `    wrapper: ${name}(...)`,
    `    could not statically verify this call's argv: ${snippet}`,
    '    #299: an unresolvable call to a known gh-wrapper is never assumed ' +
      'safe by this check — read the call site by hand and confirm it does ' +
      'not feed a label-search-index query, then add an allowlist entry (or ' +
      'rewrite the call so its argv is statically visible) to clear this.',
  ].join('\n');
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
 *
 * Vasquez (round 5): the `lstat`-then-`readFile` sequence above is two
 * separate filesystem calls, so a regular file at the checked path could in
 * principle be swapped for a symlink in the gap between them (TOCTOU). The
 * airtight fix -- opening with `O_NOFOLLOW` so the open itself fails
 * atomically if the path is a symlink -- is POSIX-only: `fs.constants.
 * O_NOFOLLOW` is `undefined` on Windows (confirmed on this repo's own
 * windows-latest runner), and this repo's CI runs both `windows-latest` and
 * `macos-latest`, so a Windows build silently WOULD NOT get the protection
 * a `|` of an `undefined` flag is a no-op, not an error. Since a portable,
 * single-syscall guarantee isn't available across both platforms this
 * script must run on, the gap is narrowed instead of closed by re-checking
 * with a SECOND `lstat` immediately after the read: if the path is a
 * symlink post-read, the just-read content is discarded (never added to
 * `files`) and the path moves to `refusedSymlinks` instead, same as if it
 * had been caught on the first check. This still cannot defeat a
 * sufficiently well-timed adversary controlling the filesystem live during
 * this scan's run -- no portable Node API can, without an OS-specific
 * syscall this script cannot rely on across both CI platforms -- but it
 * ensures a swap that lands validation on wrong-then-right OR right-
 * then-wrong-again symlink states is caught by ONE of the two checks
 * rather than trusted on the strength of only the first.
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

      const contents = readFile(relativePath);

      // Re-check immediately after reading: narrows (does not eliminate --
      // see the TOCTOU note above) the window in which this path could have
      // been swapped for a symlink between the check above and this read.
      if (lstat(relativePath).isSymbolicLink()) {
        refusedSymlinks.push(relativePath);
        continue;
      }

      files.push({ path: relativePath, contents });
    }
  }
  return { files, refusedSymlinks };
}

async function main() {
  const { files, refusedSymlinks } = collectScannedFiles();
  const { violations, allowlisted, needsReview } = scanLabelIndexUsage({
    files,
  });

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

  if (needsReview.length > 0) {
    console.error(
      `[label-index-usage] ${needsReview.length} call(s) to a known gh-wrapper ` +
        'could not be statically verified and need manual review (#299: an ' +
        'unresolvable call is never assumed safe):\n',
    );
    for (const entry of needsReview) {
      console.error(formatNeedsReview(entry));
    }
    process.exitCode = 1;
  }

  if (
    refusedSymlinks.length > 0 ||
    violations.length > 0 ||
    needsReview.length > 0
  ) {
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
