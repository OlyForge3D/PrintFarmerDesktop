// #336: `scripts/census-ownership-evidence.mjs` re-derives `ownershipEvidence`
// live on every run — it is not a cached snapshot — but the ISSUE was never
// that the script goes stale. It was that nothing checks whether the
// *reported* census itself is still being re-taken often enough to track a
// population that moves on a timer:
//
//   gc.reflogExpireUnreachable = 30 days
//
// A worktree's `ownershipEvidence` drains from true to false as its own
// creation reflog entries cross that 30-day line, with no event marking the
// transition. The 2026-08-04 baseline (worktrees=24, true=18, false=6,
// wrongly-accused=0) was published once; #336 exists because no session that
// took it will be here in 30 days to notice it has drifted.
//
// THIS FILE closes that gap the same way check-dated-measurement.mjs closes
// the analogous gap for a mutable GitHub object: it does not re-run the
// census itself (that is census-ownership-evidence.mjs's job, and it already
// self-re-derives). It asserts, mechanically, that a *citation* of a past
// census run is not older than the reflog decay clock the census depends on
// — and fails loudly, with a distinct exit code, the moment it is.
//
// THE THREE-VALUE ANSWER THIS GIVES, matching the two thresholds that matter:
//
//   FRESH  age <= RECOMMENDED_REMEASUREMENT_DAYS (7d, the issue's own
//          requested re-measurement cadence: "re-run in ~1 week").
//   DUE    RECOMMENDED_REMEASUREMENT_DAYS < age <= REFLOG_EXPIRY_DAYS (30d).
//          Re-measurement is now overdue, but the reflog window this
//          citation's `true` count depends on has not fully closed yet, so
//          the numbers are not yet provably wrong.
//   STALE  age > REFLOG_EXPIRY_DAYS. `gc.reflogExpireUnreachable` has had a
//          full cycle to run since this citation was taken. Any worktree the
//          citation counted `ownershipEvidence=true` may have silently
//          crossed into `false` since — a would-be finding may already read
//          as an abstention — and the citation's numbers can no longer be
//          trusted as a description of the current population.
//
// A citation dated in the future (measured_at later than now) is
// UNVERIFIABLE rather than FRESH, for the identical reason
// check-dated-measurement.mjs refuses that case for `updated_at`: a claim
// this check cannot make sense of is not evidence the claim is current.
//
// CONTROLS, so a check that has never fired is not indistinguishable from one
// that cannot fire (the same requirement #473 and #462 both name): a citation
// dated "now" must read FRESH (positive arm), and one dated far enough in the
// past to be unambiguously beyond both thresholds must read STALE (negative
// arm), evaluated fresh on every invocation rather than only in tests.
//
// CITATION FORMAT: a fenced block whose info string is `census-measured`,
// modelled directly on check-dated-measurement.mjs's `measured` block so a
// reader who already knows that convention recognizes this one:
//
//   ```census-measured
//   worktrees: 24
//   true: 18
//   false: 6
//   accused: 0
//   measured_at: 2026-08-04T00:00:00Z
//   ```
//
// `census-ownership-evidence.mjs`'s own `formatReport` now appends exactly
// this block to its report, so `npm run census:ownership-evidence` output can
// be pasted verbatim into an issue comment or PR body and later checked here
// with `--file`, without any hand-transcription step to get wrong.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizeTimestamp } from './check-dated-measurement.mjs';

export const VERDICT_FRESH = 'fresh';
export const VERDICT_DUE = 'due';
export const VERDICT_STALE = 'stale';
export const VERDICT_UNVERIFIABLE = 'unverifiable';

export const EXIT_OK = 0;
export const EXIT_DUE = 1;
export const EXIT_STALE = 2;
export const EXIT_UNVERIFIABLE = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The issue's own requested re-measurement cadence ("re-run in ~1 week"). */
export const RECOMMENDED_REMEASUREMENT_DAYS = 7;

/** `gc.reflogExpireUnreachable` — the decay clock the census depends on. */
export const REFLOG_EXPIRY_DAYS = 30;

/**
 * A fixed instant used only to drive the positive control. Never compared
 * against anything read from a real citation, so its value carries no
 * meaning beyond "some valid, parseable timestamp".
 */
export const SAMPLE_TIMESTAMP_FOR_CONTROLS = '2024-01-01T00:00:00Z';

/**
 * An instant guaranteed to be more than `REFLOG_EXPIRY_DAYS` before
 * `SAMPLE_TIMESTAMP_FOR_CONTROLS`, for the negative control: a citation this
 * old must never be reported FRESH or DUE.
 */
export const FABRICATED_ANCIENT_TIMESTAMP = '2000-01-01T00:00:00Z';

/**
 * Normalizes a value that names one instant in time — a finite epoch-ms
 * number or a parseable ISO string — to epoch-ms, or null if it names no
 * usable instant. Unlike `resolveNow`, this never defaults an omitted value
 * to the real clock: `measured_at` has no meaningful "unset means now".
 */
export function normalizeInstant(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  return normalizeTimestamp(value);
}

/**
 * Resolves the "now" side of the comparison. Accepts a finite epoch-ms
 * number (what a test wants), an ISO string (what a human passing `--now`
 * wants), or nothing (real wall-clock time). Returns null, like
 * `normalizeTimestamp`, when given something that resolves to no usable
 * instant — never silently falls back to `Date.now()` for a value that was
 * actually supplied and unparseable, which would mask the caller's mistake.
 */
export function resolveNow(now) {
  if (now === undefined) {
    return Date.now();
  }
  return normalizeInstant(now);
}

/**
 * The one comparison this whole mechanism rests on: how old is a census
 * citation relative to now, measured against the two thresholds above.
 *
 * `measuredAt` later than `now` is treated on the same footing
 * `classifyMeasurementFreshness` in check-dated-measurement.mjs treats
 * `live < cited`: never reported FRESH, because a citation this check
 * cannot make sense of is not evidence the claim is current.
 */
export function classifyCensusFreshness({ measuredAt, now } = {}) {
  const measuredMs = normalizeInstant(measuredAt);
  const nowMs = resolveNow(now);

  if (measuredMs === null || nowMs === null) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      exitCode: EXIT_UNVERIFIABLE,
      ageDays: null,
      reason:
        `cannot compare: measured_at ${JSON.stringify(measuredAt)} and now ${JSON.stringify(now)} ` +
        'do not both normalize to a usable instant',
    };
  }

  if (measuredMs > nowMs) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      exitCode: EXIT_UNVERIFIABLE,
      ageDays: null,
      reason:
        `the citation's measured_at (${new Date(measuredMs).toISOString()}) is later than now ` +
        `(${new Date(nowMs).toISOString()}); a census cannot have been taken in the future -- check ` +
        'the citation or the clock, not the population',
    };
  }

  const ageDays = (nowMs - measuredMs) / MS_PER_DAY;

  if (ageDays <= RECOMMENDED_REMEASUREMENT_DAYS) {
    return {
      verdict: VERDICT_FRESH,
      exitCode: EXIT_OK,
      ageDays,
      reason: `measured ${ageDays.toFixed(1)} day(s) ago, within the ${RECOMMENDED_REMEASUREMENT_DAYS}-day recommended re-measurement cadence`,
    };
  }

  if (ageDays <= REFLOG_EXPIRY_DAYS) {
    return {
      verdict: VERDICT_DUE,
      exitCode: EXIT_DUE,
      ageDays,
      reason:
        `measured ${ageDays.toFixed(1)} day(s) ago -- past the ${RECOMMENDED_REMEASUREMENT_DAYS}-day recommended ` +
        `cadence but not yet past the ${REFLOG_EXPIRY_DAYS}-day gc.reflogExpireUnreachable window this citation's ` +
        '`true` count depends on. Re-measurement is due, not yet proven wrong.',
    };
  }

  return {
    verdict: VERDICT_STALE,
    exitCode: EXIT_STALE,
    ageDays,
    reason:
      `measured ${ageDays.toFixed(1)} day(s) ago -- past the ${REFLOG_EXPIRY_DAYS}-day gc.reflogExpireUnreachable ` +
      'window. Any worktree this citation counted ownershipEvidence=true may have silently drained into ' +
      'false since; this citation can no longer be trusted as a description of the current population.',
  };
}

/**
 * Both controls, self-contained and run on every invocation regardless of
 * what citation this run is checking -- mirrors `evaluateControls` in
 * check-dated-measurement.mjs and check-stale-checkout-head.mjs for the
 * identical reason: a check that has never fired is indistinguishable from
 * one that cannot fire.
 *
 * POSITIVE: a citation dated exactly "now" must read FRESH. A negative
 * control alone cannot catch a comparator that always reports STALE -- that
 * passes a negative-only suite perfectly while being useless.
 *
 * NEGATIVE: a citation dated far enough in the past to be unambiguously
 * beyond both thresholds must read STALE, never FRESH or DUE.
 */
export function evaluateControls() {
  const failures = [];

  const positive = classifyCensusFreshness({
    measuredAt: SAMPLE_TIMESTAMP_FOR_CONTROLS,
    now: SAMPLE_TIMESTAMP_FOR_CONTROLS,
  });
  if (positive.verdict !== VERDICT_FRESH) {
    failures.push(
      `positive control failed: a citation dated "now" was not reported FRESH (${positive.verdict}), so the comparison is dead`,
    );
  }

  const negative = classifyCensusFreshness({
    measuredAt: FABRICATED_ANCIENT_TIMESTAMP,
    now: SAMPLE_TIMESTAMP_FOR_CONTROLS,
  });
  if (negative.verdict !== VERDICT_STALE) {
    failures.push(
      'negative control failed: a fabricated, decades-old measured_at was not reported STALE, so the ' +
        'comparison is saturating',
    );
  }

  return { passed: failures.length === 0, failures };
}

export function formatResult(result, citation = {}) {
  const label =
    result.exitCode === EXIT_OK
      ? 'FRESH'
      : result.exitCode === EXIT_DUE
        ? 'DUE'
        : result.exitCode === EXIT_STALE
          ? 'STALE'
          : 'UNVERIFIABLE';
  const lines = [`[census-freshness] ${label} (${result.verdict})`];
  const counts = ['worktrees', 'trueCount', 'falseCount', 'accused']
    .filter((key) => citation[key] !== undefined)
    .map(
      (key) =>
        `${key === 'trueCount' ? 'true' : key === 'falseCount' ? 'false' : key}=${citation[key]}`,
    );
  if (counts.length > 0) lines.push(`  census  ${counts.join(' ')}`);
  lines.push(`  ${result.reason}`);
  if (result.verdict === VERDICT_DUE || result.verdict === VERDICT_STALE) {
    lines.push(
      '  Re-run and re-publish: `npm run census:ownership-evidence`, then update the ' +
        '`census-measured` citation with the fresh report.',
    );
  }
  return lines.join('\n');
}

// --- citation parsing --------------------------------------------------------

const REQUIRED_FIELDS = [
  'worktrees',
  'true',
  'false',
  'accused',
  'measured_at',
];

/**
 * The four fields whose entire meaning is numeric. A citation is a claim
 * about counts; a `worktrees` field that reads `"twenty-four"` or is missing
 * entirely is the same failure from this check's point of view -- neither
 * names a count -- so both must produce the same `incomplete` outcome
 * rather than the malformed one silently becoming `NaN` and flowing through
 * comparisons and rendering unflagged.
 */
const NUMERIC_FIELDS = ['worktrees', 'true', 'false', 'accused'];

/**
 * A count field's raw text must be a plain non-negative base-10 integer --
 * one or more ASCII digits and nothing else. This deliberately rejects
 * forms that `Number(...)` would otherwise coerce into something
 * `Number.isFinite` accepts: a leading `-` (negative counts are not a
 * meaningful claim about how many worktrees exist), a decimal point (a
 * fractional worktree count is not a count), and alternate-base or
 * exponential notation such as `0x10` or `1e3` (a count field is a
 * transcription of a whole number, not an arbitrary numeric expression).
 */
const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;

/**
 * Parses `census-measured` fenced citation blocks out of a report or issue
 * body -- the same shape and parsing strategy as
 * check-dated-measurement.mjs's `parseMeasurementCitations`, deliberately,
 * so a reader who knows one convention already knows the other. A block
 * missing a required key, one where a numeric key's value is not a plain
 * non-negative base-10 integer (e.g. `worktrees: twenty-four`, `worktrees:
 * -1`, `worktrees: 24.5`, `worktrees: 0x10`, or an empty value), or one
 * where any key is repeated (e.g. two `measured_at:` lines), is returned
 * with `incomplete: true` and the offending keys named -- never silently
 * coerced to `NaN`, silently accepted as a non-integer count, or silently
 * resolved by letting the last occurrence of a duplicated key win.
 */
export function parseCensusCitations(text) {
  if (typeof text !== 'string') {
    return [];
  }
  const blockPattern = /```census-measured\r?\n([\s\S]*?)```/g;
  const citations = [];
  let match;
  while ((match = blockPattern.exec(text)) !== null) {
    const fields = {};
    const keyCounts = new Map();
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (!key) continue;
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      fields[key] = value;
    }
    // A key repeated within one block names two different values for the
    // same field with no rule for which wins. Silently keeping only the
    // last occurrence would hide the same class of ambiguity already
    // refused for repeated CLI flags -- treat it as an incomplete citation
    // rather than an arbitrary tiebreak.
    const duplicateFields = [...keyCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key);
    const missingFields = REQUIRED_FIELDS.filter((key) => !(key in fields));
    const invalidNumericFields = NUMERIC_FIELDS.filter(
      (key) => key in fields && !NON_NEGATIVE_INTEGER_PATTERN.test(fields[key]),
    );
    const missing = [
      ...missingFields,
      ...invalidNumericFields,
      ...duplicateFields,
    ];
    citations.push({
      worktrees:
        fields.worktrees !== undefined ? Number(fields.worktrees) : undefined,
      trueCount: fields.true !== undefined ? Number(fields.true) : undefined,
      falseCount: fields.false !== undefined ? Number(fields.false) : undefined,
      accused:
        fields.accused !== undefined ? Number(fields.accused) : undefined,
      measuredAt: fields.measured_at,
      fields,
      incomplete: missing.length > 0,
      missing,
      missingFields,
      invalidFields: invalidNumericFields,
      duplicateFields,
    });
  }
  return citations;
}

// --- effects -----------------------------------------------------------------

export function parseArgs(argv) {
  const FLAG_NAMES = new Set(['--measured-at', '--now', '--file']);
  const args = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!FLAG_NAMES.has(arg)) {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)}; usage: check-census-freshness.mjs ` +
          '(--measured-at <iso> | --file <path>) [--now <iso>]',
      );
    }
    // A flag repeated more than once names two different values for the
    // same input with no rule for which wins. Silently keeping only the
    // last occurrence is the same shape of bug as the missing-value and
    // mutually-exclusive cases below: ambiguous input treated as if it
    // were unambiguous. Refuse it instead of picking one arbitrarily.
    if (seen.has(arg)) {
      throw new Error(`${arg} was given more than once`);
    }
    seen.add(arg);
    const value = argv[index + 1];
    // A flag given with no following token, or immediately followed by
    // another recognized flag, has no value. Treating that as "value
    // omitted, use the default" is exactly how `--now` with no argument
    // used to silently fall back to the real wall clock instead of
    // erroring -- a false-green result no different from the check never
    // having run. Refuse it instead: an explicitly-passed flag that names
    // no value is the caller's mistake, not permission to guess.
    if (value === undefined || FLAG_NAMES.has(value)) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
    if (arg === '--measured-at') args.measuredAt = value;
    else if (arg === '--now') args.now = value;
    else args.file = value;
  }
  if (args.file !== undefined && args.measuredAt !== undefined) {
    // The usage string documents `--measured-at` and `--file` as mutually
    // exclusive alternatives (`--measured-at <iso> | --file <path>`), but
    // silently letting one win over the other -- previously `--file` always
    // won -- means a caller who passes both by mistake gets a result from
    // whichever source they didn't intend, without any indication that
    // happened. Fail instead of guessing.
    throw new Error(
      '--measured-at and --file are mutually exclusive; provide exactly one',
    );
  }
  return args;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const { readFile = (path) => readFileSync(path, 'utf8') } = deps;

  const controls = evaluateControls();
  if (!controls.passed) {
    for (const failure of controls.failures) {
      console.error(`[census-freshness] ${failure}`);
    }
    console.error(
      '[census-freshness] refusing to report: a FRESH verdict from a broken comparator is indistinguishable from a real one',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`[census-freshness] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  let citations;
  if (args.file) {
    const text = readFile(args.file);
    citations = parseCensusCitations(text);
    if (citations.length === 0) {
      console.error(
        `[census-freshness] no \`\`\`census-measured fenced block found in ${args.file}`,
      );
      process.exitCode = EXIT_UNVERIFIABLE;
      return;
    }
  } else if (args.measuredAt) {
    citations = [
      { measuredAt: args.measuredAt, incomplete: false, missing: [] },
    ];
  } else {
    console.error(
      'usage: check-census-freshness.mjs (--measured-at <iso> | --file <path>) [--now <iso>]',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  let worstExitCode = EXIT_OK;
  for (const citation of citations) {
    if (citation.incomplete) {
      const missingFields = citation.missingFields ?? citation.missing;
      const invalidFields = citation.invalidFields ?? [];
      const duplicateFields = citation.duplicateFields ?? [];
      const parts = [];
      if (missingFields.length > 0) {
        parts.push(`missing required field(s): ${missingFields.join(', ')}`);
      }
      if (invalidFields.length > 0) {
        parts.push(
          `non-numeric or unparseable field(s): ${invalidFields.join(', ')}`,
        );
      }
      if (duplicateFields.length > 0) {
        parts.push(
          `duplicated field(s) within one citation block: ${duplicateFields.join(', ')}`,
        );
      }
      console.error(
        `[census-freshness] citation is incomplete -- ${parts.join('; ')}`,
      );
      worstExitCode = Math.max(worstExitCode, EXIT_UNVERIFIABLE);
      continue;
    }

    const result = classifyCensusFreshness({
      measuredAt: citation.measuredAt,
      now: args.now,
    });
    const rendered = formatResult(result, citation);
    if (result.exitCode === EXIT_OK) {
      console.log(rendered);
    } else {
      console.error(rendered);
    }
    worstExitCode = Math.max(worstExitCode, result.exitCode);
  }

  process.exitCode = worstExitCode;
}

export { main };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[census-freshness] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
  });
}
