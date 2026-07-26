export interface NpmComponent {
  name: string;
  version: string;
  license?: string;
  path: string;
  /** True for Rollup externals, which the host runtime supplies rather than npm. */
  runtimeProvided?: boolean;
}

export interface ShippedNpmComponents {
  declared: string[];
  externals: string[];
  components: Map<string, NpmComponent>;
}

export interface CargoComponent {
  name: string;
  version: string;
  license?: string;
  source: string | null;
  /** The native library this crate links, from cargo's `links` metadata. */
  links: string | null;
  procMacro: boolean;
}

export interface ShippedCargoComponents {
  root: string | null;
  components: Map<string, CargoComponent>;
  nativeLibraries: CargoComponent[];
  nonRegistrySources: CargoComponent[];
}

export interface NpmReconciliation {
  fromLock: Set<string>;
  fromLs: Set<string>;
  missingFromLs: string[];
  missingFromLock: string[];
}

export interface ShippedCargoFeatures {
  fromStagingScript: string[] | null;
  fromReleaseWorkflow: string[] | null;
}

export function packageNameFromSpecifier(specifier: string): string | null;
export function scanBareImports(directory: string): Map<string, string[]>;
export function readRollupExternals(repoRoot: string): Set<string>;
export function readViteAliases(repoRoot: string): Set<string>;
export function isAliasedSpecifier(
  specifier: string,
  aliases: Iterable<string>,
): boolean;
export function collectNpmClosure(
  lock: unknown,
  roots: Iterable<string>,
): Map<string, NpmComponent>;
export function deriveShippedNpmComponents(
  lock: unknown,
  repoRoot: string,
): ShippedNpmComponents;
export function reconcileNpmProduction(
  lock: unknown,
  npmLsTree: unknown,
): NpmReconciliation;
export function readShippedCargoFeatures(
  repoRoot: string,
): ShippedCargoFeatures;
export function deriveShippedCargoComponents(
  cargoMetadata: unknown,
): ShippedCargoComponents;

export interface SbomProperty {
  name: string;
  value: string;
}

export interface SbomComponent {
  type: string;
  'bom-ref': string;
  name: string;
  version: string;
  purl: string;
  licenses?: unknown;
  properties: SbomProperty[];
}

export interface Sbom {
  bomFormat: string;
  specVersion: string;
  serialNumber: string;
  version: number;
  metadata: {
    component: Record<string, unknown>;
    properties: SbomProperty[];
  };
  components: SbomComponent[];
}

export function encodeNpmPurl(name: string, version: string): string;
export function buildSbom(input: {
  lock: unknown;
  repoRoot: string;
  cargoMetadata: unknown;
  features: readonly string[];
}): Sbom;
