export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string },
) => string;

export const DEFAULT_MAX_SESSION_HOURS: number;

export interface CollisionCommit {
  sha: string;
  authorDate: Date;
  message: string;
}

export function readNonMergeCommits(
  ref: string,
  git?: CommandRunner,
  since?: string,
): CollisionCommit[];

export function parseSessionTrailerValues(
  message: string,
  interpret?: CommandRunner,
): string[];

export interface FormednessFindings {
  missing: { sha: string }[];
  malformed: { sha: string; value: string }[];
}

export function findFormednessFindings(
  commits: CollisionCommit[],
  interpret?: CommandRunner,
): FormednessFindings;

export interface SessionLifetimeViolation {
  value: string;
  count: number;
  spanHours: number;
  firstSha: string;
  lastSha: string;
}

export function findSessionLifetimeViolations(
  commits: CollisionCommit[],
  maxSessionHours: number,
  interpret?: CommandRunner,
): SessionLifetimeViolation[];

export function formatReport(report: {
  missing: { sha: string }[];
  malformed: { sha: string; value: string }[];
  violations: SessionLifetimeViolation[];
  maxSessionHours: number;
}): string;

export interface CollisionCheckResult {
  ok: boolean;
  commits: number;
  missing: { sha: string }[];
  malformed: { sha: string; value: string }[];
  violations: SessionLifetimeViolation[];
}

export interface CollisionCheckDependencies {
  readCommits?: (
    ref: string,
    git: CommandRunner | undefined,
    since: string | undefined,
  ) => CollisionCommit[];
  interpretTrailers?: CommandRunner;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export function main(
  argv: string[],
  deps?: CollisionCheckDependencies,
): CollisionCheckResult;
