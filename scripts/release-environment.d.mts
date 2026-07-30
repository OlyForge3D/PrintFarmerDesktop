export function buildIsolatedEnvironment(
  source: NodeJS.ProcessEnv,
  allowedNames: readonly string[],
  platform?: NodeJS.Platform,
): NodeJS.ProcessEnv;

export function runIsolatedReleaseCommand(options: {
  command: string;
  args: string[];
  allowedNames: readonly string[];
  sourceEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<void>;
