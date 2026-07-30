import type { SignOptions, SignToolOptions } from '@electron/windows-sign';
import type { SquirrelWindowsOptions } from 'electron-winstaller';

export const WINDOWS_TIMESTAMP_SERVER: string;
export function windowsSignOptions(
  environment?: NodeJS.ProcessEnv,
): SignToolOptions;
export function signWindowsRelease(options: {
  appDirectory: string;
  outputDirectory: string;
  environment?: NodeJS.ProcessEnv;
  signImplementation?: (options: SignOptions) => Promise<void>;
  createInstallerImplementation?: (
    options: SquirrelWindowsOptions,
  ) => Promise<void>;
}): Promise<void>;
