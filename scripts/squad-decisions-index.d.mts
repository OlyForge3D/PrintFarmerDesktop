export const INDEXED_SOURCES: readonly string[];
export const INDEX_PATH: string;
export const GENERATED_BANNER: string;

export interface IndexedSection {
  source: string;
  level: number;
  title: string;
  date: string | null;
  startLine: number;
  endLine: number;
}

export function parseSections(
  markdown: string,
  options?: { source?: string },
): IndexedSection[];

export function issueReferences(title: string): number[];

export function renderIndex(
  sectionsBySource: Map<string, IndexedSection[]>,
): string;

export function buildIndex(
  sources: ReadonlyArray<{ path: string; contents: string }>,
): string;

export function lookup(
  sections: readonly IndexedSection[],
  query: string,
): IndexedSection[];
