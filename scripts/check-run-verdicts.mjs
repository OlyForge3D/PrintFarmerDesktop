#!/usr/bin/env node
// Reads check-run conclusions from the Checks API directly, instead of
// `gh pr checks`, because the rendered table collapses two different
// outcomes onto one string.
//
// THE DEFECT (#562). `gh pr checks` renders both `conclusion: failure` and
// `conclusion: cancelled` as the single word `fail`. Since #540 made
// concurrency-group supersede-cancellation routine, a rapid re-push now
// produces a wall of `fail` rows for checks that never ran a failing step --
// they were cancelled by a newer run superseding them, not defeated by one.
// An agent or human triaging from that rendered view reads "fail" as "the
// build is broken" and has no way to tell the two apart, because the view
// does not carry the distinction.
//
//     $ gh pr checks 560
//     Sequencing hold        fail          <- rendered
//
//     $ gh api commits/<sha>/check-runs --jq '... | select(.name=="Sequencing hold")'
//     conclusion=cancelled                  <- ground truth, five runs, zero failures
//
// THE FIX. Read `commits/<sha>/check-runs` -- which dereferences a SHA prefix
// rather than filtering on it (see probe-sha-query.mjs / #379) -- and
// classify each conclusion into one of three verdicts instead of two:
//
//   passed      success, neutral, skipped
//   failed      failure, timed_out, action_required, startup_failure
//   superseded  cancelled, stale -- NOT folded into failed. "No verdict",
//               exactly as the citation-reachability harness (#562's cited
//               precedent) exits 2 for "could not look" rather than
//               guessing.
//   pending     status is not yet completed (conclusion is still null)
//
// `superseded` is deliberately its own bucket rather than a note attached to
// `failed`. Folding it back in under a different label reproduces the exact
// defect this file exists to remove: a reader who only checks
// `verdict === 'failed'` would still read a superseded run as broken.
//
// CONTROLS, per the citation-reachability pattern this issue names
// explicitly: a positive control (a genuine `failure` still reports
// `failed`), a negative control (`success` reports `passed`), and an
// explicit assertion that `cancelled` does NOT report `failed`. All three are
// exercised in tests/checkRunVerdicts.test.ts, and a matcher whose positive
// control was never established is how #562's class of defect survives.
//
// When more than one run exists for a check name at a SHA (retries,
// concurrency-superseded attempts), only the most recently started run's
// conclusion is reported -- the same "latest, not aggregate" rule
// `gh pr checks` itself applies, so this does not introduce a second axis of
// disagreement with the tool it replaces.

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EXIT_CLEAN = 0;
export const EXIT_FAILED = 1;
export const EXIT_UNDETERMINED = 2;

export const VERDICT_PASSED = 'passed';
export const VERDICT_FAILED = 'failed';
export const VERDICT_SUPERSEDED = 'superseded';
export const VERDICT_PENDING = 'pending';

const PASS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
]);
const SUPERSEDED_CONCLUSIONS = new Set(['cancelled', 'stale']);
// A check-run `name` is not a trusted string: anyone who can create a check
// run against a commit -- for instance via a workflow triggered from a fork
// PR -- controls this field, yet it is interpolated straight into terminal
// output and error messages below (`formatReport`, the thrown-error messages
// in this function and in `isNewerCheckRun`). C0 control characters (0x00-
// 0x1F) and DEL (0x7F) include the ESC byte that begins every ANSI escape
// sequence; leaving them in place would let an attacker-controlled name
// rewrite terminal output (cursor moves, color changes, even overwriting
// prior lines) or otherwise corrupt the report a human or agent is reading.
// Stripping every control byte removes the trigger for any such sequence
// regardless of what follows it, without having to enumerate escape-sequence
// grammars. Beyond that C0/C1/DEL byte range, two further classes of
// Unicode codepoints are stripped for the same reason: U+2028 (LINE
// SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are newline-equivalent
// characters honored by many terminals/renderers, so a name embedding one
// could forge an apparent extra row in printed report output, letting
// fabricated text masquerade as a separate check result; and the Unicode
// "Cf" (format) general category -- bidi embeddings/overrides/isolates
// (U+202A-U+202E, U+2066-U+2069), zero-width space/joiners (U+200B-U+200D),
// the byte-order mark (U+FEFF), and every other invisible-or-reordering
// codepoint in that category -- let a name visually reorder, hide, or
// splice into the displayed text in any renderer that honors them, the
// same "attacker name spoofs what is read" attack as ANSI escapes, just
// via different Unicode mechanisms. Matching the whole Cf category (via
// `\p{Cf}`) rather than an enumerated list of specific code points closes
// this attack class in general instead of one code point at a time.
// eslint-disable-next-line no-control-regex -- see comment above: strips C0/DEL/C1 control bytes, Unicode line/paragraph separators (U+2028/U+2029), and the entire Unicode "Cf" (format) category -- bidi controls, zero-width characters, the BOM, and similar -- from an attacker-controlled check-run name before it is ever printed.
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f-\x9f\u2028\u2029]|\p{Cf}/gu; // prettier-ignore
// GitHub's Checks API always returns `started_at`/`completed_at` in strict
// ISO 8601 with a literal `Z` suffix (e.g. "2026-08-06T16:00:00Z"), never
// any other `Date.parse`-acceptable shape. `Date.parse` alone is too
// permissive as a validator: it also happily accepts RFC 2822
// ("Thu, 06 Aug 2026 16:00:00 GMT") and other non-GitHub formats, so a
// drifted/malformed API response carrying a timestamp in one of those
// shapes would sail through a `Date.parse`-only check as "valid" even
// though it is not a shape this API ever actually emits. Requiring the
// documented shape up front closes that gap the same way the status/
// conclusion enum checks close theirs: fail closed on anything that isn't
// the one shape GitHub is known to send, rather than accepting anything a
// permissive parser can make sense of.
const ISO_8601_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/**
 * A shape match against ISO_8601_TIMESTAMP_PATTERN is not enough on its
 * own: `Date.parse` -- which every downstream comparison in this file
 * relies on -- does not reject an impossible calendar date or an
 * out-of-range time component, it silently *normalizes* it into an
 * adjacent valid one instead (e.g. "2026-02-30T00:00:00Z" parses as if it
 * were March 2nd; "2026-08-06T24:00:00Z" parses as the following
 * midnight). A malformed/drifted response carrying one of these would
 * still match the regex and still produce a `Date.parse`-able value, so
 * it would sail through undetected and silently shift when compared
 * against other timestamps. Re-derive each component from the matched
 * calendar/time fields via `Date.UTC` and require it to read back
 * unchanged -- `Date.UTC` performs the exact same rollover `Date.parse`
 * does, so a mismatch here means the input was never a real calendar
 * date/time in the first place.
 * @param {string} value
 * @returns {boolean}
 */
function isValidGitHubTimestamp(value) {
  const match = ISO_8601_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  const asDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    asDate.getUTCFullYear() === year &&
    asDate.getUTCMonth() === month - 1 &&
    asDate.getUTCDate() === day &&
    asDate.getUTCHours() === hour &&
    asDate.getUTCMinutes() === minute &&
    asDate.getUTCSeconds() === second
  );
}
// GitHub's documented Checks API status enum (create/get a check run):
// https://docs.github.com/en/rest/checks/runs -- queued, in_progress, and
// completed are the states this file's logic actually branches on; waiting,
// requested, and pending are also documented values (used by deployment
// protection-rule integrations) that could in principle appear on a check
// run response. Anything outside this set is not a status GitHub documents
// at all, so it must fail closed rather than being treated as "not
// completed" (which is what an unrecognized string would silently become
// by falling through every `status === 'completed'` check below).
const KNOWN_STATUSES = new Set([
  'queued',
  'in_progress',
  'completed',
  'waiting',
  'requested',
  'pending',
]);

/**
 * Classify one check run's conclusion into a verdict.
 *
 * This is the whole fix: `cancelled` and `stale` map to `superseded`, a
 * distinct third answer, rather than being folded into `failed` the way
 * `gh pr checks` folds them. A conclusion this function has never seen
 * throws rather than guessing a bucket for it -- an unrecognized conclusion
 * is exactly the situation a silent default would misreport.
 *
 * @param {string | null} conclusion
 * @returns {'passed' | 'failed' | 'superseded' | 'pending'}
 */
export function classifyConclusion(conclusion) {
  if (conclusion === null) return VERDICT_PENDING;
  if (PASS_CONCLUSIONS.has(conclusion)) return VERDICT_PASSED;
  if (FAILED_CONCLUSIONS.has(conclusion)) return VERDICT_FAILED;
  if (SUPERSEDED_CONCLUSIONS.has(conclusion)) return VERDICT_SUPERSEDED;
  throw new Error(
    `unrecognized check-run conclusion ${JSON.stringify(conclusion)}; refusing to guess a verdict for it`,
  );
}

/**
 * @param {unknown} checkRun
 * @param {number} index
 * @returns {{name: string, displayName: string, conclusion: string | null, status: string, startedAt: string | null, completedAt: string | null, id: number}}
 */
function parseCheckRun(checkRun, index) {
  const name = /** @type {any} */ (checkRun)?.name;
  const status = /** @type {any} */ (checkRun)?.status;
  const startedAtRaw = /** @type {any} */ (checkRun)?.started_at;
  const completedAtRaw = /** @type {any} */ (checkRun)?.completed_at;
  const id = /** @type {any} */ (checkRun)?.id;
  const conclusion = /** @type {any} */ (checkRun)?.conclusion ?? null;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`check run ${index + 1} has no non-empty name`);
  }
  // Sanitize a *separate* display copy for anything that gets printed or
  // embedded in an error message (see CONTROL_CHARS_PATTERN above) -- but
  // never key/group runs by this sanitized value. Stripping control
  // characters before using the result as an identity would let two
  // distinct raw names collide into the same sanitized string (e.g.
  // "Desktop" and "De\x07sktop" both sanitize to "Desktop"), letting an
  // attacker-controlled check name silently alias onto -- and mask -- a
  // different, legitimately-named check's tracked verdict. The raw `name`
  // stays the grouping identity throughout; `displayName` is for output
  // only.
  const sanitizedName = name.replace(CONTROL_CHARS_PATTERN, '');
  if (sanitizedName.trim() === '') {
    // A name made up entirely of control characters (no printable content
    // at all) passes the raw non-empty check above -- control bytes are not
    // whitespace as far as `String.prototype.trim` is concerned -- but
    // becomes empty once sanitized. Treat that the same as the raw-empty
    // case rather than reporting a check with no visible name.
    throw new Error(
      `check run ${index + 1} has no non-empty name once control characters are stripped`,
    );
  }
  if (typeof status !== 'string' || status === '') {
    throw new Error(`check run ${index + 1} (${sanitizedName}) has no status`);
  }
  if (!KNOWN_STATUSES.has(status)) {
    // A garbage/unrecognized status (typo, API-version drift, a malformed
    // response) must not fall through the `status === 'completed'` checks
    // below and be silently treated as "not completed" -- that is exactly
    // how a structurally invalid response would resolve to `pending` and
    // let `main` exit clean, the same failure mode the two invariant
    // checks above already close for known-but-contradictory pairings.
    throw new Error(
      `check run ${index + 1} (${sanitizedName}) has an unrecognized status ${JSON.stringify(status)}`,
    );
  }
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      `check run ${index + 1} (${sanitizedName}) has no positive integer id`,
    );
  }
  if (conclusion !== null && typeof conclusion !== 'string') {
    throw new Error(
      `check run ${index + 1} (${sanitizedName}) has a non-string conclusion`,
    );
  }
  // `conclusion: null` is the normal, expected shape for a run that has not
  // completed yet -- that is what "pending" means. But a run whose `status`
  // is already `completed` is documented by GitHub to always carry a
  // conclusion; `completed` with `conclusion: null` is not a real API shape,
  // it is malformed input. Treating it as `pending` would be actively wrong
  // (it reads as "still running", when the run has in fact finished with no
  // recorded verdict), and letting it fall through to a clean exit would
  // reintroduce exactly the kind of false-negative "everything's fine"
  // misreporting this file exists to prevent. Fail closed instead.
  if (status === 'completed' && conclusion === null) {
    throw new Error(
      `check run ${index + 1} (${sanitizedName}) is completed but has no conclusion`,
    );
  }
  // The inverse contract violation: GitHub only sets `conclusion` once a
  // run's `status` becomes `completed` -- a run still `queued` or
  // `in_progress` should always report `conclusion: null`. A malformed or
  // buggy response that sends a non-null conclusion (e.g. "failure") on a
  // still-open run is the same class of impossible status/conclusion
  // pairing as the completed-with-null case above, and must fail the same
  // way: silently normalizing it away (the prior behaviour) would let a
  // structurally invalid response resolve to `pending` and let `main` exit
  // clean, instead of surfacing that the input violated the API's own
  // documented contract.
  if (status !== 'completed' && conclusion !== null) {
    throw new Error(
      `check run ${index + 1} (${sanitizedName}) has status ${JSON.stringify(status)} but a non-null conclusion ${JSON.stringify(conclusion)} -- only a completed run should carry one`,
    );
  }
  // A run still `queued` (or one of the deployment-protection-rule states
  // `waiting`/`requested`/`pending`) legitimately has not started yet, so
  // GitHub reports `started_at: null` for it -- that is not malformed
  // input, it is the normal shape of "not yet begun". `in_progress`,
  // though, definitionally means work has begun, so GitHub always sets a
  // real `started_at` once a run reaches that status -- `in_progress` with
  // `started_at: null` is the same class of impossible combination as
  // `completed` with no timestamp, just one status earlier, and silently
  // accepting it would let such a run's null `started_at` feed
  // `isNewerCheckRun`'s "still open, no timestamp to bound against" branch
  // and let it outrank a completed run it may not actually be newer than.
  let startedAt = null;
  if (startedAtRaw !== null && startedAtRaw !== undefined) {
    if (
      typeof startedAtRaw !== 'string' ||
      !isValidGitHubTimestamp(startedAtRaw)
    ) {
      throw new Error(
        `check run ${index + 1} (${sanitizedName}) has an invalid started_at`,
      );
    }
    startedAt = startedAtRaw;
  } else if (status === 'completed' || status === 'in_progress') {
    throw new Error(
      `check run ${index + 1} (${sanitizedName}) has status ${JSON.stringify(status)} but no started_at`,
    );
  }
  let completedAt = null;
  if (completedAtRaw !== null && completedAtRaw !== undefined) {
    if (
      typeof completedAtRaw !== 'string' ||
      !isValidGitHubTimestamp(completedAtRaw)
    ) {
      throw new Error(
        `check run ${index + 1} (${sanitizedName}) has an invalid completed_at`,
      );
    }
    if (status !== 'completed') {
      // The same contradiction as a non-null conclusion on a still-open
      // run, just on the timestamp instead of the verdict field: GitHub
      // only sets `completed_at` once a run's status becomes `completed`.
      // A queued/in_progress run reporting one anyway is not a real API
      // shape, and silently accepting it (the prior behaviour) risks a
      // caller inferring the run has finished when `status` says
      // otherwise -- fail closed instead of trusting either field alone.
      throw new Error(
        `check run ${index + 1} (${sanitizedName}) has status ${JSON.stringify(status)} but a non-null completed_at -- only a completed run should carry one`,
      );
    }
    completedAt = completedAtRaw;
  } else if (status === 'completed') {
    throw new Error(
      `check run ${index + 1} (${sanitizedName}) is completed but has no completed_at`,
    );
  }
  if (
    status === 'completed' &&
    startedAt !== null &&
    completedAt !== null &&
    Date.parse(completedAt) < Date.parse(startedAt)
  ) {
    // A completed run's own two timestamps are internally contradictory --
    // it claims to have finished before it started, a negative duration
    // that cannot happen for a genuine run. This is the same class of
    // corrupt-but-plausible-looking input as the other invariants checked
    // above: silently accepting it wouldn't just misreport this one run's
    // conclusion, it could feed a corrupt timestamp into
    // `isNewerCheckRun`'s "latest attempt" comparison and cause it to pick
    // the wrong run for a name entirely. Fail closed instead of trusting
    // either timestamp on its own.
    throw new Error(
      `check run ${index + 1} (${sanitizedName}) has completed_at (${completedAt}) earlier than started_at (${startedAt})`,
    );
  }
  // A run whose status is not yet 'completed' has not settled on a
  // conclusion regardless of what the field carries, so it is forced to
  // null here rather than trusted -- the same "don't trust a field the API
  // hasn't committed to yet" discipline as elsewhere in this repo's checks.
  return {
    name,
    displayName: sanitizedName,
    conclusion: status === 'completed' ? conclusion : null,
    status,
    startedAt,
    completedAt,
    id,
  };
}

/**
 * Compare two parsed check runs for the same name and report which one is
 * the more recent attempt: `1` if `a` is strictly newer than `b`, `-1` if
 * `a` is strictly older, or `0` if the two cannot be safely ordered from
 * the data available (a genuine tie, or one/both sides carry no timestamp
 * this function can use).
 *
 * Round-8 finding (Ripley and Vasquez, independently, same root cause):
 * an earlier version of this function decided recency via a set of
 * separate pairwise rules -- "open beats completed, but bounded against
 * the completed run's own timestamp" for one pair of states, "started
 * beats queued, unconditionally" for another. Each rule was locally
 * defensible, but composing them did not produce a genuine partial order:
 * a stale `in_progress` run could beat a `queued` rerun (via the
 * unconditional "started beats queued" rule), that `queued` rerun could
 * beat a `completed failure` (via the bounded-timestamp rule, since it was
 * created after the failure completed), and that same `completed failure`
 * could beat the original stale `in_progress` run (via the bounded rule
 * again, since the failure started after the stale run started) -- a
 * genuine 3-cycle (A > C, C > B, B > A) among three runs for the same
 * name. Which run `latestCheckRunsByName` reported as "latest" then
 * depended on the input array's order, defeating the entire point of a
 * "latest run" computation.
 *
 * The fix: stop deciding recency from ad hoc pairwise rules and instead
 * score each run independently, then compare the scores. Any comparison
 * built by comparing a real-number score per input is transitive by
 * construction (it is just `<` on numbers) -- there is no way for it to
 * produce a cycle, no matter how the score is computed, as long as the
 * score is a pure function of one run alone (never of the pair being
 * compared).
 *
 * A follow-up rewrite scored each run by a field called `created_at`,
 * reasoning that every check run carries one from the moment it is
 * created, regardless of status. That reasoning was wrong: `created_at`
 * is not a field the Checks API actually puts on a check-run object at
 * all (only on the run's `app` and `check_suite`, not the run itself --
 * see GitHub's REST API reference for "Check Runs"). Requiring it in
 * `parseCheckRun` made every real PR's check runs fail to parse ("invalid
 * created_at"), confirmed by Ripley against this repo's own live Checks
 * API response (every run, including completed ones, actually comes back
 * with `created_at: null`, because the field simply is not there). That
 * requirement is reverted; this function is back to using only
 * `started_at`/`completed_at`, which the API genuinely documents and
 * `parseCheckRun` genuinely validates.
 *
 * The fix for the real (transitivity) bug does not require inventing a
 * field, though -- it requires the same thing the round-8 finding asked
 * for: a score that is a pure function of one run, not a rule that
 * depends on which states the two runs being compared happen to be in.
 * That score is a `(primary, secondary)` pair:
 *
 *   primary   = `completed_at` if the run is completed, otherwise
 *               `started_at` (which may be `null` for a run that has not
 *               started yet).
 *   secondary = `started_at`, used only to break an exact tie on
 *               `primary` between two completed runs. `completed_at` is
 *               only second-resolution, so two reruns of a fast job can
 *               genuinely finish in the same reported second (this
 *               repo's own live data has shown exactly that); `started_at`
 *               is an independent signal not tied to that same-second
 *               collision, since a later rerun was, definitionally,
 *               started no earlier than the run it superseded.
 *
 * Comparing runs by this per-run score directly -- rather than by a rule
 * that depends on which states the pair being compared are in -- is what
 * makes the result transitive: it reduces to ordinary comparison of
 * values that are each a pure function of one run alone, so it can never
 * form a cycle no matter what order the runs are folded in.
 *
 * When `primary` is `null` on either side (a run that is still
 * queued/waiting/requested and has not started yet, so the API gives it
 * no timestamp at all), this returns `0` rather than guessing. There is
 * no bound left to check such a run against, so treating it as either
 * newer or older than another run would be an unfounded assumption.
 * `latestCheckRunsByName` already fails closed (throws "cannot
 * determine") on an unresolved `0` that survives to the end, which is the
 * correct outcome here: confidently picking a side for a run the API
 * gives no timestamp evidence for would be exactly the kind of
 * "plausible-looking but wrong" misreporting this file exists to prevent.
 *
 * @param {ReturnType<typeof parseCheckRun>} run
 * @returns {number | null}
 */
function primaryRecencyTime(run) {
  const anchor = run.completedAt ?? run.startedAt;
  return anchor === null ? null : Date.parse(anchor);
}

/**
 * @param {ReturnType<typeof parseCheckRun>} run
 * @returns {number | null}
 */
function secondaryRecencyTime(run) {
  // Only meaningful as a tiebreaker between two completed runs (see
  // compareCheckRunRecency's doc comment): for a run that is not
  // completed, `startedAt` IS its `primary` score already (or null), so
  // reusing it here would let a genuine primary-level tie between an open
  // run and a completed run resolve via the open run's own started_at
  // instead of correctly staying unresolved.
  if (run.status !== 'completed' || run.startedAt === null) return null;
  return Date.parse(run.startedAt);
}

/**
 * @param {ReturnType<typeof parseCheckRun>} a
 * @param {ReturnType<typeof parseCheckRun>} b
 * @returns {1 | -1 | 0}
 */
function compareCheckRunRecency(a, b) {
  const aPrimary = primaryRecencyTime(a);
  const bPrimary = primaryRecencyTime(b);
  if (aPrimary === null || bPrimary === null) return 0;
  if (aPrimary !== bPrimary) return aPrimary > bPrimary ? 1 : -1;
  const aSecondary = secondaryRecencyTime(a);
  const bSecondary = secondaryRecencyTime(b);
  if (aSecondary === null || bSecondary === null) return 0;
  if (aSecondary !== bSecondary) return aSecondary > bSecondary ? 1 : -1;
  return 0;
}

/**
 * Reduce every check run to the single most-recent run per name.
 *
 * `compareCheckRunRecency` can return "unresolvable" (`0`) for a given pair
 * without that meaning the name's overall latest run is unresolvable --  a
 * later run in the input can still unambiguously outrank both members of an
 * earlier ambiguous pair. So this cannot simply fold the list with a single
 * "current best" and bail out on the first ambiguous pair it meets (that
 * was the prior, buggy behaviour): it tracks every run *not yet proven
 * older than some other run seen so far* (the "undominated" set) and only
 * commits to a verdict once the whole list has been seen. If more than one
 * run remains undominated at the end, that ambiguity is real and
 * unresolvable, and only then does this throw -- callers (`buildVerdicts`/
 * `main`) already treat a thrown error as undetermined, so this fails
 * closed rather than reporting a possibly-wrong verdict as authoritative.
 *
 * `gh pr checks` itself renders only the latest run for a given name, so
 * reporting anything else here would disagree with the tool this replaces
 * along a second axis the issue never raised.
 *
 * @param {readonly unknown[]} checkRuns
 * @returns {Map<string, ReturnType<typeof parseCheckRun>>}
 */
export function latestCheckRunsByName(checkRuns) {
  const parsed = checkRuns.map((checkRun, index) =>
    parseCheckRun(checkRun, index),
  );
  const groups = new Map();
  for (const run of parsed) {
    const group = groups.get(run.name);
    if (group) {
      group.push(run);
    } else {
      groups.set(run.name, [run]);
    }
  }
  const latest = new Map();
  for (const runs of groups.values()) {
    /** @type {ReturnType<typeof parseCheckRun>[]} */
    let undominated = [runs[0]];
    for (const run of runs.slice(1)) {
      const dominatedByExisting = undominated.some(
        (other) => compareCheckRunRecency(other, run) === 1,
      );
      if (dominatedByExisting) continue;
      undominated = undominated.filter(
        (other) => compareCheckRunRecency(run, other) !== 1,
      );
      undominated.push(run);
    }
    if (undominated.length > 1) {
      throw new Error(
        `cannot determine the latest attempt for check "${undominated[0].displayName}" -- runs ${undominated.map((run) => run.id).join(', ')} cannot be safely ordered relative to each other, and no other signal this API provides is a safe way to order them`,
      );
    }
    latest.set(undominated[0].name, undominated[0]);
  }
  return latest;
}

/**
 * @param {readonly unknown[]} checkRuns
 * @returns {{name: string, conclusion: string | null, verdict: string}[]}
 */
export function buildVerdicts(checkRuns) {
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) {
    throw new Error('no check runs to classify');
  }
  // Group/select using the raw name (see parseCheckRun), but the `name`
  // in the output here is what reaches the terminal/report -- that must
  // be the sanitized `displayName`, never the raw, attacker-controllable
  // value.
  return [...latestCheckRunsByName(checkRuns).values()]
    .map((run) => ({
      name: run.displayName,
      conclusion: run.conclusion,
      verdict: classifyConclusion(run.conclusion),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseArgs(argv) {
  /** @type {{repo?: string, sha?: string, help?: boolean, error?: string}} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--repo' || arg === '--sha') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        out.error = `${arg} requires a value`;
        return out;
      }
      if (arg === '--repo') out.repo = value;
      else out.sha = value;
      i += 1;
    } else {
      out.error = `unknown argument ${JSON.stringify(arg)}`;
      return out;
    }
  }
  return out;
}

/**
 * @param {string | undefined} requested
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {string | null}
 */
export function resolveRepo(requested, env, run) {
  if (requested) return /^[^/\s]+\/[^/\s]+$/.test(requested) ? requested : null;
  if (env.GITHUB_REPOSITORY) {
    return /^[^/\s]+\/[^/\s]+$/.test(env.GITHUB_REPOSITORY)
      ? env.GITHUB_REPOSITORY
      : null;
  }
  const result = run(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', env },
  );
  if (!result || result.error || result.status !== 0) return null;
  const slug = String(result.stdout ?? '').trim();
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

const PAGE_SIZE = 100;

/**
 * A sane upper bound on how many pages a single commit's check-runs
 * response could legitimately span, as defense in depth against a runaway
 * or hostile `gh api --paginate` response. No real commit needs 100,000
 * check runs.
 */
const MAX_PAGES = 1000;

/**
 * `commits/<sha>/check-runs` dereferences its path segment, so a short
 * prefix resolves the same way `gh api commits/<sha>/...` always has in this
 * repo (see probe-sha-query.mjs) -- no separate resolve step is needed here.
 *
 * Pages through every result rather than reading only the first `per_page`
 * rows. A commit with many re-run attempts -- routine in this repo once
 * concurrency-group cancellation (#540) makes cancelled runs common -- can
 * carry well over 100 check runs, and silently dropping the rest is the same
 * shape of misreporting this file exists to remove: a check beyond page one
 * would be invisible to `latestCheckRunsByName` even though it may be the
 * most recent attempt for its name.
 *
 * TERMINATION SIGNAL. An earlier version of this function inferred "no more
 * pages" from row counts alone (a short/empty page, or reaching the
 * API-reported `total_count`). Review found that heuristic unsound in both
 * directions: a *full* page reaching `total_count` is not proof there is
 * nothing beyond it (an under-reported `total_count`), and even a
 * short/empty page does not, by construction, rule out a later page still
 * holding real data if the underlying list changed mid-fetch in a way that
 * did not also change the reported `total_count`.
 *
 * GitHub's REST API already has an authoritative answer to "is there
 * another page": the response's `Link` header carries `rel="next"` if and
 * only if another page exists
 * (https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api).
 * `gh api --paginate` follows that header itself, so this delegates
 * termination to it entirely instead of re-deriving it from row counts --
 * verified directly against this repo's own commits: `gh api
 * .../check-runs?per_page=1 --paginate --slurp` against a commit with 20
 * check runs returns exactly 20 page objects (one per Link "next" hop),
 * and `per_page=20` against that same commit returns exactly 1 (no
 * wasted trailing empty-page request once `total_count` divides evenly by
 * `per_page`). `total_count` is still cross-checked for consistency across
 * every page and against the number of rows actually collected -- not to
 * decide when to stop, but as a sanity check on the API's own metadata.
 *
 * @param {string} repo
 * @param {string} sha
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {{ok: true, checkRuns: unknown[]} | {ok: false, reason: string}}
 */
export function fetchCheckRuns(repo, sha, env, run) {
  const result = run(
    'gh',
    [
      'api',
      `repos/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=${PAGE_SIZE}`,
      '--paginate',
      '--slurp',
    ],
    { encoding: 'utf8', env },
  );
  if (!result || result.error) {
    return { ok: false, reason: 'the check-runs query could not be executed' };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim();
    const status = /HTTP (\d{3})/.exec(stderr)?.[1];
    return {
      ok: false,
      reason: `the check-runs query failed${status ? ` (HTTP ${status})` : ''}`,
    };
  }
  const stdout = String(result.stdout ?? '').trim();
  let pages;
  try {
    pages = JSON.parse(stdout || 'null');
  } catch {
    return {
      ok: false,
      reason: 'the check-runs query did not return valid JSON',
    };
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    return {
      ok: false,
      reason: 'the check-runs response carried no pages',
    };
  }
  if (pages.length > MAX_PAGES) {
    return {
      ok: false,
      reason: `the check-runs response spanned ${pages.length} pages, over the ${MAX_PAGES}-page safety cap -- refusing to report a possibly-incomplete verdict`,
    };
  }
  const collected = [];
  const seenIds = new Set();
  let expectedTotal;
  for (const [index, page] of pages.entries()) {
    const totalCount = /** @type {any} */ (page)?.total_count;
    const rows = /** @type {any} */ (page)?.check_runs;
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      return {
        ok: false,
        reason: `page ${index + 1} of the check-runs response carried no non-negative integer total_count`,
      };
    }
    if (!Array.isArray(rows)) {
      return {
        ok: false,
        reason: `page ${index + 1} of the check-runs response carried no check_runs array`,
      };
    }
    expectedTotal ??= totalCount;
    if (totalCount !== expectedTotal) {
      return {
        ok: false,
        reason: `the check-runs total_count changed from ${expectedTotal} to ${totalCount} while it was paged`,
      };
    }
    for (const row of rows) {
      const id = /** @type {any} */ (row)?.id;
      if (typeof id === 'number') {
        if (seenIds.has(id)) {
          return {
            ok: false,
            reason: `the check-runs response returned duplicate check run id ${id} while it was paged`,
          };
        }
        seenIds.add(id);
      }
      collected.push(row);
    }
  }
  if (collected.length !== expectedTotal) {
    return {
      ok: false,
      reason: `the check-runs response reported total_count=${expectedTotal} but pagination (following the API's own "next page" Link header, not a row-count guess) actually collected ${collected.length} rows`,
    };
  }
  if (collected.length === 0) {
    return {
      ok: false,
      reason: `no check runs found for ${sha}`,
    };
  }
  return { ok: true, checkRuns: collected };
}

export function formatReport(sha, verdicts) {
  const lines = [`check-run verdicts for ${sha}`, ''];
  for (const { name, conclusion, verdict } of verdicts) {
    lines.push(
      `  ${verdict.padEnd(10)} ${name}  (conclusion=${conclusion ?? 'null'})`,
    );
  }
  const superseded = verdicts.filter((v) => v.verdict === VERDICT_SUPERSEDED);
  if (superseded.length > 0) {
    lines.push(
      '',
      `${superseded.length} check(s) superseded (cancelled by a newer run) -- not a failure, no verdict.`,
    );
  }
  return lines.join('\n');
}

export const USAGE = `usage: node scripts/check-run-verdicts.mjs --sha <sha-or-prefix> [--repo owner/name]

Reads commits/<sha>/check-runs from the Checks API and reports a three-way
verdict per check name -- passed, failed, or superseded -- instead of the
two-way pass/fail 'gh pr checks' renders. 'cancelled' reports 'superseded',
never 'failed'.

exit 0  every check passed, is pending, or was superseded (no verdict)
exit 1  at least one check genuinely failed
exit 2  undetermined -- could not read check runs`;

export function runMain(argv, env, run, write) {
  const args = parseArgs(argv);
  if (args.help) {
    write(USAGE);
    return EXIT_CLEAN;
  }
  if (args.error) {
    write(`${args.error}\n\n${USAGE}`);
    return EXIT_UNDETERMINED;
  }
  if (!args.sha) {
    write(`--sha is required\n\n${USAGE}`);
    return EXIT_UNDETERMINED;
  }

  const repo = resolveRepo(args.repo, env, run);
  if (!repo) {
    write('undetermined: could not determine a valid owner/name repository');
    return EXIT_UNDETERMINED;
  }

  const fetched = fetchCheckRuns(repo, args.sha, env, run);
  if (!fetched.ok) {
    write(`undetermined: ${fetched.reason}`);
    return EXIT_UNDETERMINED;
  }

  let verdicts;
  try {
    verdicts = buildVerdicts(fetched.checkRuns);
  } catch (error) {
    write(
      `undetermined: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_UNDETERMINED;
  }

  write(formatReport(args.sha, verdicts));
  return verdicts.some((v) => v.verdict === VERDICT_FAILED)
    ? EXIT_FAILED
    : EXIT_CLEAN;
}

export function main(
  argv,
  env = process.env,
  run = spawnSync,
  write = (text) => process.stdout.write(`${text}\n`),
) {
  try {
    return runMain(argv, env, run, write);
  } catch (error) {
    write(
      `undetermined: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_UNDETERMINED;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
