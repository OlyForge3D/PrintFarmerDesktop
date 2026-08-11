/**
 * Short-lived main-process memory of what the operator selected.
 *
 * Two problems motivate it.
 *
 * The first is duplicated work. Resolving profiles for a selected printer needs
 * that printer's candidate record (for the server's eligibility verdict) and its
 * calibration context. The renderer has already caused both to be fetched by the
 * time it asks for profiles, so refetching them meant the candidate list was
 * pulled again on every selection and the backend profile resolver ran twice for
 * a single click.
 *
 * The second is fencing. An action must be verified against the context the
 * operator actually saw, not against whatever is current when the request lands.
 * Holding the observed context here — keyed by printer *and* configuration
 * revision — lets a later request be matched against the exact snapshot the
 * selection was made from.
 *
 * Entries expire quickly and are per server profile. This is a cache of recent
 * observations, never a source of authority: nothing here is trusted to permit
 * an action on its own, and a miss simply means the value is fetched again.
 */

import type {
  RemoteCalibrationPrinterCandidate,
  RemoteCalibrationPrinterContext,
} from './calibrationWire.js';

/**
 * How long an observation stays usable.
 *
 * Short enough that a printer reconfigured mid-session is refetched rather than
 * remembered, long enough to cover one wizard step. Machine-moving actions do
 * not rely on this window: they re-read the context authoritatively.
 */
const OBSERVATION_TTL_MS = 30_000;

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

function live<T>(entry: Entry<T> | undefined, now: number): T | null {
  if (entry === undefined || entry.expiresAt <= now) return null;
  return entry.value;
}

export class CalibrationSelectionCache {
  private readonly candidates = new Map<
    string,
    Entry<readonly RemoteCalibrationPrinterCandidate[]>
  >();
  private readonly contexts = new Map<
    string,
    Entry<RemoteCalibrationPrinterContext>
  >();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private static contextKey(profileId: string, printerId: string): string {
    return `${profileId}\u0000${printerId}`;
  }

  rememberCandidates(
    profileId: string,
    candidates: readonly RemoteCalibrationPrinterCandidate[],
  ): void {
    this.candidates.set(profileId, {
      value: candidates,
      expiresAt: this.now() + OBSERVATION_TTL_MS,
    });
  }

  /** The server's verdict for one printer, if it was seen recently. */
  candidate(
    profileId: string,
    printerId: string,
  ): RemoteCalibrationPrinterCandidate | null {
    const list = live(this.candidates.get(profileId), this.now());
    if (list === null) return null;
    return list.find((entry) => entry.printerId === printerId) ?? null;
  }

  rememberContext(
    profileId: string,
    context: RemoteCalibrationPrinterContext,
  ): void {
    this.contexts.set(
      CalibrationSelectionCache.contextKey(profileId, context.printerId),
      { value: context, expiresAt: this.now() + OBSERVATION_TTL_MS },
    );
  }

  /**
   * The recently observed context for one printer.
   *
   * When `configurationRevision` is supplied, a remembered context at a
   * different revision is a miss rather than a hit: the caller asked about a
   * specific configuration, and answering with another one is exactly the
   * confusion the revision fence exists to prevent.
   */
  context(
    profileId: string,
    printerId: string,
    configurationRevision?: number,
  ): RemoteCalibrationPrinterContext | null {
    const context = live(
      this.contexts.get(
        CalibrationSelectionCache.contextKey(profileId, printerId),
      ),
      this.now(),
    );
    if (context === null) return null;
    if (
      configurationRevision !== undefined &&
      context.configurationRevision !== configurationRevision
    ) {
      return null;
    }
    return context;
  }

  /** Drop everything for one server profile, e.g. when its binding changes. */
  forgetProfile(profileId: string): void {
    this.candidates.delete(profileId);
    for (const key of [...this.contexts.keys()]) {
      if (key.startsWith(`${profileId}\u0000`)) this.contexts.delete(key);
    }
  }

  clear(): void {
    this.candidates.clear();
    this.contexts.clear();
  }
}
