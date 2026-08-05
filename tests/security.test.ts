// @vitest-environment node

/**
 * Renderer-isolation controls in `src/main/security.ts`. This module had no
 * tests: it is the only main-process module besides `ipc.ts` and `main.ts` with
 * a runtime `electron` import, and no test in this repository mocked `electron`
 * until now.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  openedExternally: [] as string[],
  singleInstanceLock: true,
  openExternalRejection: null as Error | null,
}));

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: () => electronState.singleInstanceLock,
  },
  shell: {
    openExternal: (url: string) => {
      electronState.openedExternally.push(url);
      return electronState.openExternalRejection
        ? Promise.reject(electronState.openExternalRejection)
        : Promise.resolve();
    },
  },
}));

const { applyContentSecurityPolicy, enforceSingleInstance, hardenWindow } =
  await import('../src/main/security.js');

type Listener = (...args: unknown[]) => unknown;

function fakeWindow() {
  const listeners = new Map<string, Listener>();
  let windowOpenHandler: ((details: { url: string }) => unknown) | null = null;
  let permissionHandler:
    | ((
        wc: unknown,
        permission: string,
        callback: (ok: boolean) => void,
      ) => void)
    | null = null;

  return {
    listeners,
    get windowOpenHandler() {
      return windowOpenHandler;
    },
    get permissionHandler() {
      return permissionHandler;
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
        setPermissionRequestHandler: (
          handler: (
            wc: unknown,
            permission: string,
            callback: (ok: boolean) => void,
          ) => void,
        ) => {
          permissionHandler = handler;
        },
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

/** Capture the CSP string `applyContentSecurityPolicy` installs. */
type HeadersCallback = (result: {
  responseHeaders: Record<string, string[]>;
}) => void;
type HeadersListener = (
  details: { responseHeaders: Record<string, string[]> },
  callback: HeadersCallback,
) => void;

function cspFor(devServerUrl?: string | null): string {
  const listeners: HeadersListener[] = [];
  const session = {
    webRequest: {
      onHeadersReceived: (handler: HeadersListener) => {
        listeners.push(handler);
      },
    },
  };
  applyContentSecurityPolicy(session as never, devServerUrl);
  const listener = listeners[0];
  if (!listener) throw new Error('no onHeadersReceived handler registered');
  let captured = '';
  listener({ responseHeaders: {} }, (result) => {
    captured = result.responseHeaders['Content-Security-Policy']![0]!;
  });
  return captured;
}

/** Split a CSP string into its directives. */
function directive(csp: string, name: string): string {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  if (!found) throw new Error(`CSP has no ${name} directive: ${csp}`);
  return found;
}

beforeEach(() => {
  electronState.openedExternally = [];
  electronState.singleInstanceLock = true;
  electronState.openExternalRejection = null;
  delete process.env['ELECTRON_RENDERER_URL'];
});

/**
 * Run `body`, capturing `console.error` calls for the duration.
 *
 * `shell.openExternal` rejects for ordinary reasons — no registered handler for
 * the scheme, no browser on a headless box, a user cancelling the OS prompt.
 * Both call sites used to be `void shell.openExternal(url)`, which silences
 * `no-floating-promises` and leaves the rejection to crash the main process
 * (issue #314).
 *
 * These tests assert the handler *runs*, which is a different claim from the
 * source containing a `.catch` — `tests/mainVoidRejectionHandlers.test.ts`
 * makes the textual claim, and text is not behaviour.
 */
async function captureConsoleErrors(body: () => void): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    calls.push(args);
  });
  try {
    body();
    // The handler is attached synchronously but runs on the microtask queue.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    spy.mockRestore();
  }
  return calls;
}

describe('a failed external open is reported, not floated (#314)', () => {
  it('reports a rejected will-navigate open', async () => {
    const failure = new Error('no handler registered for this scheme');
    electronState.openExternalRejection = failure;
    const window = fakeWindow();
    hardenWindow(window as never);

    const errors = await captureConsoleErrors(() => {
      navigate(window, 'https://evil.example/steal');
    });

    // Non-vacuity: the path under test actually ran. Without this, a listener
    // that was never registered would produce the same empty-handed pass as a
    // rejection that was correctly handled.
    expect(electronState.openedExternally).toEqual([
      'https://evil.example/steal',
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe('[security] failed to open external URL');
    expect(errors[0]?.[1]).toBe(failure);
  });

  it('reports a rejected window-open', async () => {
    const failure = new Error('no browser available');
    electronState.openExternalRejection = failure;
    const window = fakeWindow();
    hardenWindow(window as never);

    const errors = await captureConsoleErrors(() => {
      window.windowOpenHandler?.({ url: 'https://evil.example/popup' });
    });

    expect(electronState.openedExternally).toEqual([
      'https://evil.example/popup',
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe(
      '[security] failed to open external window URL',
    );
    expect(errors[0]?.[1]).toBe(failure);
  });

  it('stays silent when the open succeeds', async () => {
    // Control for both assertions above. They are of the form "console.error
    // was called", which a handler that logs unconditionally would also
    // satisfy. This pins the log to the rejection rather than to the call.
    const window = fakeWindow();
    hardenWindow(window as never);

    const errors = await captureConsoleErrors(() => {
      navigate(window, 'https://evil.example/steal');
      window.windowOpenHandler?.({ url: 'https://evil.example/popup' });
    });

    expect(electronState.openedExternally).toHaveLength(2);
    expect(errors).toEqual([]);
  });
});

describe('hardenWindow', () => {
  it('cancels top-frame navigation to an off-origin URL and hands it to the OS browser', () => {
    const window = fakeWindow();
    hardenWindow(window as never);

    const { prevented } = navigate(window, 'https://evil.example/steal');

    expect(prevented).toBe(true);
    expect(electronState.openedExternally).toEqual([
      'https://evil.example/steal',
    ]);
  });

  it('permits navigation within the packaged file: bundle', () => {
    const window = fakeWindow();
    hardenWindow(window as never);

    // The complement of the test above. Without it, a `will-navigate` listener
    // that cancelled unconditionally would pass the rejection test while
    // breaking the app, and nothing would notice.
    const { prevented } = navigate(window, 'file:///app/index.html');

    expect(prevented).toBe(false);
    expect(electronState.openedExternally).toEqual([]);
  });

  it('permits navigation to the dev-server origin only while ELECTRON_RENDERER_URL names it', () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    const window = fakeWindow();
    hardenWindow(window as never);

    expect(navigate(window, 'http://localhost:5173/index.html').prevented).toBe(
      false,
    );
    // Same scheme and host shape, different port: not the configured origin.
    expect(navigate(window, 'http://localhost:9999/index.html').prevented).toBe(
      true,
    );
  });

  it('denies every window-open request regardless of scheme', () => {
    const window = fakeWindow();
    hardenWindow(window as never);
    const handler = window.windowOpenHandler;
    expect(handler).toBeTypeOf('function');

    expect(handler!({ url: 'https://example.com' })).toEqual({
      action: 'deny',
    });
    // A non-http scheme is still denied; it is simply not forwarded to the OS.
    expect(handler!({ url: 'file:///etc/passwd' })).toEqual({
      action: 'deny',
    });
    expect(electronState.openedExternally).toEqual(['https://example.com']);
  });

  it('refuses renderer permission requests', () => {
    const window = fakeWindow();
    hardenWindow(window as never);
    const handler = window.permissionHandler;
    expect(handler).toBeTypeOf('function');

    const granted: boolean[] = [];
    for (const permission of ['media', 'geolocation', 'notifications']) {
      handler!({}, permission, (ok) => granted.push(ok));
    }
    expect(granted).toEqual([false, false, false]);
  });
});

describe('applyContentSecurityPolicy', () => {
  it('forbids inline and remote script in the packaged policy', () => {
    const csp = cspFor(null);

    // Asserted on script-src specifically, not on the whole policy string:
    // style-src legitimately carries 'unsafe-inline' (security.ts:70), so a
    // policy-wide search for that token would fail against correct input.
    expect(directive(csp, 'script-src')).toBe("script-src 'self'");
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('allows inline style and data:/blob: images, which the renderer depends on', () => {
    const csp = cspFor(null);

    // Recorded as deliberate rather than accidental: the thumbnail path renders
    // decoded PNG bytes through a data: URL, so img-src must permit it.
    expect(directive(csp, 'style-src')).toContain("'unsafe-inline'");
    expect(directive(csp, 'img-src')).toBe("img-src 'self' data: blob:");
  });

  it('widens script-src and connect-src to the dev-server origin only when one is supplied', () => {
    const csp = cspFor('http://localhost:5173');

    expect(directive(csp, 'script-src')).toBe(
      "script-src 'self' 'unsafe-inline' http://localhost:5173",
    );
    expect(directive(csp, 'connect-src')).toBe(
      "connect-src 'self' http://localhost:5173 ws://localhost:5173",
    );
    // The relaxation is confined to the dev server: object-src and base-uri
    // stay locked even in development.
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('does not leak the development relaxation into the packaged policy', () => {
    // The pairing that matters: the same assertion run against both branches.
    expect(directive(cspFor(null), 'script-src')).not.toContain(
      "'unsafe-inline'",
    );
    expect(directive(cspFor('http://localhost:5173'), 'script-src')).toContain(
      "'unsafe-inline'",
    );
  });
});

describe('enforceSingleInstance', () => {
  it('reports the lock result so a second instance can be refused', () => {
    electronState.singleInstanceLock = true;
    expect(enforceSingleInstance()).toBe(true);
    electronState.singleInstanceLock = false;
    expect(enforceSingleInstance()).toBe(false);
  });
});
