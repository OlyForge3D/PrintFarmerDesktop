import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type AppInfoResponse,
  type ExtractVendorMetadataRequest,
  type ExtractVendorMetadataResponse,
  type LoadSceneRequest,
  type LoadSceneResponse,
  type OpenModelFileResponse,
  type OpenFolderResponse,
  type PrintFarmerApi,
  type RenderThumbnailRequest,
  type RenderThumbnailResponse,
  type ScanRootRequest,
  type ScanRootResponse,
  type ListModelsResponse,
  type ListTagsResponse,
  type TagsForModelRequest,
  type TagsForModelResponse,
  type AddModelTagRequest,
  type AddModelTagResponse,
  type RemoveModelTagRequest,
  type RemoveModelTagResponse,
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
  openModelFile: (): Promise<OpenModelFileResponse> =>
    ipcRenderer.invoke(
      IpcChannel.OpenModelFile,
    ) as Promise<OpenModelFileResponse>,
  extractVendorMetadata: (
    request: ExtractVendorMetadataRequest,
  ): Promise<ExtractVendorMetadataResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ExtractVendorMetadata,
      request,
    ) as Promise<ExtractVendorMetadataResponse>,
  renderThumbnail: (
    request: RenderThumbnailRequest,
  ): Promise<RenderThumbnailResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RenderThumbnail,
      request,
    ) as Promise<RenderThumbnailResponse>,
  scanRoot: (request: ScanRootRequest): Promise<ScanRootResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ScanRoot,
      request,
    ) as Promise<ScanRootResponse>,
  listModels: (): Promise<ListModelsResponse> =>
    ipcRenderer.invoke(IpcChannel.ListModels) as Promise<ListModelsResponse>,
  listTags: (): Promise<ListTagsResponse> =>
    ipcRenderer.invoke(IpcChannel.ListTags) as Promise<ListTagsResponse>,
  tagsForModel: (request: TagsForModelRequest): Promise<TagsForModelResponse> =>
    ipcRenderer.invoke(
      IpcChannel.TagsForModel,
      request,
    ) as Promise<TagsForModelResponse>,
  addModelTag: (request: AddModelTagRequest): Promise<AddModelTagResponse> =>
    ipcRenderer.invoke(
      IpcChannel.AddModelTag,
      request,
    ) as Promise<AddModelTagResponse>,
  removeModelTag: (
    request: RemoveModelTagRequest,
  ): Promise<RemoveModelTagResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RemoveModelTag,
      request,
    ) as Promise<RemoveModelTagResponse>,
  openFolder: (): Promise<OpenFolderResponse> =>
    ipcRenderer.invoke(IpcChannel.OpenFolder) as Promise<OpenFolderResponse>,
};

contextBridge.exposeInMainWorld('printFarmer', api);
