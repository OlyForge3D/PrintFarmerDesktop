import type { NotarizeOptions } from '@electron/notarize';

export function notarizeMacRelease(options: {
  appPath: string;
  environment?: NodeJS.ProcessEnv;
  notarizeImplementation?: (options: NotarizeOptions) => Promise<void>;
  stapleImplementation?: (appPath: string) => Promise<void>;
}): Promise<void>;
