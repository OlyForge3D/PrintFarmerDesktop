#!/usr/bin/env node
// PIN #367 INSTANCE 4 TO THE BEHAVIOUR IT RESTS ON.
//
// #367 catalogues verification commands that succeed while carrying no
// information. Instance 4 is the sharpest of the four measured there, because
// it is not a silent zero -- it is a wrong one, and there is no silence to
// notice:
//
//   @($null).Count                   = 1     <- a datum fabricated from absence
//   @().Count                        = 0
//   ($null | Measure-Object).Count   = 0
//
// `@(...)` is the standard idiom for guarding against PowerShell's
// scalar-to-array collapse: a pipeline that happens to produce exactly one
// object hands it back as a bare scalar, and `.Count` on a scalar throws or
// silently reads a property that does not exist. Wrapping in `@(...)` fixes
// that direction. It breaks the OTHER direction: a variable holding `$null`
// (the normal shape of "the shelled-out command answered with nothing") is
// wrapped into a one-element array *containing* `$null`, and `.Count` reports
// 1 -- the same reading a genuine single-item result produces. The idiom that
// prevents "one item is misread as none" causes "none is misread as one".
//
// #367 names the direction as the dangerous one: a phantom baseline entry
// SHRINKS a measured delta (before=1, after=2 reads as a delta of 1 instead
// of 2), so it discards true findings rather than publishing false ones --
// the failure is invisible in exactly the reports nobody double-checks.
//
// THIS IS AN EMPIRICAL CLAIM ABOUT POWERSHELL, THE SAME SHAPE AS #367's OTHER
// THREE INSTANCES. `scripts/probe-silent-success.mjs` re-runs the git claims
// against this machine's git so they cannot decay silently into folklore;
// this file does the same for the one instance that probe does not reach,
// against this machine's PowerShell. No network, no credential, no repository
// -- `pwsh -NoProfile -NonInteractive -Command <expr>` is the entire
// dependency surface.
//
// THE VERDICT IS PER-ARM, AS IN THE SIBLING PROBE. The defect arm is EXPECTED
// to be BLIND -- `@($value).Count` must read "1" for both "no value" and "one
// value", because that collapse is the finding. The substitute arms are
// EXPECTED to be SOUND -- they must read "0" for absence and "1" for presence.
// A count of arms would send a reader to the wrong sentence; the direction
// each arm moved is what matters:
//
//   the defect arm turns SOUND       PowerShell changed the array-wrapper
//                                    collapse; the instance is now historical
//   a substitute arm turns BLIND     the remedy this repo would migrate onto
//                                    no longer discriminates absence from one
//
// PRECONDITION, READ BEFORE ANY ARM. If `pwsh` is unavailable, or the
// interpreter cannot evaluate a trivial expression, every arm below would
// read as "no result" -- which the classifier already reports as UNUSABLE,
// not BLIND. But an unusable arm and a blind one are different findings with
// different remedies, so the precondition is checked and reported on its own,
// separately from the six case readings, and its failure is ALWAYS exit 2,
// never 0 or 1: "the experiment did not run" must never share a channel with
// "the answer changed".
//
// Run:  node scripts/probe-array-wrapper.mjs
//       npm run probe:array-wrapper
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  classifyDiscrimination,
  VERDICT_SOUND,
  VERDICT_BLIND,
} from './instrument-probe.mjs';

export const EXIT_HOLDS = 0;
export const EXIT_CHANGED = 1;
export const EXIT_UNDETERMINED = 2;

export const STATUS_HOLDS = 'HOLDS';
export const STATUS_CHANGED = 'CHANGED';
export const STATUS_UNDETERMINED = 'UNDETERMINED';

export const ROLE_DEFECT = 'defect';
export const ROLE_SUBSTITUTE = 'substitute';

export const PWSH_BINARY = 'pwsh';

/**
 * Each arm asks the same two cases -- a variable holding `$null` (the shape a
 * shelled-out command's "nothing to report" normally takes) and a variable
 * holding one genuine item -- through a different counting expression.
 * Discrimination is undefined for one subject, which is why every arm is a
 * pair rather than a single reading.
 */
export const ARMS = Object.freeze([
  Object.freeze({
    id: 'array-wrap-null-count',
    role: ROLE_DEFECT,
    expect: VERDICT_BLIND,
    cites: '#367 instance 4',
    claim:
      '`@($value).Count` reads 1 for both "$value is $null" and "$value holds one item"',
    expression: '@($value).Count',
  }),
  Object.freeze({
    id: 'measure-object-count',
    role: ROLE_SUBSTITUTE,
    expect: VERDICT_SOUND,
    cites: '#367 remedy 2',
    claim:
      '`($value | Measure-Object).Count` separates "$value is $null" (0) from "$value holds one item" (1)',
    expression: '($value | Measure-Object).Count',
  }),
  Object.freeze({
    id: 'array-wrap-filtered-count',
    role: ROLE_SUBSTITUTE,
    expect: VERDICT_SOUND,
    cites: '#367 remedy 2',
    claim:
      '`@($value | Where-Object { $null -ne $_ }).Count` filters the null before counting, so it also separates the two cases',
    expression: '@($value | Where-Object { $null -ne $_ }).Count',
  }),
]);

/**
 * @param {string} command
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runPwsh(command) {
  const result = spawnSync(
    PWSH_BINARY,
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) {
    throw new Error(`${PWSH_BINARY}: ${result.error.message}`);
  }
  return {
    status: typeof result.status === 'number' ? result.status : 128,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * @param {{status: number, stdout: string, stderr: string}} result
 * @returns {{reading: string|null, error?: string}}
 */
export function readSuccessfulOutput(result) {
  if (result.status !== 0) {
    const detail = result.stderr.trim() || 'no stderr';
    return { reading: null, error: `pwsh exited ${result.status}: ${detail}` };
  }
  return { reading: result.stdout.trim() };
}

/**
 * The one precondition this whole probe rests on: the interpreter runs and
 * answers a question that has nothing to do with the defect being measured.
 * Separated from the arms below for the same reason `probe-silent-success.mjs`
 * separates its fixture preconditions from its readings -- a missing `pwsh`
 * would make every arm read identically (no result), which the classifier
 * reports as UNUSABLE. UNUSABLE is a true finding about an arm; "the
 * interpreter never ran" is a finding about the whole experiment, and the two
 * must not share an exit code.
 *
 * @returns {{id: string, satisfied: boolean, detail: string}}
 */
export function readPrecondition() {
  let result;
  try {
    result = runPwsh('1 + 1');
  } catch (error) {
    return {
      id: 'P1-interpreter-answers',
      satisfied: false,
      detail: `pwsh could not be invoked: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { reading } = readSuccessfulOutput(result);
  return {
    id: 'P1-interpreter-answers',
    satisfied: reading === '2',
    detail: `1 + 1 => ${JSON.stringify(reading)} (exit ${result.status})`,
  };
}

/**
 * @param {string} expression
 * @returns {{label: string, reading: string|null, error?: string}[]}
 */
export function readArm(expression) {
  const absent = readSuccessfulOutput(runPwsh(`$value = $null; ${expression}`));
  const present = readSuccessfulOutput(runPwsh(`$value = 'x'; ${expression}`));
  return [
    { label: '$value is $null (absent)', ...absent },
    { label: '$value holds one item (present)', ...present },
  ];
}

/**
 * @param {{id: string, role: string, expect: string, cites: string, claim: string}} arm
 * @param {{verdict: string, vacuous?: boolean, findings: string[], readings: {label: string, reading: string|null}[]}} classified
 * @returns {{id: string, role: string, cites: string, claim: string, expect: string, observed: string, status: string, direction: string, findings: string[], readings: {label: string, reading: string|null}[]}}
 */
export function judgeArm(arm, classified) {
  if (!arm || typeof arm !== 'object') {
    throw new Error('judgeArm requires an arm');
  }
  if (!classified || typeof classified !== 'object') {
    throw new Error('judgeArm requires a classification');
  }
  const observed = classified.verdict;
  const findings = classified.findings ?? [];
  const readings = classified.readings ?? [];

  let status;
  let direction = '';
  if (classified.vacuous === true) {
    status = STATUS_UNDETERMINED;
    direction =
      "no reading about PowerShell's behaviour: the case pair is vacuous";
  } else if (observed === arm.expect) {
    status = STATUS_HOLDS;
  } else if (observed === VERDICT_SOUND || observed === VERDICT_BLIND) {
    status = STATUS_CHANGED;
    direction =
      arm.role === ROLE_DEFECT
        ? 'PowerShell now discriminates here, so this instance is historical and the issue overstates it'
        : 'the substitute no longer discriminates, so anything migrated onto it is unguarded';
  } else {
    status = STATUS_UNDETERMINED;
    direction = `no reading about PowerShell's behaviour: ${observed}`;
  }

  return {
    id: arm.id,
    role: arm.role,
    cites: arm.cites,
    claim: arm.claim,
    expect: arm.expect,
    observed,
    status,
    direction,
    findings,
    readings,
  };
}

/**
 * Preconditions outrank every arm, and a failure there is always exit 2.
 *
 * @param {{id: string, satisfied: boolean, detail: string}} precondition
 * @param {readonly {status: string}[]} judged
 * @returns {{exitCode: number, summary: string}}
 */
export function overallVerdict(precondition, judged) {
  if (
    !precondition ||
    typeof precondition !== 'object' ||
    typeof precondition.satisfied !== 'boolean'
  ) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary:
        'invalid precondition record: the experiment did not run, so no arm below is evidence',
    };
  }
  if (!precondition.satisfied) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary: `precondition not satisfied (${precondition.detail}): the experiment did not run, so no arm below is evidence`,
    };
  }
  if (!Array.isArray(judged) || judged.length === 0) {
    return { exitCode: EXIT_UNDETERMINED, summary: 'no arms were read' };
  }
  const undetermined = judged.filter((a) => a.status === STATUS_UNDETERMINED);
  if (undetermined.length > 0) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary: `${undetermined.length} arm(s) produced no reading about PowerShell's behaviour`,
    };
  }
  const changed = judged.filter((a) => a.status === STATUS_CHANGED);
  if (changed.length > 0) {
    return {
      exitCode: EXIT_CHANGED,
      summary: `${changed.length} of ${judged.length} arm(s) no longer match #367 instance 4; the issue's text is out of date in the direction named per arm`,
    };
  }
  return {
    exitCode: EXIT_HOLDS,
    summary: `all ${judged.length} arm(s) match #367 instance 4: the array-wrapper idiom still fabricates a datum from $null, and every prescribed substitute still discriminates`,
  };
}

/**
 * @param {{id: string, satisfied: boolean, detail: string}} precondition
 * @param {readonly ReturnType<typeof judgeArm>[]} judged
 * @param {{exitCode: number, summary: string}} verdict
 * @returns {string}
 */
export function formatReport(precondition, judged, verdict) {
  const lines = [];
  lines.push('PRECONDITION (read before any arm; a failure here is exit 2)');
  if (!precondition || typeof precondition !== 'object') {
    lines.push('  invalid precondition record');
  } else {
    lines.push(
      `  ${precondition.satisfied ? 'ok  ' : 'FAIL'} ${precondition.id} — ${precondition.detail}`,
    );
  }
  lines.push('');
  lines.push('ARMS');
  for (const a of judged ?? []) {
    lines.push(
      `  ${a.status.padEnd(12)} ${a.id.padEnd(28)} ${a.role.padEnd(10)} expect ${a.expect}, observed ${a.observed}   ${a.cites}`,
    );
    lines.push(`      ${a.claim}`);
    for (const r of a.readings) {
      lines.push(`      ${r.label}: ${JSON.stringify(r.reading)}`);
    }
    if (a.direction) lines.push(`      => ${a.direction}`);
    for (const f of a.findings) lines.push(`      ${f}`);
  }
  lines.push('');
  lines.push(`exit ${verdict.exitCode}: ${verdict.summary}`);
  return lines.join('\n');
}

export const USAGE = `Usage: node scripts/probe-array-wrapper.mjs

Re-runs #367 instance 4 -- the PowerShell array-wrapper idiom fabricating a
datum ($null.Count === 1) -- against this machine's pwsh.

  0  the defect still reproduces and every prescribed substitute still
     discriminates, so #367 instance 4's text is still true of this pwsh
  1  at least one claim no longer holds; the report names which direction
  2  the experiment did not run (pwsh unavailable or unusable)
`;

/**
 * @param {{readPrecondition?: typeof readPrecondition, readArm?: typeof readArm}} [options]
 * @returns {number}
 */
export function main(options = {}) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return EXIT_HOLDS;
  }

  let precondition;
  try {
    precondition = (options.readPrecondition ?? readPrecondition)();
  } catch (error) {
    process.stdout.write(
      `exit ${EXIT_UNDETERMINED}: the precondition could not be read (${
        error instanceof Error ? error.message : String(error)
      }); nothing was measured\n`,
    );
    return EXIT_UNDETERMINED;
  }

  const judged = [];
  if (precondition.satisfied) {
    for (const arm of ARMS) {
      let cases;
      try {
        cases = (options.readArm ?? readArm)(arm.expression);
      } catch (error) {
        cases = [
          {
            label: 'arm did not run',
            reading: null,
            error: error instanceof Error ? error.message : String(error),
          },
          { label: 'arm did not run', reading: null },
        ];
      }
      judged.push(judgeArm(arm, classifyDiscrimination(cases, 'stdout')));
    }
  }

  const verdict = overallVerdict(precondition, judged);
  process.stdout.write(`${formatReport(precondition, judged, verdict)}\n`);
  return verdict.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
