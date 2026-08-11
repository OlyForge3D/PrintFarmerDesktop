/**
 * Bounded recovery from an expired or revoked calibration session.
 *
 * ## Why 401 is not 403
 *
 * The desktop app authenticates to PrintFarmer by exchanging a configured API
 * key for a short-lived JWT — fifteen minutes by default. Two ordinary events
 * therefore produce a 401 that has nothing to do with the operator's rights:
 * the token simply aged out while the workspace sat open, and an administrator
 * forced a revocation, which fails JWT validation the same way.
 *
 * Both are recoverable without asking the operator for anything, because the
 * credential the exchange needs is already configured. A 403 is the opposite:
 * the identity was accepted and the *action* was refused, so re-exchanging the
 * key would prove nothing and would only add a request. Collapsing the two into
 * one "auth failed" path either re-exchanges pointlessly on every refusal or
 * strands a workspace whose token merely expired behind a sign-in prompt it
 * cannot satisfy.
 *
 * ## What recovery may and may not do
 *
 * Recovery re-establishes *identity*, then re-reads capabilities so the gate is
 * evaluated against whatever principal the new token resolves to — which is not
 * guaranteed to be the previous one, since an API key can be reassigned.
 *
 * It never replays the request that failed. For a read that is a missed
 * convenience; for a create, generate, queue or dispatch it would mean issuing
 * a machine-moving request under a freshly minted, possibly different principal
 * that the operator never authorised. The failed operation returns typed
 * re-authentication guidance and waits for a deliberate retry.
 *
 * ## Boundedness
 *
 * A server that answers 401 to everything, including the capability read taken
 * immediately after a successful exchange, must not be met with an exchange per
 * request. One recovery runs at a time per profile, concurrent callers join it
 * instead of starting their own, exactly one exchange is attempted per
 * recovery, and a profile that has just recovered is left alone for a cooldown.
 */

/**
 * How long after an attempt another 401 is absorbed without re-exchanging.
 *
 * Short relative to the fifteen-minute token lifetime, so a genuine expiry is
 * always recovered promptly, but long enough that a revoked key cannot turn a
 * burst of failing requests into a burst of exchanges.
 */
export const AUTH_RECOVERY_COOLDOWN_MS = 10_000;

export type CalibrationAuthRecoveryStatus =
  /** A new token was obtained and capabilities were re-read against it. */
  | 'reauthenticated'
  /** The API-key exchange itself failed; the app has no usable identity. */
  | 'exchangeFailed'
  /** The exchange succeeded and the server still refused the new token. */
  | 'stillUnauthenticated'
  /** Another recovery for this profile was already running and was joined. */
  | 'joined'
  /** A recovery ran moments ago; this failure was absorbed by the cooldown. */
  | 'cooldown';

export interface CalibrationAuthRecoveryOutcome {
  readonly status: CalibrationAuthRecoveryStatus;
  /** Whether this call actually performed an exchange. */
  readonly attempted: boolean;
  /** Whether the app currently holds a usable calibration session. */
  readonly authenticated: boolean;
}

/**
 * The caller performs the exchange and the follow-up capability read, and
 * classifies the result. Keeping the transport outside this module is what lets
 * it be reasoned about — and tested — purely as a bound on attempts.
 */
export type CalibrationAuthRecoveryAttempt = () => Promise<
  'reauthenticated' | 'exchangeFailed' | 'stillUnauthenticated'
>;

export class CalibrationAuthRecovery {
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly inFlight = new Map<
    string,
    Promise<CalibrationAuthRecoveryStatus>
  >();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record that the server rejected this profile's token, re-exchanging at most
   * once per cooldown window and never recursively.
   */
  async noteUnauthenticated(
    profileId: string,
    attempt: CalibrationAuthRecoveryAttempt,
  ): Promise<CalibrationAuthRecoveryOutcome> {
    const existing = this.inFlight.get(profileId);
    if (existing !== undefined) {
      // Joining the running recovery is what keeps a burst of concurrent 401s
      // — every open panel refreshing at once, say — to a single exchange.
      const status = await existing.catch(
        (): CalibrationAuthRecoveryStatus => 'exchangeFailed',
      );
      return {
        status: 'joined',
        attempted: false,
        authenticated: status === 'reauthenticated',
      };
    }
    const last = this.lastAttemptAt.get(profileId);
    if (last !== undefined && this.now() - last < AUTH_RECOVERY_COOLDOWN_MS) {
      return { status: 'cooldown', attempted: false, authenticated: false };
    }
    const run = (async (): Promise<CalibrationAuthRecoveryStatus> => {
      try {
        return await attempt();
      } catch {
        // A recovery that throws is a recovery that failed. Surfacing the
        // diagnostic error instead of the original 401 would replace something
        // the operator can act on with something they cannot.
        return 'exchangeFailed';
      } finally {
        this.lastAttemptAt.set(profileId, this.now());
        this.inFlight.delete(profileId);
      }
    })();
    this.inFlight.set(profileId, run);
    const status = await run;
    return {
      status,
      attempted: true,
      authenticated: status === 'reauthenticated',
    };
  }

  /** Forget the cooldown for one profile, e.g. when its credentials change. */
  forgetProfile(profileId: string): void {
    this.lastAttemptAt.delete(profileId);
  }

  /** Forget every cooldown, e.g. when the selected profile changes or on quit. */
  clear(): void {
    this.lastAttemptAt.clear();
  }
}
