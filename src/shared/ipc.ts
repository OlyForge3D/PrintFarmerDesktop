import { z } from 'zod';

/**
 * Versioned IPC contract shared between the Electron main process and the
 * renderer. Every channel has a Zod schema so the main process can validate
 * untrusted renderer input at runtime, and the renderer gets static types.
 *
 * The renderer never receives a generic filesystem, shell, or network
 * primitive; it may only invoke the explicit channels defined here.
 */

export const IPC_CONTRACT_VERSION = 1 as const;

/** Channel names. Keep these stable; bump IPC_CONTRACT_VERSION on breaks. */
export const IpcChannel = {
  AppInfo: 'app:info',
  SidecarPing: 'sidecar:ping',
  LoadScene: 'model:loadScene',
  OpenModelFile: 'dialog:openModelFile',
  ExtractVendorMetadata: 'model:extractVendorMetadata',
  RenderThumbnail: 'model:renderThumbnail',
  ScanRoot: 'catalog:scanRoot',
  ListModels: 'catalog:listModels',
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
export const ModelFormat = z.enum(['stl', 'threeMf']);
export type ModelFormat = z.infer<typeof ModelFormat>;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const Bounds = z.object({
  min: Vec3,
  max: Vec3,
});
export type Bounds = z.infer<typeof Bounds>;

/**
 * The normalized, format-agnostic mesh the sidecar produces from an STL or 3MF
 * file. Positions and indices are flat arrays (`positions` is xyz-interleaved;
 * `indices` references vertices in triples). `faceColors`, when present, is one
 * RGB (0–255) triple per triangle.
 */
export const SceneMesh = z.object({
  positions: z.array(z.number()),
  indices: z.array(z.number().int().nonnegative()),
  bounds: Bounds,
  sourceFormat: ModelFormat,
  faceColors: z.array(z.number().int().min(0).max(255)).nullable().optional(),
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

export const ScanRootRequest = z.object({
  rootId: z.string().min(1).max(256),
  path: z.string().min(1).max(4096),
});
export type ScanRootRequest = z.infer<typeof ScanRootRequest>;

export const ScanRootResponse = ReconcileReport;
export type ScanRootResponse = z.infer<typeof ScanRootResponse>;

export const ListModelsRequest = z.void();
export type ListModelsRequest = z.infer<typeof ListModelsRequest>;

export const ListModelsResponse = z.array(LogicalModel);
export type ListModelsResponse = z.infer<typeof ListModelsResponse>;

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
  [IpcChannel.ListModels]: {
    request: ListModelsRequest,
    response: ListModelsResponse,
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
  listModels(): Promise<ListModelsResponse>;
}
