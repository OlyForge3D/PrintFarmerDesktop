export interface NpmCommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | null;
  stderr: string | null;
  error?: Error;
}

export interface NpmRunOptions {
  cwd: string;
  stdio: 'inherit' | ['ignore', 'pipe', 'pipe'];
  encoding?: BufferEncoding;
  maxBuffer?: number;
}

export type NpmRunner = (
  args: readonly string[],
  options: NpmRunOptions,
) => NpmCommandResult;

export function executeNpm(
  args: readonly string[],
  options: NpmRunOptions,
): NpmCommandResult;

export function assertCompleteNpmTree(tree: unknown): void;

export function installDependencies(options?: {
  cwd?: string;
  runNpm?: NpmRunner;
}): void;

export function runCiInstall(options?: {
  cwd?: string;
  runNpm?: NpmRunner;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}): number;
