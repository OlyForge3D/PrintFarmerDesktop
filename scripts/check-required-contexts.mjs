// Answers "is this pull request actually mergeable" by NAME, not by count.
//
// WHY THIS EXISTS
//
// Every session in this squad, including me, has reported readiness as a
// fraction: "11/11 pass", "9/9 green", "10/10". The required set is eight
// contexts BY NAME, and a head here carries ten to fifteen check runs. So the
// numerator and the denominator are both drawn from a population that is not
// the required set, and the fraction can be any of:
//
//   10/10 green with all eight required present      -> genuinely ready
//   9/9 green   with a required context ABSENT       -> not ready, reads ready
//   11/11 green with a required context ABSENT       -> not ready, reads ready
//
// A COUNT CANNOT DETECT AN ABSENT CONTEXT. That is the whole point. Nine of
// nine is nine of nine whether the tenth ran and passed, ran and failed, or
// never existed; the absent case removes a row from both sides of the fraction
// and leaves it looking perfect. The reassuring reading is the one you get for
// free, which is the property that makes this class of defect survive.
//
// ABSENT AND RED ARE DIFFERENT EVENTS AND GET DIFFERENT EXIT CODES
//
// A red required context is an honest report: something ran and said no, and it
// is visible in every UI. An absent one is silent by construction — there is no
// row to be red. They have different remedies (fix the code vs. find out why
// the workflow did not fire), so collapsing them into one non-zero code sends
// you to the wrong place. This is the same three-valued discipline recorded in
// check-merge-landed.mjs and instrument-probe.mjs: `if (!ok)` merges every
// failure mode toward the one you were already expecting.
//
//   0  every required context present and successful
//   1  a required context is present and NOT successful   (honestly red)
//   2  could not be determined                            (no credential, API)
//   3  a required context is ABSENT                       (never reported)
//
// 3 outranks 1 when both hold, and the reason is not severity. It is that a red
// context is already telling you about itself and an absent one is not, so the
// absent one is the finding you would otherwise leave with.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not read `mergeable` or `mergeStateStatus`. Both were observed this
// evening reading MERGEABLE at three consecutive states of the same PR
// (BEHIND -> BLOCKED -> CLEAN), and UNKNOWN permanently on merged PRs, where it
// means "no answer exists" rather than "not computed yet" — a liveness check
// keyed on it never terminates. Those fields answer a different question than
// the one asked here.
//
// It also does not merge anything. Deciding and acting are separate, and the
// party that would benefit from a permissive reading should not be the party
// producing it.

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REQUIRED_CONTEXT_NAMES } from './check-protection-assumptions.mjs';
import { discoverToken } from './check-merge-queue-contexts.mjs';
import { resolveRepository } from './check-pr-closure-scope.mjs';

export const EXIT_READY = 0;
export const EXIT_NOT_GREEN = 1;
export const EXIT_UNDETERMINED = 2;
export const EXIT_ABSENT = 3;

export const STATE_SUCCESS = 'SUCCESS';

/**
 * Pick the run that decides a context.
 *
 * A name can appear more than once — re-runs, and matrix jobs that report under
 * one name across attempts. GitHub decides on the LATEST, so taking the first
 * match would let a superseded red veto a repaired head, and taking "any
 * success" would let a stale green cover a fresh red. Ordering is by completion
 * where available and by start otherwise, because a run still in progress has
 * no completion time and must still be able to supersede an older one.
 *
 * @param {readonly {name?: string, status?: string, conclusion?: string|null, completedAt?: string|null, startedAt?: string|null}[]} runs
 * @param {string} name
 * @returns {{name?: string, status?: string, conclusion?: string|null, completedAt?: string|null, startedAt?: string|null} | null}
 */
export function latestRunNamed(runs, name) {
  const matches = (runs ?? []).filter((r) => r && r.name === name);
  if (matches.length === 0) return null;
  const keyOf = (/** @type {any} */ r) => r.completedAt ?? r.startedAt ?? '';
  let best = matches[0];
  for (const r of matches.slice(1)) {
    if (String(keyOf(r)) >= String(keyOf(best))) best = r;
  }
  return best;
}

/**
 * The judgement. Pure over already-collected rollup entries.
 *
 * @param {readonly string[]} required
 * @param {readonly {name?: string, status?: string, conclusion?: string|null, completedAt?: string|null, startedAt?: string|null}[]} runs
 * @returns {{absent: string[], notGreen: {name: string, state: string}[], pending: string[], green: string[], extra: number, exitCode: number}}
 */
export function evaluateRequiredContexts(required, runs) {
  const absent = [];
  const notGreen = [];
  const pending = [];
  const green = [];

  for (const name of required ?? []) {
    const run = latestRunNamed(runs ?? [], name);
    if (run === null) {
      absent.push(name);
      continue;
    }
    // An unfinished run has no conclusion, and "" is a real value there rather
    // than a missing one. Reporting it as not-green would be a lie in the
    // strict direction; reporting it as green would be one in the direction
    // that costs something. It is neither, so it gets its own bucket.
    if ((run.status ?? '') !== 'COMPLETED') {
      pending.push(name);
      continue;
    }
    if ((run.conclusion ?? '') !== STATE_SUCCESS) {
      notGreen.push({ name, state: run.conclusion ?? '(no conclusion)' });
      continue;
    }
    green.push(name);
  }

  const requiredNames = new Set(required ?? []);
  const seen = new Set(
    (runs ?? []).map((r) => r?.name).filter((n) => typeof n === 'string'),
  );
  let extra = 0;
  for (const n of seen) if (!requiredNames.has(n)) extra += 1;

  let exitCode = EXIT_READY;
  if (notGreen.length > 0 || pending.length > 0) exitCode = EXIT_NOT_GREEN;
  if (absent.length > 0) exitCode = EXIT_ABSENT;

  return { absent, notGreen, pending, green, extra, exitCode };
}

/**
 * @param {number} prNumber
 * @param {ReturnType<typeof evaluateRequiredContexts>} result
 * @param {readonly string[]} required
 * @returns {string}
 */
export function formatResult(prNumber, result, required) {
  const lines = [
    `PR #${prNumber}: ${result.green.length} of ${required.length} required contexts green, by name.`,
  ];
  for (const n of result.green) lines.push(`  ok      ${n}`);
  for (const n of result.pending) lines.push(`  pending ${n}`);
  for (const f of result.notGreen) lines.push(`  RED     ${f.name} ${f.state}`);
  for (const n of result.absent) lines.push(`  ABSENT  ${n}`);
  lines.push('');
  lines.push(
    `  ${result.extra} non-required check run name(s) also present. They are not ` +
      `evidence of readiness and are excluded from the count above — reporting ` +
      `them together cannot establish readiness for the ${required.length}-context gate.`,
  );
  if (result.absent.length > 0) {
    lines.push('');
    lines.push(
      '  A required context that never reported cannot go red. Find out why the ' +
        'workflow did not fire; do not re-run the ones that did.',
    );
  }
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @returns {{pr?: number, help?: boolean, error?: string}}
 */
export function parseArgs(argv) {
  /** @type {{pr?: number, help?: boolean, error?: string}} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--pr') {
      const v = argv[i + 1];
      i += 1;
      if (v === undefined || !/^[0-9]+$/.test(v)) {
        out.error = '--pr needs a number';
        continue;
      }
      out.pr = Number(v);
      continue;
    }
    out.error = `unrecognised argument ${JSON.stringify(a)}`;
  }
  return out;
}

const USAGE = `usage: node scripts/check-required-contexts.mjs --pr <number>

Verifies the required status checks BY NAME on a pull request's head, because
a count cannot detect a required context that never reported at all.

  0 ready · 1 a required context is red or pending · 2 undetermined ·
  3 a required context is ABSENT
`;

/**
 * The candidate names, by platform. Separated out so BOTH lists are pinned by
 * a test on every runner, rather than only the list the runner happens to use.
 *
 * @param {string} platform
 * @returns {string[]}
 */
export function ghCandidates(platform) {
  return platform === 'win32' ? ['gh.exe', 'gh', 'gh.cmd'] : ['gh'];
}

/**
 * MEASURED ON THIS MACHINE, and it is the reverse of what the repo's existing
 * comment says. check-merge-queue-contexts.mjs records that "`gh` is a .cmd
 * shim on Windows, which spawn cannot exec directly" and lists `gh.cmd` first.
 * Under Node 24:
 *
 *   gh.exe -> status 0        gh -> status 0        gh.cmd -> EINVAL
 *
 * So the first candidate is the only one that fails. That helper loops, so it
 * recovers silently and nobody noticed the premise had inverted. A single
 * hardcoded name does not recover, which is how the first draft of this file
 * reported "could not resolve the repository" on a machine where gh was logged
 * in and working. Try them all and say which one worked if none do.
 *
 * @param {typeof spawnSync} run
 * @param {readonly string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [platform] injected so BOTH candidate lists are testable on
 *   either runner. The first version read process.platform directly, and its
 *   fall-through test passed on Windows and FAILED on macOS — where the list
 *   has one entry and there is nothing to fall through to. CI caught it; the
 *   local run could not. A test whose meaning depends on which runner executes
 *   it is exactly the defect this file is about, one level up.
 * @returns {{status: number|null, stdout: string, stderr: string, spawned: boolean}}
 */
export function runGh(run, args, env, platform = process.platform) {
  const candidates = ghCandidates(platform);
  let last = { status: null, stdout: '', stderr: '', spawned: false };
  for (const command of candidates) {
    const r = run(command, [...args], { encoding: 'utf8', env });
    if (r.error) {
      last = {
        status: null,
        stdout: '',
        stderr: String(r.error.message ?? ''),
        spawned: false,
      };
      continue;
    }
    return {
      status: r.status,
      stdout: String(r.stdout ?? ''),
      stderr: String(r.stderr ?? ''),
      spawned: true,
    };
  }
  return last;
}

/**
 * Resolve owner/repo without letting a failure masquerade as a finding.
 *
 * FOUND BY RUNNING IT. The first version called resolveRepository() directly.
 * That function THROWS when GITHUB_REPOSITORY is unset and returns an
 * {owner, repo} object rather than a slug — I had assumed a falsy return and a
 * string, and never checked. The uncaught throw exited 1, which in this file's
 * own taxonomy means "a required context is red." So an environment problem was
 * reported as a verdict about the pull request, by the script whose entire
 * purpose is to keep those apart. main() is wrapped for the same reason: an
 * exception is not evidence about the subject.
 *
 * THAT WRAPPER HAS A BOUNDARY AND IT IS WORTH STATING, because I later walked
 * across it. It covers exceptions thrown from inside main(). It cannot cover a
 * failure to LOAD this module — ESM resolves the static import graph before
 * evaluating the file, so a missing sibling exits 1 with ERR_MODULE_NOT_FOUND
 * while main does not yet exist. Same laundering, one phase earlier, and no
 * in-process handler can reach it. tests/requiredContexts.test.ts asserts the
 * only decidable half: every sibling named below is on disk.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {string | null}
 */
export function resolveRepositorySlug(env, run) {
  try {
    const { owner, repo } = resolveRepository(env);
    return `${owner}/${repo}`;
  } catch {
    // Not set is the normal case on a developer machine. Ask gh, which is the
    // same credential and the same remote every other squad script uses.
    const r = runGh(
      run,
      ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      env,
    );
    if (!r.spawned || r.status !== 0) return null;
    const slug = r.stdout.trim();
    return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
  }
}

/**
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {number}
 */
export function main(argv, env = process.env, run = spawnSync) {
  try {
    return runMain(argv, env, run);
  } catch (err) {
    console.error(
      `check-required-contexts failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Exit 2, not a pass and not a finding about the pull request.',
    );
    return EXIT_UNDETERMINED;
  }
}

/**
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof spawnSync} run
 * @returns {number}
 */
function runMain(argv, env, run) {
  const args = parseArgs([...argv]);
  if (args.help) {
    console.log(USAGE);
    return EXIT_READY;
  }
  if (args.error !== undefined) {
    console.error(args.error);
    console.error(USAGE);
    return EXIT_UNDETERMINED;
  }
  if (args.pr === undefined) {
    console.error('--pr is required');
    console.error(USAGE);
    return EXIT_UNDETERMINED;
  }

  const token = discoverToken(env, run);
  if (token === null || token === '') {
    console.error(
      'no GitHub credential found, so readiness could not be determined. This is exit 2, not a pass.',
    );
    return EXIT_UNDETERMINED;
  }
  const repository = resolveRepositorySlug(env, run);
  if (!repository) {
    console.error('could not resolve the repository. Exit 2, not a pass.');
    return EXIT_UNDETERMINED;
  }

  const result = runGh(
    run,
    [
      'pr',
      'view',
      String(args.pr),
      '--repo',
      repository,
      '--json',
      'statusCheckRollup',
    ],
    { ...env, GH_TOKEN: token },
  );
  if (!result.spawned || result.status !== 0) {
    console.error(
      `gh pr view failed: ${result.stderr.trim() || 'no output'}. Exit 2, not a pass.`,
    );
    return EXIT_UNDETERMINED;
  }
  /** @type {{statusCheckRollup?: unknown[]}} */
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    console.error('could not parse gh output. Exit 2, not a pass.');
    return EXIT_UNDETERMINED;
  }

  const runs = /** @type {any[]} */ (parsed.statusCheckRollup ?? []);
  const evaluated = evaluateRequiredContexts([...REQUIRED_CONTEXT_NAMES], runs);
  console.log(formatResult(args.pr, evaluated, [...REQUIRED_CONTEXT_NAMES]));
  return evaluated.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2)));
}
