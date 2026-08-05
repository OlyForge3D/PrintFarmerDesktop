// @vitest-environment node

/**
 * Guards the rejection paths of the two `shell.openExternal()` calls in
 * `hardenWindow`.
 *
 * Both were `void shell.openExternal(url)`. `void` satisfies
 * `@typescript-eslint/no-floating-promises` — the rule offers it in the same
 * sentence as `.catch` and `.then` with a rejection handler, as though the four
 * remedies were interchangeable. Three attach a handler; `void` suppresses the
 * diagnostic and changes nothing at runtime. Lint was green on both sites for
 * exactly that reason, so lint cannot be the regression guard here and these
 * tests exist instead.
 *
 * `openExternal` rejects on ordinary conditions — no registered handler for the
 * scheme, or the platform opener returning non-zero. There is no
 * `process.on('unhandledRejection')` anywhere in `src/`, so under Node's default
 * `--unhandled-rejections=throw` such a rejection raises an uncaught exception
 * in the main process.
 *
 * Four claims, because closing the window is not the whole requirement:
 *   1. the process survives — no `unhandledRejection` is reported;
 *   2. the failure is observable — a record naming it is emitted;
 *   3. that record is caused by the rejection — it is absent when
 *      `openExternal` resolves, so claim 2 cannot be satisfied by an
 *      unconditional log;
 *   4. the guard is still a guard — the URL is still not navigated to
 *      internally and the popup is still denied, so a `.catch` cannot be
 *      "passing" by having disabled the surface it protects.
 *
 * Claim 1 is an absence and is worthless without a control: a listener that
 * never fires satisfies `toEqual([])` for every reason, including being
 * attached to the wrong event or running in a mode where Node does not report.
 * `collectUnhandledRejections` is therefore exercised against a bare rejected
 * promise in the same harness, and is required to see it.
 *
 * @module security.openExternalRejection.test
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  openedExternally: [] as string[],
  /** When set, `openExternal` rejects with this instead of resolving. */
  failWith: null as Error | null,
}));

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => true,
  },
  shell: {
    openExternal: (url: string) => {
      electronState.openedExternally.push(url);
      return electronState.failWith
        ? Promise.reject(electronState.failWith)
        : Promise.resolve();
    },
  },
}));

const { hardenWindow } = await import('../src/main/security.js');

type Listener = (...args: unknown[]) => unknown;

function fakeWindow() {
  const listeners = new Map<string, Listener>();
  let windowOpenHandler: ((details: { url: string }) => unknown) | null = null;

  return {
    listeners,
    get windowOpenHandler() {
      return windowOpenHandler;
    },
    webContents: {
      on: (event: string, listener: Listener) => {
        listeners.set(event, listener);
      },
      setWindowOpenHandler: (
        handler: (details: { url: string }) => unknown,
      ) => {
        windowOpenHandler = handler;
      },
      session: {
        setPermissionRequestHandler: () => undefined,
      },
    },
  };
}

/** Invoke the registered `will-navigate` listener and report what it did. */
function navigate(window: ReturnType<typeof fakeWindow>, url: string) {
  let prevented = false;
  const listener = window.listeners.get('will-navigate');
  if (!listener) throw new Error('no will-navigate listener registered');
  listener({ preventDefault: () => (prevented = true) }, url);
  return { prevented };
}

/**
 * Collects `unhandledRejection` events raised while `run` executes, then drains
 * the microtask queue and one macrotask turn — Node reports at the end of the
 * turn in which the promise settles, so a synchronous assertion sees nothing
 * regardless of whether the defect is present.
 *
 * Pre-existing listeners are detached for the duration and restored afterwards:
 * Vitest installs its own, and leaving it attached means it, not this function,
 * decides what an unhandled rejection does to the run.
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

beforeEach(() => {
  electronState.openedExternally = [];
  electronState.failWith = null;
  delete process.env['ELECTRON_RENDERER_URL'];
});

describe('collectUnhandledRejections', () => {
  /**
   * The control for every `toEqual([])` below. Without it those assertions pass
   * whether or not the handlers exist, because a listener that is never invoked
   * and a listener that has nothing to report produce the same empty array.
   */
  it('reports a rejected promise that has no handler', async () => {
    const marker = new Error('deliberate: control rejection');
    const seen = await collectUnhandledRejections(() => {
      void Promise.reject(marker);
    });

    expect(seen).toEqual([marker]);
  });
});

describe('hardenWindow openExternal rejection', () => {
  it('does not leave an unhandled rejection when will-navigate delegation fails', async () => {
    electronState.failWith = new Error('deliberate: no handler for scheme');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const window = fakeWindow();
    hardenWindow(window as never);

    const seen = await collectUnhandledRejections(() => {
      navigate(window, 'https://example.com/');
    });

    expect(seen).toEqual([]);
    // Claim 2: the failure is reported rather than discarded.
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]?.[1]).toBe(electronState.failWith);
    errors.mockRestore();
  });

  it('does not leave an unhandled rejection when a denied popup fails to open', async () => {
    electronState.failWith = new Error('deliberate: opener exited non-zero');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const window = fakeWindow();
    hardenWindow(window as never);

    let decision: unknown;
    const seen = await collectUnhandledRejections(() => {
      decision = window.windowOpenHandler?.({ url: 'https://example.com/' });
    });

    expect(seen).toEqual([]);
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]?.[1]).toBe(electronState.failWith);
    // Claim 4: the popup is still denied. A `.catch` that also stopped
    // returning `deny` would satisfy every assertion above while removing the
    // control this function exists to apply.
    expect(decision).toEqual({ action: 'deny' });
    errors.mockRestore();
  });

  /**
   * Claim 3. Without this, an unconditional `console.error` on every external
   * open — or one moved outside the rejection path — satisfies the two tests
   * above, and they would then be asserting that a line of code runs rather
   * than that a rejection is handled.
   */
  it('reports nothing when openExternal resolves', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const window = fakeWindow();
    hardenWindow(window as never);

    const seen = await collectUnhandledRejections(() => {
      const { prevented } = navigate(window, 'https://example.com/');
      // Claim 4 on this path: external navigation is still blocked.
      expect(prevented).toBe(true);
      window.windowOpenHandler?.({ url: 'https://example.com/' });
    });

    expect(seen).toEqual([]);
    expect(errors.mock.calls).toEqual([]);
    expect(electronState.openedExternally).toEqual([
      'https://example.com/',
      'https://example.com/',
    ]);
    errors.mockRestore();
  });
});
