export type ProbeVerdict = 'SOUND' | 'BLIND' | 'MISREPORTS' | 'UNUSABLE';

export interface ProbeCaseReading {
  readonly label: string;
  readonly reading: string | null;
  readonly expect?: string | undefined;
  readonly error?: string | undefined;
}

export interface DiscriminationOutcome {
  readonly verdict: ProbeVerdict;
  readonly blind: boolean;
  readonly findings: string[];
  readonly readings: { label: string; reading: string | null }[];
}

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: string | undefined;
}

export const VERDICT_SOUND: 'SOUND';
export const VERDICT_BLIND: 'BLIND';
export const VERDICT_MISREPORTS: 'MISREPORTS';
export const VERDICT_UNUSABLE: 'UNUSABLE';

export const EXIT_SOUND: 0;
export const EXIT_DEFECTIVE: 1;
export const EXIT_UNDETERMINED: 2;

export const VERDICT_RANK: readonly ProbeVerdict[];
export const PROBE_PLACEHOLDER: '{{PROBE}}';
export const PLACEHOLDER: RegExp;
export const REDUCERS: readonly string[];

export function pathIsInterpolable(p: string | undefined): boolean;
export function worstVerdict(verdicts: readonly string[]): ProbeVerdict;
export function exitCodeFor(verdict: string): 0 | 1 | 2;

export function classifyDiscrimination(
  cases: readonly ProbeCaseReading[],
): DiscriminationOutcome;

export function applyReduce(
  reduce: string,
  raw: string,
): { ok: true; value: string } | { ok: false; reason: string };

export interface ProbeCaseSpec {
  readonly label: string;
  readonly probe?:
    { readonly exit: number; readonly lines?: number } | undefined;
  readonly vars?: Record<string, string> | undefined;
  readonly expect?: string | undefined;
}

export interface ValidatedSpec {
  readonly instrument: string;
  readonly shell: 'pwsh' | 'sh' | 'none';
  readonly script?: string | undefined;
  readonly command?: string[] | undefined;
  readonly reading: 'exitCode' | 'stdout';
  readonly reduce: string;
  readonly cases: readonly ProbeCaseSpec[];
}

export function validateSpec(
  spec: unknown,
): { ok: true; spec: ValidatedSpec } | { ok: false; reason: string };

export function buildArgv(
  spec: {
    shell: string;
    script?: string | undefined;
    command?: string[] | undefined;
  },
  nodePath: string,
  probePath: string,
  vars?: Record<string, string> | undefined,
): { ok: true; argv: string[] } | { ok: false; reason: string };

export function runArgv(argv: string[], env: Record<string, string>): RunResult;

export function readingFrom(
  reading: 'exitCode' | 'stdout',
  result: RunResult,
  reduce?: string | undefined,
): { reading: string | null; error?: string | undefined };

export function executeSpec(
  spec: ValidatedSpec,
  run: (argv: string[], env: Record<string, string>) => RunResult,
  nodePath: string,
  probePath: string,
): ProbeCaseReading[];

export function formatOutcome(
  instrument: string,
  outcome: DiscriminationOutcome,
): string;

export function parseArgs(argv: readonly string[]): {
  spec?: string | undefined;
  help?: boolean | undefined;
};

export function main(argv?: readonly string[]): number;
