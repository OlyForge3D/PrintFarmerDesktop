export interface SquadCoverageIssue {
  number: number;
  labels: string[];
  url?: string;
}

export interface IssueCoverageClassification {
  number: number;
  labels: string[];
  squadLabels: string[];
  covered: boolean;
}

export interface SquadCoverageOffender {
  number: number;
  labels: string[];
}

export interface SquadCoverageResult {
  totalOpenIssues: number;
  coveredCount: number;
  offenders: SquadCoverageOffender[];
}

export function normalizeLabels(
  rawLabels: unknown,
  description: string,
): string[];
export function parseOpenIssues(raw: string): SquadCoverageIssue[];
export function classifyIssueCoverage(
  issue: SquadCoverageIssue,
): IssueCoverageClassification;
export function evaluateSquadCoverage(
  issues: SquadCoverageIssue[],
): SquadCoverageResult;
export function formatOffenderLine(offender: SquadCoverageOffender): string;
export function formatReport(result: SquadCoverageResult): string;
export function runGitHub(
  args: string[],
  execute?: (
    command: string,
    args: string[],
    options: {
      encoding: string;
      maxBuffer: number;
      stdio: string[];
    },
  ) => string,
): string;
export function parsePaginatedIssuesResponse(raw: string): SquadCoverageIssue[];
export function readOpenIssues(input: {
  run: (args: string[]) => string;
}): SquadCoverageIssue[];
export function readFixtureIssues(path: string): SquadCoverageIssue[];
export function main(
  argv?: string[],
  deps?: {
    run?: (args: string[]) => string;
    output?: (line: string) => void;
    readFixture?: (path: string) => SquadCoverageIssue[];
    readLive?: (input: {
      run: (args: string[]) => string;
    }) => SquadCoverageIssue[];
  },
): Promise<SquadCoverageResult>;
