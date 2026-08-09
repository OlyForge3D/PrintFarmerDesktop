export interface DocsOnlyVerdict {
  readonly docsOnly: boolean;
  readonly offenders: readonly string[];
  readonly reason: string;
}

export interface DocsAndTestsVerdict {
  readonly docsAndTests: boolean;
  readonly offenders: readonly string[];
  readonly reason: string;
}

export function isDocumentationPath(file: unknown): boolean;

export function isDocsOrTestPath(file: unknown): boolean;

export function classifyPaths(files: unknown): DocsOnlyVerdict;

export function classifyDocsAndTests(files: unknown): DocsAndTestsVerdict;
