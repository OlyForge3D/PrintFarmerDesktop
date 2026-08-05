#!/usr/bin/env node
// Did a merge that reported success actually reach the branch?
//
// #391: fifteen PRs were merged in one sweep. Fourteen landed. One did not,
// and reported success identically to the fourteen:
//
//   PUT /pulls/386/merge -> {"merged":true}
//   merge commit 1ececa0f, parents = 2, PR page merged=true
//   3 of its 5 files ABSENT from development
//
// The merge commit was built with a PULL-REQUEST HEAD as its first parent
// rather than the branch tip. Twenty-five seconds later another merge moved
// the ref past it, and 1ececa0f became unreachable. Nothing in the merge
// response, the PR state, the timeline, or the merge commit's own shape
// distinguished it from the fourteen. Only the tree disagreed.
//
//   A MERGE IS NOT EVIDENCE THAT A MERGE HAPPENED.
//
// #391's remedy is four sentences of conduct -- serialise merges, follow every
// sweep with an assertion, fetch first, assert file presence. Every one of them
// is a commitment, and the party able to breach them is the party making them.
// This is the assertion, run rather than promised.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT THE SUBJECT #391 NAMED
//
// #391 prescribes `--is-ancestor <PR head> <trunk>`, which is the check that
// found the incident. Measured over the last 30 merged PRs in this repository:
//
//   subject                exit 1     of which actually lost
//   PR head                9 / 30     1     <- 8 false alarms
//   merge_commit_sha       1 / 30     1     <- exactly #386
//
// The eight false alarms are squash merges. A squash discards the head, so the
// head is legitimately unreachable from trunk for work that shipped perfectly;
// 23 of 29 merges in this repository take that path. An instrument that cries
// loss on a quarter of all healthy merges is not usable, and its one true
// positive is indistinguishable from its eight false ones.
//
// `merge_commit_sha` is the right subject because it is defined as the commit
// GitHub produced ON THE BASE, whatever the strategy. Measured here: for squash
// merges it has parents=1 and IS an ancestor of trunk (#378, #373, #359, #358,
// #348, #337, #332, #329); for merge commits it has parents=2 and is likewise.
// The head and the merge commit are neighbouring questions and only one of them
// is the question owed.
//
// THE FILE ASSERTION NEEDS A POSITIVE CONTROL, AND #391 SAYS SO
//
//   git cat-file -e origin/development:scripts/check-protection-assumptions.mjs -> 128
//   git cat-file -e origin/development:scripts/does-not-exist.mjs               -> 128
//
// A genuinely absent file and a path that was never right are byte-identical.
// So every path is first required to be present at refs/pull/N/head; a path
// absent THERE indicts the path, not the merge, and yields UNVERIFIABLE rather
// than a finding. Deletions are exempt, because absence is their success.
//
// THREE-VALUED THROUGHOUT (#315)
//
// `git merge-base --is-ancestor` answers 1 for "no" and 128 for "I could not
// answer", and every `if (code !== 0)` collapses them into the reassuring
// reading. Objects are fetched before they are asked about, and a 128 that
// survives the fetch is UNVERIFIABLE, never "landed".
//
// WHY UNVERIFIABLE DOES NOT OUTRANK NOT-LANDED HERE
//
// mutation-harness.mjs ranks confounded ABOVE survived, because a confounded
// arm undermines its own result. This tool ranks the other way, and the
// difference is structural rather than a matter of taste: an unverifiable PR-A
// says nothing about a confirmed loss in PR-B. Masking a proven loss behind an
// unrelated missing object would be the failure #391 is about, committed by the
// instrument built to catch it. Both are always printed.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERDICT_LANDED = 'landed';
export const VERDICT_NOT_LANDED = 'not-landed';
export const VERDICT_UNVERIFIABLE = 'unverifiable';
export const VERDICT_ADJUDICATED = 'adjudicated';

export const EXIT_LANDED = 0;
export const EXIT_NOT_LANDED = 1;
export const EXIT_UNVERIFIABLE = 2;

/**
 * A loss that has been found, accepted, and repaired by a DIFFERENT pull
 * request. #386's merge commit will never become an ancestor of trunk -- the
 * ref moved past it and nothing can undo that -- so without this the check is
 * permanently red on a true finding, and a permanently red check is one whose
 * remedy is to switch it off.
 *
 * This is an allowlist, so it is a commitment, so it needs a rot check. Each
 * entry must name the paths the restoring PR puts back, and those paths are
 * verified ON THE TARGET at run time. If the restore has not landed, the
 * adjudication is void and the loss is reported again. The entry cannot outlive
 * the repair it claims, and it cannot be written in advance of one.
 */
export const ADJUDICATED_LOSSES = [
  {
    prNumber: 386,
    restoredBy: 390,
    restoredPaths: [
      'scripts/check-protection-assumptions.mjs',
      'tests/protectionAssumptions.test.ts',
    ],
    reason:
      '#386 merged onto a spent PR head branch (#391). Its merge commit 1ececa0f can never become an ancestor of development. #390 restores the identical content from the surviving branch.',
  },
];

/**
 * Is a reported loss discharged? Only if every path the restore claims is
 * actually readable on the target. `codes` are raw `git cat-file -e` statuses.
 */
export function classifyAdjudication({ entry, codes } = {}) {
  if (!entry) {
    return { discharged: false, reason: 'no adjudication on record' };
  }
  if (!Array.isArray(entry.restoredPaths) || entry.restoredPaths.length === 0) {
    return {
      discharged: false,
      reason: `the adjudication for #${entry.prNumber} names no restored paths, so it asserts nothing`,
    };
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    return {
      discharged: false,
      reason: `the adjudication for #${entry.prNumber} carries no reason`,
    };
  }
  const missing = entry.restoredPaths.filter(
    (path, index) => (codes ?? [])[index] !== 0,
  );
  if (missing.length > 0) {
    return {
      discharged: false,
      reason: `#${entry.prNumber} is recorded as restored by #${entry.restoredBy}, but that restore has NOT landed: ${missing.join(', ')} absent from the target`,
    };
  }
  return {
    discharged: true,
    reason: `#${entry.prNumber} did not land and is discharged by #${entry.restoredBy}, whose ${entry.restoredPaths.length} restored path(s) are present on the target`,
  };
}

/**
 * Ancestry, read three-valued. `code` is the raw exit status of
 * `git merge-base --is-ancestor`, taken AFTER the object has been fetched.
 */
export function classifyAncestry({ code, subject } = {}) {
  if (code === 0) {
    return { reached: true, reason: `${subject} is an ancestor of the target` };
  }
  if (code === 1) {
    return {
      reached: false,
      reason: `${subject} is NOT an ancestor of the target`,
    };
  }
  return {
    reached: null,
    reason: `git could not answer for ${subject} (exit ${code}); the object is still missing after a fetch`,
  };
}

/**
 * One file's fate. `atHead` and `atTarget` are the raw `git cat-file -e` exit
 * codes for <ref>:<path>.
 *
 * The order is load-bearing. A path absent at the PR head is checked FIRST,
 * because absence at the target is then explained by the path rather than by
 * the merge -- that is #391's "an absence assertion over a bad path passes for
 * the wrong reason", and it is the reason this cannot be a bare cat-file loop.
 */
export function classifyFile({ path, status, atHead, atTarget } = {}) {
  if (status === 'removed') {
    return {
      path,
      present: null,
      reason: `${path} is a deletion; absence is its success and it is not evidence either way`,
    };
  }
  if (atHead !== 0) {
    return {
      path,
      present: null,
      reason: `${path} is not present at the PR head either (exit ${atHead}); the path is wrong, so its absence from the target indicts nothing`,
    };
  }
  if (atTarget === 0) {
    return { path, present: true, reason: `${path} is present on the target` };
  }
  if (atTarget === 1 || atTarget === 128) {
    return {
      path,
      present: false,
      reason: `${path} is ABSENT from the target`,
    };
  }
  return {
    path,
    present: null,
    reason: `${path} could not be read on the target (exit ${atTarget})`,
  };
}

/**
 * One PR's verdict, over already-resolved facts so that every arm is drivable
 * from a plain object. An arm no real input can provoke is unbound and
 * equivalent to a deleted one.
 */
export function classifyMerge({
  prNumber,
  merged,
  mergeCommitSha,
  baseRef,
  targetRef,
  ancestry,
  files = [],
  adjudication,
} = {}) {
  if (merged !== true) {
    return {
      prNumber,
      verdict: VERDICT_UNVERIFIABLE,
      reason: `#${prNumber} is not merged, so there is no merge to verify`,
      files: [],
    };
  }
  if (
    typeof mergeCommitSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(mergeCommitSha)
  ) {
    return {
      prNumber,
      verdict: VERDICT_UNVERIFIABLE,
      reason: `#${prNumber} reports merged with no usable merge_commit_sha (${JSON.stringify(mergeCommitSha)})`,
      files: [],
    };
  }
  if (
    !ancestry ||
    ancestry.reached === null ||
    ancestry.reached === undefined
  ) {
    return {
      prNumber,
      verdict: VERDICT_UNVERIFIABLE,
      reason: `#${prNumber}: ${ancestry ? ancestry.reason : 'ancestry was never read'}`,
      files,
    };
  }

  const absent = files.filter((file) => file.present === false);

  if (ancestry.reached === false) {
    const via =
      baseRef && targetRef && baseRef !== targetRef
        ? `; it was merged into "${baseRef}", not "${targetRef}"`
        : '';
    const loss = `#${prNumber} reports merged, but ${mergeCommitSha.slice(0, 8)} never reached the target${via}${
      absent.length > 0 ? ` (${absent.length} file(s) absent)` : ''
    }`;
    if (adjudication && adjudication.discharged === true) {
      return {
        prNumber,
        verdict: VERDICT_ADJUDICATED,
        reason: `${loss} — ${adjudication.reason}`,
        files,
      };
    }
    return {
      prNumber,
      verdict: VERDICT_NOT_LANDED,
      reason: adjudication ? `${loss} — ${adjudication.reason}` : loss,
      files,
    };
  }

  // Reached, but files are missing. This is a different animal from #386 and
  // must not be silently folded into it: the merge did land, and something
  // after it removed the content. Reported as not-landed because the work is
  // absent either way, with the distinction preserved in the reason.
  if (absent.length > 0) {
    return {
      prNumber,
      verdict: VERDICT_NOT_LANDED,
      reason: `#${prNumber}: ${mergeCommitSha.slice(0, 8)} IS an ancestor of the target, yet ${absent.length} of its file(s) are absent from it: ${absent
        .map((file) => file.path)
        .join(', ')}`,
      files,
    };
  }

  return {
    prNumber,
    verdict: VERDICT_LANDED,
    reason: `#${prNumber}: ${mergeCommitSha.slice(0, 8)} reached the target and ${files.filter((file) => file.present === true).length} verified file(s) are present`,
    files,
  };
}

/**
 * The sweep. #391's incident was invisible per-PR at merge time and only became
 * visible after the NEXT merge landed, so the unit of assertion is the set.
 */
export function evaluateSweep(results) {
  const notLanded = results.filter(
    (result) => result.verdict === VERDICT_NOT_LANDED,
  );
  const unverifiable = results.filter(
    (result) => result.verdict === VERDICT_UNVERIFIABLE,
  );
  const landed = results.filter((result) => result.verdict === VERDICT_LANDED);
  const adjudicated = results.filter(
    (result) => result.verdict === VERDICT_ADJUDICATED,
  );

  if (notLanded.length > 0) {
    return {
      exitCode: EXIT_NOT_LANDED,
      verdict: VERDICT_NOT_LANDED,
      notLanded,
      unverifiable,
      landed,
      adjudicated,
    };
  }
  if (unverifiable.length > 0) {
    return {
      exitCode: EXIT_UNVERIFIABLE,
      verdict: VERDICT_UNVERIFIABLE,
      notLanded,
      unverifiable,
      landed,
      adjudicated,
    };
  }
  return {
    exitCode: EXIT_LANDED,
    verdict: VERDICT_LANDED,
    notLanded,
    unverifiable,
    landed,
    adjudicated,
  };
}

export function formatSweep(sweep, { targetRef } = {}) {
  const lines = [
    `[merge-landed] target ${targetRef ?? '(unknown)'} — ${sweep.landed.length} landed, ${sweep.notLanded.length} NOT landed, ${sweep.unverifiable.length} unverifiable, ${sweep.adjudicated.length} adjudicated`,
  ];
  for (const result of sweep.notLanded) {
    lines.push(`  NOT LANDED   ${result.reason}`);
  }
  for (const result of sweep.unverifiable) {
    lines.push(`  unverifiable ${result.reason}`);
  }
  for (const result of sweep.adjudicated) {
    lines.push(`  adjudicated  ${result.reason}`);
  }
  if (sweep.notLanded.length === 0 && sweep.unverifiable.length === 0) {
    lines.push(
      '  every merge in this set reached the target or is discharged.',
    );
  } else if (sweep.notLanded.length > 0) {
    lines.push(
      '  A merge is not evidence that a merge happened. Re-merge from a current base.',
    );
  }
  return lines.join('\n');
}

// --- effects -------------------------------------------------------------

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

/**
 * Fetch before asserting, so a 1 ("no") is distinguishable from a 128 ("did not
 * answer"). Failure is deliberately not fatal: the fetch is an attempt to make
 * the question answerable, and if it fails the classifier says UNVERIFIABLE
 * rather than guessing.
 */
export function ensureObject(sha, remote = 'origin') {
  const present = git(['cat-file', '-e', `${sha}^{commit}`], {
    allowFailure: true,
  });
  if (present.code === 0) {
    return true;
  }
  git(['fetch', '--quiet', remote, sha], { allowFailure: true });
  return (
    git(['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true }).code ===
    0
  );
}

export function ancestryCode(sha, targetRef) {
  return git(['merge-base', '--is-ancestor', sha, targetRef], {
    allowFailure: true,
  }).code;
}

export function pathCode(ref, path) {
  return git(['cat-file', '-e', `${ref}:${path}`], { allowFailure: true }).code;
}

async function requestJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'check-merge-landed',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${url}`);
  }
  return response.json();
}

export async function fetchMergedPulls({ repository, token, limit = 15 }) {
  const pulls = await requestJson(
    `https://api.github.com/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=${Math.min(100, limit * 3)}`,
    token,
  );
  return pulls.filter((pull) => pull.merged_at !== null).slice(0, limit);
}

export async function fetchPullFiles({ repository, token, prNumber }) {
  const files = await requestJson(
    `https://api.github.com/repos/${repository}/pulls/${prNumber}/files?per_page=100`,
    token,
  );
  return files.map((file) => ({ path: file.filename, status: file.status }));
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

export function verifyPull({ pull, files, targetRef }) {
  const mergeCommitSha = pull.merge_commit_sha;
  const prNumber = pull.number;
  const merged = pull.merged_at !== null && pull.merged_at !== undefined;

  if (!merged || typeof mergeCommitSha !== 'string') {
    return classifyMerge({
      prNumber,
      merged,
      mergeCommitSha,
      baseRef: pull.base?.ref,
      targetRef,
    });
  }

  const reachable = ensureObject(mergeCommitSha);
  const ancestry = classifyAncestry({
    code: reachable ? ancestryCode(mergeCommitSha, targetRef) : 128,
    subject: mergeCommitSha.slice(0, 8),
  });

  const headRef = `refs/pull/${prNumber}/head`;
  git(['fetch', '--quiet', 'origin', `${headRef}:${headRef}`], {
    allowFailure: true,
  });

  const classified = files.map((file) =>
    classifyFile({
      path: file.path,
      status: file.status,
      atHead: pathCode(headRef, file.path),
      atTarget: pathCode(targetRef, file.path),
    }),
  );

  const entry = ADJUDICATED_LOSSES.find(
    (candidate) => candidate.prNumber === prNumber,
  );
  const adjudication = entry
    ? classifyAdjudication({
        entry,
        codes: entry.restoredPaths.map((path) => pathCode(targetRef, path)),
      })
    : undefined;

  return classifyMerge({
    prNumber,
    merged,
    mergeCommitSha,
    baseRef: pull.base?.ref,
    targetRef,
    ancestry,
    files: classified,
    adjudication,
  });
}

async function main() {
  const args = process.argv.slice(2);
  let targetRef = 'origin/development';
  let limit = 15;
  const explicit = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--target') {
      targetRef = args[index + 1];
      index += 1;
    } else if (arg === '--limit') {
      limit = Number.parseInt(args[index + 1], 10);
      index += 1;
    } else if (/^\d+$/.test(arg)) {
      explicit.push(Number.parseInt(arg, 10));
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)}; usage: check-merge-landed [--target <ref>] [--limit <n>] [pr-number...]`,
      );
    }
  }

  const repository = resolveRepository();
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';

  git(['fetch', '--quiet', 'origin'], { allowFailure: true });

  // POSITIVE CONTROL. Every file verdict below rests on `cat-file -e` being
  // able to answer 0 for something that is genuinely present. If it cannot,
  // every absence reading is worthless and the run must not report findings.
  if (pathCode(targetRef, 'package.json') !== 0) {
    console.error(
      `[merge-landed] positive control failed: package.json is not readable at ${targetRef}, so no absence reading from this run means anything`,
    );
    process.exitCode = EXIT_UNVERIFIABLE;
    return;
  }

  const pulls =
    explicit.length > 0
      ? await Promise.all(
          explicit.map((prNumber) =>
            requestJson(
              `https://api.github.com/repos/${repository}/pulls/${prNumber}`,
              token,
            ),
          ),
        )
      : await fetchMergedPulls({ repository, token, limit });

  const results = [];
  for (const pull of pulls) {
    let files = [];
    try {
      files = await fetchPullFiles({
        repository,
        token,
        prNumber: pull.number,
      });
    } catch {
      files = [];
    }
    results.push(verifyPull({ pull, files, targetRef }));
  }

  const sweep = evaluateSweep(results);
  console.log(formatSweep(sweep, { targetRef }));
  process.exitCode = sweep.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`[merge-landed] ${error.message}`);
    process.exitCode = EXIT_UNVERIFIABLE;
  });
}
