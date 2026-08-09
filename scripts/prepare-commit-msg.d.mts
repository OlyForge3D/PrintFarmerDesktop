export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string },
) => string;

export const SESSION_ENV_VAR: string;
export const SKIPPED_SOURCES: Set<string>;

export function resolveSessionId(
  environment?: NodeJS.ProcessEnv,
): string | null;

export function appendSessionTrailer(
  messageFilePath: string,
  sessionId: string,
  exec?: CommandRunner,
): void;

export interface PrepareCommitMsgResult {
  applied: boolean;
  sessionId?: string;
  reason?: string;
}

export interface PrepareCommitMsgDependencies {
  environment?: NodeJS.ProcessEnv;
  exec?: CommandRunner;
}

export function main(
  argv: (string | undefined)[],
  deps?: PrepareCommitMsgDependencies,
): PrepareCommitMsgResult;
