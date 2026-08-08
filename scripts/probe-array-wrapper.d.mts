/**
 * Declarations for `scripts/probe-array-wrapper.mjs`.
 *
 * Mirrors `scripts/probe-silent-success.d.mts`'s shape: the runtime is
 * permissive (plain JS), the declarations are narrow, because the tests pin
 * behaviour at the narrow edges (e.g. `judgeArm` throwing on a missing arm or
 * classification, rather than inventing a judgement from nothing).
 */

export interface Arm {
  readonly id: string;
  readonly role: string;
  readonly expect: string;
  readonly cites: string;
  readonly claim: string;
  readonly expression: string;
}

/** A single reading. `null` means the case produced none, which is NOT the
 *  same as the string `"0"` -- that is a genuine zero answered by pwsh. */
export interface ProbeCase {
  readonly label: string;
  readonly reading: string | null;
  readonly error?: string | undefined;
}

export interface Precondition {
  readonly id: string;
  readonly satisfied: boolean;
  readonly detail: string;
}

export interface Classification {
  readonly verdict: string;
  readonly vacuous?: boolean;
  readonly findings?: readonly string[] | undefined;
  readonly readings?: readonly ProbeCase[] | undefined;
}

export interface JudgedArm {
  readonly id: string;
  readonly role: string;
  readonly cites: string;
  readonly claim: string;
  readonly expect: string;
  readonly observed: string;
  readonly status: string;
  readonly direction: string;
  readonly findings: readonly string[];
  readonly readings: readonly ProbeCase[];
}

export interface Verdict {
  readonly exitCode: number;
  readonly summary: string;
}

export const EXIT_HOLDS: number;
export const EXIT_CHANGED: number;
export const EXIT_UNDETERMINED: number;

export const STATUS_HOLDS: string;
export const STATUS_CHANGED: string;
export const STATUS_UNDETERMINED: string;

export const ROLE_DEFECT: string;
export const ROLE_SUBSTITUTE: string;

export const PWSH_BINARY: string;

export const ARMS: readonly Arm[];
export const USAGE: string;

export function readSuccessfulOutput(result: {
  status: number;
  stdout: string;
  stderr: string;
}): { reading: string | null; error?: string };

export function readPrecondition(): Precondition;

export function readArm(expression: string): ProbeCase[];

export function judgeArm(
  arm: Arm | undefined,
  classified: Classification | undefined,
): JudgedArm;

export function overallVerdict(
  precondition: unknown,
  judged: readonly { readonly status: string }[],
): Verdict;

export function formatReport(
  precondition: Precondition,
  judged: readonly JudgedArm[],
  verdict: Verdict,
): string;

export function main(options?: {
  readPrecondition?: typeof readPrecondition;
  readArm?: typeof readArm;
}): number;
