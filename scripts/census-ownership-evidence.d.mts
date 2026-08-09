export function listWorktreePaths(cwd?: string): string[];

export interface WorktreeMeasurement {
  readonly path: string;
  readonly ok: boolean;
  readonly ownershipEvidence: boolean | null;
  readonly ownCommits: string[];
  readonly error?: string;
}

export function measureWorktree(worktreePath: string): WorktreeMeasurement;

export interface CensusSummary {
  readonly worktreesTotal: number;
  readonly evaluable: number;
  readonly unreadable: number;
  readonly ownershipEvidenceTrue: number;
  readonly ownershipEvidenceFalse: number;
  readonly ownershipEvidenceIndeterminate: number;
  readonly wronglyAccused: number;
  readonly collisions: Array<[string, string[]]>;
  readonly trueEntries: WorktreeMeasurement[];
  readonly falseEntries: WorktreeMeasurement[];
  readonly indeterminateEntries: WorktreeMeasurement[];
  readonly unreadableEntries: WorktreeMeasurement[];
}

export function summarizeCensus(
  measurements: WorktreeMeasurement[],
): CensusSummary;

export function formatCensusCitation(
  summary: CensusSummary,
  options?: { measuredAt?: string },
): string;

export function formatReport(
  summary: CensusSummary,
  options?: { measuredAt?: string },
): string;

export interface CensusResult {
  readonly summary: CensusSummary;
  readonly measurements: WorktreeMeasurement[];
  readonly report: string;
}

export function runCensus(
  cwd?: string,
  options?: { measuredAt?: string },
): CensusResult;
