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

import type { RemoteCalibrationCapabilities } from './calibrationWire.js';
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
  };
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
  private lastSync: CalibrationLastSyncSnapshot | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Called at every successful capability negotiation. */
  recordCapabilities(capabilities: RemoteCalibrationCapabilities): void {
    this.capability = {
      negotiatedApiVersion: capabilities.apiVersion,
      negotiatedSchemaVersion: capabilities.schemaVersion,
      apiContractVersion: capabilities.apiContractVersion,
      flags: { ...capabilities.flags },
      grantedScopes: [...capabilities.grantedScopes],
      negotiatedAt: this.now().toISOString(),
    };
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

  capabilitySnapshot(): CalibrationCapabilitySnapshot | null {
    return this.capability;
  }

  lastSyncSnapshot(): CalibrationLastSyncSnapshot | null {
    return this.lastSync;
  }

  /**
   * Collect a full diagnostics report. Reads the outbox counts from the
   * sidecar; if that read fails, `outbox` is null rather than throwing, because
   * a diagnostics command that cannot run when something is broken is useless.
   * `outboxUnavailableReason` says which of the three null causes applied, so
   * the absence is diagnosable rather than merely visible.
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
      capability: this.capability,
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
      lines.push(`    ${flag}: ${String(enabled)}`);
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
