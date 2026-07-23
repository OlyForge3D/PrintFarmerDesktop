import {
  app,
  BrowserWindow,
  Menu,
  safeStorage,
  session,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import {
  applyContentSecurityPolicy,
  enforceSingleInstance,
  hardenWindow,
} from './security.js';
import { registerIpcHandlers } from './ipc.js';
import { resolveAppIconPath } from './appIcon.js';
import { ServerProfileService } from './serverProfiles.js';
import { SidecarClient, spawnSidecarChannel } from './sidecar.js';
import { SyncHttpClient } from './syncHttp.js';
import { PrintFarmerSyncEngine } from './syncEngine.js';

let syncEngine: PrintFarmerSyncEngine | null = null;
let sharedSidecar: SidecarClient | null = null;
let sharedProfiles: ServerProfileService | null = null;
let shutdownStarted = false;
let cleanupComplete = false;

const createMainWindow = (): void => {
  const iconPath = resolveAppIconPath(
    app.getAppPath(),
    process.resourcesPath,
    app.isPackaged,
  );
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 700,
    title: 'PrintFarmer Desktop',
    icon: iconPath,
    backgroundColor: '#0e1116',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 12 },
        }
      : {
          // Keep native caption buttons while replacing the menu/icon strip with
          // renderer-owned chrome. The CSS titlebar reserves this overlay area.
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#101318',
            symbolColor: '#e6e9ed',
            height: 40,
          },
        }),
    webPreferences: {
      // main.js and preload.js are emitted side by side in `.vite/build`
      // (dev) and packaged together, so resolve the preload from this dir.
      preload: path.join(import.meta.dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  hardenWindow(mainWindow);
  mainWindow.setMenuBarVisibility(false);

  // Surface renderer-side failures in the main process log. Without this a
  // crashing renderer just shows a blank window with no diagnostics.
  mainWindow.webContents.on(
    'console-message',
    (_event, level, message, line, sourceId) => {
      if (level >= 2) {
        console.error(`[renderer:${level}] ${message} (${sourceId}:${line})`);
      }
    },
  );
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] render-process-gone: ${details.reason}`);
  });

  const showMainWindow = (): void => {
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  };
  mainWindow.once('ready-to-show', showMainWindow);

  // Renderer entry: dev server when running `electron-forge start`, otherwise
  // the packaged HTML produced by the Vite plugin.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow
      .loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
      .then(showMainWindow)
      .catch((error: unknown) =>
        console.error('[renderer] failed to load dev server', error),
      );
  } else {
    void mainWindow
      .loadFile(
        path.join(
          import.meta.dirname,
          `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
        ),
      )
      .then(showMainWindow)
      .catch((error: unknown) =>
        console.error('[renderer] failed to load packaged UI', error),
      );
  }
};

function installApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  // macOS keeps its menu in the system menu bar rather than inside the window.
  // Preserve standard application/Edit/Window roles and accelerators while the
  // BrowserWindow itself uses renderer-owned titlebar chrome.
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'File',
      submenu: [{ role: 'close' }],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!enforceSingleInstance()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock.setIcon(
        resolveAppIconPath(app.getAppPath(), process.resourcesPath, false),
      );
    }
    installApplicationMenu();
    applyContentSecurityPolicy(
      session.defaultSession,
      MAIN_WINDOW_VITE_DEV_SERVER_URL,
    );
    // Persist the model catalog under the per-user data directory so it
    // survives restarts. The sidecar reads this via PRINTFARMER_CATALOG_DB.
    if (!process.env.PRINTFARMER_CATALOG_DB) {
      process.env.PRINTFARMER_CATALOG_DB = path.join(
        app.getPath('userData'),
        'catalog.sqlite3',
      );
    }
    sharedSidecar = new SidecarClient(spawnSidecarChannel);
    sharedProfiles = new ServerProfileService({
      userDataPath: app.getPath('userData'),
      secretStorage: safeStorage,
    });
    registerIpcHandlers(undefined, sharedProfiles, sharedSidecar);
    syncEngine = new PrintFarmerSyncEngine(
      sharedProfiles,
      sharedSidecar,
      new SyncHttpClient(sharedProfiles),
    );
    void syncEngine.start().catch(() => {
      console.error('[sync] scheduler startup failed');
    });
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    if (cleanupComplete || !syncEngine) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    const engine = syncEngine;
    syncEngine = null;
    void (async () => {
      const disposal = engine.dispose();
      await Promise.race([
        disposal,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
      sharedSidecar?.dispose();
      sharedSidecar = null;
      await Promise.race([
        disposal,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      sharedProfiles?.clearTokens();
      sharedProfiles = null;
      cleanupComplete = true;
      app.quit();
    })();
  });

  // Refuse to attach webviews or open arbitrary windows from any web contents.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}
