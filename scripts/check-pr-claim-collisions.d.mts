export interface OpenPullRequestClaim {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  closingIssueNumbers: number[];
}

export interface PullRequestIssueClaim {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  sources: string[];
}

export interface IssueClaimCollision {
  issueNumber: number;
  pullRequests: PullRequestIssueClaim[];
}

export interface ClaimCollisionResult {
  openPullRequestCount: number;
  claimedIssueCount: number;
  singleClaimCount: number;
  collisions: IssueClaimCollision[];
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
export function readOpenPullRequests(input: {
  owner: string;
  repo: string;
  run: (args: string[]) => string;
}): OpenPullRequestClaim[];
export function resolveBranchIssueNumbers(input: {
  owner: string;
  repo: string;
  numbers: number[];
  run: (args: string[]) => string;
}): number[];
export function evaluateClaimCollisions(
  pullRequests: OpenPullRequestClaim[],
  branchIssueNumbers: number[],
): ClaimCollisionResult;
export function formatCollisionWarnings(result: ClaimCollisionResult): string[];
export function main(
  argv?: string[],
  deps?: {
    run?: (args: string[]) => string;
    environment?: Record<string, string | undefined>;
    output?: (line: string) => void;
  },
): ClaimCollisionResult;
