export type FieldKind = 'durable' | 'volatile' | 'latch';

export interface FieldSpec {
  kind: FieldKind;
  /** Present only for `latch`: the field whose truth closes the latch. */
  latchedBy?: string;
}

export const FIELD_CLASSES: Record<string, FieldSpec>;

export type Outcome =
  | 'durable'
  | 'fresh'
  | 'latched'
  | 'refused-stale'
  | 'refused-latch-open'
  | 'refused-unclassified';

export const OUTCOMES: Outcome[];
export const REFUSALS: Outcome[];

export interface Action {
  id: string;
  startedAt: string;
}

export interface Snapshot {
  /** `null` for a snapshot that arrived from outside this action. */
  actionId: string | null;
  observedAt: string | null;
  fields: Record<string, unknown>;
}

export interface ReportEntry {
  field: string;
  outcome: Outcome;
  reason: string;
  withheld: boolean;
  /** `null` whenever `withheld` — a refusal never carries the value. */
  value: unknown;
}

export interface Report {
  observedAt: string | null;
  actionId: string | null;
  sameAction: boolean;
  entries: ReportEntry[];
}

export function beginAction(now?: () => string): Action;
export function observe(
  fetchFields: () => Record<string, unknown>,
  action: Action,
  now?: () => string,
): Snapshot;
export function relayedSnapshot(input: {
  observedAt?: string | null;
  fields: Record<string, unknown>;
}): Snapshot;
export function classifyField(
  field: string,
  snapshot: Snapshot,
  sameAction: boolean,
): { outcome: Outcome; reason: string };
export function report(snapshot: Snapshot, action: Action | null): Report;
export function renderLines(result: Report): string[];
export function ghFetcher(
  repo: string,
  number: string,
): () => Record<string, unknown>;
export function parseArgs(argv: string[]): { repo: string; number: string };
export function main(
  argv?: string[],
  out?: Pick<Console, 'log' | 'error'>,
): number;
