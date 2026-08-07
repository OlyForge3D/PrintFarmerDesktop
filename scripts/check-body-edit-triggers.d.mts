export const DEFAULT_PULL_REQUEST_TYPES: string[];
export const BODY_EDIT_TYPE: string;

export interface BodyDerivedRead {
  pattern: RegExp;
  reason: string;
}

export const BODY_DERIVED_READS: BodyDerivedRead[];

export interface WorkflowSource {
  path: string;
  contents: string;
}

export interface ScriptSource {
  basename: string;
  contents: string;
}

export interface TriggerFinding {
  workflow: string;
  guards: string[];
  types: string[];
  reasons: string[];
}

export interface DroppedDefaultsFinding {
  workflow: string;
  types: string[];
  dropped: string[];
}

export function bodyDerivedReads(contents: string): string[];
export function invokedScripts(
  workflowContents: string,
  npmScripts?: Record<string, string>,
): string[];
/** `null` when the workflow has no `pull_request:` trigger at all. */
export function pullRequestTypes(workflowContents: string): string[] | null;
export function effectiveTypes(types: string[] | null): string[] | null;
export function droppedDefaultTypes(types: string[] | null): string[];
export function evaluateBodyEditTriggers(input: {
  workflows: WorkflowSource[];
  scripts: ScriptSource[];
  npmScripts: Record<string, string>;
}): {
  findings: TriggerFinding[];
  compliant: TriggerFinding[];
  droppedDefaults: DroppedDefaultsFinding[];
  guards: string[];
};
export function formatFindings(findings: TriggerFinding[]): string[];
export function formatDroppedDefaults(
  droppedDefaults: DroppedDefaultsFinding[],
): string[];
