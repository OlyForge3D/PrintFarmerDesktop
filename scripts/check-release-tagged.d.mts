export const VERDICT_TAGGED: 'tagged';
export const VERDICT_UNTAGGED: 'untagged';
export const VERDICT_PENDING: 'pending';
export const VERDICT_MISPLACED: 'misplaced';
export const VERDICT_UNVERIFIABLE: 'unverifiable';

export const EXIT_TAGGED: 0;
export const EXIT_UNTAGGED: 1;
export const EXIT_UNVERIFIABLE: 2;

export const DEFAULT_GRACE_HOURS: number;

export type ReleaseVerdict =
  | typeof VERDICT_TAGGED
  | typeof VERDICT_UNTAGGED
  | typeof VERDICT_PENDING
  | typeof VERDICT_MISPLACED
  | typeof VERDICT_UNVERIFIABLE;

export interface TagAncestryReading {
  reached: boolean | null;
  reason: string;
}

export interface PresenceReading {
  verdict: ReleaseVerdict;
  tagName: string | null;
  reason: string;
}

export interface PublicationReading {
  checked: boolean;
  published: boolean | null;
  reason: string;
}

export interface ReleaseLookup {
  found: boolean;
  isPrerelease?: boolean;
  assets: string[];
}

export interface CwdOption {
  cwd?: string;
}

export function tagNameForVersion(version: unknown): string | null;

export function parseVersion(packageJsonText: unknown): string | null;

export function classifyTagAncestry(input?: {
  code?: number;
  tagName?: string;
  targetRef?: string;
}): TagAncestryReading;

export function classifyTagPresence(input?: {
  version?: string | null;
  tagExists?: boolean;
  knownTagCount?: number;
  tagAncestry?: TagAncestryReading | undefined;
  bumpAgeHours?: number | null;
  graceHours?: number;
}): PresenceReading;

export function classifyPublication(input?: {
  tagName?: string | null;
  presence?: ReleaseVerdict;
  release?: ReleaseLookup | null;
}): PublicationReading;

export function evaluateRelease(input?: {
  presence?: PresenceReading;
  publication?: PublicationReading;
}): { exitCode: 0 | 1 | 2; verdict: ReleaseVerdict };

export function formatResult(input: {
  targetRef?: string;
  version?: string | null;
  presence?: PresenceReading;
  publication?: PublicationReading;
}): string;

export function readVersionAt(
  targetRef: string,
  options?: CwdOption,
): string | null;

export function countVersionTags(options?: CwdOption): number;

export function tagExists(tagName: string, options?: CwdOption): boolean;

export function tagAncestryCode(
  tagName: string,
  targetRef: string,
  options?: CwdOption,
): number;

export function bumpAgeHoursAt(
  targetRef: string,
  version: string,
  now?: number,
  options?: CwdOption,
): number | null;

export function fetchRelease(input: {
  repository: string | null;
  token?: string;
  tagName: string;
}): Promise<ReleaseLookup | null>;

export function main(argv?: string[]): Promise<0 | 1 | 2>;
