import type { DetectorFinding } from './design-detector.mjs';

export interface HookLimits {
  maxFindings: number;
  maxChars: number;
}

export interface HookSettings {
  enabled: boolean;
  limits: HookLimits;
}

export interface HookPayload {
  readonly cwd?: string;
  readonly toolName?: string;
  readonly toolArgs?: unknown;
}

export function extractEditedPaths(
  toolName: unknown,
  toolArgs: unknown,
): string[];
export function readHookSettings(
  root: string,
  env?: Readonly<Record<string, string | undefined>>,
): HookSettings;
export function toRepoRelative(
  root: string,
  filePath: string,
  cwd?: string,
): string | null;
export function formatContext(
  findings: readonly DetectorFinding[],
  root: string,
  limits: HookLimits,
): string;
export function handlePayload(
  payload: HookPayload | null | undefined,
  deps?: {
    env?: Readonly<Record<string, string | undefined>>;
    detect?: (root: string, files: readonly string[]) => DetectorFinding[];
  },
): { additionalContext: string } | null;
