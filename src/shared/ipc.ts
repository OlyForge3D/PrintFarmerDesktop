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
} as const;

export type IpcSchemas = typeof ipcSchemas;

/** Typed surface exposed on `window.printFarmer` by the preload bridge. */
export interface PrintFarmerApi {
  getAppInfo(): Promise<AppInfoResponse>;
  pingSidecar(request: SidecarPingRequest): Promise<SidecarPingResponse>;
  loadScene(request: LoadSceneRequest): Promise<LoadSceneResponse>;
  openModelFile(): Promise<OpenModelFileResponse>;
}
