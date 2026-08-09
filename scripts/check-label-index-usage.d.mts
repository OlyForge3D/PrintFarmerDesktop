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

export interface ScanLabelIndexUsageResult {
  violations: LabelIndexViolation[];
  allowlisted: LabelIndexAllowlistedEntry[];
}

export const SCANNED_DIRECTORIES: string[];
export const LABEL_INDEX_PATTERNS: LabelIndexPattern[];
export const ALLOWED_LABEL_INDEX_USAGE: Readonly<Record<string, string>>;

export function scanLabelIndexUsage(input?: {
  files?: ScannedFile[];
  allowlist?: Record<string, string>;
}): ScanLabelIndexUsageResult;

export function formatViolation(violation: LabelIndexViolation): string;

export function collectScannedFiles(deps?: {
  readFile?: (path: string) => string;
  listFiles?: (directory: string) => string[];
}): ScannedFile[];

export function main(): Promise<void>;
