export const EXIT_UP_TO_DATE: 0;
export const EXIT_BEHIND: 1;
export const EXIT_UNDETERMINED: 2;

export interface BehindBaseResult {
  state: 'up-to-date' | 'behind' | 'undetermined';
  exitCode: number;
}

export function evaluateBehindBase(facts: {
  baseIsAncestorOfHead: boolean | null | undefined;
}): BehindBaseResult;

export function formatResult(
  prNumber: number,
  baseRefName: string,
  result: BehindBaseResult,
): string;

export function parseArgs(argv: readonly string[]): {
  pr?: number;
  base?: string;
  remote?: string;
  help?: boolean;
  error?: string;
};

export function main(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  run?: (...args: unknown[]) => unknown,
): number;
