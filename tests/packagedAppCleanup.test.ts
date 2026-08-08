import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachPackagedFailureDiagnostics,
  cleanupPackagedApp,
  createPackagedFailureDiagnostics,
  createPackagedProcessLog,
  createPackagedStartupTrace,
  decodeBoundedUtf8Tail,
  FIRST_LAUNCH_TIMEOUT_MS,
  launchInstrumentedElectronTestApp,
  MAX_PROCESS_OUTPUT_BYTES,
  runWithPackagedTestCleanup,
  type PackagedApp,
  type PackagedFailureDiagnostics,
} from '../e2e/helpers/packagedApp.js';

describe('packaged test failure cleanup', () => {
  it('keeps the body failure primary while attaching logs and retaining cleanup errors', async () => {
    const events: string[] = [];
    const originalCause = new Error('original body cause');
    const primaryError = new Error('primary assertion failed', {
      cause: originalCause,
    });
    const primaryStack = primaryError.stack;
    const closeError = new Error('process close failed');
    const processLog = createPackagedProcessLog();
    processLog.append('packaged stderr');
    const app: Pick<PackagedApp, 'close'> = {
      close: vi.fn(() => {
        events.push('cleanup');
        return Promise.reject(closeError);
      }),
    };
    const observedDiagnostics: PackagedFailureDiagnostics[] = [];
    const attach = vi.fn((diagnostics: PackagedFailureDiagnostics) => {
      events.push('attach');
      observedDiagnostics.push(diagnostics);
      expect(processLog.read()).toBe('packaged stderr');
      return Promise.resolve();
    });

    const thrown = await captureError(
      runWithPackagedTestCleanup(
        () => {
          events.push('body');
          return Promise.reject(primaryError);
        },
        () => cleanupPackagedApp(app, []),
        attach,
      ),
    );

    expect(thrown).toBe(primaryError);
    expect(primaryError.stack).toBe(primaryStack);
    expect(events).toEqual(['body', 'cleanup', 'attach']);
    expect(attach).toHaveBeenCalledOnce();
    expect(errorCause(primaryError)).toBe(originalCause);
    expect(errorCause(originalCause)).toBe(closeError);
    expect(observedDiagnostics).toHaveLength(1);
    expect(observedDiagnostics[0]?.secondary).toEqual([
      expect.objectContaining({
        name: 'Error',
        message: 'process close failed',
      }),
    ]);
  });

  it('retains a diagnostic-attachment failure without replacing the body error', async () => {
    const primaryError = new Error('body failed');
    const attachmentError = new Error('attachment failed');
    const primaryStack = primaryError.stack;

    const thrown = await captureError(
      runWithPackagedTestCleanup(
        () => Promise.reject(primaryError),
        () => Promise.resolve(),
        () => Promise.reject(attachmentError),
      ),
    );

    expect(thrown).toBe(primaryError);
    expect(primaryError.stack).toBe(primaryStack);
    expect(errorCause(primaryError)).toBe(attachmentError);
  });

  it('makes cleanup-only underlying errors serializable and retains logs', async () => {
    const rootError = new Error('root deletion failed with EPERM');
    const cleanupError = new AggregateError(
      [rootError],
      'Packaged test cleanup failed.',
    );
    const cleanupStack = cleanupError.stack;
    const attach = vi.fn((diagnostics: PackagedFailureDiagnostics) => {
      expect(diagnostics.secondary).toEqual([
        expect.objectContaining({
          name: 'Error',
          message: 'root deletion failed with EPERM',
        }),
      ]);
      return Promise.resolve();
    });

    const thrown = await captureError(
      runWithPackagedTestCleanup(
        () => Promise.resolve(),
        () => Promise.reject(cleanupError),
        attach,
      ),
    );

    expect(thrown).toBe(cleanupError);
    expect(cleanupError.stack).toBe(cleanupStack);
    expect(errorCause(cleanupError)).toBe(rootError);
    expect(attach).toHaveBeenCalledOnce();
  });

  it('removes resources acquired before a post-mkdtemp setup failure', async () => {
    const primaryError = new Error('setup after mkdtemp failed');
    const close = vi.fn(() => Promise.resolve());
    let app: Pick<PackagedApp, 'close'> | null = null;
    let root: string | null = null;
    let attachedOutput = '';
    const processLog = createPackagedProcessLog();
    processLog.append('startup output');

    const thrown = await captureError(
      runWithPackagedTestCleanup(
        () => {
          root = mkdtempSync(path.join(tmpdir(), 'pf-cleanup-test-'));
          app = { close };
          return Promise.reject(primaryError);
        },
        () => cleanupPackagedApp(app, root === null ? [] : [root]),
        () => {
          attachedOutput = processLog.read();
          return Promise.resolve();
        },
      ),
    );

    expect(thrown).toBe(primaryError);
    expect(close).toHaveBeenCalledOnce();
    expect(root).not.toBeNull();
    if (root === null) {
      throw new Error('Expected a temp root to be acquired.');
    }
    expect(existsSync(root)).toBe(false);
    expect(attachedOutput).toBe('startup output');
  });

  it('cleans the app and root before retaining an EPERM diagnostic-enumeration failure', async () => {
    const primaryError = new Error('test body failed');
    const enumerationError = Object.assign(
      new Error('instance enumeration denied'),
      { code: 'EPERM' },
    );
    const close = vi.fn(() => Promise.resolve());
    const enumerateInstances = vi.fn(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(existsSync(root)).toBe(false);
      throw enumerationError;
    });
    const root = mkdtempSync(path.join(tmpdir(), 'pf-eperm-test-'));

    const thrown = await captureError(
      runWithPackagedTestCleanup(
        () => Promise.reject(primaryError),
        () =>
          cleanupPackagedApp({ close }, [root], () => {
            enumerateInstances();
          }),
      ),
    );

    expect(thrown).toBe(primaryError);
    expect(close).toHaveBeenCalledOnce();
    expect(existsSync(root)).toBe(false);
    expect(enumerateInstances).toHaveBeenCalledOnce();
    expect(errorCause(primaryError)).toBe(enumerationError);
  });

  it('decodes arbitrary-byte output in one bounded code-point pass', () => {
    const tail = Buffer.from('\nuseful-tail-Ω\n', 'utf8');
    const invalidBytes = Buffer.concat([
      Buffer.alloc(MAX_PROCESS_OUTPUT_BYTES - tail.length, 0xff),
      tail,
    ]);
    const invalid = decodeBoundedUtf8Tail(invalidBytes);
    expect(invalid.text).toMatch(/useful-tail-Ω\n$/);
    expect(invalid.outputBytes).toBe(Buffer.byteLength(invalid.text));
    expect(invalid.outputBytes).toBeLessThanOrEqual(MAX_PROCESS_OUTPUT_BYTES);
    expect(invalid.inspectedCodePoints).toBeLessThanOrEqual(invalid.inputBytes);

    const mixedPattern = Buffer.concat([
      Buffer.from('ascii-€-😀-invalid-', 'utf8'),
      Buffer.from([0xff]),
      Buffer.from('\n'),
    ]);
    const mixedBytes = Buffer.alloc(MAX_PROCESS_OUTPUT_BYTES);
    for (
      let offset = 0;
      offset < mixedBytes.length;
      offset += mixedPattern.length
    ) {
      mixedPattern.copy(mixedBytes, offset);
    }
    const mixed = decodeBoundedUtf8Tail(mixedBytes);
    expect(mixed.outputBytes).toBe(Buffer.byteLength(mixed.text));
    expect(mixed.outputBytes).toBeLessThanOrEqual(MAX_PROCESS_OUTPUT_BYTES);
    expect(mixed.inspectedCodePoints).toBeLessThanOrEqual(mixed.inputBytes);

    const processLog = createPackagedProcessLog();
    processLog.append(`discarded-${'x'.repeat(MAX_PROCESS_OUTPUT_BYTES)}`);
    processLog.append('retained-tail');

    expect(Buffer.byteLength(processLog.read())).toBeLessThanOrEqual(
      MAX_PROCESS_OUTPUT_BYTES,
    );
    expect(processLog.read()).toMatch(/retained-tail$/);
  });

  it('records timestamped spawn-to-DOM milestones and labeled process output', async () => {
    let now = Date.parse('2026-08-05T10:00:00.000Z');
    const processLog = createPackagedProcessLog();
    const startupTrace = createPackagedStartupTrace(() => now);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const waitForLoadState = vi.fn(() => {
      now += 11;
      return Promise.resolve();
    });
    const page = { waitForLoadState };
    const firstWindow = vi.fn(() => {
      stdout.write('main output\n');
      stderr.write('main error\n');
      now += 7;
      return Promise.resolve(page);
    });
    const close = vi.fn(() => Promise.resolve());

    const launched = await launchInstrumentedElectronTestApp(
      () => {
        now += 5;
        return Promise.resolve({
          process: () => ({ stdout, stderr }),
          firstWindow,
          close,
        });
      },
      processLog,
      startupTrace,
    );

    expect(launched.page).toBe(page);
    expect(waitForLoadState).toHaveBeenCalledWith('domcontentloaded', {
      timeout: FIRST_LAUNCH_TIMEOUT_MS,
    });
    expect(startupTrace.snapshot()).toEqual({
      startedAtUtc: '2026-08-05T10:00:00.000Z',
      elapsedMs: 23,
      waitingFor: null,
      milestones: [
        {
          name: 'spawn',
          timestampUtc: '2026-08-05T10:00:00.000Z',
          elapsedMs: 0,
        },
        {
          name: 'electronLaunch',
          timestampUtc: '2026-08-05T10:00:00.005Z',
          elapsedMs: 5,
        },
        {
          name: 'firstWindow',
          timestampUtc: '2026-08-05T10:00:00.012Z',
          elapsedMs: 12,
        },
        {
          name: 'domcontentloaded',
          timestampUtc: '2026-08-05T10:00:00.023Z',
          elapsedMs: 23,
        },
      ],
    });
    expect(processLog.read()).toContain('[stdout] main output');
    expect(processLog.read()).toContain('[stderr] main error');
  });

  it('reports firstWindow as the named startup failure phase', async () => {
    const processLog = createPackagedProcessLog();
    const startupTrace = createPackagedStartupTrace();
    const close = vi.fn(() => Promise.resolve());

    const thrown = await captureError(
      launchInstrumentedElectronTestApp(
        () =>
          Promise.resolve({
            process: () => ({
              stdout: new PassThrough(),
              stderr: new PassThrough(),
            }),
            firstWindow: () =>
              Promise.reject(new Error('controlled first-window timeout')),
            close,
          }),
        processLog,
        startupTrace,
      ),
    );

    expect(thrown).toEqual(
      expect.objectContaining({
        message:
          'Packaged Electron startup failed while waiting for firstWindow.',
      }),
    );
    expect(startupTrace.snapshot().waitingFor).toBe('firstWindow');
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports domcontentloaded as the named startup failure phase', async () => {
    const processLog = createPackagedProcessLog();
    const startupTrace = createPackagedStartupTrace();
    const close = vi.fn(() => Promise.resolve());

    const thrown = await captureError(
      launchInstrumentedElectronTestApp(
        () =>
          Promise.resolve({
            process: () => ({
              stdout: new PassThrough(),
              stderr: new PassThrough(),
            }),
            firstWindow: () =>
              Promise.resolve({
                waitForLoadState: () =>
                  Promise.reject(new Error('controlled DOM timeout')),
              }),
            close,
          }),
        processLog,
        startupTrace,
      ),
    );

    expect(thrown).toEqual(
      expect.objectContaining({
        message:
          'Packaged Electron startup failed while waiting for domcontentloaded.',
      }),
    );
    expect(startupTrace.snapshot().waitingFor).toBe('domcontentloaded');
    expect(close).toHaveBeenCalledOnce();
  });

  it('attaches the startup phase snapshot independently from process output', async () => {
    const attached = new Map<string, Buffer>();
    const attach = vi.fn(
      (
        name: string,
        options: { body: Buffer | string; contentType: string },
      ) => {
        attached.set(name, Buffer.from(options.body));
        return Promise.resolve();
      },
    );
    const trace = createPackagedStartupTrace(() =>
      Date.parse('2026-08-05T10:00:00.000Z'),
    );
    trace.mark('spawn');
    trace.waitFor('firstWindow');

    await attachPackagedFailureDiagnostics(
      { attach },
      '[stderr] controlled failure',
      createPackagedFailureDiagnostics(new Error('startup failed'), []),
      trace.snapshot(),
    );

    expect([...attached.keys()]).toEqual([
      'packaged-startup.json',
      'packaged-process.log',
    ]);
    expect(
      JSON.parse(attached.get('packaged-startup.json')!.toString('utf8')),
    ).toMatchObject({
      schemaVersion: 1,
      waitingFor: 'firstWindow',
      milestones: [{ name: 'spawn', elapsedMs: 0 }],
    });
    expect(attached.get('packaged-process.log')?.toString('utf8')).toBe(
      '[stderr] controlled failure',
    );
  });
});

describe('first-launch warm-up retry (#509)', () => {
  beforeEach(() => {
    // Each spec below depends on the module-level "has any packaged Electron
    // launch completed in this worker yet" flag starting false, so it must
    // get its own fresh module instance rather than share the one the
    // `describe` block above already advanced past its first launch.
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('propagates the retried attempt into the caller-held startupTrace, not the discarded failed first attempt', async () => {
    const {
      createPackagedProcessLog,
      createPackagedStartupTrace,
      launchInstrumentedElectronTestApp,
    } = await import('../e2e/helpers/packagedApp.js');
    const processLog = createPackagedProcessLog();
    const startupTrace = createPackagedStartupTrace();
    const close = vi.fn(() => Promise.resolve());
    let attempt = 0;

    const launched = await launchInstrumentedElectronTestApp(
      () => {
        attempt += 1;
        if (attempt === 1) {
          return Promise.reject(new Error('controlled cold-start failure'));
        }
        return Promise.resolve({
          process: () => ({
            stdout: new PassThrough(),
            stderr: new PassThrough(),
          }),
          firstWindow: () =>
            Promise.resolve({
              waitForLoadState: () => Promise.resolve(),
            }),
          close,
        });
      },
      processLog,
      startupTrace,
    );

    expect(attempt).toBe(2);
    expect(launched.app).not.toBeNull();

    // The SAME startupTrace object the caller passed in -- the one it would
    // later read via `.snapshot()` for e.g. failure diagnostics -- must
    // reflect the retry that actually produced this result, not the
    // discarded failed first attempt.
    const snapshot = startupTrace.snapshot();
    expect(snapshot.waitingFor).toBeNull();
    expect(snapshot.milestones.map((milestone) => milestone.name)).toEqual([
      'spawn',
      'electronLaunch',
      'firstWindow',
      'domcontentloaded',
    ]);
  });

  it('does not retry launches after the first in the same worker', async () => {
    const {
      createPackagedProcessLog,
      createPackagedStartupTrace,
      launchInstrumentedElectronTestApp,
    } = await import('../e2e/helpers/packagedApp.js');
    const processLog = createPackagedProcessLog();
    const close = vi.fn(() => Promise.resolve());
    const successfulLaunch = () =>
      Promise.resolve({
        process: () => ({
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }),
        firstWindow: () =>
          Promise.resolve({ waitForLoadState: () => Promise.resolve() }),
        close,
      });

    // Warm the "first launch already completed" flag for this module
    // instance so the second launch below is treated as steady-state.
    await launchInstrumentedElectronTestApp(
      successfulLaunch,
      processLog,
      createPackagedStartupTrace(),
    );

    let secondAttempt = 0;
    const thrown = await captureError(
      launchInstrumentedElectronTestApp(
        () => {
          secondAttempt += 1;
          return Promise.reject(new Error('controlled steady-state failure'));
        },
        processLog,
        createPackagedStartupTrace(),
      ),
    );

    expect(secondAttempt).toBe(1);
    expect(thrown).toEqual(
      expect.objectContaining({
        message:
          'Packaged Electron startup failed while waiting for electronLaunch.',
      }),
    );
  });
});

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to reject.');
}

function errorCause(error: Error): unknown {
  return (error as Error & { cause?: unknown }).cause;
}
