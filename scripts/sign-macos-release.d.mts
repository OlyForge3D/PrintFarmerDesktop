import type { SignOptions } from '@electron/osx-sign';

export function signMacRelease(options: {
  appPath: string;
  sidecarPath: string;
  environment?: NodeJS.ProcessEnv;
  runCommandImplementation?: (command: string, args: string[]) => Promise<void>;
  signAppImplementation?: (options: SignOptions) => Promise<void>;
}): Promise<void>;
