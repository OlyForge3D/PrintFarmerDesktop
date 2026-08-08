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
  /**
   * Whether the live remote tip is readable in this object store. Required, not
   * optional: `gatherFacts` measures it on every path, so an optional field
   * would only ever be omitted by a test fixture — a shape production cannot
   * produce. The guard refuses on anything but `true`.
   */
  liveTipPresent: boolean;
  /**
   * Whether the live `ls-remote` query failed. Recorded as a fact rather than
   * thrown, so a network failure cannot skip the decision function entirely.
   */
  liveQueryFailed: boolean;
  /** First line of the failure, for the diagnostic. Empty when it succeeded. */
  liveQueryError: string;
  /**
   * Only consulted when `liveQueryFailed`. Tri-state on purpose: `true` the
   * update provably destroys nothing, `false` it provably does, `null` the
   * question is unanswerable because the advertised object is absent. Only
   * `true` permits an allow.
   */
  provablyFastForward: boolean | null;
  discarded: GuardedCommit[];
  /**
   * Commits the push removes from the ref whose content survives locally under
   * a different sha. Optional because the safe default is empty: omitting it
   * can only make the guard stricter, unlike `ownershipEvidence`.
   */
  preserved?: string[];
  ownSessions?: Iterable<string>;
  /**
   * The exact commit objects this worktree created. Optional, and the safe
   * default is empty for the same reason as `preserved`: omitting it can only
   * make the guard stricter, never more permissive.
   *
   * This exists because `ownSessions` cannot answer the question. A
   * `Copilot-Session` trailer reaches a commit through its author's prompt, so
   * two sessions handed the same brief carry the same id and each is exempted
   * from the other's ownership check. A sha is not transcribable from an
   * instruction. See `readOwnedCommits`.
   */
  ownCommits?: Iterable<string>;
  /**
   * Whether this clone authored anything, i.e. whether it created a commit at
   * all. Required, because absence of a session id from `ownSessions` is only
   * evidence when the instrument that records it was running AND had something
   * to record. Deliberately not optional: a caller that omits it would silently
   * get the over-claiming behaviour this field was added to remove.
   */
  ownershipEvidence: boolean;
  ack?: string | undefined;
  ackForeign?: string | undefined;
  /**
   * State of the pull request whose head is this branch (#184), or `null` when
   * none could be resolved — either there is no such PR, or the `gh` query
   * could not be answered at all (no binary, no credential, no network).
   * Those two cases are collapsed deliberately: neither is evidence of a
   * merged/closed PR. Optional because the safe default is "unknown", which
   * never refuses — omitting it can only make the guard more permissive on
   * THIS check, unlike `ownershipEvidence`.
   */
  prState?: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  /** The PR's number under the same conditions as `prState`. */
  prNumber?: number | null;
}

export type GuardCode =
  | 'push-guard.protected-ref'
  | 'push-guard.pr-already-resolved'
  | 'push-guard.stale-lease'
  | 'push-guard.unfetched-remote-tip'
  | 'push-guard.unverified-fast-forward'
  | 'push-guard.unverifiable-remote'
  | 'push-guard.branch-delete'
  | 'push-guard.acknowledged-delete'
  | 'push-guard.new-branch'
  | 'push-guard.fast-forward'
  | 'push-guard.rewrite-preserves-all'
  | 'push-guard.foreign-session'
  | 'push-guard.unowned-discard'
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
export function readLiveRemoteSha(
  remote: string,
  ref: string,
  location?: string,
): string | null;
export function readPushUrl(remote: string): string;
export function readAssociatedPullRequest(
  branch: string,
  env?: NodeJS.ProcessEnv,
  run?: (
    command: string,
    args: string[],
    options?: unknown,
  ) => {
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  },
): { state: 'OPEN' | 'MERGED' | 'CLOSED' | null; number: number | null };
export function isAncestor(
  ancestor: string,
  descendant: string,
): boolean | null;
export function hasCommit(sha: string): boolean;
export function readCommits(range: string[]): Required<GuardedCommit>[];
export function readEquivalentCommits(
  localSha: string,
  liveSha: string,
): Set<string>;
export function readReflogSessions(): Set<string>;
export function readOwnedCommits(): Set<string>;
export function authoredHere(): boolean;

/**
 * Canonical home of the origin label. `safe-force-push.mjs` re-exports this
 * rather than keeping its own copy: the pre-push refusal and the force-push
 * preview describe the same commits to the same operator, and two copies of the
 * rule are two things that can disagree.
 *
 * `attributable` is required rather than defaulted so no caller can silently
 * pick a side on the question the third state exists to keep open.
 */
export function originLabel(
  sha: string,
  owned: Set<string>,
  attributable: boolean,
): string;
export function readReflogEntries(
  ref: string,
): { sha: string; reflogSubject: string; sessions: string[] }[];
export function gatherFacts(
  update: RefUpdate,
  remote: string,
  env?: NodeJS.ProcessEnv,
  location?: string,
): PushFacts;
export function parseStdin(text: string): RefUpdate[];
