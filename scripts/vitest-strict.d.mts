export const EXIT_OK: 0;
export const EXIT_UNMATCHED: 1;
export const EXIT_INCONCLUSIVE: 2;

export const MATCHED: 'matched';
export const UNMATCHED: 'unmatched';
export const INCONCLUSIVE: 'inconclusive';

export const SKIP_FLAG_VALUE: 'flag-value';
export const SKIP_AMBIGUOUS: 'ambiguous';

export const VALUE_TAKING_FLAGS: Set<string>;

export type ListingVerdict =
  typeof MATCHED | typeof UNMATCHED | typeof INCONCLUSIVE;

export type SkipReason = typeof SKIP_FLAG_VALUE | typeof SKIP_AMBIGUOUS;

export interface SkippedToken {
  token: string;
  reason: SkipReason;
  after: string;
}

export interface Listing {
  code: number;
  stdout: string;
}

export function isFlag(token: unknown): boolean;

export function selectorCandidates(argv?: string[]): {
  candidates: string[];
  skipped: SkippedToken[];
};

export function classifyListing(input?: {
  code?: number | undefined;
  stdout?: string | undefined;
}): ListingVerdict;

export function formatRefusal(input?: {
  unmatched?: string[] | undefined;
  candidates?: string[] | undefined;
}): string;

export function formatInconclusive(input?: {
  selector?: string | undefined;
  code?: number | undefined;
}): string;

export function resolveVitestBin(require?: NodeRequire): string;

export function listFilesFor(
  selector: string,
  options?: { cwd?: string | undefined; bin?: string | undefined },
): Listing;

export function runVitest(
  argv: string[],
  options?: { cwd?: string | undefined; bin?: string | undefined },
): number;

export function checkSelectors(
  argv: string[],
  options?: { list?: ((selector: string) => Listing) | undefined },
): {
  verdict: ListingVerdict;
  unmatched?: string[];
  selector?: string;
  code?: number;
  candidates: string[];
  skipped: SkippedToken[];
};

export function main(
  argv?: string[],
  options?: {
    list?: ((selector: string) => Listing) | undefined;
    run?: ((argv: string[]) => number) | undefined;
    log?: ((message: string) => void) | undefined;
  },
): number;
