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
 * @returns {{name: string, conclusion: string | null, status: string, startedAt: string | null, completedAt: string | null, id: number}}
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
  if (typeof status !== 'string' || status === '') {
    throw new Error(`check run ${index + 1} (${name}) has no status`);
  }
  if (!KNOWN_STATUSES.has(status)) {
    // A garbage/unrecognized status (typo, API-version drift, a malformed
    // response) must not fall through the `status === 'completed'` checks
    // below and be silently treated as "not completed" -- that is exactly
    // how a structurally invalid response would resolve to `pending` and
    // let `main` exit clean, the same failure mode the two invariant
    // checks above already close for known-but-contradictory pairings.
    throw new Error(
      `check run ${index + 1} (${name}) has an unrecognized status ${JSON.stringify(status)}`,
    );
  }
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      `check run ${index + 1} (${name}) has no positive integer id`,
    );
  }
  if (conclusion !== null && typeof conclusion !== 'string') {
    throw new Error(
      `check run ${index + 1} (${name}) has a non-string conclusion`,
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
      `check run ${index + 1} (${name}) is completed but has no conclusion`,
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
      `check run ${index + 1} (${name}) has status ${JSON.stringify(status)} but a non-null conclusion ${JSON.stringify(conclusion)} -- only a completed run should carry one`,
    );
  }
  // A queued or in-progress run legitimately has not started yet, so GitHub
  // reports `started_at: null` for it -- that is not malformed input, it is
  // the normal shape of "pending". Only a completed run is required to carry
  // a valid timestamp; a completed run with none is the actually-malformed
  // case. `completed_at` follows the identical rule.
  let startedAt = null;
  if (startedAtRaw !== null && startedAtRaw !== undefined) {
    if (
      typeof startedAtRaw !== 'string' ||
      Number.isNaN(Date.parse(startedAtRaw))
    ) {
      throw new Error(
        `check run ${index + 1} (${name}) has an invalid started_at`,
      );
    }
    startedAt = startedAtRaw;
  } else if (status === 'completed') {
    throw new Error(
      `check run ${index + 1} (${name}) is completed but has no started_at`,
    );
  }
  let completedAt = null;
  if (completedAtRaw !== null && completedAtRaw !== undefined) {
    if (
      typeof completedAtRaw !== 'string' ||
      Number.isNaN(Date.parse(completedAtRaw))
    ) {
      throw new Error(
        `check run ${index + 1} (${name}) has an invalid completed_at`,
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
        `check run ${index + 1} (${name}) has status ${JSON.stringify(status)} but a non-null completed_at -- only a completed run should carry one`,
      );
    }
    completedAt = completedAtRaw;
  } else if (status === 'completed') {
    throw new Error(
      `check run ${index + 1} (${name}) is completed but has no completed_at`,
    );
  }
  // A run whose status is not yet 'completed' has not settled on a
  // conclusion regardless of what the field carries, so it is forced to
  // null here rather than trusted -- the same "don't trust a field the API
  // hasn't committed to yet" discipline as elsewhere in this repo's checks.
  return {
    name,
    conclusion: status === 'completed' ? conclusion : null,
    status,
    startedAt,
    completedAt,
    id,
  };
}

/**
 * Compare two parsed check runs for the same name and report whether
 * `candidate` should replace `current` as "the latest attempt".
 *
 * Neither `id` ordering nor a single timestamp field is sound on its own:
 *
 * - `id` ordering (the prior approach) assumes a higher check-run id always
 *   means a newer run. Live Checks API data on this repo disproves that: a
 *   later-started rerun can carry a LOWER id than an older run for the same
 *   name, so ordering by id alone can pick a stale run and reintroduce this
 *   file's original bug through a different mechanism.
 * - Ordering by `started_at` alone (the original approach, before id
 *   ordering replaced it) breaks on a run that legitimately has not started
 *   yet (`started_at: null` while queued).
 *
 * Instead: a run that is still open (`status !== 'completed'`) is always
 * treated as more current than one that has already completed for the same
 * name -- an in-flight attempt is definitionally the live state of that
 * check, regardless of when either run was created. Between two runs in the
 * same state (both completed, or both still open), compare the timestamp
 * that state guarantees is present: `completed_at` for two completed runs
 * (always non-null once completed), `started_at` for two still-open runs
 * (may still be null on both if neither has started; that case falls back
 * to id, the least-bad signal available when nothing has run yet).
 *
 * `completed_at` is only second-resolution, so two reruns of a fast job can
 * genuinely tie on it -- live Checks API data on this repo showed exactly
 * that (two "Stacked base" completions in the same second), and falling
 * back to `id` at that point is just as unsound as ordering by id
 * everywhere: a rerun's id is not guaranteed to be higher than an earlier
 * attempt's. `started_at` is a second, independent monotonic signal that is
 * not tied to `completed_at`'s tie -- a later rerun was, definitionally,
 * *started* no earlier than the run it superseded, even when both happen
 * to finish in the same second. So a `completed_at` tie falls through to
 * comparing `started_at` before ever falling back to id.
 *
 * If `started_at` *also* ties -- both timestamps identical between two
 * completed runs, or both still-open runs never having started at all --
 * there is no timestamp left this API guarantees is monotonic, and id is
 * not a safe way to break that tie either (the entire reason id ordering
 * was abandoned as this file's primary signal in the first place). Rather
 * than trust id as a last resort, this throws: an unresolvable tie means
 * "which run is truly latest" cannot be determined from the data available,
 * and guessing risks silently picking the stale run -- exactly the failure
 * mode this file exists to close. Callers (`buildVerdicts`/`main`) already
 * treat a thrown error as undetermined, so this fails closed rather than
 * reporting a possibly-wrong verdict as authoritative.
 *
 * @param {ReturnType<typeof parseCheckRun>} candidate
 * @param {ReturnType<typeof parseCheckRun>} current
 * @returns {boolean}
 */
function isNewerCheckRun(candidate, current) {
  const candidateOpen = candidate.status !== 'completed';
  const currentOpen = current.status !== 'completed';
  if (candidateOpen !== currentOpen) {
    // Exactly one of the two is still open (in_progress/queued): the open
    // one is the live state of this check, whichever id or timestamp it
    // carries.
    return candidateOpen;
  }
  if (!candidateOpen) {
    // Both completed: compare the timestamp every completed run is
    // required to carry. A tie on `completed_at` (only second-resolution)
    // falls through to `started_at` -- still a monotonic, timestamp-based
    // signal, not id.
    if (candidate.completedAt !== current.completedAt) {
      return (
        Date.parse(/** @type {string} */ (candidate.completedAt)) >
        Date.parse(/** @type {string} */ (current.completedAt))
      );
    }
    if (candidate.startedAt !== current.startedAt) {
      // Both completed, so both are guaranteed a non-null started_at by
      // parseCheckRun -- no null-handling needed here, unlike the
      // still-open branch below.
      return (
        Date.parse(/** @type {string} */ (candidate.startedAt)) >
        Date.parse(/** @type {string} */ (current.startedAt))
      );
    }
    throw new Error(
      `cannot determine the latest attempt for check "${candidate.name}" -- runs ${candidate.id} and ${current.id} have identical started_at and completed_at, and no other signal this API provides is a safe way to order them`,
    );
  }
  // Both still open: prefer whichever has actually started over one still
  // queued with no started_at, since that is strictly more information
  // about progress; between two with comparable started_at, compare it
  // directly. If neither has started at all, there is no timestamp signal
  // to compare -- fail closed the same way as the completed/completed tie
  // above rather than trusting id.
  if (candidate.startedAt === null && current.startedAt === null) {
    throw new Error(
      `cannot determine the latest attempt for check "${candidate.name}" -- runs ${candidate.id} and ${current.id} have neither started yet, and no other signal this API provides is a safe way to order them`,
    );
  }
  if (candidate.startedAt === null) return false;
  if (current.startedAt === null) return true;
  if (candidate.startedAt !== current.startedAt) {
    return Date.parse(candidate.startedAt) > Date.parse(current.startedAt);
  }
  throw new Error(
    `cannot determine the latest attempt for check "${candidate.name}" -- runs ${candidate.id} and ${current.id} share the same started_at with neither completed, and no other signal this API provides is a safe way to order them`,
  );
}

/**
 * Reduce every check run to the single most-recent run per name.
 *
 * See `isNewerCheckRun` for why "most recent" cannot be determined by id
 * ordering or by a single timestamp field alone. `gh pr checks` itself
 * renders only the latest run for a given name, so reporting anything else
 * here would disagree with the tool this replaces along a second axis the
 * issue never raised.
 *
 * @param {readonly unknown[]} checkRuns
 * @returns {Map<string, ReturnType<typeof parseCheckRun>>}
 */
export function latestCheckRunsByName(checkRuns) {
  const parsed = checkRuns.map((checkRun, index) =>
    parseCheckRun(checkRun, index),
  );
  const latest = new Map();
  for (const run of parsed) {
    const current = latest.get(run.name);
    if (!current || isNewerCheckRun(run, current)) {
      latest.set(run.name, run);
    }
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
  return [...latestCheckRunsByName(checkRuns).values()]
    .map((run) => ({
      name: run.name,
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
