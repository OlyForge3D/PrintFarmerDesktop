export const CLEANUP_WARNING_MARKER: string;
export const CLEANUP_FAILURE_ANCHOR: string;
export const CLEANUP_FAILURE_DIAGNOSTIC: string;
export const CLEANUP_EVIDENCE_OUTPUT: string;
export const CLEANUP_EVIDENCE_FILENAME: string;
export const NPM_PRODUCTION_TREE_COMMAND: string;
export function hasCleanupFailure(output: unknown): boolean;
export function extractCleanupPaths(output: unknown): string[];
export function extractCleanupDirectories(output: unknown): string[];
export interface CleanupRecovery {
  attempted: boolean;
  recovered: boolean;
  directories: string[];
  reason: string | null;
}
export function retryCleanupRemovals(
  output: string,
  options?: {
    platform?: NodeJS.Platform;
    root?: string;
    rmImpl?: (
      path: string,
      options: {
        recursive: true;
        force: true;
        maxRetries: number;
        retryDelay: number;
      },
    ) => Promise<void>;
  },
): Promise<CleanupRecovery>;
export function resolveCleanupEvidencePath(
  environment?: NodeJS.ProcessEnv,
): string;
export interface CleanupEvidence {
  schemaVersion: number;
  anchor: string;
  diagnostic: string;
  recordedAt: string;
  repository: string | null;
  runId: string | null;
  runAttempt: string | null;
  runUrl: string | null;
  headSha: string | null;
  job: string | null;
  workflow: string | null;
  runnerOs: string;
  runnerName: string | null;
  cleanupPaths: string[];
  cleanupDirectories: string[];
  recovery: Pick<CleanupRecovery, 'attempted' | 'recovered' | 'reason'>;
  productionTreeProblems: string[];
  productionTreeExitProblems: string[];
  productionTreeError: string | null;
  warningExcerpt: string[];
}
export function createCleanupEvidence(input: {
  output: string;
  recovery: CleanupRecovery;
  productionTreeProblems?: string[];
  productionTreeExitProblems?: string[];
  productionTreeError?: string | null;
  environment?: NodeJS.ProcessEnv;
  recordedAt?: string;
}): CleanupEvidence;
export function writeCleanupEvidence(
  evidence: CleanupEvidence,
  options?: {
    environment?: NodeJS.ProcessEnv;
    mkdirImpl?: (
      path: string,
      options: { recursive: true },
    ) => Promise<unknown>;
    writeFileImpl?: (
      path: string,
      data: string,
      options: { encoding: 'utf8'; flag: 'wx' },
    ) => Promise<unknown>;
  },
): Promise<string>;
export function markCleanupEvidenceOutput(
  environment?: NodeJS.ProcessEnv,
  appendFileImpl?: (
    path: string,
    data: string,
    encoding: 'utf8',
  ) => Promise<unknown>,
): Promise<boolean>;
export function findTreeProblems(tree: unknown): string[];
export function findTreeExitProblems(
  status: unknown,
  stderr: unknown,
): string[];
export function findUnresolvedPackages(tree: unknown): string[];
export function npmInvocation(commandLine: string): {
  command: string;
  args: string[];
};
export interface MainDependencies {
  runNpmCi(): Promise<{ code: number; output: string }>;
  retryCleanupRemovals(output: string): Promise<CleanupRecovery>;
  writeCleanupEvidence(evidence: CleanupEvidence): Promise<string>;
  markCleanupEvidenceOutput(): Promise<boolean>;
  readProductionTree(): { tree: unknown; status: unknown; stderr: string };
  fail(lines: string[]): void;
  exit(code: number): void;
  writeStderr(message: string): void;
}
export function main(dependencies?: Partial<MainDependencies>): Promise<void>;
