/**
 * Guards the startup rejection window on `retargetArtifacts.initialize()`.
 *
 * The promise is assigned to `retargetReady` and awaited inside three IPC
 * handlers, so its rejection *is* eventually handled — but only once the
 * renderer first retargets, which may be minutes after startup or never. Until
 * then Node sees a rejected promise with no handler attached and, depending on
 * `--unhandled-rejections`, terminates the main process. `initialize()` reaps
 * stale instance directories, so it rejects on ordinary filesystem contention:
 * it is the call that threw `EPERM: rmdir` and exited the #159 suite non-zero
 * while every test passed.
 *
 * Three claims, because closing the window is not the whole requirement:
 *   1. the process survives — no `unhandledRejection` is reported;
 *   2. the failure is observable — a record naming it is emitted;
 *   3. that record is caused by the rejection — it is absent when initialize
 *      resolves, so claim 2 cannot be satisfied by an unconditional log.
 *
 * Claim 1 is an absence, so it is worthless without the control below: an
 * `unhandledRejection` listener that never fires satisfies `toEqual([])` for
 * every reason, including being attached to the wrong event or in a mode where
 * Node does not report at all. The control rejects a promise with no handler in
 * the same harness and requires the listener to see it.
 *
 * @module retargetInitUnhandledRejection.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { captureCalibrationLogs } from '../src/main/calibrationLog.js';

const INIT_FAILURE = 'EPERM: operation not permitted, rmdir';

const electronState = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
};

/** Lets a single test flip `initialize()` between rejecting and resolving. */
const retargetState = { failInit: true };

vi.mock('electron', () => ({
  app: {
    getPath: () => '/test/userData',
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/test/userData',
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  },
  shell: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electronState.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      electronState.handlers.delete(channel);
    },
  },
  BrowserWindow: { fromWebContents: () => ({ id: 'window-stub' }) },
}));

vi.mock('../src/main/retargetArtifacts.js', () => ({
  RetargetArtifactService: class {
    initialize = () =>
      retargetState.failInit
        ? Promise.reject(new Error(INIT_FAILURE))
        : Promise.resolve();
    disposeAll = () => Promise.resolve();
    disposeOwner = () => Promise.resolve();
    disposeForOwner = () => Promise.resolve({ disposed: true });
    preflight = () => Promise.resolve({ status: 'canceled' });
    build = () => Promise.resolve({ status: 'canceled' });
    loadScene = () => Promise.resolve({ status: 'canceled' });
    saveAs = () => Promise.resolve({ status: 'canceled' });
  },
}));

/**
 * Collects `unhandledRejection` events raised while `run` executes, then drains
 * the microtask queue and one macrotask turn — Node reports at the end of the
 * turn in which the promise settles, so a synchronous assertion sees nothing
 * regardless of whether the defect is present.
 */
async function collectUnhandledRejections(
  run: () => void | Promise<void>,
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    seen.push(reason);
  };
  const existing = process.listeners('unhandledRejection');
  for (const listener of existing) {
    process.off('unhandledRejection', listener);
  }
  process.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    for (const listener of existing) {
      process.on(
        'unhandledRejection',
        listener as (...args: unknown[]) => void,
      );
    }
  }
  return seen;
}

describe('retargetArtifacts.initialize() startup rejection', () => {
  let capture: ReturnType<typeof captureCalibrationLogs>;

  beforeEach(() => {
    electronState.handlers.clear();
    retargetState.failInit = true;
  });

  afterEach(() => {
    capture?.stop();
    vi.resetModules();
  });

  /**
   * `vi.resetModules()` gives each test a fresh module registry, so the sink
   * must be installed on the same `calibrationLog` instance `ipc.ts` will
   * import. Capturing from a statically-imported copy silently observes a
   * different module and records nothing — which the non-empty assertions
   * below turn into a failure rather than a vacuous pass.
   */
  async function loadIpcWithCapture(): Promise<{
    registerIpcHandlers: (...args: unknown[]) => () => Promise<void>;
  }> {
    const log = await import('../src/main/calibrationLog.js');
    capture = log.captureCalibrationLogs();
    return (await import('../src/main/ipc.js')) as unknown as {
      registerIpcHandlers: (...args: unknown[]) => () => Promise<void>;
    };
  }

  it('reports an unhandled rejection when nothing attaches a handler', async () => {
    // CONTROL. Without this, the assertion below that the real code produces no
    // unhandled rejection is unfalsifiable: a listener that never fires passes
    // it for every reason, including reasons that have nothing to do with the
    // fix. This proves the harness observes the event it claims to observe.
    const seen = await collectUnhandledRejections(() => {
      void Promise.reject(new Error('control: nothing handles this'));
    });

    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain('control: nothing handles this');
  });

  it('survives a rejecting initialize and says so, without swallowing it', async () => {
    const { registerIpcHandlers } = await loadIpcWithCapture();

    let dispose: (() => Promise<void>) | undefined;
    const seen = await collectUnhandledRejections(() => {
      dispose = registerIpcHandlers();
    });

    // 1. The process survives: startup produced no unhandled rejection.
    expect(seen).toEqual([]);

    // 2. The failure is observable. Assert the captured set is non-empty before
    //    asserting anything about its contents — a capture that returns nothing
    //    satisfies every claim made about what it does not contain.
    const records = capture.records;
    expect(records.length).toBeGreaterThan(0);

    const failure = records.find(
      (record) =>
        record.event === 'retargetArtifacts.startupInitializationFailed',
    );
    expect(failure).toBeDefined();
    expect(failure?.level).toBe('error');
    expect(failure?.outcome).toBe('failed');

    expect(typeof dispose).toBe('function');
  });

  it('emits no such record when initialize succeeds', async () => {
    // CONTROL for the assertion above. Without it, "the failure is observable"
    // is satisfied by a record emitted unconditionally at startup, which would
    // survive deleting the rejection entirely. Same input path, one variable
    // changed: initialize resolves.
    retargetState.failInit = false;
    const { registerIpcHandlers } = await loadIpcWithCapture();

    const seen = await collectUnhandledRejections(() => {
      registerIpcHandlers();
    });
    expect(seen).toEqual([]);

    // The capture is live and other startup records land in it, so a zero here
    // is a statement about this event rather than about an empty sink.
    expect(capture.records.length).toBeGreaterThan(0);
    expect(
      capture.records.filter(
        (record) =>
          record.event === 'retargetArtifacts.startupInitializationFailed',
      ),
    ).toEqual([]);
  });
});

/*
 * Not asserted here, deliberately, and it is a finding rather than a gap.
 *
 * `retarget:listProfiles` is the channel that awaits `retargetReady`, so the
 * obvious third claim — that handling the rejection at the creation site does
 * not swallow it — looks testable through its response. It is not. Measured at
 * `c7bd1f6` with `initialize()` rejecting and resolving, and again with a stub
 * retarget sidecar injected, the handler returns a byte-identical envelope in
 * both conditions:
 *
 *   { status: 'error', error: { code: 'sidecarUnavailable', … } }
 *
 * because its `catch` maps every error — the startup reap failure, a profile
 * refresh failure, an absent sidecar — onto one outcome. Any assertion written
 * against that envelope passes whether or not the rejection was swallowed, so
 * it would be an assertion that cannot fail.
 *
 * The lossy envelope is itself worth reporting: an operator who sees
 * `sidecarUnavailable` cannot tell a failed temp-root reap from a sidecar that
 * genuinely is not there, and those have different recovery steps.
 *
 * The gap is measured, not asserted. Two mutations, both swallowing:
 *
 *   M-4   `initialize().catch(() => undefined)`            exit 1, RED
 *   M-4b  log identically, then swallow for awaiters       exit 0, SURVIVED
 *
 * M-4 is red for the wrong reason — it removes the rejection, so no record is
 * emitted and the observability assertion fires. It changes two things and
 * would read as coverage of the awaiter claim. M-4b changes only the one, and
 * it survives: nothing here can distinguish preserved from swallowed.
 */
