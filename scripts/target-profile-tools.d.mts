export interface TargetPrinter {
  vendor: string;
  model: string;
  preset: string;
  variant: string;
}

export interface ParsedPreset {
  value: Record<string, unknown>;
  type: 'filament' | 'machine' | 'machine_model' | 'process';
  name: string;
}

export interface SnapshotEntry {
  upstreamPath: string;
  bytes: Uint8Array;
  preset: ParsedPreset;
}

export interface Snapshot {
  ref: string;
  retrievedAt: string;
  entries: SnapshotEntry[];
  roots: string[];
}

export const BUNDLE_ID: string;
export const BUNDLE_SCHEMA_VERSION: number;
export const UPSTREAM_REPOSITORY: string;
export const TARGET_PRINTER: Readonly<TargetPrinter>;
export const APPROVED_UPSTREAM_PATHS: readonly string[];

export function assertExactCommitRef(ref: string): string;
export function assertRetrievalDate(retrievedAt: string): string;
export function assertSafeRelativePath(value: string, label?: string): string;
export function sha256(bytes: Uint8Array): string;
export function parsePreset(
  bytes: Uint8Array,
  sourcePath: string,
): ParsedPreset;
export function validatePresetClosure(
  entries: SnapshotEntry[],
  target?: TargetPrinter,
): string[];
export function downloadApprovedSnapshot(options: {
  ref: string;
  retrievedAt: string;
  approvedPaths?: readonly string[];
  fetchImpl?: typeof fetch;
  target?: TargetPrinter;
}): Promise<Omit<Snapshot, 'ref' | 'retrievedAt'>>;
export function createManifest(snapshot: Snapshot): Record<string, unknown>;
export function validateManifest(value: unknown): Record<string, unknown>;
export function verifyBundleDirectory(
  bundleDirectory: string,
  approvedPaths?: readonly string[],
): Promise<Record<string, unknown>>;
export function writeSnapshotBundle(
  bundleDirectory: string,
  snapshot: Snapshot,
): Promise<Record<string, unknown>>;
