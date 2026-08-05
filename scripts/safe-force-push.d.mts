export interface SafeForcePushOptions {
  remote: string;
  branch: string | null;
  yes: boolean;
  foreign: string | null;
}

export function parseArgs(argv: string[]): SafeForcePushOptions;

/**
 * `attributable` is deliberately required rather than optional. It is the flag
 * that separates "this is not yours" from "I could not tell", and a default
 * would silently pick one of those for a caller that had not considered the
 * difference.
 */
export function originLabel(
  sha: string,
  owned: Set<string>,
  attributable: boolean,
): string;
