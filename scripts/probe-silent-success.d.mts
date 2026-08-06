/**
 * Declarations for `scripts/probe-silent-success.mjs`.
 *
 * The signatures are deliberately narrow where the runtime is permissive.
 * `judgeArm` accepts `undefined` in both positions here NOT because callers
 * should pass it, but because refusing it is behaviour the tests pin: a
 * judgement invented from a missing arm is exactly the fabricated report the
 * probe's preconditions exist to prevent, so the throw is part of the contract
 * and has to be reachable from a typed test.
 */

export interface Arm {
  readonly id: string;
  readonly role: string;
  readonly reading: string;
  readonly expect: string;
  readonly cites: string;
  readonly claim: string;
}

/** A single reading. `null` means the arm produced none, which is NOT the same
 *  as the empty string — that is a genuine answer from `status --porcelain`. */
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

export const FABRICATED_OBJECT: string;
export const ABSENT_REF: string;
export const ABSENT_PATH: string;
export const FIXTURE_BRANCH: string;
export const STABLE_FILE: string;
export const MUTATED_FILE: string;
export const COMMITTED_BYTES: string;
export const MUTATED_BYTES: string;

export const ARMS: readonly Arm[];
export const USAGE: string;

export function judgeArm(
  arm: Arm | undefined,
  classified: Classification | undefined,
): JudgedArm;

export function overallVerdict(
  preconditions: unknown,
  judged: readonly { readonly status: string }[],
): Verdict;

export function formatReport(
  preconditions: readonly Precondition[],
  judged: readonly JudgedArm[],
  verdict: Verdict,
): string;

export function judgeFixture(readings: {
  realStatus: number;
  realType: string;
  fabricatedStatus: number;
}): boolean;

export function judgeMutationReached(readings: {
  onDisk: string;
  restored: string;
}): boolean;

export function buildFixture(): { dir: string };
export function setWorkingTree(dir: string, mutated: boolean): void;
export function readPreconditions(dir: string): Precondition[];
export function readSuccessfulOutput(
  result: { status: number; stdout: string; stderr: string },
  mode: 'trim' | 'raw',
): { reading: string | null; error?: string };
export function readArm(dir: string, id: string): ProbeCase[];
export function main(options?: {
  readPreconditions?: typeof readPreconditions;
  readArm?: typeof readArm;
}): number;
