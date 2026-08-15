/**
 * Main-process record that an operator really did acknowledge a clear bed.
 *
 * ## Why a renderer boolean is not acceptable
 *
 * Dispatching a calibration print moves a machine. The desktop app must not do
 * that without evidence that a person confirmed the bed is clear. An earlier
 * shape of this interlock accepted `operatorAcknowledgedBedClear: true` on the
 * IPC request, which is not evidence of anything: the renderer is the party
 * being gated, so letting it assert its own precondition makes the gate
 * decorative. One call site simply passed a literal `true`.
 *
 * ## What this holds instead
 *
 * A record minted **in main**, only after main has itself observed — from the
 * server — that the named job exists and is actually waiting for a bed-clear
 * acknowledgement. The renderer cannot fabricate that observation; the most it
 * can do is ask, and the request fails when the server does not agree.
 *
 * Records are:
 *
 * - **Bound.** Keyed by server profile, printer, configuration revision, job,
 *   project, attempt and operation. A record minted for one job, printer or
 *   configuration cannot authorise a different one.
 * - **Single-use.** {@link consume} removes the record it returns, so a replayed
 *   dispatch finds nothing and is refused.
 * - **Short-lived.** An acknowledgement is a statement about the bed *now*.
 *   After {@link ACKNOWLEDGEMENT_TTL_MS} the operator is asked again rather than
 *   the app assuming the bed stayed clear.
 */

/**
 * How long a bed-clear acknowledgement stays valid.
 *
 * Deliberately short. This is a claim about the current physical state of a
 * machine, and the longer it is honoured the more likely it is to be false.
 */
export const ACKNOWLEDGEMENT_TTL_MS = 120_000;

/** Everything a record is bound to. All parts must match to consume it. */
export interface BedClearAcknowledgementBinding {
  readonly profileId: string;
  readonly printerId: string;
  readonly configurationRevision: number | null;
  readonly jobId: string;
  readonly projectId: string | null;
  readonly attemptId: string | null;
  readonly operationId: string;
}

function keyOf(binding: BedClearAcknowledgementBinding): string {
  return [
    binding.profileId,
    binding.printerId,
    binding.configurationRevision ?? 'no-revision',
    binding.jobId,
    binding.projectId ?? 'no-project',
    binding.attemptId ?? 'no-attempt',
    binding.operationId,
  ].join('\u0000');
}

interface Record_ {
  readonly expiresAt: number;
}

export class BedClearAcknowledgementLedger {
  private readonly records = new Map<string, Record_>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record that an operator acknowledged a clear bed for exactly this binding.
   *
   * Callers must only reach this after confirming with the server that the job
   * is genuinely awaiting acknowledgement; the ledger stores the fact, it does
   * not establish it.
   */
  record(binding: BedClearAcknowledgementBinding): void {
    this.records.set(keyOf(binding), {
      expiresAt: this.now() + ACKNOWLEDGEMENT_TTL_MS,
    });
  }

  /**
   * Take the acknowledgement for this binding, if there is a live one.
   *
   * Removes it whether or not it had expired: an expired record is not a record
   * that can be retried into validity, and leaving it would let a caller keep
   * probing. Returns false when nothing matched, which is the fail-closed
   * answer for a replay, a forged flag, or a binding that moved on.
   */
  consume(binding: BedClearAcknowledgementBinding): boolean {
    const key = keyOf(binding);
    const record = this.records.get(key);
    if (record === undefined) return false;
    this.records.delete(key);
    return record.expiresAt > this.now();
  }

  /** Whether a live acknowledgement exists, without spending it. */
  has(binding: BedClearAcknowledgementBinding): boolean {
    const record = this.records.get(keyOf(binding));
    return record !== undefined && record.expiresAt > this.now();
  }

  /** Drop expired records so the map cannot grow without bound. */
  prune(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
  }

  clear(): void {
    this.records.clear();
  }
}
