export declare const MERGE_QUEUE_CLASSES: readonly [
  'reports',
  'advisory',
  'publication',
];

export type MergeQueueClass = (typeof MERGE_QUEUE_CLASSES)[number];

export interface WorkflowFile {
  file: string;
  contents: string;
}

export interface ClassificationViolation {
  file: string;
  declared: MergeQueueClass;
  reason: string;
}

export interface DeadlockingContext {
  context: string;
  emittedBy: string | undefined;
  reason: string;
}

export interface RequiredStatusChecks {
  contexts: string[];
  strict: boolean;
}

export interface Repository {
  owner: string;
  repo: string;
}

export declare function resolveRepository(env: NodeJS.ProcessEnv): Repository;

export declare function declaredClassOf(
  contents: string,
  file?: string,
): MergeQueueClass;

export declare function triggersOf(contents: string, file?: string): string[];

export declare function renderedContexts(
  contents: string,
  file?: string,
): string[];

export declare function evaluateWorkflowClassification(
  workflows: WorkflowFile[],
): ClassificationViolation[];

export declare function evaluateRequiredContexts(input: {
  workflows: WorkflowFile[];
  requiredContexts: string[];
}): DeadlockingContext[];

export declare function readWorkflows(directory: string): WorkflowFile[];

export declare function fetchRequiredContexts(input: {
  repository: Repository;
  branch: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<RequiredStatusChecks>;

export declare function formatDeadlock(offenders: DeadlockingContext[]): string;
