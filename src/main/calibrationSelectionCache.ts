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
  readonly epoch: number;
  readonly expiresAt: number;
}

function live<T>(
  entry: Entry<T> | undefined,
  now: number,
  epoch: number,
): T | null {
  if (entry === undefined || entry.epoch !== epoch || entry.expiresAt <= now) {
    return null;
  }
  return entry.value;
}

export interface CalibrationCandidateEvidence {
  readonly candidates: readonly RemoteCalibrationPrinterCandidate[];
  readonly unreadable: number;
  readonly truncated: boolean;
  /** Monotonic identity for the exact candidate-list observation. */
  readonly generation: number;
}

interface CachedContext {
  readonly context: RemoteCalibrationPrinterContext;
  /** Null for an action-only authoritative read not initiated by selection. */
  readonly candidateGeneration: number | null;
}

export class CalibrationSelectionCache {
  private readonly candidates = new Map<
    string,
    Entry<CalibrationCandidateEvidence>
  >();
  private readonly contexts = new Map<string, Entry<CachedContext>>();
  private nextCandidateGeneration = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private static contextKey(profileId: string, printerId: string): string {
    return `${profileId}\u0000${printerId}`;
  }

  rememberCandidates(
    profileId: string,
    epoch: number,
    evidence: Omit<CalibrationCandidateEvidence, 'generation'>,
  ): number {
    const generation = this.nextCandidateGeneration;
    this.nextCandidateGeneration += 1;
    this.candidates.set(profileId, {
      value: { ...evidence, generation },
      epoch,
      expiresAt: this.now() + OBSERVATION_TTL_MS,
    });
    return generation;
  }

  evidence(
    profileId: string,
    epoch: number,
  ): CalibrationCandidateEvidence | null {
    return live(this.candidates.get(profileId), this.now(), epoch);
  }

  /** The server's verdict for one printer, if it was seen recently. */
  candidate(
    profileId: string,
    printerId: string,
    epoch: number,
  ): RemoteCalibrationPrinterCandidate | null {
    const evidence = this.evidence(profileId, epoch);
    if (evidence === null) return null;
    return (
      evidence.candidates.find((entry) => entry.printerId === printerId) ?? null
    );
  }

  /** Candidate plus the exact list observation that made it selectable. */
  selectedCandidate(
    profileId: string,
    printerId: string,
    epoch: number,
  ): {
    readonly candidate: RemoteCalibrationPrinterCandidate;
    readonly generation: number;
  } | null {
    const evidence = this.evidence(profileId, epoch);
    if (evidence === null) return null;
    const candidate = evidence.candidates.find(
      (entry) => entry.printerId === printerId,
    );
    return candidate === undefined
      ? null
      : { candidate, generation: evidence.generation };
  }

  rememberContext(
    profileId: string,
    epoch: number,
    context: RemoteCalibrationPrinterContext,
  ): void {
    this.contexts.set(
      CalibrationSelectionCache.contextKey(profileId, context.printerId),
      {
        value: { context, candidateGeneration: null },
        epoch,
        expiresAt: this.now() + OBSERVATION_TTL_MS,
      },
    );
  }

  /**
   * Remember a context only if the candidate observation that authorised its
   * read is still current. A later candidate refresh makes an in-flight reply
   * stale even when the profile-wide action epoch did not change.
   */
  rememberSelectedContext(
    profileId: string,
    epoch: number,
    candidateGeneration: number,
    context: RemoteCalibrationPrinterContext,
  ): boolean {
    const evidence = this.evidence(profileId, epoch);
    if (evidence?.generation !== candidateGeneration) return false;
    this.contexts.set(
      CalibrationSelectionCache.contextKey(profileId, context.printerId),
      {
        value: { context, candidateGeneration },
        epoch,
        expiresAt: this.now() + OBSERVATION_TTL_MS,
      },
    );
    return true;
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
    epoch: number,
    configurationRevision?: number,
  ): RemoteCalibrationPrinterContext | null {
    const cached = live(
      this.contexts.get(
        CalibrationSelectionCache.contextKey(profileId, printerId),
      ),
      this.now(),
      epoch,
    );
    if (cached === null) return null;
    if (
      cached.candidateGeneration !== null &&
      cached.candidateGeneration !== this.evidence(profileId, epoch)?.generation
    ) {
      return null;
    }
    const context = cached.context;
    if (
      configurationRevision !== undefined &&
      context.configurationRevision !== configurationRevision
    ) {
      return null;
    }
    return context;
  }

  /** Context produced from the currently cached candidate-list observation. */
  selectedContext(
    profileId: string,
    printerId: string,
    epoch: number,
    configurationRevision?: number,
  ): RemoteCalibrationPrinterContext | null {
    const cached = live(
      this.contexts.get(
        CalibrationSelectionCache.contextKey(profileId, printerId),
      ),
      this.now(),
      epoch,
    );
    const evidence = this.evidence(profileId, epoch);
    if (
      cached === null ||
      cached.candidateGeneration === null ||
      cached.candidateGeneration !== evidence?.generation
    ) {
      return null;
    }
    const context = cached.context;
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
