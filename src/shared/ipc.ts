import { z } from 'zod';

/**
 * Versioned IPC contract shared between the Electron main process and the
 * renderer. Every channel has a Zod schema so the main process can validate
 * untrusted renderer input at runtime, and the renderer gets static types.
 *
 * The renderer never receives a generic filesystem, shell, or network
 * primitive; it may only invoke the explicit channels defined here.
 */

export const IPC_CONTRACT_VERSION = 2 as const;

/** Channel names. Keep these stable; bump IPC_CONTRACT_VERSION on breaks. */
export const IpcChannel = {
  // --- Printer Calibration transport (issue #52) ---------------------------
  CalibrationGetAvailability: 'calibration:getAvailability',
  CalibrationListPrinters: 'calibration:listPrinters',
  CalibrationGetPrinterContext: 'calibration:getPrinterContext',
  CalibrationListWorkspaceStates: 'calibration:listWorkspaceStates',
  CalibrationGetWorkspaceState: 'calibration:getWorkspaceState',
  CalibrationSaveWorkspaceState: 'calibration:saveWorkspaceState',
  CalibrationListProjects: 'calibration:listProjects',
  CalibrationGetProject: 'calibration:getProject',
  CalibrationSaveDraft: 'calibration:saveDraft',
  CalibrationListAttempts: 'calibration:listAttempts',
  CalibrationGetAttempt: 'calibration:getAttempt',
  OpenCalibrationPhoto: 'calibration:openPhoto',
  CalibrationStagePhoto: 'calibration:stagePhoto',
  CalibrationListConflicts: 'calibration:listConflicts',
  CalibrationResolveConflict: 'calibration:resolveConflict',
  CalibrationSyncNow: 'calibration:syncNow',
  CalibrationStartGeneration: 'calibration:startGeneration',
  CalibrationGetQueueState: 'calibration:getQueueState',
  CalibrationAcknowledgeBedClear: 'calibration:acknowledgeBedClear',
  CalibrationStartPrint: 'calibration:startPrint',
  CalibrationListOrcaProfiles: 'calibration:listOrcaProfiles',
  CalibrationExportOrcaProfile: 'calibration:exportOrcaProfile',
  CalibrationImportLegacyBackupV4: 'calibration:importLegacyBackupV4',
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

// --- calibration:openPhoto -------------------------------------------------

export const OpenCalibrationPhotoRequest = z.void();
export type OpenCalibrationPhotoRequest = z.infer<
  typeof OpenCalibrationPhotoRequest
>;
export const OpenCalibrationPhotoResponse = z
  .object({ approvalId: z.string().uuid() })
  .strict()
  .nullable();
export type OpenCalibrationPhotoResponse = z.infer<
  typeof OpenCalibrationPhotoResponse
>;

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
 * Negotiated end-to-end capability flags that must ALL be present for the
 * Printer Calibration feature to be available. If any are false/missing the
 * feature gate returns a typed unavailable reason.
 */
export const CalibrationCapabilityFlags = z
  .object({
    /** Server exposes calibration REST APIs. */
    calibrationApiEnabled: z.boolean(),
    /** Server emits calibration change-feed events. */
    calibrationChangeFeedEnabled: z.boolean(),
    /** Server accepts offline draft push via calibration sync. */
    calibrationOfflineDraftEnabled: z.boolean(),
    /** Server can accept staged photo uploads for calibration. */
    calibrationPhotoUploadEnabled: z.boolean(),
    /** Server supports generation and G-code promotion. */
    calibrationGenerationEnabled: z.boolean(),
  })
  .passthrough();
export type CalibrationCapabilityFlags = z.infer<
  typeof CalibrationCapabilityFlags
>;

/** Required JWT permission scopes for calibration operations. */
export const CalibrationRequiredScopes = z.enum([
  'CalibrationRead',
  'CalibrationWrite',
  'CalibrationGenerate',
]);
export type CalibrationRequiredScopes = z.infer<
  typeof CalibrationRequiredScopes
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
    /** Negotiated schema version for the calibration change feed. */
    negotiatedSchemaVersion: z.number().int().nonnegative().nullable(),
    /** The effective capability flags discovered during negotiation. */
    capabilityFlags: CalibrationCapabilityFlags.nullable(),
    /** The JWT scopes present in the current token (never the token itself). */
    grantedScopes: z.array(z.string().max(64)).max(32).nullable(),
    /** Whether offline drafts and photo staging are currently enabled. */
    offlineEditingEnabled: z.boolean(),
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
export const CalibrationPrinterCandidate = z
  .object({
    /** Server-assigned stable printer ID. */
    printerId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(256),
    /** Printer model/make string for display. */
    printerModel: z.string().max(256).nullable(),
    /** Whether the printer meets the Klipper firmware/dialect requirement. */
    firmwareCompatible: z.boolean(),
    /** OrcaSlicer profile identity associated with this printer. */
    orcaProfileId: z.string().max(512).nullable(),
    /** Whether PrintFarmer considers this printer currently online. */
    isOnline: z.boolean(),
    updatedAt: z.string().datetime(),
    eligibility: CalibrationPrinterEligibility.nullable()
      .optional()
      .default(null),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.firmwareCompatible !== (candidate.eligibility !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['firmwareCompatible'],
        message:
          'Firmware compatibility must be backed by complete explicit eligibility.',
      });
    }
  });
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
    printers: z.array(CalibrationPrinterCandidate).max(200),
    fetchedAt: z.string().datetime(),
  })
  .strict();
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
  })
  .strict();
export type CalibrationPrinterContext = z.infer<
  typeof CalibrationPrinterContext
>;

export const CalibrationGetPrinterContextRequest = z
  .object({
    profileId: z.string().uuid(),
    printerId: z.string().min(1).max(256),
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
    displayName: z.string().min(1).max(512),
    source: z.literal('printFarmer'),
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

export const CalibrationListProjectsRequest = z
  .object({ profileId: z.string().uuid() })
  .strict();
export type CalibrationListProjectsRequest = z.infer<
  typeof CalibrationListProjectsRequest
>;
export const CalibrationListProjectsResponse = z
  .object({ projects: z.array(CalibrationProjectSummary).max(500) })
  .strict();
export type CalibrationListProjectsResponse = z.infer<
  typeof CalibrationListProjectsResponse
>;

export const CalibrationGetProjectRequest = z
  .object({ profileId: z.string().uuid(), projectId: z.string().uuid() })
  .strict();
export type CalibrationGetProjectRequest = z.infer<
  typeof CalibrationGetProjectRequest
>;
export const CalibrationGetProjectResponse = CalibrationProject;
export type CalibrationGetProjectResponse = z.infer<
  typeof CalibrationGetProjectResponse
>;

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

export const CalibrationSaveDraftRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    fields: CalibrationDraftFields,
    /** Client-generated idempotency key for this draft save operation. */
    operationId: z.string().uuid(),
  })
  .strict();
export type CalibrationSaveDraftRequest = z.infer<
  typeof CalibrationSaveDraftRequest
>;
export const CalibrationSaveDraftResponse = z
  .object({
    /** Updated project aggregate. */
    project: CalibrationProject,
    /** Whether the operation was queued in the outbox (offline). */
    queued: z.boolean(),
  })
  .strict();
export type CalibrationSaveDraftResponse = z.infer<
  typeof CalibrationSaveDraftResponse
>;

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

export const CalibrationListAttemptsRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    stepId: z.string().uuid(),
  })
  .strict();
export type CalibrationListAttemptsRequest = z.infer<
  typeof CalibrationListAttemptsRequest
>;
export const CalibrationListAttemptsResponse = z
  .object({
    attempts: z.array(CalibrationAttempt).max(999),
  })
  .strict();
export type CalibrationListAttemptsResponse = z.infer<
  typeof CalibrationListAttemptsResponse
>;

export const CalibrationGetAttemptRequest = z
  .object({
    profileId: z.string().uuid(),
    attemptId: z.string().uuid(),
  })
  .strict();
export type CalibrationGetAttemptRequest = z.infer<
  typeof CalibrationGetAttemptRequest
>;
export const CalibrationGetAttemptResponse = CalibrationAttempt;
export type CalibrationGetAttemptResponse = z.infer<
  typeof CalibrationGetAttemptResponse
>;

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

export const CalibrationListConflictsRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    /** If true, include already-resolved conflicts. */
    includeResolved: z.boolean().default(false),
  })
  .strict();
export type CalibrationListConflictsRequest = z.infer<
  typeof CalibrationListConflictsRequest
>;
export const CalibrationListConflictsResponse = z
  .object({ conflicts: z.array(CalibrationConflict).max(1000) })
  .strict();
export type CalibrationListConflictsResponse = z.infer<
  typeof CalibrationListConflictsResponse
>;

export const CalibrationResolveConflictRequest = z
  .object({
    profileId: z.string().uuid(),
    conflictId: z.string().uuid(),
    resolution: CalibrationConflictResolution,
    /**
     * For manualFieldMerge: the merged field values (plain text, no credentials).
     * Only accepted for metadata/draft conflict kinds.
     */
    mergedFields: z
      .record(z.string().max(4096))
      .optional()
      .refine((fields) => !fields || Object.keys(fields).length <= 20),
  })
  .strict();
export type CalibrationResolveConflictRequest = z.infer<
  typeof CalibrationResolveConflictRequest
>;
export const CalibrationResolveConflictResponse = z
  .object({ conflict: CalibrationConflict })
  .strict();
export type CalibrationResolveConflictResponse = z.infer<
  typeof CalibrationResolveConflictResponse
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
]);
export type CalibrationApiErrorCode = z.infer<typeof CalibrationApiErrorCode>;

export const CalibrationApiError = z
  .object({
    code: CalibrationApiErrorCode,
    message: z.string().max(512),
    /** Whether the operation may be retried. */
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().nonnegative().max(86_400).nullable(),
  })
  .strict();
export type CalibrationApiError = z.infer<typeof CalibrationApiError>;

/** Request to trigger profile generation for a completed calibration project. */
export const CalibrationStartGenerationRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    /** Client-generated idempotency key for this generation request. */
    operationId: z.string().uuid(),
    /** The base revision of the project at generation time (for If-Match). */
    baseRevision: z.number().int().nonnegative(),
  })
  .strict();
export type CalibrationStartGenerationRequest = z.infer<
  typeof CalibrationStartGenerationRequest
>;
export const CalibrationStartGenerationResponse = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('submitted'),
        generationJobId: z.string().uuid(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationStartGenerationResponse = z.infer<
  typeof CalibrationStartGenerationResponse
>;

export const CalibrationQueueState = z
  .object({
    profileId: z.string().uuid(),
    printerId: z.string().min(1).max(256),
    /** Whether a print job for this calibration is currently queued. */
    jobQueued: z.boolean(),
    jobId: z.string().uuid().nullable(),
    /** Whether a bed-clear acknowledgement is needed before print. */
    awaitingBedClear: z.boolean(),
    /** Whether print start is allowed (sync complete + printer fresh). */
    printStartAllowed: z.boolean(),
    /** If not allowed, the typed reason. */
    printStartBlockedReason: z.string().max(256).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CalibrationQueueState = z.infer<typeof CalibrationQueueState>;

export const CalibrationGetQueueStateRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
  })
  .strict();
export type CalibrationGetQueueStateRequest = z.infer<
  typeof CalibrationGetQueueStateRequest
>;
export const CalibrationGetQueueStateResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), queue: CalibrationQueueState }).strict(),
  z.object({ status: z.literal('error'), error: CalibrationApiError }).strict(),
]);
export type CalibrationGetQueueStateResponse = z.infer<
  typeof CalibrationGetQueueStateResponse
>;

/** Acknowledge that the bed has been cleared before starting an exact calibration job. */
export const CalibrationAcknowledgeBedClearRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    jobId: z.string().uuid(),
    operationId: z.string().uuid(),
  })
  .strict();
export type CalibrationAcknowledgeBedClearRequest = z.infer<
  typeof CalibrationAcknowledgeBedClearRequest
>;
export const CalibrationAcknowledgeBedClearResponse = z.discriminatedUnion(
  'status',
  [
    z.object({ status: z.literal('ok') }).strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationAcknowledgeBedClearResponse = z.infer<
  typeof CalibrationAcknowledgeBedClearResponse
>;

/** Start an exact calibration print job. Disabled until sync complete + printer fresh. */
export const CalibrationStartPrintRequest = z
  .object({
    profileId: z.string().uuid(),
    projectId: z.string().uuid(),
    jobId: z.string().uuid(),
    operationId: z.string().uuid(),
    /** The base revision of the queue state (If-Match). */
    baseRevision: z.number().int().nonnegative(),
  })
  .strict();
export type CalibrationStartPrintRequest = z.infer<
  typeof CalibrationStartPrintRequest
>;
export const CalibrationStartPrintResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), jobId: z.string().uuid() }).strict(),
  z.object({ status: z.literal('error'), error: CalibrationApiError }).strict(),
]);
export type CalibrationStartPrintResponse = z.infer<
  typeof CalibrationStartPrintResponse
>;

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

export const CalibrationListOrcaProfilesRequest = z
  .object({ profileId: z.string().uuid() })
  .strict();
export type CalibrationListOrcaProfilesRequest = z.infer<
  typeof CalibrationListOrcaProfilesRequest
>;
export const CalibrationListOrcaProfilesResponse = z
  .object({ profiles: z.array(OrcaProfileEntry).max(5000) })
  .strict();
export type CalibrationListOrcaProfilesResponse = z.infer<
  typeof CalibrationListOrcaProfilesResponse
>;

/**
 * Export a local OrcaSlicer profile for use in a calibration project.
 * The renderer may not specify a filesystem path; main resolves based on
 * the stable orcaProfileId only.
 */
export const CalibrationExportOrcaProfileRequest = z
  .object({
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
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
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
 * Import request for a legacy calibration backup v4 file.
 * The file is identified by an approvalId from an open-file dialog;
 * the renderer cannot supply an arbitrary path.
 */
export const CalibrationImportLegacyBackupV4Request = z
  .object({
    profileId: z.string().uuid(),
    /** Approval from dialog:openModelFile (reuses the existing allowlisted channel). */
    approvalId: z.string().uuid(),
    operationId: z.string().uuid(),
  })
  .strict();
export type CalibrationImportLegacyBackupV4Request = z.infer<
  typeof CalibrationImportLegacyBackupV4Request
>;
export const CalibrationImportLegacyBackupV4Response = z.discriminatedUnion(
  'status',
  [
    z
      .object({
        status: z.literal('ok'),
        summary: LegacyCalibrationBackupSummary,
        importedProjectCount: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({ status: z.literal('error'), error: CalibrationApiError })
      .strict(),
  ],
);
export type CalibrationImportLegacyBackupV4Response = z.infer<
  typeof CalibrationImportLegacyBackupV4Response
>;

// ==========================================================================
// End of Printer Calibration transport additions
// ==========================================================================

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
const RetargetErrorCode = z.enum([
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
  [IpcChannel.OpenCalibrationPhoto]: {
    request: OpenCalibrationPhotoRequest,
    response: OpenCalibrationPhotoResponse,
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
  [IpcChannel.CalibrationListProjects]: {
    request: CalibrationListProjectsRequest,
    response: CalibrationListProjectsResponse,
  },
  [IpcChannel.CalibrationGetProject]: {
    request: CalibrationGetProjectRequest,
    response: CalibrationGetProjectResponse,
  },
  [IpcChannel.CalibrationSaveDraft]: {
    request: CalibrationSaveDraftRequest,
    response: CalibrationSaveDraftResponse,
  },
  [IpcChannel.CalibrationListAttempts]: {
    request: CalibrationListAttemptsRequest,
    response: CalibrationListAttemptsResponse,
  },
  [IpcChannel.CalibrationGetAttempt]: {
    request: CalibrationGetAttemptRequest,
    response: CalibrationGetAttemptResponse,
  },
  [IpcChannel.CalibrationStagePhoto]: {
    request: CalibrationStagePhotoRequest,
    response: CalibrationStagePhotoResponse,
  },
  [IpcChannel.CalibrationListConflicts]: {
    request: CalibrationListConflictsRequest,
    response: CalibrationListConflictsResponse,
  },
  [IpcChannel.CalibrationResolveConflict]: {
    request: CalibrationResolveConflictRequest,
    response: CalibrationResolveConflictResponse,
  },
  [IpcChannel.CalibrationSyncNow]: {
    request: CalibrationSyncNowRequest,
    response: CalibrationSyncNowResponse,
  },
  [IpcChannel.CalibrationStartGeneration]: {
    request: CalibrationStartGenerationRequest,
    response: CalibrationStartGenerationResponse,
  },
  [IpcChannel.CalibrationGetQueueState]: {
    request: CalibrationGetQueueStateRequest,
    response: CalibrationGetQueueStateResponse,
  },
  [IpcChannel.CalibrationAcknowledgeBedClear]: {
    request: CalibrationAcknowledgeBedClearRequest,
    response: CalibrationAcknowledgeBedClearResponse,
  },
  [IpcChannel.CalibrationStartPrint]: {
    request: CalibrationStartPrintRequest,
    response: CalibrationStartPrintResponse,
  },
  [IpcChannel.CalibrationListOrcaProfiles]: {
    request: CalibrationListOrcaProfilesRequest,
    response: CalibrationListOrcaProfilesResponse,
  },
  [IpcChannel.CalibrationExportOrcaProfile]: {
    request: CalibrationExportOrcaProfileRequest,
    response: CalibrationExportOrcaProfileResponse,
  },
  [IpcChannel.CalibrationImportLegacyBackupV4]: {
    request: CalibrationImportLegacyBackupV4Request,
    response: CalibrationImportLegacyBackupV4Response,
  },
} as const;

export type IpcSchemas = typeof ipcSchemas;

/** Typed surface exposed on `window.printFarmer` by the preload bridge. */
export interface PrintFarmerApi {
  getAppInfo(): Promise<AppInfoResponse>;
  pingSidecar(request: SidecarPingRequest): Promise<SidecarPingResponse>;
  loadScene(request: LoadSceneRequest): Promise<LoadSceneResponse>;
  openModelFile(): Promise<OpenModelFileResponse>;
  openCalibrationPhoto(): Promise<OpenCalibrationPhotoResponse>;
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
  listCalibrationProjects(
    request: CalibrationListProjectsRequest,
  ): Promise<CalibrationListProjectsResponse>;
  getCalibrationProject(
    request: CalibrationGetProjectRequest,
  ): Promise<CalibrationGetProjectResponse>;
  saveCalibrationDraft(
    request: CalibrationSaveDraftRequest,
  ): Promise<CalibrationSaveDraftResponse>;
  listCalibrationAttempts(
    request: CalibrationListAttemptsRequest,
  ): Promise<CalibrationListAttemptsResponse>;
  getCalibrationAttempt(
    request: CalibrationGetAttemptRequest,
  ): Promise<CalibrationGetAttemptResponse>;
  stageCalibrationPhoto(
    request: CalibrationStagePhotoRequest,
  ): Promise<CalibrationStagePhotoResponse>;
  listCalibrationConflicts(
    request: CalibrationListConflictsRequest,
  ): Promise<CalibrationListConflictsResponse>;
  resolveCalibrationConflict(
    request: CalibrationResolveConflictRequest,
  ): Promise<CalibrationResolveConflictResponse>;
  syncCalibrationNow(
    request: CalibrationSyncNowRequest,
  ): Promise<CalibrationSyncNowResponse>;
  startCalibrationGeneration(
    request: CalibrationStartGenerationRequest,
  ): Promise<CalibrationStartGenerationResponse>;
  getCalibrationQueueState(
    request: CalibrationGetQueueStateRequest,
  ): Promise<CalibrationGetQueueStateResponse>;
  acknowledgeCalibrationBedClear(
    request: CalibrationAcknowledgeBedClearRequest,
  ): Promise<CalibrationAcknowledgeBedClearResponse>;
  startCalibrationPrint(
    request: CalibrationStartPrintRequest,
  ): Promise<CalibrationStartPrintResponse>;
  listOrcaProfiles(
    request: CalibrationListOrcaProfilesRequest,
  ): Promise<CalibrationListOrcaProfilesResponse>;
  exportOrcaProfile(
    request: CalibrationExportOrcaProfileRequest,
  ): Promise<CalibrationExportOrcaProfileResponse>;
  importLegacyCalibrationBackupV4(
    request: CalibrationImportLegacyBackupV4Request,
  ): Promise<CalibrationImportLegacyBackupV4Response>;
}
