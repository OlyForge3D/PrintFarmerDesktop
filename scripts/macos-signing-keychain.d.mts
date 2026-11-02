export function withMacSigningKeychain(options: {
  command: string;
  args: string[];
  environment?: NodeJS.ProcessEnv;
  runProcessImplementation?: (
    command: string,
    args: string[],
    options: {
      environment: NodeJS.ProcessEnv;
      captureOutput?: boolean;
      cancellationSignal?: AbortSignal;
    },
  ) => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
  }>;
  temporaryDirectory?: string;
}): Promise<void>;
