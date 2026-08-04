/**
 * Types for scripts/lift-hold-on-close.mjs.
 *
 * Written by reading the implementation rather than from memory: a first draft
 * of this file described `evaluateHoldsToLift` as returning `{lift, retained,
 * merged}`, which no version of the script has ever returned. A declaration
 * file is an assertion about another file, and it is checked against the
 * callers rather than against the thing it describes — so a wrong one
 * type-checks clean until some caller happens to touch the field that is
 * missing.
 */

export interface HoldLiftResult {
  /**
   * Hold labels to remove. Empty unless the pull request merged, because a
   * closed-unmerged pull request is reopenable and its hold may still be live.
   */
  readonly lift: readonly string[];
  /** Every hold label found, whether or not it is being lifted. */
  readonly held: readonly string[];
  /** Why the decision went the way it did, for the job log. */
  readonly reason: string;
}

export const HOLD_LABEL_PREFIX: string;

export function evaluateHoldsToLift(input: {
  labels: readonly (string | { name?: unknown })[];
  merged: unknown;
}): HoldLiftResult;

export function formatLift(
  result: HoldLiftResult,
  prNumber: number,
  repository: { owner: string; repo: string },
): string;

/**
 * Summarises a backfill sweep. Distinguishes the two ways a sweep lifts
 * nothing, because they mean opposite things: the index offered no rows, or it
 * offered rows whose objects were already clear. The second is the measured
 * steady state — label removals on merged pull requests are the one mutation
 * this search index does not reconcile — and reads as a fault unless said.
 */
export function formatBackfillSummary(input: {
  candidates: number;
  lifted: number;
  repository: { owner: string; repo: string };
}): string;

export function fetchPullRequest(options: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ labels: string[]; merged: boolean }>;

/**
 * Merged pull requests still carrying a hold label — the cohort that landed
 * before the event-triggered workflow existed and is therefore permanently
 * unevaluated by it.
 */
export function findMergedPullRequestsCarryingHolds(options: {
  owner: string;
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<number[]>;

/** Resolves true when the label was removed, false when it was already gone. */
export function removeLabel(options: {
  owner: string;
  repo: string;
  prNumber: number;
  label: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean>;
