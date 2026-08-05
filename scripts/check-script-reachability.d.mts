export declare const SCRIPT_DIRECTORY: string;
export declare const UNINVOKED_SCRIPTS: Record<string, string>;
export declare const UNENFORCED_CHECKS: Record<string, string>;
export declare const SOURCE_EXTENSIONS: string[];

export interface SourceFile {
  path: string;
  contents: string;
}

export interface InvocationKind {
  kind: 'npm' | 'workflow' | 'import' | 'dynamic';
  where: string;
}

export interface ReachabilityReport {
  orphans: Array<{ basename: string }>;
  declared: Array<{ basename: string; reason: string }>;
  invoked: Array<{ basename: string; kinds: InvocationKind[] }>;
}

export interface EnforcementReport {
  unenforced: Array<{ key: string }>;
  declared: Array<{ key: string; reason: string }>;
  enforced: Array<{ key: string; workflows: string[] }>;
}

export declare function runCommandLines(contents: string): string[];

export declare function invocationKinds(options: {
  basename: string;
  filePath: string;
  contents: string;
}): InvocationKind[];

export declare function evaluateScriptReachability(options: {
  scripts: string[];
  files: SourceFile[];
  allowlist?: Record<string, string>;
}): ReachabilityReport;

export declare function evaluateCheckEnforcement(options: {
  packageScripts: Record<string, string>;
  workflows: SourceFile[];
  allowlist?: Record<string, string>;
}): EnforcementReport;

export interface UnresolvedImport {
  from: string;
  specifier: string;
  target: string;
}

export interface ImportResolutionReport {
  resolved: UnresolvedImport[];
  unresolved: UnresolvedImport[];
}

export declare function relativeImportSpecifiers(contents: string): string[];

export declare function evaluateImportResolution(options: {
  sources: readonly SourceFile[];
  trackedPaths: ReadonlySet<string>;
}): ImportResolutionReport;

export declare function formatFindings(options: {
  reachability: ReachabilityReport;
  enforcement: EnforcementReport;
  // Optional on purpose. Two call sites in the test suite predate this
  // evaluator, and making it required would turn a missing argument into a
  // type error at exactly the sites that have nothing to say about imports.
  imports?: ImportResolutionReport;
}): string[];

export declare function readTrackedFiles(repoRoot: string): SourceFile[];

export declare function readAllTrackedPaths(repoRoot: string): string[];
