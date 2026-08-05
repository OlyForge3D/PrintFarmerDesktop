/**
 * Types for check-injected-defaults.mjs.
 *
 * `readFile` is declared as the narrow shape this tool actually uses rather
 * than as `typeof readFileSync`. The wider signature has overloads returning
 * Buffer and accepting file handles and option objects, none of which are
 * reached here — and declaring it would force every test fixture to satisfy
 * parts of an API it does not implement. A signature a stub must lie to
 * satisfy is the wrong signature; check-required-contexts.d.mts carries the
 * same note about spawnSync for the same reason.
 */

export const EXIT_OK: 0;
export const EXIT_RELOCATED: 1;
export const EXIT_UNDETERMINED: 2;

export const VERDICT_DRIVEN: 'DRIVEN';
export const VERDICT_DIRECT: 'DIRECT';
export const VERDICT_UNREACHABLE: 'UNREACHABLE';
export const VERDICT_UNDETERMINED: 'UNDETERMINED';

export type Verdict = 'DRIVEN' | 'DIRECT' | 'UNREACHABLE' | 'UNDETERMINED';

/** How much of a call site's argument could be established statically. */
export type CallResolution = 'none' | 'literal' | 'indirect' | 'unresolved';

export interface InjectedDefault {
  /** The property name on the destructured parameter. */
  key: string;
  /** 'identifier' when the default names a binding, 'inline' otherwise. */
  defaultKind: 'identifier' | 'inline';
  /** The bound name, or null for an inline expression that has none. */
  defaultName: string | null;
  line: number | null;
}

export interface CallSite {
  line: number | null;
  resolution: CallResolution;
  /** Null exactly when the resolution is 'unresolved'. */
  keys: Set<string> | null;
}

export interface ClassifiedDefault extends InjectedDefault {
  verdict: Verdict;
  why: string;
}

export interface AnalysisResult {
  moduleFile: string;
  suiteFile: string;
  rootName: string;
  defaults: InjectedDefault[];
  sites: CallSite[];
  classified: ClassifiedDefault[];
}

/** Only the reading shape this tool uses; see the note at the top. */
export type ReadFile = (file: string, encoding: string) => string;

export interface AnalyseOptions {
  moduleFile: string;
  suiteFile: string;
  rootName: string;
  readFile?: ReadFile;
}

export interface ClassifyInput {
  defaults: InjectedDefault[];
  exports: Set<string>;
  imported: Set<string>;
  sites: CallSite[];
}

export interface ParsedArgs {
  module: string | null;
  suite: string | null;
  root: string;
  help: boolean;
}

export interface Io {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

// The AST is `@typescript-eslint/parser` output. It is deliberately not modelled
// here: only the one property this module relies on generically is modelled.
// Narrowing further would pin an upstream type that changes on a parser upgrade
// without changing this file.
export interface AstNode {
  type: string;
  [key: string]: unknown;
}
export type Ast = AstNode;

export function walk(
  node: AstNode | AstNode[] | null | undefined,
  visit: (node: AstNode) => void,
): void;
export function parseSource(source: string, filename: string): Ast;
export function namedExports(ast: Ast): Set<string>;
export function importedFrom(
  ast: Ast,
  suitePath: string,
  modulePath: string,
): Set<string>;
export function findCompositionRoot(ast: Ast, rootName: string): AstNode | null;
export function readInjectedDefaults(
  rootNode: AstNode | null,
): InjectedDefault[];
export function uniqueObjectBindings(ast: Ast): Map<string, AstNode>;
export function findCallSites(ast: Ast, rootName: string): CallSite[];
export function classifyDefaults(input: ClassifyInput): ClassifiedDefault[];
export function exitCodeFor(
  classified: Pick<ClassifiedDefault, 'verdict'>[],
): 0 | 1 | 2;
export function formatResult(
  result: Pick<
    AnalysisResult,
    'moduleFile' | 'suiteFile' | 'rootName' | 'classified' | 'sites'
  >,
): string;
export function parseArgs(argv: string[]): ParsedArgs;
export function analyse(options: AnalyseOptions): AnalysisResult;
export function runMain(argv: string[], io?: Io): 0 | 1 | 2;
export function main(argv: string[], io?: Io): 0 | 1 | 2;
