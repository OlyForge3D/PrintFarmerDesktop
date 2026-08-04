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

export function fetchPullRequest(options: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{ labels: string[]; merged: boolean }>;

/** Resolves true when the label was removed, false when it was already gone. */
export function removeLabel(options: {
  owner: string;
  repo: string;
  prNumber: number;
  label: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean>;
