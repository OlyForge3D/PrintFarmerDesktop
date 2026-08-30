import { z } from 'zod';

/**
 * Versioned IPC contract shared between the Electron main process and the
 * renderer. Every channel has a Zod schema so the main process can validate
 * untrusted renderer input at runtime, and the renderer gets static types.
 *
 * The renderer never receives a generic filesystem, shell, or network
 * primitive; it may only invoke the explicit channels defined here.
 */

export const IPC_CONTRACT_VERSION = 6 as const;

/** Channel names. Keep these stable; bump IPC_CONTRACT_VERSION on breaks. */
export const IpcChannel = {
  // --- Printer Calibration transport (issue #52) ---------------------------
  CalibrationGetAvailability: 'calibration:getAvailability',
  CalibrationListPrinters: 'calibration:listPrinters',
  CalibrationGetPrinterContext: 'calibration:getPrinterContext',
  CalibrationListWorkspaceStates: 'calibration:listWorkspaceStates',
  CalibrationGetWorkspaceState: 'calibration:getWorkspaceState',
  CalibrationSaveWorkspaceState: 'calibration:saveWorkspaceState',
  CalibrationSyncNow: 'calibration:syncNow',
  CalibrationGetDiagnostics: 'calibration:getDiagnostics',
  // --- Conflict resolution (restored by issue #762 after PR #757 removed
  // the renderer-facing channels; the sidecar/main-process resolve logic was
  // never removed) -----------------------------------------------------------
  CalibrationResolveConflict: 'calibration:resolveConflict',
  CalibrationListConflicts: 'calibration:listConflicts',
  // --- Queue reconciliation (issue #54) ------------------------------------
  CalibrationPollQueueChanges: 'calibration:pollQueueChanges',
  CalibrationGetSubscriptionResources: 'calibration:getSubscriptionResources',
  CalibrationListOrcaProfiles: 'calibration:listOrcaProfiles',
  CalibrationExportOrcaProfile: 'calibration:exportOrcaProfile',
  // --- Machine → process → filament profile cascade ------------------------
  // Five channels for the cascading profile picker: step 1 of the filament
  // calibration workflow ("select the machine profile, the process profile,
  // then typically a generic filament profile"). The PUT that used to persist
  // the picks on a printer row belonged to the printer-calibration setup
  // flow and was removed on 2026-08-23 (see
  // `.squad/decisions/inbox/vasquez-filament-calibration-reframe.md`).
  CalibrationListExtendedProfiles: 'calibration:listExtendedProfiles',
  CalibrationListMachineProfilesForModel:
    'calibration:listMachineProfilesForModel',
  CalibrationListProcessProfilesForMachines:
    'calibration:listProcessProfilesForMachines',
  CalibrationListFilamentProfilesForMachines:
    'calibration:listFilamentProfilesForMachines',
  CalibrationListCustomProfiles: 'calibration:listCustomProfiles',
  // --- On-demand system profile identity resolution (issue #766) -----------
  // PrintFarmer#2004 shipped `POST /api/slicer/profiles/resolve-for-model`,
  // gated only by `Calibration.Update` (a scope the desktop already holds).
  // A system profile a catalog list returned with `guid: null` (never
  // imported into PrintFarmer's DB) is no longer a dead end: the renderer
  // resolves it by name on demand, and the server imports it transparently
  // if needed. See `CalibrationSlicerProfileRef.guid` below.
  CalibrationResolveSystemProfile: 'calibration:resolveSystemProfile',
  // --- Server-side CalibrationProject entry point (issue #798) --------------
  // Creates a `CalibrationProject` in Coach mode, bound to the chosen base
  // profile and printer, BEFORE any profile clone or local wizard state is
  // written. Alongside the clone-based write-back model for now — #795
  // (draft/promotion semantics) is what would let this project become the
  // write-back target; reconciling the two lifecycles is out of scope here.
  CalibrationCreateProject: 'calibration:createProject',
  // --- Filament calibration slice pipeline (owner reframe 2026-08-23) -------
  CalibrationCloneFilamentProfile: 'calibration:cloneFilamentProfile',
  CalibrationSubmitCalibrationSlice: 'calibration:submitCalibrationSlice',
  CalibrationGetSliceJobStatus: 'calibration:getSliceJobStatus',
  CalibrationSendSliceToPrinter: 'calibration:sendSliceToPrinter',
  CalibrationUpdateFilamentProfileMeasurement:
    'calibration:updateFilamentProfileMeasurement',
  // --- Draft-profile write-back / completion promotion (issue #795) --------
  // Moves per-method write-back off the live cloned profile onto the
  // project's server-side draft profile (attempt + `selection` observation,
  // merged server-side), and promotes the draft into a real custom filament
  // profile only when the project's lifecycle transitions to `Completed`.
  // The clone from `CalibrationCloneFilamentProfile` above remains the
  // slicing target (slicing resolves profiles by name, not by project/draft
  // reference — see `calibrationHttp.createAttempt`'s doc comment), so it is
  // NOT removed; only the *write-back* destination moves.
  CalibrationSubmitCalibrationObservation:
    'calibration:submitCalibrationObservation',
  CalibrationCompleteCalibrationProject:
    'calibration:completeCalibrationProject',
  // --- Filament calibration wizard restart resilience (issue #754) ---------
  CalibrationSaveFilamentWizardState: 'calibration:saveFilamentWizardState',
  CalibrationGetFilamentWizardState: 'calibration:getFilamentWizardState',
  CalibrationClearFilamentWizardState: 'calibration:clearFilamentWizardState',
  // -------------------------------------------------------------------------
  AppInfo: 'app:info',
  SidecarPing: 'sidecar:ping',
  LoadScene: 'model:loadScene',
  OpenModelFile: 'dialog:openModelFile',
  ExtractVendorMetadata: 'model:extractVendorMetadata',
  ExtractVendorPlateThumbnails: 'model:extractVendorPlateThumbnails',
  RenderThumbnail: 'model:renderThumbnail',
  ScanRoot: 'catalog:scanRoot',
  PreviewImport: 'catalog:previewImport',
  ImportRoot: 'catalog:importRoot',
  ListModels: 'catalog:listModels',
  ResetCatalog: 'catalog:reset',
  ListFavorites: 'catalog:listFavorites',
  AddFavorite: 'catalog:addFavorite',
  RemoveFavorite: 'catalog:removeFavorite',
  ListTags: 'catalog:listTags',
  TagsForModel: 'catalog:tagsForModel',
  AddModelTag: 'catalog:addModelTag',
  RemoveModelTag: 'catalog:removeModelTag',
  ListCollections: 'catalog:listCollections',
  CollectionsForModel: 'catalog:collectionsForModel',
  CreateCollection: 'catalog:createCollection',
  DeleteCollection: 'catalog:deleteCollection',
  AddModelToCollection: 'catalog:addModelToCollection',
  RemoveModelFromCollection: 'catalog:removeModelFromCollection',
  OpenFolder: 'dialog:openFolder',
  ListServerProfiles: 'serverProfiles:list',
  TestServerProfile: 'serverProfiles:test',
  SaveServerProfile: 'serverProfiles:save',
  SelectServerProfile: 'serverProfiles:select',
  DeleteServerProfile: 'serverProfiles:delete',
  StartUploadJob: 'uploadJobs:start',
  ListUploadJobs: 'uploadJobs:list',
  PauseUploadJob: 'uploadJobs:pause',
  ResumeUploadJob: 'uploadJobs:resume',
  CancelUploadJob: 'uploadJobs:cancel',
  RetryUploadJob: 'uploadJobs:retry',
  ConfirmLegacyUploadRetry: 'uploadJobs:confirmLegacyRetry',
  RemoveUploadJob: 'uploadJobs:remove',
  ResetUploadJobs: 'uploadJobs:reset',
  ResetApprovedRoots: 'catalog:resetApprovedRoots',
  RetargetListProfiles: 'retarget:listProfiles',
  RetargetImportProfile: 'retarget:importProfile',
  RetargetPreflight: 'retarget:preflight',
  RetargetBuild: 'retarget:build',
  RetargetLoadScene: 'retarget:loadScene',
  RetargetSaveAs: 'retarget:saveAs',
  RetargetDispose: 'retarget:dispose',
} as const;

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel];

// --- app:info -------------------------------------------------------------

export const AppInfoRequest = z.void();
export type AppInfoRequest = z.infer<typeof AppInfoRequest>;

export const AppInfoResponse = z.object({
  contractVersion: z.literal(IPC_CONTRACT_VERSION),
  appVersion: z.string(),
  platform: z.enum(['win32', 'darwin', 'linux']),
  electronVersion: z.string(),
});
export type AppInfoResponse = z.infer<typeof AppInfoResponse>;

// --- sidecar:ping ---------------------------------------------------------

export const SidecarPingRequest = z.object({
  nonce: z.string().min(1).max(128),
});
export type SidecarPingRequest = z.infer<typeof SidecarPingRequest>;

export const SidecarPingResponse = z.object({
  ok: z.boolean(),
  nonce: z.string(),
  sidecarVersion: z.string().nullable(),
});
export type SidecarPingResponse = z.infer<typeof SidecarPingResponse>;

// --- model:loadScene ------------------------------------------------------

/** Supported model formats, matching the sidecar's `ModelFormat` serde names. */
export const ModelFormat = z.enum(['stl', 'threeMf', 'obj']);
export type ModelFormat = z.infer<typeof ModelFormat>;
export const SceneLoadStatus = z.enum(['complete', 'partial', 'unsupported']);
export type SceneLoadStatus = z.infer<typeof SceneLoadStatus>;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const Mat4 = z.array(z.number()).length(16);
const Rgb = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);

export const Bounds = z.object({
  min: Vec3,
  max: Vec3,
});
export type Bounds = z.infer<typeof Bounds>;

/**
 * A named triangle range within a {@link SceneMesh}: `triangleStart` is the
 * index of the first triangle and `triangleCount` how many follow, both in
 * triangle units (multiply by three for `indices` offsets). Backs the viewer's
 * part tree. STL yields one part; 3MF yields one per build item.
 */
export const ScenePart = z.object({
  name: z.string(),
  triangleStart: z.number().int().nonnegative(),
  triangleCount: z.number().int().nonnegative(),
  status: SceneLoadStatus.default('complete'),
  statusDetail: z.string().optional(),
  partNumber: z.string().optional(),
  materialLabel: z.string().optional(),
});
export type ScenePart = z.infer<typeof ScenePart>;

export const SceneTransform = z.object({
  matrix: Mat4,
});
export type SceneTransform = z.infer<typeof SceneTransform>;

export const SceneMaterial = z.object({
  baseColor: Rgb.nullable().optional(),
  faceColors: z.array(z.number().int().min(0).max(255)).nullable().optional(),
});
export type SceneMaterial = z.infer<typeof SceneMaterial>;

export const SceneObjectMesh = z.object({
  positions: z.array(z.number()),
  indices: z.array(z.number().int().nonnegative()),
  bounds: Bounds,
});
export type SceneObjectMesh = z.infer<typeof SceneObjectMesh>;

/**
 * One scene-graph node from the sidecar. `id` is the stable instance identity;
 * `sourceId` identifies the reusable source object definition that instance came
 * from. `transform.matrix` is a local 4×4 affine matrix already laid out in the
 * row-major argument order that `THREE.Matrix4.set()` expects (translation at
 * entries 3/7/11); root objects use the scene root / plate root as their parent.
 */
export const SceneObject = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  name: z.string(),
  parentId: z.string().min(1).nullable().optional(),
  children: z.array(z.string().min(1)).default([]),
  transform: SceneTransform,
  mesh: SceneObjectMesh.nullable().optional(),
  material: SceneMaterial.default({}),
  plateId: z.string().min(1),
  buildItemIndex: z.number().int().nonnegative().nullable().optional(),
});
export type SceneObject = z.infer<typeof SceneObject>;

export const ScenePlate = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  index: z.number().int().nonnegative(),
  rootObjectIds: z.array(z.string().min(1)).default([]),
});
export type ScenePlate = z.infer<typeof ScenePlate>;

/**
 * Scene DTO v2. The sidecar still provides a legacy flattened aggregate mesh for
 * thumbnails/stats (`positions`, `indices`, `bounds`, `faceColors`, `parts`),
 * but the renderer should consume `objects` + `rootObjectIds` + `plates` as the
 * explicit Rust↔renderer contract for multi-object rendering.
 */
export const SceneMesh = z.object({
  sceneVersion: z.literal(2),
  positions: z.array(z.number()),
  indices: z.array(z.number().int().nonnegative()),
  bounds: Bounds,
  sourceFormat: ModelFormat,
  faceColors: z.array(z.number().int().min(0).max(255)).nullable().optional(),
  status: SceneLoadStatus.default('complete'),
  statusMessages: z.array(z.string()).default([]),
  parts: z.array(ScenePart).default([]),
  objects: z.array(SceneObject).default([]),
  rootObjectIds: z.array(z.string().min(1)).default([]),
  plates: z.array(ScenePlate).default([]),
});
export type SceneMesh = z.infer<typeof SceneMesh>;

export const LoadSceneRequest = z.object({
  path: z.string().min(1).max(4096),
});
export type LoadSceneRequest = z.infer<typeof LoadSceneRequest>;

export const LoadSceneResponse = SceneMesh;
export type LoadSceneResponse = z.infer<typeof LoadSceneResponse>;

// --- dialog:openModelFile -------------------------------------------------

export const OpenModelFileRequest = z.void();
export type OpenModelFileRequest = z.infer<typeof OpenModelFileRequest>;

/**
 * The file the user picked, or `null` when they cancelled the dialog. The main
 * process only ever returns a path the user explicitly selected; the renderer
 * never gets to name an arbitrary path itself.
 */
export const OpenModelFileResponse = z
  .object({
    path: z.string().min(1),
    approvalId: z.string().uuid().optional(),
  })
  .nullable();
export type OpenModelFileResponse = z.infer<typeof OpenModelFileResponse>;

// --- model:extractVendorMetadata ------------------------------------------

/**
 * The authoring slicer, matching the sidecar's `Slicer::as_str` camelCase wire
 * names. `unknown` means no slicer could be identified.
 */
export const Slicer = z.enum([
  'prusaSlicer',
  'superSlicer',
  'bambuStudio',
  'orcaSlicer',
  'cura',
  'unknown',
]);
export type Slicer = z.infer<typeof Slicer>;

/** Dublin-Core-style model metadata; every field is optional. */
export const CoreMetadata = z.object({
  title: z.string().optional(),
  designer: z.string().optional(),
  description: z.string().optional(),
  application: z.string().optional(),
  creationDate: z.string().optional(),
  modificationDate: z.string().optional(),
  licenseTerms: z.string().optional(),
  copyright: z.string().optional(),
});
export type CoreMetadata = z.infer<typeof CoreMetadata>;

/** Per-plate slice statistics from a slicer project. */
export const PlateSliceInfo = z.object({
  index: z.number().int().nonnegative().optional(),
  predictionSeconds: z.number().int().nonnegative().optional(),
  weightGrams: z.number().nonnegative().optional(),
  filamentTypes: z.array(z.string()),
});
export type PlateSliceInfo = z.infer<typeof PlateSliceInfo>;

/** Slicer-project (vendor) metadata extracted from a 3MF. */
export const VendorMetadata = z.object({
  slicer: Slicer,
  core: CoreMetadata,
  plates: z.array(PlateSliceInfo),
  thumbnails: z.array(z.string()),
});
export type VendorMetadata = z.infer<typeof VendorMetadata>;

export const ExtractVendorMetadataRequest = z.object({
  path: z.string().min(1).max(4096),
});
export type ExtractVendorMetadataRequest = z.infer<
  typeof ExtractVendorMetadataRequest
>;

export const ExtractVendorMetadataResponse = VendorMetadata;
export type ExtractVendorMetadataResponse = z.infer<
  typeof ExtractVendorMetadataResponse
>;

export const VendorPlateThumbnail = z.object({
  partName: z.string().min(1),
  plateIndex: z.number().int().nonnegative().optional(),
  pngBase64: z.string().min(1),
});
export type VendorPlateThumbnail = z.infer<typeof VendorPlateThumbnail>;

/**
 * Embedded vendor plate thumbnails from the native sidecar. Each record names
 * the 3MF ZIP part it came from and carries the PNG bytes as base64 so Dallas
 * can render or upload them without touching the filesystem.
 */
export const VendorPlateThumbnails = z.object({
  thumbnails: z.array(VendorPlateThumbnail).max(1024),
});
export type VendorPlateThumbnails = z.infer<typeof VendorPlateThumbnails>;

export const ExtractVendorPlateThumbnailsRequest = z.object({
  path: z.string().min(1).max(4096),
});
export type ExtractVendorPlateThumbnailsRequest = z.infer<
  typeof ExtractVendorPlateThumbnailsRequest
>;

export const ExtractVendorPlateThumbnailsResponse = VendorPlateThumbnails;
export type ExtractVendorPlateThumbnailsResponse = z.infer<
  typeof ExtractVendorPlateThumbnailsResponse
>;

// --- model:renderThumbnail ------------------------------------------------

export const RenderThumbnailRequest = z.object({
  path: z.string().min(1).max(4096),
  size: z.number().int().min(16).max(4096).optional(),
});
export type RenderThumbnailRequest = z.infer<typeof RenderThumbnailRequest>;

/** A rendered thumbnail as a base64-encoded PNG plus its pixel dimensions. */
export const RenderThumbnailResponse = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pngBase64: z.string().min(1),
  /**
   * Cache recipe the sidecar rendered under. Optional so an older sidecar that
   * predates cache versioning still validates; when present, callers must key
   * any persisted thumbnail by it so a parser/renderer change invalidates
   * rather than silently reuses stale pixels.
   */
  cacheRecipe: z.string().min(1).optional(),
});
export type RenderThumbnailResponse = z.infer<typeof RenderThumbnailResponse>;

// --- catalog:scanRoot / catalog:listModels --------------------------------

/** A physical file backing a logical model, mirroring the sidecar's DTO. */
export const ModelLocation = z.object({
  rootId: z.string(),
  path: z.string(),
  rootRelative: z.string(),
  size: z.number().int().nonnegative(),
  modifiedUnixSeconds: z.number().int().nullable().optional(),
  available: z.boolean(),
});
export type ModelLocation = z.infer<typeof ModelLocation>;

/** A logical model (content-hash identity) plus its physical locations. */
export const LogicalModel = z.object({
  hash: z.string().min(1),
  format: ModelFormat,
  size: z.number().int().nonnegative(),
  locations: z.array(ModelLocation),
});
export type LogicalModel = z.infer<typeof LogicalModel>;

/** Summary of one reconciliation pass over a source root. */
export const ReconcileReport = z.object({
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  hashErrors: z.number().int().nonnegative(),
});
export type ReconcileReport = z.infer<typeof ReconcileReport>;

export const ScanRootRequest = z
  .object({
    rootId: z.string().min(1).max(256),
    approvalId: z.string().uuid(),
  })
  .strict();
export type ScanRootRequest = z.infer<typeof ScanRootRequest>;

export const ScanRootResponse = ReconcileReport;
export type ScanRootResponse = z.infer<typeof ScanRootResponse>;

export const ImportFolder = z.object({
  relativePath: z.string().max(4096),
  name: z.string().min(1).max(255),
  depth: z.number().int().positive(),
  modelCount: z.number().int().nonnegative(),
});
export type ImportFolder = z.infer<typeof ImportFolder>;

export const ImportPreviewRequest = z
  .object({
    approvalId: z.string().uuid(),
  })
  .strict();
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequest>;

export const ImportPreviewResponse = z.object({
  modelCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  skippedErrors: z.number().int().nonnegative(),
  complete: z.boolean(),
  formats: z.object({
    stl: z.number().int().nonnegative(),
    threeMf: z.number().int().nonnegative(),
    obj: z.number().int().nonnegative(),
  }),
  folders: z.array(ImportFolder).max(500),
  foldersTruncated: z.boolean(),
});
export type ImportPreviewResponse = z.infer<typeof ImportPreviewResponse>;

const ImportRuleBase = z.object({
  relativePath: z.string().max(4096),
  name: z.string().trim().min(1).max(128),
});

export const ImportRule = z.discriminatedUnion('kind', [
  ImportRuleBase.extend({
    kind: z.literal('collection'),
    collectionId: z.string().min(1).max(256).optional(),
  }).strict(),
  ImportRuleBase.extend({
    kind: z.literal('tag'),
  }).strict(),
]);
export type ImportRule = z.infer<typeof ImportRule>;

export const ImportRootRequest = ScanRootRequest.extend({
  rules: z.array(ImportRule).max(1000),
  commonTags: z.array(z.string().trim().min(1).max(128)).max(100),
});
export type ImportRootRequest = z.infer<typeof ImportRootRequest>;

export const ImportRootResponse = z.object({
  report: ReconcileReport,
  modelsOrganized: z.number().int().nonnegative(),
  collectionsCreated: z.number().int().nonnegative(),
  collectionAssignments: z.number().int().nonnegative(),
  tagAssignments: z.number().int().nonnegative(),
  resolvedCollections: z
    .array(
      z.object({
        relativePath: z.string().max(4096),
        name: z.string().min(1).max(128),
        collectionId: z.string().min(1).max(256),
      }),
    )
    .max(1000),
});
export type ImportRootResponse = z.infer<typeof ImportRootResponse>;

export const ListModelsRequest = z.void();
export type ListModelsRequest = z.infer<typeof ListModelsRequest>;

export const ListModelsResponse = z.array(LogicalModel);
export type ListModelsResponse = z.infer<typeof ListModelsResponse>;

export const ResetCatalogRequest = z.void();
export type ResetCatalogRequest = z.infer<typeof ResetCatalogRequest>;

export const ResetCatalogResponse = z
  .object({
    reset: z.literal(true),
    modelsRemoved: z.number().int().nonnegative(),
    sourceRootsRemoved: z.number().int().nonnegative(),
  })
  .strict();
export type ResetCatalogResponse = z.infer<typeof ResetCatalogResponse>;

// --- catalog favorites ----------------------------------------------------

/** Content hashes the user has marked as local favorites in the catalog. */
export const ListFavoritesRequest = z.void();
export type ListFavoritesRequest = z.infer<typeof ListFavoritesRequest>;

export const ListFavoritesResponse = z.array(z.string().min(1));
export type ListFavoritesResponse = z.infer<typeof ListFavoritesResponse>;

export const FavoriteModelRequest = z.object({ hash: z.string().min(1) });
export type FavoriteModelRequest = z.infer<typeof FavoriteModelRequest>;

/** All favorite hashes after the mutation is applied. */
export const FavoriteModelResponse = z.array(z.string().min(1));
export type FavoriteModelResponse = z.infer<typeof FavoriteModelResponse>;

// --- catalog tags ---------------------------------------------------------

/** A user-defined organizational label. `id` is the normalized name. */
export const Tag = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type Tag = z.infer<typeof Tag>;

export const ListTagsRequest = z.void();
export type ListTagsRequest = z.infer<typeof ListTagsRequest>;

export const ListTagsResponse = z.array(Tag);
export type ListTagsResponse = z.infer<typeof ListTagsResponse>;

export const TagsForModelRequest = z.object({ hash: z.string().min(1) });
export type TagsForModelRequest = z.infer<typeof TagsForModelRequest>;

export const TagsForModelResponse = z.array(Tag);
export type TagsForModelResponse = z.infer<typeof TagsForModelResponse>;

export const AddModelTagRequest = z.object({
  hash: z.string().min(1),
  name: z.string().min(1).max(128),
});
export type AddModelTagRequest = z.infer<typeof AddModelTagRequest>;

/** All tags for the model after the change. */
export const AddModelTagResponse = z.array(Tag);
export type AddModelTagResponse = z.infer<typeof AddModelTagResponse>;

export const RemoveModelTagRequest = z.object({
  hash: z.string().min(1),
  tagId: z.string().min(1),
});
export type RemoveModelTagRequest = z.infer<typeof RemoveModelTagRequest>;

export const RemoveModelTagResponse = z.array(Tag);
export type RemoveModelTagResponse = z.infer<typeof RemoveModelTagResponse>;

// --- catalog collections --------------------------------------------------

/** A user-owned, many-to-many grouping of models. */
export const Collection = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sharedToFarm: z.boolean(),
  memberCount: z.number().int().nonnegative(),
});
export type Collection = z.infer<typeof Collection>;

export const ListCollectionsRequest = z.void();
export type ListCollectionsRequest = z.infer<typeof ListCollectionsRequest>;

export const ListCollectionsResponse = z.array(Collection);
export type ListCollectionsResponse = z.infer<typeof ListCollectionsResponse>;

export const CollectionsForModelRequest = z.object({
  hash: z.string().min(1),
});
export type CollectionsForModelRequest = z.infer<
  typeof CollectionsForModelRequest
>;

export const CollectionsForModelResponse = z.array(Collection);
export type CollectionsForModelResponse = z.infer<
  typeof CollectionsForModelResponse
>;

export const CreateCollectionRequest = z.object({
  name: z.string().min(1).max(128),
});
export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequest>;

export const CreateCollectionResponse = Collection;
export type CreateCollectionResponse = z.infer<typeof CreateCollectionResponse>;

export const DeleteCollectionRequest = z.object({ id: z.string().min(1) });
export type DeleteCollectionRequest = z.infer<typeof DeleteCollectionRequest>;

/** All collections after the delete. */
export const DeleteCollectionResponse = z.array(Collection);
export type DeleteCollectionResponse = z.infer<typeof DeleteCollectionResponse>;

export const CollectionMembershipRequest = z.object({
  collectionId: z.string().min(1),
  hash: z.string().min(1),
});
export type CollectionMembershipRequest = z.infer<
  typeof CollectionMembershipRequest
>;

/** The model's collections after the membership change. */
export const CollectionMembershipResponse = z.array(Collection);
export type CollectionMembershipResponse = z.infer<
  typeof CollectionMembershipResponse
>;

// --- dialog:openFolder ----------------------------------------------------

export const OpenFolderRequest = z.void();
export type OpenFolderRequest = z.infer<typeof OpenFolderRequest>;

/** The folder the user picked, or `null` when they cancelled the dialog. */
export const OpenFolderResponse = z
  .object({
    path: z.string().min(1),
    approvalId: z.string().uuid(),
  })
  .strict()
  .nullable();
export type OpenFolderResponse = z.infer<typeof OpenFolderResponse>;

// --- PrintFarmer server profiles ------------------------------------------

export const ServerAuthMode = z.enum(['apiKey', 'password']);
export type ServerAuthMode = z.infer<typeof ServerAuthMode>;

export const ServerVersion = z
  .object({
    service: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    commit: z
      .string()
      .max(128)
      .nullish()
      .transform((value) => value ?? null),
    environment: z.string().min(1).max(64),
    runtime: z.string().min(1).max(128),
    timestamp: z.string().datetime(),
  })
  .strict();
export type ServerVersion = z.infer<typeof ServerVersion>;

export const ServerCapabilities = z
  .object({
    architecture: z.string().min(1).max(128),
    slicingEnabled: z.boolean(),
    modelFilesEnabled: z.boolean(),
    thumbnailGenerationEnabled: z.boolean(),
    gcodeUploadEnabled: z.boolean(),
    clientThumbnailUploadEnabled: z.boolean().optional().default(false),
    idempotentModelUploadEnabled: z.boolean().optional().default(false),
    modelThumbnailReplacementEnabled: z.boolean().optional().default(false),
    platformNote: z
      .string()
      .max(1024)
      .nullish()
      .transform((value) => value ?? null),
    operatorFeatures: z.record(z.boolean()).optional(),
  })
  .strict();
export type ServerCapabilities = z.infer<typeof ServerCapabilities>;

export const FeatureAvailability = z
  .object({
    modelUpload: z
      .object({
        available: z.boolean(),
        mode: z.enum(['modern', 'legacyModelOnly', 'unavailable']).optional(),
        reason: z.string().max(256).nullable(),
      })
      .transform((value) => ({
        ...value,
        mode: value.mode ?? (value.available ? 'modern' : 'unavailable'),
      })),
    librarySync: z.object({
      available: z.boolean(),
      reason: z.string().max(256).nullable(),
    }),
    clientThumbnailUpload: z.object({
      available: z.boolean(),
      reason: z.string().max(256).nullable(),
    }),
    serverThumbnailFallback: z
      .object({
        available: z.boolean(),
        reason: z.string().max(256).nullable(),
      })
      .default({
        available: false,
        reason: 'Server-thumbnail fallback is not required.',
      }),
  })
  .strict();
export type FeatureAvailability = z.infer<typeof FeatureAvailability>;

export const ServerProfile = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().min(1).max(80),
    baseUrl: z.string().url().max(2048),
    authMode: ServerAuthMode,
    username: z.string().min(1).max(256).optional(),
    version: ServerVersion.nullable(),
    capabilities: ServerCapabilities.nullable(),
    availability: FeatureAvailability,
    status: z.enum(['connected', 'error', 'legacy']),
    lastCheckedAt: z.string().datetime(),
    warnings: z.array(z.enum(['insecureHttp', 'legacy'])).max(2),
  })
  .strict();
export type ServerProfile = z.infer<typeof ServerProfile>;

const ApiKeyCredentials = z
  .object({
    authMode: z.literal('apiKey'),
    apiKey: z.string().min(1).max(4096),
  })
  .strict();

const PasswordCredentials = z
  .object({
    authMode: z.literal('password'),
    username: z.string().trim().min(1).max(256),
    password: z.string().min(1).max(4096),
    rememberMe: z.boolean().default(true),
  })
  .strict();

export const ServerProfileDraft = z
  .object({
    id: z.string().uuid().optional(),
    displayName: z.string().trim().min(1).max(80),
    baseUrl: z.string().trim().min(1).max(2048),
    credentials: z.discriminatedUnion('authMode', [
      ApiKeyCredentials,
      PasswordCredentials,
    ]),
    allowLegacy: z.boolean(),
  })
  .strict();
export type ServerProfileDraft = z.infer<typeof ServerProfileDraft>;

export const ListServerProfilesRequest = z.void();
export const ListServerProfilesResponse = z
  .object({
    profiles: z.array(ServerProfile).max(100),
    selectedProfileId: z.string().uuid().nullable(),
  })
  .strict();
export type ListServerProfilesResponse = z.infer<
  typeof ListServerProfilesResponse
>;

export const TestServerProfileRequest = z.discriminatedUnion('source', [
  z.object({ source: z.literal('saved'), id: z.string().uuid() }).strict(),
  z.object({ source: z.literal('draft'), draft: ServerProfileDraft }).strict(),
]);
export type TestServerProfileRequest = z.infer<typeof TestServerProfileRequest>;
export const TestServerProfileResponse = ServerProfile;
export type TestServerProfileResponse = z.infer<
  typeof TestServerProfileResponse
>;

export const SaveServerProfileRequest = ServerProfileDraft;
export type SaveServerProfileRequest = z.infer<typeof SaveServerProfileRequest>;
export const SaveServerProfileResponse = ServerProfile;
export type SaveServerProfileResponse = z.infer<
  typeof SaveServerProfileResponse
>;

export const SelectServerProfileRequest = z
  .object({ id: z.string().uuid() })
  .strict();
export type SelectServerProfileRequest = z.infer<
  typeof SelectServerProfileRequest
>;
export const SelectServerProfileResponse = ServerProfile;
export type SelectServerProfileResponse = z.infer<
  typeof SelectServerProfileResponse
>;

export const DeleteServerProfileRequest = SelectServerProfileRequest;
export type DeleteServerProfileRequest = z.infer<
  typeof DeleteServerProfileRequest
>;
export const DeleteServerProfileResponse = ListServerProfilesResponse;
export type DeleteServerProfileResponse = z.infer<
  typeof DeleteServerProfileResponse
>;

// --- durable model upload jobs ---------------------------------------------

export const UploadItemState = z.enum([
  'queued',
  'uploading',
  'succeeded',
  'failed',
  'cancelled',
  'uncertain',
]);
export type UploadItemState = z.infer<typeof UploadItemState>;

export const UploadError = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(1024),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().nonnegative().max(86_400).nullable(),
    duplicateRisk: z.boolean(),
  })
  .strict();
export type UploadError = z.infer<typeof UploadError>;

export const RemoteUploadResult = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(1024),
    fileName: z.string().min(1).max(1024),
    fileSize: z.number().int().nonnegative(),
    fileType: z.string().min(1).max(128),
    uploadedAt: z.string().datetime(),
    url: z.string().max(4096),
    thumbnailUrl: z.string().max(4096).nullable(),
    wasExisting: z.boolean(),
    clientUploadId: z.string().uuid().nullable(),
    etag: z.string().min(1).max(1024).nullable(),
  })
  .strict();
export type RemoteUploadResult = z.infer<typeof RemoteUploadResult>;

export const UploadJobItem = z
  .object({
    id: z.string().uuid(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    clientUploadId: z.string().uuid(),
    displayName: z.string().min(1).max(1024),
    size: z.number().int().nonnegative().max(512_000_000),
    state: UploadItemState,
    bytesSent: z.number().int().nonnegative().max(512_000_000),
    attempts: z.number().int().nonnegative().max(10_000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    remote: RemoteUploadResult.nullable(),
    error: UploadError.nullable(),
  })
  .strict();
export type UploadJobItem = z.infer<typeof UploadJobItem>;

export const UploadJobState = z.enum([
  'running',
  'paused',
  'completed',
  'partialFailure',
  'cancelled',
  'attention',
]);
export type UploadJobState = z.infer<typeof UploadJobState>;

export const UploadJob = z
  .object({
    id: z.string().uuid(),
    profileId: z.string().uuid(),
    profileName: z.string().min(1).max(80),
    profileRevision: z.string().min(1).max(128).default('legacy-unbound'),
    serverBinding: z.string().min(1).max(128).default('legacy-unbound'),
    mode: z.enum(['modern', 'legacyModelOnly']),
    state: UploadJobState,
    paused: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    items: z.array(UploadJobItem).min(1).max(500),
    totalBytes: z.number().int().nonnegative(),
    bytesSent: z.number().int().nonnegative(),
    summary: z
      .object({
        queued: z.number().int().nonnegative(),
        uploading: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        cancelled: z.number().int().nonnegative(),
        uncertain: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type UploadJob = z.infer<typeof UploadJob>;

export const StartUploadJobRequest = z
  .object({
    profileId: z.string().uuid(),
    hashes: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(500)
      .refine((hashes) => new Set(hashes).size === hashes.length, {
        message: 'Upload hashes must be unique.',
      }),
  })
  .strict();
export type StartUploadJobRequest = z.infer<typeof StartUploadJobRequest>;
export const StartUploadJobResponse = UploadJob;
export type StartUploadJobResponse = z.infer<typeof StartUploadJobResponse>;

export const ListUploadJobsRequest = z.void();
export const ListUploadJobsResponse = z.array(UploadJob).max(100);
export type ListUploadJobsResponse = z.infer<typeof ListUploadJobsResponse>;

export const UploadJobRequest = z.object({ jobId: z.string().uuid() }).strict();
export type UploadJobRequest = z.infer<typeof UploadJobRequest>;
export const UploadJobResponse = UploadJob;
export type UploadJobResponse = z.infer<typeof UploadJobResponse>;
export const RemoveUploadJobResponse = z
  .object({ removed: z.literal(true) })
  .strict();
export type RemoveUploadJobResponse = z.infer<typeof RemoveUploadJobResponse>;
export const ResetUploadJobsRequest = z.void();
export const ResetUploadJobsResponse = z
  .object({ reset: z.literal(true), backupCreated: z.boolean() })
  .strict();
export type ResetUploadJobsResponse = z.infer<typeof ResetUploadJobsResponse>;
export const ResetApprovedRootsRequest = z.void();
export const ResetApprovedRootsResponse = z
  .object({ reset: z.literal(true) })
  .strict();
export type ResetApprovedRootsResponse = z.infer<
  typeof ResetApprovedRootsResponse
>;
// ==========================================================================
// Printer Calibration transport — shared IPC contract (issue #52)
// ==========================================================================
//
// All calibration IPC types follow the same additive principle used throughout
// this file: Zod schemas validated at the main-process boundary keep the
// renderer presentation-only and secret-free.
//
// IMPORTANT: the renderer may never receive credentials, raw JWT tokens,
// API keys, or arbitrary file paths. Every field below is deliberately scoped.

// --- Calibration capability flags ------------------------------------------

/**
 * Negotiated end-to-end capability flags discovered during availability
 * negotiation.
 *
 * `calibrationApiEnabled`, `calibrationChangeFeedEnabled` and
 * `calibrationOfflineDraftEnabled` are preconditions: if any is false the
 * feature gate returns a typed unavailable reason. The remaining flags switch
 * individual features on and off and are surfaced so the workspace can disable
 * just those actions.
 */
export const CalibrationCapabilityFlags = z
  .object({
    /** Server exposes calibration REST APIs. Required. */
    calibrationApiEnabled: z.boolean(),
    /** Server emits calibration change-feed events. Required. */
    calibrationChangeFeedEnabled: z.boolean(),
    /** Server accepts offline draft push via calibration sync. Required. */
    calibrationOfflineDraftEnabled: z.boolean(),
    /** Server can accept staged photo uploads for calibration. Optional. */
    calibrationPhotoUploadEnabled: z.boolean(),
    /**
     * Server supports calibration generation and slicing. Optional: this needs
     * an online slicing worker attesting a pinned upstream OrcaSlicer build,
     * which many deployments will not run. Recording measured results by hand
     * stays available when it is false. Does not gate promotion of a produced
     * artifact — see `calibrationArtifactPromotionEnabled` below.
     */
    calibrationGenerationEnabled: z.boolean(),
    /**
     * Server accepts promotion of a produced calibration artifact. Optional
     * and distinct from `calibrationGenerationEnabled`: a deployment can have
     * a working slicing fleet (so `generate` succeeds) while its promotion
     * checkpoint store or reconciler is unhealthy, in which case a produced
     * artifact cannot be promoted. `applyPatch` requires this flag in
     * addition to generation; `generate` does not.
     */
    calibrationArtifactPromotionEnabled: z.boolean(),
  })
  .passthrough();
export type CalibrationCapabilityFlags = z.infer<
  typeof CalibrationCapabilityFlags
>;

/**
 * Whether the server advertised a value for a capability flag's backing
 * field at all — `'unknown'` means the field was absent from the response,
 * so availability could not be determined from what the server sent
 * (#493). `flags` above fails closed to `false` for `'unknown'` too; this is
 * the only place a caller can tell "the server said no" apart from "the
 * server said nothing".
 */
export const CalibrationFlagAdvertisement = z.enum([
  'true',
  'false',
  'unknown',
]);
export type CalibrationFlagAdvertisement = z.infer<
  typeof CalibrationFlagAdvertisement
>;

/** Per-flag advertisement state, keyed the same as {@link CalibrationCapabilityFlags}. */
export const CalibrationCapabilityFlagAdvertisement = z
  .object({
    calibrationApiEnabled: CalibrationFlagAdvertisement,
    calibrationChangeFeedEnabled: CalibrationFlagAdvertisement,
    calibrationOfflineDraftEnabled: CalibrationFlagAdvertisement,
    calibrationPhotoUploadEnabled: CalibrationFlagAdvertisement,
    calibrationGenerationEnabled: CalibrationFlagAdvertisement,
    calibrationArtifactPromotionEnabled: CalibrationFlagAdvertisement,
  })
  .passthrough();
export type CalibrationCapabilityFlagAdvertisement = z.infer<
  typeof CalibrationCapabilityFlagAdvertisement
>;

/**
 * Canonical permissions, spelled exactly as PrintFarmer emits them in the
 * capability payload's `effectivePermissions` member.
 *
 * Three resources appear here, and they are not interchangeable. Calibration
 * endpoints require `calibration:*`; the job queue requires `queue:*`; slicing
 * submission requires `slicing:*`. A principal may hold one family and not
 * another, so treating any of them as a stand-in for another would authorise
 * work the server is about to refuse.
 *
 * Earlier desktop builds asserted a PascalCase JWT-scope vocabulary
 * (`CalibrationRead`, `CalibrationWrite`) that no PrintFarmer build has ever
 * produced, so every check against it was dead: `grantedScopes` is populated
 * straight from `effectivePermissions`, and a PascalCase needle can never be
 * found in a `resource:action` haystack.
 */
export const CALIBRATION_PERMISSIONS = {
  /** List candidates, read a printer's calibration context, resolve profiles. */
  read: 'calibration:read',
  /** Create a calibration project. */
  create: 'calibration:create',
  /** Mutate an existing project: steps, attempts, measurements, sync. */
  update: 'calibration:update',
  /** Request profile generation from recorded results. */
  generate: 'calibration:generate',
  /** Submit the slicing job generation depends on. */
  slicingSubmit: 'slicing:submit',
  /** Create a job-queue entry (`POST /api/job-queue`). */
  queueWrite: 'queue:write',
  /** Read a job-queue entry (`GET /api/job-queue/{id}`). */
  queueRead: 'queue:read',
  /** Acknowledge that a printer's bed is clear. */
  queueAcknowledgeBedClear: 'queue:acknowledge-bed-clear',
  /** Release an acknowledged job for dispatch. */
  queueStart: 'queue:start',
} as const;
export const CalibrationPermission = z.enum([
  CALIBRATION_PERMISSIONS.read,
  CALIBRATION_PERMISSIONS.create,
  CALIBRATION_PERMISSIONS.update,
  CALIBRATION_PERMISSIONS.generate,
  CALIBRATION_PERMISSIONS.slicingSubmit,
  CALIBRATION_PERMISSIONS.queueWrite,
  CALIBRATION_PERMISSIONS.queueRead,
  CALIBRATION_PERMISSIONS.queueAcknowledgeBedClear,
  CALIBRATION_PERMISSIONS.queueStart,
]);
export type CalibrationPermission = z.infer<typeof CalibrationPermission>;

/**
 * Legacy spellings accepted *only* when the server literally advertises them.
 *
 * This is not a grant-widening fallback: a permission is satisfied by an alias
 * solely because the server named that alias in its own response. Nothing is
 * inferred, defaulted, or synthesised, so a server that grants no calibration
 * permission still reads as granting none.
 *
 * Only the calibration family has legacy spellings. The queue and slicing
 * permissions have never had a PascalCase form, and inventing one would be
 * fabricating a grant rather than recognising one.
 */
const CALIBRATION_PERMISSION_ALIASES: Readonly<
  Record<CalibrationPermission, readonly string[]>
> = {
  [CALIBRATION_PERMISSIONS.read]: ['CalibrationRead'],
  [CALIBRATION_PERMISSIONS.create]: ['CalibrationWrite'],
  [CALIBRATION_PERMISSIONS.update]: ['CalibrationWrite'],
  [CALIBRATION_PERMISSIONS.generate]: ['CalibrationGenerate'],
  [CALIBRATION_PERMISSIONS.slicingSubmit]: [],
  [CALIBRATION_PERMISSIONS.queueWrite]: [],
  [CALIBRATION_PERMISSIONS.queueRead]: [],
  [CALIBRATION_PERMISSIONS.queueAcknowledgeBedClear]: [],
  [CALIBRATION_PERMISSIONS.queueStart]: [],
};

/**
 * Whether the server granted one exact permission.
 *
 * Three ways a permission can be satisfied, in decreasing directness:
 *
 * 1. The exact `resource:action` string.
 * 2. A same-resource `resource:admin` grant. PrintFarmer authorises
 *    `queue:admin` as covering `queue:read`/`write`/`start`/`acknowledge-bed-clear`,
 *    and likewise for `calibration:` and `slicing:`, and the capability payload
 *    may expose the raw grant rather than its expansion. Implication is strictly
 *    **within** a resource: `queue:admin` says nothing about calibration, and no
 *    admin grant implies another resource's admin.
 * 3. A legacy PascalCase spelling, and only when the server literally sent it.
 *
 * `null` scopes mean "never negotiated", which is not the same as "denied" and
 * is reported as not-granted here; callers that must distinguish the two should
 * test the null themselves before asking.
 */
export function hasCalibrationPermission(
  grantedScopes: readonly string[] | null | undefined,
  permission: CalibrationPermission,
): boolean {
  if (grantedScopes == null) return false;
  if (grantedScopes.includes(permission)) return true;
  // Same resource only. Splitting on the first colon keeps `queue:admin` from
  // ever satisfying a `calibration:` or `slicing:` permission, which is the
  // substitution the per-route mapping exists to prevent.
  const resource = permission.slice(0, permission.indexOf(':'));
  if (resource !== '' && grantedScopes.includes(`${resource}:admin`)) {
    return true;
  }
  return CALIBRATION_PERMISSION_ALIASES[permission].some((alias) =>
    grantedScopes.includes(alias),
  );
}

/**
 * A capability the server refuses to offer today, with the machine-readable
 * reason code and human message it reported. Verbatim projection of the
 * `PlatformCapabilitiesDto.unavailableReasons[]` entries from PrintFarmer.
 *
 * Surfaced through {@link CalibrationAvailability} so the renderer can
 * explain a `missingCapabilityFlags` refusal or a disabled `calibrationGenerationEnabled`
 * in the operator's own words rather than flattening the refusal into one
 * opaque boolean. The set of `feature` names is not enumerated here: the
 * server may report reasons for capabilities the desktop does not gate on,
 * and the renderer decides which to display.
 */
export const CalibrationServerUnavailableReason = z
  .object({
    /** Short capability name, e.g. `calibrationGeneration`, `slicing`. */
    feature: z.string().min(1).max(128),
    /** Machine-readable code, e.g. `slicer_registry_unavailable`. */
    code: z.string().min(1).max(128),
    /** Human-readable explanation, safe to display to the operator. */
    message: z.string().max(1024),
  })
  .strict();
export type CalibrationServerUnavailableReason = z.infer<
  typeof CalibrationServerUnavailableReason
>;

/**
 * Typed reason why calibration is unavailable on a given server profile.
 * Returned as a discriminated union so the renderer can render a meaningful
 * help message without inspecting raw error text.
 */
export const CalibrationUnavailableReason = z.enum([
  /** Server API or schema version does not meet the minimum requirement. */
  'serverVersionTooLow',
  /** Required JWT scopes are absent from the current token. */
  'missingScopes',
  /** Firmware dialect must be exactly Klipper/Klipper — other dialects are unsupported. */
  'unsupportedFirmware',
  /** The upstream OrcaSlicer identity is not present or not the required version. */
  'unsupportedSlicer',
  /** One or more E2E capability flags are missing/disabled. */
  'missingCapabilityFlags',
  /** Server returned calibration APIs as explicitly disabled by the operator. */
  'operatorDisabled',
  /** Server profile is legacy/incompatible (no API negotiation). */
  'legacyServer',
  /**
   * The token was rejected outright: the short-lived desktop JWT expired or was
   * revoked. Distinct from `missingScopes`, which means the identity was
   * accepted and the rights were not there — that one needs an administrator,
   * this one needs a reconnect.
   */
  'sessionExpired',
  /** No server profile is selected. */
  'noProfile',
]);
export type CalibrationUnavailableReason = z.infer<
  typeof CalibrationUnavailableReason
>;

/** Effective printer calibration availability for the selected server profile. */
export const CalibrationAvailability = z
  .object({
    available: z.boolean(),
    /** Populated when `available` is false; typed reason for the UI. */
    unavailableReason: CalibrationUnavailableReason.nullable(),
    /** Human-readable elaboration of the unavailability (never a credential). */
    unavailableDetail: z.string().max(512).nullable(),
    /** Negotiated server API version that gates calibration. */
    negotiatedApiVersion: z.string().max(64).nullable(),
    /** Negotiated schema version for the calibration change feed (e.g. "1.0"). */
    negotiatedSchemaVersion: z.string().max(64).nullable(),
    /** The effective capability flags discovered during negotiation. */
    capabilityFlags: CalibrationCapabilityFlags.nullable(),
    /** The JWT scopes present in the current token (never the token itself). */
    grantedScopes: z.array(z.string().max(64)).max(32).nullable(),
    /** Whether offline drafts and photo staging are currently enabled. */
    offlineEditingEnabled: z.boolean(),
    /**
     * Server-reported diagnostics for capabilities the deployment cannot
     * currently offer. Always present (empty array when the server did not
     * report any). This is what turns a `missingCapabilityFlags` or a
     * `capabilityFlags.calibrationGenerationEnabled: false` into a message
     * the operator can read — otherwise the refusal collapses to a bare
     * boolean and neither the renderer nor the operator can tell why.
     */
    serverUnavailableReasons: z
      .array(CalibrationServerUnavailableReason)
      .max(64),
  })
  .strict();
export type CalibrationAvailability = z.infer<typeof CalibrationAvailability>;

export const CalibrationGetAvailabilityRequest = z.void();
export type CalibrationGetAvailabilityRequest = z.infer<
  typeof CalibrationGetAvailabilityRequest
>;
export const CalibrationGetAvailabilityResponse = CalibrationAvailability;
export type CalibrationGetAvailabilityResponse = z.infer<
  typeof CalibrationGetAvailabilityResponse
>;

// --- Printer candidates and context ----------------------------------------

/** Klipper firmware and G-code dialect identity (both must be Klipper). */
export const KlipperFirmwareInfo = z
  .object({
    firmware: z.literal('Klipper'),
    gcodeDialect: z.literal('Klipper'),
    firmwareVersion: z.string().max(128).nullable(),
    klipperConfigHash: z.string().max(256).nullable(),
  })
  .strict();
export type KlipperFirmwareInfo = z.infer<typeof KlipperFirmwareInfo>;

/**
 * PrintFarmer's complete, explicit calibration eligibility assertion.
 * Anything incomplete or carrying a different literal is represented as null.
 */
export const CalibrationPrinterEligibility = z
  .object({
    firmwareFamily: z.literal('Klipper'),
    gcodeDialect: z.literal('Klipper'),
    slicerFamily: z.literal('OrcaSlicer'),
    slicerDistribution: z.literal('upstream'),
    slicerIdentity: z.literal('OrcaSlicer'),
    hardwareContextComplete: z.literal(true),
    safetyContextComplete: z.literal(true),
    permissionsComplete: z.literal(true),
    reasons: z.array(z.never()).max(0),
  })
  .strict();
export type CalibrationPrinterEligibility = z.infer<
  typeof CalibrationPrinterEligibility
>;

/** Summary of one PrintFarmer-managed printer that can be selected for calibration. */
/**
 * Every rejection reason code PrintFarmer's calibration eligibility evaluator
 * can emit.
 *
 * Extracted from the `Reject`/`RejectMissing` call sites in
 * `PrinterCalibrationContextService.cs` on OlyForge3D/PrintFarmer@development,
 * pinned at blob `eb67837` (commit `1994f68e`, 2026-08-11) — including the
 * transitive ones, since `RequireValue`, `RequireString` and `RequirePositive`
 * all funnel into `RejectMissing`.
 *
 * Two sources, because one of them is invisible to the obvious method. 97 of
 * these appear in that file as string literals. The remaining six do not
 * appear there at all: `CalibrationProfileSafetyValidator.Validate` returns a
 * `CalibrationProfileSafetyResult`, and the service forwards it as
 * `Reject(reasons, missingInputs, safety.Code!, safety.Field!, ...)` — the code
 * is a *variable* at that call site, so scanning the service for literals
 * finds nothing and silently reports a complete catalogue. Any future audit
 * has to follow indirection out of the file, not just grep inside it; the six
 * `profile_contains_*` / `profile_json_*` codes are the ones that method
 * misses, and they were missing here until a review caught it.
 *
 * Counted at that pin: 103 codes, all of which the candidate route can emit,
 * and all of which are listed here. `status_stale`, `status_unknown` and
 * `status_unsupported` are genuine server codes despite looking client-side —
 * they are `Reject`/`RejectMissing` call sites in the same file.
 *
 * This is an allowlist, not documentation. `rejectionReasonCodes` was
 * introduced specifically so the renderer would receive a bounded machine
 * token instead of the server's free-text `message`, but accepting any short
 * string as a "code" left that property asserted rather than enforced: a
 * hostile or buggy server could put arbitrary prose in `code` and it would
 * reach the renderer anyway. Validating against this catalogue is what makes
 * the claim true.
 *
 * Erring generous is deliberate. An extra member is inert, whereas a missing
 * one degrades a real diagnosis to
 * {@link UNRECOGNIZED_CALIBRATION_REASON_CODE} — informative but less useful.
 */
export const CALIBRATION_REJECTION_REASON_CODES = [
  'active_toolhead_invalid',
  'active_toolhead_missing',
  'bed_origin_x_missing',
  'bed_origin_y_missing',
  'build_volume_x_missing',
  'build_volume_y_missing',
  'build_volume_z_missing',
  'direct_drive_state_missing',
  'drive_type_missing',
  'enclosure_state_missing',
  'excluded_regions_missing',
  'extruder_gear_ratio_missing',
  'filament_bed_temperature_exceeds_limit',
  'filament_bed_temperature_requires_heated_bed',
  'filament_hotend_temperature_exceeds_limit',
  'filament_material_missing',
  'filament_material_unsupported',
  'filament_profile_missing',
  'filament_profile_not_found',
  'firmware_detection_confidence_invalid',
  'firmware_detection_confidence_missing',
  'firmware_detection_source_unknown',
  'firmware_detection_time_missing',
  'firmware_detection_version_missing',
  'firmware_family_not_klipper',
  'firmware_family_unknown',
  'firmware_identity_unverified',
  'firmware_metadata_stale',
  'firmware_retraction_capability_missing',
  'firmware_version_missing',
  'gcode_dialect_not_klipper',
  'gcode_dialect_unknown',
  'geometry_json_invalid',
  'hardware_metadata_stale',
  'hardware_verification_time_missing',
  'heated_bed_state_missing',
  'heated_chamber_state_missing',
  'hotend_max_temperature_missing',
  'machine_profile_missing',
  'machine_profile_not_found',
  'max_acceleration_missing',
  'max_bed_temperature_missing',
  'max_chamber_temperature_missing',
  'max_print_speed_missing',
  'max_travel_acceleration_missing',
  'max_travel_speed_missing',
  'max_volumetric_flow_missing',
  'motion_type_missing',
  'multi_extruder_status_unsupported',
  'nozzle_diameter_missing',
  'nozzle_hardness_missing',
  'nozzle_material_missing',
  'nozzle_max_temperature_missing',
  'nozzle_type_missing',
  'physical_toolhead_missing',
  'pressure_advance_capability_missing',
  'printable_polygon_invalid',
  'printable_polygon_missing',
  'printer_configuration_changed',
  'printer_in_maintenance',
  'printer_not_found',
  'printer_offline',
  'process_profile_missing',
  'process_profile_not_found',
  'profile_compatibility_missing',
  'profile_contains_credential',
  'profile_contains_filesystem_path',
  'profile_contains_private_url',
  'profile_contains_unsafe_command',
  'profile_distribution_missing',
  'profile_distribution_unsupported',
  'profile_format_missing',
  'profile_format_unsupported',
  'profile_gcode_dialect_mismatch',
  'profile_gcode_dialect_missing',
  'profile_hash_mismatch',
  'profile_json_invalid',
  'profile_json_missing',
  'profile_machine_mismatch',
  'profile_nozzle_data_missing',
  'profile_nozzle_material_mismatch',
  'profile_nozzle_mismatch',
  'profile_printer_mismatch',
  'profile_printer_model_mismatch',
  'profile_revision_missing',
  'profile_service_unavailable',
  'profile_slicer_mismatch',
  'profile_version_mismatch',
  'profile_version_missing',
  'required_operations_unsupported',
  'slicer_distribution_missing',
  'slicer_distribution_unsupported',
  'slicer_engine_missing',
  'slicer_engine_unsupported',
  'slicer_version_missing',
  'slicer_version_unsupported',
  'status_stale',
  'status_unknown',
  'status_unsupported',
  'supported_materials_missing',
  'toolhead_offset_x_missing',
  'toolhead_offset_y_missing',
  'toolhead_offset_z_missing',
] as const;

/** Substituted for any reason code outside {@link CALIBRATION_REJECTION_REASON_CODES}. */
export const UNRECOGNIZED_CALIBRATION_REASON_CODE = 'unrecognized_reason';

/** Substituted for any missing-input field name that is not a plain field path. */
export const UNRECOGNIZED_CALIBRATION_INPUT = 'unrecognized_input';

/**
 * How many rejection reasons a *server* response may carry for one printer.
 *
 * A truncation threshold, not a gate. Exceeding it is legitimate — the
 * evaluator asks about a dozen questions of every toolhead, so a freshly added
 * five-toolhead machine reports well past this without the server being wrong
 * — so the list is cut here and the cut is declared with
 * {@link CALIBRATION_EXPLANATION_TRUNCATED_CODE}, never used as a reason to
 * refuse the response.
 */
export const CALIBRATION_MAX_SERVER_REJECTION_REASONS = 64;

/**
 * How many codes the renderer may receive for one printer: every server reason
 * plus the two diagnostics the client can add itself — one naming an
 * incoherent verdict, one declaring the list was truncated.
 *
 * Derived rather than written as a number, because the two bounds were once
 * both spelled `.max(64)` and that arithmetic was wrong. A server may send a
 * full 64 reasons; when that response also contradicts itself the handler
 * prepends {@link CALIBRATION_SERVER_CONTRADICTION_CODE}, and when it ran long
 * it appends {@link CALIBRATION_EXPLANATION_TRUNCATED_CODE}. The refusal that
 * followed was not local: the handler parses `{ printers: [...] }` as one
 * value, so a single over-long candidate threw away *every* printer,
 * reinstating the empty-discovery failure this contract exists to prevent. The
 * bound has to be the server's plus the client's, and saying so in arithmetic
 * is what keeps it that way when either side moves.
 */
export const CALIBRATION_MAX_REJECTION_REASON_CODES =
  CALIBRATION_MAX_SERVER_REJECTION_REASONS + 2;

/**
 * How many candidates one discovery response may describe.
 *
 * Shared by the wire schema and the IPC schema deliberately. They used to
 * disagree — 500 on the wire, 200 at IPC — so a farm of 201 to 500 printers
 * parsed cleanly off the network and was then rejected on the way to the
 * renderer, as one value, taking every healthy printer with it. Two bounds
 * that must agree should be one bound.
 */
export const CALIBRATION_MAX_PRINTER_CANDIDATES = 500;

/**
 * Emitted when the server both declares a printer eligible and supplies
 * reasons it is not.
 *
 * Not a server code: PrintFarmer never sends it. It exists so a self
 * contradicting response is *visible* rather than quietly flattened into an
 * ordinary ineligible printer, which would hide a server defect from the only
 * people able to report it.
 *
 * Because it means "the client detected this", it must be unforgeable from the
 * wire — see {@link CalibrationServerReasonCode}.
 */
export const CALIBRATION_SERVER_CONTRADICTION_CODE = 'server_contradiction';

/**
 * Emitted when the server declares a printer ineligible without raising a
 * single rejection reason.
 *
 * The mirror of {@link CALIBRATION_SERVER_CONTRADICTION_CODE}, and incoherent
 * for the same reason: PrintFarmer computes `Eligible = reasons.Count == 0`,
 * so `eligible: false` with an empty reason list asserts both that the printer
 * was refused and that there was nothing to refuse it for. Detecting only the
 * first direction left this one arriving as a printer that is simply not
 * calibratable, with an empty explanation and nothing to report.
 *
 * The response may still name missing inputs. That does not make the refusal
 * explained — `RejectMissing` records a reason beside every missing input, so
 * missing inputs without one is a second violation of the same pair, not
 * evidence against the first.
 *
 * Client-authored, like every sentinel here, and therefore excluded from
 * {@link CalibrationServerReasonCode}.
 */
export const CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE =
  'server_unexplained_refusal';

/**
 * Emitted when the server grants eligibility it has not evidenced.
 *
 * Eligibility here is explicit: the server must *name* Klipper firmware, the
 * Klipper G-code dialect and an upstream OrcaSlicer engine. A response that
 * says `eligible: true`, lists no reasons — coherent by the server's own rule
 * — and yet does not name those identities is refused by this client, which is
 * the correct outcome but was a silent one: the printer arrived ineligible
 * with no code at all.
 *
 * This is the residual case that makes "an ineligible printer can always say
 * why" true by construction rather than case by case.
 */
export const CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE =
  'client_eligibility_unverified';

/**
 * Emitted when the server said more than the renderer will carry.
 *
 * A printer can legitimately exceed the per-printer cap: the evaluator asks
 * roughly a dozen questions of every toolhead, so a five-toolhead machine that
 * has just been added reports well over sixty missing inputs without anything
 * being wrong with the server. Silently showing the first sixty-four as though
 * they were the whole story would be its own quiet lie, so the fact that the
 * list was cut is stated in the list itself.
 *
 * Client-authored, and therefore excluded from
 * {@link CalibrationServerReasonCode} like every other sentinel here.
 */
export const CALIBRATION_EXPLANATION_TRUNCATED_CODE =
  'client_explanation_truncated';

/**
 * What a *server* is allowed to say: the catalogue and nothing else.
 *
 * Deliberately narrower than {@link CalibrationRejectionReasonCode}. Both
 * sentinels are client-authored claims *about* the response —
 * `server_contradiction` means "this client caught the server contradicting
 * itself", `unrecognized_reason` means "this client did not recognise what the
 * server said". Validating raw server codes against an enum that contained
 * them let a server assert those claims itself: an ordinary ineligible printer
 * whose `code` was literally `server_contradiction` passed through unchanged
 * and became indistinguishable from the marker the client synthesizes, so the
 * one signal saying "this server emits incoherent records" could be
 * manufactured by the server it accuses.
 *
 * Excluding them here makes a forged sentinel just another unknown code, so it
 * degrades to `unrecognized_reason` like any other.
 */
const CalibrationServerReasonCode = z.enum(CALIBRATION_REJECTION_REASON_CODES);

/**
 * What the *renderer* may receive: the catalogue plus the client's own
 * sentinels, which are appended after normalisation rather than parsed out of
 * it.
 */
const CalibrationRejectionReasonCode = z.enum([
  ...CALIBRATION_REJECTION_REASON_CODES,
  UNRECOGNIZED_CALIBRATION_REASON_CODE,
  CALIBRATION_SERVER_CONTRADICTION_CODE,
  CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
  CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE,
  CALIBRATION_EXPLANATION_TRUNCATED_CODE,
]);

/**
 * Every code the renderer may be handed for a refused printer.
 *
 * Exported so the renderer's operator-facing wording can be keyed exhaustively
 * off it: a code added to the catalogue without a sentence to read out fails to
 * compile rather than reaching an operator as a bare identifier.
 */
export type CalibrationRejectionReasonCode = z.infer<
  typeof CalibrationRejectionReasonCode
>;

/**
 * A missing-input field path such as `firmware.family`,
 * `profiles.filament.material` or `profiles.machine.exactJson.gcode_flavor`.
 *
 * Constrained by shape rather than by an allowlist because the vocabulary is
 * open by design — it names fields of an evolving DTO, so an exhaustive list
 * would silently degrade real diagnoses on every server that adds a field.
 *
 * Underscores and uppercase are admitted because the server emits them. Two
 * real missing-input paths address keys *inside* an OrcaSlicer profile
 * document rather than members of the DTO, and those keys are snake_case:
 * `profiles.machine.exactJson.gcode_flavor` and
 * `profiles.machine.exactJson.nozzle_diameter` are both `RejectMissing` field
 * arguments at the pinned blob. An identifier-only pattern reduced each of
 * them to {@link UNRECOGNIZED_CALIBRATION_INPUT}, discarding the most specific
 * diagnosis PrintFarmer produces in precisely the cases where an operator has
 * to act on it.
 *
 * Only `RejectMissing` populates `missingInputs` — plain `Reject` takes the
 * set but never adds to it — so a path that appears solely on a `Reject` call
 * (`profiles.filament.exactJson.required_nozzle_HRC`, for instance) is a
 * rejection *field* and never arrives here at all. That distinction matters
 * when sourcing fixtures: asserting such a path as a missing input would test
 * a message the server does not send.
 *
 * Array indices are admitted because toolhead paths interpolate one:
 * `toolheads[{toolhead.Index}].nozzleDiameter` reaches the wire as
 * `toolheads[0].nozzleDiameter`.
 *
 * Every segment must still begin with a letter, so whitespace, markup, quotes,
 * URLs, POSIX and Windows path separators, and `..` traversal remain excluded:
 * no server-authored prose can arrive through this field.
 */
const CALIBRATION_MISSING_INPUT_PATTERN =
  /^[A-Za-z][A-Za-z0-9_]*(?:\[\d{1,3}\])?(?:\.[A-Za-z][A-Za-z0-9_]*(?:\[\d{1,3}\])?)*$/;

/**
 * The longest field path the renderer will carry.
 *
 * Exported because it is a *classification* threshold, not just a schema
 * bound: anything longer is replaced by {@link UNRECOGNIZED_CALIBRATION_INPUT}
 * on the way in, so the bound can never be the reason a response is rejected.
 */
export const CALIBRATION_MAX_FIELD_PATH_LENGTH = 128;

const CalibrationMissingInputField = z
  .string()
  .min(1)
  .max(CALIBRATION_MAX_FIELD_PATH_LENGTH)
  .refine(
    (value) =>
      value === UNRECOGNIZED_CALIBRATION_INPUT ||
      CALIBRATION_MISSING_INPUT_PATTERN.test(value),
    { message: 'Not a calibration field path.' },
  );

/**
 * Maps a server-supplied reason code onto the catalogue, substituting
 * {@link UNRECOGNIZED_CALIBRATION_REASON_CODE} for anything unknown.
 *
 * Validates against {@link CalibrationServerReasonCode}, which excludes the
 * client's own sentinels, so a server cannot forge either of them by simply
 * sending one as a code.
 *
 * Substitutes rather than throws on purpose: an unfamiliar code is not a
 * reason to discard the printer it describes, and throwing here would empty
 * the list for a diagnosis the client merely does not recognise.
 */
export function normalizeCalibrationReasonCode(
  code: string,
): z.infer<typeof CalibrationRejectionReasonCode> {
  const result = CalibrationServerReasonCode.safeParse(code);
  return result.success ? result.data : UNRECOGNIZED_CALIBRATION_REASON_CODE;
}

/** The {@link normalizeCalibrationReasonCode} counterpart for field paths. */
export function normalizeCalibrationMissingInput(field: string): string {
  // Length is checked here rather than left to the schema for the same reason
  // the code catalogue substitutes instead of throwing: a path longer than the
  // renderer will carry is a reason to describe *that field* as unusable, not
  // to reject the response it arrived in.
  return field.length <= CALIBRATION_MAX_FIELD_PATH_LENGTH &&
    CALIBRATION_MISSING_INPUT_PATTERN.test(field)
    ? field
    : UNRECOGNIZED_CALIBRATION_INPUT;
}

export const CalibrationPrinterCandidate = z
  .object({
    /** Server-assigned stable printer ID. */
    printerId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    /** Printer model/make string for display. */
    printerModel: z.string().max(256).nullable(),
    /**
     * Catalog `PrinterModel` GUID this printer maps to.
     *
     * Sourced directly from `CompletePrinterDto.ModelId`
     * (`OlyForge3D/PrintFarmer:src/infra/Dtos/CompletePrinterDto.cs` on
     * `origin/development`). Under Path D `GET /api/printers` — the plain
     * printers list that replaced the removed calibration-candidates route —
     * already carries the model Guid, so no per-record `/details` enrichment
     * round-trip is needed on the way to the renderer.
     *
     * `null` deliberately means "model unknown" — the wire response was
     * missing the field, or the operator is running a server build predating
     * the model catalog. The renderer's permissive fallback
     * (`src/renderer/calibration/profileSelection.ts:49-53`) shows the wider
     * catalog pool rather than an empty picker in that case. Encoding
     * "unknown" as an empty string would collapse it into "known value that
     * matches nothing" and silently defeat the fallback — the exact shape
     * the calibration contract exists to prevent.
     *
     * Additive on the response schema: `optional().default(null)` means older
     * or hand-written clients that omit the field still parse; the current
     * main-process handler forwards whatever the wire says, so no version
     * bump is needed. `nullable()` covers the "field known, value unknown"
     * case.
     */
    printerModelId: z.string().uuid().nullable().optional().default(null),
    /** Whether PrintFarmer considers this printer currently online. */
    isOnline: z.boolean(),
  })
  .strict();
export type CalibrationPrinterCandidate = z.infer<
  typeof CalibrationPrinterCandidate
>;

export const CalibrationListPrintersRequest = z
  .object({ profileId: z.string().uuid() })
  .strict();
export type CalibrationListPrintersRequest = z.infer<
  typeof CalibrationListPrintersRequest
>;
export const CalibrationListPrintersResponse = z
  .object({
    printers: z
      .array(CalibrationPrinterCandidate)
      .max(CALIBRATION_MAX_PRINTER_CANDIDATES),
    /**
     * Whether the server offered more candidates than this list carries.
     *
     * Client-derived from the raw wire length, never read from the payload, so
     * a server can neither hide a cut nor invent one. Present so the app can
     * say the list is partial rather than presenting the first 500 of 540
     * printers as the whole farm.
     */
    printersTruncated: z.boolean(),
    /**
     * How many candidates the server sent that this client could not read.
     *
     * Counted rather than thrown. A candidate whose `id`, timestamp, firmware
     * identity or any other member fails validation is dropped on its own; it
     * used to fail the array, and the array is the whole farm. Reported so a
     * shorter list than the operator owns is visible as a fault rather than
     * mistaken for the truth.
     *
     * Bounded by the number of candidates that can be considered at all: the
     * production count is derived by counting failures among them, so a value
     * above that ceiling describes a list that cannot exist and is rejected
     * rather than believed. Records beyond the cap are reported by
     * `printersTruncated`, not here — they were never examined.
     */
    printersUnreadable: z
      .number()
      .int()
      .nonnegative()
      .max(CALIBRATION_MAX_PRINTER_CANDIDATES),
    fetchedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((response, context) => {
    // Every candidate considered was either read or not read, and only
    // CALIBRATION_MAX_PRINTER_CANDIDATES are ever considered — so the two
    // numbers are parts of one whole, not independent quantities. Bounding
    // them separately let `1 readable + 500 unreadable` through, describing
    // 501 candidates from a list that can hold 500. Records past the cap are
    // never counted here; `printersTruncated` is the evidence for those.
    if (
      response.printers.length + response.printersUnreadable >
      CALIBRATION_MAX_PRINTER_CANDIDATES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['printersUnreadable'],
        message:
          'Readable and unreadable candidates together exceed the number that can be considered.',
      });
    }
  });
export type CalibrationListPrintersResponse = z.infer<
  typeof CalibrationListPrintersResponse
>;

/**
 * Immutable printer context snapshot bound to one calibration session.
 * Once bound, the context must not change during active calibration;
 * changes require an explicit stale-snapshot conflict resolution.
 */
export const CalibrationPrinterContext = z
  .object({
    printerId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    printerModel: z.string().max(256).nullable(),
    firmware: KlipperFirmwareInfo,
    orcaProfileId: z.string().max(512).nullable(),
    /** The OrcaSlicer upstream profile name bound to this printer. */
    orcaProfileDisplayName: z.string().max(512).nullable(),
    /** Bed dimensions in mm (width × depth). */
    bedWidthMm: z.number().positive().max(10_000).nullable(),
    bedDepthMm: z.number().positive().max(10_000).nullable(),
    /** Nozzle diameter in mm at binding time. */
    nozzleDiameterMm: z.number().positive().max(10).nullable(),
    /** Snapshot timestamp from PrintFarmer (not wall clock). */
    snapshotAt: z.string().datetime(),
    /**
     * How far PrintFarmer got when it judged this printer.
     *
     * `'full'` means the server resolved this printer's slicer profiles and
     * declared it eligible with no missing inputs and no rejection reasons.
     * `'preliminary'` means it did not, or did not say — an older build that
     * omits the field reports nothing, and nothing is never promoted to a pass.
     *
     * Only `'full'` may be bound. A preliminary context is still worth loading
     * and displaying, because it explains *why* the printer cannot be
     * calibrated, but it can never stand in for the resolution it did not do.
     */
    evaluationScope: z.enum(['preliminary', 'full']).default('preliminary'),
    /** Whether this snapshot is still current (false = stale, needs rebase). */
    isCurrent: z.boolean(),
    configurationId: z
      .string()
      .min(1)
      .max(256)
      .nullable()
      .optional()
      .default(null),
    configurationRevision: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .default(null),
    snapshotId: z.string().min(1).max(256).nullable().optional().default(null),
    snapshotRevision: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional()
      .default(null),
    slicerIdentity: z.literal('OrcaSlicer').nullable().optional().default(null),
    slicerDistribution: z
      .literal('upstream')
      .nullable()
      .optional()
      .default(null),
    profileRevision: z
      .string()
      .min(1)
      .max(256)
      .nullable()
      .optional()
      .default(null),
    /**
     * Exact PrintFarmer profile identities from the authoritative snapshot.
     *
     * Backend GUIDs and OrcaSlicer names are carried in separate members so a
     * local display/file name can never be mistaken for a server identity.
     */
    profileIdentities: z
      .object({
        machine: z
          .object({
            backendProfileId: z.string().uuid(),
            orcaProfileName: z.string().min(1).max(512),
            profileRevision: z.string().min(1).max(256),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
        process: z
          .object({
            backendProfileId: z.string().uuid(),
            orcaProfileName: z.string().min(1).max(512),
            profileRevision: z.string().min(1).max(256),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
        filament: z
          .object({
            backendProfileId: z.string().uuid(),
            orcaProfileName: z.string().min(1).max(512),
            profileRevision: z.string().min(1).max(256),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      })
      .strict()
      .nullable()
      .optional(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional()
      .default(null),
    toolheads: z
      .array(
        z
          .object({
            toolId: z.string().min(1).max(256),
            toolheadId: z.string().min(1).max(256),
            extruderType: z.enum(['directDrive', 'bowden']),
            nozzle: z
              .object({
                id: z.string().min(1).max(256),
                diameterMm: z.number().positive().max(10),
                material: z.string().min(1).max(256),
              })
              .strict(),
          })
          .strict(),
      )
      .max(32)
      .optional()
      .default([]),
    safety: z
      .object({
        buildVolumeMm: z
          .object({
            x: z.number().positive().max(10_000),
            y: z.number().positive().max(10_000),
            z: z.number().positive().max(10_000),
          })
          .strict(),
        maximumNozzleTemperatureC: z.number().positive().max(2_000),
        maximumBedTemperatureC: z.number().nonnegative().max(1_000),
        maximumVolumetricRateMm3S: z.number().positive().max(10_000),
        emergencyStopAvailable: z.boolean(),
        thermalProtectionConfirmed: z.boolean(),
        ventilationAssessed: z.boolean(),
      })
      .strict()
      .nullable()
      .optional()
      .default(null),
    permissions: z
      .object({
        readPrinter: z.boolean(),
        writeCalibration: z.boolean(),
        generateCalibration: z.boolean(),
        startPrint: z.boolean(),
      })
      .strict()
      .nullable()
      .optional()
      .default(null),
    /**
     * Why PrintFarmer refused this printer, in the same codes the candidate
     * list carries.
     *
     * The context DTO extends the candidate DTO, so the server's reasons are
     * present on every context too — and they are the *interesting* ones, since
     * only the context resolves slicer profiles. Dropping them left the one
     * refusal an operator reaches after selecting a printer explained solely by
     * this client's own structural checks, which can say a profile identity is
     * missing but never that the machine profile was scoped to another printer.
     *
     * Empty on an authoritative context: eligibility and refusal are mutually
     * exclusive on the server, which derives `Eligible` from `reasons.Count`.
     */
    rejectionReasonCodes: z
      .array(CalibrationRejectionReasonCode)
      .max(CALIBRATION_MAX_REJECTION_REASON_CODES)
      .optional()
      .default([]),
    /** Field paths PrintFarmer still needs populated for this printer. */
    missingInputs: z
      .array(CalibrationMissingInputField)
      .max(CALIBRATION_MAX_SERVER_REJECTION_REASONS)
      .optional()
      .default([]),
  })
  .strict();
export type CalibrationPrinterContext = z.infer<
  typeof CalibrationPrinterContext
>;

export const CalibrationGetPrinterContextRequest = z
  .object({
    profileId: z.string().uuid(),
    printerId: z.string().min(1).max(256),
    /**
     * Configuration revision the caller believes is current for this printer.
     *
     * Sent through to the server as `configurationRevision` so the snapshot
     * returned is pinned to a revision the caller already reasoned about rather
     * than to whatever happens to be current when the request lands. Omitted
     * when the caller has no prior revision, which is the first load.
     */
    configurationRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CalibrationGetPrinterContextRequest = z.infer<
  typeof CalibrationGetPrinterContextRequest
>;
export const CalibrationGetPrinterContextResponse = CalibrationPrinterContext;
export type CalibrationGetPrinterContextResponse = z.infer<
  typeof CalibrationGetPrinterContextResponse
>;

// --- Exact local workspace state (issue #53) --------------------------------

export const CalibrationWorkspaceStageId = z.enum([
  'temperature',
  'flowPass1',
  'flowPass2',
  'pressureAdvance',
  'flowVerification',
  'retraction',
  'maximumVolumetricSpeed',
  'shrinkage',
  'finalVerification',
]);
export type CalibrationWorkspaceStageId = z.infer<
  typeof CalibrationWorkspaceStageId
>;

const WorkspaceId = z.string().min(1).max(256);
const WorkspaceTimestamp = z.string().datetime();
const WorkspaceBoundedText = z.string().max(4_096);

export const CalibrationMethod = z.enum([
  'temperatureTower',
  'flowStandard',
  'flowCoarse',
  'flowYolo',
  'flowFine',
  'pressureAdvanceTower',
  'pressureAdvanceLine',
  'pressureAdvancePattern',
  'verificationPrint',
  'retractionTower',
  'volumetricSpeedTower',
  'dimensionalCoupon',
]);
export type CalibrationMethod = z.infer<typeof CalibrationMethod>;

const WorkspaceDiagnostic = z
  .object({
    code: WorkspaceId,
    severity: z.enum(['warning', 'error']),
    message: z.string().min(1).max(4_096),
    field: z.string().max(256).optional(),
    stageId: CalibrationWorkspaceStageId.optional(),
    eventId: WorkspaceId.optional(),
  })
  .strict();

const WorkspaceBaseline = z
  .object({
    nozzleTemperatureC: z.number().finite().min(0).max(2_000),
    flowRatio: z.number().finite().positive().max(10),
    pressureAdvance: z.number().finite().nonnegative().max(10),
    retractionLengthMm: z.number().finite().nonnegative().max(100),
    maximumVolumetricRateMm3S: z.number().finite().positive().max(10_000),
    shrinkageCompensationXPercent: z.number().finite().min(-100).max(100),
    shrinkageCompensationYPercent: z.number().finite().min(-100).max(100),
    shrinkageCompensationZPercent: z.number().finite().min(-100).max(100),
  })
  .strict();

const WorkspaceNozzle = z
  .object({
    nozzleId: WorkspaceId,
    diameterMm: z.number().finite().positive().max(10),
    material: z.string().trim().min(1).max(256),
  })
  .strict();
const WorkspaceToolhead = z
  .object({
    toolId: WorkspaceId,
    toolheadId: WorkspaceId,
    nozzle: WorkspaceNozzle,
    extruderType: z.enum(['directDrive', 'bowden']),
  })
  .strict();
const WorkspaceSafety = z
  .object({
    buildVolumeMm: z
      .object({
        x: z.number().finite().positive().max(10_000),
        y: z.number().finite().positive().max(10_000),
        z: z.number().finite().positive().max(10_000),
      })
      .strict(),
    maximumNozzleTemperatureC: z.number().finite().positive().max(2_000),
    maximumBedTemperatureC: z.number().finite().nonnegative().max(1_000),
    maximumVolumetricRateMm3S: z.number().finite().positive().max(10_000),
    emergencyStopAvailable: z.boolean(),
    thermalProtectionConfirmed: z.boolean(),
    ventilationAssessed: z.boolean(),
  })
  .strict();
const WorkspaceSnapshot = z
  .object({
    snapshotId: WorkspaceId,
    snapshotRevision: z.number().int().nonnegative(),
    capturedAt: WorkspaceTimestamp,
    configurationRevision: z.number().int().nonnegative(),
    toolheads: z.array(WorkspaceToolhead).min(1).max(32),
    safety: WorkspaceSafety,
  })
  .strict();
const WorkspaceFilament = z
  .object({
    filamentProjectId: WorkspaceId,
    provider: z.string().trim().min(1).max(256),
    product: z.string().trim().min(1).max(256),
    sku: z.string().trim().min(1).max(256),
    spoolId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
const WorkspaceBinding = z
  .object({
    printer: z
      .object({
        backendProfileId: WorkspaceId,
        backendPrinterId: WorkspaceId,
        printerConfigurationId: WorkspaceId,
        printerConfigurationRevision: z.number().int().nonnegative(),
      })
      .strict(),
    snapshot: WorkspaceSnapshot,
    selectedToolId: WorkspaceId,
    selectedToolheadId: WorkspaceId,
    selectedNozzleId: WorkspaceId,
    profileIdentities: z
      .object({
        machine: z
          .object({
            backendProfileId: WorkspaceId,
            orcaProfileName: z.string().min(1).max(512),
            profileRevision: z.string().min(1).max(256),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
        process: z
          .object({
            backendProfileId: WorkspaceId,
            orcaProfileName: z.string().min(1).max(512),
            profileRevision: z.string().min(1).max(256),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
        filament: z
          .object({
            backendProfileId: WorkspaceId,
            orcaProfileName: z.string().min(1).max(512),
            profileRevision: z.string().min(1).max(256),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      })
      .strict()
      .optional(),
    filament: WorkspaceFilament,
  })
  .strict();

const WorkspaceObservationBase = {
  observationId: WorkspaceId,
  attemptId: WorkspaceId,
  observedAt: WorkspaceTimestamp,
  notes: WorkspaceBoundedText,
};
const WorkspaceTemperatureObservation = z
  .object({
    ...WorkspaceObservationBase,
    stageId: z.literal('temperature'),
    temperatureC: z.number().finite().min(0).max(2_000),
    quality: z.number().finite().min(0).max(100),
  })
  .strict();
const WorkspaceFlowPass1Observation = z
  .object({
    ...WorkspaceObservationBase,
    stageId: z.literal('flowPass1'),
    adjustmentPercent: z.number().finite().min(-100).max(100),
    quality: z.number().finite().min(0).max(100),
  })
  .strict();
const WorkspaceFlowPass2Observation = z
  .object({
    ...WorkspaceObservationBase,
    stageId: z.literal('flowPass2'),
    adjustmentPercent: z.number().finite().min(-100).max(100),
    quality: z.number().finite().min(0).max(100),
  })
  .strict();
const WorkspacePressureAdvanceObservation = z
  .object({
    ...WorkspaceObservationBase,
    stageId: z.literal('pressureAdvance'),
    pressureAdvance: z.number().finite().nonnegative().max(10),
    quality: z.number().finite().min(0).max(100),
  })
  .strict();
const WorkspaceFlowVerificationObservation = z
  .object({
    ...WorkspaceObservationBase,
    stageId: z.literal('flowVerification'),
    passed: z.boolean(),
    defectCount: z.number().int().nonnegative().max(10_000),
  })
  .strict();
const WorkspaceRetractionObservation = z
  .object({
    ...WorkspaceObservationBase,
    stageId: z.literal('retraction'),
    retractionLengthMm: z.number().finite().nonnegative().max(100),
    quality: z.number().finite().min(0).max(100),
  })
  .strict();
const WorkspaceVolumetricSpeedObservation = z
  .object({
    ...WorkspaceObservationBase,
    stageId: z.literal('maximumVolumetricSpeed'),
    stableVolumetricRateMm3S: z.number().finite().positive().max(10_000),
    quality: z.number().finite().min(0).max(100),
  })
  .strict();
const WorkspaceShrinkageObservation = z
  .object({
    ...WorkspaceObservationBase,
    stageId: z.literal('shrinkage'),
    nominalXmm: z.number().finite().positive().max(10_000),
    nominalYmm: z.number().finite().positive().max(10_000),
    nominalZmm: z.number().finite().positive().max(10_000),
    measuredXmm: z.number().finite().positive().max(10_000),
    measuredYmm: z.number().finite().positive().max(10_000),
    measuredZmm: z.number().finite().positive().max(10_000),
  })
  .strict();
const WorkspaceFinalVerificationObservation = z
  .object({
    ...WorkspaceObservationBase,
    stageId: z.literal('finalVerification'),
    passed: z.boolean(),
    defectCount: z.number().int().nonnegative().max(10_000),
  })
  .strict();

const WorkspaceRecommendation = z
  .object({
    summary: z.string().min(1).max(4_096),
    rationale: z.string().min(1).max(4_096),
    values: z
      .array(
        z
          .object({
            key: WorkspaceId,
            value: z.union([z.number().finite(), z.boolean()]),
            unit: z.enum([
              'celsius',
              'millimeter',
              'millimeterPerSecond',
              'cubicMillimeterPerSecond',
              'second',
              'percent',
              'ratio',
              'count',
              'boolean',
            ]),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const WorkspaceAttemptScope = z
  .object({
    backendProfileId: WorkspaceId,
    backendPrinterId: WorkspaceId,
    printerConfigurationId: WorkspaceId,
    printerConfigurationRevision: z.number().int().nonnegative(),
    snapshotId: WorkspaceId,
    snapshotRevision: z.number().int().nonnegative(),
    toolId: WorkspaceId,
    toolheadId: WorkspaceId,
    nozzleId: WorkspaceId,
    filamentProjectId: WorkspaceId,
    filamentProvider: z.string().min(1).max(256),
    filamentProduct: z.string().min(1).max(256),
    filamentSku: z.string().min(1).max(256),
    spoolId: z.string().min(1).max(256).optional(),
  })
  .strict();
const WorkspaceAttemptBase = {
  attemptId: WorkspaceId,
  scope: WorkspaceAttemptScope,
  ordinal: z.number().int().positive().max(10_000),
  status: z.enum(['inProgress', 'completed', 'abandoned']),
  startedAt: WorkspaceTimestamp,
  completedAt: WorkspaceTimestamp.optional(),
  selectedObservationId: WorkspaceId.optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  recommendation: WorkspaceRecommendation.optional(),
  diagnostics: z.array(WorkspaceDiagnostic).max(2_000),
};
const WorkspaceAttempt = z.discriminatedUnion('stageId', [
  z
    .object({
      ...WorkspaceAttemptBase,
      stageId: z.literal('temperature'),
      method: z.literal('temperatureTower'),
      observations: z.array(WorkspaceTemperatureObservation).max(2_000),
    })
    .strict(),
  z
    .object({
      ...WorkspaceAttemptBase,
      stageId: z.literal('flowPass1'),
      method: z.enum(['flowStandard', 'flowCoarse', 'flowYolo']),
      observations: z.array(WorkspaceFlowPass1Observation).max(2_000),
    })
    .strict(),
  z
    .object({
      ...WorkspaceAttemptBase,
      stageId: z.literal('flowPass2'),
      method: z.literal('flowFine'),
      observations: z.array(WorkspaceFlowPass2Observation).max(2_000),
    })
    .strict(),
  z
    .object({
      ...WorkspaceAttemptBase,
      stageId: z.literal('pressureAdvance'),
      method: z.enum([
        'pressureAdvanceTower',
        'pressureAdvanceLine',
        'pressureAdvancePattern',
      ]),
      observations: z.array(WorkspacePressureAdvanceObservation).max(2_000),
    })
    .strict(),
  z
    .object({
      ...WorkspaceAttemptBase,
      stageId: z.literal('flowVerification'),
      method: z.literal('verificationPrint'),
      observations: z.array(WorkspaceFlowVerificationObservation).max(2_000),
    })
    .strict(),
  z
    .object({
      ...WorkspaceAttemptBase,
      stageId: z.literal('retraction'),
      method: z.literal('retractionTower'),
      observations: z.array(WorkspaceRetractionObservation).max(2_000),
    })
    .strict(),
  z
    .object({
      ...WorkspaceAttemptBase,
      stageId: z.literal('maximumVolumetricSpeed'),
      method: z.literal('volumetricSpeedTower'),
      observations: z.array(WorkspaceVolumetricSpeedObservation).max(2_000),
    })
    .strict(),
  z
    .object({
      ...WorkspaceAttemptBase,
      stageId: z.literal('shrinkage'),
      method: z.literal('dimensionalCoupon'),
      observations: z.array(WorkspaceShrinkageObservation).max(2_000),
    })
    .strict(),
  z
    .object({
      ...WorkspaceAttemptBase,
      stageId: z.literal('finalVerification'),
      method: z.literal('verificationPrint'),
      observations: z.array(WorkspaceFinalVerificationObservation).max(2_000),
    })
    .strict(),
]);

const WorkspaceStageProgress = z
  .object({
    stageId: CalibrationWorkspaceStageId,
    status: z.enum([
      'notStarted',
      'inProgress',
      'completed',
      'skipped',
      'needsRetest',
    ]),
    attemptIds: z.array(WorkspaceId).max(1_000),
    selectedAttemptId: WorkspaceId.optional(),
    skip: z
      .object({
        skipId: WorkspaceId,
        reason: z.string().trim().min(1).max(4_096),
        skippedAt: WorkspaceTimestamp,
      })
      .strict()
      .optional(),
    retestReason: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict();
const WorkspaceStages = z
  .object({
    temperature: WorkspaceStageProgress,
    flowPass1: WorkspaceStageProgress,
    flowPass2: WorkspaceStageProgress,
    pressureAdvance: WorkspaceStageProgress,
    flowVerification: WorkspaceStageProgress,
    retraction: WorkspaceStageProgress,
    maximumVolumetricSpeed: WorkspaceStageProgress,
    shrinkage: WorkspaceStageProgress,
    finalVerification: WorkspaceStageProgress,
  })
  .strict();

const WorkspaceEventBase = {
  eventId: WorkspaceId,
  timestamp: WorkspaceTimestamp,
};
const WorkspaceHistoryEvent = z.discriminatedUnion('type', [
  z
    .object({
      ...WorkspaceEventBase,
      type: z.literal('setMode'),
      mode: z.enum(['coach', 'expert']),
    })
    .strict(),
  z
    .object({
      ...WorkspaceEventBase,
      type: z.literal('navigate'),
      stageId: CalibrationWorkspaceStageId,
    })
    .strict(),
  z
    .object({
      ...WorkspaceEventBase,
      type: z.literal('beginAttempt'),
      attemptId: WorkspaceId,
      stageId: CalibrationWorkspaceStageId,
      method: CalibrationMethod,
    })
    .strict(),
  z
    .object({
      ...WorkspaceEventBase,
      type: z.literal('recordObservation'),
      attemptId: WorkspaceId,
      observation: z.discriminatedUnion('stageId', [
        WorkspaceTemperatureObservation,
        WorkspaceFlowPass1Observation,
        WorkspaceFlowPass2Observation,
        WorkspacePressureAdvanceObservation,
        WorkspaceFlowVerificationObservation,
        WorkspaceRetractionObservation,
        WorkspaceVolumetricSpeedObservation,
        WorkspaceShrinkageObservation,
        WorkspaceFinalVerificationObservation,
      ]),
    })
    .strict(),
  z
    .object({
      ...WorkspaceEventBase,
      type: z.literal('selectObservation'),
      attemptId: WorkspaceId,
      observationId: WorkspaceId,
    })
    .strict(),
  z
    .object({
      ...WorkspaceEventBase,
      type: z.literal('completeAttempt'),
      attemptId: WorkspaceId,
      confidence: z.enum(['low', 'medium', 'high']),
    })
    .strict(),
  z
    .object({
      ...WorkspaceEventBase,
      type: z.literal('skipStage'),
      stageId: CalibrationWorkspaceStageId,
      skipId: WorkspaceId,
      reason: z.string().trim().min(1).max(4_096),
    })
    .strict(),
  z
    .object({
      ...WorkspaceEventBase,
      type: z.literal('redoStage'),
      stageId: CalibrationWorkspaceStageId,
      attemptId: WorkspaceId,
      method: CalibrationMethod,
      reason: z.string().trim().min(1).max(4_096),
    })
    .strict(),
  z
    .object({
      ...WorkspaceEventBase,
      type: z.literal('rebaseSnapshot'),
      binding: WorkspaceBinding,
      retestStages: z.array(CalibrationWorkspaceStageId).min(1).max(9),
      reason: z.string().trim().min(1).max(4_096),
    })
    .strict(),
]);

function workspaceIssue(
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

const WorkspaceDomainState = z
  .object({
    schemaVersion: z.literal(1),
    projectId: WorkspaceId,
    createdAt: WorkspaceTimestamp,
    mode: z.enum(['coach', 'expert']),
    baseline: WorkspaceBaseline,
    binding: WorkspaceBinding,
    snapshotHistory: z.array(WorkspaceSnapshot).min(1).max(1_000),
    currentStageId: CalibrationWorkspaceStageId,
    stages: WorkspaceStages,
    attempts: z.array(WorkspaceAttempt).max(2_000),
    history: z.array(WorkspaceHistoryEvent).max(10_000),
    diagnostics: z.array(WorkspaceDiagnostic).max(2_000),
  })
  .strict()
  .superRefine((state, context) => {
    for (const stageId of CalibrationWorkspaceStageId.options) {
      if (state.stages[stageId].stageId !== stageId) {
        workspaceIssue(
          context,
          ['stages', stageId, 'stageId'],
          'Stage key must match its stage identity.',
        );
      }
    }

    const attemptById = new Map(
      state.attempts.map((attempt) => [attempt.attemptId, attempt]),
    );
    if (attemptById.size !== state.attempts.length) {
      workspaceIssue(
        context,
        ['attempts'],
        'Attempt identities must be unique.',
      );
    }
    const eventIds = new Set(state.history.map((event) => event.eventId));
    if (eventIds.size !== state.history.length) {
      workspaceIssue(context, ['history'], 'Event identities must be unique.');
    }

    const observationById = new Map<
      string,
      (typeof state.attempts)[number]['observations'][number]
    >();
    for (const [attemptIndex, attempt] of state.attempts.entries()) {
      const stage = state.stages[attempt.stageId];
      const references = stage.attemptIds.filter(
        (attemptId) => attemptId === attempt.attemptId,
      ).length;
      if (references !== 1) {
        workspaceIssue(
          context,
          ['attempts', attemptIndex, 'attemptId'],
          'Each attempt must be referenced exactly once by its stage.',
        );
      }
      const historicalSnapshot = state.snapshotHistory.find(
        (snapshot) =>
          snapshot.snapshotId === attempt.scope.snapshotId &&
          snapshot.snapshotRevision === attempt.scope.snapshotRevision,
      );
      const scopedTool = historicalSnapshot?.toolheads.find(
        (toolhead) => toolhead.toolId === attempt.scope.toolId,
      );
      if (
        historicalSnapshot === undefined ||
        historicalSnapshot.configurationRevision !==
          attempt.scope.printerConfigurationRevision ||
        scopedTool?.toolheadId !== attempt.scope.toolheadId ||
        scopedTool.nozzle.nozzleId !== attempt.scope.nozzleId
      ) {
        workspaceIssue(
          context,
          ['attempts', attemptIndex, 'scope'],
          'Attempt scope must match an immutable snapshot and tool identity.',
        );
      }
      if (
        attempt.scope.backendProfileId !==
          state.binding.printer.backendProfileId ||
        attempt.scope.backendPrinterId !==
          state.binding.printer.backendPrinterId ||
        attempt.scope.printerConfigurationId !==
          state.binding.printer.printerConfigurationId ||
        attempt.scope.filamentProjectId !==
          state.binding.filament.filamentProjectId ||
        attempt.scope.filamentProvider !== state.binding.filament.provider ||
        attempt.scope.filamentProduct !== state.binding.filament.product ||
        attempt.scope.filamentSku !== state.binding.filament.sku ||
        attempt.scope.spoolId !== state.binding.filament.spoolId
      ) {
        workspaceIssue(
          context,
          ['attempts', attemptIndex, 'scope'],
          'Attempt scope must retain project printer and filament identity.',
        );
      }
      for (const [
        observationIndex,
        observation,
      ] of attempt.observations.entries()) {
        if (
          observation.attemptId !== attempt.attemptId ||
          observation.stageId !== attempt.stageId
        ) {
          workspaceIssue(
            context,
            ['attempts', attemptIndex, 'observations', observationIndex],
            'Observation identity must match its attempt and stage.',
          );
        }
        if (observationById.has(observation.observationId)) {
          workspaceIssue(
            context,
            [
              'attempts',
              attemptIndex,
              'observations',
              observationIndex,
              'observationId',
            ],
            'Observation identities must be unique.',
          );
        }
        observationById.set(observation.observationId, observation);
      }
      if (
        attempt.selectedObservationId !== undefined &&
        !attempt.observations.some(
          (observation) =>
            observation.observationId === attempt.selectedObservationId,
        )
      ) {
        workspaceIssue(
          context,
          ['attempts', attemptIndex, 'selectedObservationId'],
          'Selected observation must belong to its attempt.',
        );
      }
      if (
        attempt.status === 'completed' &&
        (attempt.completedAt === undefined ||
          attempt.selectedObservationId === undefined ||
          attempt.confidence === undefined ||
          attempt.recommendation === undefined)
      ) {
        workspaceIssue(
          context,
          ['attempts', attemptIndex, 'status'],
          'Completed attempts require a selected result, confidence, recommendation, and completion time.',
        );
      }
      if (
        attempt.status !== 'completed' &&
        (attempt.completedAt !== undefined ||
          attempt.confidence !== undefined ||
          attempt.recommendation !== undefined)
      ) {
        workspaceIssue(
          context,
          ['attempts', attemptIndex, 'status'],
          'Only completed attempts may carry completion metadata.',
        );
      }
    }

    for (const stageId of CalibrationWorkspaceStageId.options) {
      const stage = state.stages[stageId];
      const uniqueAttemptIds = new Set(stage.attemptIds);
      const expectedAttemptIds = state.attempts
        .filter((attempt) => attempt.stageId === stageId)
        .map((attempt) => attempt.attemptId);
      if (
        uniqueAttemptIds.size !== stage.attemptIds.length ||
        expectedAttemptIds.length !== stage.attemptIds.length ||
        expectedAttemptIds.some((attemptId) => !uniqueAttemptIds.has(attemptId))
      ) {
        workspaceIssue(
          context,
          ['stages', stageId, 'attemptIds'],
          'Stage attempt references must be exact and unique.',
        );
      }
      const selected =
        stage.selectedAttemptId === undefined
          ? undefined
          : attemptById.get(stage.selectedAttemptId);
      if (
        stage.selectedAttemptId !== undefined &&
        (selected === undefined ||
          selected.stageId !== stageId ||
          selected.status !== 'completed')
      ) {
        workspaceIssue(
          context,
          ['stages', stageId, 'selectedAttemptId'],
          'Selected attempt must be a completed attempt from this stage.',
        );
      }
      const activeCount = expectedAttemptIds.filter(
        (attemptId) => attemptById.get(attemptId)?.status === 'inProgress',
      ).length;
      if (
        (stage.status === 'inProgress' && activeCount !== 1) ||
        (stage.status !== 'inProgress' && activeCount !== 0)
      ) {
        workspaceIssue(
          context,
          ['stages', stageId, 'status'],
          'Stage status must match its in-progress attempt.',
        );
      }
      if (stage.status === 'completed' && selected === undefined) {
        workspaceIssue(
          context,
          ['stages', stageId, 'selectedAttemptId'],
          'Completed stages require a completed selected attempt.',
        );
      }
      if (stage.status === 'skipped' && stage.skip === undefined) {
        workspaceIssue(
          context,
          ['stages', stageId, 'skip'],
          'Skipped stages require an auditable skip record.',
        );
      }
      if (stage.status !== 'skipped' && stage.skip !== undefined) {
        workspaceIssue(
          context,
          ['stages', stageId, 'skip'],
          'Only skipped stages may carry a skip record.',
        );
      }
      if (stage.status === 'needsRetest' && stage.retestReason === undefined) {
        workspaceIssue(
          context,
          ['stages', stageId, 'retestReason'],
          'Stages needing retest require a reason.',
        );
      }
      if (
        stage.status === 'notStarted' &&
        (stage.attemptIds.length !== 0 || stage.selectedAttemptId !== undefined)
      ) {
        workspaceIssue(
          context,
          ['stages', stageId],
          'A not-started stage cannot reference attempts.',
        );
      }
    }

    const snapshotKeys = new Set<string>();
    for (const [snapshotIndex, snapshot] of state.snapshotHistory.entries()) {
      const snapshotKey = `${snapshot.snapshotId}:${snapshot.snapshotRevision}`;
      if (snapshotKeys.has(snapshotKey)) {
        workspaceIssue(
          context,
          ['snapshotHistory', snapshotIndex],
          'Snapshot history identities must be unique.',
        );
      }
      snapshotKeys.add(snapshotKey);
      const toolIds = new Set(
        snapshot.toolheads.map((toolhead) => toolhead.toolId),
      );
      const toolheadIds = new Set(
        snapshot.toolheads.map((toolhead) => toolhead.toolheadId),
      );
      const nozzleIds = new Set(
        snapshot.toolheads.map((toolhead) => toolhead.nozzle.nozzleId),
      );
      if (
        toolIds.size !== snapshot.toolheads.length ||
        toolheadIds.size !== snapshot.toolheads.length ||
        nozzleIds.size !== snapshot.toolheads.length
      ) {
        workspaceIssue(
          context,
          ['snapshotHistory', snapshotIndex, 'toolheads'],
          'Tool, toolhead, and nozzle identities must be unique in a snapshot.',
        );
      }
    }
    const latestSnapshot = state.snapshotHistory.at(-1);
    if (
      latestSnapshot?.snapshotId !== state.binding.snapshot.snapshotId ||
      latestSnapshot.snapshotRevision !==
        state.binding.snapshot.snapshotRevision ||
      JSON.stringify(latestSnapshot) !==
        JSON.stringify(state.binding.snapshot) ||
      state.binding.printer.printerConfigurationRevision !==
        state.binding.snapshot.configurationRevision
    ) {
      workspaceIssue(
        context,
        ['snapshotHistory'],
        'Current binding must match the latest snapshot and configuration revision.',
      );
    }
    const selectedTool = state.binding.snapshot.toolheads.find(
      (toolhead) => toolhead.toolId === state.binding.selectedToolId,
    );
    if (
      selectedTool?.toolheadId !== state.binding.selectedToolheadId ||
      selectedTool.nozzle.nozzleId !== state.binding.selectedNozzleId
    ) {
      workspaceIssue(
        context,
        ['binding', 'selectedToolId'],
        'Selected tool identity must be present in the current snapshot.',
      );
    }

    for (const [eventIndex, event] of state.history.entries()) {
      if (
        event.type === 'beginAttempt' ||
        event.type === 'redoStage' ||
        event.type === 'completeAttempt'
      ) {
        const attempt = attemptById.get(event.attemptId);
        if (
          attempt === undefined ||
          ('stageId' in event && attempt.stageId !== event.stageId) ||
          ('method' in event && attempt.method !== event.method) ||
          (event.type === 'completeAttempt' &&
            (attempt.status !== 'completed' ||
              attempt.confidence !== event.confidence))
        ) {
          workspaceIssue(
            context,
            ['history', eventIndex],
            'History attempt reference does not match a persisted attempt.',
          );
        }
      } else if (event.type === 'recordObservation') {
        const attempt = attemptById.get(event.attemptId);
        const observation = observationById.get(
          event.observation.observationId,
        );
        if (
          attempt === undefined ||
          observation === undefined ||
          event.observation.attemptId !== event.attemptId ||
          observation.attemptId !== event.attemptId ||
          observation.stageId !== attempt.stageId ||
          JSON.stringify(event.observation) !== JSON.stringify(observation)
        ) {
          workspaceIssue(
            context,
            ['history', eventIndex],
            'History observation reference does not match a persisted observation.',
          );
        }
      } else if (event.type === 'selectObservation') {
        const attempt = attemptById.get(event.attemptId);
        if (
          attempt === undefined ||
          !attempt.observations.some(
            (observation) => observation.observationId === event.observationId,
          )
        ) {
          workspaceIssue(
            context,
            ['history', eventIndex],
            'History selected observation must belong to its attempt.',
          );
        }
      } else if (event.type === 'skipStage') {
        const stage = state.stages[event.stageId];
        if (
          stage.status !== 'skipped' ||
          stage.skip?.skipId !== event.skipId ||
          stage.skip.reason !== event.reason
        ) {
          workspaceIssue(
            context,
            ['history', eventIndex],
            'History skip reference must match the persisted stage skip.',
          );
        }
      }
    }
    for (const [diagnosticIndex, diagnostic] of state.diagnostics.entries()) {
      if (
        diagnostic.eventId !== undefined &&
        !eventIds.has(diagnostic.eventId)
      ) {
        workspaceIssue(
          context,
          ['diagnostics', diagnosticIndex, 'eventId'],
          'Diagnostic event reference must exist in history.',
        );
      }
    }
  });

const WorkspaceStepDraft = z
  .object({
    prerequisites: z.string().max(2_048),
    methodNotes: z.string().max(4_096),
    expectedResult: z.string().max(2_048),
  })
  .strict();
const WorkspaceStepDrafts = z
  .object({
    temperature: WorkspaceStepDraft.optional(),
    flowPass1: WorkspaceStepDraft.optional(),
    flowPass2: WorkspaceStepDraft.optional(),
    pressureAdvance: WorkspaceStepDraft.optional(),
    flowVerification: WorkspaceStepDraft.optional(),
    retraction: WorkspaceStepDraft.optional(),
    maximumVolumetricSpeed: WorkspaceStepDraft.optional(),
    shrinkage: WorkspaceStepDraft.optional(),
    finalVerification: WorkspaceStepDraft.optional(),
  })
  .strict();

const WorkspaceWorkflowDraft = z
  .object({
    method: CalibrationMethod.nullable(),
    observation: z
      .object({
        primary: z.string().max(128),
        quality: z.string().max(128),
        notes: z.string().max(4_096),
        passed: z.boolean(),
        nominalXmm: z.string().max(128),
        nominalYmm: z.string().max(128),
        nominalZmm: z.string().max(128),
        measuredXmm: z.string().max(128),
        measuredYmm: z.string().max(128),
        measuredZmm: z.string().max(128),
      })
      .strict(),
    confidence: z.enum(['low', 'medium', 'high']).nullable(),
    reason: z.string().max(4_096),
    photoAttemptId: z.string().uuid().nullable(),
    photoCaption: z.string().max(512),
    photoOrder: z.number().int().min(1).max(1_000),
  })
  .strict();
const WorkspaceWorkflowDrafts = z
  .object({
    temperature: WorkspaceWorkflowDraft,
    flowPass1: WorkspaceWorkflowDraft,
    flowPass2: WorkspaceWorkflowDraft,
    pressureAdvance: WorkspaceWorkflowDraft,
    flowVerification: WorkspaceWorkflowDraft,
    retraction: WorkspaceWorkflowDraft,
    maximumVolumetricSpeed: WorkspaceWorkflowDraft,
    shrinkage: WorkspaceWorkflowDraft,
    finalVerification: WorkspaceWorkflowDraft,
  })
  .strict();

const WorkspacePhotoMetadata = z
  .object({
    photoId: z.string().uuid(),
    attemptId: z.string().uuid(),
    stageId: CalibrationWorkspaceStageId,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    byteSize: z.number().int().positive().max(20_000_000),
    status: z.enum(['staged', 'uploading', 'uploaded', 'failed', 'conflicted']),
    caption: z.string().min(1).max(512),
    order: z.number().int().min(1).max(1_000),
    stagedAt: z.string().datetime(),
  })
  .strict();

export const CalibrationSelectedBaseProfile = z
  .object({
    orcaProfileId: z.string().min(1).max(512),
    /**
     * The OrcaSlicer-facing profile name used to locate this profile on disk.
     * See {@link OrcaProfileEntry.orcaProfileName}: for a PrintFarmer-sourced
     * profile the id is a server `Guid` that no local file carries, so
     * generation must resolve the base profile by this name instead.
     * Optional so workspaces persisted before the split still load.
     */
    orcaProfileName: z.string().min(1).max(512).optional(),
    displayName: z.string().min(1).max(512),
    /**
     * 'printFarmer' — server-supplied, upstream-verified profile.
     * 'systemInstall' — locally discovered from the OS OrcaSlicer installation,
     * content-hash verified against the backend's recorded hash.
     */
    source: z.enum(['printFarmer', 'systemInstall']),
    upstreamVerified: z.literal(true),
    printerId: WorkspaceId,
    configurationRevision: z.number().int().nonnegative(),
    snapshotId: WorkspaceId,
    toolId: WorkspaceId,
    toolheadId: WorkspaceId,
    nozzleId: WorkspaceId,
    nozzleDiameterMm: z.number().finite().positive().max(10),
    profileRevision: z.string().min(1).max(256).nullable(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export type CalibrationSelectedBaseProfile = z.infer<
  typeof CalibrationSelectedBaseProfile
>;

/**
 * Resolves the OrcaSlicer profile *name* to look up on disk for a selected
 * base profile.
 *
 * Returns null when the name cannot be determined, which is the only honest
 * answer for a PrintFarmer-sourced profile persisted before `orcaProfileName`
 * existed: its `orcaProfileId` is a server `Guid`, and falling back to it would
 * search local files for a name that cannot exist and report the profile
 * missing for the wrong reason. Local sources are safe to fall back on, because
 * their id is the name.
 */
export function resolveOrcaBaseProfileLookupName(profile: {
  orcaProfileId: string;
  orcaProfileName?: string | undefined;
  source: string;
}): string | null {
  if (profile.orcaProfileName !== undefined) return profile.orcaProfileName;
  return profile.source === 'printFarmer' ? null : profile.orcaProfileId;
}

/**
 * A single append-only observation recorded after a print completes.
 * Once written, observations are never mutated or deleted.
 */
export const CalibrationPrintObservation = z
  .object({
    observationId: z.string().uuid(),
    attemptId: z.string().uuid(),
    jobId: z.string().uuid(),
    recordedAt: z.string().datetime(),
    /** Selected calibration result. */
    selectedResult: z.enum(['accepted', 'rejected', 'inconclusive']).nullable(),
    /** Confidence in the result. */
    confidence: z.enum(['low', 'medium', 'high']).nullable(),
    /** Whether a retest is needed. */
    retestRequired: z.boolean(),
    /** Operator notes (append-only). */
    notes: z.string().max(4096),
    /** Photo IDs attached to this observation (from prior stage). */
    photoIds: z.array(z.string().uuid()).max(20),
  })
  .passthrough();
export type CalibrationPrintObservation = z.infer<
  typeof CalibrationPrintObservation
>;

export const CalibrationWorkspacePayload = z
  .object({
    schemaVersion: z.literal(1),
    domainState: WorkspaceDomainState,
    metadata: z
      .object({
        displayName: z.string().trim().min(1).max(256),
        description: z.string().max(4_096),
      })
      .strict(),
    stepDrafts: WorkspaceStepDrafts,
    workflowDrafts: WorkspaceWorkflowDrafts,
    photos: z.array(WorkspacePhotoMetadata).max(1_000),
    physicalMatch: z
      .object({
        snapshotId: z.string().min(1).max(256),
        toolId: z.string().min(1).max(256),
        toolheadId: z.string().min(1).max(256),
        nozzleId: z.string().min(1).max(256),
        nozzleDiameterMm: z.number().positive().max(10),
        confirmedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
    selectedBaseProfile: CalibrationSelectedBaseProfile,
    /** Compatibility alias; must equal selectedBaseProfile.orcaProfileId. */
    selectedBaseProfileId: z.string().min(1).max(512),
    autosaveRevision: z.number().int().nonnegative(),
    /** Append-only print lifecycle observations (criterion 13, issue #54). */
    printObservations: z.array(CalibrationPrintObservation).max(200).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    const binding = payload.domainState.binding;
    const selectedTool = binding.snapshot.toolheads.find(
      (toolhead) => toolhead.toolId === binding.selectedToolId,
    );
    if (
      payload.selectedBaseProfileId !==
        payload.selectedBaseProfile.orcaProfileId ||
      payload.selectedBaseProfile.printerId !==
        binding.printer.backendPrinterId ||
      payload.selectedBaseProfile.configurationRevision !==
        binding.printer.printerConfigurationRevision ||
      payload.selectedBaseProfile.snapshotId !== binding.snapshot.snapshotId ||
      payload.selectedBaseProfile.toolId !== binding.selectedToolId ||
      payload.selectedBaseProfile.toolheadId !== binding.selectedToolheadId ||
      payload.selectedBaseProfile.nozzleId !== binding.selectedNozzleId ||
      payload.selectedBaseProfile.nozzleDiameterMm !==
        selectedTool?.nozzle.diameterMm
    ) {
      workspaceIssue(
        context,
        ['selectedBaseProfile'],
        'Selected base profile must match the current printer, snapshot, tool, and nozzle binding.',
      );
    }
    if (payload.physicalMatch !== null) {
      if (
        payload.physicalMatch.snapshotId !== binding.snapshot.snapshotId ||
        payload.physicalMatch.toolId !== binding.selectedToolId ||
        payload.physicalMatch.toolheadId !== binding.selectedToolheadId ||
        payload.physicalMatch.nozzleId !== binding.selectedNozzleId ||
        payload.physicalMatch.nozzleDiameterMm !==
          selectedTool?.nozzle.diameterMm
      ) {
        workspaceIssue(
          context,
          ['physicalMatch'],
          'Physical match confirmation must match the current binding.',
        );
      }
    }
    const attemptById = new Map(
      payload.domainState.attempts.map((attempt) => [
        attempt.attemptId,
        attempt,
      ]),
    );
    const photoIds = new Set<string>();
    for (const [photoIndex, photo] of payload.photos.entries()) {
      const attempt = attemptById.get(photo.attemptId);
      if (photoIds.has(photo.photoId)) {
        workspaceIssue(
          context,
          ['photos', photoIndex, 'photoId'],
          'Photo identities must be unique.',
        );
      }
      photoIds.add(photo.photoId);
      if (attempt === undefined || attempt.stageId !== photo.stageId) {
        workspaceIssue(
          context,
          ['photos', photoIndex],
          'Photo metadata must reference an attempt from the same stage.',
        );
      }
    }
    for (const stageId of CalibrationWorkspaceStageId.options) {
      const photoAttemptId = payload.workflowDrafts[stageId].photoAttemptId;
      if (photoAttemptId === null) continue;
      const attempt = attemptById.get(photoAttemptId);
      if (attempt === undefined || attempt.stageId !== stageId) {
        workspaceIssue(
          context,
          ['workflowDrafts', stageId, 'photoAttemptId'],
          'Photo draft attempt must reference an attempt from the same stage.',
        );
      }
    }
  });
export type CalibrationWorkspacePayload = z.infer<
  typeof CalibrationWorkspacePayload
>;

export function deriveCalibrationWorkspaceProjection(
  domainState: z.infer<typeof WorkspaceDomainState>,
): {
  completedStepCount: number;
  totalStepCount: 9;
  status: 'draft' | 'inProgress' | 'complete';
} {
  const stages = CalibrationWorkspaceStageId.options.map(
    (stageId) => domainState.stages[stageId].status,
  );
  const completedStepCount = stages.filter(
    (status) => status === 'completed',
  ).length;
  const resolved = stages.every(
    (status) => status === 'completed' || status === 'skipped',
  );
  return {
    completedStepCount,
    totalStepCount: 9,
    status: resolved
      ? 'complete'
      : domainState.attempts.length > 0 || domainState.history.length > 0
        ? 'inProgress'
        : 'draft',
  };
}

export const CalibrationWorkspaceStateRecord = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(256),
    description: z.string().max(4_096).nullable(),
    printerId: z.string().min(1).max(256),
    status: z.enum([
      'draft',
      'inProgress',
      'awaitingGeneration',
      'generated',
      'complete',
      'archived',
    ]),
    completedStepCount: z.number().int().nonnegative().max(9),
    totalStepCount: z.number().int().nonnegative().max(9),
    isSynced: z.boolean(),
    isPrinterContextFresh: z.boolean(),
    hasConflicts: z.boolean(),
    remoteProjectId: z.string().uuid().nullable(),
    baseRevision: z.number().int().nonnegative().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    workspaceState: CalibrationWorkspacePayload,
  })
  .strict();
export type CalibrationWorkspaceStateRecord = z.infer<
  typeof CalibrationWorkspaceStateRecord
>;

export const CalibrationListWorkspaceStatesRequest = z
  .object({ profileId: z.string().uuid() })
  .strict();
export type CalibrationListWorkspaceStatesRequest = z.infer<
  typeof CalibrationListWorkspaceStatesRequest
>;
export const CalibrationUnhydratedProject = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(256),
    description: z.string().max(4_096).nullable(),
    printerId: z.string().min(1).max(256),
    status: CalibrationWorkspaceStateRecord.shape.status,
    isSynced: z.literal(true),
    isPrinterContextFresh: z.literal(false),
    hasConflicts: z.boolean(),
    remoteProjectId: z.string().uuid(),
    baseRevision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recoveryState: z.literal('migrationRequired'),
  })
  .strict();
export type CalibrationUnhydratedProject = z.infer<
  typeof CalibrationUnhydratedProject
>;
export const CalibrationListWorkspaceStatesResponse = z
  .object({
    states: z.array(CalibrationWorkspaceStateRecord).max(500),
    unhydratedProjects: z.array(CalibrationUnhydratedProject).max(500),
  })
  .strict();
export type CalibrationListWorkspaceStatesResponse = z.infer<
  typeof CalibrationListWorkspaceStatesResponse
>;

export const CalibrationGetWorkspaceStateRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
  })
  .strict();
export type CalibrationGetWorkspaceStateRequest = z.infer<
  typeof CalibrationGetWorkspaceStateRequest
>;
export const CalibrationGetWorkspaceStateResponse =
  CalibrationWorkspaceStateRecord.nullable();
export type CalibrationGetWorkspaceStateResponse = z.infer<
  typeof CalibrationGetWorkspaceStateResponse
>;

export const CalibrationSaveWorkspaceStateRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(256),
    description: z.string().max(4_096).nullable().optional(),
    printerId: z.string().min(1).max(256),
    status: CalibrationWorkspaceStateRecord.shape.status,
    completedStepCount: z.number().int().nonnegative().max(9),
    totalStepCount: z.number().int().min(1).max(9),
    baseRevision: z.number().int().nonnegative().nullable().optional(),
    operationId: z.string().uuid(),
    workspaceState: CalibrationWorkspacePayload,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    const workspace = value.workspaceState;
    const binding = workspace.domainState.binding.printer;
    const projection = deriveCalibrationWorkspaceProjection(
      workspace.domainState,
    );
    if (workspace.domainState.projectId !== value.projectId) {
      workspaceIssue(
        context,
        ['workspaceState', 'domainState', 'projectId'],
        'Workspace project identity must match the request.',
      );
    }
    if (binding.backendProfileId !== value.profileId) {
      workspaceIssue(
        context,
        [
          'workspaceState',
          'domainState',
          'binding',
          'printer',
          'backendProfileId',
        ],
        'Workspace profile identity must match the request.',
      );
    }
    if (binding.backendPrinterId !== value.printerId) {
      workspaceIssue(
        context,
        [
          'workspaceState',
          'domainState',
          'binding',
          'printer',
          'backendPrinterId',
        ],
        'Workspace printer identity must match the request.',
      );
    }
    if (
      workspace.metadata.displayName !== value.displayName ||
      workspace.metadata.description !== (value.description ?? '')
    ) {
      workspaceIssue(
        context,
        ['workspaceState', 'metadata'],
        'Workspace metadata must match the request projection.',
      );
    }
    if (workspace.domainState.createdAt !== value.createdAt) {
      workspaceIssue(
        context,
        ['workspaceState', 'domainState', 'createdAt'],
        'Workspace creation time must match the request.',
      );
    }
    if (
      value.completedStepCount !== projection.completedStepCount ||
      value.totalStepCount !== projection.totalStepCount
    ) {
      workspaceIssue(
        context,
        ['completedStepCount'],
        'Workspace step counts must be derived from domain stage state.',
      );
    }
    if (value.status !== projection.status) {
      workspaceIssue(
        context,
        ['status'],
        'Workspace status must be derived from domain stage state.',
      );
    }
  });
export type CalibrationSaveWorkspaceStateRequest = z.infer<
  typeof CalibrationSaveWorkspaceStateRequest
>;
export const CalibrationSaveWorkspaceStateResponse = z
  .object({
    state: CalibrationWorkspaceStateRecord,
    queued: z.literal(true),
  })
  .strict();
export type CalibrationSaveWorkspaceStateResponse = z.infer<
  typeof CalibrationSaveWorkspaceStateResponse
>;

// --- Calibration step stages -----------------------------------------------

/** The ordered calibration stages. Step ordering is significant and may not be
 *  silently reordered without an explicit user action on a supported step. */
export const CalibrationStepKind = z.enum([
  'temperatureTower',
  'retraction',
  'flowRate',
  'pressureAdvance',
  'firstLayerHeight',
  'firstLayerWidth',
  'overhangAngle',
  'toleranceTest',
  'speedTest',
]);
export type CalibrationStepKind = z.infer<typeof CalibrationStepKind>;

export const CalibrationStepStatus = z.enum([
  'pending',
  'inProgress',
  'observationRequired',
  'complete',
  'skipped',
]);
export type CalibrationStepStatus = z.infer<typeof CalibrationStepStatus>;

/** A single step in a calibration project. Steps are strictly ordered. */
export const CalibrationStep = z
  .object({
    stepId: z.string().uuid(),
    /** 0-indexed stable ordinal assigned at project creation; reordering bumps a draft field only. */
    ordinal: z.number().int().nonnegative().max(99),
    kind: CalibrationStepKind,
    status: CalibrationStepStatus,
    /** User-editable display title (draft field). */
    displayName: z.string().min(1).max(128),
    /** Freetext prerequisites the user has recorded for this step (draft). */
    prerequisites: z.string().max(2048).nullable(),
    /** Freetext method notes (draft). */
    methodNotes: z.string().max(4096).nullable(),
    /** The step's expected result description (draft). */
    expectedResult: z.string().max(2048).nullable(),
    /** The step's actual measured result, once complete (append-only). */
    measuredResult: z.string().max(4096).nullable(),
    /** Whether this step can be reordered by the user. */
    reorderingSupported: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CalibrationStep = z.infer<typeof CalibrationStep>;

// --- Calibration projects and drafts ---------------------------------------

export const CalibrationProjectStatus = z.enum([
  'draft',
  'inProgress',
  'awaitingGeneration',
  'generated',
  'complete',
  'archived',
]);
export type CalibrationProjectStatus = z.infer<typeof CalibrationProjectStatus>;

/**
 * Summary of one calibration project. The renderer receives this for list
 * views; full aggregates are fetched via getProject.
 */
export const CalibrationProjectSummary = z
  .object({
    projectId: z.string().uuid(),
    profileId: z.string().uuid(),
    printerId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    status: CalibrationProjectStatus,
    stepCount: z.number().int().nonnegative().max(50),
    completedStepCount: z.number().int().nonnegative().max(50),
    /** Whether the project has unresolved sync conflicts. */
    hasConflicts: z.boolean(),
    /** Whether all outbox mutations are synchronized. */
    isSynced: z.boolean(),
    /** Whether printer context is freshly validated (required for generation/print). */
    isPrinterContextFresh: z.boolean(),
    remoteProjectId: z.string().uuid().nullable(),
    baseRevision: z.number().int().nonnegative().nullable(),
    /** Remote summaries without an exact workspace remain recoverable. */
    recoveryState: z.literal('migrationRequired').nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CalibrationProjectSummary = z.infer<
  typeof CalibrationProjectSummary
>;

/** Full calibration project aggregate returned by getProject. */
export const CalibrationProject = z
  .object({
    projectId: z.string().uuid(),
    profileId: z.string().uuid(),
    printerId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    description: z.string().max(4096).nullable(),
    status: CalibrationProjectStatus,
    steps: z.array(CalibrationStep).max(50),
    /** Bound immutable printer context snapshot. */
    printerContext: CalibrationPrinterContext,
    hasConflicts: z.boolean(),
    isSynced: z.boolean(),
    isPrinterContextFresh: z.boolean(),
    remoteProjectId: z.string().uuid().nullable(),
    baseRevision: z.number().int().nonnegative().nullable(),
    /** Opaque cursor for the project's change feed position. */
    changeFeedCursor: z.string().max(4096).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CalibrationProject = z.infer<typeof CalibrationProject>;

// --- Drafts ----------------------------------------------------------------

/**
 * Field-level draft mutation payload. Only the fields included are updated;
 * absent fields are not touched. Measurements and selections are excluded
 * from offline drafts — those are append-only server-authoritative fields.
 */
export const CalibrationDraftFields = z
  .object({
    /** Project-level display name. */
    displayName: z.string().trim().min(1).max(256).optional(),
    /** Project-level description. */
    description: z.string().max(4096).optional(),
    /** Step-level field updates, keyed by stepId. */
    stepDrafts: z
      .array(
        z
          .object({
            stepId: z.string().uuid(),
            displayName: z.string().trim().min(1).max(128).optional(),
            ordinal: z.number().int().nonnegative().max(99).optional(),
            prerequisites: z.string().max(2048).nullable().optional(),
            methodNotes: z.string().max(4096).nullable().optional(),
            expectedResult: z.string().max(2048).nullable().optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();
export type CalibrationDraftFields = z.infer<typeof CalibrationDraftFields>;

// --- Calibration attempts ---------------------------------------------------

/** A single discrete attempt at one calibration step. Append-only. */
export const CalibrationAttempt = z
  .object({
    attemptId: z.string().uuid(),
    stepId: z.string().uuid(),
    projectId: z.string().uuid(),
    profileId: z.string().uuid(),
    /** Server-assigned attempt number within the step. */
    attemptNumber: z.number().int().positive().max(999),
    /** The measured parameter value (if observation produced one). */
    measuredValue: z.number().finite().nullable(),
    measuredUnit: z.string().max(32).nullable(),
    /** Whether this attempt was selected as the outcome for the step. */
    isSelected: z.boolean(),
    /** PrintFarmer is authoritative for this; client never silently overrides. */
    printerContextSnapshotHash: z.string().max(256).nullable(),
    remoteAttemptId: z.string().uuid().nullable(),
    remoteRevision: z.number().int().nonnegative().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CalibrationAttempt = z.infer<typeof CalibrationAttempt>;

// --- Calibration events and observations -----------------------------------

/** An immutable event recorded during a calibration attempt. Append-only. */
export const CalibrationEvent = z
  .object({
    eventId: z.string().uuid(),
    attemptId: z.string().uuid(),
    stepId: z.string().uuid(),
    projectId: z.string().uuid(),
    profileId: z.string().uuid(),
    kind: z.string().min(1).max(64),
    payload: z.record(z.unknown()).default({}),
    remoteEventId: z.string().uuid().nullable(),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type CalibrationEvent = z.infer<typeof CalibrationEvent>;

/** A physical measurement observation attached to an attempt. Append-only. */
export const CalibrationObservation = z
  .object({
    observationId: z.string().uuid(),
    attemptId: z.string().uuid(),
    stepId: z.string().uuid(),
    projectId: z.string().uuid(),
    profileId: z.string().uuid(),
    /** The measured parameter key (e.g. 'flowRate', 'retractionDistance'). */
    parameterKey: z.string().min(1).max(64),
    numericValue: z.number().finite().nullable(),
    unit: z.string().max(32).nullable(),
    /** User-supplied qualitative note for this observation. */
    note: z.string().max(2048).nullable(),
    remoteObservationId: z.string().uuid().nullable(),
    observedAt: z.string().datetime(),
  })
  .strict();
export type CalibrationObservation = z.infer<typeof CalibrationObservation>;

// --- Staged photos ---------------------------------------------------------

export const StagedPhotoStatus = z.enum([
  /** Photo is stored locally, not yet uploaded. */
  'staged',
  /** Upload is in progress. */
  'uploading',
  /** Upload completed successfully. */
  'uploaded',
  /** Upload failed (will retry). */
  'failed',
  /** Conflicted — upload succeeded but server version differs. */
  'conflicted',
]);
export type StagedPhotoStatus = z.infer<typeof StagedPhotoStatus>;

/**
 * Metadata for a photo staged offline. The renderer never receives raw photo
 * bytes; it may only reference photos by their stable hash.
 */
export const StagedPhoto = z
  .object({
    photoId: z.string().uuid(),
    attemptId: z.string().uuid(),
    stageId: CalibrationWorkspaceStageId,
    projectId: z.string().uuid(),
    profileId: z.string().uuid(),
    /** SHA-256 hash of the photo bytes (stable content identity). */
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    /** File size in bytes. */
    byteSize: z.number().int().positive().max(20_000_000),
    status: StagedPhotoStatus,
    uploadAttempts: z.number().int().nonnegative().max(100),
    remotePhotoId: z.string().uuid().nullable(),
    remoteUrl: z.string().max(4096).nullable(),
    stagedAt: z.string().datetime(),
    uploadedAt: z.string().datetime().nullable(),
    caption: z.string().min(1).max(512),
    order: z.number().int().min(1).max(1_000),
  })
  .strict();
export type StagedPhoto = z.infer<typeof StagedPhoto>;

/**
 * Photo staging request. The renderer provides a dialog-approved opaque
 * approval ID; the main process resolves the actual file path.
 *
 * Retained intentionally (issue #758) despite having zero current production
 * consumers: PrintFarmer #1940 (Path D) keeps calibration photos server-side
 * as a fit for filament calibration, and re-adding this channel only needs
 * the key/handler/wire/preload wiring restored, not a new contract.
 */
export const CalibrationStagePhotoRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    stageId: CalibrationWorkspaceStageId,
    attemptId: z.string().uuid(),
    /** Opaque, sender-bound approval ID from calibration:openPhoto. */
    approvalId: z.string().uuid(),
    /** Client-generated stable photo ID for idempotency. */
    photoId: z.string().uuid(),
    caption: z.string().min(1).max(512),
    order: z.number().int().min(1).max(1_000),
  })
  .strict();
export type CalibrationStagePhotoRequest = z.infer<
  typeof CalibrationStagePhotoRequest
>;
export const CalibrationStagePhotoResponse = StagedPhoto;
export type CalibrationStagePhotoResponse = z.infer<
  typeof CalibrationStagePhotoResponse
>;

// --- Generated profile revisions ------------------------------------------

/**
 * A generated OrcaSlicer filament profile revision.
 * The exact profile JSON is managed by PrintFarmer; PFD caches metadata only.
 * PrintFarmer is authoritative for the content of generated revisions.
 */
export const GeneratedProfileRevision = z
  .object({
    revisionId: z.string().uuid(),
    projectId: z.string().uuid(),
    profileId: z.string().uuid(),
    /** Human-readable revision label (e.g. "v3 — 2026-07-26"). */
    revisionLabel: z.string().min(1).max(256),
    /** Whether this is the currently promoted/selected profile revision. */
    isPromoted: z.boolean(),
    /** The OrcaSlicer profile name this revision targets. */
    targetOrcaProfileId: z.string().max(512).nullable(),
    /** SHA-256 of the generated profile JSON (content identity, not the JSON itself). */
    profileJsonHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    remoteRevisionId: z.string().uuid().nullable(),
    generatedAt: z.string().datetime(),
    promotedAt: z.string().datetime().nullable(),
  })
  .strict();
export type GeneratedProfileRevision = z.infer<typeof GeneratedProfileRevision>;

// --- Outbox operations -------------------------------------------------------

export const CalibrationOutboxOperationKind = z.enum([
  'saveProjectDraft',
  'saveStepDraft',
  'recordObservation',
  'selectAttemptOutcome',
  'stagePhoto',
  'retractPhoto',
  'reorderSteps',
]);
export type CalibrationOutboxOperationKind = z.infer<
  typeof CalibrationOutboxOperationKind
>;

export const CalibrationOutboxOperationState = z.enum([
  /** Not yet claimed for push. */
  'pending',
  /** Claimed, upload in flight. */
  'leased',
  /** Applied successfully on the server. */
  'settled',
  /** Apply failed; awaiting retry. */
  'failed',
  /** Exact replay accepted (idempotent re-send). */
  'replayed',
  /** Manually superseded by the user (conflict resolution). */
  'superseded',
]);
export type CalibrationOutboxOperationState = z.infer<
  typeof CalibrationOutboxOperationState
>;

export const CalibrationOutboxOperation = z
  .object({
    operationId: z.string().uuid(),
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    kind: CalibrationOutboxOperationKind,
    /** Stable ordering sequence for dependency-ready push. */
    sequence: z.number().int().nonnegative(),
    state: CalibrationOutboxOperationState,
    /** Server base revision the operation targets (for precondition checks). */
    baseRevision: z.number().int().nonnegative().nullable(),
    attemptCount: z.number().int().nonnegative().max(100),
    lastError: z.string().max(1024).nullable(),
    retryAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CalibrationOutboxOperation = z.infer<
  typeof CalibrationOutboxOperation
>;

// --- Sync status -----------------------------------------------------------

export const CalibrationSyncPhase = z.enum([
  'idle',
  'validatingCapabilities',
  'pushingOperations',
  'pullingChanges',
  'hydratingAggregates',
  'succeeded',
  'partialConflict',
  'failed',
]);
export type CalibrationSyncPhase = z.infer<typeof CalibrationSyncPhase>;

export const CalibrationSyncStatus = z
  .object({
    phase: CalibrationSyncPhase,
    profileId: z.string().uuid().nullable(),
    projectId: z.string().uuid().nullable(),
    pushedOperations: z.number().int().nonnegative(),
    pulledChanges: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
    cursor: z.string().max(4096).nullable(),
    error: z.string().max(1024).nullable(),
  })
  .strict();
export type CalibrationSyncStatus = z.infer<typeof CalibrationSyncStatus>;

export const CalibrationSyncNowRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
  })
  .strict();
export type CalibrationSyncNowRequest = z.infer<
  typeof CalibrationSyncNowRequest
>;
export const CalibrationSyncNowResponse = CalibrationSyncStatus;
export type CalibrationSyncNowResponse = z.infer<
  typeof CalibrationSyncNowResponse
>;

// --- Diagnostics (issue #159) ---------------------------------------------

/**
 * Copyable calibration health report.
 *
 * Every field here is either a version string, a boolean flag, a
 * `resource:action` scope, a count, a typed error code, or an identifier. There
 * is deliberately no field for a token, a credential, a photo, a server message
 * or a filesystem path, so the response cannot carry a secret by construction —
 * the same structural rule the log records follow.
 *
 * `capability` and `lastSync` are observed in memory during the current app run
 * and are null until calibration has negotiated and synced at least once since
 * the app started. A null is "not observed yet", not "broken".
 */
export const CalibrationCapabilitySnapshot = z
  .object({
    negotiatedApiVersion: z.string().max(64).nullable(),
    negotiatedSchemaVersion: z.string().max(64).nullable(),
    apiContractVersion: z.string().max(64),
    flags: CalibrationCapabilityFlags,
    /** Per-flag advertisement state (#493): `'true'` | `'false'` | `'unknown'`. */
    flagAdvertisement: CalibrationCapabilityFlagAdvertisement,
    grantedScopes: z.array(z.string().max(64)).max(64),
    negotiatedAt: z.string().datetime(),
  })
  .strict();
export type CalibrationCapabilitySnapshot = z.infer<
  typeof CalibrationCapabilitySnapshot
>;

export const CalibrationOutboxSnapshot = z
  .object({
    pendingOperationCount: z.number().int().nonnegative(),
    unresolvedConflictCount: z.number().int().nonnegative(),
  })
  .strict();
export type CalibrationOutboxSnapshot = z.infer<
  typeof CalibrationOutboxSnapshot
>;

/**
 * Why `outbox` is null. Only `readFailed` indicates a fault; the other two are
 * benign "nothing was asked" states. Keeping them distinct is what lets a
 * runbook name a cause instead of keying on absence (issue #236).
 */
export const CalibrationOutboxUnavailableReason = z.enum([
  'notAttempted',
  'noProfileSelected',
  'readFailed',
]);
export type CalibrationOutboxUnavailableReason = z.infer<
  typeof CalibrationOutboxUnavailableReason
>;

export const CalibrationLastSyncSnapshot = z
  .object({
    outcome: z.enum(['ok', 'failed']),
    at: z.string().datetime(),
    errorCode: z.string().max(64).nullable(),
    correlationId: z.string().max(128).nullable(),
  })
  .strict();
export type CalibrationLastSyncSnapshot = z.infer<
  typeof CalibrationLastSyncSnapshot
>;

export const CalibrationGetDiagnosticsRequest = z
  .object({
    profileId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
  })
  .strict();
export type CalibrationGetDiagnosticsRequest = z.infer<
  typeof CalibrationGetDiagnosticsRequest
>;

export const CalibrationGetDiagnosticsResponse = z
  .object({
    generatedAt: z.string().datetime(),
    profileId: z.string().uuid().nullable(),
    capability: CalibrationCapabilitySnapshot.nullable(),
    outbox: CalibrationOutboxSnapshot.nullable(),
    outboxUnavailableReason: CalibrationOutboxUnavailableReason.nullable(),
    lastSync: CalibrationLastSyncSnapshot.nullable(),
    observedSinceAppStart: z.boolean(),
    /** Pre-formatted plain text for pasting into a bug report. */
    report: z.string().max(8192),
  })
  .strict();
export type CalibrationGetDiagnosticsResponse = z.infer<
  typeof CalibrationGetDiagnosticsResponse
>;

// --- Conflicts and resolutions -------------------------------------------

export const CalibrationConflictKind = z.enum([
  /** Project metadata (displayName, description) changed concurrently. */
  'projectMetadata',
  /** Step ordering changed concurrently. */
  'stepOrdering',
  /** Step draft fields (method, prerequisites, expected result) conflict. */
  'stepDraft',
  /** Selected current observation/attempt diverged. */
  'outcomeSelection',
  /** Cached printer snapshot is stale vs server. */
  'staleprinterSnapshot',
  /** Local edit vs server deletion. */
  'deletionVsLocalEdit',
]);
export type CalibrationConflictKind = z.infer<typeof CalibrationConflictKind>;

/**
 * Valid resolution strategies. Only semantically safe strategies are exposed;
 * there is intentionally no last-write-wins option.
 */
export const CalibrationConflictResolution = z.enum([
  /** Accept the server version; discard local changes. */
  'acceptServer',
  /** Keep local changes as a new revision, submitted on top of server state. */
  'keepLocalAsNewRevision',
  /**
   * Manual field-level merge — only available for metadata/draft conflicts
   * where a textual merge is well-defined. Not available for measurements,
   * exact profile JSON, or outcome selections.
   */
  'manualFieldMerge',
]);
export type CalibrationConflictResolution = z.infer<
  typeof CalibrationConflictResolution
>;

export const CalibrationConflict = z
  .object({
    conflictId: z.string().uuid(),
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    kind: CalibrationConflictKind,
    /** The entity ID that is conflicted (stepId, attemptId, projectId, etc.). */
    entityId: z.string().uuid(),
    /** JSON-serialized local payload at conflict time. Never contains credentials. */
    localPayloadSummary: z.string().max(4096).nullable(),
    /** JSON-serialized server payload at conflict time. */
    serverPayloadSummary: z.string().max(4096).nullable(),
    serverRevision: z.number().int().nonnegative(),
    /** Available resolutions for this conflict kind. */
    availableResolutions: z.array(CalibrationConflictResolution).max(3),
    resolvedAt: z.string().datetime().nullable(),
    resolution: CalibrationConflictResolution.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type CalibrationConflict = z.infer<typeof CalibrationConflict>;

export const CalibrationResolveConflictRequest = z
  .object({
    profileId: z.string().uuid(),
    conflictId: z.string().uuid(),
    resolution: CalibrationConflictResolution,
    /**
     * For manualFieldMerge: the merged field values (plain text, no credentials).
     * Only accepted for metadata/draft conflict kinds. Both the key (a field
     * name) and the value are bounded -- `z.record(valueSchema)` only bounds
     * values, so an unbounded key type here would leave field *names*
     * unbounded even though the comment above and the 20-key/4096-char-value
     * limits below imply the whole structure is capped.
     */
    mergedFields: z
      .record(z.string().min(1).max(200), z.string().max(4096))
      .optional()
      .refine((fields) => !fields || Object.keys(fields).length <= 20),
  })
  .strict();
export type CalibrationResolveConflictRequest = z.infer<
  typeof CalibrationResolveConflictRequest
>;
/**
 * An observation whose binding printer-snapshot revision is behind the revision
 * a resolution accepted.
 *
 * Identifiers here are `z.string()`, not `z.string().uuid()`, on purpose. The
 * sidecar does not mint these ids, so a UUID demand would reject real rows and
 * — because parsing is all-or-nothing — discard the entire supersession report
 * along with them. That is exactly the defect #194 found in the conflict list
 * path, where `conflict-` prefixed ids failed a `uuid()` contract and took the
 * whole response with them.
 */
export const CalibrationSupersededObservation = z
  .object({
    observationId: z.string().min(1).max(200),
    attemptId: z.string().min(1).max(200),
    stepId: z.string().min(1).max(200),
    parameterKey: z.string().min(1).max(200),
    boundSnapshotRevision: z.number().int().nonnegative(),
  })
  .strict();
export type CalibrationSupersededObservation = z.infer<
  typeof CalibrationSupersededObservation
>;

export const CalibrationResolveConflictResponse = z
  .object({
    conflict: CalibrationConflict,
    /**
     * Observations the accepted revision superseded. Accepting a server
     * snapshot reports them; it does not invalidate them, because cascading
     * would destroy measurement work whose blast radius is invisible at the
     * moment of pressing. Invalidation is a separate, explicit action.
     *
     * Required, and deliberately without `.default([])`. A default would let a
     * responder that reports nothing parse as one reporting an empty set, and
     * those are different claims: "nothing was superseded" is a measurement,
     * "this resolution does not report supersession" is not. A caller that
     * cannot separate them renders an unexamined snapshot as clean.
     */
    supersededObservations: z.array(CalibrationSupersededObservation).max(1000),
  })
  .strict();
export type CalibrationResolveConflictResponse = z.infer<
  typeof CalibrationResolveConflictResponse
>;

/**
 * List unresolved calibration conflicts for a profile (issue #762).
 *
 * `projectId` is optional and, when omitted, lists conflicts across every
 * project the profile owns -- this mirrors
 * `SidecarCalibrationAdapter.listCalibrationConflicts(profileId, projectId)`,
 * whose `projectId` parameter is already `string | null`.
 */
export const CalibrationListConflictsRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CalibrationListConflictsRequest = z.infer<
  typeof CalibrationListConflictsRequest
>;

export const CalibrationListConflictsResponse = z
  .object({
    conflicts: z.array(CalibrationConflict).max(500),
  })
  .strict();
export type CalibrationListConflictsResponse = z.infer<
  typeof CalibrationListConflictsResponse
>;

// --- Generation and G-code queue ------------------------------------------

/**
 * ProblemDetails-mapped typed error states from the calibration API.
 * The renderer receives these typed codes rather than raw HTTP status text.
 */
export const CalibrationApiErrorCode = z.enum([
  /** HTTP 428 — precondition required (e.g., base revision missing). */
  'preconditionRequired',
  /** HTTP 412 — revision conflict (If-Match mismatch). */
  'revisionConflict',
  /** HTTP 409 — idempotency key payload changed. */
  'idempotencyPayloadChanged',
  /** HTTP 422 — invalid/unsafe data submitted. */
  'invalidData',
  /** HTTP 503 — generation worker or telemetry service unavailable. */
  'workerUnavailable',
  /** Generic transient server error. */
  'serverError',
  /** The operation is disabled until sync completes. */
  'syncRequired',
  /** The printer context is stale and must be revalidated. */
  'printerContextStale',
  // --- Bed-clear / queue-specific codes (issue #54) -----------------------
  /** HTTP 403 — caller does not have queue:acknowledge-bed-clear or queue:start. */
  'forbidden',
  /** HTTP 404 job_not_found — the queue job does not exist. */
  'jobNotFound',
  /** HTTP 409 wrong_job — bed-clear was for a different job. */
  'wrongJob',
  /** HTTP 409 printer_busy — printer already has an active job. */
  'printerBusy',
  /** HTTP 409 job_not_dispatchable — job is not in a dispatchable state. */
  'jobNotDispatchable',
  /** HTTP 412 dispatch_revision_conflict — ETag mismatch; response body carries current ETags. */
  'dispatchRevisionConflict',
  /** HTTP 422 calibration_job_incompatible — job is incompatible with the assigned printer. */
  'calibrationJobIncompatible',
  /** HTTP 422 filament_check_failed — filament material or nozzle mismatch. */
  'filamentCheckFailed',
  // --- Filament-calibration slice-pipeline codes (owner reframe 2026-08-23) --
  /**
   * HTTP 422 `unsupported_calibration_method` from `POST /api/slice` when a
   * calibration method wire name is not recognised by upstream PR #1952's
   * `CalibrationMethod` parser. Distinct from `invalidData` because the
   * `supportedMethods` list is echoed in the ProblemDetails extension and the
   * renderer surfaces it verbatim — the fix is "pick one of these", never
   * "clean up the payload".
   */
  'unsupportedCalibrationMethod',
  /**
   * HTTP 403 on `POST /api/slicer/profiles/clone` or
   * `PUT /api/slicer/profiles/custom/{id}` from the
   * `InteractiveSessionRequirement` authorization gate (upstream
   * `ProfilesController.cs:1247-1283, 1352-1395`). Distinct from `forbidden`
   * because the operator can recover — sign in via the app's interactive
   * session rather than a background token — instead of being told the scope
   * is missing.
   */
  'interactiveSessionRequired',
  /**
   * Terminal `Failed` reached during slice-job polling
   * (`GET /api/slice/{jobId}` returned `status: 'Failed'`). Distinct from a
   * transient poll-transport error because the server has finished with the
   * job — no amount of retry against the same job id will change the outcome.
   */
  'sliceJobFailed',
  /**
   * Slice-job poll driver reached its wall-clock cap without observing a
   * terminal status. Distinct from `sliceJobFailed` because the server has
   * *not* declared the job dead — the desktop has given up watching.
   */
  'sliceJobTimeout',
]);
export type CalibrationApiErrorCode = z.infer<typeof CalibrationApiErrorCode>;

export const CalibrationApiError = z
  .object({
    code: CalibrationApiErrorCode,
    message: z.string().max(512),
    /** Whether the operation may be retried. */
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().nonnegative().max(86_400).nullable(),
    /**
     * Opaque correlation reference the operator can quote to support (#177).
     *
     * `message` is catalogued: it is chosen from fixed literals keyed by the
     * error code, never copied from the backend. That alone would convert a
     * leak into an unrecoverable support case, because on some failures the
     * backend's `detail` is the only actionable information. This field is what
     * preserves recoverability without preserving the text: it names the flow,
     * so the raw detail can be read from the main-process log instead of being
     * shown to the renderer.
     *
     * The guarantee is **structural, not a filter**. The type is a UUID, so
     * server-supplied prose cannot be carried here even by a caller that tries:
     * a `detail` string fails `.uuid()` at the boundary. That is deliberately
     * the same shape of guarantee as `CalibrationLogInput` having no `message`
     * key — an allowlist over server-chosen content would be a filter, and a
     * filter over content this repository does not control fails open and
     * reports nothing when it does.
     *
     * Nullable rather than optional so every producer must decide. An optional
     * field that producers forget is null everywhere and nothing notices, which
     * is the inert-control shape this codebase keeps filing.
     */
    reference: z.string().uuid().nullable(),
    /**
     * Machine-readable ProblemDetails `errorCode`/`code` extension when the
     * refusal came from PrintFarmer's dispatch safety gates
     * (`DispatchSafetyGates.MapBlockedReason` — e.g.
     * `firmware_family_mismatch`, `calibration_record_mismatch`,
     * `capabilities_unsatisfied`). Nullable when the failure was not a gated
     * refusal, and null-defaulted rather than nullable-required so the fifteen
     * manually-constructed error paths in `src/main/ipc.ts` do not need to
     * decide null for every fault of a fault that is never a gated one.
     *
     * NOT the same disposition as `serverDetail`. `serverDetail` is unbounded
     * server-controlled prose that could name a file path, a support ticket, a
     * GPS pair or an authenticated user, and the #177 disposition is that it
     * lives on `CalibrationHttpError.serverDetail` in the main process only —
     * the renderer sees a catalogued literal plus the opaque `reference`.
     * `blockedReasonCode` is the ProblemDetails `errorCode` extension (bounded
     * to 64 characters and used by PrintFarmer as an enum-shaped machine
     * identifier). The 64-char bound is enforced where the value is actually
     * derived — the `RemoteCalibrationProblemDetails` `.transform` in
     * `calibrationWire.ts`, which clips its coalesced `errorCode` result, and
     * the separate `readJobErrorEnvelope` clip in `calibrationHttp.ts` for the
     * bed-clear/job-queue path — not by the raw `errorCode` field's own
     * `.max(64)` alone, which a server could bypass via the wider (256-char)
     * `error` fallback the transform also coalesces (issue #743: an
     * unenforced mismatch here let a 65-256-char server value throw a Zod
     * validation exception at IPC serialization instead of failing closed).
     * Its purpose is exactly to be translated on the receiving side, the same way `code`
     * above is translated to a catalogued literal in `toApiError`. Bounded and
     * enum-shaped rather than free-form is what makes the difference; a token
     * is at most as leak-prone as the HTTP status code.
     *
     * Read this in the renderer via `describeBlockedReasonCode`, which pins
     * every known code to a sentence and returns the raw code on an
     * unrecognised token so a visible unknown remains debuggable. Never
     * substitute for `message` — the catalogue literal names the HTTP-level
     * category ("Bed-clear conflict") and this code names the specific gate
     * that closed. An operator needs both.
     */
    blockedReasonCode: z.string().max(64).nullable().optional(),
  })
  .strict();
export type CalibrationApiError = z.infer<typeof CalibrationApiError>;

/**
 * An individual problem within an orchestration status (validation or execution issue).
 */
export const CalibrationOrchestrationProblem = z
  .object({
    code: z.string(),
    field: z.string().nullable(),
    message: z.string(),
  })
  .passthrough();
export type CalibrationOrchestrationProblem = z.infer<
  typeof CalibrationOrchestrationProblem
>;

/**
 * Orchestration status for a G-code generation run.
 * `status` and `currentStep` are free-form strings defined by the saga
 * implementation — never switch exhaustively on them; always render the
 * raw value with a fallback for unrecognised states.
 */
export const CalibrationOrchestrationStatus = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    attemptId: z.string().uuid(),
    operationId: z.string(),
    /** Free-form status from the saga — e.g. "Running", "Completed". NOT an enum. */
    status: z.string(),
    /** Free-form current step — e.g. "submitting-slice-job", "awaiting-worker". NOT an enum. */
    currentStep: z.string(),
    revision: z.number().int(),
    retryCount: z.number().int(),
    nextRetryAtUtc: z.string().datetime().nullable(),
    stepStartedAtUtc: z.string().datetime().nullable(),
    lastErrorCode: z.string().nullable(),
    problems: z.array(CalibrationOrchestrationProblem).max(100).default([]),
    model3DId: z.string().uuid().nullable(),
    sliceJobId: z.string().uuid().nullable(),
    workerId: z.string().uuid().nullable(),
    sourceArtifactId: z.string().uuid().nullable(),
    finalArtifactId: z.string().uuid().nullable(),
    gcodeFileId: z.string().uuid().nullable(),
    specificationSha256: z.string().nullable(),
    planManifestSha256: z.string().nullable(),
    gcodeSha256: z.string().nullable(),
    manifestSha256: z.string().nullable(),
    generatorVersion: z.string().nullable(),
    slicerContainerDigest: z.string().nullable(),
    slicerBinarySha256: z.string().nullable(),
    statusRoute: z.string(),
    createdAtUtc: z.string().datetime(),
    updatedAtUtc: z.string().datetime(),
    completedAtUtc: z.string().datetime().nullable(),
  })
  .passthrough();
export type CalibrationOrchestrationStatus = z.infer<
  typeof CalibrationOrchestrationStatus
>;

/**
 * Full state of a queue job as returned by GET /api/job-queue/{id}.
 * `status` is a PrintJobStatus enum value; `dispatchAttemptOutcome` is a
 * DispatchAttemptOutcome value. Both are passed as strings (not enums) for
 * forward compatibility.
 */
export const CalibrationQueueJobState = z
  .object({
    jobId: z.string().uuid(),
    jobKind: z.string().nullable(),
    /** Job rowVersion (opaque base-64 ETag). Send byte-identical as If-Match. */
    rowVersion: z.string().nullable(),
    /** Logical job revision persisted alongside the row-version token. */
    jobRevision: z.number().int().nonnegative(),
    /** Dispatch state rowVersion (opaque base-64 ETag). Send as X-Dispatch-State-If-Match. */
    dispatchStateRowVersion: z.string().nullable(),
    /** Logical dispatch-state revision persisted alongside its ETag. */
    dispatchStateRevision: z.number().int().nonnegative().nullable(),
    /** PrintJobStatus literal: Queued|Assigned|Starting|Printing|Paused|Completed|Failed|Cancelled */
    status: z.string().nullable(),
    /** DispatchAttemptOutcome literal: InProgress|Accepted|Rejected|FailedBeforeStart|Unknown */
    dispatchAttemptOutcome: z.string().nullable(),
    /** BedClearState literal: None|Acknowledged|Consumed|Invalidated */
    bedClearState: z.string().nullable(),
    gcodeFileId: z.string().uuid().nullable(),
    assignedPrinterId: z.string().uuid().nullable(),
    /** Assigned printer display name from server (passthrough from JobQueuePrintJobDto). */
    assignedPrinterName: z.string().nullable().optional(),
    /** ISO 8601 UTC expiry for an active bed-clear acknowledgement. null = no expiry. */
    acknowledgementExpiresAt: z.string().datetime().nullable().optional(),
    calibrationProjectId: z.string().uuid().nullable(),
    calibrationAttemptId: z.string().uuid().nullable(),
    calibrationOrchestrationId: z.string().uuid().nullable(),
    pinnedPrinterConfigRevision: z.number().int().nullable(),
    /** Durable exact-job bed-clear command identity, when one exists. */
    bedClearCommandId: z.string().uuid().nullable(),
    /** Lowercase SHA-256 of the exact case-sensitive UTF-8 idempotency key. */
    bedClearIdempotencyKeySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    bedClearExpiresAtUtc: z.string().datetime().nullable(),
    priority: z.number().int(),
    queuePosition: z.number().int(),
    updatedAt: z.string().datetime(),
    /** Firmware family required at job creation time (e.g. 'Klipper'). Passthrough from QueuePrintJobDto. */
    requiredFirmwareFamily: z.string().max(256).nullable().optional(),
    /** Filament SKU required at job creation time. Passthrough from QueuePrintJobDto. */
    requiredFilamentSku: z.string().max(256).nullable().optional(),
    /** Machine profile SHA-256 at job creation time. Used for stale-context detection. */
    machineProfileSha256: z.string().max(256).nullable().optional(),
    /**
     * Whether print start is allowed. Emitted by the server on job DTOs when
     * `dispatchStateRowVersion` is present and the current job/dispatch state
     * has been evaluated for readiness (sync complete + printer fresh + bed
     * clear acknowledged where required). Optional/nullable so this schema
     * still accepts DTOs from server builds that do not yet emit it.
     */
    printStartAllowed: z.boolean().nullable().optional(),
    /**
     * When `printStartAllowed` is false, the typed reason. This is a
     * passthrough of `PrintStartBlockedReason` on the server-side job DTO.
     * (The `docs/runbooks/stale-dispatch-lease.md` reference formerly here
     * documented the printer-calibration saga runbook, reaped under #756.)
     * Renderer translation is driven from
     * `CalibrationApiError.blockedReasonCode` (which carries the code across
     * error responses from `/api/job-queue/{id}/start`); this field is the
     * *steady-state* companion for the same code on the job read path.
     */
    printStartBlockedReason: z.string().max(256).nullable().optional(),
  })
  .passthrough();
export type CalibrationQueueJobState = z.infer<typeof CalibrationQueueJobState>;

// --- Queue reconciliation / change feed (issue #54) ------------------------

/**
 * One event in the job-queue change feed.
 * `sequence` is monotonic — detect gaps by comparing consecutive values.
 * `schemaVersion` is "3" (current).
 *
 * CRITICAL: Printer-group envelopes are REDACTED — `jobId`, `bedClearState`,
 * `attemptOutcome`, and most operational fields are null. Never treat them as
 * job state. Subscribe via SubscribeToQueueJobAsync(jobId) for full envelopes.
 */
export const CalibrationQueueEventEnvelope = z
  .object({
    schemaVersion: z.string(),
    eventId: z.string().uuid(),
    sequence: z.number().int(),
    eventType: z.string(),
    occurredAtUtc: z.string().datetime(),
    jobId: z.string().uuid().nullable(),
    printerId: z.string().uuid().nullable(),
    projectId: z.string().uuid().nullable(),
    calibrationAttemptId: z.string().uuid().nullable(),
    /** PrintJobStatus literal: Queued|Assigned|Starting|Printing|Paused|Completed|Failed|Cancelled */
    jobStatus: z.string().nullable(),
    /** "Standard" | "FilamentCalibration" | null */
    jobKind: z.string().nullable(),
    /** Opaque base-64 job rowVersion */
    jobRevision: z.string().nullable(),
    /** Opaque base-64 dispatch state rowVersion */
    dispatchStateRevision: z.string().nullable(),
    attemptId: z.string().uuid().nullable(),
    attemptNumber: z.number().int().nullable(),
    /** DispatchAttemptOutcome: InProgress|Accepted|Rejected|FailedBeforeStart|Unknown */
    attemptOutcome: z.string().nullable(),
    /** BedClearState: None|Acknowledged|Consumed|Invalidated */
    bedClearState: z.string().nullable(),
    bedClearCommandId: z.string().uuid().nullable(),
    bedClearExpiresAtUtc: z.string().datetime().nullable(),
    failureCode: z.string().nullable(),
    failureRetryable: z.boolean().nullable(),
    failureRequiresReconciliation: z.boolean().nullable(),
    jobLogicalRevision: z.number().int().nullable(),
    dispatchStateLogicalRevision: z.number().int().nullable(),
  })
  .passthrough();
export type CalibrationQueueEventEnvelope = z.infer<
  typeof CalibrationQueueEventEnvelope
>;

/**
 * Returns `true` when a change-feed envelope belongs to a specific queue job.
 *
 * Redacted Printer-group envelopes (from the server's
 * `QueueEventEnvelope.RedactForPrinter()`) have `jobId === null` and always
 * return `false`, preventing them from being consumed as job-specific state.
 * See admin guide §10.5.
 *
 * Used by `CalibrationQueueDispatchPanel` and directly testable.
 */
export function isJobScopedEnvelope(
  evt: { readonly jobId: string | null },
  jobId: string,
): boolean {
  return evt.jobId === jobId;
}

export const CalibrationPollQueueChangesRequest = z
  .object({
    profileId: z.string().uuid(),
    /** Sequence cursor from the previous poll. Use 0 to start from the beginning. */
    afterSequence: z.number().int().min(0),
    /** Maximum events to return (server cap: 500). */
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type CalibrationPollQueueChangesRequest = z.infer<
  typeof CalibrationPollQueueChangesRequest
>;

export const CalibrationPollQueueChangesResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        afterSequence: z.number().int(),
        nextSequence: z.number().int(),
        hasMore: z.boolean(),
        /** Whether a gap was detected (missing sequences). Triggers REST refetch. */
        gapDetected: z.boolean(),
        events: z.array(CalibrationQueueEventEnvelope).max(500),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationPollQueueChangesResponse = z.infer<
  typeof CalibrationPollQueueChangesResponse
>;

export const CalibrationGetSubscriptionResourcesRequest = z
  .object({ profileId: z.string().uuid() })
  .strict();
export type CalibrationGetSubscriptionResourcesRequest = z.infer<
  typeof CalibrationGetSubscriptionResourcesRequest
>;

export const CalibrationGetSubscriptionResourcesResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        printerIds: z.array(z.string().uuid()).max(500),
        jobIds: z.array(z.string().uuid()).max(500),
        projectIds: z.array(z.string().uuid()).max(500),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationGetSubscriptionResourcesResponse = z.infer<
  typeof CalibrationGetSubscriptionResourcesResponse
>;

// --- Typed blocked reasons (criterion 10, issue #54) -----------------------

/**
 * Typed reasons why an action is blocked.
 * These are deterministic — each maps to a specific diagnosis.
 * Never use free text; always use a typed code so the UI can explain clearly.
 */
export const CalibrationBlockedReason = z.discriminatedUnion('code', [
  z
    .object({
      code: z.literal('staleTelemetry'),
      detail: z.string().max(512),
    })
    .strict(),
  z
    .object({
      code: z.literal('firmwareChange'),
      detail: z.string().max(512),
    })
    .strict(),
  z
    .object({
      code: z.literal('configChange'),
      detail: z.string().max(512),
    })
    .strict(),
  z
    .object({
      code: z.literal('materialMismatch'),
      detail: z.string().max(512),
    })
    .strict(),
  z
    .object({
      code: z.literal('maintenanceBusy'),
      detail: z.string().max(512),
    })
    .strict(),
  z
    .object({
      code: z.literal('missingGcode'),
      detail: z.string().max(512),
    })
    .strict(),
  z
    .object({
      code: z.literal('permissionFailure'),
      detail: z.string().max(512),
    })
    .strict(),
  z
    .object({
      code: z.literal('printerOffline'),
      detail: z.string().max(512),
    })
    .strict(),
  z
    .object({
      code: z.literal('acknowledgementExpired'),
      detail: z.string().max(512),
    })
    .strict(),
  z
    .object({
      code: z.literal('jobReordered'),
      detail: z.string().max(512),
    })
    .strict(),
]);
export type CalibrationBlockedReason = z.infer<typeof CalibrationBlockedReason>;

// --- Immutable provenance record (criterion 11, issue #54) -----------------

/**
 * Immutable provenance for a queued calibration job.
 * All fields reflect what was locked in at job creation time —
 * these are never updated after the job is queued.
 */
export const CalibrationJobProvenance = z
  .object({
    /** Upstream Orca version used for generation. */
    requiredSlicerVersion: z.string().max(256).nullable(),
    /** Klipper dialect enforced by the job runner. */
    requiredGcodeDialect: z.string().max(256).nullable(),
    /** Klipper firmware family enforced by the job runner. */
    requiredFirmwareFamily: z.string().max(256).nullable(),
    /** Slicer container digest (sha256:...) for reproducibility. */
    requiredSlicerContainerDigest: z.string().max(512).nullable(),
    /** Printer config revision pinned at job creation time. */
    pinnedPrinterConfigRevision: z.number().int().nullable(),
    /** Job ID. */
    jobId: z.string().uuid(),
    /** Assigned printer ID. */
    assignedPrinterId: z.string().uuid().nullable(),
    /** G-code file ID. */
    gcodeFileId: z.string().uuid().nullable(),
    // --- Hashes (all hex-sha256) ---
    gcodeContentSha256: z.string().max(256).nullable(),
    specificationSha256: z.string().max(256).nullable(),
    machineProfileSha256: z.string().max(256).nullable(),
    processProfileSha256: z.string().max(256).nullable(),
    filamentProfileSha256: z.string().max(256).nullable(),
    printerConfigSnapshotSha256: z.string().max(256).nullable(),
    /** Queue revision (opaque base-64 ETag) at job creation time. */
    rowVersion: z.string().nullable(),
  })
  .passthrough();
export type CalibrationJobProvenance = z.infer<typeof CalibrationJobProvenance>;

// --- Local OrcaSlicer profile discovery ------------------------------------

export const OrcaProfileSource = z.enum([
  /** Profile from the system OrcaSlicer installation. */
  'systemInstall',
  /** Profile imported manually by the user. */
  'userImported',
  /** Explicit upstream profile and compatibility scope supplied by PrintFarmer. */
  'printFarmer',
]);
export type OrcaProfileSource = z.infer<typeof OrcaProfileSource>;

/** A discoverable OrcaSlicer filament profile on the local machine. */
export const OrcaProfileEntry = z
  .object({
    orcaProfileId: z.string().min(1).max(512),
    /**
     * The OrcaSlicer-facing profile name, used to locate the profile on disk.
     *
     * Distinct from `orcaProfileId` and not interchangeable with it. For a
     * PrintFarmer-sourced entry the id is the server's immutable `Guid`, which
     * appears nowhere in an OrcaSlicer profile file, so matching local files by
     * id can never succeed — only this name can. For a locally discovered
     * entry the two happen to coincide.
     *
     * Optional for back-compat with entries persisted before the split; the
     * resolver falls back to `orcaProfileId` only for local sources, where that
     * fallback is exactly the name.
     */
    orcaProfileName: z.string().min(1).max(512).optional(),
    displayName: z.string().min(1).max(512),
    vendor: z.string().max(256).nullable(),
    material: z.string().max(256).nullable(),
    source: OrcaProfileSource,
    upstreamVerified: z.boolean(),
    printerId: z.string().min(1).max(256),
    configurationRevision: z.number().int().nonnegative(),
    snapshotId: z.string().min(1).max(256),
    toolId: z.string().min(1).max(256),
    toolheadId: z.string().min(1).max(256),
    nozzleId: z.string().min(1).max(256),
    nozzleDiameterMm: z.number().finite().positive().max(10),
    profileRevision: z.string().min(1).max(256).nullable(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    /** Whether PFD can export this profile for calibration use. */
    exportable: z.boolean(),
  })
  .strict();
export type OrcaProfileEntry = z.infer<typeof OrcaProfileEntry>;

/**
 * Resolve OrcaSlicer profiles for exactly one already-selected printer.
 *
 * `printerId` is required, and that is the point: the calibration wizard must
 * ask which printer to calibrate *before* it resolves anything, so there is no
 * legal way to spell "list profiles for the whole farm". Earlier builds took
 * only a `profileId`, listed every candidate, and then fetched a context plus
 * ran a local OrcaSlicer scan per printer — work that grew with farm size,
 * pulled snapshots the operator never asked for, and made an unselected printer
 * indistinguishable from a selected one.
 */
export const CalibrationListOrcaProfilesRequest = z
  .object({
    profileId: z.string().uuid(),
    /** The single printer the operator selected. Never a list, never absent. */
    printerId: z.string().min(1).max(256),
    /**
     * Configuration revision the selection was made against. Carried so the
     * resolved profiles can be fenced to the same revision the operator saw.
     */
    configurationRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CalibrationListOrcaProfilesRequest = z.infer<
  typeof CalibrationListOrcaProfilesRequest
>;
/**
 * Why a profile listing came back without server-derived entries.
 *
 * An empty `profiles` array is ambiguous on its own: it reads identically
 * whether the server refused the request, the route drifted, the deployment
 * has calibration disabled, or the farm genuinely has no eligible printer.
 * Callers need to tell those apart to say anything useful to the operator.
 */
export const CalibrationProfileDiscoveryDiagnostic = z
  .object({
    /** Coarse machine-readable cause. */
    kind: z.enum([
      /** Server-derived discovery succeeded. */
      'ok',
      /** 401 — the session is not authenticated for calibration. */
      'unauthenticated',
      /** 403 — authenticated but lacking the calibration permission. */
      'forbidden',
      /** 404 — the route is absent on this server build (contract drift). */
      'routeUnavailable',
      /** 503 — a server dependency calibration needs is not configured. */
      'serverDependencyUnavailable',
      /**
       * 503 from the profile resolver specifically. Distinct from the generic
       * dependency outage because the remedy differs: the printer is fine and
       * its context is readable, but no profile can be resolved right now.
       */
      'profileResolverUnavailable',
      /**
       * The selected printer's calibration context could not be read, so no
       * profile could be resolved for it. Says nothing about other printers and
       * must never be rendered as "there are no printers".
       */
      'selectedPrinterContextUnavailable',
      /**
       * The selected printer is not a calibration candidate on this server, or
       * is no longer present in the candidate set.
       */
      'selectedPrinterNotACandidate',
      /**
       * The server answered for the selected printer and resolved no profile
       * bound to it. The printer exists and is readable; it simply has no
       * profile identity that calibration can bind to.
       */
      'noProfilesForSelectedPrinter',
      /** The response did not match the calibration contract. */
      'malformedResponse',
      /**
       * Some candidate records could not be read; the rest were.
       *
       * Distinct from `malformedResponse`, which says nothing usable came
       * back, and from `ok`, which claims the list is complete. Candidates are
       * parsed one at a time so a single bad record cannot empty the farm —
       * but reporting the survivors as `ok` would trade one silent loss for
       * another, telling the operator a printer is absent when the truth is
       * that this client could not read it.
       */
      'partiallyUnreadable',
      /**
       * The server offered more candidates than were considered.
       *
       * Distinct from `partiallyUnreadable`: those records were examined and
       * refused, these were never looked at. Reporting `ok` after stopping at
       * the cap would describe a farm this client had not seen the whole of.
       */
      'farmTruncated',
      /** The server answered normally and returned no eligible printer. */
      'noEligiblePrinters',
      /** The request could not reach the server at all. */
      'unreachable',
    ]),
    /** Operator-facing explanation. Never contains credentials or paths. */
    message: z.string().max(512),
    /** Server-supplied problem code, when one was provided. */
    serverCode: z.string().max(64).nullable().default(null),
  })
  .strict();
export type CalibrationProfileDiscoveryDiagnostic = z.infer<
  typeof CalibrationProfileDiscoveryDiagnostic
>;

/**
 * One locally installed OrcaSlicer filament profile, for inspection only.
 *
 * Deliberately carries no printer, toolhead, nozzle or snapshot identity, so it
 * cannot be mistaken for — or used as — a bound calibration base profile. It
 * also carries no filesystem path: the renderer needs to know a profile exists,
 * not where the user keeps it.
 */
export const LocalOrcaProfileSummary = z
  .object({
    name: z.string().min(1).max(512),
    source: z.enum(['systemInstall', 'userImported']),
    material: z.string().max(64).nullable(),
  })
  .strict();
export type LocalOrcaProfileSummary = z.infer<typeof LocalOrcaProfileSummary>;

/** Outcome of scanning this machine's OrcaSlicer installation. */
export const LocalOrcaDiscoveryDiagnostic = z
  .object({
    kind: z.enum([
      /** Profiles were found locally. */
      'ok',
      /** No canonical OrcaSlicer root exists — OrcaSlicer is likely not installed. */
      'noInstallFound',
      /** OrcaSlicer is installed but no filament profiles were readable. */
      'noProfilesFound',
      /**
       * Profiles were readable, but none matches the selected printer's exact
       * profile name and nozzle. The install is healthy and the printer is
       * fine; the specific profile the server named is simply not on this
       * machine. Kept separate so the operator is told to install *that*
       * profile rather than to repair an OrcaSlicer install that is not broken.
       */
      'noMatchForSelectedPrinter',
      /**
       * The scan itself failed — a permission error on a profile directory, an
       * I/O fault, an unreadable root. Distinct from `noInstallFound`, which
       * asserts something about this machine that a failed scan has no standing
       * to assert: telling an operator with a working OrcaSlicer that it is not
       * installed sends them to reinstall software that is already there.
       */
      'scanFailed',
    ]),
    message: z.string().max(512),
  })
  .strict();
export type LocalOrcaDiscoveryDiagnostic = z.infer<
  typeof LocalOrcaDiscoveryDiagnostic
>;

export const CalibrationListOrcaProfilesResponse = z
  .object({
    profiles: z.array(OrcaProfileEntry).max(5000),
    /**
     * The printer this answer is about, echoed back from the request.
     *
     * The renderer fences on it: a reply that names a printer other than the
     * currently selected one is discarded rather than rendered. Without the
     * echo a late reply for printer A is indistinguishable from a reply for
     * printer B and would silently populate the wrong selection.
     */
    printerId: z.string().min(1).max(256),
    /**
     * Configuration revision these profiles were resolved at, from the server
     * snapshot. Null when the server did not report one, which is itself a
     * reason the result cannot be bound.
     */
    configurationRevision: z.number().int().nonnegative().nullable(),
    /**
     * Why server-derived discovery produced what it did, so an empty list is
     * never silently ambiguous. Defaulted for callers that predate the field;
     * the production handler always sets it explicitly.
     */
    discovery: CalibrationProfileDiscoveryDiagnostic.default({
      kind: 'ok',
      message: 'Server profile discovery completed.',
      serverCode: null,
    }),
    /**
     * How many candidate records the server sent that this client could not
     * read, and therefore how many printers are missing from `profiles`.
     *
     * Structured rather than left inside {@link discovery}'s prose. The number
     * is the evidence: a caller deciding whether to warn, a test asserting the
     * exact count, and a reader distinguishing "the farm is empty" from "the
     * farm was unreadable" all need it as a value, not as a sentence they
     * would have to parse back out. `discovery.message` is derived from it,
     * never the other way round.
     *
     * Client-derived in the main process by counting candidates that failed
     * validation, so no field of the server payload can raise or lower it.
     *
     * Required, not defaulted. Main, preload and renderer ship together, so
     * there is no older caller on this boundary to accommodate — and a default
     * of `0` would convert a future propagation slip into a confident "every
     * record was readable", which is precisely the false reassurance this
     * field exists to prevent. Bounded by the number of candidates that can be
     * considered at all, so a count larger than the list it describes is
     * rejected rather than believed.
     */
    printersUnreadable: z
      .number()
      .int()
      .nonnegative()
      .max(CALIBRATION_MAX_PRINTER_CANDIDATES),
    /**
     * Whether the server offered more candidates than were considered.
     *
     * Carried for the same reason as on {@link CalibrationListPrintersResponse}:
     * the wire layer stops at {@link CALIBRATION_MAX_PRINTER_CANDIDATES}, and a
     * response that quietly reported `ok` after ignoring the remainder would
     * describe a farm it had not looked at. Distinct from
     * `printersUnreadable`: those records were seen and rejected, these were
     * never considered.
     */
    printersTruncated: z.boolean(),
    /**
     * Locally installed OrcaSlicer profiles, scanned independently of the
     * server. Populated even when the server refused, so "PrintFarmer is
     * unreachable" stays distinguishable from "this machine has no profiles".
     */
    localProfiles: z.array(LocalOrcaProfileSummary).max(5000).default([]),
    localDiscovery: LocalOrcaDiscoveryDiagnostic.default({
      kind: 'ok',
      message: 'Local OrcaSlicer profile scan completed.',
    }),
  })
  .strict();
export type CalibrationListOrcaProfilesResponse = z.infer<
  typeof CalibrationListOrcaProfilesResponse
>;

/**
 * Typed error for local OrcaSlicer profile operations (install, restore,
 * export). Declared here so it can be referenced by CalibrationExportOrcaProfileResponse.
 */
export const OrcaProfileOperationError = z
  .object({
    code: z.enum([
      'slicerRunning',
      'profileConflict',
      'pathRestricted',
      'permissionDenied',
      'verificationFailed',
      'rollbackFailed',
      'unsupportedPlatform',
      'baseProfileMissing',
      /**
       * The base profile is still on disk under the recorded name, but its
       * bytes are not the ones the project was bound to. Patching it would
       * produce output whose provenance record names a different base than the
       * one actually used.
       */
      'baseProfileChanged',
      /**
       * The project recorded no fingerprint for its base profile, so there is
       * nothing to verify the local file against. Generating anyway would make
       * the immutable-base guarantee unenforceable rather than merely unproven.
       */
      'baseProfileUnverifiable',
      'workspaceNotReady',
      'invalidPatch',
      'canceled',
      'internalError',
    ]),
    message: z.string().max(1024),
    retryable: z.boolean(),
  })
  .strict();
export type OrcaProfileOperationError = z.infer<
  typeof OrcaProfileOperationError
>;

/**
 * Export a local OrcaSlicer profile for use in a calibration project.
 * The renderer may not specify a filesystem path; main resolves based on
 * the stable orcaProfileId only.
 */
export const CalibrationExportOrcaProfileRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    snapshotId: z.string().min(1).max(256),
    orcaProfileId: z.string().min(1).max(512),
    /** Client-generated idempotency key. */
    operationId: z.string().uuid(),
  })
  .strict();
export type CalibrationExportOrcaProfileRequest = z.infer<
  typeof CalibrationExportOrcaProfileRequest
>;
export const CalibrationExportOrcaProfileResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        /** SHA-256 of the exported profile JSON (content identity). */
        profileJsonHash: z.string().regex(/^[a-f0-9]{64}$/),
        displayName: z.string().min(1).max(512),
      })
      .strict(),
    /** User dismissed the native save dialog; no bytes were written. */
    z.object({ status: z.literal('canceled') }).strict(),
    z
      .object({
        status: z.literal('error'),
        error: OrcaProfileOperationError,
      })
      .strict(),
  ],
);
export type CalibrationExportOrcaProfileResponse = z.infer<
  typeof CalibrationExportOrcaProfileResponse
>;

// --- Legacy calibration backup v4 import -----------------------------------

export const LegacyCalibrationBackupStatus = z.enum([
  'ready',
  'importing',
  'complete',
  'failed',
]);
export type LegacyCalibrationBackupStatus = z.infer<
  typeof LegacyCalibrationBackupStatus
>;

/** Summary of a legacy v4 backup file to be imported. */
export const LegacyCalibrationBackupSummary = z
  .object({
    /** SHA-256 of the backup file (content identity). */
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Backup format version detected. */
    detectedVersion: z.number().int().nonnegative(),
    projectCount: z.number().int().nonnegative().max(10_000),
    attemptCount: z.number().int().nonnegative().max(100_000),
    photoCount: z.number().int().nonnegative().max(100_000),
    /** Whether a C toolchain-based format check passed. */
    formatValid: z.boolean(),
  })
  .strict();
export type LegacyCalibrationBackupSummary = z.infer<
  typeof LegacyCalibrationBackupSummary
>;

/**
 * Per-project preflight outcome for a legacy calibration backup v4 file.
 * Each project is classified as importable, unsupported, or corrupt,
 * with explicit reasons for non-importable records.
 */
export const LegacyBackupProjectOutcome = z
  .object({
    legacyProjectId: z.string().max(256),
    name: z.string().max(512),
    /** Deterministic import classification determined by preflight. */
    outcome: z.enum(['importable', 'unsupported', 'corrupt', 'requiresAction']),
    /** Structured issue codes for non-importable records. */
    issues: z.array(z.string().max(512)).max(50),
    stepCount: z.number().int().nonnegative().max(100),
    attemptCount: z.number().int().nonnegative().max(10_000),
    photoCount: z.number().int().nonnegative().max(10_000),
    /** Legacy printer model/name snapshot (no credentials; for user display only). */
    legacyPrinterName: z.string().max(256).nullable(),
    /** Whether the project requires explicit printer/toolhead mapping. */
    requiresPrinterMapping: z.boolean(),
    /** Source-to-target project ID (deterministic, collision-safe). */
    targetProjectId: z.string().uuid().nullable(),
  })
  .strict();
export type LegacyBackupProjectOutcome = z.infer<
  typeof LegacyBackupProjectOutcome
>;

/**
 * Bounded preflight result returned by the CalibrationPickLegacyBackupV4 channel.
 * Preflight is deterministic, fail-closed, and never claims import completion.
 * It does not modify the source file or contact the backend.
 */
export const LegacyBackupPreflight = z
  .object({
    summary: LegacyCalibrationBackupSummary,
    projectOutcomes: z.array(LegacyBackupProjectOutcome).max(10_000),
    importableCount: z.number().int().nonnegative(),
    unsupportedCount: z.number().int().nonnegative(),
    corruptCount: z.number().int().nonnegative(),
    requiresActionCount: z.number().int().nonnegative(),
    /** Global warnings that apply to the whole backup (not per-project). */
    warnings: z.array(z.string().max(512)).max(100),
  })
  .strict();
export type LegacyBackupPreflight = z.infer<typeof LegacyBackupPreflight>;

/**
 * Picker channel: shows a native file dialog for a .pfdbak / .json backup file,
 * runs bounded local preflight validation, and returns an approvalId that the
 * renderer passes to the (now-removed) legacy backup import channel.
 *
 * The renderer never receives a filesystem path; the main process owns the
 * approved path for the lifetime of the operation.
 */
export const CalibrationPickLegacyBackupV4Request = z.void();
export type CalibrationPickLegacyBackupV4Request = z.infer<
  typeof CalibrationPickLegacyBackupV4Request
>;
export const CalibrationPickLegacyBackupV4Response = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        /** Opaque approval token. */
        approvalId: z.string().uuid(),
        preflight: LegacyBackupPreflight,
      })
      .strict(),
    z.object({ status: z.literal('cancelled') }).strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationPickLegacyBackupV4Response = z.infer<
  typeof CalibrationPickLegacyBackupV4Response
>;

// ==========================================================================
// End of Printer Calibration transport additions
// ==========================================================================

// --- Upstream Orca filament profiles (issue #55) ---------------------------

/**
 * Windows-only: transactionally install the generated profile into the
 * canonical OrcaSlicer user-data directory. Requires a prior successful
 * generate step producing the same operationId. The main process validates
 * that OrcaSlicer is not running, creates a timestamped backup, writes via a
 * temp file, performs readback verification, and atomically replaces the
 * target.
 *
 * Retained intentionally (issue #758): PrintFarmer #1940 (Path D) plans to
 * reuse installing a tuned profile into local OrcaSlicer as a plausible
 * calibration end-step, so re-adding this channel only needs the
 * key/handler/wire/preload wiring restored, not a new contract. The prior
 * generate-a-profile schema (`CalibrationGenerateOrcaProfile*`) was removed
 * with the rest of the printer-calibration saga under issue #756/#758 — Path
 * D's design is not finalized, so it may return in a different shape rather
 * than as a straight re-add of the deleted schema.
 */
export const CalibrationInstallOrcaProfileRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    snapshotId: z.string().min(1).max(256),
    /**
     * Must match the operationId a prior generate step produced. Used to
     * retrieve the cached generated profile bytes.
     */
    operationId: z.string().uuid(),
    /**
     * SHA-256 of the generated profile JSON the renderer received from the
     * generate step. Verified against the main-process cache before writing.
     */
    confirmedProfileJsonHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CalibrationInstallOrcaProfileRequest = z.infer<
  typeof CalibrationInstallOrcaProfileRequest
>;

export const CalibrationInstallOrcaProfileResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        /** SHA-256 of what was successfully written and verified on disk. */
        installedHash: z.string().regex(/^[a-f0-9]{64}$/),
        /**
         * SHA-256 of the backup that was created before writing. Pass to
         * CalibrationRestoreOrcaProfile if rollback is needed.
         */
        backupHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    z
      .object({
        status: z.literal('error'),
        error: OrcaProfileOperationError,
      })
      .strict(),
  ],
);
export type CalibrationInstallOrcaProfileResponse = z.infer<
  typeof CalibrationInstallOrcaProfileResponse
>;

/**
 * Windows-only: restore a profile from a timestamped backup created during
 * a prior CalibrationInstallOrcaProfile call. Used for explicit user-driven
 * rollback after a confirmed install.
 *
 * Retained intentionally (issue #758) as the rollback counterpart to the
 * retained `CalibrationInstallOrcaProfile` channel for PrintFarmer #1940
 * (Path D).
 */
export const CalibrationRestoreOrcaProfileRequest = z
  .object({
    profileId: z.string().uuid(),
    /**
     * Must match the operationId from the original install call that produced
     * the backup.
     */
    operationId: z.string().uuid(),
    /**
     * SHA-256 of the backup the renderer received from the install step.
     * Verified before restoring.
     */
    backupHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CalibrationRestoreOrcaProfileRequest = z.infer<
  typeof CalibrationRestoreOrcaProfileRequest
>;

export const CalibrationRestoreOrcaProfileResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        /** SHA-256 of what was restored and verified on disk. */
        restoredHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    z
      .object({
        status: z.literal('error'),
        error: OrcaProfileOperationError,
      })
      .strict(),
  ],
);
export type CalibrationRestoreOrcaProfileResponse = z.infer<
  typeof CalibrationRestoreOrcaProfileResponse
>;

// --- retarget --------------------------------------------------------------

const RetargetToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const BoundedText = z.string().max(2048);
const boundedRecord = <T extends z.ZodTypeAny>(value: T, maximum: number) =>
  z.record(value).superRefine((record, context) => {
    if (Object.keys(record).length > maximum) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum,
        type: 'array',
        inclusive: true,
        message: 'Too many record entries.',
      });
    }
  });
const IssueCode = z.enum([
  'sourceNotFound',
  'targetNotFound',
  'outputPathConflict',
  'invalidArchive',
  'archiveLimitExceeded',
  'unsafeArchivePath',
  'externalRelationship',
  'missingModel',
  'emptyBuild',
  'geometryOnly',
  'preSlicedOnly',
  'unsupportedPrusa',
  'unsupportedCura',
  'unsupportedSlicer',
  'unknownOrcaFamilyProducer',
  'missingProjectSettings',
  'invalidProjectSettings',
  'missingModelSettings',
  'invalidModelSettings',
  'incompleteProject',
  'tooManyFilamentSlots',
  'unsupportedMaterial',
  'unsafeSettingValue',
  'profileNotFound',
  'profileManifestInvalid',
  'profileHashMismatch',
  'profileTypeMismatch',
  'profileMissingParent',
  'profileInheritanceCycle',
  'profileValueInvalid',
  'targetSourceConflict',
  'staleSliceArtifactsRemoved',
  'customGcodeRemoved',
  'digitalSignaturesRemoved',
  'unsupportedSourceSettingsOmitted',
  'paintMetadataPreservedUnverified',
  'profileRecommendationAmbiguous',
  'sourceSettingReplaced',
  'settingClamped',
  'filamentProfileMapped',
  'sceneIncompatible',
  'sourceChanged',
  'outputValidationFailed',
  'io',
]);
export const RetargetErrorCode = z.enum([
  'invalidRequest',
  'sidecarUnavailable',
  'profileStoreCorrupt',
  'profileImportFailed',
  'profileNotFound',
  'artifactNotFound',
  'artifactExpired',
  'artifactForbidden',
  'artifactBusy',
  'sourceChanged',
  'saveSourceConflict',
  'saveDestinationExists',
  'saveFailed',
  'internalError',
]);
const RetargetIssue = z
  .object({
    code: IssueCode,
    severity: z.enum(['blocker', 'warning', 'error']),
    title: BoundedText,
    message: BoundedText,
    action: BoundedText,
    part: BoundedText.nullable(),
    setting: BoundedText.nullable(),
  })
  .strict();
const RetargetFailure = z
  .object({
    domain: z.enum(['native', 'electron']),
    code: z.union([IssueCode, RetargetErrorCode]),
    message: BoundedText,
    action: BoundedText,
    part: BoundedText.nullable(),
    setting: BoundedText.nullable(),
  })
  .strict();
const RetargetProfile = z
  .object({
    id: z.string().min(1).max(512),
    source: z.enum(['bundled', 'imported']),
    displayName: z.string().min(1).max(512),
    processName: z.string().min(1).max(512),
    machineName: z.string().min(1).max(512),
    compatibleFilaments: z.array(z.string().min(1).max(512)).max(100),
    layerHeight: z.number().finite().positive().max(10),
    category: z.string().max(128).nullable(),
    bundleCommit: z.string().max(128).nullable(),
    settingCount: z.number().int().nonnegative().max(10_000),
    settingsSummary: boundedRecord(
      z.union([
        z.string().max(1024),
        z.number().finite(),
        z.boolean(),
        z.array(z.string().max(1024)).max(100),
      ]),
      10_000,
    ),
    importedAt: z.number().int().nonnegative().nullable(),
    fingerprint: Sha256,
  })
  .strict();
export type RetargetProfile = z.infer<typeof RetargetProfile>;
const RetargetCatalog = z
  .object({
    profiles: z.array(RetargetProfile).max(200),
    warnings: z.array(RetargetFailure).max(100),
  })
  .strict();
const RetargetChange = z
  .object({
    code: IssueCode,
    message: BoundedText,
    setting: BoundedText.nullable(),
    before: BoundedText.nullable(),
    after: BoundedText.nullable(),
  })
  .strict();
const RetargetSource = z
  .object({
    fileName: z.string().min(1).max(512),
    byteSize: z.number().int().nonnegative(),
    sha256: Sha256,
    producer: BoundedText,
    machineId: BoundedText.nullable(),
    processId: BoundedText.nullable(),
    layerHeight: z.number().finite().nullable(),
    objectCount: z.number().int().nonnegative().max(100_000),
    buildItemCount: z.number().int().nonnegative().max(100_000),
    plateCount: z.number().int().nonnegative().max(1_000),
    materials: z.array(z.string().max(512)).max(100),
    colors: z.array(z.string().max(512)).max(100),
  })
  .strict();
const RetargetPreflightReport = z
  .object({
    accepted: z.boolean(),
    source: RetargetSource,
    recommendation: z
      .object({
        recommended: z
          .object({
            profileId: z.string().max(512),
            displayName: BoundedText,
            score: z.number().finite(),
            rationale: BoundedText,
          })
          .strict(),
        alternatives: z
          .array(
            z
              .object({
                profileId: z.string().max(512),
                displayName: BoundedText,
                score: z.number().finite(),
                rationale: BoundedText,
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .nullable(),
    blockers: z.array(RetargetIssue).max(100),
    warnings: z.array(RetargetIssue).max(100),
    proposedChanges: boundedRecord(z.array(RetargetChange).max(20_000), 100),
  })
  .strict();
const RetargetValidation = z
  .object({
    valid: z.boolean(),
    sourceSha256: Sha256,
    outputSha256: Sha256,
    sourcePreserved: z.boolean(),
    sceneCompatibility: z
      .object({
        compatible: z.boolean(),
        differences: z.array(BoundedText).max(1000),
      })
      .strict(),
    invariants: boundedRecord(z.boolean(), 1000),
    warnings: z.array(RetargetIssue).max(100),
    errors: z.array(RetargetIssue).max(100),
  })
  .strict();
const RetargetBuildReport = z
  .object({
    sourceSha256: Sha256,
    outputSha256: Sha256,
    outputFileName: z.string().min(1).max(512),
    targetProfileId: z.string().min(1).max(512),
    removedPartCount: z.number().int().nonnegative().max(100_000),
    preservedPartCount: z.number().int().nonnegative().max(100_000),
    appliedChanges: boundedRecord(z.array(RetargetChange).max(20_000), 100),
    warnings: z.array(RetargetIssue).max(100),
    validation: RetargetValidation,
  })
  .strict();
const RetargetOutcome = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('ok'), value }).strict(),
    z
      .object({
        status: z.literal('blocked'),
        blockers: z.array(RetargetIssue).max(100),
        warnings: z.array(RetargetIssue).max(100),
        value: value.nullable(),
      })
      .strict(),
    z.object({ status: z.literal('error'), error: RetargetFailure }).strict(),
  ]);

export const RetargetListProfilesRequest = z.void();
export const RetargetListProfilesResponse = RetargetOutcome(RetargetCatalog);
export type RetargetListProfilesResponse = z.infer<
  typeof RetargetListProfilesResponse
>;
export const RetargetImportProfileRequest = z.void();
export const RetargetImportProfileResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('canceled') }).strict(),
  z
    .object({
      status: z.literal('ok'),
      profile: RetargetProfile,
      duplicate: z.boolean(),
    })
    .strict(),
  z.object({ status: z.literal('error'), error: RetargetFailure }).strict(),
]);
export type RetargetImportProfileResponse = z.infer<
  typeof RetargetImportProfileResponse
>;
export const RetargetPreflightRequest = z
  .object({
    modelHash: Sha256,
    rootId: z.string().min(1).max(256),
    profileId: z.string().min(1).max(512),
    objectExclusion: z.boolean(),
  })
  .strict();
export type RetargetPreflightRequest = z.infer<typeof RetargetPreflightRequest>;
export const RetargetPreflightResponse = RetargetOutcome(
  z.object({ token: RetargetToken, report: RetargetPreflightReport }).strict(),
);
export type RetargetPreflightResponse = z.infer<
  typeof RetargetPreflightResponse
>;
export const RetargetBuildRequest = z
  .object({
    token: RetargetToken,
    profileId: z.string().min(1).max(512),
    objectExclusion: z.boolean(),
  })
  .strict();
export type RetargetBuildRequest = z.infer<typeof RetargetBuildRequest>;
export const RetargetBuildResponse = RetargetOutcome(RetargetBuildReport);
export type RetargetBuildResponse = z.infer<typeof RetargetBuildResponse>;
export const RetargetLoadSceneRequest = z
  .object({ token: RetargetToken, source: z.enum(['source', 'output']) })
  .strict();
export type RetargetLoadSceneRequest = z.infer<typeof RetargetLoadSceneRequest>;
const RetargetSceneMesh = SceneMesh.strict().superRefine((scene, context) => {
  const limits: Array<[number, number, string]> = [
    [scene.positions.length, 30_000_000, 'positions'],
    [scene.indices.length, 30_000_000, 'indices'],
    [scene.faceColors?.length ?? 0, 30_000_000, 'faceColors'],
    [scene.parts.length, 20_000, 'parts'],
    [scene.objects.length, 100_000, 'objects'],
    [scene.rootObjectIds.length, 100_000, 'rootObjectIds'],
    [scene.plates.length, 1_000, 'plates'],
  ];
  for (const [actual, maximum, field] of limits) {
    if (actual > maximum) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum,
        type: 'array',
        inclusive: true,
        path: [field],
        message: `${field} exceeds the retarget scene limit.`,
      });
    }
  }
  for (const [index, object] of scene.objects.entries()) {
    if (object.children.length > 100_000) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 100_000,
        type: 'array',
        inclusive: true,
        path: ['objects', index, 'children'],
        message: 'Scene object children exceed the retarget scene limit.',
      });
    }
    if (
      object.mesh &&
      (object.mesh.positions.length > 30_000_000 ||
        object.mesh.indices.length > 30_000_000)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 30_000_000,
        type: 'array',
        inclusive: true,
        path: ['objects', index, 'mesh'],
        message: 'Scene object mesh exceeds the retarget scene limit.',
      });
    }
  }
});
export const RetargetLoadSceneResponse = RetargetOutcome(RetargetSceneMesh);
export type RetargetLoadSceneResponse = z.infer<
  typeof RetargetLoadSceneResponse
>;
export const RetargetSaveAsRequest = z
  .object({ token: RetargetToken })
  .strict();
export type RetargetSaveAsRequest = z.infer<typeof RetargetSaveAsRequest>;
export const RetargetSaveAsResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('canceled') }).strict(),
  z
    .object({
      status: z.literal('ok'),
      fileName: z.string().min(1).max(512),
      refreshWarning: RetargetFailure.nullable(),
    })
    .strict(),
  z.object({ status: z.literal('error'), error: RetargetFailure }).strict(),
]);
export type RetargetSaveAsResponse = z.infer<typeof RetargetSaveAsResponse>;
export const RetargetDisposeRequest = z
  .object({ token: RetargetToken })
  .strict();
export type RetargetDisposeRequest = z.infer<typeof RetargetDisposeRequest>;
export const RetargetDisposeResponse = z
  .object({ disposed: z.boolean() })
  .strict();
export type RetargetDisposeResponse = z.infer<typeof RetargetDisposeResponse>;

// --- Machine → process → filament profile cascade -------------------------
//
// Five IPC channels that let the operator see the machine/process/filament
// profiles PrintFarmer offers. This is step 1 of the filament calibration
// workflow (owner directive 2026-08-23,
// `.squad/decisions/inbox/vasquez-filament-calibration-reframe.md`): the
// operator picks machine + process + filament as their starting profiles,
// then works through the OrcaSlicer wiki steps against a client-side
// filament profile.
//
// The renderer sees a unified `{ name, guid?, source, ...display }` shape per
// profile. Main-process is responsible for:
//   * calling `/api/slicer/profiles/extended` (Guids for system profiles)
//   * calling `/api/slicer/profiles/machine/for-model/{modelId}` (system,
//     name-keyed) or `/for-machines` (server-side applicability filter)
//   * calling `/api/slicer/profiles/custom` (Guid-keyed, filtered client-side)
//
// The setup PUT (`calibration:setupPrinter` → `PUT /api/printers/{id}/
// calibration-setup`) was removed on 2026-08-23: it belonged to the
// printer-calibration subsystem, which is not what the filament workflow
// needs.
//
// The renderer never sees SHA-256 as a profile identifier: the wire migration
// documented at §C.2 of `printfarmer-api-contract.md` says system profiles are
// name-keyed on the worker DTOs, Guid-keyed via `/extended`, and custom
// profiles are Guid-keyed everywhere. The existing `machineProfileSha256`
// field on `CalibrationJobProvenance` is a PROVENANCE hash for a generated
// gcode job — a different concern from the identity used to select a
// profile — and is left in place unchanged.

/** Longest single profile name string carried over the desktop IPC boundary. */
const CALIBRATION_MAX_PROFILE_NAME = 512;
/**
 * Cap on the number of profiles the main process forwards to the renderer,
 * per profile-type bucket. Shared by the wire schema
 * (`RemoteExtendedProfilesResponse` in `calibrationWire.ts`, which imports
 * this constant directly rather than defining its own) and this IPC schema
 * deliberately — see #767, where the wire ceiling was raised independently
 * of this one and a catalog with more than 2048 machine (or process, or
 * filament) profiles parsed fine off the filament) profiles parsed fine off the
 * network and then threw here on the way to the renderer, turning a
 * `profilesTruncated: true` response into a hard error instead. Two bounds
 * that must agree should be one bound.
 */
export const CALIBRATION_MAX_PROFILE_LIST = 10_000;
/** Cap on the number of machine names the renderer may pass to /for-machines. */
const CALIBRATION_MAX_MACHINE_FILTER = 64;

/**
 * Unified profile row the renderer sees. `guid` is present for custom
 * profiles and for system profiles the main process was able to resolve
 * against `/extended`; `null` when only a canonical name is known (a system
 * profile PrintFarmer's DB has never imported).
 *
 * Before PrintFarmer#2004 a `null` guid was a genuine dead end — the desktop
 * cannot import profiles by design, so a never-imported catalog profile was
 * permanently unselectable. #2004 shipped a non-admin
 * `POST /api/slicer/profiles/resolve-for-model/{modelId}` endpoint
 * (`Calibration.Update` scope, which the desktop already holds) that
 * resolves a profile by **name** and auto-imports it server-side on demand.
 * So `guid: null` here now means "not yet resolved", not "unselectable": the
 * row stays selectable, and the caller resolves the real Guid via
 * `calibration:resolveSystemProfile` at the point one is actually needed
 * (today, only the filament clone step needs a Guid — see
 * `FilamentCalibrationWizard.performClone`).
 */
export const CalibrationSlicerProfileRef = z
  .object({
    /** Canonical `Name` string. Identity for system profiles on the wire. */
    name: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    /** Resolved Guid used to reference a profile on the wire, or null. */
    guid: z.string().uuid().nullable(),
    /** `'system'` (worker DTO or extended row) or `'custom'` (user-created). */
    source: z.enum(['system', 'custom']),
    /** Optional human-readable manufacturer / material / quality label. */
    displayLabel: z.string().max(512).nullable(),
    /**
     * Provenance-only sha256 of the profile content. Never used for lookup
     * or applicability. Retained so audit records can pin exactly the profile
     * revision the operator saw when they made their selection.
     */
    contentSha256: z.string().max(256).nullable(),
  })
  .strict();
export type CalibrationSlicerProfileRef = z.infer<
  typeof CalibrationSlicerProfileRef
>;

// --- calibration:listExtendedProfiles ---

export const CalibrationListExtendedProfilesRequest = z
  .object({ profileId: z.string().uuid() })
  .strict();
export type CalibrationListExtendedProfilesRequest = z.infer<
  typeof CalibrationListExtendedProfilesRequest
>;

export const CalibrationListExtendedProfilesResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        machineProfiles: z
          .array(CalibrationSlicerProfileRef)
          .max(CALIBRATION_MAX_PROFILE_LIST),
        processProfiles: z
          .array(CalibrationSlicerProfileRef)
          .max(CALIBRATION_MAX_PROFILE_LIST),
        filamentProfiles: z
          .array(CalibrationSlicerProfileRef)
          .max(CALIBRATION_MAX_PROFILE_LIST),
        /**
         * True when `/extended` had more rows than this client's catalog
         * ceiling and some were dropped. Mirrors `printersTruncated` on the
         * calibration-candidates contract: derived from the raw wire length
         * before slicing, never trusted from the payload.
         */
        profilesTruncated: z.boolean(),
        fetchedAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationListExtendedProfilesResponse = z.infer<
  typeof CalibrationListExtendedProfilesResponse
>;

// --- calibration:listMachineProfilesForModel ---

export const CalibrationListMachineProfilesForModelRequest = z
  .object({
    profileId: z.string().uuid(),
    printerModelId: z.string().uuid(),
  })
  .strict();
export type CalibrationListMachineProfilesForModelRequest = z.infer<
  typeof CalibrationListMachineProfilesForModelRequest
>;

export const CalibrationListMachineProfilesForModelResponse =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('ok'),
        /**
         * System machine profiles + user's custom machine profiles scoped to
         * the printer's catalog model. Server responded with a 404 → returned
         * as ok with an empty list AND `noModelAlias: true`, so the renderer
         * can distinguish "no OrcaSlicer alias for this model" (fixable by
         * catalog admins) from "genuinely nothing applicable" (fixable by
         * uploading a custom profile).
         */
        profiles: z
          .array(CalibrationSlicerProfileRef)
          .max(CALIBRATION_MAX_PROFILE_LIST),
        noModelAlias: z.boolean(),
        /**
         * True when the `/extended` join used to resolve these Guids had
         * more rows than this client's catalog ceiling and some were
         * dropped. `false` (never omitted) when no `/extended` fetch ran,
         * e.g. the no-model-alias short-circuit below.
         */
        profilesTruncated: z.boolean(),
        fetchedAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ]);
export type CalibrationListMachineProfilesForModelResponse = z.infer<
  typeof CalibrationListMachineProfilesForModelResponse
>;

// --- calibration:listProcessProfilesForMachines ---

export const CalibrationListProcessProfilesForMachinesRequest = z
  .object({
    profileId: z.string().uuid(),
    machineNames: z
      .array(z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME))
      .min(1)
      .max(CALIBRATION_MAX_MACHINE_FILTER),
  })
  .strict();
export type CalibrationListProcessProfilesForMachinesRequest = z.infer<
  typeof CalibrationListProcessProfilesForMachinesRequest
>;

export const CalibrationListProcessProfilesForMachinesResponse =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('ok'),
        profiles: z
          .array(CalibrationSlicerProfileRef)
          .max(CALIBRATION_MAX_PROFILE_LIST),
        /** See `profilesTruncated` on `CalibrationListMachineProfilesForModelResponse`. */
        profilesTruncated: z.boolean(),
        fetchedAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ]);
export type CalibrationListProcessProfilesForMachinesResponse = z.infer<
  typeof CalibrationListProcessProfilesForMachinesResponse
>;

// --- calibration:listFilamentProfilesForMachines ---

export const CalibrationListFilamentProfilesForMachinesRequest = z
  .object({
    profileId: z.string().uuid(),
    machineNames: z
      .array(z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME))
      .min(1)
      .max(CALIBRATION_MAX_MACHINE_FILTER),
  })
  .strict();
export type CalibrationListFilamentProfilesForMachinesRequest = z.infer<
  typeof CalibrationListFilamentProfilesForMachinesRequest
>;

export const CalibrationListFilamentProfilesForMachinesResponse =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('ok'),
        profiles: z
          .array(CalibrationSlicerProfileRef)
          .max(CALIBRATION_MAX_PROFILE_LIST),
        /** See `profilesTruncated` on `CalibrationListMachineProfilesForModelResponse`. */
        profilesTruncated: z.boolean(),
        fetchedAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ]);
export type CalibrationListFilamentProfilesForMachinesResponse = z.infer<
  typeof CalibrationListFilamentProfilesForMachinesResponse
>;

// --- calibration:listCustomProfiles ---

export const CalibrationListCustomProfilesRequest = z
  .object({ profileId: z.string().uuid() })
  .strict();
export type CalibrationListCustomProfilesRequest = z.infer<
  typeof CalibrationListCustomProfilesRequest
>;

/**
 * Custom profile row. Unlike the unified `CalibrationSlicerProfileRef` this
 * carries `printerModelId` and `compatiblePrinters` verbatim from the server
 * so the renderer can do the client-side applicability filter the React
 * `NewSliceJobPage` performs (§B.2 of the API contract report).
 */
export const CalibrationCustomProfileRef = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    profileType: z.enum(['machine', 'process', 'filament']),
    printerModelId: z.string().uuid().nullable(),
    compatiblePrinters: z
      .array(z.string().max(CALIBRATION_MAX_PROFILE_NAME))
      .max(CALIBRATION_MAX_PROFILE_LIST)
      .nullable(),
    createdAt: z.string().datetime().nullable(),
  })
  .strict();
export type CalibrationCustomProfileRef = z.infer<
  typeof CalibrationCustomProfileRef
>;

export const CalibrationListCustomProfilesResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        profiles: z
          .array(CalibrationCustomProfileRef)
          .max(CALIBRATION_MAX_PROFILE_LIST),
        fetchedAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationListCustomProfilesResponse = z.infer<
  typeof CalibrationListCustomProfilesResponse
>;

// --- calibration:resolveSystemProfile ---
//
// Backing: `POST /api/slicer/profiles/resolve-for-model/{modelId}`
// (`ProfileResolutionDtos.cs`, `ProfilesController.cs`, PrintFarmer PR
// #2008 closing #2004). Gated by `Calibration.Update`, a scope the desktop
// already holds — unlike the admin-only import wizard, no prior admin
// action is required. Looks the name up in PrintFarmer's DB first (no
// worker call, no-op for an already-imported profile); if never imported,
// resolves the catalog model, imports the single matching profile from the
// OrcaSlicer worker catalog, and returns its new Guid. `profileId` is
// non-null on success (imported or not); null only alongside a populated
// `error` (ambiguous name, worker unreachable, model not found, etc).

export const CalibrationProfileResolutionType = z.enum([
  'machine',
  'process',
  'filament',
]);
export type CalibrationProfileResolutionType = z.infer<
  typeof CalibrationProfileResolutionType
>;

export const CalibrationResolveSystemProfileRequest = z
  .object({
    profileId: z.string().uuid(),
    /** Catalog printer-model Guid the profile name is resolved against. */
    printerModelId: z.string().uuid(),
    profileType: CalibrationProfileResolutionType,
    /** The profile's canonical `Name`, as returned by the catalog list. */
    profileName: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
  })
  .strict();
export type CalibrationResolveSystemProfileRequest = z.infer<
  typeof CalibrationResolveSystemProfileRequest
>;

export const CalibrationResolveSystemProfileResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        /** The resolved profile's database identity. */
        profileId: z.string().uuid(),
        /**
         * True when the profile had never been imported and this call
         * auto-imported it from the OrcaSlicer worker catalog; false when
         * it already existed in PrintFarmer's database.
         */
        imported: z.boolean(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationResolveSystemProfileResponse = z.infer<
  typeof CalibrationResolveSystemProfileResponse
>;

// (calibration:setupPrinter removed 2026-08-23 — printer-calibration setup PUT
// was not part of the filament calibration workflow.)

// ============================================================================
// Filament calibration slice pipeline (upstream PR #1952, merged 2026-08-24)
// ============================================================================
//
// The five schemas below carry the OrcaSlicer-wiki calibration workflow the
// owner described on 2026-08-23. Every DTO shape here is quoted verbatim from
// the head of `OlyForge3D/PrintFarmer@main` after PR #1952 merged — the source
// files and their content SHAs are recorded in
// `.squad/decisions/inbox/bishop-filament-calibration-channels.md`, and the
// tests in `tests/calibrationHttp.filamentCalibration.test.ts` cite them again
// per fixture so a drift in either direction is visible on inspection.
//
// The desktop transfers no calibration geometry over these channels. Upstream's
// `SliceJobController` resolves the calibration model from the worker's own
// bundled `resources/calib/` when it sees `calibration.method` — the desktop
// omits `modelFileUrl` / `model3DId`, so no upload path is needed.
//
// None of these channels populate the calibration-projects saga identifiers
// (`calibrationProjectId`, `calibrationAttemptId`, `calibrationOrchestrationId`)
// on the submit request. That saga was stripped in PR #750 (merged
// 2026-08-23) and PR #1952 rejects any of those keys with
// `calibration_mode_conflicts_with_saga_ids` — that rejection is *the* proof
// that a calibration slice stays an ordinary slice job eligible for
// `send-to-printer`.
// ---------------------------------------------------------------------------

/** Wire values for `CalibrationRequest.method` in upstream PR #1952. */
export const CalibrationSliceMethod = z.enum([
  'flow_rate_pass_1',
  'flow_rate_pass_2',
  'flow_rate_yolo_recommended',
  'flow_rate_yolo_perfectionist',
  'max_volumetric_speed',
  'pressure_advance_tower',
  'retraction',
  'temperature_tower',
]);
export type CalibrationSliceMethod = z.infer<typeof CalibrationSliceMethod>;

/** Slice job status projection (public projection in PR #1952). */
export const CalibrationSliceJobStatus = z.enum([
  'Queued',
  'Processing',
  'Completed',
  'Failed',
  'Cancelled',
]);
export type CalibrationSliceJobStatus = z.infer<
  typeof CalibrationSliceJobStatus
>;

/**
 * Terminal-outcome classification produced by the main-process poll driver.
 * `completed` and `failed` are the two ways a job stops moving on the server;
 * `null` means the job is still in-flight from the renderer's perspective.
 * A `cappedOut` snapshot uses `null` here — the driver has stopped looking, not
 * the server — and pairs with the `sliceJobTimeout` error the renderer sees
 * when it asks for another poll past the cap.
 */
export const CalibrationSliceJobTerminalOutcome = z.enum([
  'completed',
  'failed',
]);
export type CalibrationSliceJobTerminalOutcome = z.infer<
  typeof CalibrationSliceJobTerminalOutcome
>;

// --- calibration:createProject (issue #798) ---
//
// Backing: `POST /api/calibration-projects`.
// DTO: `CalibrationProjectCreateRequest` / response `CalibrationProjectDto`,
// verified directly against `OlyForge3D/PrintFarmer`'s
// `Farm.Modules.Calibration/Contracts/CalibrationProjectContracts.cs` and
// `CalibrationProjectsController.cs` at commit
// `0720b9d146256c69fa2780c029ab5982bba509a1` (contracts blob
// `48353af39c7f6b4d9d5e0062254e5fa648860e39`, controller blob
// `657e551a6b75fd2dfdc2a2fe85d8329d6aac7f69`), cross-checked against that
// commit's `RouteTableSnapshot.txt` — not one of #784's four dead routes.
// See `tests/fixtures/server-contract/calibrationProjectContracts.snapshot.ts`
// for the pinned provenance.
//
// Created at calibration start, in `Coach` mode, bound to the chosen base
// filament profile and printer (Spoolman/local-spool ids when a spool has
// been picked — no spool-selection UI exists in the filament wizard yet, so
// those three fields are `null` for now; see #798's scope note 3). This is
// deliberately additive alongside the existing clone-on-completion
// write-back model: reconciling the two lifecycles depends on
// draft/promotion semantics blocked on #795 and is out of scope here.

/**
 * Server-enforced cap on `CalibrationCreateProjectRequest.name`. Exported so
 * callers can truncate a client-composed name (which may be built from a
 * much longer clone-name field) before it ever reaches the wire, instead of
 * discovering the cap as a runtime Zod-parse failure.
 */
export const CALIBRATION_MAX_PROJECT_NAME = 200;

export const CalibrationCreateProjectRequest = z
  .object({
    /** Selected PrintFarmer server profile Guid. */
    profileId: z.string().uuid(),
    /**
     * Client-chosen idempotency key, paired with a fixed `clientId` on the
     * main-process side: retrying a create with the same
     * `(clientId, requestId)` returns the already-created project rather
     * than minting a duplicate. Callers must keep this stable across a
     * retry of the *same* attempt and only mint a fresh one when a
     * genuinely new attempt starts.
     */
    requestId: z.string().uuid(),
    /** Display name for the created project. */
    name: z.string().min(1).max(CALIBRATION_MAX_PROJECT_NAME),
    /** Target printer Guid — the printer the calibration will run on. */
    printerId: z.string().uuid(),
    /** Base filament identity the project is bound to at creation. */
    filamentProvider: z.string().min(1).max(64),
    filamentProductId: z.string().min(1).max(256),
    filamentProductName: z.string().min(1).max(256),
    filamentMaterial: z.string().min(1).max(64),
  })
  .strict();
export type CalibrationCreateProjectRequest = z.infer<
  typeof CalibrationCreateProjectRequest
>;

export const CalibrationCreateProjectResponse = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      project: z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1).max(200),
          lifecycleStatus: z.string().min(1).max(64),
          experienceMode: z.string().min(1).max(32),
          printerId: z.string().uuid(),
          revision: z.number().int().nonnegative(),
        })
        .passthrough(),
    })
    .strict(),
  z.object({ status: z.literal('error'), error: CalibrationApiError }).strict(),
]);
export type CalibrationCreateProjectResponse = z.infer<
  typeof CalibrationCreateProjectResponse
>;

// --- calibration:cloneFilamentProfile ---
//
// Backing: `POST /api/slicer/profiles/clone`
// DTO: `CloneSingleProfileRequestDto` (source Guid + profileType +
//   optional rename + printer compatibility). Response 201
//   `CloneSingleProfileResponseDto { Id, Name, ProfileType, IsSystem }` per
//   upstream `ProfilesController.cs:1247-1283`.
// Auth: `Slicing.Submit` + `InteractiveSessionRequirement`. The interactive
// gate returns 403; we surface that as `interactiveSessionRequired` so the
// renderer can prompt for a live sign-in instead of a generic scope error.
//
// Every request also renames the clone in the same call — that's the workflow
// the owner described ("clone… rename it to match the filament they are
// calibrating"). `name` is required rather than optional because a
// filament-calibration clone with no name would leave the operator staring at
// two rows called the same thing during analysis and pick the wrong one.

export const CalibrationCloneFilamentProfileRequest = z
  .object({
    /** Selected PrintFarmer server profile Guid. */
    profileId: z.string().uuid(),
    /**
     * Guid of the source filament profile to clone — a system or custom
     * `guid` from `calibration:listExtendedProfiles` / `listCustomProfiles`.
     */
    sourceProfileId: z.string().uuid(),
    /**
     * New display name for the clone. Required — see block comment above.
     * Bounded to the same 512-char cap the other profile-name fields use.
     */
    name: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    /**
     * Optional printer-model Guid to bind the clone to. When omitted the
     * server leaves the source profile's compatibility as-is; when supplied
     * the clone becomes single-printer-model compatible.
     */
    printerModelId: z.string().uuid().nullable().optional(),
    /**
     * Optional list of printer names to record as compatible. When both
     * `printerModelId` and this are omitted the source's compatibility is
     * inherited unchanged.
     */
    compatiblePrinters: z
      .array(z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME))
      .max(CALIBRATION_MAX_MACHINE_FILTER)
      .nullable()
      .optional(),
  })
  .strict();
export type CalibrationCloneFilamentProfileRequest = z.infer<
  typeof CalibrationCloneFilamentProfileRequest
>;

export const CalibrationCloneFilamentProfileResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        clone: z
          .object({
            id: z.string().uuid(),
            name: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
            /**
             * `filament` is the only workflow-legal answer, but upstream's
             * `CloneSingleProfileResponseDto` echoes back the concrete
             * profile type so we validate rather than assert. A machine-typed
             * or process-typed clone here would be a wire drift, not a normal
             * response.
             */
            profileType: z.enum(['machine', 'process', 'filament']),
            /**
             * PR #1952 hard-codes `IsSystem = false` for the clone — user
             * clones are always custom. Enforced structurally so a wire
             * drift into `true` cannot slip past.
             */
            isSystem: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationCloneFilamentProfileResponse = z.infer<
  typeof CalibrationCloneFilamentProfileResponse
>;

// --- calibration:submitCalibrationSlice ---
//
// Backing: `POST /api/slice`
// DTO: `SubmitSliceJobRequest` in `SliceJobDtos.cs`. In calibration mode the
// desktop omits `modelFileUrl` and `model3DId` — the worker resolves the
// calibration model from `resources/calib/` — and NEVER populates
// `calibrationProjectId` / `calibrationAttemptId` /
// `calibrationOrchestrationId`. Upstream rejects any of those with
// `calibration_mode_conflicts_with_saga_ids` (422).
//
// `slicerProfileJson` is a JSON-encoded string on the wire — a `{ machine,
// process, filament }` name triple. We hold the three names as a typed object
// on the IPC boundary and let the HTTP client stringify it, so the renderer
// cannot smuggle arbitrary JSON through this field.
//
// Auth: `Slicing.Submit`.

const CALIBRATION_MAX_METHOD_PARAM_COUNT = 32;

/**
 * Optional numeric parameters for the chosen calibration method. Passthrough
 * keys are permitted — PR #1952's `CalibrationRequest.Params` is
 * `Dictionary<string, JsonElement>` and applies method defaults for any key
 * the caller does not provide. We restrict values to finite numbers because
 * the only in-use params are numeric (`start_temp`, `flow_ratio_target`, ...)
 * and permitting anything else would let a caller send arbitrary JSON blobs
 * that the worker would either ignore or reject.
 */
export const CalibrationSliceMethodParams = z
  .record(z.string().min(1).max(64), z.number().finite())
  .refine(
    (record) =>
      Object.keys(record).length <= CALIBRATION_MAX_METHOD_PARAM_COUNT,
    { message: 'params carries too many keys' },
  );
export type CalibrationSliceMethodParams = z.infer<
  typeof CalibrationSliceMethodParams
>;

export const CalibrationSubmitCalibrationSliceRequest = z
  .object({
    /** Selected PrintFarmer server profile Guid. */
    profileId: z.string().uuid(),
    /**
     * Printer target — carried on the submit for slice-context purposes and
     * later reused on `send-to-printer` when the operator commits to actually
     * printing the calibration piece.
     */
    printerId: z.string().uuid(),
    /**
     * The three-name profile triple the renderer picked. `filamentProfileName`
     * is the cloned filament profile's `Name` — that is *the* variable being
     * calibrated across the workflow.
     */
    machineProfileName: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    processProfileName: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    filamentProfileName: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    /** Calibration method wire name — see `CalibrationSliceMethod`. */
    method: CalibrationSliceMethod,
    /** Optional numeric overrides for the method's default parameters. */
    params: CalibrationSliceMethodParams.optional(),
  })
  .strict();
export type CalibrationSubmitCalibrationSliceRequest = z.infer<
  typeof CalibrationSubmitCalibrationSliceRequest
>;

/**
 * `SubmitSliceJobResponse` fields kept public on the desktop side — the
 * `jobId` is the identifier every subsequent stage needs.
 */
export const CalibrationSubmitCalibrationSliceResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        job: z
          .object({
            jobId: z.string().uuid(),
            status: CalibrationSliceJobStatus,
            queuedAt: z.string().datetime(),
            /**
             * Nullable because PR #1952's `SubmitSliceJobResponse.QueuePosition`
             * is `int?` (server does not always compute a position — a job
             * accepted straight into `Processing` has no queue position).
             */
            queuePosition: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationSubmitCalibrationSliceResponse = z.infer<
  typeof CalibrationSubmitCalibrationSliceResponse
>;

// --- calibration:getSliceJobStatus ---
//
// Backing: `GET /api/slice/{jobId}`
// DTO: `SliceJobStatusResponse` — the *public* projection returned by the
// controller (upstream `SliceJobController.MapToPublicStatusResponse`,
// lines 1215-1258). This is NOT the same shape as the worker's
// `CompleteSliceJobResponse`: `resultFileUrl` does not exist here — the
// public projection exposes `artifactsRoute` (the URL fragment for the
// per-job artifact list) and lets `send-to-printer` handle the actual gcode
// hand-off. If a renderer wants the sliced file, it uses `send-to-printer`,
// not a direct fetch — that is by design so a calibration gcode cannot be
// downloaded, edited, and re-uploaded outside the safety gate.
//
// Auth: `Slicing.Submit`.
//
// This channel is one-shot. The renderer drives the polling loop, passing the
// zero-indexed `pollAttempt` and observing `nextPollDelayMs` (null when the
// snapshot is terminal or the cap has been reached) plus `terminal` and
// `cappedOut`. The backoff schedule and cap live in the main-process helper
// `computeSlicePollHint` so the schedule is testable in isolation and the
// renderer cannot ratchet up the poll rate by lying about its attempt count.

/** Public projection of `SliceJobStatusResponse` from PR #1952. */
export const CalibrationSliceJobSnapshot = z
  .object({
    id: z.string().uuid(),
    status: CalibrationSliceJobStatus,
    /**
     * 0-100 integer. PR #1952 clamps this at the worker before returning it,
     * but we validate again because the wire schema is an unbounded int on
     * the C# side and a drift would otherwise reach the renderer.
     */
    progressPercent: z.number().int().min(0).max(100),
    progressMessage: z.string().max(512).nullable(),
    queuedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    /**
     * Free-form failure text when `status === 'Failed'`. Bounded but not
     * catalogued — a failure hint from the worker like "no calibration model
     * bundle for temperature_tower" is exactly the kind of prose the operator
     * needs to see verbatim. Rendered as-is on the renderer side.
     */
    errorMessage: z.string().max(2048).nullable(),
    /**
     * Admin-only worker-side failure detail (`SliceJobStatusResponse.ErrorDetail`
     * in `SliceJobDtos.cs` @ `a4f230aa...`). The C# DTO documents this as
     * "populated only for farm admins. Never returned to non-admin callers,
     * who only ever see the generic ErrorMessage". For the desktop's operator
     * identity this is expected to always be null, but the field IS on the
     * wire in every response, so it must appear in the strict schema or
     * `.strict()` will reject every non-Failed status snapshot. Bounded at
     * 4 KiB so a misconfigured admin-privileged response cannot smuggle
     * unbounded worker diagnostics through the wire.
     */
    errorDetail: z.string().max(4096).nullable(),
    /**
     * PR #1952 sets this when the worker had to re-arrange the slice plate.
     * A calibration slice should never see it — a non-null value here is a
     * signal the caller sent geometry when they should have relied on the
     * worker's bundled model. The wire value is a `LayoutDegradationReason`
     * enum name (`JsonStringEnumConverter` on the C# side, see
     * `SlicerModels.cs`), not a boolean; the previous `z.boolean().nullable()`
     * contradicted the DTO and would reject every non-null value the real
     * server produces.
     */
    layoutDegradation: z.string().max(64).nullable(),
    /**
     * Machine-readable failure classifier. Only populated when the worker
     * declared a terminal `Failed` — the renderer surfaces the raw code so
     * an operator can quote it, and the poll driver uses it to pick the
     * right catalogued message (`sliceJobFailed`).
     */
    failureReason: z.string().max(128).nullable(),
    /** Free-form hint text paired with `failureReason` when present. */
    failureHint: z.string().max(2048).nullable(),
    /**
     * Server-estimated print time in seconds. Only meaningful once the job
     * has reached `Completed`; before that it may be zero or absent depending
     * on how far the worker got in slicing.
     */
    estimatedPrintTimeSeconds: z.number().int().nonnegative().nullable(),
    /**
     * Server-estimated filament usage in grams. PR #1952 serializes this as
     * `decimal?` on the C# side, which is JSON-encoded as a number — we
     * accept any finite non-negative float and the renderer rounds for
     * display. Never used for retention checks, so precision loss on the
     * boundary is not a correctness concern.
     */
    filamentUsedGrams: z.number().finite().nonnegative().nullable(),
    /** ID of the worker that picked the job up; null when still `Queued`. */
    workerId: z.string().max(128).nullable(),
    /**
     * File name the operator would see in the printer job list. For a
     * calibration slice this comes from the bundled `resources/calib/`
     * artifact — a slug like `flow_rate_pass_1.3mf`, not the operator's
     * filament name — because the worker owns the model.
     */
    modelFileName: z.string().max(512),
    /** Slicer engine enum value as a string. `OrcaSlicer` for this workflow. */
    slicerEngine: z.string().max(64),
    /**
     * Relative URL fragment for the per-job artifact listing endpoint. The
     * renderer treats this opaquely — the calibration workflow uses
     * `send-to-printer`, not a direct fetch — but we surface it so operator
     * tooling and support can chase artifacts by URL when they need to.
     */
    artifactsRoute: z.string().max(512).nullable(),
  })
  .strict();
export type CalibrationSliceJobSnapshot = z.infer<
  typeof CalibrationSliceJobSnapshot
>;

export const CalibrationGetSliceJobStatusRequest = z
  .object({
    profileId: z.string().uuid(),
    jobId: z.string().uuid(),
    /**
     * 0-indexed poll attempt. The very first call passes 0. Each subsequent
     * call increments by 1. The main-process helper `computeSlicePollHint`
     * turns this into the next delay and decides when the cap has been
     * reached — the renderer cannot shorten the schedule by resetting to 0.
     */
    pollAttempt: z.number().int().nonnegative().max(10_000),
  })
  .strict();
export type CalibrationGetSliceJobStatusRequest = z.infer<
  typeof CalibrationGetSliceJobStatusRequest
>;

export const CalibrationGetSliceJobStatusResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        snapshot: CalibrationSliceJobSnapshot,
        /**
         * `completed` / `failed` when the server reported a terminal status,
         * `null` otherwise. On `failed` the renderer receives a paired error
         * on the *next* poll attempt — the poll driver refuses further polls
         * of a failed job and returns `sliceJobFailed` — but the snapshot
         * itself is still an `ok` result because the server did answer.
         */
        terminal: CalibrationSliceJobTerminalOutcome.nullable(),
        /**
         * Suggested delay before the renderer calls again with
         * `pollAttempt + 1`. `null` when either the snapshot is terminal or
         * the poll driver's cap has been reached. Enforced by the main-side
         * hint computation, so the renderer cannot poll faster than the
         * schedule allows.
         */
        nextPollDelayMs: z.number().int().positive().max(60_000).nullable(),
        /**
         * `true` when the cap has been reached. A subsequent
         * `getSliceJobStatus` call for the same `jobId` with a higher
         * `pollAttempt` will return `sliceJobTimeout` — this flag exists so
         * the renderer can show "no more automatic polling" before the
         * operator asks for another retry.
         */
        cappedOut: z.boolean(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationGetSliceJobStatusResponse = z.infer<
  typeof CalibrationGetSliceJobStatusResponse
>;

// --- calibration:sendSliceToPrinter ---
//
// Backing: `POST /api/slice/{jobId}/send-to-printer`
// DTO: `SendToPrinterRequest { PrinterId, StartPrint }` →
//   `SendToPrinterResponse { JobId, PrinterId, FileName, PrintStarted, Message }`.
// Auth: `Queue.Start` (upstream `SlicePrintBridgeController` scope).
//
// `startPrint: true` is a **machine-moving action**. It is guarded by
// `calibrationActionGate.ts` — an `operatorAcknowledgement` minted by main is
// required before the request is dispatched. Never default it to `true`; the
// renderer must supply it explicitly per operator click.

export const CalibrationSendSliceToPrinterRequest = z
  .object({
    profileId: z.string().uuid(),
    jobId: z.string().uuid(),
    printerId: z.string().uuid(),
    /**
     * `true` starts the print immediately after transfer; `false` uploads the
     * gcode to the printer's queue and leaves it idle. Required rather than
     * defaulted because the two are fundamentally different actions from a
     * safety perspective — see block comment above.
     */
    startPrint: z.boolean(),
    /**
     * Live operator acknowledgement minted by `calibrationActionGate.ts`.
     * Required only when `startPrint` is `true`; the gate is a no-op for
     * an upload-only transfer. Verified structurally on the main side.
     */
    operatorAcknowledgement: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type CalibrationSendSliceToPrinterRequest = z.infer<
  typeof CalibrationSendSliceToPrinterRequest
>;

export const CalibrationSendSliceToPrinterResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        result: z
          .object({
            jobId: z.string().uuid(),
            printerId: z.string().uuid(),
            fileName: z.string().max(512),
            printStarted: z.boolean(),
            /** Free-form server confirmation text. */
            message: z.string().max(2048).nullable(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationSendSliceToPrinterResponse = z.infer<
  typeof CalibrationSendSliceToPrinterResponse
>;

// --- calibration:updateFilamentProfileMeasurement ---
//
// Backing: `PUT /api/slicer/profiles/custom/{id}`
// DTO: `UpdateCustomProfileRequestDto` — replaces `rawJson`, `name`,
// `description`, or the printer-compatibility fields, only for non-null
// entries. We take semantic measurements on the desktop side and let the
// HTTP client synthesise the `rawJson` merge — the renderer never crafts
// the profile JSON directly, so a key drift stays localised to the merge
// helper.
//
// Auth: `Slicing.Submit` + `InteractiveSessionRequirement` (same 403 path
// as the clone endpoint).
//
// The method-to-key mapping is:
//   flow_rate_pass_1 / flow_rate_pass_2           → filament_flow_ratio
//   flow_rate_yolo_recommended /
//   flow_rate_yolo_perfectionist                  → filament_flow_ratio
//   max_volumetric_speed                          → filament_max_volumetric_speed
//   pressure_advance_tower                        → pressure_advance +
//                                                   enable_pressure_advance
//   retraction                                    → filament_retraction_length
//   temperature_tower                             → nozzle_temperature +
//                                                   nozzle_temperature_initial_layer
// This is enforced structurally by the discriminated union below — a
// temperature-tower request that only carries `filamentFlowRatio` fails
// at the IPC boundary.
//
// All four flow methods share one measurement shape and one write-back key,
// so consumers must branch on the *shape* (`'filamentFlowRatio' in m`) rather
// than on a list of method literals. A literal list silently mis-routes every
// method added after it was written — see the write-back in `main/ipc.ts`,
// which treated any non-`flow_rate_pass_*` method as a temperature tower.
//
// Numeric bounds on the single-value measurements mirror the server's
// `CalibrationMeasurementRanges` verbatim rather than being invented here, so
// a value the desktop accepts is never one the server would reject.

/**
 * PrintFarmer's own nozzle-temperature measurement band, in °C: 150-320.
 *
 * This mirrors the server's real `CalibrationMeasurementRanges` band per the
 * comment above, the same way every sibling bound in this union does — it is
 * NOT the per-printer `maximumNozzleTemperatureC` (`CalibrationPrinterContext
 * .safety.maximumNozzleTemperatureC`, reduced from the printer's toolheads in
 * `calibrationWire.ts`), which this flow has no way to read (see the
 * `temperature_tower` bound below for why). A wider "internal ceiling" such
 * as `WorkspaceBaseline.nozzleTemperatureC`'s 2000 is deliberately NOT used
 * here: nothing downstream of this schema clamps a filament-measurement
 * value against a real per-printer limit before it is written into the
 * profile and used to drive hotend heating, so the schema bound is the only
 * safety-relevant guard this flow has. 320 is the widest value this
 * boundary can accept without also being able to accept a value no printer
 * could safely reach.
 */
export const PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C = 320;

export const CalibrationFilamentMeasurement = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('flow_rate_pass_1'),
      /**
       * `filament_flow_ratio` per OrcaSlicer wiki. Values outside 0.5..1.5
       * are physically implausible for a first-pass flow calibration and
       * suggest an analysis error rather than a real reading; we bound to
       * that range at the IPC boundary.
       */
      filamentFlowRatio: z.number().finite().min(0.5).max(1.5),
    })
    .strict(),
  z
    .object({
      method: z.literal('flow_rate_pass_2'),
      filamentFlowRatio: z.number().finite().min(0.5).max(1.5),
    })
    .strict(),
  z
    .object({
      method: z.literal('flow_rate_yolo_recommended'),
      /**
       * YOLO (Recommended) measures the same physical quantity as the legacy
       * two-pass method — a corrected `filament_flow_ratio` — in a single
       * print, so it carries the identical payload and the identical 0.5..1.5
       * plausibility band.
       */
      filamentFlowRatio: z.number().finite().min(0.5).max(1.5),
    })
    .strict(),
  z
    .object({
      method: z.literal('flow_rate_yolo_perfectionist'),
      /**
       * YOLO (Perfectionist) is a finer sweep than Recommended but resolves to
       * the same `filament_flow_ratio` key and the same band.
       */
      filamentFlowRatio: z.number().finite().min(0.5).max(1.5),
    })
    .strict(),
  z
    .object({
      method: z.literal('temperature_tower'),
      /**
       * Print temperature in °C, bounded to `PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C`
       * (PrintFarmer's real 150-320 band) rather than the 300 this used to
       * hard-cap at.
       */
      nozzleTemperature: z
        .number()
        .int()
        .min(150)
        .max(PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C),
      /**
       * Initial-layer temperature in °C. Same band as `nozzleTemperature`.
       */
      nozzleTemperatureInitialLayer: z
        .number()
        .int()
        .min(150)
        .max(PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C),
    })
    .strict(),
  z
    .object({
      method: z.literal('max_volumetric_speed'),
      /**
       * Observed maximum volumetric speed in mm³/s — the value the operator
       * settles on after inspecting the printed tower, not the permissive
       * slicing-time ceiling the worker applies before slicing.
       *
       * Bounds mirror the server's
       * `CalibrationMeasurementRanges.MaximumVolumetricSpeed` (1..60) exactly.
       * The upper bound sits deliberately above the worker's 50mm³/s slicing
       * ceiling so a filament that tolerates slightly more is not rejected.
       */
      maxVolumetricSpeed: z.number().finite().min(1).max(60),
    })
    .strict(),
  z
    .object({
      method: z.literal('pressure_advance_tower'),
      /**
       * Pressure-advance (linear-advance) coefficient. Bounds mirror the
       * server's `CalibrationMeasurementRanges.PressureAdvance` (0.0..2.0).
       *
       * The write-back also sets `enable_pressure_advance`: a coefficient
       * written into a profile that leaves the flag off produces a profile
       * that looks calibrated and prints as though it were not.
       */
      pressureAdvance: z.number().finite().min(0).max(2),
    })
    .strict(),
  z
    .object({
      method: z.literal('retraction'),
      /**
       * Retraction length in millimetres. Bounds mirror the server's
       * `CalibrationMeasurementRanges.RetractionLength` (0.0..10.0).
       *
       * Written to `filament_retraction_length` — the OrcaSlicer *per-filament
       * override*, not the machine-level `retraction_length`. The wizard's only
       * output is a filament clone, and the server leaves the write-back to the
       * client precisely so it lands in the consumer's own scope.
       */
      retractionLength: z.number().finite().min(0).max(10),
    })
    .strict(),
]);
export type CalibrationFilamentMeasurement = z.infer<
  typeof CalibrationFilamentMeasurement
>;

export const CalibrationUpdateFilamentProfileMeasurementRequest = z
  .object({
    profileId: z.string().uuid(),
    /** Custom filament profile Guid (the clone from step 1). */
    customProfileId: z.string().uuid(),
    measurement: CalibrationFilamentMeasurement,
  })
  .strict();
export type CalibrationUpdateFilamentProfileMeasurementRequest = z.infer<
  typeof CalibrationUpdateFilamentProfileMeasurementRequest
>;

export const CalibrationUpdateFilamentProfileMeasurementResponse =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('ok'),
        /**
         * The 4-field projection the renderer needs to confirm the write
         * landed. The wire actually returns `CustomProfileDto` (10 fields;
         * see `CloneProfilesDtos.cs`), and the main-process handler narrows
         * to this shape before parsing — so widening the renderer surface
         * to include `rawJson`, timestamps, or the printer-model association
         * is a deliberate contract change, not a byproduct of the DTO shape.
         * An earlier version of this docblock claimed the PUT endpoint
         * returned `CloneSingleProfileResponseDto`; that was false —
         * `UpdateCustomProfileAsync` is typed `Task<CustomProfileDto>` in
         * `IProfilesService.cs`.
         */
        updated: z
          .object({
            id: z.string().uuid(),
            name: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
            profileType: z.enum(['machine', 'process', 'filament']),
            isSystem: z.literal(false),
          })
          .strict(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ]);
export type CalibrationUpdateFilamentProfileMeasurementResponse = z.infer<
  typeof CalibrationUpdateFilamentProfileMeasurementResponse
>;

// --- calibration:submitCalibrationObservation (issue #795) ------------------
//
// Backing: `POST /api/calibration-projects/{projectId}/attempts` followed by
// `POST /api/calibration-attempts/{attemptId}/observations` (a `selection`
// observation). Both calls happen inside the main-process handler; the
// renderer submits one measurement and gets back one attempt/observation
// pair. Auth: `Calibration.Create` + `Calibration.Update` (both already held
// by the desktop's existing scope bundle).
//
// This is the write-back target `CalibrationUpdateFilamentProfileMeasurement`
// used to own alone: submitting here merges the measurement into the
// project's *draft* profile, not any real custom profile, so an abandoned
// project accumulates nothing an operator can see in their filament list.
// The desktop still also calls `CalibrationUpdateFilamentProfileMeasurement`
// to keep the live clone in sync for slicing continuity between methods
// (slicing resolves profiles by name — see `createAttempt`'s doc comment in
// `calibrationHttp.ts` for why the clone cannot be retired yet).

export const CalibrationSubmitCalibrationObservationRequest = z
  .object({
    profileId: z.string().uuid(),
    /** The `CalibrationProject` created at wizard start (issue #798). */
    projectId: z.string().uuid(),
    /**
     * Idempotency key pair for the attempt-create call, paired with a fixed
     * `clientId` on the main-process side. Kept stable across a retry of the
     * *same* measurement submission; mint a fresh `requestId` only for a
     * genuinely new attempt.
     */
    requestId: z.string().uuid(),
    /** Idempotency key for the observation-append call. */
    operationId: z.string().uuid(),
    measurement: CalibrationFilamentMeasurement,
  })
  .strict();
export type CalibrationSubmitCalibrationObservationRequest = z.infer<
  typeof CalibrationSubmitCalibrationObservationRequest
>;

export const CalibrationSubmitCalibrationObservationResponse =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('ok'),
        attemptId: z.string().uuid(),
        observationId: z.string().uuid(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ]);
export type CalibrationSubmitCalibrationObservationResponse = z.infer<
  typeof CalibrationSubmitCalibrationObservationResponse
>;

// --- calibration:completeCalibrationProject (issue #795) --------------------
//
// Backing: `GET /api/calibration-projects/{projectId}` (to source a fresh
// `baseRevision`) followed by
// `PATCH /api/calibration-projects/{projectId}` with
// `lifecycleStatus: "Completed"`. Both calls happen inside the main-process
// handler. Auth: `Calibration.Read` + `Calibration.Update`.
//
// A genuine `Active` → `Completed` transition triggers server-side
// promotion of the accumulated draft profile into a brand-new real custom
// filament profile (`IFilamentProfilePromotionGateway.PromoteAsync`); the
// desktop never calls the slicer's `promote-from-calibration` route
// directly.
//
// KNOWN, DISCLOSED SCOPE LIMITATION (issue #795): this is the only path that
// creates a *promoted* custom filament profile from the accumulated draft.
// It is NOT the only path that leaves a visible entry in the user's custom
// filament profile list at all — `CalibrationCloneFilamentProfile` still
// creates a real, named custom profile at wizard step 1 (kept because
// slicing resolves profiles by name, not by project/draft reference; see
// `createAttempt`'s doc comment in `calibrationHttp.ts`). An abandoned run
// therefore still leaves that clone behind. What this change delivers is:
// abandoning never creates a SECOND profile via promotion, and completing
// reliably produces one via promotion — it does not yet make an abandoned
// run leave zero profiles. Eliminating the clone itself is blocked on
// OlyForge3D/PrintFarmer#2203 (a non-admin way to remove/archive it) or an
// equivalent change letting slicing resolve profiles by reference.
//
// This handler best-effort reads the draft profile after a successful PATCH
// to report `promotedProfileId`; a failure on that follow-up read does not
// fail the completion itself (the project has already transitioned) and is
// reported as `promotedProfileId: null`.

export const CalibrationCompleteCalibrationProjectRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
  })
  .strict();
export type CalibrationCompleteCalibrationProjectRequest = z.infer<
  typeof CalibrationCompleteCalibrationProjectRequest
>;

export const CalibrationCompleteCalibrationProjectResponse =
  z.discriminatedUnion('status', [
    z
      .object({
        status: z.literal('ok'),
        lifecycleStatus: z.string().min(1).max(64),
        /**
         * The newly-promoted custom filament profile's Guid, when the
         * follow-up draft-profile read succeeded and promotion had already
         * occurred (immediately, since promotion is synchronous with the
         * `Completed` transition). `null` when the follow-up read failed or
         * a promotion claim was still in flight; the caller may re-invoke
         * this channel (idempotent) or poll `getDraftProfile` separately.
         */
        promotedProfileId: z.string().uuid().nullable(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ]);
export type CalibrationCompleteCalibrationProjectResponse = z.infer<
  typeof CalibrationCompleteCalibrationProjectResponse
>;

// --- Filament calibration wizard restart resilience (issue #754) -----------
//
// The wizard's in-flight progress (which method, which step, the in-flight
// slice `jobId`) previously lived only in renderer memory (PR #753) — an app
// restart mid-calibration lost that bookkeeping, though never the underlying
// work: the cloned profile and any written-back measurements are durable on
// the server, and an in-flight slice job keeps running there too.
//
// `saveCalibrationWorkspaceState` does not fit: its schema is bound to the
// printer-calibration domain (`projectId`/`printerId`, server-derived
// `completedStepCount`/`totalStepCount`), which #750 deliberately removed
// from the filament flow (see
// `.squad/decisions/inbox/vasquez-filament-calibration-reframe.md`). This is
// the additive, filament-shaped alternative: a small channel pair, persisted
// on disk in the main process with the same atomic write pattern
// `UpdateStateStore` uses (`src/main/updateState.ts`), keyed by server
// profile. One record per profile — a profile can have at most one filament
// calibration wizard in flight, matching the one-wizard-per-profile UI.
//
// The wire contract only accepts the four *stable* phases a resume can safely
// land on (`methodPicker`, `pollingSlice`, `sliceReady`, `awaitingMeasurement`).
// A phase where a network call is actually in flight when the process dies
// (submitting a slice, sending to the printer, writing back a measurement) is
// deliberately unrepresentable here: the renderer maps that transient phase
// back to its nearest stable predecessor before persisting, so "was the
// in-flight request applied server-side" is never a question this record has
// to answer — the operator just retries the step. Enforced structurally by
// the enum below, not by a comment the renderer could ignore.

export const FilamentWizardStateInFlightJob = z
  .object({
    jobId: z.string().min(1).max(256),
    method: CalibrationSliceMethod,
    submittedAt: z.string().datetime(),
    pollAttempt: z.number().int().nonnegative().max(10_000),
    lastStatus: CalibrationSliceJobStatus,
  })
  .strict();
export type FilamentWizardStateInFlightJob = z.infer<
  typeof FilamentWizardStateInFlightJob
>;

/** The phases a restored wizard may resume into. See block comment above. */
export const FilamentWizardStatePhase = z.enum([
  'methodPicker',
  'pollingSlice',
  'sliceReady',
  'awaitingMeasurement',
]);
export type FilamentWizardStatePhase = z.infer<typeof FilamentWizardStatePhase>;

export const FilamentWizardStateRecord = z
  .object({
    schemaVersion: z.literal(1),
    printerId: z.string().min(1).max(256),
    printerModelId: z.string().uuid().nullable(),
    machineName: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    processName: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    baseFilamentName: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    baseFilamentGuid: z.string().uuid(),
    /** The clone id every write-back names — the identity that carries state across steps. */
    cloneId: z.string().uuid(),
    cloneName: z.string().min(1).max(CALIBRATION_MAX_PROFILE_NAME),
    /**
     * The `CalibrationProject` created at wizard start (issue #798),
     * threaded through so a resumed wizard can keep submitting
     * attempt/observation write-back (#795) against the SAME project
     * instead of silently losing that binding across a restart. `nullish`
     * for backward compatibility with records persisted by a build before
     * #795 shipped, which never wrote this key at all.
     */
    projectId: z
      .string()
      .uuid()
      .nullish()
      .transform((v) => v ?? null),
    completedMethods: z
      .array(CalibrationSliceMethod)
      .max(CalibrationSliceMethod.options.length),
    currentMethod: CalibrationSliceMethod.nullable(),
    inFlightJob: FilamentWizardStateInFlightJob.nullable(),
    /**
     * See `WizardWorkingState.draftObservationFailures` in
     * `FilamentCalibrationWizard.tsx` for the full rationale. `nullish` for
     * backward compatibility with records persisted by a build before this
     * field existed, which never wrote this key at all — treated as "no
     * known failures" rather than failing to parse the whole record.
     */
    draftObservationFailures: z
      .array(CalibrationSliceMethod)
      .max(CalibrationSliceMethod.options.length)
      .nullish()
      .transform((v) => v ?? []),
    phase: FilamentWizardStatePhase,
    updatedAt: z.string().datetime(),
  })
  .strict();
export type FilamentWizardStateRecord = z.infer<
  typeof FilamentWizardStateRecord
>;

export const CalibrationSaveFilamentWizardStateRequest = z
  .object({
    profileId: z.string().uuid(),
    state: FilamentWizardStateRecord,
  })
  .strict();
export type CalibrationSaveFilamentWizardStateRequest = z.infer<
  typeof CalibrationSaveFilamentWizardStateRequest
>;

export const CalibrationSaveFilamentWizardStateResponse = z
  .object({ saved: z.literal(true) })
  .strict();
export type CalibrationSaveFilamentWizardStateResponse = z.infer<
  typeof CalibrationSaveFilamentWizardStateResponse
>;

export const CalibrationGetFilamentWizardStateRequest = z
  .object({ profileId: z.string().uuid() })
  .strict();
export type CalibrationGetFilamentWizardStateRequest = z.infer<
  typeof CalibrationGetFilamentWizardStateRequest
>;

export const CalibrationGetFilamentWizardStateResponse =
  FilamentWizardStateRecord.nullable();
export type CalibrationGetFilamentWizardStateResponse = z.infer<
  typeof CalibrationGetFilamentWizardStateResponse
>;

export const CalibrationClearFilamentWizardStateRequest = z
  .object({ profileId: z.string().uuid() })
  .strict();
export type CalibrationClearFilamentWizardStateRequest = z.infer<
  typeof CalibrationClearFilamentWizardStateRequest
>;

export const CalibrationClearFilamentWizardStateResponse = z
  .object({ cleared: z.boolean() })
  .strict();
export type CalibrationClearFilamentWizardStateResponse = z.infer<
  typeof CalibrationClearFilamentWizardStateResponse
>;

/**
 * Registry mapping each channel to its request/response schemas. Used by both
 * the main-process handler registration and the preload bridge.
 */
export const ipcSchemas = {
  [IpcChannel.AppInfo]: {
    request: AppInfoRequest,
    response: AppInfoResponse,
  },
  [IpcChannel.SidecarPing]: {
    request: SidecarPingRequest,
    response: SidecarPingResponse,
  },
  [IpcChannel.LoadScene]: {
    request: LoadSceneRequest,
    response: LoadSceneResponse,
  },
  [IpcChannel.OpenModelFile]: {
    request: OpenModelFileRequest,
    response: OpenModelFileResponse,
  },
  [IpcChannel.ExtractVendorMetadata]: {
    request: ExtractVendorMetadataRequest,
    response: ExtractVendorMetadataResponse,
  },
  [IpcChannel.ExtractVendorPlateThumbnails]: {
    request: ExtractVendorPlateThumbnailsRequest,
    response: ExtractVendorPlateThumbnailsResponse,
  },
  [IpcChannel.RenderThumbnail]: {
    request: RenderThumbnailRequest,
    response: RenderThumbnailResponse,
  },
  [IpcChannel.ScanRoot]: {
    request: ScanRootRequest,
    response: ScanRootResponse,
  },
  [IpcChannel.PreviewImport]: {
    request: ImportPreviewRequest,
    response: ImportPreviewResponse,
  },
  [IpcChannel.ImportRoot]: {
    request: ImportRootRequest,
    response: ImportRootResponse,
  },
  [IpcChannel.ListModels]: {
    request: ListModelsRequest,
    response: ListModelsResponse,
  },
  [IpcChannel.ResetCatalog]: {
    request: ResetCatalogRequest,
    response: ResetCatalogResponse,
  },
  [IpcChannel.ListFavorites]: {
    request: ListFavoritesRequest,
    response: ListFavoritesResponse,
  },
  [IpcChannel.AddFavorite]: {
    request: FavoriteModelRequest,
    response: FavoriteModelResponse,
  },
  [IpcChannel.RemoveFavorite]: {
    request: FavoriteModelRequest,
    response: FavoriteModelResponse,
  },
  [IpcChannel.ListTags]: {
    request: ListTagsRequest,
    response: ListTagsResponse,
  },
  [IpcChannel.TagsForModel]: {
    request: TagsForModelRequest,
    response: TagsForModelResponse,
  },
  [IpcChannel.AddModelTag]: {
    request: AddModelTagRequest,
    response: AddModelTagResponse,
  },
  [IpcChannel.RemoveModelTag]: {
    request: RemoveModelTagRequest,
    response: RemoveModelTagResponse,
  },
  [IpcChannel.ListCollections]: {
    request: ListCollectionsRequest,
    response: ListCollectionsResponse,
  },
  [IpcChannel.CollectionsForModel]: {
    request: CollectionsForModelRequest,
    response: CollectionsForModelResponse,
  },
  [IpcChannel.CreateCollection]: {
    request: CreateCollectionRequest,
    response: CreateCollectionResponse,
  },
  [IpcChannel.DeleteCollection]: {
    request: DeleteCollectionRequest,
    response: DeleteCollectionResponse,
  },
  [IpcChannel.AddModelToCollection]: {
    request: CollectionMembershipRequest,
    response: CollectionMembershipResponse,
  },
  [IpcChannel.RemoveModelFromCollection]: {
    request: CollectionMembershipRequest,
    response: CollectionMembershipResponse,
  },
  [IpcChannel.OpenFolder]: {
    request: OpenFolderRequest,
    response: OpenFolderResponse,
  },
  [IpcChannel.ListServerProfiles]: {
    request: ListServerProfilesRequest,
    response: ListServerProfilesResponse,
  },
  [IpcChannel.TestServerProfile]: {
    request: TestServerProfileRequest,
    response: TestServerProfileResponse,
  },
  [IpcChannel.SaveServerProfile]: {
    request: SaveServerProfileRequest,
    response: SaveServerProfileResponse,
  },
  [IpcChannel.SelectServerProfile]: {
    request: SelectServerProfileRequest,
    response: SelectServerProfileResponse,
  },
  [IpcChannel.DeleteServerProfile]: {
    request: DeleteServerProfileRequest,
    response: DeleteServerProfileResponse,
  },
  [IpcChannel.StartUploadJob]: {
    request: StartUploadJobRequest,
    response: StartUploadJobResponse,
  },
  [IpcChannel.ListUploadJobs]: {
    request: ListUploadJobsRequest,
    response: ListUploadJobsResponse,
  },
  [IpcChannel.PauseUploadJob]: {
    request: UploadJobRequest,
    response: UploadJobResponse,
  },
  [IpcChannel.ResumeUploadJob]: {
    request: UploadJobRequest,
    response: UploadJobResponse,
  },
  [IpcChannel.CancelUploadJob]: {
    request: UploadJobRequest,
    response: UploadJobResponse,
  },
  [IpcChannel.RetryUploadJob]: {
    request: UploadJobRequest,
    response: UploadJobResponse,
  },
  [IpcChannel.ConfirmLegacyUploadRetry]: {
    request: UploadJobRequest,
    response: UploadJobResponse,
  },
  [IpcChannel.RemoveUploadJob]: {
    request: UploadJobRequest,
    response: RemoveUploadJobResponse,
  },
  [IpcChannel.ResetUploadJobs]: {
    request: ResetUploadJobsRequest,
    response: ResetUploadJobsResponse,
  },
  [IpcChannel.ResetApprovedRoots]: {
    request: ResetApprovedRootsRequest,
    response: ResetApprovedRootsResponse,
  },
  [IpcChannel.RetargetListProfiles]: {
    request: RetargetListProfilesRequest,
    response: RetargetListProfilesResponse,
  },
  [IpcChannel.RetargetImportProfile]: {
    request: RetargetImportProfileRequest,
    response: RetargetImportProfileResponse,
  },
  [IpcChannel.RetargetPreflight]: {
    request: RetargetPreflightRequest,
    response: RetargetPreflightResponse,
  },
  [IpcChannel.RetargetBuild]: {
    request: RetargetBuildRequest,
    response: RetargetBuildResponse,
  },
  [IpcChannel.RetargetLoadScene]: {
    request: RetargetLoadSceneRequest,
    response: RetargetLoadSceneResponse,
  },
  [IpcChannel.RetargetSaveAs]: {
    request: RetargetSaveAsRequest,
    response: RetargetSaveAsResponse,
  },
  [IpcChannel.RetargetDispose]: {
    request: RetargetDisposeRequest,
    response: RetargetDisposeResponse,
  },
  // --- Printer Calibration transport (issue #52) ---------------------------
  [IpcChannel.CalibrationGetAvailability]: {
    request: CalibrationGetAvailabilityRequest,
    response: CalibrationGetAvailabilityResponse,
  },
  [IpcChannel.CalibrationListPrinters]: {
    request: CalibrationListPrintersRequest,
    response: CalibrationListPrintersResponse,
  },
  [IpcChannel.CalibrationGetPrinterContext]: {
    request: CalibrationGetPrinterContextRequest,
    response: CalibrationGetPrinterContextResponse,
  },
  [IpcChannel.CalibrationListWorkspaceStates]: {
    request: CalibrationListWorkspaceStatesRequest,
    response: CalibrationListWorkspaceStatesResponse,
  },
  [IpcChannel.CalibrationGetWorkspaceState]: {
    request: CalibrationGetWorkspaceStateRequest,
    response: CalibrationGetWorkspaceStateResponse,
  },
  [IpcChannel.CalibrationSaveWorkspaceState]: {
    request: CalibrationSaveWorkspaceStateRequest,
    response: CalibrationSaveWorkspaceStateResponse,
  },
  [IpcChannel.CalibrationSyncNow]: {
    request: CalibrationSyncNowRequest,
    response: CalibrationSyncNowResponse,
  },
  [IpcChannel.CalibrationGetDiagnostics]: {
    request: CalibrationGetDiagnosticsRequest,
    response: CalibrationGetDiagnosticsResponse,
  },
  [IpcChannel.CalibrationResolveConflict]: {
    request: CalibrationResolveConflictRequest,
    response: CalibrationResolveConflictResponse,
  },
  [IpcChannel.CalibrationListConflicts]: {
    request: CalibrationListConflictsRequest,
    response: CalibrationListConflictsResponse,
  },
  // --- Queue reconciliation (issue #54) ------------------------------------
  [IpcChannel.CalibrationPollQueueChanges]: {
    request: CalibrationPollQueueChangesRequest,
    response: CalibrationPollQueueChangesResponse,
  },
  [IpcChannel.CalibrationGetSubscriptionResources]: {
    request: CalibrationGetSubscriptionResourcesRequest,
    response: CalibrationGetSubscriptionResourcesResponse,
  },
  [IpcChannel.CalibrationListOrcaProfiles]: {
    request: CalibrationListOrcaProfilesRequest,
    response: CalibrationListOrcaProfilesResponse,
  },
  [IpcChannel.CalibrationExportOrcaProfile]: {
    request: CalibrationExportOrcaProfileRequest,
    response: CalibrationExportOrcaProfileResponse,
  },
  [IpcChannel.CalibrationListExtendedProfiles]: {
    request: CalibrationListExtendedProfilesRequest,
    response: CalibrationListExtendedProfilesResponse,
  },
  [IpcChannel.CalibrationListMachineProfilesForModel]: {
    request: CalibrationListMachineProfilesForModelRequest,
    response: CalibrationListMachineProfilesForModelResponse,
  },
  [IpcChannel.CalibrationListProcessProfilesForMachines]: {
    request: CalibrationListProcessProfilesForMachinesRequest,
    response: CalibrationListProcessProfilesForMachinesResponse,
  },
  [IpcChannel.CalibrationListFilamentProfilesForMachines]: {
    request: CalibrationListFilamentProfilesForMachinesRequest,
    response: CalibrationListFilamentProfilesForMachinesResponse,
  },
  [IpcChannel.CalibrationListCustomProfiles]: {
    request: CalibrationListCustomProfilesRequest,
    response: CalibrationListCustomProfilesResponse,
  },
  [IpcChannel.CalibrationResolveSystemProfile]: {
    request: CalibrationResolveSystemProfileRequest,
    response: CalibrationResolveSystemProfileResponse,
  },
  [IpcChannel.CalibrationCreateProject]: {
    request: CalibrationCreateProjectRequest,
    response: CalibrationCreateProjectResponse,
  },
  [IpcChannel.CalibrationCloneFilamentProfile]: {
    request: CalibrationCloneFilamentProfileRequest,
    response: CalibrationCloneFilamentProfileResponse,
  },
  [IpcChannel.CalibrationSubmitCalibrationSlice]: {
    request: CalibrationSubmitCalibrationSliceRequest,
    response: CalibrationSubmitCalibrationSliceResponse,
  },
  [IpcChannel.CalibrationGetSliceJobStatus]: {
    request: CalibrationGetSliceJobStatusRequest,
    response: CalibrationGetSliceJobStatusResponse,
  },
  [IpcChannel.CalibrationSendSliceToPrinter]: {
    request: CalibrationSendSliceToPrinterRequest,
    response: CalibrationSendSliceToPrinterResponse,
  },
  [IpcChannel.CalibrationUpdateFilamentProfileMeasurement]: {
    request: CalibrationUpdateFilamentProfileMeasurementRequest,
    response: CalibrationUpdateFilamentProfileMeasurementResponse,
  },
  [IpcChannel.CalibrationSubmitCalibrationObservation]: {
    request: CalibrationSubmitCalibrationObservationRequest,
    response: CalibrationSubmitCalibrationObservationResponse,
  },
  [IpcChannel.CalibrationCompleteCalibrationProject]: {
    request: CalibrationCompleteCalibrationProjectRequest,
    response: CalibrationCompleteCalibrationProjectResponse,
  },
  [IpcChannel.CalibrationSaveFilamentWizardState]: {
    request: CalibrationSaveFilamentWizardStateRequest,
    response: CalibrationSaveFilamentWizardStateResponse,
  },
  [IpcChannel.CalibrationGetFilamentWizardState]: {
    request: CalibrationGetFilamentWizardStateRequest,
    response: CalibrationGetFilamentWizardStateResponse,
  },
  [IpcChannel.CalibrationClearFilamentWizardState]: {
    request: CalibrationClearFilamentWizardStateRequest,
    response: CalibrationClearFilamentWizardStateResponse,
  },
} as const;

export type IpcSchemas = typeof ipcSchemas;

/** Typed surface exposed on `window.printFarmer` by the preload bridge. */
export interface PrintFarmerApi {
  getAppInfo(): Promise<AppInfoResponse>;
  pingSidecar(request: SidecarPingRequest): Promise<SidecarPingResponse>;
  loadScene(request: LoadSceneRequest): Promise<LoadSceneResponse>;
  openModelFile(): Promise<OpenModelFileResponse>;
  extractVendorMetadata(
    request: ExtractVendorMetadataRequest,
  ): Promise<ExtractVendorMetadataResponse>;
  extractVendorPlateThumbnails(
    request: ExtractVendorPlateThumbnailsRequest,
  ): Promise<ExtractVendorPlateThumbnailsResponse>;
  renderThumbnail(
    request: RenderThumbnailRequest,
  ): Promise<RenderThumbnailResponse>;
  scanRoot(request: ScanRootRequest): Promise<ScanRootResponse>;
  previewImport(request: ImportPreviewRequest): Promise<ImportPreviewResponse>;
  importRoot(request: ImportRootRequest): Promise<ImportRootResponse>;
  listModels(): Promise<ListModelsResponse>;
  resetCatalog(): Promise<ResetCatalogResponse>;
  listFavorites(): Promise<ListFavoritesResponse>;
  addFavorite(request: FavoriteModelRequest): Promise<FavoriteModelResponse>;
  removeFavorite(request: FavoriteModelRequest): Promise<FavoriteModelResponse>;
  listTags(): Promise<ListTagsResponse>;
  tagsForModel(request: TagsForModelRequest): Promise<TagsForModelResponse>;
  addModelTag(request: AddModelTagRequest): Promise<AddModelTagResponse>;
  removeModelTag(
    request: RemoveModelTagRequest,
  ): Promise<RemoveModelTagResponse>;
  listCollections(): Promise<ListCollectionsResponse>;
  collectionsForModel(
    request: CollectionsForModelRequest,
  ): Promise<CollectionsForModelResponse>;
  createCollection(
    request: CreateCollectionRequest,
  ): Promise<CreateCollectionResponse>;
  deleteCollection(
    request: DeleteCollectionRequest,
  ): Promise<DeleteCollectionResponse>;
  addModelToCollection(
    request: CollectionMembershipRequest,
  ): Promise<CollectionMembershipResponse>;
  removeModelFromCollection(
    request: CollectionMembershipRequest,
  ): Promise<CollectionMembershipResponse>;
  openFolder(): Promise<OpenFolderResponse>;
  listServerProfiles(): Promise<ListServerProfilesResponse>;
  testServerProfile(
    request: TestServerProfileRequest,
  ): Promise<TestServerProfileResponse>;
  saveServerProfile(
    request: SaveServerProfileRequest,
  ): Promise<SaveServerProfileResponse>;
  selectServerProfile(
    request: SelectServerProfileRequest,
  ): Promise<SelectServerProfileResponse>;
  deleteServerProfile(
    request: DeleteServerProfileRequest,
  ): Promise<DeleteServerProfileResponse>;
  startUploadJob(
    request: StartUploadJobRequest,
  ): Promise<StartUploadJobResponse>;
  listUploadJobs(): Promise<ListUploadJobsResponse>;
  pauseUploadJob(request: UploadJobRequest): Promise<UploadJobResponse>;
  resumeUploadJob(request: UploadJobRequest): Promise<UploadJobResponse>;
  cancelUploadJob(request: UploadJobRequest): Promise<UploadJobResponse>;
  retryUploadJob(request: UploadJobRequest): Promise<UploadJobResponse>;
  confirmLegacyUploadRetry(
    request: UploadJobRequest,
  ): Promise<UploadJobResponse>;
  removeUploadJob(request: UploadJobRequest): Promise<RemoveUploadJobResponse>;
  resetUploadJobs(): Promise<ResetUploadJobsResponse>;
  resetApprovedRoots(): Promise<ResetApprovedRootsResponse>;
  listRetargetProfiles(): Promise<RetargetListProfilesResponse>;
  importRetargetProfile(): Promise<RetargetImportProfileResponse>;
  preflightRetarget(
    request: RetargetPreflightRequest,
  ): Promise<RetargetPreflightResponse>;
  buildRetarget(request: RetargetBuildRequest): Promise<RetargetBuildResponse>;
  loadRetargetScene(
    request: RetargetLoadSceneRequest,
  ): Promise<RetargetLoadSceneResponse>;
  saveRetargetAs(
    request: RetargetSaveAsRequest,
  ): Promise<RetargetSaveAsResponse>;
  disposeRetarget(
    request: RetargetDisposeRequest,
  ): Promise<RetargetDisposeResponse>;
  // --- Printer Calibration transport (issue #52) ---------------------------
  getCalibrationAvailability(): Promise<CalibrationGetAvailabilityResponse>;
  listCalibrationPrinters(
    request: CalibrationListPrintersRequest,
  ): Promise<CalibrationListPrintersResponse>;
  getCalibrationPrinterContext(
    request: CalibrationGetPrinterContextRequest,
  ): Promise<CalibrationGetPrinterContextResponse>;
  listCalibrationWorkspaceStates(
    request: CalibrationListWorkspaceStatesRequest,
  ): Promise<CalibrationListWorkspaceStatesResponse>;
  getCalibrationWorkspaceState(
    request: CalibrationGetWorkspaceStateRequest,
  ): Promise<CalibrationGetWorkspaceStateResponse>;
  saveCalibrationWorkspaceState(
    request: CalibrationSaveWorkspaceStateRequest,
  ): Promise<CalibrationSaveWorkspaceStateResponse>;
  syncCalibrationNow(
    request: CalibrationSyncNowRequest,
  ): Promise<CalibrationSyncNowResponse>;
  getCalibrationDiagnostics(
    request: CalibrationGetDiagnosticsRequest,
  ): Promise<CalibrationGetDiagnosticsResponse>;
  resolveCalibrationConflict(
    request: CalibrationResolveConflictRequest,
  ): Promise<CalibrationResolveConflictResponse>;
  listCalibrationConflicts(
    request: CalibrationListConflictsRequest,
  ): Promise<CalibrationListConflictsResponse>;
  // --- Queue reconciliation (issue #54) ------------------------------------
  pollCalibrationQueueChanges(
    request: CalibrationPollQueueChangesRequest,
  ): Promise<CalibrationPollQueueChangesResponse>;
  getCalibrationSubscriptionResources(
    request: CalibrationGetSubscriptionResourcesRequest,
  ): Promise<CalibrationGetSubscriptionResourcesResponse>;
  listOrcaProfiles(
    request: CalibrationListOrcaProfilesRequest,
  ): Promise<CalibrationListOrcaProfilesResponse>;
  exportOrcaProfile(
    request: CalibrationExportOrcaProfileRequest,
  ): Promise<CalibrationExportOrcaProfileResponse>;
  // --- Machine → process → filament profile cascade -----------------------
  listCalibrationExtendedProfiles(
    request: CalibrationListExtendedProfilesRequest,
  ): Promise<CalibrationListExtendedProfilesResponse>;
  listCalibrationMachineProfilesForModel(
    request: CalibrationListMachineProfilesForModelRequest,
  ): Promise<CalibrationListMachineProfilesForModelResponse>;
  listCalibrationProcessProfilesForMachines(
    request: CalibrationListProcessProfilesForMachinesRequest,
  ): Promise<CalibrationListProcessProfilesForMachinesResponse>;
  listCalibrationFilamentProfilesForMachines(
    request: CalibrationListFilamentProfilesForMachinesRequest,
  ): Promise<CalibrationListFilamentProfilesForMachinesResponse>;
  listCalibrationCustomProfiles(
    request: CalibrationListCustomProfilesRequest,
  ): Promise<CalibrationListCustomProfilesResponse>;
  resolveSystemProfile(
    request: CalibrationResolveSystemProfileRequest,
  ): Promise<CalibrationResolveSystemProfileResponse>;
  // --- Server-side CalibrationProject entry point (issue #798) -------------
  createCalibrationProject(
    request: CalibrationCreateProjectRequest,
  ): Promise<CalibrationCreateProjectResponse>;
  // --- Filament calibration slice pipeline (PR #1952) ---------------------
  cloneCalibrationFilamentProfile(
    request: CalibrationCloneFilamentProfileRequest,
  ): Promise<CalibrationCloneFilamentProfileResponse>;
  submitCalibrationSlice(
    request: CalibrationSubmitCalibrationSliceRequest,
  ): Promise<CalibrationSubmitCalibrationSliceResponse>;
  getCalibrationSliceJobStatus(
    request: CalibrationGetSliceJobStatusRequest,
  ): Promise<CalibrationGetSliceJobStatusResponse>;
  sendCalibrationSliceToPrinter(
    request: CalibrationSendSliceToPrinterRequest,
  ): Promise<CalibrationSendSliceToPrinterResponse>;
  updateCalibrationFilamentProfileMeasurement(
    request: CalibrationUpdateFilamentProfileMeasurementRequest,
  ): Promise<CalibrationUpdateFilamentProfileMeasurementResponse>;
  // --- Draft-profile write-back / completion promotion (issue #795) -------
  submitCalibrationObservation(
    request: CalibrationSubmitCalibrationObservationRequest,
  ): Promise<CalibrationSubmitCalibrationObservationResponse>;
  completeCalibrationProject(
    request: CalibrationCompleteCalibrationProjectRequest,
  ): Promise<CalibrationCompleteCalibrationProjectResponse>;
  saveFilamentCalibrationWizardState(
    request: CalibrationSaveFilamentWizardStateRequest,
  ): Promise<CalibrationSaveFilamentWizardStateResponse>;
  getFilamentCalibrationWizardState(
    request: CalibrationGetFilamentWizardStateRequest,
  ): Promise<CalibrationGetFilamentWizardStateResponse>;
  clearFilamentCalibrationWizardState(
    request: CalibrationClearFilamentWizardStateRequest,
  ): Promise<CalibrationClearFilamentWizardStateResponse>;
}
