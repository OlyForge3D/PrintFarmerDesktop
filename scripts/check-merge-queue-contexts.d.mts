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

/**
 * A credential the script never asked for is not a credential it does not have.
 * `run` is injectable so the discovery can be tested without a real `gh`.
 */
export type CredentialProbe = (
  command: string,
  args: string[],
  options: { encoding: string; stdio: unknown },
) => { status: number | null; stdout?: string; error?: unknown } | undefined;

export declare function discoverToken(
  env?: NodeJS.ProcessEnv,
  run?: CredentialProbe,
): string | null;

/**
 * Returns `''` when the environment already identifies the repository (owner
 * alone is enough downstream), `null` when nothing can identify it.
 */
export declare function discoverRepository(
  env?: NodeJS.ProcessEnv,
  run?: CredentialProbe,
): string | null;
