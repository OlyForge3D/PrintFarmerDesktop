export const EXIT_CLEAN: 0;
export const EXIT_UNARMED: 1;
export const EXIT_UNDETERMINED: 2;

export interface ParsedWorktree {
  readonly path: string;
  readonly normalizedPath: string;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
}

export interface HooksArmedStatus {
  armed: boolean;
  reason: string | null;
  configured: string | null;
  hooksDir: string | null;
  hookPath: string | null;
  toplevel: string | null;
}

export interface CoverageEntry {
  readonly path: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly status: HooksArmedStatus;
}

export interface CoverageResult {
  readonly entries: CoverageEntry[];
  readonly unarmed: CoverageEntry[];
  readonly exitCode: typeof EXIT_CLEAN | typeof EXIT_UNARMED;
}

export interface OkResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface PresenceResult extends OkResult {
  readonly match?: ParsedWorktree;
}

export interface CheckOutcome {
  readonly exitCode:
    typeof EXIT_CLEAN | typeof EXIT_UNARMED | typeof EXIT_UNDETERMINED;
  readonly report: string;
}

export function normalizeSeparators(candidate: string): string;

export function parsePorcelainWorktreeList(output: string): ParsedWorktree[];

export function enumerateWorktrees(cwd?: string): ParsedWorktree[];

export function evaluatePopulation(worktrees: ParsedWorktree[]): OkResult;

export function assertMainCheckoutPresent(
  worktrees: ParsedWorktree[],
  mainCheckoutPath: string,
): PresenceResult;

export function evaluateCoverage(entries: CoverageEntry[]): CoverageResult;

export function formatReport(result: CoverageResult): string;

export function runCheck(cwd?: string): CheckOutcome;
