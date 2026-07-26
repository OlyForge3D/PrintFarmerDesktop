import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  ipcSchemas,
  type AppInfoResponse,
  type ExtractVendorMetadataRequest,
  type ExtractVendorMetadataResponse,
  type ExtractVendorPlateThumbnailsRequest,
  type ExtractVendorPlateThumbnailsResponse,
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
  type ListFavoritesResponse,
  type FavoriteModelRequest,
  type FavoriteModelResponse,
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
  type ResetUploadJobsResponse,
  type ResetApprovedRootsResponse,
  type RetargetListProfilesResponse,
  type RetargetImportProfileResponse,
  type RetargetPreflightRequest,
  type RetargetPreflightResponse,
  type RetargetBuildRequest,
  type RetargetBuildResponse,
  type RetargetLoadSceneRequest,
  type RetargetLoadSceneResponse,
  type RetargetSaveAsRequest,
  type RetargetSaveAsResponse,
  type RetargetDisposeRequest,
  type RetargetDisposeResponse,
  // Printer Calibration transport (issue #52)
  type CalibrationGetAvailabilityResponse,
  type CalibrationListPrintersRequest,
  type CalibrationListPrintersResponse,
  type CalibrationGetPrinterContextRequest,
  type CalibrationGetPrinterContextResponse,
  type CalibrationListProjectsRequest,
  type CalibrationListProjectsResponse,
  type CalibrationGetProjectRequest,
  type CalibrationGetProjectResponse,
  type CalibrationSaveDraftRequest,
  type CalibrationSaveDraftResponse,
  type CalibrationListAttemptsRequest,
  type CalibrationListAttemptsResponse,
  type CalibrationGetAttemptRequest,
  type CalibrationGetAttemptResponse,
  type CalibrationStagePhotoRequest,
  type CalibrationStagePhotoResponse,
  type CalibrationListConflictsRequest,
  type CalibrationListConflictsResponse,
  type CalibrationResolveConflictRequest,
  type CalibrationResolveConflictResponse,
  type CalibrationSyncNowRequest,
  type CalibrationSyncNowResponse,
  type CalibrationStartGenerationRequest,
  type CalibrationStartGenerationResponse,
  type CalibrationGetQueueStateRequest,
  type CalibrationGetQueueStateResponse,
  type CalibrationAcknowledgeBedClearRequest,
  type CalibrationAcknowledgeBedClearResponse,
  type CalibrationStartPrintRequest,
  type CalibrationStartPrintResponse,
  type CalibrationListOrcaProfilesResponse,
  type CalibrationExportOrcaProfileRequest,
  type CalibrationExportOrcaProfileResponse,
  type CalibrationImportLegacyBackupV4Request,
  type CalibrationImportLegacyBackupV4Response,
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
  extractVendorPlateThumbnails: (
    request: ExtractVendorPlateThumbnailsRequest,
  ): Promise<ExtractVendorPlateThumbnailsResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ExtractVendorPlateThumbnails,
      request,
    ) as Promise<ExtractVendorPlateThumbnailsResponse>,
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
  listFavorites: (): Promise<ListFavoritesResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ListFavorites,
    ) as Promise<ListFavoritesResponse>,
  addFavorite: (
    request: FavoriteModelRequest,
  ): Promise<FavoriteModelResponse> =>
    ipcRenderer.invoke(
      IpcChannel.AddFavorite,
      request,
    ) as Promise<FavoriteModelResponse>,
  removeFavorite: (
    request: FavoriteModelRequest,
  ): Promise<FavoriteModelResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RemoveFavorite,
      request,
    ) as Promise<FavoriteModelResponse>,
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
  confirmLegacyUploadRetry: (
    request: UploadJobRequest,
  ): Promise<UploadJobResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ConfirmLegacyUploadRetry,
      request,
    ) as Promise<UploadJobResponse>,
  removeUploadJob: (
    request: UploadJobRequest,
  ): Promise<RemoveUploadJobResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RemoveUploadJob,
      request,
    ) as Promise<RemoveUploadJobResponse>,
  resetUploadJobs: (): Promise<ResetUploadJobsResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ResetUploadJobs,
    ) as Promise<ResetUploadJobsResponse>,
  resetApprovedRoots: (): Promise<ResetApprovedRootsResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ResetApprovedRoots,
    ) as Promise<ResetApprovedRootsResponse>,
  listRetargetProfiles: async (): Promise<RetargetListProfilesResponse> =>
    ipcSchemas[IpcChannel.RetargetListProfiles].response.parse(
      await ipcRenderer.invoke(IpcChannel.RetargetListProfiles),
    ),
  importRetargetProfile: async (): Promise<RetargetImportProfileResponse> =>
    ipcSchemas[IpcChannel.RetargetImportProfile].response.parse(
      await ipcRenderer.invoke(IpcChannel.RetargetImportProfile),
    ),
  preflightRetarget: async (
    request: RetargetPreflightRequest,
  ): Promise<RetargetPreflightResponse> =>
    ipcSchemas[IpcChannel.RetargetPreflight].response.parse(
      await ipcRenderer.invoke(IpcChannel.RetargetPreflight, request),
    ),
  buildRetarget: async (
    request: RetargetBuildRequest,
  ): Promise<RetargetBuildResponse> =>
    ipcSchemas[IpcChannel.RetargetBuild].response.parse(
      await ipcRenderer.invoke(IpcChannel.RetargetBuild, request),
    ),
  loadRetargetScene: async (
    request: RetargetLoadSceneRequest,
  ): Promise<RetargetLoadSceneResponse> =>
    ipcSchemas[IpcChannel.RetargetLoadScene].response.parse(
      await ipcRenderer.invoke(IpcChannel.RetargetLoadScene, request),
    ),
  saveRetargetAs: async (
    request: RetargetSaveAsRequest,
  ): Promise<RetargetSaveAsResponse> =>
    ipcSchemas[IpcChannel.RetargetSaveAs].response.parse(
      await ipcRenderer.invoke(IpcChannel.RetargetSaveAs, request),
    ),
  disposeRetarget: async (
    request: RetargetDisposeRequest,
  ): Promise<RetargetDisposeResponse> =>
    ipcSchemas[IpcChannel.RetargetDispose].response.parse(
      await ipcRenderer.invoke(IpcChannel.RetargetDispose, request),
    ),
  // --- Printer Calibration transport (issue #52) ---------------------------
  getCalibrationAvailability:
    async (): Promise<CalibrationGetAvailabilityResponse> =>
      ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse(
        await ipcRenderer.invoke(IpcChannel.CalibrationGetAvailability),
      ),
  listCalibrationPrinters: async (
    request: CalibrationListPrintersRequest,
  ): Promise<CalibrationListPrintersResponse> =>
    ipcSchemas[IpcChannel.CalibrationListPrinters].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationListPrinters, request),
    ),
  getCalibrationPrinterContext: async (
    request: CalibrationGetPrinterContextRequest,
  ): Promise<CalibrationGetPrinterContextResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetPrinterContext].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationGetPrinterContext,
        request,
      ),
    ),
  listCalibrationProjects: async (
    request: CalibrationListProjectsRequest,
  ): Promise<CalibrationListProjectsResponse> =>
    ipcSchemas[IpcChannel.CalibrationListProjects].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationListProjects, request),
    ),
  getCalibrationProject: async (
    request: CalibrationGetProjectRequest,
  ): Promise<CalibrationGetProjectResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetProject].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationGetProject, request),
    ),
  saveCalibrationDraft: async (
    request: CalibrationSaveDraftRequest,
  ): Promise<CalibrationSaveDraftResponse> =>
    ipcSchemas[IpcChannel.CalibrationSaveDraft].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationSaveDraft, request),
    ),
  listCalibrationAttempts: async (
    request: CalibrationListAttemptsRequest,
  ): Promise<CalibrationListAttemptsResponse> =>
    ipcSchemas[IpcChannel.CalibrationListAttempts].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationListAttempts, request),
    ),
  getCalibrationAttempt: async (
    request: CalibrationGetAttemptRequest,
  ): Promise<CalibrationGetAttemptResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetAttempt].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationGetAttempt, request),
    ),
  stageCalibrationPhoto: async (
    request: CalibrationStagePhotoRequest,
  ): Promise<CalibrationStagePhotoResponse> =>
    ipcSchemas[IpcChannel.CalibrationStagePhoto].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationStagePhoto, request),
    ),
  listCalibrationConflicts: async (
    request: CalibrationListConflictsRequest,
  ): Promise<CalibrationListConflictsResponse> =>
    ipcSchemas[IpcChannel.CalibrationListConflicts].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationListConflicts, request),
    ),
  resolveCalibrationConflict: async (
    request: CalibrationResolveConflictRequest,
  ): Promise<CalibrationResolveConflictResponse> =>
    ipcSchemas[IpcChannel.CalibrationResolveConflict].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationResolveConflict, request),
    ),
  syncCalibrationNow: async (
    request: CalibrationSyncNowRequest,
  ): Promise<CalibrationSyncNowResponse> =>
    ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationSyncNow, request),
    ),
  startCalibrationGeneration: async (
    request: CalibrationStartGenerationRequest,
  ): Promise<CalibrationStartGenerationResponse> =>
    ipcSchemas[IpcChannel.CalibrationStartGeneration].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationStartGeneration, request),
    ),
  getCalibrationQueueState: async (
    request: CalibrationGetQueueStateRequest,
  ): Promise<CalibrationGetQueueStateResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetQueueState].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationGetQueueState, request),
    ),
  acknowledgeCalibrationBedClear: async (
    request: CalibrationAcknowledgeBedClearRequest,
  ): Promise<CalibrationAcknowledgeBedClearResponse> =>
    ipcSchemas[IpcChannel.CalibrationAcknowledgeBedClear].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationAcknowledgeBedClear,
        request,
      ),
    ),
  startCalibrationPrint: async (
    request: CalibrationStartPrintRequest,
  ): Promise<CalibrationStartPrintResponse> =>
    ipcSchemas[IpcChannel.CalibrationStartPrint].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationStartPrint, request),
    ),
  listOrcaProfiles: async (): Promise<CalibrationListOrcaProfilesResponse> =>
    ipcSchemas[IpcChannel.CalibrationListOrcaProfiles].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationListOrcaProfiles),
    ),
  exportOrcaProfile: async (
    request: CalibrationExportOrcaProfileRequest,
  ): Promise<CalibrationExportOrcaProfileResponse> =>
    ipcSchemas[IpcChannel.CalibrationExportOrcaProfile].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationExportOrcaProfile,
        request,
      ),
    ),
  importLegacyCalibrationBackupV4: async (
    request: CalibrationImportLegacyBackupV4Request,
  ): Promise<CalibrationImportLegacyBackupV4Response> =>
    ipcSchemas[IpcChannel.CalibrationImportLegacyBackupV4].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationImportLegacyBackupV4,
        request,
      ),
    ),
};

contextBridge.exposeInMainWorld('printFarmer', api);
