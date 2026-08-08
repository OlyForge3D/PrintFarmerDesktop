export const EXPECTED_SETUP_FILES: string[];

export interface SetupFilesDiff {
  unexpected: string[];
  missing: string[];
}

export function diffSetupFiles(
  actual: unknown,
  expected?: string[],
): SetupFilesDiff;

export function resolveVitestBinPath(options?: {
  cwd?: string | undefined;
  requireImpl?: { resolve: (specifier: string) => string } | undefined;
}): string;

export function withRealVitestInvocationContext<T>(
  fn: () => Promise<T>,
  options: { vitestBinPath: string },
): Promise<T>;

export interface VitestLikeContext {
  config?: { setupFiles?: unknown; root?: string } | undefined;
  close: () => Promise<void>;
}

export type CreateVitestImpl = (
  mode: 'test' | 'benchmark',
  options: {
    run?: boolean;
    watch?: boolean;
    config?: string | false;
    root?: string;
  },
) => Promise<VitestLikeContext>;

export function resolveCommittedSetupFiles(input: {
  configPath: string;
  cwd: string;
  createVitestImpl: CreateVitestImpl;
  vitestBinPath?: string | undefined;
}): Promise<string[]>;

export function checkSetupFiles(options?: {
  cwd?: string | undefined;
  configPath?: string | undefined;
  expected?: string[] | undefined;
  createVitestImpl?: CreateVitestImpl | undefined;
  vitestBinPath?: string | undefined;
}): Promise<SetupFilesDiff>;

export function formatReport(diff: SetupFilesDiff, expected?: string[]): string;

export function defaultCreateVitest(
  mode: 'test' | 'benchmark',
  options: {
    run?: boolean;
    watch?: boolean;
    config?: string | false;
    root?: string;
  },
): Promise<VitestLikeContext>;

export function main(options?: {
  createVitestImpl?: CreateVitestImpl | undefined;
  log?: ((message: string) => void) | undefined;
}): Promise<number>;
