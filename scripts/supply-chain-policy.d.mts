import type { Sbom, SbomComponent } from './supply-chain.d.mts';

export interface LicensePolicy {
  outbound?: string;
  allowed?: string[];
  componentExceptions?: LicenseException[];
}

export interface LicenseException {
  bomRef?: string;
  purl?: string;
  reason: string;
}

export interface LicenseViolation {
  ref: string;
  name: string;
  reason: 'missing' | 'disallowed' | 'unresolved' | 'outbound' | 'policy';
  detail: string;
}

export interface Advisory {
  ecosystem: 'npm' | 'cargo';
  id: string | undefined;
  title?: string;
  package: string | undefined;
  version?: string;
  severity: string;
  fixAvailable: boolean;
}

export interface AdvisoryWaiver {
  id: string;
  reason: string;
}

export interface AdvisoryPolicy {
  severityThreshold?: string;
  enforcement?: 'block' | 'report';
  waivers?: AdvisoryWaiver[];
}

export interface AdvisoryInput {
  advisories: Advisory[];
  couldNotRun?: string[];
}

export interface AdvisoryEvaluation {
  blocking: Advisory[];
  waived: Array<Advisory & { waiver: AdvisoryWaiver }>;
  belowThreshold: Advisory[];
  couldNotRun: string[];
}

export interface SupplyChainPolicy {
  licenses: LicensePolicy;
  advisories: AdvisoryPolicy;
}

export interface SbomCoverage {
  complete: boolean;
  expectedCount: number;
  actualCount: number;
  missing: string[];
  unexpected: string[];
  duplicates: string[];
  malformed: string[];
  diagnostic: string | null;
}

export type NpmSbomCoverage = SbomCoverage;
export type CargoSbomCoverage = SbomCoverage;

export function licenseExpressionsOf(component: unknown): string[];
export function isExpressionAllowed(
  expression: string,
  allowed: Iterable<string>,
): boolean;
export function evaluateLicensePolicy(
  sbom: Sbom,
  policy: LicensePolicy,
): { violations: LicenseViolation[] };
export function advisoryEnforcement(policy: unknown): 'block' | 'report';
export function validateSupplyChainPolicy(policy: unknown): SupplyChainPolicy;

export function severityRank(severity: string): number;
export function severityFromCvss(vector: string | undefined): string;
export function normalizeNpmAudit(report: unknown): Advisory[];
export function normalizeCargoAudit(report: unknown): Advisory[];
export function evaluateNpmSbomCoverage(
  sbom: Sbom,
  npmProductionTree: unknown,
  importedComponents: Iterable<readonly [string, string]>,
): NpmSbomCoverage;
export function evaluateCargoSbomCoverage(
  sbom: Sbom,
  cargoMetadata: unknown,
): CargoSbomCoverage;
export function scopeToShippedClosure(
  advisories: Advisory[],
  shippedPackageNames: Iterable<string>,
  shippedPackageIdentities?: Iterable<string>,
): Advisory[];
export function evaluateAdvisories(
  input: AdvisoryInput,
  policy: AdvisoryPolicy,
): AdvisoryEvaluation;

export function renderThirdPartyNotices(sbom: Sbom): string;

export type { Sbom, SbomComponent };
