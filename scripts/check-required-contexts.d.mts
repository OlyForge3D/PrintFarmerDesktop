/**
 * What this script actually needs from a spawner. Declaring `typeof spawnSync`
 * would overstate the dependency and force every test stub to fabricate `pid`,
 * `output` and `signal` — fields the code never reads. A stub that has to lie
 * about five fields to satisfy a signature is a signature that is wrong.
 */
export type GhSpawn = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8'; env: NodeJS.ProcessEnv },
) => {
  status?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error | undefined;
};

export const EXIT_READY: 0;
export const EXIT_NOT_GREEN: 1;
export const EXIT_UNDETERMINED: 2;
export const EXIT_ABSENT: 3;
export const STATE_SUCCESS: 'SUCCESS';

export interface RollupRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  completedAt?: string | null;
  startedAt?: string | null;
}

export interface RequiredContextsResult {
  absent: string[];
  notGreen: { name: string; state: string }[];
  pending: string[];
  green: string[];
  extra: number;
  exitCode: number;
}

export interface GhResult {
  spawned: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export function latestRunNamed(
  runs: readonly RollupRun[] | undefined,
  name: string,
): RollupRun | null;

export function evaluateRequiredContexts(
  required: readonly string[] | undefined,
  runs: readonly RollupRun[] | undefined,
): RequiredContextsResult;

export function formatResult(
  pr: number,
  result: RequiredContextsResult,
  required: readonly string[],
): string;

export function parseArgs(argv: readonly string[]): {
  pr?: number;
  help?: boolean;
  error?: string;
};

export function resolveRepositorySlug(
  env: NodeJS.ProcessEnv,
  run?: GhSpawn,
): string | null;

export function runGh(
  run: GhSpawn,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): GhResult;

export function main(
  argv: readonly string[],
  env?: NodeJS.ProcessEnv,
  run?: GhSpawn,
): number;
