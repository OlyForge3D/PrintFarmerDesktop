#!/usr/bin/env node
// @ts-check
/**
 * instrument-probe — prove an instrument separates two known-different cases
 * before believing what it says about an unknown one.
 *
 * WHY THIS EXISTS (issue #214)
 * ---------------------------------------------------------------------------
 * #214 catalogues fourteen commands that answer a neighbouring question and
 * report the wrong answer as a confident, well-formed value. Its own stated
 * remedy is "a short .squad/ reference of known-lying commands", and its own
 * diagnosis is "the failure is not knowledge, it is that each session meets
 * these fresh". Those two sentences contradict each other: a reference is
 * consulted AFTER you suspect an instrument, and the whole defect class is
 * not suspecting it. Two sessions paid for the same member ninety minutes
 * apart with the catalogue already open.
 *
 * #214's other remedy — "every matching predicate gets a control that must
 * return the opposite result" — is the right rule and is a commitment: it
 * binds only the person who remembers to apply it, and forgetting is silent.
 * This script is that rule as something that runs.
 *
 * THE UNIFICATION
 * ---------------------------------------------------------------------------
 * Exit-code fidelity and predicate discrimination look like two problems and
 * are one. Measured on this machine:
 *
 *   pwsh: $LASTEXITCODE=77; <cmd> | Select-Object -First 1; exit $LASTEXITCODE
 *     <cmd> exits 3  -> 77
 *     <cmd> exits 0  -> 77
 *
 * The pipeline is not merely inaccurate about the exit code. It returns THE
 * SAME READING for the two cases it exists to separate, so no amount of
 * reading it more carefully can recover the answer. That is exactly the shape
 * of #214's instance 5 (`branch --contains` returns true for the tip and for
 * every ancestor) and instance 1 (`.Contains()` on a string array returns
 * False for text plainly present). One classifier covers all of them:
 *
 *   an instrument is sound only if it gives DIFFERENT readings for two cases
 *   you have independently established are different.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not carry a list of known-bad commands. A list only ever answers for
 * members someone already met; this answers for an instrument nobody has
 * catalogued, which is the case that costs money. Naming the two cases is the
 * user's job and is the irreducible part — no tool can know what question you
 * meant to ask.
 *
 * VERDICT RANKING (pinned by test, and it is not the obvious order)
 * ---------------------------------------------------------------------------
 *   BLIND       > MISREPORTS > UNUSABLE > SOUND
 *
 * MISREPORTS outranks UNUSABLE for the reason established in
 * check-merge-landed.mjs: a proven defect in case A is not weakened by case B
 * failing to run. A reading that came back wrong is a finding; a reading that
 * never arrived is an absence of one. Ranking them the other way would let a
 * single unusable arm mask a demonstrated lie — which is #214's subject one
 * level up, inside the instrument built to detect it.
 *
 * BLIND outranks MISREPORTS because blindness is the unrecoverable case. A
 * misreporting instrument still varies with its subject, so its output retains
 * information; a blind one has none to retain.
 *
 * EXIT CODES ARE THREE-VALUED ON PURPOSE (issue #315)
 *   0 sound · 1 defective instrument · 2 could not be determined
 * Never collapse 2 into 1: "this instrument lies" and "I could not find out
 * whether it lies" have different remedies, and `if (!ok)` merges them toward
 * the reassuring reading.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERDICT_SOUND = 'SOUND';
export const VERDICT_BLIND = 'BLIND';
export const VERDICT_MISREPORTS = 'MISREPORTS';
export const VERDICT_UNUSABLE = 'UNUSABLE';

export const EXIT_SOUND = 0;
export const EXIT_DEFECTIVE = 1;
export const EXIT_UNDETERMINED = 2;

/** Worst-first. Index 0 dominates. See the ranking note in the header. */
export const VERDICT_RANK = [
  VERDICT_BLIND,
  VERDICT_MISREPORTS,
  VERDICT_UNUSABLE,
  VERDICT_SOUND,
];

export const PROBE_PLACEHOLDER = '{{PROBE}}';

/** Any `{{NAME}}` token. A spec with none cannot vary with its case. */
export const PLACEHOLDER = /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/;

/**
 * cmd.exe and POSIX shells both expand inside quotes, so there is no quoting
 * that makes an arbitrary path safe to interpolate into a shell string. Rather
 * than emit a command line we cannot vouch for, refuse. Same policy, and the
 * same reasoning, as resolveCommand() in mutation-harness.mjs.
 */
const SAFE_PATH = /^[A-Za-z0-9 _.:@=+\-/\\]+$/;

/**
 * @param {string} p
 * @returns {boolean}
 */
export function pathIsInterpolable(p) {
  return typeof p === 'string' && p.length > 0 && SAFE_PATH.test(p);
}

/**
 * Reduce a set of case verdicts to the verdict for the run.
 * @param {readonly string[]} verdicts
 * @returns {string}
 */
export function worstVerdict(verdicts) {
  for (const candidate of VERDICT_RANK) {
    if (verdicts.includes(candidate)) return candidate;
  }
  return VERDICT_SOUND;
}

/**
 * @param {string} verdict
 * @returns {number}
 */
export function exitCodeFor(verdict) {
  if (verdict === VERDICT_SOUND) return EXIT_SOUND;
  if (verdict === VERDICT_UNUSABLE) return EXIT_UNDETERMINED;
  return EXIT_DEFECTIVE;
}

/**
 * The whole judgement, pure over already-collected readings.
 *
 * A reading of `null` means the arm did not produce one. It is NOT the same as
 * a reading of the empty string, which is a genuine answer — conflating them
 * is #214 instance 4 (an unfinished check's conclusion is "").
 *
 * @param {readonly {label: string, reading: string|null, expect?: string|undefined, error?: string|undefined}[]} cases
 * @returns {{verdict: string, blind: boolean, findings: string[], readings: {label: string, reading: string|null}[]}}
 */
export function classifyDiscrimination(cases) {
  const findings = [];
  const readings = cases.map((c) => ({ label: c.label, reading: c.reading }));

  if (!Array.isArray(cases) || cases.length < 2) {
    return {
      verdict: VERDICT_UNUSABLE,
      blind: false,
      findings: [
        'fewer than two cases: discrimination is undefined with one subject',
      ],
      readings,
    };
  }

  const perCase = [];

  for (const c of cases) {
    if (c.reading === null || c.reading === undefined) {
      findings.push(
        `${c.label}: no reading (${c.error ?? 'arm produced no result'})`,
      );
      perCase.push(VERDICT_UNUSABLE);
      continue;
    }
    if (c.expect !== undefined && c.expect !== c.reading) {
      findings.push(
        `${c.label}: expected ${JSON.stringify(c.expect)}, instrument said ${JSON.stringify(c.reading)}`,
      );
      perCase.push(VERDICT_MISREPORTS);
      continue;
    }
    perCase.push(VERDICT_SOUND);
  }

  // Blindness needs every reading present: you cannot show two things are the
  // same when one of them is missing.
  const present = cases.filter(
    (c) => c.reading !== null && c.reading !== undefined,
  );
  let blind = false;
  if (present.length === cases.length) {
    const distinct = new Set(present.map((c) => c.reading));
    if (distinct.size === 1) {
      blind = true;
      findings.unshift(
        `BLIND: every case returned ${JSON.stringify(present[0].reading)} — the instrument does not vary with the thing it is supposed to measure`,
      );
    }
  }

  const verdict = blind ? VERDICT_BLIND : worstVerdict(perCase);
  return { verdict, blind, findings, readings };
}

/**
 * Reduce raw output to the answer the caller actually acts on.
 *
 * THIS EXISTS BECAUSE THE TOOL CERTIFIED A DOCUMENTED LIAR.
 * Run live against #214's own instance 5 — `git branch -a --contains` — with
 * `reading: "stdout"` and no reduction, the verdict came back SOUND: the two
 * outputs differed, because an ancestor is reachable from more branches than
 * the tip is. But nobody consumes that text. What is consumed is "does the
 * list contain <branch>", and that answer is **yes for the tip and yes for the
 * ancestor** — the blindness #214 filed it for. The harness had compared a
 * neighbouring reading, which is the defect it exists to detect, committed by
 * the detector. So the spec must state the reduction, and the reduction is
 * the unit of discrimination.
 *
 * `lineCount` is here for a measured case of its own: `git ls-remote` returns
 * exit 0 for both a present and an absent branch, and only the line count
 * moves. An instrument whose exit code is constant across the two cases it
 * exists to separate is blind at the exit code and sound at the line count,
 * and the spec has to be able to say which one it is reading.
 *
 * @param {string} reduce
 * @param {string} raw
 * @returns {{ok: true, value: string} | {ok: false, reason: string}}
 */
export function applyReduce(reduce, raw) {
  if (reduce === 'raw') return { ok: true, value: raw };
  if (reduce === 'trim') return { ok: true, value: raw.trim() };
  if (reduce === 'empty') return { ok: true, value: String(raw.trim() === '') };
  if (reduce === 'lineCount') {
    const n = raw.split('\n').filter((l) => l.trim() !== '').length;
    return { ok: true, value: String(n) };
  }
  if (reduce.startsWith('contains:')) {
    const needle = reduce.slice('contains:'.length);
    if (needle === '')
      return { ok: false, reason: 'contains: needs a non-empty needle' };
    return { ok: true, value: String(raw.includes(needle)) };
  }
  return { ok: false, reason: `unsupported reduce ${JSON.stringify(reduce)}` };
}

export const REDUCERS = [
  'raw',
  'trim',
  'empty',
  'lineCount',
  'contains:<text>',
];

/**
 * @param {unknown} spec
 * @returns {{ok: true, spec: any} | {ok: false, reason: string}}
 */
export function validateSpec(spec) {
  if (spec === null || typeof spec !== 'object') {
    return { ok: false, reason: 'spec must be an object' };
  }
  const s = /** @type {any} */ (spec);
  if (typeof s.instrument !== 'string' || s.instrument.length === 0) {
    return { ok: false, reason: 'spec.instrument must be a non-empty string' };
  }
  const shell = s.shell ?? 'none';
  if (!['pwsh', 'sh', 'none'].includes(shell)) {
    return { ok: false, reason: `unsupported shell ${JSON.stringify(shell)}` };
  }
  if (shell === 'none') {
    if (!Array.isArray(s.command) || s.command.length === 0) {
      return {
        ok: false,
        reason: 'spec.command must be a non-empty array when shell is "none"',
      };
    }
    if (
      !s.command.some(
        (/** @type {unknown} */ el) =>
          typeof el === 'string' && PLACEHOLDER.test(el),
      )
    ) {
      return {
        ok: false,
        reason:
          'spec.command must contain at least one {{PLACEHOLDER}} element, or it cannot vary with the case',
      };
    }
  } else if (typeof s.script !== 'string' || !PLACEHOLDER.test(s.script)) {
    return {
      ok: false,
      reason:
        'spec.script must be a string containing at least one {{PLACEHOLDER}}, or it cannot vary with the case',
    };
  }
  const reading = s.reading ?? 'exitCode';
  if (!['exitCode', 'stdout'].includes(reading)) {
    return {
      ok: false,
      reason: `unsupported reading ${JSON.stringify(reading)}`,
    };
  }
  const reduce = s.reduce ?? 'raw';
  if (typeof reduce !== 'string') {
    return { ok: false, reason: 'spec.reduce must be a string' };
  }
  const probe = applyReduce(reduce, '');
  if (!probe.ok) return { ok: false, reason: probe.reason };
  if (reading === 'exitCode' && reduce !== 'raw') {
    return {
      ok: false,
      reason:
        'spec.reduce applies to stdout; an exit code is already the answer',
    };
  }
  if (reading === 'stdout' && reduce === 'raw') {
    return {
      ok: false,
      reason:
        'spec.reduce is required when reading stdout: comparing whole output certifies instruments that are blind to the answer you consume (see applyReduce). Use one of: ' +
        REDUCERS.filter((r) => r !== 'raw').join(', ') +
        '. If you genuinely consume the whole text, say "trim".',
    };
  }
  if (!Array.isArray(s.cases) || s.cases.length < 2) {
    return { ok: false, reason: 'spec.cases must list at least two cases' };
  }
  for (const c of s.cases) {
    if (c === null || typeof c !== 'object') {
      return { ok: false, reason: 'each case must be an object' };
    }
    if (typeof c.label !== 'string' || c.label.length === 0) {
      return { ok: false, reason: 'each case needs a non-empty label' };
    }
    const hasProbe = c.probe !== null && typeof c.probe === 'object';
    const hasVars =
      c.vars !== null && typeof c.vars === 'object' && c.vars !== undefined;
    if (!hasProbe && !hasVars) {
      return {
        ok: false,
        reason: `case ${c.label}: needs either a probe (harness-generated subject) or vars (a subject of your own)`,
      };
    }
    if (hasProbe) {
      if (!Number.isInteger(c.probe.exit)) {
        return {
          ok: false,
          reason: `case ${c.label}: probe.exit must be an integer`,
        };
      }
      if (c.probe.lines !== undefined && !Number.isInteger(c.probe.lines)) {
        return {
          ok: false,
          reason: `case ${c.label}: probe.lines must be an integer`,
        };
      }
    }
    if (hasVars) {
      for (const [k, v] of Object.entries(c.vars)) {
        if (typeof v !== 'string') {
          return {
            ok: false,
            reason: `case ${c.label}: vars.${k} must be a string`,
          };
        }
      }
    }
  }
  return { ok: true, spec: { ...s, shell, reading, reduce } };
}

const PROBE_SOURCE = `const n = Number(process.env.PROBE_LINES ?? '0');
for (let i = 0; i < n; i += 1) process.stdout.write('probe-line-' + i + '\\n');
process.exit(Number(process.env.PROBE_EXIT ?? '0'));
`;

/**
 * Build the argv to run for one case.
 *
 * `vars` are the case's own subject (ref pairs, strings, paths). They are
 * substituted as `{{NAME}}` and are ALSO exported as environment variables, so
 * a shell-free spec can read them without any interpolation at all.
 *
 * @param {{shell: string, script?: string, command?: string[]}} spec
 * @param {string} nodePath
 * @param {string} probePath
 * @param {Record<string,string>} [vars]
 * @returns {{ok: true, argv: string[]} | {ok: false, reason: string}}
 */
export function buildArgv(spec, nodePath, probePath, vars = {}) {
  /**
   * @param {string} text
   * @param {string} probeText
   * @returns {{ok: true, value: string} | {ok: false, reason: string}}
   */
  const substitute = (text, probeText) => {
    let out = text.split(PROBE_PLACEHOLDER).join(probeText);
    for (const [k, v] of Object.entries(vars)) {
      const token = `{{${k}}}`;
      if (!out.includes(token)) continue;
      if (spec.shell !== 'none' && !pathIsInterpolable(v)) {
        return {
          ok: false,
          reason: `refusing to interpolate vars.${k}: contains characters a shell may expand. Read it from the environment instead (it is exported as ${k}), or use shell "none".`,
        };
      }
      out = out.split(token).join(v);
    }
    return { ok: true, value: out };
  };

  if (spec.shell === 'none') {
    const argv = [];
    for (const el of spec.command ?? []) {
      if (el === PROBE_PLACEHOLDER) {
        argv.push(nodePath, probePath);
        continue;
      }
      const sub = substitute(el, `${nodePath} ${probePath}`);
      if (!sub.ok) return sub;
      argv.push(sub.value);
    }
    return { ok: true, argv };
  }
  if (!pathIsInterpolable(nodePath) || !pathIsInterpolable(probePath)) {
    return {
      ok: false,
      reason:
        'refusing to interpolate a path containing characters a shell may expand; use shell "none"',
    };
  }
  const quoted =
    spec.shell === 'pwsh'
      ? `& '${nodePath}' '${probePath}'`
      : `'${nodePath}' '${probePath}'`;
  const sub = substitute(spec.script ?? '', quoted);
  if (!sub.ok) return sub;
  return {
    ok: true,
    argv:
      spec.shell === 'pwsh'
        ? ['pwsh', '-NoProfile', '-Command', sub.value]
        : ['sh', '-c', sub.value],
  };
}

/**
 * @param {string[]} argv
 * @param {Record<string,string>} env
 * @returns {{status: number|null, stdout: string, error?: string|undefined}}
 */
export function runArgv(argv, env) {
  const [cmd, ...rest] = argv;
  const res = spawnSync(cmd, rest, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (res.error) {
    return {
      status: null,
      stdout: '',
      error: String(res.error.message ?? res.error),
    };
  }
  if (res.status === null) {
    return {
      status: null,
      stdout: res.stdout ?? '',
      error: 'process produced no exit status',
    };
  }
  return { status: res.status, stdout: res.stdout ?? '' };
}

/**
 * Turn one executed case into the reading the caller acts on.
 * @param {'exitCode'|'stdout'} reading
 * @param {{status: number|null, stdout: string, error?: string|undefined}} result
 * @param {string} [reduce]
 * @returns {{reading: string|null, error?: string|undefined}}
 */
export function readingFrom(reading, result, reduce = 'raw') {
  if (result.error !== undefined) return { reading: null, error: result.error };
  if (reading === 'exitCode') {
    return result.status === null
      ? { reading: null, error: 'no exit status' }
      : { reading: String(result.status) };
  }
  const reduced = applyReduce(reduce, result.stdout);
  return reduced.ok
    ? { reading: reduced.value }
    : { reading: null, error: reduced.reason };
}

/**
 * @param {any} spec
 * @param {(argv: string[], env: Record<string,string>) => {status: number|null, stdout: string, error?: string|undefined}} run
 * @param {string} nodePath
 * @param {string} probePath
 */
export function executeSpec(spec, run, nodePath, probePath) {
  return spec.cases.map((/** @type {any} */ c) => {
    const vars = c.vars ?? {};
    const built = buildArgv(spec, nodePath, probePath, vars);
    if (!built.ok) {
      return {
        label: c.label,
        reading: null,
        expect: c.expect,
        error: built.reason,
      };
    }
    const result = run(built.argv, {
      ...vars,
      PROBE_EXIT: String(c.probe?.exit ?? 0),
      PROBE_LINES: String(c.probe?.lines ?? 0),
    });
    const r = readingFrom(spec.reading, result, spec.reduce);
    return {
      label: c.label,
      reading: r.reading,
      expect: c.expect,
      error: r.error,
    };
  });
}

/**
 * @param {string} instrument
 * @param {ReturnType<typeof classifyDiscrimination>} outcome
 * @returns {string}
 */
export function formatOutcome(instrument, outcome) {
  const lines = [
    `instrument: ${instrument}`,
    `verdict:    ${outcome.verdict}`,
    '',
  ];
  for (const r of outcome.readings) {
    lines.push(
      `  ${r.reading === null ? '(no reading)' : JSON.stringify(r.reading)}  <- ${r.label}`,
    );
  }
  if (outcome.findings.length > 0) {
    lines.push('');
    for (const f of outcome.findings) lines.push(`  ! ${f}`);
  }
  if (outcome.verdict === VERDICT_SOUND) {
    lines.push('');
    lines.push(
      '  the instrument separated the cases; that is all this proves, and it',
    );
    lines.push('  proves it only for the cases you named.');
  }
  return lines.join('\n');
}

/**
 * @param {readonly string[]} argv
 * @returns {{spec?: string, help?: boolean}}
 */
export function parseArgs(argv) {
  /** @type {{spec?: string, help?: boolean}} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--spec') out.spec = argv[i + 1];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

const USAGE = `usage: node scripts/instrument-probe.mjs --spec <file.json>

Proves an instrument gives DIFFERENT readings for two cases you have
independently established are different. Refuses to certify one that does not.

A case supplies its subject either way round:
  "probe": { "exit": 3, "lines": 25 }   harness-generated: a command with a
                                        known exit code and output volume,
                                        substituted as {{PROBE}}
  "vars":  { "A": "...", "B": "..." }   your own subject, substituted as
                                        {{A}}/{{B}} and exported to the
                                        environment under the same names

Wrapper fidelity (does this pipeline lose the exit code?):
  {
    "instrument": "pwsh pipeline through Select-Object -First 1",
    "shell": "pwsh",
    "script": "$LASTEXITCODE=77; {{PROBE}} | Select-Object -First 1 > $null; exit $LASTEXITCODE",
    "reading": "exitCode",
    "cases": [
      { "label": "probe failed",    "probe": { "exit": 3, "lines": 25 }, "expect": "3" },
      { "label": "probe succeeded", "probe": { "exit": 0, "lines": 25 }, "expect": "0" }
    ]
  }

Predicate discrimination (does this command separate the two cases I mean?):
  {
    "instrument": "git branch -a --contains",
    "shell": "none",
    "command": ["git", "branch", "-a", "--contains", "{{SHA}}"],
    "reading": "stdout",
    "reduce": "contains:development",
    "cases": [
      { "label": "SHA is a branch tip",     "vars": { "SHA": "<tip sha>" } },
      { "label": "SHA is only an ancestor", "vars": { "SHA": "<ancestor sha>" } }
    ]
  }

"reduce" is REQUIRED when reading stdout, and it is the whole point: it names
the answer you act on. Comparing whole output certifies instruments that are
blind to that answer — measured, on this very example. Reducers:
  trim · empty · lineCount · contains:<text>

"expect" is optional. Omit it when you do not know what the instrument should
say but do know the two cases differ — blindness is still detectable, and
blindness is the member that costs the most.

DOMAIN. A SOUND verdict says the instrument separated the cases YOU named. It
says nothing about a third case, and nothing about whether the cases you named
are the ones your question turns on. Choosing them is the irreducible part and
no tool can do it for you.

exit 0 sound · 1 defective instrument · 2 could not be determined`;

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.spec) {
    process.stdout.write(USAGE + '\n');
    return args.help ? EXIT_SOUND : EXIT_UNDETERMINED;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(args.spec, 'utf8'));
  } catch (err) {
    process.stderr.write(`could not read spec: ${String(err)}\n`);
    return EXIT_UNDETERMINED;
  }

  const valid = validateSpec(parsed);
  if (!valid.ok) {
    process.stderr.write(`invalid spec: ${valid.reason}\n`);
    return EXIT_UNDETERMINED;
  }

  const dir = mkdtempSync(join(tmpdir(), 'instrument-probe-'));
  const probePath = join(dir, 'probe.mjs');
  try {
    writeFileSync(probePath, PROBE_SOURCE, 'utf8');

    // POSITIVE CONTROL, and it is not optional. Everything below reads the
    // probe's exit code back through the instrument; if the probe itself does
    // not vary, a BLIND verdict would be the harness's own defect reported as
    // the subject's. Run it bare first.
    const control = classifyDiscrimination(
      [
        { exit: 3, label: 'control: probe exits 3' },
        { exit: 0, label: 'control: probe exits 0' },
      ].map((c) => {
        const r = runArgv([process.execPath, probePath], {
          PROBE_EXIT: String(c.exit),
          PROBE_LINES: '25',
        });
        const read = readingFrom('exitCode', r);
        return {
          label: c.label,
          reading: read.reading,
          expect: String(c.exit),
          error: read.error,
        };
      }),
    );
    if (control.verdict !== VERDICT_SOUND) {
      process.stderr.write(
        'probe self-check failed: the harness cannot distinguish its own two cases, so no verdict about your instrument would mean anything\n',
      );
      process.stderr.write(
        formatOutcome('instrument-probe self-check', control) + '\n',
      );
      return EXIT_UNDETERMINED;
    }

    const cases = executeSpec(valid.spec, runArgv, process.execPath, probePath);
    const outcome = classifyDiscrimination(cases);
    process.stdout.write(formatOutcome(valid.spec.instrument, outcome) + '\n');
    return exitCodeFor(outcome.verdict);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
