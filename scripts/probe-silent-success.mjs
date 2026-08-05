#!/usr/bin/env node
// PIN #367's REMEDY LIST TO THE BEHAVIOUR IT RESTS ON.
//
// #367 catalogues commands that "succeed while carrying no information" and
// prescribes substitutes for them. Every one of those prescriptions is an
// EMPIRICAL CLAIM ABOUT GIT'S EXIT CODES AND OUTPUT, written down once:
//
//   instance 1  `git ls-remote <ref>` exits 0 with no output for an absent ref
//   remedy 1    `git ls-remote --exit-code` returns 2 instead
//   instance 2  `git diff -- <bad pathspec>` is byte-identical to "clean"
//   remedy 1    `git ls-files --error-unmatch <path>` errors instead
//   instance 8  `git rev-parse <sha>:<path>` cannot see the working tree
//   remedy 8    `git hash-object` / `git status --porcelain` can
//
// A claim like that decays SILENTLY. If a future git makes `git diff` complain
// about an unmatched pathspec, instance 2 becomes false and the issue keeps
// asserting it. If a future git makes `--exit-code` stop distinguishing, the
// REMEDY becomes false — and that direction is worse, because the repo will
// have migrated onto it by then. Nothing in a document disagrees with reality.
// This does.
//
// WHY THIS ONE CAN BE A CI GATE AND probe-sha-query CANNOT
//
// The sibling probe for #379 asks a rate-limited third-party API and needs a
// credential, so on `pull_request` a network flake would be indistinguishable
// from the finding changing. This probe builds its own git repository in a
// temporary directory and asks only local git. No network, no credential, no
// shared state, deterministic. That difference is the whole reason one is a
// tool and the other can be enforced.
//
// THE VERDICT IS PER-ARM AND THE TWO FAILURE DIRECTIONS ARE NOT THE SAME EDIT
//
// Six arms. Three are DEFECTS, and a defect arm is EXPECTED to be BLIND —
// blindness is the finding, not a fault. Three are SUBSTITUTES, expected
// SOUND. So the probe does not ask "is git well behaved"; it asks whether
// #367's text is still true of git, and reports which way it moved:
//
//   a defect arm that turns SOUND      git improved; the instance is now
//                                      historical and the issue overstates it
//   a substitute arm that turns BLIND  the repo has migrated onto an
//                                      instrument that no longer discriminates
//
// Both exit 1, and they demand OPPOSITE edits, so the report names the
// direction rather than a count. A count would send a reader to change the
// wrong sentence.
//
// TWO PRECONDITIONS, BOTH BEFORE ANY ARM IS READ
//
// If the fixture never builds, EVERY arm reads identically and comes back
// BLIND — which is the EXPECTED result for half of them. A completely broken
// run would then render as "the three findings reproduce, the three remedies
// are broken" and exit 1: a confident, detailed, entirely fabricated report.
// That is #367's own thesis pointed at this file, so it is answered
// structurally rather than promised:
//
//   P1  the fixture repository answers `cat-file -t HEAD` with "commit",
//       against a fabricated object that must NOT answer
//   P2  the working-tree mutation actually changed the bytes on disk, read
//       with node's fs and NOT with git
//
// P2 is the #229 precondition: a test that passes because the condition it
// tolerates never arose is indistinguishable from one that passes because the
// tolerance works. Arms 5, 6 and 7 all measure "clean vs mutated", and if the
// mutation silently failed they would agree — soundly, about nothing. P2 is
// read through fs precisely BECAUSE git is the subject; asking the instrument
// under test whether the experiment happened is the defect this file exists
// to catch.
//
// A FAILED PRECONDITION IS ALWAYS EXIT 2, never 1. "The experiment did not
// run" must never be reported in the same channel as "the answer changed".
//
// DOMAIN
//
// This pins git's behaviour on THIS machine's git, for the six readings #367
// names. It does not establish that the repo's scripts use the sound member of
// each pair — that is a separate question and `check-script-reachability` is
// the wrong tool for it. It also cannot enumerate silently-permissive commands
// nobody has noticed yet; it only stops the ones already catalogued from
// rotting.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * A well-formed object name that cannot exist in a fixture repository built
 * seconds ago. Fabricated, not malformed: a malformed name is rejected by the
 * argument parser, which separates "could not parse" from "could not find" and
 * so proves nothing about lookup.
 */
export const FABRICATED_OBJECT = '0123456789abcdef0123456789abcdef01234567';

export const ABSENT_REF = 'refs/heads/zzq-no-such-branch';
export const ABSENT_PATH = 'zzq-no-such-file.txt';
export const FIXTURE_BRANCH = 'probe-main';
export const STABLE_FILE = 'stable.txt';
export const MUTATED_FILE = 'tracked.txt';
export const COMMITTED_BYTES = 'committed contents\n';
export const MUTATED_BYTES = 'working tree contents, never committed\n';

/**
 * Each arm is a PAIR, because discrimination is undefined for one subject.
 *
 * `expect` is what #367 currently asserts. `role` says which sentence in the
 * issue has to change when the arm moves, and that is why it is recorded here
 * rather than inferred from `expect` at report time: the two happen to
 * correspond today, and a reader repairing this file later should not have to
 * rediscover that the correspondence was incidental.
 */
export const ARMS = Object.freeze([
  Object.freeze({
    id: 'ls-remote-bare',
    role: ROLE_DEFECT,
    reading: 'exitCode',
    expect: VERDICT_BLIND,
    cites: '#367 instance 1',
    claim: '`git ls-remote <ref>` exits 0 whether or not the ref exists',
  }),
  Object.freeze({
    id: 'ls-remote-exit-code',
    role: ROLE_SUBSTITUTE,
    reading: 'exitCode',
    expect: VERDICT_SOUND,
    cites: '#367 remedy 1',
    claim: '`git ls-remote --exit-code` separates present from absent',
  }),
  Object.freeze({
    id: 'diff-pathspec',
    role: ROLE_DEFECT,
    reading: 'byteCount',
    expect: VERDICT_BLIND,
    cites: '#367 instance 2',
    claim:
      '`git diff -- <path>` is byte-identical for an unchanged path and a path that does not exist',
  }),
  Object.freeze({
    id: 'ls-files-error-unmatch',
    role: ROLE_SUBSTITUTE,
    reading: 'exitCode',
    expect: VERDICT_SOUND,
    cites: '#367 remedy 1',
    claim:
      '`git ls-files --error-unmatch <path>` separates a real path from an absent one',
  }),
  Object.freeze({
    id: 'rev-parse-commit-relative',
    role: ROLE_DEFECT,
    reading: 'stdout',
    expect: VERDICT_BLIND,
    cites: '#367 instance 8',
    claim:
      '`git rev-parse <sha>:<path>` returns the same hash whether or not the working file was damaged',
  }),
  Object.freeze({
    id: 'hash-object-working-tree',
    role: ROLE_SUBSTITUTE,
    reading: 'stdout',
    expect: VERDICT_SOUND,
    cites: '#367 remedy 8',
    claim: '`git hash-object <path>` hashes the bytes actually on disk',
  }),
  Object.freeze({
    id: 'status-porcelain',
    role: ROLE_SUBSTITUTE,
    reading: 'stdout',
    expect: VERDICT_SOUND,
    cites: '#367 remedy 8',
    claim: '`git status --porcelain` is non-empty for a damaged working tree',
  }),
]);

/**
 * Compare an observed verdict against what #367 asserts.
 *
 * UNUSABLE and VACUOUS are deliberately NOT folded into CHANGED. Neither says
 * anything about git's behaviour — one means an arm produced no reading, the
 * other means the case pair separated for a reason unrelated to the predicate.
 * Reporting either as "the claim changed" would send someone to edit a true
 * sentence.
 *
 * @param {{id: string, role: string, expect: string, cites: string, claim: string}} arm
 * @param {{verdict: string, findings: string[], readings: {label: string, reading: string|null}[]}} classified
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
  if (observed === arm.expect) {
    status = STATUS_HOLDS;
  } else if (observed === VERDICT_SOUND || observed === VERDICT_BLIND) {
    status = STATUS_CHANGED;
    direction =
      arm.role === ROLE_DEFECT
        ? 'git now discriminates here, so this instance is historical and the issue overstates it'
        : 'the substitute no longer discriminates, so anything migrated onto it is unguarded';
  } else {
    status = STATUS_UNDETERMINED;
    direction = `no reading about git's behaviour: ${observed}`;
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
 * Preconditions outrank every arm, and they are read first.
 *
 * The ordering is the entire point. A broken fixture makes half the arms come
 * back BLIND, which is the expected reading for exactly those arms, so a
 * rule that consulted the arms first would publish a matching set from an
 * experiment that never happened.
 *
 * @param {readonly {id: string, satisfied: boolean, detail: string}[]} preconditions
 * @param {readonly {status: string}[]} judged
 * @returns {{exitCode: number, summary: string}}
 */
export function overallVerdict(preconditions, judged) {
  const failed = (preconditions ?? []).filter((p) => !p.satisfied);
  if (failed.length > 0) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary: `precondition not satisfied (${failed
        .map((p) => p.id)
        .join(', ')}): the experiment did not run, so no arm below is evidence`,
    };
  }
  if (!Array.isArray(judged) || judged.length === 0) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary: 'no arms were read',
    };
  }
  const undetermined = judged.filter((a) => a.status === STATUS_UNDETERMINED);
  if (undetermined.length > 0) {
    return {
      exitCode: EXIT_UNDETERMINED,
      summary: `${undetermined.length} arm(s) produced no reading about git's behaviour`,
    };
  }
  const changed = judged.filter((a) => a.status === STATUS_CHANGED);
  if (changed.length > 0) {
    return {
      exitCode: EXIT_CHANGED,
      summary: `${changed.length} of ${judged.length} arm(s) no longer match #367; the issue's text is out of date in the direction named per arm`,
    };
  }
  return {
    exitCode: EXIT_HOLDS,
    summary: `all ${judged.length} arm(s) match #367: every catalogued defect still reproduces and every prescribed substitute still discriminates`,
  };
}

/**
 * @param {readonly {id: string, satisfied: boolean, detail: string}[]} preconditions
 * @param {readonly ReturnType<typeof judgeArm>[]} judged
 * @param {{exitCode: number, summary: string}} verdict
 * @returns {string}
 */
export function formatReport(preconditions, judged, verdict) {
  const lines = [];
  lines.push('PRECONDITIONS (read before any arm; a failure here is exit 2)');
  for (const p of preconditions ?? []) {
    lines.push(`  ${p.satisfied ? 'ok  ' : 'FAIL'} ${p.id} — ${p.detail}`);
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

/**
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  }
  return {
    status: typeof result.status === 'number' ? result.status : 128,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Build a throwaway repository with a committed baseline and a working-tree
 * mutation. Identity and signing are pinned on the command line rather than
 * read from the environment, so the probe cannot fail because the machine
 * running it has a commit hook or a gpg key.
 *
 * @returns {{dir: string}}
 */
export function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-silent-'));
  const id = [
    '-c',
    'user.name=probe',
    '-c',
    'user.email=probe@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
  ];
  runGit(['-c', `init.defaultBranch=${FIXTURE_BRANCH}`, 'init', '.'], dir);
  writeFileSync(join(dir, STABLE_FILE), COMMITTED_BYTES);
  writeFileSync(join(dir, MUTATED_FILE), COMMITTED_BYTES);
  runGit([...id, 'add', '.'], dir);
  runGit([...id, 'commit', '-m', 'fixture baseline'], dir);
  return { dir };
}

/**
 * @param {string} dir
 * @param {boolean} mutated
 */
export function setWorkingTree(dir, mutated) {
  writeFileSync(
    join(dir, MUTATED_FILE),
    mutated ? MUTATED_BYTES : COMMITTED_BYTES,
  );
}

/**
 * P1's judgement, pure over the two readings.
 *
 * SPLIT OUT BECAUSE THE THIRD CLAUSE WAS OTHERWISE UNFALSIFIABLE. Requiring
 * the fabricated object to be REFUSED is the half of P1 that does real work —
 * without it, a git that answers every lookup satisfies the precondition — and
 * no test can reach it through the filesystem, because there is no directory
 * in which a fabricated 40-hex name resolves. Writing the assertion against
 * `detail` instead was the first thing I tried, and asserting a sentence about
 * a behaviour is not a test of the behaviour: it is #367's own defect, a check
 * that answers a neighbouring question, committed inside #367's probe.
 *
 * Taking data rather than a directory is what makes all four combinations
 * constructible from a plain object.
 *
 * @param {{realStatus: number, realType: string, fabricatedStatus: number}} readings
 * @returns {boolean}
 */
export function judgeFixture({ realStatus, realType, fabricatedStatus }) {
  return realStatus === 0 && realType === 'commit' && fabricatedStatus !== 0;
}

/**
 * P2's judgement, pure over the two byte strings.
 *
 * Both directions are required. Checking only that the mutated read differs
 * would pass for a directory whose writes never land at all, because the
 * restore would differ too.
 *
 * @param {{onDisk: string, restored: string}} readings
 * @returns {boolean}
 */
export function judgeMutationReached({ onDisk, restored }) {
  return onDisk === MUTATED_BYTES && restored === COMMITTED_BYTES;
}

/**
 * P1 and P2. Both are measured, neither is assumed, and P2 deliberately does
 * not ask git.
 *
 * @param {string} dir
 * @returns {{id: string, satisfied: boolean, detail: string}[]}
 */
export function readPreconditions(dir) {
  const real = runGit(['cat-file', '-t', 'HEAD'], dir);
  const fabricated = runGit(['cat-file', '-t', FABRICATED_OBJECT], dir);
  const p1 = judgeFixture({
    realStatus: real.status,
    realType: real.stdout.trim(),
    fabricatedStatus: fabricated.status,
  });

  setWorkingTree(dir, true);
  const onDisk = readFileSync(join(dir, MUTATED_FILE), 'utf8');
  setWorkingTree(dir, false);
  const restored = readFileSync(join(dir, MUTATED_FILE), 'utf8');
  const p2 = judgeMutationReached({ onDisk, restored });

  return [
    {
      id: 'P1-fixture-is-a-repository',
      satisfied: p1,
      detail: `cat-file -t HEAD => ${JSON.stringify(real.stdout.trim())} (exit ${real.status}); fabricated object exit ${fabricated.status} (must be non-zero)`,
    },
    {
      id: 'P2-mutation-reaches-the-disk',
      satisfied: p2,
      detail: p2
        ? 'the working file differs from the committed bytes when mutated and matches when restored, read with fs rather than git'
        : 'the working-tree write did not take effect, so every clean-vs-mutated arm would agree about nothing',
    },
  ];
}

/**
 * @param {string} dir
 * @param {string} id
 * @returns {{label: string, reading: string|null, error?: string}[]}
 */
export function readArm(dir, id) {
  const exit = (args) => String(runGit(args, dir).status);
  const out = (args) => runGit(args, dir).stdout.trim();
  const bytes = (args) => String(runGit(args, dir).stdout.length);
  const url = pathToFileURL(dir).href;

  if (id === 'ls-remote-bare') {
    return [
      {
        label: 'present ref',
        reading: exit(['ls-remote', url, `refs/heads/${FIXTURE_BRANCH}`]),
      },
      { label: 'absent ref', reading: exit(['ls-remote', url, ABSENT_REF]) },
    ];
  }
  if (id === 'ls-remote-exit-code') {
    return [
      {
        label: 'present ref',
        reading: exit([
          'ls-remote',
          '--exit-code',
          url,
          `refs/heads/${FIXTURE_BRANCH}`,
        ]),
      },
      {
        label: 'absent ref',
        reading: exit(['ls-remote', '--exit-code', url, ABSENT_REF]),
      },
    ];
  }
  if (id === 'diff-pathspec') {
    setWorkingTree(dir, false);
    return [
      {
        label: 'path exists and matches',
        reading: bytes(['diff', 'HEAD', '--', STABLE_FILE]),
      },
      {
        label: 'path does not exist',
        reading: bytes(['diff', 'HEAD', '--', ABSENT_PATH]),
      },
    ];
  }
  if (id === 'ls-files-error-unmatch') {
    return [
      {
        label: 'path exists',
        reading: exit(['ls-files', '--error-unmatch', STABLE_FILE]),
      },
      {
        label: 'path does not exist',
        reading: exit(['ls-files', '--error-unmatch', ABSENT_PATH]),
      },
    ];
  }
  if (id === 'rev-parse-commit-relative') {
    setWorkingTree(dir, false);
    const clean = out(['rev-parse', `HEAD:${MUTATED_FILE}`]);
    setWorkingTree(dir, true);
    const damaged = out(['rev-parse', `HEAD:${MUTATED_FILE}`]);
    setWorkingTree(dir, false);
    return [
      { label: 'working tree clean', reading: clean },
      { label: 'working tree damaged', reading: damaged },
    ];
  }
  if (id === 'hash-object-working-tree') {
    setWorkingTree(dir, false);
    const clean = out(['hash-object', MUTATED_FILE]);
    setWorkingTree(dir, true);
    const damaged = out(['hash-object', MUTATED_FILE]);
    setWorkingTree(dir, false);
    return [
      { label: 'working tree clean', reading: clean },
      { label: 'working tree damaged', reading: damaged },
    ];
  }
  if (id === 'status-porcelain') {
    setWorkingTree(dir, false);
    const clean = out(['status', '--porcelain']);
    setWorkingTree(dir, true);
    const damaged = out(['status', '--porcelain']);
    setWorkingTree(dir, false);
    return [
      { label: 'working tree clean', reading: clean },
      { label: 'working tree damaged', reading: damaged },
    ];
  }
  throw new Error(`unknown arm: ${id}`);
}

export const USAGE = `Usage: node scripts/probe-silent-success.mjs

Re-runs the measurements #367 records about git's silently permissive commands
and the substitutes it prescribes, in a throwaway repository.

  0  every catalogued defect still reproduces and every substitute still
     discriminates, so #367's text is still true of this machine's git
  1  at least one claim no longer holds; the report names which direction
  2  the experiment did not run
`;

export function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return EXIT_HOLDS;
  }

  let fixture = null;
  try {
    fixture = buildFixture();
  } catch (error) {
    process.stdout.write(
      `exit ${EXIT_UNDETERMINED}: the fixture repository could not be built (${
        error instanceof Error ? error.message : String(error)
      }); nothing was measured\n`,
    );
    return EXIT_UNDETERMINED;
  }

  try {
    const preconditions = readPreconditions(fixture.dir);
    const judged = [];
    if (preconditions.every((p) => p.satisfied)) {
      for (const arm of ARMS) {
        let cases;
        try {
          cases = readArm(fixture.dir, arm.id);
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
        judged.push(judgeArm(arm, classifyDiscrimination(cases, arm.reading)));
      }
    }
    const verdict = overallVerdict(preconditions, judged);
    process.stdout.write(`${formatReport(preconditions, judged, verdict)}\n`);
    return verdict.exitCode;
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
