import type { CargoSbomCoverage, Sbom } from './supply-chain-policy.mjs';

export function requireCargoSbomCoverage(
  sbom: Sbom,
  cargoMetadata: unknown,
): CargoSbomCoverage;
