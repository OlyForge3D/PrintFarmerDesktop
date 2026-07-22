import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type AppInfoResponse,
  type LoadSceneRequest,
  type LoadSceneResponse,
  type PrintFarmerApi,
  type SidecarPingRequest,
  type SidecarPingResponse,
} from '@shared/ipc';

/**
 * The only bridge between the sandboxed renderer and the main process. It
 * exposes a small, explicit, typed surface. No `ipcRenderer`, `require`, or
 * Node primitive is ever exposed to renderer code.
 */
const api: PrintFarmerApi = {
  getAppInfo: (): Promise<AppInfoResponse> =>
    ipcRenderer.invoke(IpcChannel.AppInfo) as Promise<AppInfoResponse>,
  pingSidecar: (request: SidecarPingRequest): Promise<SidecarPingResponse> =>
    ipcRenderer.invoke(
      IpcChannel.SidecarPing,
      request,
    ) as Promise<SidecarPingResponse>,
  loadScene: (request: LoadSceneRequest): Promise<LoadSceneResponse> =>
    ipcRenderer.invoke(
      IpcChannel.LoadScene,
      request,
    ) as Promise<LoadSceneResponse>,
};

contextBridge.exposeInMainWorld('printFarmer', api);
