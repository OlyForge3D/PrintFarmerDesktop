export const DIRECT_PUSH_TRACKING_ISSUE: 388;

export interface DirectPushCommit {
  sha: string;
  author: string;
  authoredDate: string;
  subject: string;
}

export interface IssueComment {
  body?: string;
}

export function findBareCommits(
  commits: readonly DirectPushCommit[],
  pullCounts: ReadonlyMap<string, number>,
): DirectPushCommit[];

export function formatBareCommitEvidence(commit: DirectPushCommit): string;

export function alreadyRecorded(
  existingComments: readonly IssueComment[] | undefined,
  sha: string,
): boolean;

export function countAssociatedPullRequests(args: {
  owner: string;
  repo: string;
  sha: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<number>;

export function fetchTrackingIssueComments(args: {
  owner: string;
  repo: string;
  issueNumber: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<IssueComment[]>;

export function postTrackingIssueComment(args: {
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string>;

export function readCommitRange(
  since: string,
  ref: string,
  exec?: (
    command: string,
    args: readonly string[],
    options: { encoding: 'utf8' },
  ) => string,
): DirectPushCommit[];
