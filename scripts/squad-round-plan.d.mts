export const ERR_TRUNCATED_LISTING: 'E_TRUNCATED_LISTING';
export const ERR_MALFORMED_RESPONSE: 'E_MALFORMED_RESPONSE';
export const ERR_DEPENDENCY_CYCLE: 'E_DEPENDENCY_CYCLE';

export const PRIORITY_ORDER: readonly string[];
export const NO_PRIORITY_RANK: number;

export class RoundPlanError extends Error {
  constructor(code: string, message: string, details?: Record<string, unknown>);
  code: string;
  details: Record<string, unknown>;
}

export interface NormalizedIssue {
  number: number;
  state: string;
  title: string;
  labels: string[];
  assignees: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DependencyGraph {
  blockedBy: Map<number, Set<number>>;
  blocking: Map<number, Set<number>>;
  states: Map<number, string>;
}

export interface QueueEntry {
  number: number;
  title: string;
  priorityRank: number;
  ownPriorityRank: number;
  inheritedFrom: number | null;
  unblockValue: number;
  createdAt: string | null;
}

export interface RoundPlan {
  openIssues: number;
  duplicatesCollapsed: number[];
  cycles: number[][];
  blocked: Array<{
    number: number;
    blockers: number[];
    sources: { native: number[]; prose: number[] };
  }>;
  queue: QueueEntry[];
  dispatch: number[];
  slots: { capacity: number; active: number; free: number };
  cache: {
    reused: number[];
    reinspect: Array<{ number: number; why: string }>;
  };
  accounting: {
    open: number;
    blocked: number;
    ready: number;
    balanced: boolean;
  };
}

export function assertCompleteListing<T>(options: {
  items: unknown;
  limit: number | undefined;
  hasNextPage?: boolean;
  source?: string;
}): T[];

export function normalizeIssues(
  rows: unknown,
  options?: { source?: string },
): { issues: NormalizedIssue[]; duplicates: number[] };

export function priorityRank(labels: readonly string[] | undefined): number;

export function buildDependencyGraph(
  dependencies: unknown,
  options?: { source?: string },
): DependencyGraph;

export function findDependencyCycles(graph: DependencyGraph): number[][];

export function openBlockers(
  number: number,
  context: {
    graph: DependencyGraph;
    issueStates?: Map<number, string>;
    markers?: Record<number | string, readonly number[]>;
  },
): { native: number[]; prose: number[]; all: number[] };

export function transitiveUnblockValue(
  number: number,
  context: { graph: DependencyGraph; issueStates?: Map<number, string> },
): number;

export function effectivePriority(
  number: number,
  context: { graph: DependencyGraph; issues: readonly NormalizedIssue[] },
): { rank: number; ownRank: number; inheritedFrom: number | null };

export function orderQueue(
  candidates: readonly NormalizedIssue[],
  context: {
    graph: DependencyGraph;
    issues: readonly NormalizedIssue[];
    issueStates?: Map<number, string>;
  },
): QueueEntry[];

export function diffSnapshot(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): {
  added: string[];
  changed: string[];
  unchanged: string[];
  removed: string[];
};

export function buildRoundPlan(input: {
  issues: unknown;
  dependencies: unknown;
  markers?: Record<number | string, readonly number[]>;
  slots?: { capacity?: number; active?: number };
  reuse?: {
    reuse: Array<{ number: number }>;
    inspect: Array<{ number: number; reason?: string }>;
  };
}): RoundPlan;

export function formatPlan(plan: RoundPlan): string;
