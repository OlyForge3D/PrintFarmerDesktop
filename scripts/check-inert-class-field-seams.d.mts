export interface InertSeamViolation {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly typeText: string;
}

export function listSourceFiles(repoRoot: string): string[];

export function findInertSeamCandidates(
  filePath: string,
  sourceText: string,
): InertSeamViolation[];

export function formatViolation(violation: InertSeamViolation): string;

export function scanRepository(repoRoot: string): InertSeamViolation[];
