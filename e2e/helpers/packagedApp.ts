import {
  chromium,
  type Browser,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';

const STARTUP_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 8_000;
export const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

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

export interface PackagedProcessLogDecode {
  text: string;
  inputBytes: number;
  inspectedCodePoints: number;
  outputBytes: number;
}

export interface PackagedErrorDiagnostic {
  name: string;
  message: string;
  stack?: string;
}

export interface PackagedFailureDiagnostics {
  primary: PackagedErrorDiagnostic;
  secondary: readonly PackagedErrorDiagnostic[];
}

export type PackagedStartupPhase =
  'electronLaunch' | 'firstWindow' | 'domcontentloaded';

export interface PackagedStartupMilestone {
  name: 'spawn' | PackagedStartupPhase;
  timestampUtc: string;
  elapsedMs: number;
}

export interface PackagedStartupSnapshot {
  startedAtUtc: string;
  elapsedMs: number;
  waitingFor: PackagedStartupPhase | null;
  milestones: readonly PackagedStartupMilestone[];
}

export interface PackagedStartupTrace {
  mark(name: 'spawn' | PackagedStartupPhase): void;
  waitFor(phase: PackagedStartupPhase): void;
  snapshot(): PackagedStartupSnapshot;
}

interface ElectronTestAppLike<TPage> {
  process(): Pick<ChildProcess, 'stdout' | 'stderr'>;
  firstWindow(): Promise<TPage>;
  close(): Promise<void>;
}

interface ElectronTestPageLike {
  waitForLoadState(state: 'domcontentloaded'): Promise<unknown>;
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

export function decodeBoundedUtf8Tail(
  bytes: Uint8Array,
  maxBytes = MAX_PROCESS_OUTPUT_BYTES,
): PackagedProcessLogDecode {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('The process output byte limit must be non-negative.');
  }

  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const decoded = input.toString('utf8');
  let start = decoded.length;
  let inspectedCodePoints = 0;
  let outputBytes = 0;

  // Account for each trailing code point once instead of repeatedly re-encoding
  // progressively sliced strings when invalid bytes expand to replacement text.
  while (start > 0) {
    inspectedCodePoints += 1;
    const trailing = decoded.charCodeAt(start - 1);
    let codePointStart = start - 1;
    let codePointBytes: number;
    if (trailing >= 0xdc00 && trailing <= 0xdfff && codePointStart > 0) {
      const leading = decoded.charCodeAt(codePointStart - 1);
      if (leading >= 0xd800 && leading <= 0xdbff) {
        codePointStart -= 1;
        codePointBytes = 4;
      } else {
        codePointBytes = 3;
      }
    } else if (trailing <= 0x7f) {
      codePointBytes = 1;
    } else if (trailing <= 0x7ff) {
      codePointBytes = 2;
    } else {
      codePointBytes = 3;
    }

    if (outputBytes + codePointBytes > maxBytes) {
      break;
    }
    outputBytes += codePointBytes;
    start = codePointStart;
  }

  return {
    text: decoded.slice(start),
    inputBytes: input.length,
    inspectedCodePoints,
    outputBytes,
  };
}

export function createPackagedProcessLog(): PackagedProcessLog {
  let output = Buffer.alloc(0);

  return {
    append(chunk) {
      const incoming = Buffer.from(chunk);
      if (incoming.length >= MAX_PROCESS_OUTPUT_BYTES) {
        output = Buffer.from(
          incoming.subarray(incoming.length - MAX_PROCESS_OUTPUT_BYTES),
        );
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
      return decodeBoundedUtf8Tail(output).text;
    },
  };
}

export function createPackagedStartupTrace(
  now: () => number = Date.now,
): PackagedStartupTrace {
  const startedAt = now();
  const milestones: PackagedStartupMilestone[] = [];
  let waitingFor: PackagedStartupPhase | null = null;

  return {
    mark(name) {
      const timestamp = now();
      milestones.push({
        name,
        timestampUtc: new Date(timestamp).toISOString(),
        elapsedMs: timestamp - startedAt,
      });
      if (name === waitingFor) {
        waitingFor = null;
      }
    },
    waitFor(phase) {
      waitingFor = phase;
    },
    snapshot() {
      return {
        startedAtUtc: new Date(startedAt).toISOString(),
        elapsedMs: now() - startedAt,
        waitingFor,
        milestones: milestones.map((milestone) => ({ ...milestone })),
      };
    },
  };
}

export async function launchInstrumentedElectronTestApp<
  TPage extends ElectronTestPageLike,
  TApp extends ElectronTestAppLike<TPage>,
>(
  launch: () => Promise<TApp>,
  processLog: PackagedProcessLog,
  startupTrace: PackagedStartupTrace,
): Promise<{ app: TApp; page: TPage }> {
  let app: TApp | null = null;
  let phase: PackagedStartupPhase = 'electronLaunch';
  startupTrace.mark('spawn');
  startupTrace.waitFor(phase);

  try {
    app = await launch();
    startupTrace.mark(phase);
    const child = app.process();
    captureProcessStream(child.stdout, 'stdout', processLog);
    captureProcessStream(child.stderr, 'stderr', processLog);

    phase = 'firstWindow';
    startupTrace.waitFor(phase);
    const page = await app.firstWindow();
    startupTrace.mark(phase);

    phase = 'domcontentloaded';
    startupTrace.waitFor(phase);
    await page.waitForLoadState('domcontentloaded');
    startupTrace.mark(phase);
    return { app, page };
  } catch (cause) {
    const startupError = new Error(
      `Packaged Electron startup failed while waiting for ${phase}.`,
      { cause },
    );
    if (app === null) {
      throw startupError;
    }
    try {
      await app.close();
    } catch (closeError) {
      throw new AggregateError(
        [startupError, closeError],
        startupError.message,
        { cause: startupError },
      );
    }
    throw startupError;
  }
}

function captureProcessStream(
  stream: NodeJS.ReadableStream | null,
  name: 'stdout' | 'stderr',
  processLog: PackagedProcessLog,
): void {
  stream?.on('data', (chunk: string | Uint8Array) => {
    processLog.append(`[${name}] `);
    processLog.append(chunk);
  });
}

function withSerializableCauses(
  primaryError: unknown,
  secondaryErrors: readonly unknown[],
): unknown {
  const reportableError =
    primaryError instanceof Error
      ? primaryError
      : new Error(String(primaryError));
  const ownAggregateErrors =
    primaryError instanceof AggregateError ? aggregateErrors(primaryError) : [];
  appendSerializableCauses(reportableError, [
    ...ownAggregateErrors,
    ...secondaryErrors,
  ]);

  return reportableError;
}

function appendSerializableCauses(
  primaryError: Error,
  errors: readonly unknown[],
): void {
  // Playwright 1.61 serializes Error.cause, but drops AggregateError.errors
  // and custom error fields, so append flattened failures to the existing chain.
  const existingChain = new Set<Error>();
  let tail: Error = primaryError;
  while (true) {
    if (existingChain.has(tail)) {
      return;
    }
    existingChain.add(tail);
    const cause = errorCause(tail);
    if (cause === undefined) {
      break;
    }
    if (!(cause instanceof Error)) {
      return;
    }
    tail = cause;
  }

  for (const error of flattenErrors(errors)) {
    const candidate =
      error instanceof Error
        ? error
        : new Error(`Non-Error failure: ${String(error)}`);
    const candidateTail = causeChainTail(candidate, existingChain);
    if (candidateTail === null) {
      continue;
    }
    if (!setErrorCause(tail, candidate)) {
      return;
    }
    for (let current: Error | undefined = candidate; current !== undefined;) {
      existingChain.add(current);
      const cause = errorCause(current);
      current = cause instanceof Error ? cause : undefined;
    }
    tail = candidateTail;
  }
}

function causeChainTail(
  error: Error,
  disallowed: ReadonlySet<Error>,
): Error | null {
  const visited = new Set<Error>();
  let tail = error;
  while (true) {
    if (visited.has(tail) || disallowed.has(tail)) {
      return null;
    }
    visited.add(tail);
    const cause = errorCause(tail);
    if (cause === undefined) {
      return tail;
    }
    if (!(cause instanceof Error)) {
      return null;
    }
    tail = cause;
  }
}

function errorCause(error: Error): unknown {
  return (error as Error & { cause?: unknown }).cause;
}

function setErrorCause(error: Error, cause: Error): boolean {
  try {
    Object.defineProperty(error, 'cause', {
      configurable: true,
      value: cause,
      writable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function flattenErrors(errors: readonly unknown[]): unknown[] {
  const flattened: unknown[] = [];
  const visited = new Set<unknown>();
  const visit = (error: unknown): void => {
    if (visited.has(error)) {
      return;
    }
    visited.add(error);
    if (error instanceof AggregateError) {
      const nested = aggregateErrors(error);
      if (nested.length === 0) {
        flattened.push(error);
      } else {
        for (const nestedError of nested) {
          visit(nestedError);
        }
      }
      return;
    }
    flattened.push(error);
  };
  for (const error of errors) {
    visit(error);
  }
  return flattened;
}

function aggregateErrors(error: AggregateError): readonly unknown[] {
  return error.errors as readonly unknown[];
}

function describeError(error: unknown): PackagedErrorDiagnostic {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  return {
    name: typeof error,
    message: String(error),
  };
}

export function createPackagedFailureDiagnostics(
  primaryError: unknown,
  secondaryErrors: readonly unknown[],
): PackagedFailureDiagnostics {
  const ownAggregateErrors =
    primaryError instanceof AggregateError ? aggregateErrors(primaryError) : [];
  return {
    primary: describeError(primaryError),
    secondary: flattenErrors([...ownAggregateErrors, ...secondaryErrors]).map(
      describeError,
    ),
  };
}

export async function attachPackagedFailureDiagnostics(
  testInfo: Pick<TestInfo, 'attach'>,
  processOutput: string,
  diagnostics: PackagedFailureDiagnostics,
  startup?: PackagedStartupSnapshot,
): Promise<void> {
  const attachmentErrors: unknown[] = [];
  if (startup !== undefined) {
    try {
      await testInfo.attach('packaged-startup.json', {
        body: Buffer.from(
          JSON.stringify({ schemaVersion: 1, ...startup }, null, 2),
          'utf8',
        ),
        contentType: 'application/json',
      });
    } catch (error) {
      attachmentErrors.push(error);
    }
  }
  if (diagnostics.secondary.length > 0) {
    try {
      await testInfo.attach('packaged-secondary-errors.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              schemaVersion: 1,
              primary: diagnostics.primary,
              secondary: diagnostics.secondary,
            },
            null,
            2,
          ),
          'utf8',
        ),
        contentType: 'application/json',
      });
    } catch (error) {
      attachmentErrors.push(error);
    }
  }
  try {
    await testInfo.attach('packaged-process.log', {
      body: Buffer.from(processOutput, 'utf8'),
      contentType: 'text/plain',
    });
  } catch (error) {
    attachmentErrors.push(error);
  }
  if (attachmentErrors.length > 0) {
    throw new AggregateError(
      attachmentErrors,
      'Packaged failure diagnostic attachment failed.',
    );
  }
}

export async function runWithPackagedTestCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>,
  onFailure?: (diagnostics: PackagedFailureDiagnostics) => Promise<void>,
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
        await onFailure(createPackagedFailureDiagnostics(cleanupFailure, []));
      } catch (error) {
        diagnosticErrors.push(error);
      }
    }
    throw withSerializableCauses(cleanupFailure, diagnosticErrors);
  }

  if (onFailure !== undefined) {
    try {
      await onFailure(
        createPackagedFailureDiagnostics(outcome.reason, secondaryErrors),
      );
    } catch (error) {
      secondaryErrors.push(error);
    }
  }

  throw withSerializableCauses(outcome.reason, secondaryErrors);
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
    throw withSerializableCauses(error, cleanupErrors);
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
