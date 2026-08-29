/**
 * Calibration diagnostics collector (issue #159).
 *
 * Answers the question a support engineer asks first: *is calibration healthy
 * on this machine, and what happened last time it ran?* Reports negotiated
 * API/schema versions, capability flags, granted scopes, pending outbox depth,
 * unresolved conflict count, and the last sync outcome and time.
 *
 * ## State lifetime
 *
 * Capability negotiation is an HTTP call and the calibration sync outcome was
 * previously returned in-call and discarded, so neither was available to read
 * back. Both are now recorded here in memory as they happen. That means:
 *
 * - Diagnostics never makes a network call, so it works while offline — which
 *   is exactly when an operator needs it.
 * - **Both reset when the app restarts.** `capability` and `lastSync` are null
 *   until calibration has negotiated and synced at least once in the current
 *   run. The runbooks in the companion issue must say so; a null here means
 *   "not observed since this app started", not "broken".
 *
 * ## Redaction
 *
 * Same structural rule as `calibrationLog`: the snapshot types have no field
 * for a token, a credential, or a path. Scopes are `resource:action` strings
 * from the server's `effectivePermissions`, versions are short opaque strings,
 * and the failure code is a member of the typed union — never a message.
 *
 * @module calibrationDiagnostics
 */

import type {
  CalibrationFlagAdvertisement,
  RemoteCalibrationCapabilities,
} from './calibrationWire.js';
import type { CalibrationLogErrorCode } from './calibrationLog.js';

export interface CalibrationCapabilitySnapshot {
  negotiatedApiVersion: string | null;
  negotiatedSchemaVersion: string | null;
  apiContractVersion: string;
  flags: {
    calibrationApiEnabled: boolean;
    calibrationChangeFeedEnabled: boolean;
    calibrationOfflineDraftEnabled: boolean;
    calibrationPhotoUploadEnabled: boolean;
    calibrationGenerationEnabled: boolean;
    calibrationArtifactPromotionEnabled: boolean;
  };
  /**
   * Per-flag advertisement state (#493): whether the server explicitly said
   * `true`/`false` for each flag's backing field, or said nothing at all
   * (`'unknown'`). `flags` alone fails closed on `'unknown'` to `false`, so a
   * flag can read `false` above yet be `'unknown'` here — this is the only
   * place a support engineer can tell "the server said no" apart from "the
   * server never said".
   */
  flagAdvertisement: Record<
    keyof CalibrationCapabilitySnapshot['flags'],
    CalibrationFlagAdvertisement
  >;
  grantedScopes: string[];
  /** ISO 8601 UTC of the negotiation this snapshot came from. */
  negotiatedAt: string;
}

export interface CalibrationLastSyncSnapshot {
  outcome: 'ok' | 'failed';
  /** ISO 8601 UTC. */
  at: string;
  /** Typed code when the outcome is `failed`; null otherwise. */
  errorCode: CalibrationLogErrorCode | null;
  /** Correlation ID of that sync, so a log search can start from here. */
  correlationId: string | null;
}

export interface CalibrationOutboxSnapshot {
  pendingOperationCount: number;
  unresolvedConflictCount: number;
}

/**
 * Why `outbox` is null. A null outbox arises from three structurally different
 * situations and only one of them is a fault, so a runbook cannot key a
 * diagnosis on the absence alone (issue #236).
 *
 * - `notAttempted` — no outbox source is wired, so nothing was asked.
 * - `noProfileSelected` — no server profile is selected, so there is nothing to
 *   count against. Benign, and itself the diagnosis.
 * - `readFailed` — the sidecar read was attempted and threw. **This is the only
 *   member that indicates a fault.**
 *
 * Precedence when more than one applies: `notAttempted` before
 * `noProfileSelected`, because a missing source makes the profile irrelevant.
 * Pinned by test rather than left to the order of the conditions.
 *
 * Reachability is not uniform, and the runbooks depend on that: the only
 * production caller (`calibration:getDiagnostics`) passes the sidecar adapter
 * unconditionally, so an operator can meet `noProfileSelected` and `readFailed`
 * but not `notAttempted`. The member is kept for callers that embed the store
 * directly, and the call site is pinned by test so the documentation cannot go
 * false silently.
 */
export type CalibrationOutboxUnavailableReason =
  'notAttempted' | 'noProfileSelected' | 'readFailed';

export interface CalibrationDiagnostics {
  /** ISO 8601 UTC of this collection. */
  generatedAt: string;
  profileId: string | null;
  capability: CalibrationCapabilitySnapshot | null;
  outbox: CalibrationOutboxSnapshot | null;
  /**
   * Why `outbox` is null; null when `outbox` is present. Lets a runbook name
   * the fault case (`readFailed`) instead of keying on absence, which three
   * different causes produce.
   */
  outboxUnavailableReason: CalibrationOutboxUnavailableReason | null;
  lastSync: CalibrationLastSyncSnapshot | null;
  /**
   * True when `capability` and `lastSync` are only as old as the current app
   * run. Always true today; present so a runbook can state the caveat from the
   * output itself rather than from tribal knowledge.
   */
  observedSinceAppStart: boolean;
  /** Pre-formatted, copy-paste ready for a bug report. */
  report: string;
}

/** Source of the counts that live in the sidecar's SQLite. */
export interface CalibrationDiagnosticsOutboxSource {
  countCalibrationPendingOperations(
    profileId: string,
    projectId: string | null,
  ): Promise<number>;
  listCalibrationConflicts(
    profileId: string,
    projectId: string | null,
  ): Promise<readonly unknown[]>;
}

/**
 * Records capability and sync observations as they happen and collects them on
 * demand. One instance per app run.
 */
export class CalibrationDiagnosticsStore {
  private capability: CalibrationCapabilitySnapshot | null = null;
  /**
   * Which server profile {@link capability} describes.
   *
   * A capability snapshot is one farm's answer about one account. Holding it
   * without recording whose answer it was made it usable as evidence for a
   * different profile entirely: negotiate a permissive profile A, switch to B
   * whose own negotiation is still in flight or has failed, and every gate would
   * read A's permissions and flags and authorise a mutation against B.
   *
   * Kept beside the snapshot rather than inside it so the diagnostics wire shape
   * is unchanged; the report already names the selected profile separately.
   */
  private capabilityProfileId: string | null = null;
  /**
   * Generation counter for capability negotiations.
   *
   * Profile binding alone cannot reject a *stale completion for the same
   * profile*. Two sequences need this: a 403 discards the snapshot while an
   * earlier capability GET is still in flight, and that GET then records
   * positive evidence after the refusal it was supposed to be corrected by; and
   * A → B → A, where the pre-switch response for A lands after A is current
   * again and silently becomes authoritative despite everything that happened
   * in between.
   *
   * Every discard advances the counter, so a negotiation started before it can
   * no longer write. Last start wins; earlier ones are dropped.
   */
  private capabilityEpoch = 0;
  private lastSync: CalibrationLastSyncSnapshot | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Discard the current snapshot and take a token for the negotiation about to
   * start.
   *
   * Clearing and starting are one operation on purpose: the window between them
   * is exactly where a gate would read evidence the caller has already decided
   * is suspect.
   */
  beginCapabilityNegotiation(): number {
    this.clearCapabilities();
    return this.capabilityEpoch;
  }

  /**
   * Record a completed negotiation, if it is still the current one.
   *
   * Returns whether the result was accepted. A stale completion is dropped
   * rather than applied, so a response that was already overtaken cannot
   * reinstate evidence for a decision that has since been made differently.
   */
  recordCapabilities(
    token: number,
    profileId: string,
    capabilities: RemoteCalibrationCapabilities,
  ): boolean {
    if (token !== this.capabilityEpoch) return false;
    this.capability = {
      negotiatedApiVersion: capabilities.apiVersion,
      negotiatedSchemaVersion: capabilities.schemaVersion,
      apiContractVersion: capabilities.apiContractVersion,
      flags: { ...capabilities.flags },
      flagAdvertisement: { ...capabilities.flagAdvertisement },
      grantedScopes: [...capabilities.grantedScopes],
      negotiatedAt: this.now().toISOString(),
    };
    this.capabilityProfileId = profileId;
    return true;
  }

  /** Called at the end of every calibration sync, successful or not. */
  recordSyncOutcome(outcome: {
    outcome: 'ok' | 'failed';
    errorCode?: CalibrationLogErrorCode | null;
    correlationId?: string | null;
  }): void {
    this.lastSync = {
      outcome: outcome.outcome,
      at: this.now().toISOString(),
      errorCode: outcome.errorCode ?? null,
      correlationId: outcome.correlationId ?? null,
    };
  }

  /**
   * The negotiated capabilities for exactly this server profile.
   *
   * Returns null when the stored snapshot belongs to another profile, which is
   * the whole point: an unmatched read is indistinguishable from never having
   * negotiated, so every gate fails closed on a profile switch instead of
   * inheriting the previous farm's permissions.
   *
   * The profile must be named. There is no "current" reading, because the caller
   * that knows which profile it is acting for is the only one that can say.
   */
  capabilitySnapshot(profileId: string): CalibrationCapabilitySnapshot | null {
    if (this.capabilityProfileId !== profileId) return null;
    return this.capability;
  }

  /**
   * Drop the capability snapshot before an attempt to replace it.
   *
   * Called before every negotiation and before a post-refusal refresh, so a
   * fetch that fails, times out or is itself refused leaves *no* evidence rather
   * than the previous positive answer. Clearing afterwards would be too late:
   * the window between starting a fetch and failing it is exactly when a gate
   * would read the stale snapshot.
   */
  clearCapabilities(): void {
    this.capability = null;
    this.capabilityProfileId = null;
    // Invalidates any negotiation already in flight. Without this a response
    // that left before the discard would land after it and undo it.
    this.capabilityEpoch += 1;
  }

  /**
   * Forget everything recorded for one server profile.
   *
   * The correct response to a profile being selected away from, or deleted: its
   * observations describe a farm this app is no longer acting against.
   */
  forgetProfile(profileId: string): void {
    if (this.capabilityProfileId === profileId) this.clearCapabilities();
  }

  /**
   * Forget every observation, returning the store to its just-started state.
   */
  reset(): void {
    this.clearCapabilities();
    this.lastSync = null;
  }

  lastSyncSnapshot(): CalibrationLastSyncSnapshot | null {
    return this.lastSync;
  }

  /**
   * Collect a full diagnostics report. `outbox` is null for three distinct
   * reasons — no source was wired, no profile is selected, or the read threw —
   * and the read never throws out of here, because a diagnostics command that
   * cannot run when something is broken is useless. Only the third is a fault,
   * so `outboxUnavailableReason` carries which one applied. Null alone cannot
   * tell them apart, which is the defect this docstring previously had (#236).
   */
  async collect(options: {
    profileId: string | null;
    projectId?: string | null;
    outbox?: CalibrationDiagnosticsOutboxSource | undefined;
  }): Promise<CalibrationDiagnostics> {
    const { profileId, outbox } = options;
    const projectId = options.projectId ?? null;
    let outboxSnapshot: CalibrationOutboxSnapshot | null = null;
    let outboxUnavailableReason: CalibrationOutboxUnavailableReason | null =
      null;
    if (outbox === undefined) {
      outboxUnavailableReason = 'notAttempted';
    } else if (profileId === null) {
      outboxUnavailableReason = 'noProfileSelected';
    } else {
      try {
        const [pendingOperationCount, conflicts] = await Promise.all([
          outbox.countCalibrationPendingOperations(profileId, projectId),
          outbox.listCalibrationConflicts(profileId, projectId),
        ]);
        outboxSnapshot = {
          pendingOperationCount,
          unresolvedConflictCount: conflicts.length,
        };
      } catch {
        outboxSnapshot = null;
        outboxUnavailableReason = 'readFailed';
      }
    }
    const diagnostics: Omit<CalibrationDiagnostics, 'report'> = {
      generatedAt: this.now().toISOString(),
      profileId,
      // Reported only when it belongs to the profile being reported on. A
      // report that showed another profile's permissions beside this profile's
      // id would be actively misleading in exactly the situation it is run for.
      capability:
        profileId !== null && this.capabilityProfileId === profileId
          ? this.capability
          : null,
      outbox: outboxSnapshot,
      outboxUnavailableReason,
      lastSync: this.lastSync,
      observedSinceAppStart: true,
    };
    return {
      ...diagnostics,
      report: formatCalibrationDiagnostics(diagnostics),
    };
  }
}

const NOT_OBSERVED = 'not observed since app start';

/**
 * Render the snapshot as plain text a user can paste into a bug report. Field
 * names match the log vocabulary so a runbook can name one thing, not two.
 */
export function formatCalibrationDiagnostics(
  diagnostics: Omit<CalibrationDiagnostics, 'report'>,
): string {
  const lines: string[] = [
    'PrintFarmer calibration diagnostics',
    `generatedAt: ${diagnostics.generatedAt}`,
    `profileId: ${diagnostics.profileId ?? 'none selected'}`,
    '',
    'capability',
  ];
  if (diagnostics.capability === null) {
    lines.push(`  ${NOT_OBSERVED}`);
  } else {
    const capability = diagnostics.capability;
    lines.push(
      `  negotiatedApiVersion: ${capability.negotiatedApiVersion ?? 'none'}`,
      `  negotiatedSchemaVersion: ${capability.negotiatedSchemaVersion ?? 'none'}`,
      `  apiContractVersion: ${capability.apiContractVersion}`,
      `  negotiatedAt: ${capability.negotiatedAt}`,
      '  flags:',
    );
    for (const [flag, enabled] of Object.entries(capability.flags)) {
      const advertisement =
        capability.flagAdvertisement[
          flag as keyof typeof capability.flagAdvertisement
        ];
      // `false` is ambiguous on its own: it means either "the server said no"
      // or "the server said nothing" (#493). Naming the unknown case here is
      // what makes this report truthful rather than merely fail-closed.
      const suffix =
        advertisement === 'unknown'
          ? ' (unknown — not advertised by server)'
          : '';
      lines.push(`    ${flag}: ${String(enabled)}${suffix}`);
    }
    lines.push(
      `  grantedScopes: ${
        capability.grantedScopes.length > 0
          ? capability.grantedScopes.join(', ')
          : 'none'
      }`,
    );
  }
  lines.push('', 'outbox');
  if (diagnostics.outbox === null) {
    // The reason is always rendered, so grepping `unavailable` never conflates
    // the one fault case with the two benign ones (#236). `unknown` is only
    // reachable from a hand-built snapshot that omitted the reason.
    lines.push(
      `  unavailable (${diagnostics.outboxUnavailableReason ?? 'unknown'})`,
    );
  } else {
    lines.push(
      `  pendingOperationCount: ${String(diagnostics.outbox.pendingOperationCount)}`,
      `  unresolvedConflictCount: ${String(diagnostics.outbox.unresolvedConflictCount)}`,
    );
  }
  lines.push('', 'lastSync');
  if (diagnostics.lastSync === null) {
    lines.push(`  ${NOT_OBSERVED}`);
  } else {
    lines.push(
      `  outcome: ${diagnostics.lastSync.outcome}`,
      `  at: ${diagnostics.lastSync.at}`,
      `  errorCode: ${diagnostics.lastSync.errorCode ?? 'none'}`,
      `  correlationId: ${diagnostics.lastSync.correlationId ?? 'none'}`,
    );
  }
  lines.push(
    '',
    'Capability and lastSync are observed in memory and reset when the app restarts.',
  );
  return lines.join('\n');
}

/** Process-wide store, mirroring the process-wide correlation registry. */
export const calibrationDiagnostics = new CalibrationDiagnosticsStore();
