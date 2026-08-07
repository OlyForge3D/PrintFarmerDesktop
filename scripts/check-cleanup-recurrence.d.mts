export declare const EXIT_CLEAN: 0;
export declare const EXIT_RECURRENCE: 1;
export declare const EXIT_UNDETERMINED: 2;

export declare const RECURRENCE_THRESHOLD: number;
export declare const HISTORY_COMMENT_LIMIT: number;

export interface CleanupCommentEntry {
  runId: string;
  runAttempt: string;
  job: string;
  headSha: string;
}

export interface RecurrenceClassification {
  parsed: CleanupCommentEntry[];
  firstAttemptEntries: CleanupCommentEntry[];
  distinctShas: string[];
  firstAttemptBySha: Map<string, Array<{ runId: string; job: string }>>;
  recurring: boolean;
}

export interface FetchCleanupHistoryResult {
  comments: object[];
  bounded: boolean;
}

export declare function parseCleanupComment(
  body: string,
): CleanupCommentEntry | null;

export declare function fetchCleanupHistory(input: {
  owner: string;
  repo: string;
  issueNumber?: number;
  limit?: number;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<FetchCleanupHistoryResult>;

export declare function classifyRecurrence(
  comments: Array<{ body: string }>,
): RecurrenceClassification;

export declare function formatRecurrenceReport(input: {
  classification: RecurrenceClassification;
  scope: {
    commentsExamined: number;
    bounded: boolean;
    issueNumber: number;
    owner: string;
    repo: string;
  };
}): string;

export declare function parseArgs(argv: string[]): {
  help?: boolean;
  error?: string;
  repo?: string;
  issueNumber?: number;
  limit?: number;
};

export declare function main(
  argv: string[],
  env?: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): Promise<number>;
