export declare const CACHE_SCHEMA: 1;
export declare const INVALIDATING_FIELDS: string[];
export interface RalphItem {
  kind: string;
  number: number;
  fingerprint?: string;
  state?: string;
  updatedAt?: string;
  [field: string]: unknown;
}
export interface RalphSnapshot {
  schema: 1;
  observedAt: string;
  items: RalphItem[];
}
export declare function defaultCacheDirectory(
  env?: NodeJS.ProcessEnv,
  os?: string,
): string;
export declare function cachePath(
  repo: string,
  env?: NodeJS.ProcessEnv,
  os?: string,
): string;
export declare function validateSnapshot(
  snapshot: RalphSnapshot,
): RalphSnapshot;
export declare function readSnapshot(file: string): RalphSnapshot | undefined;
export declare function atomicWriteSnapshot(
  file: string,
  snapshot: RalphSnapshot,
): void;
export declare function acquireLock(file: string): () => void;
export declare function fingerprint(item: RalphItem): string;
export declare function canonicalValue(value: unknown): unknown;
export declare function snapshot(
  items: RalphItem[],
  observedAt?: string,
): RalphSnapshot;
export declare function diffSnapshots(
  previous: RalphSnapshot | undefined,
  current: RalphSnapshot,
): Array<{
  kind: string;
  number: number;
  action: 'inspect' | 'reuse';
  reason: string;
}>;
export declare function paginate<T>(
  fetchPage: (page: number) => Promise<{ items: T[]; hasNext: boolean }>,
): Promise<T[]>;
export declare function compactPlan(
  items: RalphItem[],
  previous?: RalphSnapshot,
): {
  schema: 1;
  observedAt: string;
  plan: ReturnType<typeof diffSnapshots>;
  snapshot: RalphSnapshot;
};
export declare function parseArgs(argv: string[]): {
  repo: string;
  input: string;
  json: boolean;
};
export declare function main(argv?: string[], env?: NodeJS.ProcessEnv): void;
