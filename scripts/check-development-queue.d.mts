import type { QueuePolicy } from './merge-queue-policy.mjs';
export type QueueApi = (
  endpoint: string,
  fields?: Record<string, string>,
) => unknown;
export type QueueRunner = (
  command: string,
  args: string[],
  options: { encoding: 'utf8'; env: NodeJS.ProcessEnv },
) => { status: number | null; stdout: string; stderr: string; error?: Error };
export interface QueuePull {
  id: string;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  baseSha: string;
  mergeable: string;
  labels: { name: string }[];
  reviewThreads: {
    nodes: { isResolved: boolean }[];
    pageInfo: { hasNextPage: boolean };
  };
  mergeQueueEntry: {
    id: string;
    state: string;
    position: number;
    baseCommit: { oid: string } | null;
    headCommit: { oid: string } | null;
  } | null;
}
export interface QueueGroup {
  base_ref: string;
  base_sha: string;
  head_sha: string;
  head_ref?: string;
}
export interface QueueRun {
  id: number;
  name: string;
  head_sha: string;
  app: { id: number };
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
}
export declare function createQueueApi(
  env?: NodeJS.ProcessEnv,
  run?: QueueRunner,
): QueueApi;
export declare function readQueuePolicy(api: QueueApi): QueuePolicy;
export declare function readQueuePull(api: QueueApi, number: number): QueuePull;
export declare function assertQueuePull(pull: QueuePull, head: string): void;
export declare function assertGroupBinding(
  pull: QueuePull,
  group: QueueGroup,
): void;
export declare function checkQueueRuns(
  checks: QueuePolicy['checks'],
  runs: QueueRun[],
  sha: string,
): void;
export declare function checkDevelopmentQueue(
  args: { number: number; head: string; enqueue?: boolean },
  api: QueueApi,
  verify?: (number: number, head: string) => void,
): string;
export declare function verifyQueueEvent(
  event: { merge_group: QueueGroup },
  api: QueueApi,
  verify: (number: number, head: string) => void,
): string;
export declare function main(
  argv: string[],
  env?: NodeJS.ProcessEnv,
  run?: QueueRunner,
): number;
