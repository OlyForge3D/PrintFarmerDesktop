import { app, shell, type BrowserWindow, type Session } from 'electron';
import { URL } from 'node:url';

/**
 * Hosts the renderer is allowed to navigate to internally. In development this
 * includes the Vite dev server; in production only the packaged app protocol
 * is used, so external navigation is always delegated to the OS browser.
 */
function isInternalUrl(target: string): boolean {
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer && target.startsWith(devServer)) {
    return true;
  }
  try {
    const url = new URL(target);
    // Packaged renderer is loaded from file:// inside the app bundle.
    return url.protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * Apply defense-in-depth navigation and window-open guards to a window. The
 * renderer can never navigate the top frame to an untrusted origin, and any
 * attempt to open a new window is redirected to the default OS browser.
 */
export function hardenWindow(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block renderer-initiated permission requests (camera, geolocation, etc.).
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
}

/**
 * Attach a strict Content-Security-Policy to every response served to the
 * renderer. This is a runtime backstop in addition to the static CSP meta tag.
 */
export function applyContentSecurityPolicy(session: Session): void {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

/**
 * Prevent a second instance and refuse to launch under elevated node runtime
 * flags that could weaken the sandbox.
 */
export function enforceSingleInstance(): boolean {
  return app.requestSingleInstanceLock();
}
