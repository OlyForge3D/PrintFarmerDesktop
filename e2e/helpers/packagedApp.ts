import { chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';

const STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

export type PackagedGpuMode = 'default' | 'swiftshader';

export interface LaunchPackagedAppOptions {
  executablePath: string;
  userDataPath: string;
  catalogDb: string;
  environment?: NodeJS.ProcessEnv;
  gpuMode?: PackagedGpuMode;
  processLog?: PackagedProcessLog;
}

export interface PackagedApp {
  page: Page;
  processOutput(): string;
  close(): Promise<void>;
}

export interface PackagedProcessLog {
  append(chunk: string | Uint8Array): void;
  read(): string;
}

type TestOutcome<T> =
  | {
      status: 'fulfilled';
      value: T;
    }
  | {
      status: 'rejected';
      reason: unknown;
    };

export function createPackagedProcessLog(): PackagedProcessLog {
  let output = Buffer.alloc(0);

  return {
    append(chunk) {
      const incoming = Buffer.from(chunk);
      if (incoming.length >= MAX_PROCESS_OUTPUT_BYTES) {
        output = incoming.subarray(incoming.length - MAX_PROCESS_OUTPUT_BYTES);
        return;
      }

      const retainedBytes = Math.min(
        output.length,
        MAX_PROCESS_OUTPUT_BYTES - incoming.length,
      );
      output = Buffer.concat([
        output.subarray(output.length - retainedBytes),
        incoming,
      ]);
    },
    read() {
      let decoded = output.toString('utf8');
      while (Buffer.byteLength(decoded) > MAX_PROCESS_OUTPUT_BYTES) {
        decoded = decoded.slice(1);
      }
      return decoded;
    },
  };
}

export function suppressedErrors(error: unknown): readonly unknown[] {
  if (!(error instanceof Error)) {
    return [];
  }

  const suppressed = (error as Error & { suppressed?: unknown }).suppressed;
  return suppressed instanceof AggregateError
    ? Array.from(suppressed.errors)
    : [];
}

function withSuppressedErrors(
  primaryError: unknown,
  secondaryErrors: readonly unknown[],
): unknown {
  if (secondaryErrors.length === 0) {
    return primaryError;
  }

  const reportableError =
    primaryError instanceof Error && Object.isExtensible(primaryError)
      ? primaryError
      : new Error(
          primaryError instanceof Error
            ? primaryError.message
            : String(primaryError),
          { cause: primaryError },
        );
  const aggregate = new AggregateError(
    [...suppressedErrors(reportableError), ...secondaryErrors],
    'Secondary packaged-test diagnostics or cleanup failures',
  );

  Object.defineProperty(reportableError, 'suppressed', {
    configurable: true,
    enumerable: true,
    value: aggregate,
  });
  const primaryStack =
    reportableError.stack ??
    `${reportableError.name}: ${reportableError.message}`;
  const secondaryStacks = Array.from(aggregate.errors, (error) =>
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error),
  ).join('\n\n');
  reportableError.stack = `${primaryStack}\n\nSuppressed secondary failures:\n${secondaryStacks}`;

  return reportableError;
}

export async function runWithPackagedTestCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>,
  onFailure?: (error: unknown) => Promise<void>,
): Promise<T> {
  let outcome: TestOutcome<T> | undefined;
  const secondaryErrors: unknown[] = [];

  try {
    outcome = {
      status: 'fulfilled',
      value: await body(),
    };
  } catch (error) {
    outcome = {
      status: 'rejected',
      reason: error,
    };
  } finally {
    try {
      await cleanup();
    } catch (error) {
      secondaryErrors.push(error);
    }
  }

  if (outcome === undefined) {
    throw new Error('Packaged test completed without recording an outcome.');
  }

  if (outcome.status === 'fulfilled') {
    if (secondaryErrors.length === 0) {
      return outcome.value;
    }

    const cleanupFailure =
      secondaryErrors.length === 1
        ? secondaryErrors[0]
        : new AggregateError(secondaryErrors, 'Packaged test cleanup failed.');
    const diagnosticErrors: unknown[] = [];
    if (onFailure !== undefined) {
      try {
        await onFailure(cleanupFailure);
      } catch (error) {
        diagnosticErrors.push(error);
      }
    }
    throw withSuppressedErrors(cleanupFailure, diagnosticErrors);
  }

  if (onFailure !== undefined) {
    try {
      await onFailure(outcome.reason);
    } catch (error) {
      secondaryErrors.push(error);
    }
  }

  throw withSuppressedErrors(outcome.reason, secondaryErrors);
}

export function packagedGpuModeFromEnvironment(): PackagedGpuMode {
  const value = process.env.PRINTFARMER_E2E_GPU_MODE ?? 'default';
  if (value === 'default' || value === 'swiftshader') {
    return value;
  }
  throw new Error(
    `Unsupported PRINTFARMER_E2E_GPU_MODE "${value}". Expected default or swiftshader.`,
  );
}

export function removePackagedAppTempRoot(directory: string): void {
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 200,
  });
}

export async function cleanupPackagedApp(
  app: Pick<PackagedApp, 'close'> | null,
  directories: readonly string[],
  afterCoreCleanup?: () => Promise<void> | void,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await app?.close();
  } catch (error) {
    errors.push(error);
  }
  for (const directory of directories) {
    try {
      removePackagedAppTempRoot(directory);
    } catch (error) {
      errors.push(error);
    }
  }
  if (afterCoreCleanup !== undefined) {
    try {
      await afterCoreCleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Packaged test cleanup failed.');
  }
}

export async function launchPackagedApp(
  options: LaunchPackagedAppOptions,
): Promise<PackagedApp> {
  const gpuMode = options.gpuMode ?? 'default';
  const processLog = options.processLog ?? createPackagedProcessLog();
  let child: ChildProcess | null = null;
  let spawnError: Error | null = null;
  const appendOutput = (bytes: Buffer): void => {
    processLog.append(bytes);
  };

  let browser: Browser | null = null;
  let page: Page | null = null;
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    const activeChild = child;
    if (activeChild === null) {
      return Promise.resolve();
    }
    closePromise ??= closeHandles(page, browser, activeChild);
    return closePromise;
  };

  try {
    const port = await allocateLoopbackPort();
    child = spawn(
      options.executablePath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${options.userDataPath}`,
        ...gpuArguments(gpuMode),
      ],
      {
        env: {
          ...process.env,
          PRINTFARMER_CATALOG_DB: options.catalogDb,
          ...options.environment,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);
    child.once('error', (error) => {
      spawnError = error;
    });

    const endpoint = `http://127.0.0.1:${port}`;
    await waitForDebugEndpoint(
      endpoint,
      child,
      () => spawnError,
      () => processLog.read(),
    );
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('Packaged app did not expose a browser context.');
    }
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    page = context.pages()[0] ?? null;
    while (!page && Date.now() < deadline) {
      await delay(100);
      page = context.pages()[0] ?? null;
    }
    if (!page) {
      throw new Error('Packaged app did not create a BrowserWindow.');
    }
    await page.waitForLoadState('domcontentloaded');
    return {
      page,
      processOutput: () => processLog.read(),
      close,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    throw withSuppressedErrors(error, cleanupErrors);
  }
}

function gpuArguments(mode: PackagedGpuMode): string[] {
  if (mode === 'default') {
    return [];
  }
  return [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ];
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a debugging port.'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForDebugEndpoint(
  endpoint: string,
  child: ChildProcess,
  getSpawnError: () => Error | null,
  getOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) {
      throw new Error(
        `Packaged app could not start: ${spawnError.message}\n${getOutput()}`,
        { cause: spawnError },
      );
    }
    if (hasExited(child)) {
      throw new Error(
        `Packaged app exited with ${child.exitCode ?? child.signalCode} before CDP was ready.\n${getOutput()}`,
      );
    }
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      await response.arrayBuffer();
      if (response.ok) {
        return;
      }
    } catch {
      // The packaged process is still starting.
    }
    await delay(100);
  }
  throw new Error(
    `Packaged app did not expose CDP within ${STARTUP_TIMEOUT_MS} ms.\n${getOutput()}`,
  );
}

async function closeHandles(
  page: Page | null,
  browser: Browser | null,
  child: ChildProcess,
): Promise<void> {
  const errors: unknown[] = [];
  if (page && !page.isClosed()) {
    try {
      await page.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (process.platform !== 'darwin') {
    await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
  }
  if (browser?.isConnected()) {
    try {
      await browser.close();
    } catch (error) {
      errors.push(error);
    }
  }
  await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
  try {
    await terminateChild(child);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Packaged app cleanup failed.');
  }
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) {
    return;
  }
  if (!child.kill()) {
    throw new Error(`Could not terminate packaged app process ${child.pid}.`);
  }
  if (await waitForExit(child, SHUTDOWN_TIMEOUT_MS)) {
    return;
  }
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    if (await waitForExit(child, SHUTDOWN_TIMEOUT_MS)) {
      return;
    }
  }
  throw new Error(
    `Packaged app process ${child.pid} did not exit within ${SHUTDOWN_TIMEOUT_MS} ms.`,
  );
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited(child)) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
