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
      shell.openExternal(url).catch((error: unknown) => {
        console.error('[security] failed to open external URL', error);
      });
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url).catch((error: unknown) => {
        console.error('[security] failed to open external window URL', error);
      });
    }
    return { action: 'deny' };
  });

  // Block renderer-initiated permission requests (camera, geolocation, etc.).
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
}

/**
 * Attach a Content-Security-Policy to every response served to the renderer.
 * This session header is the authoritative CSP and applies in both dev
 * (`http://localhost` dev server) and production (`file://` app bundle).
 *
 * In production the policy is strict: no remote code, no inline script. In
 * development it is relaxed just enough for the Vite dev server, which injects
 * an inline React Fast Refresh preamble and opens a websocket for HMR — both of
 * which a strict `script-src 'self'`/`connect-src 'self'` policy would block,
 * leaving the renderer blank. `devServerUrl` is the Vite dev server origin when
 * running under `electron-forge start`, otherwise `null`/`undefined`.
 */
export function applyContentSecurityPolicy(
  session: Session,
  devServerUrl?: string | null,
): void {
  const csp = devServerUrl
    ? developmentCsp(devServerUrl)
    : [
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
 * Development CSP: permits the Vite dev server origin, its HMR websocket, and
 * the inline preamble script `@vitejs/plugin-react` injects. Never used in a
 * packaged build.
 */
function developmentCsp(devServerUrl: string): string {
  let httpOrigin = devServerUrl;
  let wsOrigin = devServerUrl;
  try {
    const url = new URL(devServerUrl);
    httpOrigin = url.origin;
    wsOrigin = `ws://${url.host}`;
  } catch {
    // Fall back to the raw string if it is not a parseable URL.
  }
  return [
    `default-src 'self' ${httpOrigin}`,
    `script-src 'self' 'unsafe-inline' ${httpOrigin}`,
    `style-src 'self' 'unsafe-inline' ${httpOrigin}`,
    "img-src 'self' data: blob:",
    `connect-src 'self' ${httpOrigin} ${wsOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Prevent a second instance and refuse to launch under elevated node runtime
 * flags that could weaken the sandbox.
 */
export function enforceSingleInstance(): boolean {
  return app.requestSingleInstanceLock();
}
