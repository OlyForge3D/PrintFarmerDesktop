export const CACHE_SCHEMA_VERSION: number;
export const CACHE_DIR_ENV: 'SQUAD_CACHE_DIR';
export const APP_CACHE_NAMESPACE: string;
export const CACHE_SUBDIRECTORY: string;
export const DEFAULT_LOCK_TTL_MS: number;

export const STATUS_OK: 'ok';
export const STATUS_MISSING: 'missing';
export const STATUS_CORRUPT: 'corrupt';
export const STATUS_SCHEMA_MISMATCH: 'schema-mismatch';
export const STATUS_SCOPE_MISMATCH: 'scope-mismatch';

export const FRESH_ONLY_ACTIONS: readonly string[];

export type CacheStatus =
  'ok' | 'missing' | 'corrupt' | 'schema-mismatch' | 'scope-mismatch';

export interface CacheScope {
  repo?: string;
  machine?: string;
  workflow?: string;
  policyVersion?: string | null;
  root?: string;
  repoRoot?: string;
  path?: string;
  ttlMs?: number;
  now?: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  homedir?: string;
}

export interface CacheEntry {
  kind: string;
  number: number;
  fingerprint: string;
  inputs: Record<string, unknown>;
  conclusion: unknown;
}

export interface CacheDocument {
  schemaVersion: number;
  repo: string | null;
  machine: string | null;
  workflow: string | null;
  policyVersion: string | null;
  updatedAt: string | null;
  entries: Record<string, CacheEntry>;
}

export interface LoadResult {
  status: CacheStatus;
  reason: string | null;
  cache: CacheDocument;
  path: string;
}

export interface LockVerdict {
  held: boolean;
  reason: string;
  holder?: Record<string, unknown>;
}

export interface EntryVerdict {
  fresh: boolean;
  reason: string;
  changed: string[];
}

export interface ReusePlan {
  reuse: Array<{
    kind: string;
    number: number;
    conclusion: unknown;
    reason: string;
  }>;
  inspect: Array<{
    kind: string;
    number: number;
    reason: string;
    changed: string[];
  }>;
}

export function requiresFreshCheck(action: string): boolean;

export function resolveCacheRoot(options?: {
  env?: Record<string, string | undefined>;
  platform?: string;
  homedir?: string;
}): string;

export function isInsideRepository(
  candidate: string,
  repoRoot: string,
): boolean;

export function resolveCachePath(scope: CacheScope): string;

export function emptyCache(scope?: CacheScope): CacheDocument;

export function validateCacheDocument(
  document: unknown,
  scope?: CacheScope,
): { status: CacheStatus; reason: string | null };

export function loadCache(
  scope: CacheScope,
  io?: Record<string, unknown>,
): LoadResult;

export function saveCache(
  scope: CacheScope,
  cache: unknown,
  io?: Record<string, unknown>,
): { path: string; document: CacheDocument };

export function evaluateLock(
  record: unknown,
  options?: { now?: number; ttlMs?: number },
): LockVerdict;

export function lockPathFor(cachePath: string): string;

export function acquireCacheLock(
  scope: CacheScope,
  io?: Record<string, unknown>,
): {
  acquired: boolean;
  path: string;
  holder?: Record<string, unknown>;
  reason?: string;
};

export function releaseCacheLock(
  scope: CacheScope,
  io?: Record<string, unknown>,
): { path: string };

export function fingerprintInputs(
  observation?: Record<string, unknown>,
): Record<string, unknown>;

export function fingerprint(observation: Record<string, unknown>): string;

export function changedInputs(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): string[];

export function evaluateEntry(
  entry: CacheEntry | null | undefined,
  observation: Record<string, unknown>,
): EntryVerdict;

export function cacheKey(kind: string, number: number): string;

export function putEntry(
  cache: CacheDocument,
  kind: string,
  number: number,
  observation: Record<string, unknown>,
  conclusion: unknown,
): CacheDocument;

export function getEntry(
  cache: CacheDocument | null | undefined,
  kind: string,
  number: number,
): CacheEntry | null;

export function planReuse(options: {
  cache: CacheDocument;
  observations: Array<Record<string, unknown>>;
  slotBlocking?: readonly number[];
}): ReusePlan;

export function formatStatus(result: LoadResult): string;
