export const INCONCLUSIVE: number;

export function refuse(headline: string, detail?: readonly string[]): never;

export interface LoadedCorpus {
  readonly sources: Map<string, string>;
  readonly unreadable: readonly string[];
}

export function loadCorpus(files: readonly string[]): LoadedCorpus;

export function requireScanRoots(corpus: LoadedCorpus): Map<string, string>;

export const GIT_OBJECT_TOKEN_RE: RegExp;

export const FORGE_CITATION_RE: RegExp;

export function isGitObjectToken(token: string): boolean;

export function isForgeCitation(token: string): boolean;

export function collectCitations(
  sources: Map<string, string>,
): Map<string, string[]>;

export function requireCorpusFloor(options: {
  count: number;
  floor: number;
  subject?: string;
}): void;
