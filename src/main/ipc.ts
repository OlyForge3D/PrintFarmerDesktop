import { app, ipcMain } from 'electron';
import {
  AppInfoResponse,
  IPC_CONTRACT_VERSION,
  IpcChannel,
  ipcSchemas,
  type SidecarPingResponse,
} from '@shared/ipc';
import {
  SidecarClient,
  spawnSidecarChannel,
  type ChannelFactory,
} from './sidecar.js';

/**
 * Register all IPC handlers. Every incoming payload is validated against its
 * Zod request schema before the handler runs, and every result is validated
 * against the response schema before being returned to the renderer. Invalid
 * input from a compromised renderer is rejected rather than trusted.
 *
 * @param channelFactory - Optional sidecar transport override, primarily for
 *   tests. Defaults to spawning the real `model-core` process.
 */
export function registerIpcHandlers(channelFactory?: ChannelFactory): void {
  const sidecar = new SidecarClient(channelFactory ?? spawnSidecarChannel);

  ipcMain.handle(IpcChannel.AppInfo, () => {
    const response: AppInfoResponse = {
      contractVersion: IPC_CONTRACT_VERSION,
      appVersion: app.getVersion(),
      platform: process.platform as 'win32' | 'darwin' | 'linux',
      electronVersion: process.versions.electron,
    };
    return ipcSchemas[IpcChannel.AppInfo].response.parse(response);
  });

  ipcMain.handle(
    IpcChannel.SidecarPing,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.SidecarPing].request.parse(rawRequest);
      // Probe the live sidecar. A failed handshake is reported as not-ok with a
      // null version rather than throwing, so the renderer can show a degraded
      // state instead of an error dialog.
      let sidecarVersion: string | null = null;
      let ok = false;
      try {
        const handshake = await sidecar.handshake();
        sidecarVersion = handshake.sidecarVersion;
        ok = true;
      } catch {
        ok = false;
      }
      const response: SidecarPingResponse = {
        ok,
        nonce: request.nonce,
        sidecarVersion,
      };
      return ipcSchemas[IpcChannel.SidecarPing].response.parse(response);
    },
  );

  ipcMain.handle(IpcChannel.LoadScene, async (_event, rawRequest: unknown) => {
    const request = ipcSchemas[IpcChannel.LoadScene].request.parse(rawRequest);
    const raw = await sidecar.loadScene(request.path);
    // Validate the sidecar's response against the contract before trusting it
    // in the renderer.
    return ipcSchemas[IpcChannel.LoadScene].response.parse(raw);
  });
}
