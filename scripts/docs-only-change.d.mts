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

export interface RustUntouchedVerdict {
  readonly rustUntouched: boolean;
  /** The changed paths that CAN reach the cargo build -- the reason it must run. */
  readonly offenders: readonly string[];
  readonly reason: string;
}

export function isDocumentationPath(file: unknown): boolean;

export function isDocsOrTestPath(file: unknown): boolean;

/**
 * True when a path can affect the cargo build. Note the inverted sense relative to the two
 * predicates above: this one answers `true` for anything it cannot reason about, because here it
 * is a false `false` that would remove a required check's work.
 */
export function affectsRust(file: unknown): boolean;

export function classifyPaths(files: unknown): DocsOnlyVerdict;

export function classifyDocsAndTests(files: unknown): DocsAndTestsVerdict;

export function classifyRustUntouched(files: unknown): RustUntouchedVerdict;
