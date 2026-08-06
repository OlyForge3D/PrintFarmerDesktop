export const ENFORCEMENT_VERBS: RegExp;
export const HAND_RUN_DISCLAIMER: RegExp;
export const TEST_MECHANISM: RegExp;

export interface Document {
  path: string;
  contents: string;
}

export interface CitationSentence {
  sentence: string;
  scripts: string[];
}

export interface CitationFinding {
  document: string;
  script: string;
  sentence: string;
  /** Mechanisms that exist but the sentence fails to name. */
  available: string[];
}

export interface HonestCitation {
  document: string;
  script: string;
  sentence: string;
  mechanism: 'by hand' | 'run:' | 'tests';
}

export function commentParagraphs(contents: string): string[];
export function citationSentences(contents: string): CitationSentence[];
export function citationParagraphs(contents: string): {
  paragraph: string;
  /** The paragraph with script references removed, used to detect a claim. */
  claim: string;
  scripts: string[];
}[];
export function runInvokedScripts(
  workflows: Document[],
  npmScripts?: Record<string, string>,
): Set<string>;
export function testImportedScripts(testFiles: Document[]): Set<string>;
export function evaluateEnforcementCitations(input: {
  documents: Document[];
  workflows: Document[];
  testFiles: Document[];
  npmScripts: Record<string, string>;
}): {
  findings: CitationFinding[];
  honest: HonestCitation[];
  citations: number;
};
export function formatFindings(findings: CitationFinding[]): string[];
