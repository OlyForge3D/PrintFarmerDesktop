export interface OpenPullRequestClaim {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  closingIssues: IssueClaimIdentity[];
}

export interface IssueClaimIdentity {
  repository: string;
  number: number;
  closed: boolean;
}

export interface PullRequestIssueClaim {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  sources: string[];
}

export interface IssueClaimCollision {
  repository: string;
  issueNumber: number;
  pullRequests: PullRequestIssueClaim[];
}

export interface ClaimCollisionResult {
  openPullRequestCount: number;
  claimedIssueCount: number;
  singleClaimCount: number;
  collisions: IssueClaimCollision[];
  closedClaims: IssueClaimCollision[];
}

export interface SettledOpenPullRequests {
  value: OpenPullRequestClaim[];
  reads: number;
  settled: boolean;
  elapsedMs: number;
  stableMs: number;
}

export interface ResolvedBranchIssueDetails {
  issueNumbers: number[];
  closedIssueNumbers: number[];
}

export function parseOpenPullRequestPages(raw: string): OpenPullRequestClaim[];
export function parseBranchIssueCandidates(headRefName: string): number[];
export function collectBranchIssueCandidates(
  pullRequests: OpenPullRequestClaim[],
): number[];
export function branchIssueTypeQuery(numbers: number[]): string;
export function parseBranchIssueTypes(
  raw: string,
  expectedNumbers: number[],
): number[];
export function parseBranchIssueClosedNumbers(
  raw: string,
  expectedNumbers: number[],
): number[];
export function runGitHub(
  args: string[],
  execute?: (
    command: string,
    args: string[],
    options: {
      encoding: string;
      maxBuffer: number;
      stdio: string[];
    },
  ) => string,
): string;
export function readOpenPullRequests(input: {
  owner: string;
  repo: string;
  run: (args: string[]) => string;
}): OpenPullRequestClaim[];
export function readSettledOpenPullRequests(
  read: () => OpenPullRequestClaim[] | Promise<OpenPullRequestClaim[]>,
  options?: {
    requiredAgreements?: number;
    maxReads?: number;
    delayMs?: number;
    minStableMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<SettledOpenPullRequests>;
export function resolveBranchIssueNumbers(input: {
  owner: string;
  repo: string;
  numbers: number[];
  run: (args: string[]) => string;
}): number[];
export function resolveBranchIssueDetails(input: {
  owner: string;
  repo: string;
  numbers: number[];
  run: (args: string[]) => string;
}): ResolvedBranchIssueDetails;
export function evaluateClaimCollisions(
  pullRequests: OpenPullRequestClaim[],
  branchIssueNumbers: number[],
  branchIssueRepository: string,
  closedBranchIssueNumbers?: number[],
): ClaimCollisionResult;
export function formatCollisionWarnings(result: ClaimCollisionResult): string[];
export function formatClosedIssueClaimWarnings(
  result: ClaimCollisionResult,
): string[];
export function main(
  argv?: string[],
  deps?: {
    run?: (args: string[]) => string;
    environment?: Record<string, string | undefined>;
    output?: (line: string) => void;
    readPopulation?: (
      read: () => OpenPullRequestClaim[] | Promise<OpenPullRequestClaim[]>,
    ) => Promise<SettledOpenPullRequests>;
    resolveBranchIssueDetails?: (input: {
      owner: string;
      repo: string;
      numbers: number[];
      run: (args: string[]) => string;
    }) => ResolvedBranchIssueDetails;
  },
): Promise<ClaimCollisionResult>;
