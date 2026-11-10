export interface SquashInput {
  base: string;
  head: string;
  group: string;
  repository?: string;
  number?: number;
  remote?: boolean;
}
export interface SquashEvidence {
  base: string;
  head: string;
  group: string;
  mergeBase: string;
  tree: string;
}
export declare function findGitHelpers(
  executable: string,
  intrinsic: string,
): string;
export declare function verifySquashGroup(input: SquashInput): SquashEvidence;
export declare function main(argv: string[]): number;
