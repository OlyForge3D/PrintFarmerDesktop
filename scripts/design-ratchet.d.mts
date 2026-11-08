import type { DetectorFinding } from './design-detector.mjs';

export interface RatchetCounts {
  allowed: number;
  total: number;
  blocking: number;
  advisory: number;
  passed: boolean;
}

export function compareCounts(
  allowance: number,
  findings: readonly DetectorFinding[],
): RatchetCounts;
export function scanRatchet(
  repo: string,
  base: string,
  head: string,
  toolRoot: string,
): RatchetCounts & {
  base: string;
  head: string;
  inspectedCommit: string;
  selected: number;
};
export function main(argv?: string[]): number;
