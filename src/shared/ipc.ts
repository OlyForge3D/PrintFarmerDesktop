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
  AppInfo: 'app:info',
  SidecarPing: 'sidecar:ping',
  LoadScene: 'model:loadScene',
  OpenModelFile: 'dialog:openModelFile',
  ExtractVendorMetadata: 'model:extractVendorMetadata',
  RenderThumbnail: 'model:renderThumbnail',
  ScanRoot: 'catalog:scanRoot',
  PreviewImport: 'catalog:previewImport',
  ImportRoot: 'catalog:importRoot',
  ListModels: 'catalog:listModels',
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

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

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
});
export type ScenePart = z.infer<typeof ScenePart>;

/**
 * The normalized, format-agnostic mesh the sidecar produces from an STL, 3MF, or OBJ
 * file. Positions and indices are flat arrays (`positions` is xyz-interleaved;
 * `indices` references vertices in triples). `faceColors`, when present, is one
 * RGB (0–255) triple per triangle. `parts` names selectable triangle ranges.
 */
export const SceneMesh = z.object({
  positions: z.array(z.number()),
  indices: z.array(z.number().int().nonnegative()),
  bounds: Bounds,
  sourceFormat: ModelFormat,
  faceColors: z.array(z.number().int().min(0).max(255)).nullable().optional(),
  parts: z.array(ScenePart).default([]),
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
  .object({ path: z.string().min(1) })
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
});
export type RenderThumbnailResponse = z.infer<typeof RenderThumbnailResponse>;

// --- catalog:scanRoot / catalog:listModels --------------------------------

/** A physical file backing a logical model, mirroring the sidecar's DTO. */
export const ModelLocation = z.object({
  rootId: z.string(),
  path: z.string(),
  rootRelative: z.string(),
  size: z.number().int().nonnegative(),
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
  renderThumbnail(
    request: RenderThumbnailRequest,
  ): Promise<RenderThumbnailResponse>;
  scanRoot(request: ScanRootRequest): Promise<ScanRootResponse>;
  previewImport(request: ImportPreviewRequest): Promise<ImportPreviewResponse>;
  importRoot(request: ImportRootRequest): Promise<ImportRootResponse>;
  listModels(): Promise<ListModelsResponse>;
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
}
