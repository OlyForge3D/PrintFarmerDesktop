// Re-measures the ownership-evidence census that issue #336 asks for on a
// recurring basis, because the population it counts moves on a timer that no
// single measuring session survives.
//
// `push-guard.mjs` distinguishes a real finding (`push-guard.foreign-session`)
// from a benign abstention (`push-guard.unattributed-discard`) using
// `ownershipEvidence` — `authoredHere()`, which asks whether THIS worktree's
// HEAD reflog contains a `creationEntries('HEAD')` entry at all. That reflog
// entry expires after `gc.reflogExpireUnreachable` (30 days) for any commit
// that is unreachable at expiry time — exactly the commits a discard makes
// unreachable. So `ownershipEvidence` drifts from true to false over time with
// no event marking the transition, silently converting would-be findings into
// abstentions. See #336 for the full argument and the 2026-08-04 baseline
// (worktrees=24, true=18, false=6, wrongly-accused=0).
//
// THE MEASUREMENT, precisely, per worktree returned by `git worktree list`:
//
//   1. `ownershipEvidence` — `authoredHere()` run WITH THAT WORKTREE AS CWD,
//      because `push-guard.mjs`'s own git calls read `process.cwd()` and
//      never take a `cwd` argument (this is the same technique
//      `tests/pushGuard.test.ts` uses: `process.chdir` around the call,
//      restored in a `finally`). This is not a re-implementation of the
//      guard's logic; it is the guard's own exported functions, invoked
//      against every worktree instead of just the one process.cwd() happens
//      to be in.
//   2. `wrongly ACCUSED` — a cross-worktree collision check on top of (1):
//      for every worktree with `ownershipEvidence === true`, `readOwnedCommits()`
//      names the sha set that worktree's OWN reflog says it created. Two
//      different worktrees claiming creation of the SAME sha is impossible
//      under correct git semantics (a commit object is created in exactly one
//      place) and would mean the reflog-based ownership signal itself is
//      unreliable on this clone — the thing that would make a "0 wrongly
//      accused" census meaningless rather than reassuring. This script
//      recomputes that check every run instead of asserting it as an
//      invariant, which is the only way a real regression would be caught.
//
// This USED TO NOT distinguish "never authored anything" from "authored
// something whose reflog entry expired" — the two-valued-answer-to-a-
// three-valued-question gap #336 named via #315. `push-guard.mjs`'s
// `authoredHere()` is now tri-state (`true` / `false` / `null`): `null` means
// the reflog cannot be read at all, or it cannot be proven complete back to
// the ref's genesis (a chain-of-object-ids check across every reflog entry's
// old/new sha, not an age heuristic — an age-based check was tried first and
// found unsound by review, since `gc.reflogExpireUnreachable` prunes each
// unreachable entry independently and can drop an old one while a newer,
// unrelated entry survives right after it), so "no creation entry" and "the
// creation entry already expired" cannot be told apart. This census reports
// that third value as its own bucket (`indeterminate`) rather than folding it
// into `false`, so a population whose reflogs are losing provable continuity
// is visible as a widening `indeterminate` count instead of a silent slide
// from `true` into `false`.
//
// `formatReport` (and `runCensus`) now also append a `` ```census-measured ``
// fenced citation block naming this run's numbers and a `measured_at`
// timestamp. This is the durable half of the #336 fix: the census itself
// already self-re-derives on every run, but a *citation* of a past run
// (pasted into an issue or PR) does not carry any signal of its own age.
// `scripts/check-census-freshness.mjs` reads that citation back and fails
// loudly once it has aged past the reflog decay window this census depends
// on, so a stale citation can be caught mechanically instead of by someone
// remembering to ask "is this still current?".

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { listLinkedWorktrees } from './safe-worktree-remove.mjs';
import { authoredHere, readOwnedCommits } from './push-guard.mjs';

/**
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function listWorktreePaths(cwd = process.cwd()) {
  return listLinkedWorktrees(cwd);
}

/**
 * Measure one worktree: `ownershipEvidence` and the sha set it claims to have
 * created, both read via `push-guard.mjs`'s own exported functions with that
 * worktree as the process's cwd — the same evidence the guard itself would
 * see if it ran there. Restores the original cwd even when the worktree is
 * missing or unreadable (a stale entry `git worktree list` did not prune).
 *
 * `ownershipEvidence` is tri-state (#315): `true` a creation entry was found,
 * `false` none was found and the reflog is provably complete back to the
 * ref's genesis (so no entry could have been pruned), `null` the reflog
 * cannot be read at all or cannot be proven complete. A worktree this
 * function itself could not read (`ok: false`) reports `false` here as a
 * filler value only — it is excluded from every bucket by `summarizeCensus`,
 * which counts strictly over `ok: true` entries.
 *
 * @param {string} worktreePath
 * @returns {{
 *   path: string,
 *   ok: boolean,
 *   ownershipEvidence: boolean | null,
 *   ownCommits: string[],
 *   error?: string,
 * }}
 */
export function measureWorktree(worktreePath) {
  if (!existsSync(worktreePath)) {
    return {
      path: worktreePath,
      ok: false,
      ownershipEvidence: false,
      ownCommits: [],
      error: 'worktree path does not exist (stale `git worktree list` entry)',
    };
  }
  const originalCwd = process.cwd();
  try {
    process.chdir(worktreePath);
    const ownershipEvidence = authoredHere();
    const ownCommits = [...readOwnedCommits()];
    return { path: worktreePath, ok: true, ownershipEvidence, ownCommits };
  } catch (error) {
    return {
      path: worktreePath,
      ok: false,
      ownershipEvidence: false,
      ownCommits: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    process.chdir(originalCwd);
  }
}

/**
 * The census numbers, plus which worktrees landed in each bucket and
 * which shas (if any) were claimed as "created here" by more than one
 * worktree — the collision that would make `ownershipEvidence` untrustworthy
 * rather than merely decayed.
 *
 * `ownershipEvidence` is tri-state (#315): entries are split strictly by
 * `=== true`, `=== false`, and `=== null` so a worktree whose reflog cannot
 * rule out decay lands in `indeterminateEntries`, never silently folded into
 * `falseEntries` the way a `!ownershipEvidence` test would fold it.
 *
 * @param {ReturnType<typeof measureWorktree>[]} measurements
 */
export function summarizeCensus(measurements) {
  const evaluable = measurements.filter((entry) => entry.ok);
  const trueEntries = evaluable.filter(
    (entry) => entry.ownershipEvidence === true,
  );
  const falseEntries = evaluable.filter(
    (entry) => entry.ownershipEvidence === false,
  );
  const indeterminateEntries = evaluable.filter(
    (entry) => entry.ownershipEvidence === null,
  );

  const claimants = new Map();
  for (const entry of trueEntries) {
    for (const sha of entry.ownCommits) {
      if (!claimants.has(sha)) claimants.set(sha, []);
      claimants.get(sha).push(entry.path);
    }
  }
  const collisions = [...claimants.entries()].filter(
    ([, paths]) => new Set(paths).size > 1,
  );
  const accusedWorktrees = new Set(collisions.flatMap(([, paths]) => paths));

  return {
    worktreesTotal: measurements.length,
    evaluable: evaluable.length,
    unreadable: measurements.length - evaluable.length,
    ownershipEvidenceTrue: trueEntries.length,
    ownershipEvidenceFalse: falseEntries.length,
    ownershipEvidenceIndeterminate: indeterminateEntries.length,
    wronglyAccused: accusedWorktrees.size,
    collisions,
    trueEntries,
    falseEntries,
    indeterminateEntries,
    unreadableEntries: measurements.filter((entry) => !entry.ok),
  };
}

/**
 * Appends a `census-measured` fenced citation — the same format
 * check-census-freshness.mjs's `parseCensusCitations` reads back — so this
 * report can be pasted verbatim into an issue comment or PR body and later
 * checked for staleness with no hand-transcription step (#336). `measuredAt`
 * defaults to the real clock but accepts an injected value for deterministic
 * tests.
 */
export function formatCensusCitation(summary, { measuredAt } = {}) {
  const timestamp = measuredAt ?? new Date().toISOString();
  return [
    '```census-measured',
    `worktrees: ${summary.worktreesTotal}`,
    `true: ${summary.ownershipEvidenceTrue}`,
    `false: ${summary.ownershipEvidenceFalse}`,
    `accused: ${summary.wronglyAccused}`,
    `indeterminate: ${summary.ownershipEvidenceIndeterminate}`,
    `measured_at: ${timestamp}`,
    '```',
  ].join('\n');
}

export function formatReport(summary, { measuredAt } = {}) {
  const lines = [
    '[census-ownership-evidence]',
    `worktrees total          ${summary.worktreesTotal}`,
    `ownershipEvidence = true  ${summary.ownershipEvidenceTrue}`,
    `ownershipEvidence = false ${summary.ownershipEvidenceFalse}`,
    `ownershipEvidence = null (indeterminate) ${summary.ownershipEvidenceIndeterminate}`,
    `wrongly ACCUSED           ${summary.wronglyAccused}`,
  ];
  if (summary.unreadable > 0) {
    lines.push(
      '',
      `${summary.unreadable} worktree(s) could not be measured (stale entries or unreadable ` +
        'reflogs) and are excluded from the true/false/indeterminate split above but counted in the total:',
    );
    for (const entry of summary.unreadableEntries) {
      lines.push(`  ${entry.path} — ${entry.error}`);
    }
  }
  if (summary.collisions.length > 0) {
    lines.push(
      '',
      `${summary.collisions.length} sha(s) claimed as "created here" by more than one ` +
        'worktree — the ownership signal itself may be unreliable on this clone:',
    );
    for (const [sha, paths] of summary.collisions) {
      lines.push(
        `  ${sha.slice(0, 12)}  claimed by: ${[...new Set(paths)].join(', ')}`,
      );
    }
  }
  lines.push('', formatCensusCitation(summary, { measuredAt }));
  return lines.join('\n');
}

export function runCensus(cwd = process.cwd(), { measuredAt } = {}) {
  const worktreePaths = listWorktreePaths(cwd);
  const measurements = worktreePaths.map((worktreePath) =>
    measureWorktree(path.resolve(worktreePath)),
  );
  const summary = summarizeCensus(measurements);
  return {
    summary,
    measurements,
    report: formatReport(summary, { measuredAt }),
  };
}

function main() {
  const { report } = runCensus();
  console.log(report);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
