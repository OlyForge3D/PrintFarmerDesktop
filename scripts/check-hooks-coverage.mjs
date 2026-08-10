// Coverage for the guard `install-git-hooks.mjs` provides (#164), which is a
// different question from whether any ONE worktree is armed. #164 gave a
// worktree the ability to *report* itself unarmed; nothing enumerated the
// population those reports were supposed to cover. `hooks:verify` — the
// existing `--verify` flag on install-git-hooks.mjs — reads `process.cwd()`,
// so it only ever answers for the worktree the operator happens to be
// standing in. At the time #382 was filed nothing invoked it at all (a
// repo-wide search found only its own package.json definition and prose);
// `npm run hooks:verify` is now a CI step in ci.yml's `desktop` job, so it is
// exercised on every push, but that only ever answers for the single
// worktree a CI runner checks out. Nothing asked the coverage question at
// all: `grep 'worktree list' scripts/ tests/` was zero hits before this file.
//
// THIS SCRIPT is the coverage question: enumerate EVERY worktree of the
// clone via `git worktree list --porcelain` (which lists the main checkout
// first, then every linked worktree — see `git-worktree(1)`), run the exact
// same `verifyHooksArmed` check `install-git-hooks.mjs` uses on each one, and
// report armed/unarmed per worktree with its branch. Exit non-zero the
// instant any worktree is unarmed; exit zero only once every worktree in the
// population reports armed.
//
// WHY A LIFECYCLE HOOK CANNOT FIX THIS: `prepare` fires on `npm install`, so
// a worktree that already ran its install has spent the only event that
// would arm or re-check it. Long-lived worktrees created before the guard
// existed are exactly the population `prepare` cannot reach. This script
// does not rely on any lifecycle event — it walks the clone's own worktree
// list, which is unaffected by which worktrees have or have not installed.
//
// FAIL LOUD ON AN EMPTY POPULATION: `git worktree list --porcelain` always
// emits at least one `worktree ` line for the main checkout when it succeeds
// (per `git-worktree(1)`). Zero `worktree ` lines means the parse failed to
// recognise output it was given, or `git` failed silently — either way that
// is an instrument fault, not a clean bill, and reporting EXIT_CLEAN off an
// empty list would be indistinguishable from "coverage confirmed" when
// nothing was actually examined. See `evaluatePopulation` below.
//
// WINDOWS PATH CAUTION (the fault that motivated this file): `git worktree
// list --porcelain` emits forward slashes even on Windows
// (`D:/s/PrintFarmerDesktop`), while `path.resolve`/`realpathSync` on the
// same platform yield backslashes. A raw string comparison between the two
// forms silently fails, and it fails in the reassuring direction: the report
// reads "main checkout not found in the enumeration" — sounding like the
// main checkout is unaffected — when the truth is worse, the main checkout
// was examined and IS the worst-affected member. `normalizeSeparators` below
// exists solely to make that comparison honest, and
// `assertMainCheckoutPresent` exists so the main checkout's presence in the
// list is proven, not assumed.
//
// NOT WIRED TO CI, DELIBERATELY: a CI runner does a fresh clone and one
// `npm ci`, so it only ever has ONE worktree (the checkout the job runs in),
// and `prepare` arms that one worktree during the same install. This script
// would therefore pass on every single CI run regardless of whether the
// coverage defect this issue describes exists anywhere else in the fleet of
// developer worktrees — a check that can only ever pass on a runner proves
// nothing about the population the issue is actually about. Do not add
// `check:hooks-coverage` to `.github/workflows/ci.yml` on the theory that
// "more required checks are safer": on this one, a required, always-green
// context would look like proof of a property CI is structurally unable to
// observe.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { REQUIRED_HOOK, verifyHooksArmed } from './install-git-hooks.mjs';

export const EXIT_CLEAN = 0;
export const EXIT_UNARMED = 1;
export const EXIT_UNDETERMINED = 2;

/**
 * `git worktree list --porcelain` on Windows: `D:/s/PrintFarmerDesktop`.
 * `path.resolve`/`realpathSync` on the same platform: `D:\s\PrintFarmerDesktop`.
 * Comparing the two forms directly silently fails — see the Windows path
 * caution above. Normalising both sides to forward slashes (and stripping a
 * trailing slash) before any comparison is the fix.
 */
export function normalizeSeparators(candidate) {
  return candidate.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Parses the plain (non `-z`) `git worktree list --porcelain` format: one
 * blank-line-separated record per worktree, each a `worktree <path>` line
 * followed by either `HEAD <sha>` + `branch <ref>`, or `HEAD <sha>` +
 * `detached`, or (for a worktree whose checkout is currently missing on
 * disk) `HEAD <sha>` alone. Per `git-worktree(1)`, the FIRST record is
 * always the main worktree.
 *
 * Returns `[]` on output with no `worktree ` line at all — the caller
 * (`evaluatePopulation`) is responsible for treating that as an error, not
 * a clean pass; this function only parses, it does not judge.
 */
export function parsePorcelainWorktreeList(output) {
  const records = output
    .split(/\r?\n\r?\n/)
    .map((record) => record.trim())
    .filter((record) => record !== '');

  return records
    .filter((record) => record.startsWith('worktree '))
    .map((record) => {
      const lines = record.split(/\r?\n/);
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));
      const headLine = lines.find((line) => line.startsWith('HEAD '));
      const branchLine = lines.find((line) => line.startsWith('branch '));
      const detached = lines.some((line) => line === 'detached');

      const rawPath = worktreeLine.slice('worktree '.length).trim();
      return {
        path: rawPath,
        normalizedPath: normalizeSeparators(rawPath),
        headSha: headLine ? headLine.slice('HEAD '.length).trim() : null,
        branch: branchLine
          ? branchLine
              .slice('branch '.length)
              .trim()
              .replace(/^refs\/heads\//, '')
          : null,
        detached,
      };
    });
}

/**
 * Runs `git worktree list --porcelain` against `cwd` and parses it. Any
 * worktree of the clone can be used as `cwd` — the list it returns is
 * clone-wide, not scoped to the worktree the command runs from.
 */
export function enumerateWorktrees(cwd = process.cwd()) {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return parsePorcelainWorktreeList(output);
}

/**
 * FAIL LOUD on an empty population: zero `worktree ` lines is a broken
 * instrument, not a clone with nothing to check — `git worktree list
 * --porcelain` always lists at least the main checkout when it succeeds. A
 * checker that examined nothing must not report EXIT_CLEAN.
 */
export function evaluatePopulation(worktrees) {
  if (worktrees.length === 0) {
    return {
      ok: false,
      reason:
        '`git worktree list --porcelain` produced zero `worktree ` lines. ' +
        'That should never happen — it always lists at least the main ' +
        'checkout when it succeeds — so this is treated as a broken parse ' +
        'or a failed git invocation, not a clean bill. Refusing to report ' +
        'EXIT_CLEAN off an empty population.',
    };
  }
  return { ok: true };
}

/**
 * Proves the main checkout is actually IN the enumeration rather than
 * assuming it, comparing normalised (forward-slash) forms so a Windows
 * backslash path and git's forward-slash porcelain output are recognised as
 * the same directory. This is the exact assertion the issue's own repro
 * lacked: an unnormalised comparison there read "main checkout not in
 * worktree list" — a false negative in the reassuring direction, since the
 * main checkout was in fact the worst-affected worktree.
 */
export function assertMainCheckoutPresent(worktrees, mainCheckoutPath) {
  const normalizedTarget = normalizeSeparators(mainCheckoutPath);
  const match = worktrees.find(
    (worktree) => worktree.normalizedPath === normalizedTarget,
  );
  if (!match) {
    return {
      ok: false,
      reason:
        `main checkout (${mainCheckoutPath}, normalised: ${normalizedTarget}) ` +
        'was not found among the enumerated worktree paths ' +
        `(${worktrees.map((w) => w.normalizedPath).join(', ')}). Before ` +
        'trusting that, check for exactly the separator-mismatch bug this ' +
        'script exists to avoid: a comparison holding a backslash path ' +
        'against porcelain output that is always forward-slash, even on ' +
        'Windows.',
    };
  }
  return { ok: true, match };
}

/**
 * The pure judgement: given every enumerated worktree and, for each, whether
 * `verifyHooksArmed` reports it armed, decide per-worktree status and the
 * overall exit code. Exits non-zero the instant any worktree is unarmed,
 * zero only once every worktree reports armed — both arms are what the
 * issue requires demonstrated by tests.
 */
export function evaluateCoverage(entries) {
  const unarmed = entries.filter((entry) => !entry.status.armed);
  return {
    entries,
    unarmed,
    exitCode: unarmed.length > 0 ? EXIT_UNARMED : EXIT_CLEAN,
  };
}

function describeBranch(entry) {
  if (entry.branch) return entry.branch;
  if (entry.detached) return '(detached HEAD)';
  return '(unknown branch)';
}

export function formatReport(result) {
  const lines = [];
  const total = result.entries.length;
  const armedCount = total - result.unarmed.length;

  if (result.exitCode === EXIT_CLEAN) {
    lines.push(
      `[hooks-coverage] CLEAN — ${armedCount} of ${total} worktree(s) armed ` +
        `(${REQUIRED_HOOK} present at core.hooksPath).`,
    );
  } else {
    lines.push(
      `[hooks-coverage] UNARMED — ${result.unarmed.length} of ${total} ` +
        'worktree(s) are NOT guarded:',
    );
    for (const entry of result.unarmed) {
      lines.push(
        `  UNARMED  ${entry.path}  [${describeBranch(entry)}]  ${entry.status.reason}`,
      );
    }
  }

  lines.push('', 'Full population:');
  for (const entry of result.entries) {
    lines.push(
      `  ${entry.status.armed ? 'armed  ' : 'UNARMED'}  ${entry.path}  [${describeBranch(entry)}]`,
    );
  }

  return lines.join('\n');
}

/**
 * @param {string} [cwd]
 * @returns {{ exitCode: number, report: string }}
 */
export function runCheck(cwd = process.cwd()) {
  let worktrees;
  try {
    worktrees = enumerateWorktrees(cwd);
  } catch (error) {
    return {
      exitCode: EXIT_UNDETERMINED,
      report:
        '[hooks-coverage] UNDETERMINED — `git worktree list --porcelain` ' +
        `failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const population = evaluatePopulation(worktrees);
  if (!population.ok) {
    return {
      exitCode: EXIT_UNDETERMINED,
      report: `[hooks-coverage] UNDETERMINED — ${population.reason}`,
    };
  }

  let mainCheckoutPath;
  try {
    // `--git-common-dir` names the shared `.git` directory (the same one for
    // every worktree of the clone). For a standard, non-bare clone its
    // parent directory is the main checkout's own top level.
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8' },
    ).trim();
    mainCheckoutPath = path.dirname(commonDir);
  } catch (error) {
    return {
      exitCode: EXIT_UNDETERMINED,
      report:
        '[hooks-coverage] UNDETERMINED — could not resolve the main ' +
        `checkout path: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const presence = assertMainCheckoutPresent(worktrees, mainCheckoutPath);
  if (!presence.ok) {
    return {
      exitCode: EXIT_UNDETERMINED,
      report: `[hooks-coverage] UNDETERMINED — ${presence.reason}`,
    };
  }

  const entries = worktrees.map((worktree) => ({
    path: worktree.path,
    branch: worktree.branch,
    detached: worktree.detached,
    status: verifyHooksArmed(worktree.path),
  }));

  const result = evaluateCoverage(entries);
  return { exitCode: result.exitCode, report: formatReport(result) };
}

function main() {
  const cwd = process.cwd();
  let outcome;
  try {
    outcome = runCheck(cwd);
  } catch (error) {
    console.error(
      `[hooks-coverage] failed: ${error instanceof Error ? error.message : String(error)}. ` +
        'Exit 2, not a pass and not a finding about any worktree.',
    );
    process.exitCode = EXIT_UNDETERMINED;
    return;
  }
  if (outcome.exitCode === EXIT_CLEAN) {
    console.log(outcome.report);
  } else {
    console.error(outcome.report);
  }
  process.exitCode = outcome.exitCode;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
