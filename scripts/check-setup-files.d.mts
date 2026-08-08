export const EXPECTED_SETUP_FILES: string[];

export interface SetupFilesDiff {
  unexpected: string[];
  missing: string[];
}

export function diffSetupFiles(
  actual: unknown,
  expected?: string[],
): SetupFilesDiff;

export type LoadConfigFromFile = (
  configEnv: { command: 'build' | 'serve'; mode: string },
  configPath: string,
  cwd: string,
) => Promise<{ config?: { test?: { setupFiles?: unknown } } } | null>;

export function resolveCommittedSetupFiles(input: {
  configPath: string;
  cwd: string;
  loadConfigFromFile: LoadConfigFromFile;
}): Promise<string[]>;

export function checkSetupFiles(options?: {
  cwd?: string | undefined;
  configPath?: string | undefined;
  expected?: string[] | undefined;
  loadConfigFromFile?: LoadConfigFromFile | undefined;
}): Promise<SetupFilesDiff>;

export function formatReport(diff: SetupFilesDiff, expected?: string[]): string;

export function defaultLoadConfigFromFile(
  configEnv: { command: 'build' | 'serve'; mode: string },
  configPath: string,
  cwd: string,
): Promise<{ config?: { test?: { setupFiles?: unknown } } } | null>;

export function main(options?: {
  loadConfigFromFile?: LoadConfigFromFile | undefined;
  log?: ((message: string) => void) | undefined;
}): Promise<number>;
