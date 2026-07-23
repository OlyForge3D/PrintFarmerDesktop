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
  type ImportPreviewRequest,
  type ImportPreviewResponse,
  type ImportRootRequest,
  type ImportRootResponse,
  type ListModelsResponse,
  type ListTagsResponse,
  type TagsForModelRequest,
  type TagsForModelResponse,
  type AddModelTagRequest,
  type AddModelTagResponse,
  type RemoveModelTagRequest,
  type RemoveModelTagResponse,
  type ListCollectionsResponse,
  type CollectionsForModelRequest,
  type CollectionsForModelResponse,
  type CreateCollectionRequest,
  type CreateCollectionResponse,
  type DeleteCollectionRequest,
  type DeleteCollectionResponse,
  type CollectionMembershipRequest,
  type CollectionMembershipResponse,
  type SidecarPingRequest,
  type SidecarPingResponse,
  type DeleteServerProfileRequest,
  type DeleteServerProfileResponse,
  type ListServerProfilesResponse,
  type SaveServerProfileRequest,
  type SaveServerProfileResponse,
  type SelectServerProfileRequest,
  type SelectServerProfileResponse,
  type TestServerProfileRequest,
  type TestServerProfileResponse,
  type StartUploadJobRequest,
  type StartUploadJobResponse,
  type ListUploadJobsResponse,
  type UploadJobRequest,
  type UploadJobResponse,
  type RemoveUploadJobResponse,
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
  previewImport: (
    request: ImportPreviewRequest,
  ): Promise<ImportPreviewResponse> =>
    ipcRenderer.invoke(
      IpcChannel.PreviewImport,
      request,
    ) as Promise<ImportPreviewResponse>,
  importRoot: (request: ImportRootRequest): Promise<ImportRootResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ImportRoot,
      request,
    ) as Promise<ImportRootResponse>,
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
  listCollections: (): Promise<ListCollectionsResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ListCollections,
    ) as Promise<ListCollectionsResponse>,
  collectionsForModel: (
    request: CollectionsForModelRequest,
  ): Promise<CollectionsForModelResponse> =>
    ipcRenderer.invoke(
      IpcChannel.CollectionsForModel,
      request,
    ) as Promise<CollectionsForModelResponse>,
  createCollection: (
    request: CreateCollectionRequest,
  ): Promise<CreateCollectionResponse> =>
    ipcRenderer.invoke(
      IpcChannel.CreateCollection,
      request,
    ) as Promise<CreateCollectionResponse>,
  deleteCollection: (
    request: DeleteCollectionRequest,
  ): Promise<DeleteCollectionResponse> =>
    ipcRenderer.invoke(
      IpcChannel.DeleteCollection,
      request,
    ) as Promise<DeleteCollectionResponse>,
  addModelToCollection: (
    request: CollectionMembershipRequest,
  ): Promise<CollectionMembershipResponse> =>
    ipcRenderer.invoke(
      IpcChannel.AddModelToCollection,
      request,
    ) as Promise<CollectionMembershipResponse>,
  removeModelFromCollection: (
    request: CollectionMembershipRequest,
  ): Promise<CollectionMembershipResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RemoveModelFromCollection,
      request,
    ) as Promise<CollectionMembershipResponse>,
  openFolder: (): Promise<OpenFolderResponse> =>
    ipcRenderer.invoke(IpcChannel.OpenFolder) as Promise<OpenFolderResponse>,
  listServerProfiles: (): Promise<ListServerProfilesResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ListServerProfiles,
    ) as Promise<ListServerProfilesResponse>,
  testServerProfile: (
    request: TestServerProfileRequest,
  ): Promise<TestServerProfileResponse> =>
    ipcRenderer.invoke(
      IpcChannel.TestServerProfile,
      request,
    ) as Promise<TestServerProfileResponse>,
  saveServerProfile: (
    request: SaveServerProfileRequest,
  ): Promise<SaveServerProfileResponse> =>
    ipcRenderer.invoke(
      IpcChannel.SaveServerProfile,
      request,
    ) as Promise<SaveServerProfileResponse>,
  selectServerProfile: (
    request: SelectServerProfileRequest,
  ): Promise<SelectServerProfileResponse> =>
    ipcRenderer.invoke(
      IpcChannel.SelectServerProfile,
      request,
    ) as Promise<SelectServerProfileResponse>,
  deleteServerProfile: (
    request: DeleteServerProfileRequest,
  ): Promise<DeleteServerProfileResponse> =>
    ipcRenderer.invoke(
      IpcChannel.DeleteServerProfile,
      request,
    ) as Promise<DeleteServerProfileResponse>,
  startUploadJob: (
    request: StartUploadJobRequest,
  ): Promise<StartUploadJobResponse> =>
    ipcRenderer.invoke(
      IpcChannel.StartUploadJob,
      request,
    ) as Promise<StartUploadJobResponse>,
  listUploadJobs: (): Promise<ListUploadJobsResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ListUploadJobs,
    ) as Promise<ListUploadJobsResponse>,
  pauseUploadJob: (request: UploadJobRequest): Promise<UploadJobResponse> =>
    ipcRenderer.invoke(
      IpcChannel.PauseUploadJob,
      request,
    ) as Promise<UploadJobResponse>,
  resumeUploadJob: (request: UploadJobRequest): Promise<UploadJobResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ResumeUploadJob,
      request,
    ) as Promise<UploadJobResponse>,
  cancelUploadJob: (request: UploadJobRequest): Promise<UploadJobResponse> =>
    ipcRenderer.invoke(
      IpcChannel.CancelUploadJob,
      request,
    ) as Promise<UploadJobResponse>,
  retryUploadJob: (request: UploadJobRequest): Promise<UploadJobResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RetryUploadJob,
      request,
    ) as Promise<UploadJobResponse>,
  removeUploadJob: (
    request: UploadJobRequest,
  ): Promise<RemoveUploadJobResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RemoveUploadJob,
      request,
    ) as Promise<RemoveUploadJobResponse>,
};

contextBridge.exposeInMainWorld('printFarmer', api);
