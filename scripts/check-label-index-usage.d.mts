export interface ScannedFile {
  path: string;
  contents: string;
}

export interface LabelIndexPattern {
  name: string;
  pattern: RegExp;
}

export interface LabelIndexViolation {
  path: string;
  matches: string[];
  reason: string;
}

export interface LabelIndexAllowlistedEntry {
  path: string;
  matches: string[];
  reason: string;
}

export interface LabelIndexNeedsReviewEntry {
  path: string;
  name: string;
  snippet: string;
}

export interface ScanLabelIndexUsageResult {
  violations: LabelIndexViolation[];
  allowlisted: LabelIndexAllowlistedEntry[];
  needsReview: LabelIndexNeedsReviewEntry[];
}

export interface LabelIndexAllowlistEntryConfig {
  patterns?: readonly string[];
  reason: string;
}

export type LabelIndexAllowlist = Record<
  string,
  LabelIndexAllowlistEntryConfig | string
>;

export const SCANNED_DIRECTORIES: string[];
export const LABEL_INDEX_PATTERNS: LabelIndexPattern[];
export const ALLOWED_LABEL_INDEX_USAGE: Readonly<
  Record<string, Readonly<LabelIndexAllowlistEntryConfig>>
>;

export function flattenGhArgvInvocations(
  contents: string,
  extraWrapperNames?: Iterable<string>,
): string;

export function flattenIndirectLabelQueryConstruction(contents: string): string;

export interface UnresolvedGhWrapperCall {
  name: string;
  snippet: string;
}

export function findUnresolvedGhWrapperCalls(
  contents: string,
): UnresolvedGhWrapperCall[];

export function findGhWrapperNames(contents: string): Set<string>;

export function collectProjectGhWrapperNames(
  files: ScannedFile[],
): Map<string, Set<string>>;

export function scanLabelIndexUsage(input?: {
  files?: ScannedFile[];
  allowlist?: LabelIndexAllowlist;
}): ScanLabelIndexUsageResult;

export function formatViolation(violation: LabelIndexViolation): string;

export function formatNeedsReview(entry: LabelIndexNeedsReviewEntry): string;

export interface CollectScannedFilesResult {
  files: ScannedFile[];
  refusedSymlinks: string[];
}

export function collectScannedFiles(deps?: {
  readFile?: (path: string) => string;
  listFiles?: (directory: string) => string[];
  lstat?: (path: string) => { isSymbolicLink(): boolean };
}): CollectScannedFilesResult;

export function main(): Promise<void>;
