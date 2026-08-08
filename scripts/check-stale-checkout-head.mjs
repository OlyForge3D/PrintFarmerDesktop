#!/usr/bin/env node
// Refuses to trust a PR head read from a shared checkout without corroborating
// it against the remote, because `gh pr checkout` leaves an instrument that
// looks live and is not.
//
// #473: `gh pr checkout 423` in the shared main checkout created
// `refs/heads/pr-423` with NO UPSTREAM CONFIGURED.
//
//   git for-each-ref --format='%(refname:short)|%(upstream:short)|%(upstream:track)' refs/heads/pr-423
//     ->  pr-423||                <- no upstream, no track, no warning
//
//   git fetch --all
//   git rev-parse refs/heads/pr-423
//     ->  5de53e13...             <- unchanged, as designed
//
// Three sessions read that branch over several hours and each reported
// `5de53e13` as PR #423's head, describing the read as "verified live". The
// live head had moved to `9119b5df` hours earlier. Nothing on screen ever
// contradicted them: a branch with no upstream cannot report `[behind N]`,
// because behind-ness is computed against an upstream it does not have, and a
// later `git fetch` moves `origin/*` without ever touching a local branch.
//
// WHY THIS READS AS CORROBORATION AND IS NOT ONE
//
// Because the stale ref lives in the SHARED checkout, every session reading it
// gets the identical wrong answer. Independent-looking reports that all trace
// back to one un-refreshed local ref are one mechanism, not three, and
// agreement between them is not corroboration (`.squad/decisions.md:305`).
// Every downstream figure fingerprints the source exactly — this repository's
// own measurement: `check-runs total_count @5de53e13 = 10` vs `@9119b5df = 11`
// — so "10/10 checks green" and "verified live" were both, silently, reports
// about a commit that was no longer the PR's head.
//
// THE REMEDY, taken directly from #473: read the head as an OUTPUT, never as
// an INPUT. A local branch ref is an input — it sits still until something
// moves it, and nothing but `git fetch <that branch>` does. The two sources
// this file reads instead are outputs of the read itself, freshly asked on
// every invocation:
//
//   gh api repos/<owner>/<repo>/pulls/<n> --jq .head.sha     (--pr <n>)
//   git ls-remote origin refs/heads/<branch>                 (no --pr)
//
// Neither depends on any local ref having been fetched recently, which is
// exactly the property the local branch lacked.
//
// A LOCAL BRANCH WITH NO UPSTREAM IS THE HAZARD, NOT ONLY A STALE ONE
//
// Reporting "stale" only when the SHAs already disagree would still bless
// `refs/heads/pr-423` on the day it was created, when it happened to be
// correct — and #473's own finding is that its correctness that day is what
// let it stand unquestioned for hours afterward. So an untracked local branch
// is refused even when its SHA matches the live head right now: a match today
// asserts nothing about whether anything will notice the branch move
// tomorrow, because nothing will.
//
// CONTROLS, so a check that reports "fresh" is not indistinguishable from one
// that cannot tell. #473 says so explicitly: "a check that has never fired is
// indistinguishable from one that cannot fire", and asks for "a negative
// control arm that feeds it a known-stale SHA and confirms it rejects".
// `evaluateControls` below is exactly that, run on every invocation against
// the real reads of this run rather than only in tests.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERDICT_FRESH = 'fresh';
export const VERDICT_STALE = 'stale';
export const VERDICT_UNTRACKED = 'untracked';
export const VERDICT_UNVERIFIABLE = 'unverifiable';

export const EXIT_OK = 0;
export const EXIT_STALE = 1;
export const EXIT_UNTRACKED = 2;
export const EXIT_UNVERIFIABLE = 3;

// A 40-hex string that is not a commit in any repository this file queries.
// The negative control asserts a real head never matches it; if it ever does,
// the comparison is saturating and every "fresh" verdict in the run is
// worthless. This is the "known-stale SHA" #473 asks the control to feed in.
export const FABRICATED_SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * A SHA is untrusted input here in the same sense it is in
 * check-review-head-coverage.mjs: `gh`/git can render it null, abbreviated, or
 * differently cased, and any of those must not silently compare equal to an
 * otherwise-identical head, nor silently compare equal to each other by both
 * being coerced to the same falsy value.
 */
export function normalizeSha(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

/**
 * The one comparison this whole instrument rests on. `localSha` is what a
 * report would have quoted before this file existed; `liveSha` is read fresh,
 * as an output, from the remote (`ls-remote`) or the API (`pulls/<n>.head.sha`)
 * rather than from any local ref. `upstream` is the branch's configured
 * upstream (`git for-each-ref %(upstream:short)`), empty string or nullish
 * when there is none.
 *
 * Ordering is load-bearing: the SHA comparison runs before the upstream check,
 * so a genuine divergence is always reported as STALE and never masked behind
 * an "untracked" verdict that undersells it.
 */
export function classifyHeadFreshness({ localSha, liveSha, upstream } = {}) {
  const local = normalizeSha(localSha);
  const live = normalizeSha(liveSha);

  if (local === null || live === null) {
    return {
      verdict: VERDICT_UNVERIFIABLE,
      exitCode: EXIT_UNVERIFIABLE,
      reason:
        `cannot compare: local sha ${JSON.stringify(localSha)} and live sha ${JSON.stringify(liveSha)} ` +
        'do not both normalize to a usable 40-hex commit',
    };
  }

  if (local !== live) {
    return {
      verdict: VERDICT_STALE,
      exitCode: EXIT_STALE,
      reason:
        `local head ${local.slice(0, 8)} does not match the live head ${live.slice(0, 8)}; ` +
        'the checkout has diverged from the branch it was read from, and any report quoting ' +
        `${local.slice(0, 8)} as "verified live" is reporting a source, not the branch`,
    };
  }

  const hasUpstream = typeof upstream === 'string' && upstream.trim() !== '';
  if (!hasUpstream) {
    return {
      verdict: VERDICT_UNTRACKED,
      exitCode: EXIT_UNTRACKED,
      reason:
        `local head ${local.slice(0, 8)} matches the live head right now, but this branch has no ` +
        'upstream configured (as `gh pr checkout <n>` leaves it), so nothing will notice or report ' +
        'it when the two next diverge; a match today proves nothing about tomorrow',
    };
  }

  return {
    verdict: VERDICT_FRESH,
    exitCode: EXIT_OK,
    reason: `local head ${local.slice(0, 8)} matches the live head and tracks ${upstream}`,
  };
}

/**
 * Both controls, over the actual reads this run collected.
 *
 * NEGATIVE (the one #473 names explicitly): a fabricated, deliberately wrong
 * "live" sha must never be reported FRESH against the real local sha. If it
 * is, the comparison always says yes and every FRESH verdict this run could
 * produce is worthless.
 *
 * POSITIVE: the real local sha, compared against ITSELF as the live sha, must
 * be reported FRESH. A negative control alone cannot catch a matcher that
 * never matches anything — that passes the negative control perfectly while
 * being just as useless.
 *
 * Both controls exercise the SHA-comparison half of `classifyHeadFreshness`
 * only, so they always pass a synthetic, present upstream (`origin/control`)
 * regardless of the real branch's own tracking state. The real branch's
 * upstream is exactly what may be untracked here — that is the defect this
 * file exists to catch — so the control must not borrow it: a broken
 * (missing) real upstream must never be able to fail the positive control and
 * mask a genuine STALE/UNTRACKED verdict behind an UNVERIFIABLE one.
 */
export function evaluateControls({ localSha } = {}) {
  const local = normalizeSha(localSha);
  const failures = [];

  if (local === null) {
    return {
      passed: false,
      failures: [
        'controls unavailable: no usable local sha was read this run, so neither control has anything to drive',
      ],
    };
  }

  const negative = classifyHeadFreshness({
    localSha: local,
    liveSha: FABRICATED_SHA,
    upstream: 'origin/control',
  });
  if (negative.verdict === VERDICT_FRESH) {
    failures.push(
      'negative control failed: a fabricated, known-stale head was reported FRESH against the real local head, so the comparison is saturating',
    );
  }

  const positive = classifyHeadFreshness({
    localSha: local,
    liveSha: local,
    upstream: 'origin/control',
  });
  if (positive.verdict !== VERDICT_FRESH) {
    failures.push(
      `positive control failed: the local head did not match itself (${positive.verdict}), so the comparison is dead`,
    );
  }

  return { passed: failures.length === 0, failures };
}

export function formatResult(result, { branch, prNumber } = {}) {
  const label =
    result.exitCode === EXIT_OK
      ? 'FRESH'
      : result.exitCode === EXIT_STALE
        ? 'STALE'
        : result.exitCode === EXIT_UNTRACKED
          ? 'UNTRACKED'
          : 'UNVERIFIABLE';
  const lines = [`[stale-checkout-head] ${label} (${result.verdict})`];
  if (branch) lines.push(`  branch  ${branch}`);
  if (prNumber !== undefined) lines.push(`  pr      #${prNumber}`);
  lines.push(`  ${result.reason}`);
  if (
    result.verdict === VERDICT_STALE ||
    result.verdict === VERDICT_UNTRACKED
  ) {
    lines.push(
      '  Do not trust this checkout for the branch head. Re-read it as an output: ' +
        '`gh api repos/<owner>/<repo>/pulls/<n> --jq .head.sha` or `git ls-remote origin <branch>`.',
    );
  }
  return lines.join('\n');
}

// --- effects ---------------------------------------------------------------

function git(args, { allowFailure = false } = {}) {
  try {
    return {
      code: 0,
      stdout: execFileSync('git', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    if (!allowFailure) {
      throw error;
    }
    return { code: error.status ?? 128, stdout: '' };
  }
}

export function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], {
    allowFailure: true,
  }).stdout.trim();
}

/**
 * The SHA a naive read of this checkout would have quoted before this file
 * existed. This IS the input the whole check exists to distrust — it is
 * deliberately never treated as ground truth on its own.
 */
export function readLocalSha(branch) {
  const result = git(['rev-parse', `refs/heads/${branch}`], {
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * `%(upstream:short)`, empty string when the branch has none — exactly the
 * shape #473 reproduced: `pr-423||` with nothing before either pipe.
 */
export function readUpstream(branch) {
  const result = git(
    ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`],
    { allowFailure: true },
  );
  return result.code === 0 ? result.stdout.trim() : '';
}

/**
 * The live head, read as an OUTPUT via `git ls-remote` against the remote
 * directly — no local ref, cached or otherwise, is consulted. Returns null
 * when the remote has no branch of this name, which is exactly the state a
 * PR-number checkout with no upstream leaves nothing to compare against
 * without `--pr`.
 */
export function readRemoteBranchHead(branch, remote = 'origin') {
  const result = git(
    ['ls-remote', '--exit-code', remote, `refs/heads/${branch}`],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return null;
  }
  const sha = result.stdout.split(/\s+/, 1)[0];
  return sha ?? null;
}

function resolveRepository() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  const remote = git(['remote', 'get-url', 'origin'], {
    allowFailure: true,
  }).stdout.trim();
  const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  if (!match) {
    throw new Error(
      `cannot resolve a repository from origin (${remote || 'unset'})`,
    );
  }
  return match[1];
}

/**
 * The other output-read #473 names: the PR object's own `head.sha`, which is
 * GitHub's live answer to "what commit is this PR at right now" and carries no
 * dependency on any ref this checkout has or has not fetched.
 */
export async function fetchPrHeadSha({ repository, prNumber, token }) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'check-stale-checkout-head',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for pull #${prNumber}`);
  }
  const payload = await response.json();
  return payload?.head?.sha ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  let prNumber;
  let branch;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--pr') {
      prNumber = Number.parseInt(args[index + 1], 10);
      index += 1;
    } else if (!arg.startsWith('-')) {
      branch = arg;
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)}; usage: check-stale-checkout-head [--pr <n>] [branch]`,
      );
    }
  }

  branch = branch ?? currentBranch();
  if (!branch) {
    console.error(
      '[stale-checkout-head] no branch given and HEAD is not on a named branch',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const localSha = readLocalSha(branch);
  if (localSha === null) {
    console.error(
      `[stale-checkout-head] refs/heads/${branch} does not exist locally; nothing to verify`,
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const upstream = readUpstream(branch);

  let liveSha;
  if (prNumber !== undefined) {
    const repository = resolveRepository();
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
    try {
      liveSha = await fetchPrHeadSha({ repository, prNumber, token });
    } catch (error) {
      console.error(`[stale-checkout-head] ${error.message}`);
      process.exitCode = EXIT_UNVERIFIABLE;
      return;
    }
  } else {
    liveSha = readRemoteBranchHead(branch);
    if (liveSha === null) {
      console.error(
        `[stale-checkout-head] no remote branch named ${branch} on origin, and no --pr <n> was given. ` +
          'This is precisely the #473 hazard: a locally-checked-out PR branch has no live source to ' +
          'compare against without naming the pull request explicitly.',
      );
      process.exitCode = EXIT_UNVERIFIABLE;
      return;
    }
  }

  const controls = evaluateControls({ localSha });
  if (!controls.passed) {
    for (const failure of controls.failures) {
      console.error(`[stale-checkout-head] ${failure}`);
    }
    console.error(
      '[stale-checkout-head] refusing to report: a FRESH verdict from a broken matcher is indistinguishable from a real one',
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const result = classifyHeadFreshness({ localSha, liveSha, upstream });
  const rendered = formatResult(result, { branch, prNumber });
  if (result.exitCode === EXIT_OK) {
    console.log(rendered);
  } else {
    console.error(rendered);
  }
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[stale-checkout-head] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
  });
}
