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
      preload: path.join(import.meta.dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  hardenWindow(mainWindow);

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
    applyContentSecurityPolicy(session.defaultSession);
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
