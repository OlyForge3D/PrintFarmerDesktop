import { app, ipcMain } from 'electron';
import {
  AppInfoResponse,
  IPC_CONTRACT_VERSION,
  IpcChannel,
  ipcSchemas,
  type SidecarPingResponse,
} from '@shared/ipc';

/**
 * Register all IPC handlers. Every incoming payload is validated against its
 * Zod request schema before the handler runs, and every result is validated
 * against the response schema before being returned to the renderer. Invalid
 * input from a compromised renderer is rejected rather than trusted.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.AppInfo, () => {
    const response: AppInfoResponse = {
      contractVersion: IPC_CONTRACT_VERSION,
      appVersion: app.getVersion(),
      platform: process.platform as 'win32' | 'darwin' | 'linux',
      electronVersion: process.versions.electron,
    };
    return ipcSchemas[IpcChannel.AppInfo].response.parse(response);
  });

  ipcMain.handle(IpcChannel.SidecarPing, (_event, rawRequest: unknown) => {
    const request =
      ipcSchemas[IpcChannel.SidecarPing].request.parse(rawRequest);
    // The Rust sidecar RPC is not wired yet; echo the nonce so the transport
    // and validation path can be exercised end to end.
    const response: SidecarPingResponse = {
      ok: true,
      nonce: request.nonce,
      sidecarVersion: null,
    };
    return ipcSchemas[IpcChannel.SidecarPing].response.parse(response);
  });
}
