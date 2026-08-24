/**
 * Backoff schedule for the `GET /api/slice/{jobId}` calibration slice poll.
 *
 * Why this lives in its own module
 * --------------------------------
 * The poll loop is driven by the *renderer* — each `calibration:getSliceJobStatus`
 * call is a single HTTP GET, and the renderer decides when to call again. That
 * arrangement keeps the IPC channel one-shot and testable end-to-end.
 *
 * The schedule itself, though, is a **main-process** concern: if the renderer
 * were free to pick its own delay it could ratchet up to a hot loop and hammer
 * the PrintFarmer worker. So the renderer sends its `pollAttempt` counter (0-
 * indexed, incremented locally), and this function is what the handler layer
 * uses to compute the *next* delay and to detect when the total wall-clock cap
 * has been reached.
 *
 * The delay returned here is a **hint** the renderer honours; the accompanying
 * `cappedOut` flag is authoritative — once the cap has been reached, the
 * handler layer refuses further polls of the same job with `sliceJobTimeout`.
 * The two together give the renderer both a schedule and a stop signal that
 * cannot be circumvented by resetting the attempt counter.
 *
 * Schedule shape
 * --------------
 * - Initial delay 500 ms after `pollAttempt === 0`.
 * - Grows by ×1.5 each step, capped at 15 000 ms per interval.
 * - Total attempts capped at {@link SLICE_POLL_MAX_ATTEMPTS} (240).
 *
 * At 240 attempts of 500 ms → 15 000 ms geometric growth, the wall-clock cap
 * lands near 20 minutes, which fits the owner's calibration workflow: a
 * temperature-tower slice against the bundled 3MF completes in seconds, a
 * flow-rate pass a little longer, and any run that has not terminated in 20
 * minutes is a stuck worker not a slow one.
 *
 * Jitter is deliberately absent. This is a per-user polling loop against the
 * user's own PrintFarmer instance, not a fleet-wide client, so the thundering-
 * herd problem jitter exists to solve does not apply. Determinism matters more
 * for test coverage than randomness would buy at this scale.
 */

/** Base delay for the very first inter-poll interval, in milliseconds. */
export const SLICE_POLL_INITIAL_DELAY_MS = 500;

/** Multiplicative backoff factor. */
export const SLICE_POLL_GROWTH_FACTOR = 1.5;

/** Ceiling on any single inter-poll interval, in milliseconds. */
export const SLICE_POLL_MAX_DELAY_MS = 15_000;

/**
 * Maximum number of polls before the handler layer refuses further attempts
 * with `sliceJobTimeout`.
 */
export const SLICE_POLL_MAX_ATTEMPTS = 240;

export interface SlicePollHint {
  /**
   * Delay in ms the renderer should wait before its next poll. `null` when
   * the cap has been reached — in that case the handler layer will reject
   * a subsequent poll with `sliceJobTimeout`.
   */
  readonly delayMs: number | null;
  /**
   * `true` when the *next* attempt would exceed {@link SLICE_POLL_MAX_ATTEMPTS}.
   * The renderer surfaces this to stop the automatic loop; the handler layer
   * enforces the same predicate on the following call, so a client that
   * ignores the hint still gets refused by the server-of-record here.
   */
  readonly cappedOut: boolean;
}

/**
 * Compute the next-delay hint for a given zero-indexed `pollAttempt`.
 *
 * The renderer calls `getSliceJobStatus` with `pollAttempt = 0` for its first
 * poll and increments by 1 for each subsequent call. This function returns
 * the delay to use *before the next call after this one* — i.e. before
 * `pollAttempt + 1`.
 *
 * Contract:
 * - `pollAttempt < 0` is treated as 0 (defensive; the Zod schema disallows it
 *   at the boundary already, but a helper that assumes a non-negative
 *   argument still gets called from tests that verify the boundary).
 * - `pollAttempt + 1 >= SLICE_POLL_MAX_ATTEMPTS` returns
 *   `{ delayMs: null, cappedOut: true }` — no more polls, timeout on next
 *   attempt.
 * - Otherwise `delayMs = min(INITIAL * FACTOR^pollAttempt, MAX_DELAY)` rounded
 *   to the nearest integer.
 */
export function computeSlicePollHint(pollAttempt: number): SlicePollHint {
  const attempt =
    Number.isFinite(pollAttempt) && pollAttempt > 0
      ? Math.floor(pollAttempt)
      : 0;
  const nextAttempt = attempt + 1;
  if (nextAttempt >= SLICE_POLL_MAX_ATTEMPTS) {
    return { delayMs: null, cappedOut: true };
  }
  const uncapped =
    SLICE_POLL_INITIAL_DELAY_MS * Math.pow(SLICE_POLL_GROWTH_FACTOR, attempt);
  const bounded = Math.min(uncapped, SLICE_POLL_MAX_DELAY_MS);
  return { delayMs: Math.round(bounded), cappedOut: false };
}

/**
 * Terminal snapshot classification. `null` when the snapshot is still in
 * flight; `'completed'` / `'failed'` when the server has closed the job out.
 *
 * `Cancelled` deliberately maps to `'failed'` from the renderer's point of
 * view: a cancelled calibration slice job is not a normal ending — either the
 * operator or an admin cut it short — and the renderer needs to treat it the
 * same way it treats a `Failed` job (surface the failure, do not offer
 * `send-to-printer`). The distinction between `Failed` and `Cancelled` is
 * preserved in the raw snapshot for the operator to inspect.
 */
export function classifySliceJobTerminalOutcome(
  status: 'Queued' | 'Processing' | 'Completed' | 'Failed' | 'Cancelled',
): 'completed' | 'failed' | null {
  if (status === 'Completed') return 'completed';
  if (status === 'Failed' || status === 'Cancelled') return 'failed';
  return null;
}
