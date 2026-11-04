import type { spawnSync } from 'node:child_process';

export interface DylibSlice {
  arch: string | null;
  dylibs: string[];
}

export const ALLOWED_DYLIB_PREFIXES: readonly string[];
export function parseOtoolDylibs(output: string): DylibSlice[];
export function findDisallowedDylibs(slices: readonly DylibSlice[]): string[];
export function checkSidecarDylibs(
  binaryPath: string,
  options?: { run?: typeof spawnSync },
): string[];
