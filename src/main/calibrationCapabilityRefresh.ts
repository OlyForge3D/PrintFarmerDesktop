/**
 * Bounded re-negotiation of calibration capabilities after the server refuses.
 *
 * ## Why a 403 must not be cached as permanent
 *
 * The desktop app negotiates capabilities once when the workspace opens and
 * gates every later action against that snapshot. Permissions are not immutable:
 * an administrator can grant or revoke a calibration role while the app is
 * running, so a snapshot taken minutes ago can be wrong in either direction.
 *
 * The dangerous direction is a stale *positive*. The app believes it may act,
 * the server refuses, and nothing updates the belief — so the operator is
 * offered actions that will keep failing, with a snapshot that keeps insisting
 * they should work. The remedy is to treat a 403 as evidence that the snapshot
 * is out of date and re-read it.
 *
 * ## What this deliberately does not do
 *
 * It never replays the refused action. Re-fetching capabilities is a read; a
 * create, generate, queue or dispatch is not, and an app that silently retried a
 * machine-moving request because a permission check changed its mind would be
 * acting on the operator's behalf without being asked. The refresh informs the
 * UI, and the operator decides whether to try again.
 *
 * It is also bounded. Without a cooldown, a server refusing every request would
 * be met with a capability fetch per refusal, turning a permission problem into
 * a request storm. One refresh is in flight at a time, and a profile that has
 * just been refreshed is not refreshed again until the cooldown expires.
 */

/**
 * How long after a refresh another 403 is absorbed without re-fetching.
 *
 * Long enough that a burst of refusals costs one read, short enough that a
 * permission granted while the operator waits is picked up on their next try.
 */
export const CAPABILITY_REFRESH_COOLDOWN_MS = 10_000;

export interface CapabilityRefreshOutcome {
  /** Whether this refusal actually caused a capability re-read. */
  readonly refreshed: boolean;
  /**
   * Whether the operator should be told their access may have changed. True
   * whenever a refusal was observed, including one absorbed by the cooldown:
   * the message is about the refusal, not about the fetch.
   */
  readonly accessMayHaveChanged: boolean;
}

export class CalibrationCapabilityRefresher {
  private readonly lastRefreshAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record that the server refused an operation for this profile, re-reading
   * capabilities at most once per cooldown window.
   *
   * `refresh` is supplied by the caller so this module never owns a transport.
   * A failed refresh is swallowed: the refusal has already been reported, and a
   * second error about the diagnostic attempt would tell the operator nothing
   * they can act on.
   */
  async noteForbidden(
    profileId: string,
    refresh: () => Promise<void>,
  ): Promise<CapabilityRefreshOutcome> {
    const existing = this.inFlight.get(profileId);
    if (existing !== undefined) {
      // A refresh is already running for this profile. Joining it rather than
      // starting another is what keeps a burst of refusals to one read.
      await existing.catch(() => undefined);
      return { refreshed: false, accessMayHaveChanged: true };
    }
    const last = this.lastRefreshAt.get(profileId);
    if (
      last !== undefined &&
      this.now() - last < CAPABILITY_REFRESH_COOLDOWN_MS
    ) {
      return { refreshed: false, accessMayHaveChanged: true };
    }
    const run = (async () => {
      try {
        await refresh();
      } finally {
        this.lastRefreshAt.set(profileId, this.now());
        this.inFlight.delete(profileId);
      }
    })();
    this.inFlight.set(profileId, run);
    await run.catch(() => undefined);
    return { refreshed: true, accessMayHaveChanged: true };
  }

  /** Forget the cooldown for one profile, e.g. when its binding changes. */
  forgetProfile(profileId: string): void {
    this.lastRefreshAt.delete(profileId);
  }
}
