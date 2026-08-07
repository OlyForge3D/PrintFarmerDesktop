export interface AdminGuideCitation {
  raw: string;
  path: string;
  commit: string;
  startLine: number;
  endLine: number;
  anchor: string;
}

export interface ParsedAdminGuideCitations {
  section: string;
  pins: string[];
  citations: AdminGuideCitation[];
}

export const GUIDE_PATH: string;
export const SERVER_REPOSITORY: string;
export const ADMIN_GUIDE_CITATION_FLOOR: number;

export class CitationParseError extends Error {}
export class CitationFetchError extends Error {}

export function section10Of(guide: string): string;
export function parseAdminGuideCitations(
  guide: string,
): ParsedAdminGuideCitations;
export function verifyCitationContent(
  citation: AdminGuideCitation,
  contents: string,
): string | null;
export function verifyRemoteCitations(options: {
  parsed: ParsedAdminGuideCitations;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  broken: string[];
  stale: string[];
  remoteHead: string;
  remaining: number;
  requestsRequired: number;
  uniqueFiles: number;
}>;
export function main(): Promise<void>;
