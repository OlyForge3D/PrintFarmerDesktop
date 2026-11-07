export declare const DESIGN_REVIEWER: 'lambert';
export declare const DESIGN_SURFACE_EXTENSIONS: readonly string[];

export function normalizeRepoPath(filePath: unknown): string;
/** Renderer markup/style files the vendored detector scans. */
export function isDesignSurfacePath(filePath: unknown): boolean;
/** Files that define or measure design without being UI themselves. */
export function isDesignGovernancePath(filePath: unknown): boolean;
export function designSurfacePaths(
  paths: readonly string[] | null | undefined,
): string[];
export function requiresDesignReview(
  paths: readonly string[] | null | undefined,
): boolean;
