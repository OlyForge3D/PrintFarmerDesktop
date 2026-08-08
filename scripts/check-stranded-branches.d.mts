export const EXIT_CLEAN: 0;
export const EXIT_STRANDED: 1;
export const EXIT_UNDETERMINED: 2;

export const DEFAULT_REMOTE: string;

export interface StrandedCommit {
  readonly sha: string;
  readonly subject: string;
  readonly issues: number[];
}

export interface LocalBranch {
  readonly name: string;
  readonly sha: string;
}

export interface BranchResult extends LocalBranch {
  readonly commits: StrandedCommit[];
}

export interface StrandedBranchEntry {
  readonly branch: string;
  readonly headSha: string;
  readonly ahead: number;
  readonly commits: StrandedCommit[];
}

export interface StrandedBranchesResult {
  readonly branchesExamined: number;
  readonly stranded: StrandedBranchEntry[];
  readonly remote?: string;
  readonly exitCode: typeof EXIT_CLEAN | typeof EXIT_STRANDED;
}

export interface RemoteRefPresence {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface CheckOutcome {
  readonly exitCode:
    typeof EXIT_CLEAN | typeof EXIT_STRANDED | typeof EXIT_UNDETERMINED;
  readonly report: string;
}

export interface GitCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export function listLocalBranches(cwd?: string): LocalBranch[];

export function evaluateRemoteRefPresence(
  remoteRefCount: number,
  remote?: string,
): RemoteRefPresence;

export function countRemoteRefs(cwd?: string, remote?: string): number;

export function pruneRemote(cwd?: string, remote?: string): GitCommandResult;

export function extractIssueReferences(message: string): number[];

export function listStrandedCommits(
  branch: string,
  cwd?: string,
  remote?: string,
): StrandedCommit[];

export function evaluateStrandedBranches(
  branchResults: BranchResult[],
  remote?: string,
): StrandedBranchesResult;

export function formatReport(result: StrandedBranchesResult): string;

export function runCheck(cwd?: string, remote?: string): CheckOutcome;
