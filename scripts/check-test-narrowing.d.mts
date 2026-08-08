export const NARROWING_FLAGS: Set<string>;

export interface NarrowingMatch {
  flag: string;
  value: string;
}

export interface Violation {
  home: 'vitest.config.ts' | 'package.json' | 'workflow';
  location: string;
  command: string | null;
  flag: string;
  value: string;
}

export interface RunBlock {
  lineNumber: number;
  command: string;
}

export interface WorkflowFile {
  file: string;
  contents: string;
}

export function tokenizeCommand(command: unknown): string[];

export function detectNarrowingFlag(tokens: string[]): NarrowingMatch | null;

export function isDirectVitestInvocation(tokens: string[]): boolean;

export function joinLineContinuations(text: unknown): string;

export function detectWrappedNarrowing(rawText: unknown): NarrowingMatch | null;

export function checkPackageJsonScripts(scripts: unknown): Violation[];

export function extractRunBlocks(contents: unknown): RunBlock[];

export function checkWorkflowText(file: string, contents: string): Violation[];

export type LoadConfigFromFile = (
  configEnv: { command: 'build' | 'serve'; mode: string },
  configPath: string,
  cwd: string,
) => Promise<{ config?: { test?: { testNamePattern?: unknown } } } | null>;

export function resolveVitestConfigNarrowing(input: {
  configPath: string;
  cwd: string;
  loadConfigFromFile: LoadConfigFromFile;
}): Promise<Violation | null>;

export function checkVitestConfig(input: {
  configPath: string;
  cwd: string;
  loadConfigFromFile: LoadConfigFromFile;
}): Promise<Violation[]>;

export function readWorkflowFiles(
  workflowsDir: string,
  options?: {
    readdir?: ((dir: string) => string[]) | undefined;
    readFile?: ((path: string, encoding: string) => string) | undefined;
  },
): WorkflowFile[];

export function checkAllHomes(options?: {
  cwd?: string | undefined;
  configPath?: string | undefined;
  packageJsonPath?: string | undefined;
  workflowsDir?: string | undefined;
  loadConfigFromFile?: LoadConfigFromFile | undefined;
  readFile?: ((path: string, encoding: string) => string) | undefined;
  readdir?: ((dir: string) => string[]) | undefined;
}): Promise<Violation[]>;

export function formatReport(violations: Violation[]): string;

export function defaultLoadConfigFromFile(
  configEnv: { command: 'build' | 'serve'; mode: string },
  configPath: string,
  cwd: string,
): Promise<{ config?: { test?: { testNamePattern?: unknown } } } | null>;

export function main(options?: {
  loadConfigFromFile?: LoadConfigFromFile | undefined;
  log?: ((message: string) => void) | undefined;
}): Promise<number>;
