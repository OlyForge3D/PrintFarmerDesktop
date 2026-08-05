export const SHA_PATTERN: RegExp;

export const EXIT_INTACT: 0;
export const EXIT_DIVERGENT: 1;
export const EXIT_INDETERMINATE: 2;

export interface MergeSurvivalFacts {
  headKnown: boolean;
  mergeKnown: boolean;
  /** The base side of the merge or squash. `null` when it could not be read. */
  parent: string | null;
  base: string | null;
  /** `null` means the diff could not be read, which is not the same as "empty". */
  branchEmpty: boolean | null;
  mergeEmpty: boolean | null;
  branchPatchId: string | null;
  mergePatchId: string | null;
}

export type MergeSurvivalVerdict = 'INTACT' | 'DIVERGENT' | 'INDETERMINATE';

export interface MergeSurvivalResult {
  verdict: MergeSurvivalVerdict;
  code: 0 | 1 | 2;
  reason: string;
}

export function commitExists(sha: string, cwd?: string): boolean;
/** `null` for an unreadable diff AND for an empty one; pair with `diffIsEmpty`. */
export function patchIdOf(
  from: string,
  to: string,
  cwd?: string,
): string | null;
export function diffIsEmpty(
  from: string,
  to: string,
  cwd?: string,
): boolean | null;
export function firstParent(sha: string, cwd?: string): string | null;
export function mergeBase(a: string, b: string, cwd?: string): string | null;
export function classify(facts: MergeSurvivalFacts): MergeSurvivalResult;
export function evaluateMergeSurvival(
  head: string,
  merge: string,
  cwd?: string,
): MergeSurvivalResult & { facts: MergeSurvivalFacts };
/** `null` when both control arms behaved; otherwise the one that did not. */
export function runComparatorControls(
  base: string,
  head: string,
  cwd?: string,
): string | null;
export function parseArgs(argv: string[]): { head: string; merge: string };
export function main(argv?: string[]): number;
export function controlsFrom(
  forward: string | null,
  again: string | null,
  inverse: string | null,
): string | null;
