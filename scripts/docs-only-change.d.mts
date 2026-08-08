export interface DocsOnlyVerdict {
  readonly docsOnly: boolean;
  readonly offenders: readonly string[];
  readonly reason: string;
}

export function isDocumentationPath(file: unknown): boolean;

export function classifyPaths(files: unknown): DocsOnlyVerdict;
