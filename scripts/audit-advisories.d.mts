import type { CargoSbomCoverage, Sbom } from './supply-chain-policy.mjs';

export const NPM_AUDIT_ARGS: readonly ['audit', '--json'];

export function requireCargoSbomCoverage(
  sbom: Sbom,
  cargoMetadata: unknown,
): CargoSbomCoverage;
