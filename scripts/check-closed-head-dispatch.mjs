// No shebang: this module is imported by tests/closedHeadDispatch.test.ts,
// and vite's transform does not always preserve one ahead of a local-module
// import the way node does (see check-review-head-coverage.mjs for the same
// note). It is invoked via `node scripts/check-closed-head-dispatch.mjs`,
// which needs no shebang.
//
// Did the head a pull request closed at ever get a `pull_request` dispatch?
//
// #380: PR #281 closed unmerged at `3e8d1c3`, a head that had
// `total_count: 0` workflow runs and zero check runs — never tested, ever.
// The head before it, `c299a41`, was the same. Neither silence was visible:
// a red check announces itself; `total_count: 0` and a not-yet-loaded UI
// render identically. Nobody read the wrong SHA — there was nothing to read.
//
//   > An absent workflow run is indistinguishable from one that has not
//   > started, and both are indistinguishable from a green one if you read
//   > the wrong SHA.
//
// #380's own investigation eliminated repo-level Actions state, trigger
// configuration, committer identity, and PR-state timeline as the cause, and
// could not measure further: webhook delivery and account-level throttling
// both require admin-scoped access this repository's automation does not
// have. NO CAUSE IS CLAIMED HERE EITHER. This file does not diagnose why a
// dispatch went missing — it makes the *symptom* impossible to miss the next
// time it happens, at the one moment the #281 shape is irreversible: close.
//
// WHY `closed`, NOT EVERY PUSH
//
// Checking on every `synchronize` would duplicate `actions-runs-for-sha.mjs`
// and race the very dispatch it is trying to observe — a check that runs as
// part of the same dispatch class it is auditing cannot see that class fail
// to fire at all. `closed` is a different event, and by the time it fires
// the head is fixed: no later commit can supersede it and make the reading
// stale. That is also its one honest limitation, stated plainly rather than
// buried: THIS CHECK ITSELF DEPENDS ON `pull_request: closed` DISPATCHING.
// If GitHub ever drops that dispatch the way it dropped `synchronize` for
// `3e8d1c3`, this check does not run and reports nothing — it is a second,
// independent instrument, not a guarantee. `lift-sequencing-hold.yml` already
// depends on the same event firing reliably, so this rides an assumption the
// repository already makes elsewhere; it does not introduce a new one.
//
// WHY THIS CANNOT BE A REQUIRED CONTEXT
//
// Same reasoning as `lift-sequencing-hold.yml`: this check's report does not
// exist until AFTER the pull request has already closed. Requiring it would
// leave every open pull request waiting on a context that cannot appear
// until the event it gates has already happened. Advisory only, exactly like
// `check:review-coverage` and `check:protection-assumptions`.
//
// A FAILURE FROM A BROKEN QUERY MUST NEVER READ AS "SILENT"
//
// `queryActionsRunsForInput` (from `actions-runs-for-sha.mjs`) already
// resolves the SHA before querying and refuses to coerce a query failure —
// a bad response, a rate limit, a transient 5xx — into a successful zero.
// This file must preserve that distinction: a query that could not be
// answered is UNVERIFIABLE, never SILENT. Collapsing the two would make a
// flaky API call indistinguishable from the #281 finding, and every SILENT
// verdict this check ever produces would be worthless the first time the
// query itself hiccups.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  resolveRepo,
  queryActionsRunsForInput,
} from './actions-runs-for-sha.mjs';

export const VERDICT_DISPATCHED = 'dispatched';
export const VERDICT_SILENT = 'silent';
export const VERDICT_UNVERIFIABLE = 'unverifiable';

export const EXIT_OK = 0;
export const EXIT_SILENT = 1;
export const EXIT_UNVERIFIABLE = 2;

export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * A SHA is untrusted input in the same sense it is throughout this
 * repository's other checks: a null, an abbreviation, or a differently-cased
 * value must not silently pass as a usable head.
 */
export function normalizeSha(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return FULL_SHA_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * The one classification this file exists for. `totalCount` must already
 * have passed through `queryActionsRunsForInput`'s own validation (a
 * non-negative safe integer) — this function additionally refuses anything
 * that arrives as something else, so a caller that skips the query and
 * fabricates a bad shape cannot produce a false SILENT or DISPATCHED.
 */
export function classifyDispatch({ headSha, totalCount, prNumber } = {}) {
  const sha = normalizeSha(headSha);
  if (sha === null) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      exitCode: EXIT_UNVERIFIABLE,
      reason: `no usable head sha to classify (${JSON.stringify(headSha)})`,
    };
  }

  if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      exitCode: EXIT_UNVERIFIABLE,
      reason: `total_count for ${sha.slice(0, 8)} is not a usable non-negative integer (${JSON.stringify(totalCount)}); a query failure must never be read as silence`,
    };
  }

  const prLabel = prNumber !== undefined ? `#${prNumber} ` : '';

  if (totalCount === 0) {
    return {
      verdict: VERDICT_SILENT,
      exitCode: EXIT_SILENT,
      reason:
        `${prLabel}closed at ${sha.slice(0, 8)}, which has total_count: 0 workflow runs — ` +
        'this head was never tested, and nothing else would have surfaced that. See #380.',
    };
  }

  return {
    verdict: VERDICT_DISPATCHED,
    exitCode: EXIT_OK,
    reason: `${prLabel}closed at ${sha.slice(0, 8)}, which dispatched ${totalCount} workflow run(s)`,
  };
}

/**
 * Both controls, run on every invocation rather than only in tests — the
 * same shape as `check-stale-checkout-head.mjs` and
 * `check-review-head-coverage.mjs`: a verdict from a broken comparator is
 * indistinguishable from a real one unless something else says so.
 *
 * NEGATIVE: an unverifiable input (no usable sha, or a query failure shape)
 * must never be classified SILENT — that would make an outage read exactly
 * like the #281 finding.
 *
 * POSITIVE: a real sha with a genuine positive total_count must classify as
 * DISPATCHED, not SILENT and not UNVERIFIABLE — otherwise this check would
 * cry #380 on every ordinary, fully-tested merge.
 */
export function evaluateControls() {
  const failures = [];

  const brokenQuery = classifyDispatch({
    headSha: 'a'.repeat(40),
    totalCount: Number.NaN,
  });
  if (brokenQuery.verdict === VERDICT_SILENT) {
    failures.push(
      'negative control failed: an unusable total_count was classified SILENT, so a broken query would be indistinguishable from a real #380',
    );
  }

  const noSha = classifyDispatch({ headSha: null, totalCount: 0 });
  if (noSha.verdict === VERDICT_SILENT) {
    failures.push(
      'negative control failed: a missing head sha was classified SILENT rather than UNVERIFIABLE',
    );
  }

  const healthy = classifyDispatch({ headSha: 'a'.repeat(40), totalCount: 5 });
  if (healthy.verdict !== VERDICT_DISPATCHED) {
    failures.push(
      `positive control failed: a real sha with total_count: 5 classified as ${healthy.verdict}, not dispatched`,
    );
  }

  return { passed: failures.length === 0, failures };
}

export function formatResult(result) {
  const label =
    result.verdict === VERDICT_DISPATCHED
      ? 'DISPATCHED'
      : result.verdict === VERDICT_SILENT
        ? 'SILENT'
        : 'UNVERIFIABLE';
  return `[closed-head-dispatch] ${label}: ${result.reason}`;
}

// --- effects -----------------------------------------------------------

function readClosedPullRequestFromEvent(eventPath) {
  if (!eventPath) return null;
  let payload;
  try {
    payload = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return null;
  }
  const pr = payload?.pull_request;
  if (
    !pr ||
    typeof pr.number !== 'number' ||
    typeof pr.head?.sha !== 'string'
  ) {
    return null;
  }
  return {
    number: pr.number,
    headSha: pr.head.sha,
    merged: Boolean(pr.merged),
  };
}

export function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pr') {
      out.pr = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg === '--sha') {
      out.sha = argv[index + 1];
      index += 1;
    } else if (arg === '--repo') {
      out.repo = argv[index + 1];
      index += 1;
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)}; usage: check-closed-head-dispatch [--pr <n> --sha <sha>] [--repo owner/name]`,
      );
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;
  const run = spawnSync;

  const fromEvent = readClosedPullRequestFromEvent(env.GITHUB_EVENT_PATH);
  const prNumber = args.pr ?? fromEvent?.number;
  // The head sha is read as an OUTPUT of the close event (or an explicit
  // --sha for manual/CI-independent use), never from a local ref — the same
  // discipline `check-stale-checkout-head.mjs` documents at length.
  const headSha = args.sha ?? fromEvent?.headSha;

  if (!headSha) {
    console.error(
      '[closed-head-dispatch] no head sha available: pass --sha, or run this under a ' +
        'pull_request "closed" event with GITHUB_EVENT_PATH set',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const repo = resolveRepo(args.repo, env, run);
  if (!repo) {
    console.error(
      '[closed-head-dispatch] unusable input: could not determine a valid owner/name repository',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const controls = evaluateControls();
  if (!controls.passed) {
    for (const failure of controls.failures) {
      console.error(`[closed-head-dispatch] ${failure}`);
    }
    console.error(
      '[closed-head-dispatch] refusing to report: a verdict from a broken comparator is indistinguishable from a real one',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const queried = queryActionsRunsForInput(headSha, repo, env, run);
  if (!queried.ok) {
    // A query failure is UNVERIFIABLE, never SILENT — see the header comment.
    console.error(
      `[closed-head-dispatch] ${queried.stage === 'resolve' ? 'unusable input' : 'query unusable'}: ${queried.reason}`,
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const result = classifyDispatch({
    headSha: queried.sha,
    totalCount: queried.totalCount,
    prNumber,
  });
  const rendered = formatResult(result);
  if (result.exitCode === EXIT_OK) {
    console.log(rendered);
  } else {
    console.error(rendered);
  }
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[closed-head-dispatch] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
  });
}
