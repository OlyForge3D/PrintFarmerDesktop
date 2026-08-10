export interface AssumptionViolation {
  assumption: string;
  expected: string;
  actual: string;
  decision: string;
  consequence: string;
}

export interface Collaborator {
  login: string;
  role: string;
}

export interface RepositoryFacts {
  protection: Record<string, unknown>;
  rulesets?: Array<Record<string, unknown>>;
  protectedBranches?: string[];
  collaborators?: Collaborator[];
}

export declare const REQUIRED_CONTEXT_NAMES: readonly string[];
export declare const EXPECTED_COLLABORATORS: readonly Collaborator[];
export declare const EXIT_SKIPPED_WITHOUT_CREDENTIALS_IN_CI: number;

export declare function evaluateProtectionAssumptions(
  facts: RepositoryFacts,
): AssumptionViolation[];

// #491: the two assumptions that depend only on the two GitHub endpoints
// that return 200 to an unauthenticated request against this repository
// (`/rulesets`, `/branches?protected=true`) -- protected branches, and
// rulesets covering feature branches.
export declare function evaluatePublicProtectionAssumptions(facts: {
  rulesets?: Array<Record<string, unknown>>;
  protectedBranches?: string[];
}): AssumptionViolation[];

export declare const PRIVILEGED_ONLY_ASSUMPTIONS: readonly string[];

export declare function rulesetCoversFeatureBranches(ruleset: unknown): boolean;

export declare function formatViolations(
  violations: AssumptionViolation[],
): string;

export declare function fetchPublicRepositoryFacts(input: {
  repository: { owner: string; repo: string };
  fetchImpl?: typeof fetch;
}): Promise<{
  rulesets: Array<Record<string, unknown>>;
  protectedBranches: string[];
}>;

export declare function fetchPrivilegedRepositoryFacts(input: {
  repository: { owner: string; repo: string };
  branch?: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  protection: Record<string, unknown>;
  collaborators: Collaborator[];
}>;

export declare function fetchRepositoryFacts(input: {
  repository: { owner: string; repo: string };
  branch?: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<Required<RepositoryFacts>>;

export interface StatusCheckEnforcement {
  /** 'bypassable' means the setting is present and exempts the only merger. */
  state: 'binding' | 'bypassable' | 'absent';
  why: string;
}
export function statusCheckEnforcement(
  protection: unknown,
): StatusCheckEnforcement;

export interface AdminExemptibleSettingReadings {
  strict: StatusCheckEnforcement;
  allow_force_pushes: StatusCheckEnforcement;
  allow_deletions: StatusCheckEnforcement;
  required_linear_history: StatusCheckEnforcement;
}
export function adminExemptibleSettingEnforcement(
  protection: unknown,
): AdminExemptibleSettingReadings;

export interface MergedAgainstBaseWorst {
  number: number;
  commits: number;
}

export interface MergedAgainstBaseReading {
  requested: number;
  sampled: number;
  upToDate: number;
  behind: number;
  unmeasured: number;
  worst: MergedAgainstBaseWorst | null;
}

export declare function measureMergedAgainstBase(input: {
  repository: { owner: string; repo: string };
  token: string;
  fetchImpl?: typeof fetch;
  base?: string;
  sampleSize?: number;
  perPage?: number;
  maxPages?: number;
}): Promise<MergedAgainstBaseReading>;

export declare function formatMergedAgainstBaseReading(
  reading: MergedAgainstBaseReading,
): string;
