export interface SafeForcePushOptions {
  remote: string;
  branch: string | null;
  yes: boolean;
  foreign: string | null;
}

export function parseArgs(argv: string[]): SafeForcePushOptions;
