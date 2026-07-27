export const DEFAULT_OUTPUT: string;
export const NPM_PRODUCTION_TREE_ARGS: readonly [
  'ls',
  '--omit=dev',
  '--all',
  '--json',
];

export function resolveShippedFeatures(root?: string): string[];
export function cargoMetadataArgs(
  features: readonly string[],
  root?: string,
): string[];
export function readCargoMetadata(
  features: readonly string[],
  root?: string,
): unknown;
export function readNpmProductionTree(root?: string): unknown;
