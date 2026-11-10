export declare const REQUIRED_CONTEXT_NAMES: readonly string[];
export declare const QUEUE_PARAMETERS: Readonly<
  Record<string, string | number>
>;
export declare function validQueueRuleset(ruleset: unknown): boolean;
export declare function validQueueConfiguration(ruleset: unknown): boolean;
export interface QueuePolicy {
  mode: 'strict' | 'queue';
  checks: { context: string; appId: number }[];
}
export declare function evaluateQueuePolicy(facts: {
  protection: unknown;
  rules: unknown[];
  rulesets: unknown[];
}): QueuePolicy;
