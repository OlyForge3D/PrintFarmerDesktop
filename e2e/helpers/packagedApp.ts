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
}

export interface PackagedApp {
  page: Page;
  processOutput(): string;
  close(): Promise<void>;
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
  app: PackagedApp | null,
  directories: readonly string[],
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
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Packaged test cleanup failed.');
  }
}

export async function launchPackagedApp(
  options: LaunchPackagedAppOptions,
): Promise<PackagedApp> {
  const port = await allocateLoopbackPort();
  const gpuMode = options.gpuMode ?? 'default';
  const child = spawn(
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
  let output = '';
  let spawnError: Error | null = null;
  const appendOutput = (bytes: Buffer): void => {
    output = `${output}${bytes.toString()}`.slice(-MAX_PROCESS_OUTPUT_BYTES);
  };
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  child.once('error', (error) => {
    spawnError = error;
  });

  let browser: Browser | null = null;
  let page: Page | null = null;
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= closeHandles(page, browser, child);
    return closePromise;
  };

  try {
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForDebugEndpoint(
      endpoint,
      child,
      () => spawnError,
      () => output,
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
      processOutput: () => output,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Packaged app launch failed and cleanup was incomplete.',
      );
    }
    throw error;
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
