export const CLEANUP_WARNING_MARKER: string;
export const NPM_PRODUCTION_TREE_COMMAND: string;
export const NODE_MODULES_REMOVAL: { maxRetries: number; retryDelay: number };
export function hasCleanupFailure(output: unknown): boolean;
export function extractCleanupPaths(output: unknown): string[];
export function findTreeProblems(tree: unknown): string[];
export function findUnresolvedPackages(tree: unknown): string[];
export function npmInvocation(commandLine: string): {
  command: string;
  args: string[];
};

export function removeNodeModules(
  dir: string,
  options?: { rm?: typeof import('node:fs').rmSync },
): { removed: true };

export function repairOutcome(evidence: {
  secondExitCode: number;
  secondWarned: boolean;
  problems: string[];
  unresolved: string[];
}): { succeeded: boolean; reasons: string[] };

export interface RepairRecord {
  firstPaths: string[];
  secondExitCode: number;
  secondWarned: boolean;
  problems: string[];
  unresolved: string[];
  succeeded: boolean;
}

export function formatStepSummary(record: RepairRecord): string;
export function formatWarningAnnotation(record: {
  firstPaths: string[];
  succeeded: boolean;
}): string;
export function appendStepSummary(
  markdown: string,
  options?: {
    env?: Record<string, string | undefined>;
    append?: typeof import('node:fs').appendFileSync;
  },
): boolean;
export function writeRepairArtifact(
  record: object,
  target: string,
  options?: { write?: typeof import('node:fs').writeFileSync },
): void;

export type NpmCiResult = { code: number; output: string };
export type TreeInspection = { problems: string[]; unresolved: string[] };

export function dischargeCleanupFailure(
  firstOutput: string,
  deps?: {
    removeNodeModules?: (dir: string) => { removed: true };
    runNpmCi?: () => Promise<NpmCiResult>;
    inspectProductionTree?: () => TreeInspection;
    appendStepSummary?: (markdown: string) => boolean;
    writeRepairArtifact?: (record: object, target: string) => void;
    note?: (lines: string[]) => void;
    fail?: (lines: string[]) => void;
    nodeModulesPath?: string;
    artifactPath?: string;
  },
): Promise<void>;

export function main(deps?: {
  runNpmCi?: () => Promise<NpmCiResult>;
  dischargeCleanupFailure?: (firstOutput: string) => Promise<void>;
  inspectProductionTree?: () => TreeInspection;
  fail?: (lines: string[]) => void;
  exit?: (code: number) => void;
}): Promise<void>;
