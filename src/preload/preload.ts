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
  type ResetCatalogResponse,
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
  type CalibrationGetAvailabilityResponse,
  type CalibrationListPrintersRequest,
  type CalibrationListPrintersResponse,
  type CalibrationGetPrinterContextRequest,
  type CalibrationGetPrinterContextResponse,
  type CalibrationListWorkspaceStatesRequest,
  type CalibrationListWorkspaceStatesResponse,
  type CalibrationGetWorkspaceStateRequest,
  type CalibrationGetWorkspaceStateResponse,
  type CalibrationSaveWorkspaceStateRequest,
  type CalibrationSaveWorkspaceStateResponse,
  type CalibrationSyncNowRequest,
  type CalibrationSyncNowResponse,
  type CalibrationGetDiagnosticsRequest,
  type CalibrationGetDiagnosticsResponse,
  type CalibrationResolveConflictRequest,
  type CalibrationResolveConflictResponse,
  type CalibrationListConflictsRequest,
  type CalibrationListConflictsResponse,
  type CalibrationPollQueueChangesRequest,
  type CalibrationPollQueueChangesResponse,
  type CalibrationGetSubscriptionResourcesRequest,
  type CalibrationGetSubscriptionResourcesResponse,
  type CalibrationListOrcaProfilesRequest,
  type CalibrationListOrcaProfilesResponse,
  type CalibrationExportOrcaProfileRequest,
  type CalibrationExportOrcaProfileResponse,
  type CalibrationListExtendedProfilesRequest,
  type CalibrationListExtendedProfilesResponse,
  type CalibrationListMachineProfilesForModelRequest,
  type CalibrationListMachineProfilesForModelResponse,
  type CalibrationListProcessProfilesForMachinesRequest,
  type CalibrationListProcessProfilesForMachinesResponse,
  type CalibrationListFilamentProfilesForMachinesRequest,
  type CalibrationListFilamentProfilesForMachinesResponse,
  type CalibrationListCustomProfilesRequest,
  type CalibrationListCustomProfilesResponse,
  type CalibrationResolveSystemProfileRequest,
  type CalibrationResolveSystemProfileResponse,
  type CalibrationCreateProjectRequest,
  type CalibrationCreateProjectResponse,
  type CalibrationGetMethodGuidanceCatalogRequest,
  type CalibrationGetMethodGuidanceCatalogResponse,
  type CalibrationGetMethodProgressRequest,
  type CalibrationGetMethodProgressResponse,
  type CalibrationSetMethodDispositionRequest,
  type CalibrationSetMethodDispositionResponse,
  type CalibrationCloneFilamentProfileRequest,
  type CalibrationCloneFilamentProfileResponse,
  type CalibrationSubmitCalibrationSliceRequest,
  type CalibrationSubmitCalibrationSliceResponse,
  type CalibrationGetSliceJobStatusRequest,
  type CalibrationGetSliceJobStatusResponse,
  type CalibrationSendSliceToPrinterRequest,
  type CalibrationSendSliceToPrinterResponse,
  type CalibrationUpdateFilamentProfileMeasurementRequest,
  type CalibrationUpdateFilamentProfileMeasurementResponse,
  type CalibrationSaveFilamentWizardStateRequest,
  type CalibrationSaveFilamentWizardStateResponse,
  type CalibrationGetFilamentWizardStateRequest,
  type CalibrationGetFilamentWizardStateResponse,
  type CalibrationClearFilamentWizardStateRequest,
  type CalibrationClearFilamentWizardStateResponse,
} from '@shared/ipc';

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
  resetCatalog: (): Promise<ResetCatalogResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ResetCatalog,
    ) as Promise<ResetCatalogResponse>,
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
  listServerProfiles: (): Promise<ListServerProfilesResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ListServerProfiles,
    ) as Promise<ListServerProfilesResponse>,
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
  testServerProfile: (
    request: TestServerProfileRequest,
  ): Promise<TestServerProfileResponse> =>
    ipcRenderer.invoke(
      IpcChannel.TestServerProfile,
      request,
    ) as Promise<TestServerProfileResponse>,
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
  openFolder: (): Promise<OpenFolderResponse> =>
    ipcRenderer.invoke(IpcChannel.OpenFolder) as Promise<OpenFolderResponse>,
  resetApprovedRoots: (): Promise<ResetApprovedRootsResponse> =>
    ipcRenderer.invoke(
      IpcChannel.ResetApprovedRoots,
    ) as Promise<ResetApprovedRootsResponse>,
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
  listCalibrationWorkspaceStates: async (
    request: CalibrationListWorkspaceStatesRequest,
  ): Promise<CalibrationListWorkspaceStatesResponse> =>
    ipcSchemas[IpcChannel.CalibrationListWorkspaceStates].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationListWorkspaceStates,
        request,
      ),
    ),
  getCalibrationWorkspaceState: async (
    request: CalibrationGetWorkspaceStateRequest,
  ): Promise<CalibrationGetWorkspaceStateResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetWorkspaceState].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationGetWorkspaceState,
        request,
      ),
    ),
  saveCalibrationWorkspaceState: async (
    request: CalibrationSaveWorkspaceStateRequest,
  ): Promise<CalibrationSaveWorkspaceStateResponse> =>
    ipcSchemas[IpcChannel.CalibrationSaveWorkspaceState].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationSaveWorkspaceState,
        request,
      ),
    ),
  syncCalibrationNow: async (
    request: CalibrationSyncNowRequest,
  ): Promise<CalibrationSyncNowResponse> =>
    ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationSyncNow, request),
    ),
  getCalibrationDiagnostics: async (
    request: CalibrationGetDiagnosticsRequest,
  ): Promise<CalibrationGetDiagnosticsResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetDiagnostics].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationGetDiagnostics, request),
    ),
  resolveCalibrationConflict: async (
    request: CalibrationResolveConflictRequest,
  ): Promise<CalibrationResolveConflictResponse> =>
    ipcSchemas[IpcChannel.CalibrationResolveConflict].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationResolveConflict, request),
    ),
  listCalibrationConflicts: async (
    request: CalibrationListConflictsRequest,
  ): Promise<CalibrationListConflictsResponse> =>
    ipcSchemas[IpcChannel.CalibrationListConflicts].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationListConflicts, request),
    ),
  pollCalibrationQueueChanges: async (
    request: CalibrationPollQueueChangesRequest,
  ): Promise<CalibrationPollQueueChangesResponse> =>
    ipcSchemas[IpcChannel.CalibrationPollQueueChanges].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationPollQueueChanges, request),
    ),
  getCalibrationSubscriptionResources: async (
    request: CalibrationGetSubscriptionResourcesRequest,
  ): Promise<CalibrationGetSubscriptionResourcesResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetSubscriptionResources].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationGetSubscriptionResources,
        request,
      ),
    ),
  listOrcaProfiles: async (
    request: CalibrationListOrcaProfilesRequest,
  ): Promise<CalibrationListOrcaProfilesResponse> =>
    ipcSchemas[IpcChannel.CalibrationListOrcaProfiles].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationListOrcaProfiles, request),
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
  listCalibrationExtendedProfiles: async (
    request: CalibrationListExtendedProfilesRequest,
  ): Promise<CalibrationListExtendedProfilesResponse> =>
    ipcSchemas[IpcChannel.CalibrationListExtendedProfiles].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationListExtendedProfiles,
        request,
      ),
    ),
  listCalibrationMachineProfilesForModel: async (
    request: CalibrationListMachineProfilesForModelRequest,
  ): Promise<CalibrationListMachineProfilesForModelResponse> =>
    ipcSchemas[
      IpcChannel.CalibrationListMachineProfilesForModel
    ].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationListMachineProfilesForModel,
        request,
      ),
    ),
  listCalibrationProcessProfilesForMachines: async (
    request: CalibrationListProcessProfilesForMachinesRequest,
  ): Promise<CalibrationListProcessProfilesForMachinesResponse> =>
    ipcSchemas[
      IpcChannel.CalibrationListProcessProfilesForMachines
    ].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationListProcessProfilesForMachines,
        request,
      ),
    ),
  listCalibrationFilamentProfilesForMachines: async (
    request: CalibrationListFilamentProfilesForMachinesRequest,
  ): Promise<CalibrationListFilamentProfilesForMachinesResponse> =>
    ipcSchemas[
      IpcChannel.CalibrationListFilamentProfilesForMachines
    ].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationListFilamentProfilesForMachines,
        request,
      ),
    ),
  listCalibrationCustomProfiles: async (
    request: CalibrationListCustomProfilesRequest,
  ): Promise<CalibrationListCustomProfilesResponse> =>
    ipcSchemas[IpcChannel.CalibrationListCustomProfiles].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationListCustomProfiles,
        request,
      ),
    ),
  resolveSystemProfile: async (
    request: CalibrationResolveSystemProfileRequest,
  ): Promise<CalibrationResolveSystemProfileResponse> =>
    ipcSchemas[IpcChannel.CalibrationResolveSystemProfile].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationResolveSystemProfile,
        request,
      ),
    ),
  createCalibrationProject: async (
    request: CalibrationCreateProjectRequest,
  ): Promise<CalibrationCreateProjectResponse> =>
    ipcSchemas[IpcChannel.CalibrationCreateProject].response.parse(
      await ipcRenderer.invoke(IpcChannel.CalibrationCreateProject, request),
    ),
  getCalibrationMethodGuidanceCatalog: async (
    request: CalibrationGetMethodGuidanceCatalogRequest,
  ): Promise<CalibrationGetMethodGuidanceCatalogResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetMethodGuidanceCatalog].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationGetMethodGuidanceCatalog,
        request,
      ),
    ),
  getCalibrationMethodProgress: async (
    request: CalibrationGetMethodProgressRequest,
  ): Promise<CalibrationGetMethodProgressResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetMethodProgress].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationGetMethodProgress,
        request,
      ),
    ),
  setCalibrationMethodDisposition: async (
    request: CalibrationSetMethodDispositionRequest,
  ): Promise<CalibrationSetMethodDispositionResponse> =>
    ipcSchemas[IpcChannel.CalibrationSetMethodDisposition].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationSetMethodDisposition,
        request,
      ),
    ),
  cloneCalibrationFilamentProfile: async (
    request: CalibrationCloneFilamentProfileRequest,
  ): Promise<CalibrationCloneFilamentProfileResponse> =>
    ipcSchemas[IpcChannel.CalibrationCloneFilamentProfile].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationCloneFilamentProfile,
        request,
      ),
    ),
  submitCalibrationSlice: async (
    request: CalibrationSubmitCalibrationSliceRequest,
  ): Promise<CalibrationSubmitCalibrationSliceResponse> =>
    ipcSchemas[IpcChannel.CalibrationSubmitCalibrationSlice].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationSubmitCalibrationSlice,
        request,
      ),
    ),
  getCalibrationSliceJobStatus: async (
    request: CalibrationGetSliceJobStatusRequest,
  ): Promise<CalibrationGetSliceJobStatusResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetSliceJobStatus].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationGetSliceJobStatus,
        request,
      ),
    ),
  sendCalibrationSliceToPrinter: async (
    request: CalibrationSendSliceToPrinterRequest,
  ): Promise<CalibrationSendSliceToPrinterResponse> =>
    ipcSchemas[IpcChannel.CalibrationSendSliceToPrinter].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationSendSliceToPrinter,
        request,
      ),
    ),
  updateCalibrationFilamentProfileMeasurement: async (
    request: CalibrationUpdateFilamentProfileMeasurementRequest,
  ): Promise<CalibrationUpdateFilamentProfileMeasurementResponse> =>
    ipcSchemas[
      IpcChannel.CalibrationUpdateFilamentProfileMeasurement
    ].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationUpdateFilamentProfileMeasurement,
        request,
      ),
    ),
  saveFilamentCalibrationWizardState: async (
    request: CalibrationSaveFilamentWizardStateRequest,
  ): Promise<CalibrationSaveFilamentWizardStateResponse> =>
    ipcSchemas[IpcChannel.CalibrationSaveFilamentWizardState].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationSaveFilamentWizardState,
        request,
      ),
    ),
  getFilamentCalibrationWizardState: async (
    request: CalibrationGetFilamentWizardStateRequest,
  ): Promise<CalibrationGetFilamentWizardStateResponse> =>
    ipcSchemas[IpcChannel.CalibrationGetFilamentWizardState].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationGetFilamentWizardState,
        request,
      ),
    ),
  clearFilamentCalibrationWizardState: async (
    request: CalibrationClearFilamentWizardStateRequest,
  ): Promise<CalibrationClearFilamentWizardStateResponse> =>
    ipcSchemas[IpcChannel.CalibrationClearFilamentWizardState].response.parse(
      await ipcRenderer.invoke(
        IpcChannel.CalibrationClearFilamentWizardState,
        request,
      ),
    ),
  listRetargetProfiles: (): Promise<RetargetListProfilesResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RetargetListProfiles,
    ) as Promise<RetargetListProfilesResponse>,
  importRetargetProfile: (): Promise<RetargetImportProfileResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RetargetImportProfile,
    ) as Promise<RetargetImportProfileResponse>,
  preflightRetarget: (
    request: RetargetPreflightRequest,
  ): Promise<RetargetPreflightResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RetargetPreflight,
      request,
    ) as Promise<RetargetPreflightResponse>,
  buildRetarget: async (
    request: RetargetBuildRequest,
  ): Promise<RetargetBuildResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RetargetBuild,
      request,
    ) as Promise<RetargetBuildResponse>,
  loadRetargetScene: (
    request: RetargetLoadSceneRequest,
  ): Promise<RetargetLoadSceneResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RetargetLoadScene,
      request,
    ) as Promise<RetargetLoadSceneResponse>,
  saveRetargetAs: (
    request: RetargetSaveAsRequest,
  ): Promise<RetargetSaveAsResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RetargetSaveAs,
      request,
    ) as Promise<RetargetSaveAsResponse>,
  disposeRetarget: (
    request: RetargetDisposeRequest,
  ): Promise<RetargetDisposeResponse> =>
    ipcRenderer.invoke(
      IpcChannel.RetargetDispose,
      request,
    ) as Promise<RetargetDisposeResponse>,
};

contextBridge.exposeInMainWorld('printFarmer', api);
