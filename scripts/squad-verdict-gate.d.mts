export const verdictContext: string;
export const verdictMarker: string;
export const squadScopeLabel: string;
export const reviewPanel: string[];
export const fullGatePrefixes: string[];
export const fullGateFiles: Set<string>;
export const sensitiveProsePrefixes: string[];
export const sensitiveProseFiles: Set<string>;
export const proseExtensions: string[];

export type SquadVerdict = 'APPROVE' | 'REQUEST_CHANGES';

export interface CommentLike {
  id?: number;
  body?: string;
  user?: { login?: string };
  author_association?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  /** Set by the caller from the live collaborator-permission API. */
  squadWriteAccess?: boolean;
  /** Set by the caller when an administrator names their own login. */
  squadAdminOverride?: boolean;
}

export interface VerdictRecord {
  reviewer: string;
  verdict: SquadVerdict;
  headSha: string;
  commenter: string;
  association: string;
  trusted: boolean;
  isSelfDeclaredAdmin: boolean;
  recordedAt: string;
  url: string;
  carriedAcrossSync?: boolean;
}

export interface ReviewLike {
  id?: number;
  state?: string;
  submittedAt?: string;
  commitId?: string;
  login?: string;
  isAdmin?: boolean;
}

export interface CompareFileLike {
  status?: string;
  filename?: string;
  previous_filename?: string;
  sha?: string;
  patch?: string;
}

export interface GateResult {
  state: 'success' | 'failure' | 'error';
  passed: boolean;
  scope?: 'out-of-scope';
  override?: 'github-review' | 'owner-comment';
  description: string;
  reason: string;
  notes: string[];
  requiredMembers: string[];
  approvals: string[];
  stale: VerdictRecord[];
  carried?: string[];
}

export function hasSquadScopeLabel(
  labels?: Array<string | { name?: string } | null | undefined>,
): boolean;

export function canAutoScope(input?: {
  authorMembers?: Iterable<string>;
  roster?: Set<string>;
  isFork?: boolean;
}): boolean;

export function hasWriteAccess(permission: unknown): boolean;

export function hasAdminAccess(permission: unknown): boolean;

export function normalizeMember(raw: unknown): string | undefined;

export function rosterFromLabels(labelNames?: string[]): Set<string>;

export function parseVerdictComment(
  comment: CommentLike | null | undefined,
): VerdictRecord | undefined;

export function isCarriedAcrossSync(input?: {
  /** `undefined` is a valid input — an unknown ancestry must fail closed. */
  recordAncestryStatus?: string | undefined;
  reviewedDiffFiles?: CompareFileLike[];
  currentDiffFiles?: CompareFileLike[];
  filesMayBeTruncated?: boolean;
  nonBaseCommitsIntroduceNoExtraContent?: boolean;
}): boolean;

export function diffFingerprint(files: CompareFileLike[]): string;

export function collectVerdicts(
  comments: CommentLike[] | undefined,
  headSha: string,
  options?: { carriedShas?: Iterable<string> },
): {
  current: Map<string, VerdictRecord>;
  stale: VerdictRecord[];
  unauthenticated: VerdictRecord[];
};

export function classifyChangeScope(paths?: string[]): {
  docsOnly: boolean;
  reason: string;
};

export function resolveAuthorMembers(input?: {
  prBody?: string;
  branchName?: string;
  linkedIssueLabels?: string[];
  roster?: Set<string>;
}): { members: Set<string>; source: string };

export function evaluateGate(input?: {
  headSha?: string;
  changedPaths?: string[];
  comments?: CommentLike[];
  reviews?: ReviewLike[];
  roster?: Set<string>;
  authorMembers?: Set<string>;
  authorSource?: string;
  squadLabeled?: boolean;
  carriedShas?: Iterable<string>;
}): GateResult;
