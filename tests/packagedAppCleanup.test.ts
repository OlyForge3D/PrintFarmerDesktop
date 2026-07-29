import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanupPackagedApp,
  createPackagedProcessLog,
  runWithPackagedTestCleanup,
  suppressedErrors,
  type PackagedApp,
} from '../e2e/helpers/packagedApp.js';

describe('packaged test failure cleanup', () => {
  it('keeps the body failure primary while attaching logs and retaining cleanup errors', async () => {
    const events: string[] = [];
    const primaryError = new Error('primary assertion failed');
    const closeError = new Error('process close failed');
    const processLog = createPackagedProcessLog();
    processLog.append('packaged stderr');
    const app: Pick<PackagedApp, 'close'> = {
      close: vi.fn(() => {
        events.push('cleanup');
        return Promise.reject(closeError);
      }),
    };
    const attach = vi.fn((error: unknown) => {
      events.push('attach');
      expect(error).toBe(primaryError);
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
    expect(events).toEqual(['body', 'cleanup', 'attach']);
    expect(attach).toHaveBeenCalledOnce();
    const secondary = suppressedErrors(thrown);
    expect(secondary).toHaveLength(1);
    const cleanupFailure = secondary[0];
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    if (!(cleanupFailure instanceof AggregateError)) {
      throw new Error('Expected an aggregate cleanup failure.');
    }
    expect(cleanupFailure.errors).toEqual([closeError]);
    expect(primaryError.stack).toContain('Suppressed secondary failures');
  });

  it('retains log-attachment and cleanup failures without replacing the body error', async () => {
    const primaryError = new Error('body failed');
    const cleanupError = new Error('cleanup failed');
    const attachmentError = new Error('attachment failed');

    const thrown = await captureError(
      runWithPackagedTestCleanup(
        () => Promise.reject(primaryError),
        () => Promise.reject(cleanupError),
        () => Promise.reject(attachmentError),
      ),
    );

    expect(thrown).toBe(primaryError);
    expect(suppressedErrors(thrown)).toEqual([cleanupError, attachmentError]);
  });

  it('retains logs when cleanup is the only failure', async () => {
    const cleanupError = new Error('cleanup failed');
    const attach = vi.fn((error: unknown) => {
      expect(error).toBe(cleanupError);
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
    const secondary = suppressedErrors(thrown);
    expect(secondary).toHaveLength(1);
    const cleanupFailure = secondary[0];
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    if (!(cleanupFailure instanceof AggregateError)) {
      throw new Error('Expected an aggregate cleanup failure.');
    }
    expect(cleanupFailure.errors).toEqual([enumerationError]);
  });

  it('bounds retained process output to one MiB', () => {
    const processLog = createPackagedProcessLog();
    processLog.append(`discarded-${'x'.repeat(1024 * 1024)}`);
    processLog.append('retained-tail');

    expect(Buffer.byteLength(processLog.read())).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(processLog.read()).toMatch(/retained-tail$/);

    const splitUtf8Log = createPackagedProcessLog();
    splitUtf8Log.append(
      Buffer.concat([Buffer.from('€'), Buffer.alloc(1024 * 1024 - 1, 'x')]),
    );
    expect(Buffer.byteLength(splitUtf8Log.read())).toBeLessThanOrEqual(
      1024 * 1024,
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
