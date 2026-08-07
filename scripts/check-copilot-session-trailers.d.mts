export interface PullRequestCommit {
  sha: string;
  message: string;
}

export interface MalformedCopilotSessionTrailer {
  sha: string;
  value: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string },
) => string;

export interface TrailerCheckResult {
  ok: boolean;
  commits: number;
  malformed: MalformedCopilotSessionTrailer[];
}

export interface TrailerCheckDependencies {
  environment?: NodeJS.ProcessEnv;
  invokeGh?: (args: string[]) => string;
  interpretTrailers?: CommandRunner;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export function parsePullRequestCommits(raw: string): PullRequestCommit[];

export function parseCopilotSessionTrailerValues(
  message: string,
  interpret?: CommandRunner,
): string[];

export function findMalformedCopilotSessionTrailers(
  commits: PullRequestCommit[],
  interpret?: CommandRunner,
): MalformedCopilotSessionTrailer[];

export function formatMalformedTrailers(
  malformed: MalformedCopilotSessionTrailer[],
): string;

export function main(
  argv: string[],
  deps?: TrailerCheckDependencies,
): TrailerCheckResult;
