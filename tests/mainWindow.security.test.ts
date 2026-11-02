// @vitest-environment node

/**
 * Window-creation security flags in `src/main/main.ts`.
 *
 * `main.ts` exports nothing and performs its work at module scope, so these
 * tests import it for its side effects with `electron` and its service
 * dependencies mocked, then assert on what it asked Electron for.
 *
 * The flag this file exists for is `nodeIntegrationInSubFrames`. It is not set
 * in `main.ts:66-75`; the protection comes from Electron's default being
 * `false`. An unstated default is invisible to review and silently reversible,
 * so it is asserted here to convert it into something CI notices.
 */

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootState = vi.hoisted(() => ({
  windowOptions: [] as Record<string, unknown>[],
  applicationNames: [] as string[],
  aboutPanelOptions: [] as Record<string, unknown>[],
  webContentsListeners: new Map<string, unknown>(),
  openedExternally: [] as string[],
  appListeners: new Map<string, (...args: unknown[]) => unknown>(),
  readyResolved: Promise.resolve(),
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    static getAllWindows = () => [];
    webContents = {
      on: (event: string, listener: unknown) => {
        bootState.webContentsListeners.set(event, listener);
      },
      setWindowOpenHandler: () => undefined,
      session: { setPermissionRequestHandler: () => undefined },
    };
    constructor(options: Record<string, unknown>) {
      bootState.windowOptions.push(options);
    }
    setMenuBarVisibility = () => undefined;
    once = () => undefined;
    isDestroyed = () => false;
    isVisible = () => true;
    show = () => undefined;
    loadURL = () => Promise.resolve();
    loadFile = () => Promise.resolve();
  }
  const fakeApp = {
    name: 'Electron',
    setName: (name: string) => {
      fakeApp.name = name;
      bootState.applicationNames.push(name);
    },
    setAboutPanelOptions: (options: Record<string, unknown>) => {
      bootState.aboutPanelOptions.push(options);
    },
    requestSingleInstanceLock: () => true,
    whenReady: () => bootState.readyResolved,
    on: (event: string, listener: (...args: unknown[]) => unknown) => {
      bootState.appListeners.set(event, listener);
    },
    getPath: () => '/test/userData',
    setPath: () => undefined,
    getAppPath: () => '/test/app',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    quit: () => undefined,
    dock: { setIcon: () => undefined },
  };
  return {
    app: fakeApp,
    BrowserWindow: FakeBrowserWindow,
    Menu: {
      setApplicationMenu: () => undefined,
      buildFromTemplate: (t: unknown) => t,
    },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: {
      openExternal: (url: string) => {
        bootState.openedExternally.push(url);
        return Promise.resolve();
      },
    },
    session: {
      defaultSession: { webRequest: { onHeadersReceived: () => undefined } },
    },
  };
});

vi.mock('../src/main/ipc.js', () => ({
  registerIpcHandlers: () => () => Promise.resolve(),
}));
vi.mock('../src/main/sidecar.js', () => ({
  SidecarClient: class {
    dispose = () => undefined;
  },
  spawnSidecarChannel: () => undefined,
}));
vi.mock('../src/main/serverProfiles.js', () => ({
  ServerProfileService: class {
    clearTokens = () => undefined;
  },
}));
vi.mock('../src/main/syncHttp.js', () => ({ SyncHttpClient: class {} }));
vi.mock('../src/main/syncEngine.js', () => ({
  PrintFarmerSyncEngine: class {
    start = () => Promise.resolve();
    dispose = () => Promise.resolve();
  },
}));

// Injected by the Vite main-process plugin at build time; absent under vitest.
vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');
vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');

let bootstrapped = false;
async function bootstrap() {
  if (!bootstrapped) {
    await import('../src/main/main.js');
    bootstrapped = true;
  }
  // Let the `app.whenReady().then(...)` continuation run.
  await bootState.readyResolved;
  await Promise.resolve();
}

beforeEach(async () => {
  await bootstrap();
});

describe('main window webPreferences', () => {
  it('creates exactly one window during startup', () => {
    // Guards the assertions below: if the bootstrap stopped creating a window,
    // every flag test would pass vacuously against an empty array.
    expect(bootState.windowOptions).toHaveLength(1);
  });

  it('withholds node integration from subframes, which Electron only guarantees by default', () => {
    const prefs = bootState.windowOptions[0]!['webPreferences'] as Record<
      string,
      unknown
    >;
    // Falsy rather than `false`: the value is legitimately absent today. This
    // asserts the effective posture, and fails if anyone sets it to `true`.
    expect(prefs['nodeIntegrationInSubFrames']).toBeFalsy();
  });

  it.each([
    ['contextIsolation', true],
    ['nodeIntegration', false],
    ['sandbox', true],
    ['webSecurity', true],
    ['allowRunningInsecureContent', false],
  ])('sets %s to %s', (flag, expected) => {
    const prefs = bootState.windowOptions[0]!['webPreferences'] as Record<
      string,
      unknown
    >;
    expect(prefs[flag]).toBe(expected);
  });
});

describe('startup diagnostics', () => {
  it('logs preload failures so a missing bridge is actionable', () => {
    const listener = bootState.webContentsListeners.get('preload-error') as (
      event: unknown,
      preloadPath: string,
      error: Error,
    ) => void;
    const failure = new Error('preload failed');
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      listener({}, 'preload.js', failure);
      expect(logError).toHaveBeenCalledWith(
        '[preload] failed to load preload.js',
        failure,
      );
    } finally {
      logError.mockRestore();
    }
  });

  it.each([
    ['error', true],
    ['warning', true],
    ['info', false],
    ['debug', false],
  ] as const)(
    'handles renderer %s messages using the current Electron payload',
    (level, shouldLog) => {
      const listener = bootState.webContentsListeners.get(
        'console-message',
      ) as (details: {
        level: 'error' | 'warning' | 'info' | 'debug';
        message: string;
        sourceId: string;
        lineNumber: number;
      }) => void;
      const logError = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        listener({
          level,
          message: 'renderer message',
          sourceId: 'http://localhost:5173/src/renderer/App.tsx',
          lineNumber: 46,
        });
        if (shouldLog) {
          expect(logError).toHaveBeenCalledWith(
            `[renderer:${level}] renderer message (http://localhost:5173/src/renderer/App.tsx:46)`,
          );
        } else {
          expect(logError).not.toHaveBeenCalled();
        }
      } finally {
        logError.mockRestore();
      }
    },
  );
});

describe('development navigation wiring', () => {
  it('passes the Forge dev-server URL to the navigation guard', () => {
    const listener = bootState.webContentsListeners.get('will-navigate') as (
      event: { preventDefault: () => void },
      url: string,
    ) => void;
    const preventDefault = vi.fn();

    listener({ preventDefault }, 'http://localhost:5173/');

    expect(preventDefault).not.toHaveBeenCalled();
    expect(bootState.openedExternally).toEqual([]);
  });
});

describe('macOS product identity', () => {
  it('uses packaged product metadata in development mode', () => {
    expect(bootState.applicationNames).toEqual(['PrintFarmer Desktop']);
    expect(bootState.aboutPanelOptions).toEqual([
      {
        applicationName: 'PrintFarmer Desktop',
        applicationVersion: '0.0.0-test',
        version: '0.0.0-test',
        copyright: 'Copyright (c) 2026 OlyForge3D',
        website: 'https://github.com/OlyForge3D/PrintFarmerDesktop',
        // `resolveAppIconPath` joins with `node:path`, which uses the host's
        // native separator, so the expectation must too (backslashes on
        // Windows CI runners, forward slashes elsewhere).
        iconPath: path.join('/test/app', 'assets', 'icon.png'),
      },
    ]);
  });
});

describe('process-wide web-contents hardening', () => {
  it('denies window-open on every WebContents created, not just the main window', () => {
    const listener = bootState.appListeners.get('web-contents-created');
    expect(
      listener,
      'main.ts registered no web-contents-created listener',
    ).toBeTypeOf('function');

    // A WebContents that never passes through `hardenWindow` — a webview or a
    // devtools contents — must still be denied. This is the process-wide net
    // at main.ts:283-285, distinct from the per-window handler in security.ts.
    const installed: (() => unknown)[] = [];
    const contents = {
      setWindowOpenHandler: (handler: () => unknown) => {
        installed.push(handler);
      },
    };
    listener!({}, contents);

    const handler = installed[0];
    expect(handler, 'no window-open handler was installed').toBeTypeOf(
      'function',
    );
    expect(handler!()).toEqual({ action: 'deny' });
  });
});
