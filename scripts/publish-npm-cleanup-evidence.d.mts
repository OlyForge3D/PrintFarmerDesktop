import type { CleanupEvidence } from './npm-ci-strict.mjs';

export const CLEANUP_TRACKING_ISSUE: number;
export const CLEANUP_ARTIFACT_PREFIX: string;
export const MAXIMUM_EVIDENCE_ARTIFACT_BYTES: number;
export const MAXIMUM_EVIDENCE_ARTIFACTS: number;
export const CLEANUP_ARTIFACT_OUTPUT: string;
export const CLEANUP_ARTIFACT_IDS_OUTPUT: string;
export const CLEANUP_SOURCE_WORKFLOWS: readonly string[];
export function validateCleanupEvidence(
  evidence: unknown,
  expected?: {
    repository?: string;
    runId?: string | number;
    runAttempt?: string | number;
    headSha?: string;
    workflow?: string;
  },
): CleanupEvidence;
export function formatCleanupEvidenceComment(evidence: CleanupEvidence): string;
export function publishCleanupEvidence(input: {
  owner: string;
  repo: string;
  token: string;
  evidence: CleanupEvidence;
  issueNumber?: number;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): Promise<string>;
export function assertTrackingIssueOpen(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  token: string;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): Promise<{ number: number; state: string }>;
export function discoverCleanupEvidenceArtifacts(input: {
  owner: string;
  repo: string;
  token: string;
  runId: string | number;
  runAttempt: string | number;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): Promise<
  Array<{
    id: number;
    name: string;
    size_in_bytes: number;
    expired?: boolean;
  }>
>;
export function findCleanupEvidenceFiles(
  root: string,
  readdirImpl?: typeof import('node:fs/promises').readdir,
): Promise<string[]>;
export function markArtifactDiscovery(
  artifacts: Array<{ id: number }>,
  environment?: NodeJS.ProcessEnv,
  appendFileImpl?: typeof import('node:fs/promises').appendFile,
): Promise<void>;
