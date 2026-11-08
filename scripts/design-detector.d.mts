export interface DetectorFinding {
  readonly antipattern: string;
  readonly name?: string;
  readonly description?: string;
  readonly severity?: string;
  readonly category?: string;
  readonly file?: string;
  readonly line?: number;
  readonly snippet?: string;
  readonly advisory?: boolean;
}

export interface DetectorManifest {
  readonly files?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export interface DesignDetectorOptions {
  files: string[];
  base: string | null;
  head: string | null;
  all: boolean;
  writeManifest: boolean;
  toolRoot: string | null;
}

export declare const DETECTOR_DIR: string;
export declare const MANIFEST_FILE: string;

export function computeDetectorHashes(
  detectorDir: string,
): Record<string, string>;
export function verifyDetectorManifest(
  manifest: DetectorManifest | null | undefined,
  actualHashes: Readonly<Record<string, string>>,
): string[];
export function partitionFindings(findings: readonly DetectorFinding[]): {
  blocking: DetectorFinding[];
  advisory: DetectorFinding[];
};
export function parseDetectorOutput(stdout: unknown): DetectorFinding[];
export function formatFinding(finding: DetectorFinding, root: string): string;
export function formatAnnotation(
  finding: DetectorFinding,
  root: string,
): string;
export function changedPathsBetween(
  root: string,
  base: string,
  head: string,
): string[];
export function allRendererPaths(root: string): string[];
export function runDetector(
  root: string,
  files: readonly string[],
  toolRoot?: string,
  options?: { strict?: boolean; noInlineIgnores?: boolean },
): DetectorFinding[];
export function parseArgs(argv: readonly string[]): DesignDetectorOptions;
export function main(argv?: readonly string[], root?: string): number;
