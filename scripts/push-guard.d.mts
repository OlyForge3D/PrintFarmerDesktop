export interface RefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export interface GuardedCommit {
  sha: string;
  subject?: string;
  sessions?: string[];
}

export interface PushFacts {
  liveRemoteSha: string | null;
  discarded: GuardedCommit[];
  pushedSessions?: Iterable<string>;
  ack?: string | undefined;
  ackForeign?: string | undefined;
}

export type GuardCode =
  | 'push-guard.protected-ref'
  | 'push-guard.stale-lease'
  | 'push-guard.branch-delete'
  | 'push-guard.acknowledged-delete'
  | 'push-guard.new-branch'
  | 'push-guard.fast-forward'
  | 'push-guard.foreign-session'
  | 'push-guard.unacknowledged-discard'
  | 'push-guard.ack-mismatch'
  | 'push-guard.acknowledged-discard';

export interface GuardResult {
  verdict: 'allow' | 'refuse';
  code: GuardCode;
  message: string;
}

export const ZERO_SHA: string;
export const PROTECTED_REFS: readonly string[];
export const ACK_ENV: string;
export const ACK_FOREIGN_ENV: string;

export function evaluateRefUpdate(
  update: RefUpdate,
  facts: PushFacts,
): GuardResult;
export function readLiveRemoteSha(remote: string, ref: string): string | null;
export function readCommits(range: string[]): Required<GuardedCommit>[];
export function gatherFacts(
  update: RefUpdate,
  remote: string,
  env?: NodeJS.ProcessEnv,
): PushFacts;
export function parseStdin(text: string): RefUpdate[];
