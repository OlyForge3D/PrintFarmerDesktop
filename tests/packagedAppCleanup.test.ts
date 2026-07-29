import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupPackagedApp,
  createPackagedProcessLog,
  decodeBoundedUtf8Tail,
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
