/**
 * Correlation registry for calibration flows (issue #159).
 *
 * A single user-initiated calibration flow spans four separate IPC calls:
 * generation request → orchestration status polls → queue state → bed-clear
 * acknowledgement. `operationId` is minted per call and used as the backend
 * idempotency key, so it deliberately *differs* between those stages and cannot
 * serve as the thing that ties them together.
 *
 * This registry mints one correlation ID at the generation request and binds it
 * to the identifiers the later stages actually carry — the `orchestrationId`
 * the server returns, and then the queue `jobId`. Every later stage resolves
 * the same correlation ID by looking up the identifier it already has, so
 * nothing needs to change in the IPC contract or the renderer.
 *
 * Entries are bounded and evicted oldest-first: a long-running desktop session
 * starts many flows and none of them may accumulate without limit.
 *
 * ## Eviction policy, and why it is visible
 *
 * The bound is {@link DEFAULT_MAX_ENTRIES} bindings — not flows; a flow holds
 * three or four. Eviction is least-recently-bound first, and a binding is
 * re-inserted on every resolve, so an active flow stays alive and the entries
 * that go are the ones nothing has touched.
 *
 * A capacity limit that degrades silently would be a trapdoor: the flow whose
 * bindings get evicted is a long, slow one, which is exactly the failing
 * calibration an incident is about. So {@link CalibrationCorrelationRegistry.resolveOrBegin}
 * reports **how** it answered. When it cannot resolve any identifier it holds
 * and mints a new ID mid-flow — after an eviction, after an app restart, or on
 * a job the desktop never generated — the stage emits
 * `correlationOrigin: 'resumed'`. A `resumed` origin on anything other than a
 * generation event is the operator-visible signature that a flow's logs have
 * stopped correlating, and #160 documents it as such.
 *
 * @module calibrationCorrelation
 */

import { randomUUID } from 'node:crypto';
import type { CalibrationCorrelationOrigin } from './calibrationLog.js';

/** The kinds of identifier a correlation ID can be reached through. */
export type CalibrationCorrelationKey =
  'orchestration' | 'job' | 'attempt' | 'operation';

export interface CalibrationCorrelationRegistryOptions {
  /** Maximum bindings retained before oldest-first eviction. */
  maxEntries?: number;
  /** Injectable for deterministic tests. */
  mintId?: () => string;
}

const DEFAULT_MAX_ENTRIES = 512;

export class CalibrationCorrelationRegistry {
  /** `${kind}:${id}` → correlationId, in insertion order. */
  private readonly bindings = new Map<string, string>();
  private readonly maxEntries: number;
  private readonly mintId: () => string;

  constructor(options: CalibrationCorrelationRegistryOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.mintId = options.mintId ?? (() => randomUUID());
  }

  /**
   * Start a flow. Binds the minted ID to every identifier already known at the
   * generation request — typically the attempt and the operation.
   */
  beginFlow(
    seeds: Partial<Record<CalibrationCorrelationKey, string | null>> = {},
  ): string {
    const correlationId = this.mintId();
    for (const [kind, id] of Object.entries(seeds)) {
      if (typeof id === 'string' && id.length > 0) {
        this.bind(kind as CalibrationCorrelationKey, id, correlationId);
      }
    }
    return correlationId;
  }

  /** Bind a further identifier to an existing flow. Idempotent. */
  bind(
    kind: CalibrationCorrelationKey,
    id: string,
    correlationId: string,
  ): void {
    if (id.length === 0) return;
    const key = `${kind}:${id}`;
    // Re-insert so a re-bound key counts as recently used for eviction.
    this.bindings.delete(key);
    this.bindings.set(key, correlationId);
    while (this.bindings.size > this.maxEntries) {
      const oldest = this.bindings.keys().next();
      if (oldest.done === true) break;
      this.bindings.delete(oldest.value);
    }
  }

  /** Resolve a flow through one identifier, or `null` if it is not bound. */
  resolve(kind: CalibrationCorrelationKey, id: string | null): string | null {
    if (id === null || id.length === 0) return null;
    return this.bindings.get(`${kind}:${id}`) ?? null;
  }

  /**
   * Resolve through the first identifier that is bound, minting and binding a
   * new flow if none is. Used by stages that may legitimately be entered
   * without a preceding generation request — polling a job after a restart, for
   * instance — so a record always carries a correlation ID rather than a hole.
   *
   * Returns the origin alongside the ID. A caller that discards the origin
   * turns an eviction into silence; see the eviction policy in the module
   * docblock.
   */
  resolveOrBeginWithOrigin(
    candidates: ReadonlyArray<[CalibrationCorrelationKey, string | null]>,
  ): { correlationId: string; origin: CalibrationCorrelationOrigin } {
    for (const [kind, id] of candidates) {
      const found = this.resolve(kind, id);
      if (found !== null) {
        // Bind the remaining identifiers so later stages resolve too.
        this.bindAll(candidates, found);
        return { correlationId: found, origin: 'continued' };
      }
    }
    const correlationId = this.mintId();
    this.bindAll(candidates, correlationId);
    return { correlationId, origin: 'resumed' };
  }

  /** {@link resolveOrBeginWithOrigin} when the caller already knows the origin. */
  resolveOrBegin(
    candidates: ReadonlyArray<[CalibrationCorrelationKey, string | null]>,
  ): string {
    return this.resolveOrBeginWithOrigin(candidates).correlationId;
  }

  private bindAll(
    candidates: ReadonlyArray<[CalibrationCorrelationKey, string | null]>,
    correlationId: string,
  ): void {
    for (const [kind, id] of candidates) {
      if (typeof id === 'string' && id.length > 0) {
        this.bind(kind, id, correlationId);
      }
    }
  }

  /** Bindings currently retained. Exposed so the bound is testable. */
  size(): number {
    return this.bindings.size;
  }

  /**
   * Drop every binding. Used when the identifier space is no longer meaningful
   * — switching server profiles retires the previous server's IDs — and to
   * isolate tests that drive the process-wide registry.
   */
  clear(): void {
    this.bindings.clear();
  }
}

/**
 * Process-wide registry. Calibration flows are per-user and per-window, and the
 * identifiers are server-minted UUIDs, so a single registry is sufficient.
 */
export const calibrationCorrelation = new CalibrationCorrelationRegistry();
