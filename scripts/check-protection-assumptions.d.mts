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

export declare function evaluateProtectionAssumptions(
  facts: RepositoryFacts,
): AssumptionViolation[];

export declare function rulesetCoversFeatureBranches(
  ruleset: Record<string, unknown> | null | undefined,
): boolean;

export declare function formatViolations(
  violations: AssumptionViolation[],
): string;

export declare function fetchRepositoryFacts(input: {
  repository: { owner: string; repo: string };
  branch?: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<Required<RepositoryFacts>>;
