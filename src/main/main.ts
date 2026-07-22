import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import {
  applyContentSecurityPolicy,
  enforceSingleInstance,
  hardenWindow,
} from './security.js';
import { registerIpcHandlers } from './ipc.js';

const createMainWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#14151a',
    show: false,
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

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Renderer entry: dev server when running `electron-forge start`, otherwise
  // the packaged HTML produced by the Vite plugin.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(
      path.join(
        import.meta.dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    );
  }
};

if (!enforceSingleInstance()) {
  app.quit();
} else {
  void app.whenReady().then(() => {
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
    registerIpcHandlers();
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

  // Refuse to attach webviews or open arbitrary windows from any web contents.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}
