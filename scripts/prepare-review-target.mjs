// Produce a review brief only for the pull request revision the API says is
// current, scoped to that branch's contribution.
//
// A bare commit diff is not that scope for a merge commit. GitHub renders a
// commit's files against its first parent, so a sync merge can show only what
// trunk brought into the branch. The compare endpoint instead reports the
// merge base of the current base and head. This command turns that into the
// explicit range reviewers must use:
//
//   merge-base(current base, current PR head)..current PR head
//
// Both mutable inputs are read again after the range is derived. If either
// moved, no brief is emitted. Exact-head check runs are read through the
// dereferencing commits/<sha>/check-runs endpoint: zero means "wait and retry",
// not "invalid head", while a command/API failure is exit 2 and never becomes
// a synthetic zero.
//
// Exit codes:
//   0  ready: a stable, current range was emitted
//   1  deferred: the head/base moved or this new head has no check runs yet
//   2  undetermined: a command, API response, or required field was unreadable
//
// This guards briefs produced through this command. The repository cannot wrap
// the app's session-dispatch API, so bypassing the command remains possible and
// is governed by .squad/skills/agent-collaboration/SKILL.md.

import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { resolveRepositorySlug, runGh } from './check-required-contexts.mjs';
import { normalizeSha } from './check-review-head-coverage.mjs';

export const EXIT_READY = 0;
export const EXIT_DEFERRED = 1;
export const EXIT_UNDETERMINED = 2;

export const VERDICT_READY = 'ready';
export const VERDICT_WAITING_FOR_CHECKS = 'waiting-for-checks';
export const VERDICT_HEAD_MOVED = 'head-moved';
export const VERDICT_BASE_MOVED = 'base-moved';

const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (argument === '--pr') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || !/^[1-9]\d*$/.test(value)) {
        parsed.error = '--pr requires a positive pull request number';
      } else {
        parsed.pr = Number(value);
      }
      continue;
    }
    if (argument === '--repo') {
      const value = argv[index + 1];
      index += 1;
      if (value === undefined || !REPOSITORY_PATTERN.test(value)) {
        parsed.error = '--repo requires owner/name';
      } else {
        parsed.repo = value;
      }
      continue;
    }
    parsed.error ??= `unrecognised argument ${JSON.stringify(argument)}`;
  }
  return parsed;
}

export function parsePullSnapshot(payload, expectedNumber) {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(
      `pull request #${expectedNumber} response was not an object`,
    );
  }
  const number = payload.number;
  const state = payload.state;
  const baseRef = payload.base?.ref;
  const headRef = payload.head?.ref;
  const headSha = normalizeSha(payload.head?.sha);

  if (number !== expectedNumber) {
    throw new Error(
      `requested pull request #${expectedNumber}, but the API returned ${JSON.stringify(number)}`,
    );
  }
  if (state !== 'open') {
    throw new Error(
      `pull request #${expectedNumber} is ${JSON.stringify(state)}, not open; no review target can be dispatched`,
    );
  }
  if (
    typeof baseRef !== 'string' ||
    baseRef === '' ||
    typeof headRef !== 'string' ||
    headRef === '' ||
    headSha === null
  ) {
    throw new Error(
      `pull request #${expectedNumber} response carried no usable base ref, head ref, or full head SHA`,
    );
  }

  return { number, state, baseRef, headRef, headSha };
}

export function parseBaseSha(payload, baseRef) {
  const baseSha = normalizeSha(payload?.commit?.sha);
  if (baseSha === null) {
    throw new Error(
      `base branch ${baseRef} response carried no full commit SHA`,
    );
  }
  return baseSha;
}

export function parseCheckRunCount(payload) {
  const count = payload?.total_count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(
      `check-runs response carried no non-negative integer total_count (${JSON.stringify(count)})`,
    );
  }
  return count;
}

export function parseComparison(payload, expectedHeadSha) {
  const headSha = normalizeSha(expectedHeadSha);
  const mergeBaseSha = normalizeSha(payload?.merge_base_commit?.sha);
  if (headSha === null || mergeBaseSha === null) {
    throw new Error(
      'compare response carried no usable merge-base or expected head SHA',
    );
  }

  const commits = Array.isArray(payload?.commits) ? payload.commits : [];
  const headCommit = commits.find(
    (commit) => normalizeSha(commit?.sha) === headSha,
  );
  const parentCount = Array.isArray(headCommit?.parents)
    ? headCommit.parents.length
    : null;
  const files = Array.isArray(payload?.files)
    ? payload.files
        .map((file) => file?.filename)
        .filter((filename) => typeof filename === 'string')
    : [];

  return {
    mergeBaseSha,
    headSha,
    range: `${mergeBaseSha}..${headSha}`,
    parentCount,
    files,
  };
}

export function classifyReviewTarget({
  initial,
  final,
  initialBaseSha,
  finalBaseSha,
  checkRunCount,
  comparison,
}) {
  if (initial.headSha !== final.headSha) {
    return {
      verdict: VERDICT_HEAD_MOVED,
      exitCode: EXIT_DEFERRED,
      reason:
        `head moved from ${initial.headSha} to ${final.headSha} while the brief was derived; ` +
        'discard every derived value and run the command again',
    };
  }
  if (initial.baseRef !== final.baseRef) {
    return {
      verdict: VERDICT_BASE_MOVED,
      exitCode: EXIT_DEFERRED,
      reason:
        `base ref moved from ${initial.baseRef} to ${final.baseRef} while the brief was derived; ` +
        'discard every derived value and run the command again',
    };
  }
  if (initialBaseSha !== finalBaseSha) {
    return {
      verdict: VERDICT_BASE_MOVED,
      exitCode: EXIT_DEFERRED,
      reason:
        `base moved from ${initialBaseSha} to ${finalBaseSha} while the brief was derived; ` +
        'discard every derived value and run the command again',
    };
  }
  if (checkRunCount === 0) {
    return {
      verdict: VERDICT_WAITING_FOR_CHECKS,
      exitCode: EXIT_DEFERRED,
      reason:
        `current head ${initial.headSha} has zero check runs. A newly pushed valid head can have ` +
        'this reading before workflows attach, so it is unsafe to dispatch now, not evidence ' +
        'that the head is invalid. Wait for a run to appear, then retry.',
    };
  }
  if (!comparison || comparison.headSha !== initial.headSha) {
    throw new Error(
      'a stable head with check runs has no comparison bound to that same head',
    );
  }

  return {
    verdict: VERDICT_READY,
    exitCode: EXIT_READY,
    reason: 'current head and base stayed stable while the scope was derived',
    pull: initial,
    baseSha: initialBaseSha,
    checkRunCount,
    comparison,
  };
}

export function formatReviewBrief(result, options = {}) {
  const readAt = options.readAt ?? new Date().toISOString();
  const lines = [
    '[review-target] READY',
    `pull request  #${result.pull.number}`,
    `base ref      ${result.pull.baseRef}`,
    `base sha      ${result.baseSha}`,
    `head ref      ${result.pull.headRef}`,
    `head sha      ${result.pull.headSha}`,
    `merge base    ${result.comparison.mergeBaseSha}`,
    `review range  ${result.comparison.range}`,
    `check runs    ${result.checkRunCount}`,
  ];
  if (result.comparison.parentCount !== null) {
    lines.push(`head parents  ${result.comparison.parentCount}`);
  }
  lines.push(
    `read at       ${readAt}`,
    '',
    `Review only the branch contribution in ${result.comparison.range}.`,
    `Do not use a bare diff of ${result.pull.headSha}; a merge head's bare commit diff is first-parent scope.`,
    `Before returning a verdict, re-read PR #${result.pull.number}'s API head and require it still equals ${result.pull.headSha}.`,
  );
  return lines.join('\n');
}

export function formatDeferred(result) {
  return `[review-target] WAIT (${result.verdict}): ${result.reason}`;
}

export function readGhJson(run, path, env) {
  const result = runGh(run, ['api', path], env);
  if (!result.spawned) {
    throw new Error(`could not launch gh for ${path}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `gh api ${path} failed with exit ${String(result.status)}: ${result.stderr.trim() || 'no error output'}`,
    );
  }
  const stdout = result.stdout.trim();
  if (stdout === '') {
    throw new Error(`gh api ${path} returned empty output`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`gh api ${path} returned invalid JSON`);
  }
}

const USAGE = `usage: npm run review:target -- --pr <number> [--repo owner/name]

Emits a review brief only when the current API head and base remain stable,
the exact head has at least one check run, and the scope can be stated as
merge-base(base, head)..head.

exit 0 ready and brief emitted
exit 1 wait/retry; no brief emitted
exit 2 undetermined; no brief emitted`;

function runMain(argv, env, run, writeOut, writeError) {
  const args = parseArgs(argv);
  if (args.help) {
    writeOut(USAGE);
    return EXIT_READY;
  }
  if (args.error) {
    writeError(`${args.error}\n${USAGE}`);
    return EXIT_UNDETERMINED;
  }
  if (args.pr === undefined) {
    writeError(`--pr is required\n${USAGE}`);
    return EXIT_UNDETERMINED;
  }

  const repository = args.repo ?? resolveRepositorySlug(env, run);
  if (!repository || !REPOSITORY_PATTERN.test(repository)) {
    throw new Error(
      'could not resolve owner/name; pass --repo or run inside a GitHub repository',
    );
  }

  const pullPath = `repos/${repository}/pulls/${args.pr}`;
  const initial = parsePullSnapshot(readGhJson(run, pullPath, env), args.pr);
  const basePath = `repos/${repository}/branches/${encodeURIComponent(initial.baseRef)}`;
  const initialBaseSha = parseBaseSha(
    readGhJson(run, basePath, env),
    initial.baseRef,
  );
  const checksPath = `repos/${repository}/commits/${initial.headSha}/check-runs?per_page=1`;
  const checkRunCount = parseCheckRunCount(readGhJson(run, checksPath, env));

  const comparison =
    checkRunCount === 0
      ? null
      : parseComparison(
          readGhJson(
            run,
            `repos/${repository}/compare/${initialBaseSha}...${initial.headSha}`,
            env,
          ),
          initial.headSha,
        );

  const final = parsePullSnapshot(readGhJson(run, pullPath, env), args.pr);
  const finalBaseSha = parseBaseSha(
    readGhJson(run, basePath, env),
    initial.baseRef,
  );
  const result = classifyReviewTarget({
    initial,
    final,
    initialBaseSha,
    finalBaseSha,
    checkRunCount,
    comparison,
  });

  if (result.exitCode === EXIT_READY) {
    writeOut(formatReviewBrief(result));
  } else {
    writeError(formatDeferred(result));
  }
  return result.exitCode;
}

export function main(
  argv,
  env = process.env,
  run = spawnSync,
  writeOut = (line) => console.log(line),
  writeError = (line) => console.error(line),
) {
  try {
    return runMain(argv, env, run, writeOut, writeError);
  } catch (error) {
    writeError(
      `[review-target] INDETERMINATE: ${error instanceof Error ? error.message : String(error)}. Exit 2; no brief was produced.`,
    );
    return EXIT_UNDETERMINED;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main(process.argv.slice(2));
}
