import type {
  CargoSbomCoverage,
  NpmSbomCoverage,
  Sbom,
} from './supply-chain-policy.mjs';

export const NPM_AUDIT_ARGS: readonly ['audit', '--json'];

export function requireNpmSbomCoverage(
  sbom: Sbom,
  npmProductionTree: unknown,
  importedComponents: Iterable<readonly [string, string]>,
): NpmSbomCoverage;
export function requireCargoSbomCoverage(
  sbom: Sbom,
  cargoMetadata: unknown,
): CargoSbomCoverage;
