#!/usr/bin/env node
// Detects local branches carrying commits that exist on NO remote ref at all
// (#543) — not "unmerged", not "behind", but unpushed and invisible. Nine
// local branches on this repo's own worktrees had commits no remote ref
// contained, including finished remedies for #478, #486 and #503. Trunk
// cannot distinguish "never written" from "written and never pushed": both
// present as absence, and every existing check in this family (behind-base,
// stale-checkout-head, merge-landed…) verifies published state. All of them
// are blind here, and blind in the direction that produces false negatives
// about our own work.
//
// THE MEASUREMENT, precisely: for each local branch, which of its commits are
// NOT an ancestor of any ref under refs/remotes/*? That is `git rev-list
// <branch> --not --remotes` — reachability per commit, exactly as the issue's
// own verification did (`git branch -r --contains <sha>`), not a comparison
// of branch names. A branch named `feature` with a remote `origin/feature`
// that is merely behind is not what this measures; a branch (named anything)
// whose HEAD commit is unreachable from every remote ref is.
//
// THE FALSIFIER (#543, and repeated stronger in the follow-up comment):
// deliberately create a local commit on a branch with no remote ref and
// require it to appear. A check reporting zero on a tree that has one is
// measuring branch names, not reachability — the same mistake that makes
// `git worktree list` look like an answer here when it only enumerates
// checkouts. `tests/strandedBranches.test.ts` drives this falsifier directly
// against a real repository, plus a positive control (a branch fully pushed
// reports clean) and a control on the instrument itself (below).
//
// FAIL-CLOSED, not fail-silent: if this clone's `refs/remotes/*` namespace is
// empty, `--not --remotes` excludes nothing, and EVERY local commit would
// read as "stranded" — a false positive from an empty exclusion set, not a
// true finding about unpushed work. That state is reported UNDETERMINED, not
// clean and not a flood of findings; see `evaluateRemoteRefPresence`.
//
// SCOPE, deliberately: this reports existence (a commit unreachable from any
// remote ref), not value. The issue's own follow-up comment found that of
// nine stranded branches, two were already superseded by work landed via
// another route, and pushing them unqualified would have re-litigated closed
// issues. Distinguishing live/superseded/overlapping needs the referenced
// issue's state and a trunk-content diff — judgement this script does not
// make. It prints the referenced issue numbers found in each stranded
// commit's message (if any) so a human or a follow-on tool can make that
// call, but the exit code and REPORT are about reachability only.

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const EXIT_CLEAN = 0;
export const EXIT_STRANDED = 1;
export const EXIT_UNDETERMINED = 2;

const RECORD_SEPARATOR = '\x1f';
const UNIT_SEPARATOR = '\x1e';

function git(args, { cwd = process.cwd(), allowFailure = false } = {}) {
  try {
    return {
      code: 0,
      stdout: execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    if (!allowFailure) {
      throw error;
    }
    return {
      code: error.status ?? 128,
      stdout: '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    };
  }
}

/**
 * Every local branch and the SHA it currently points at.
 * `%(refname:short)` matches this repo's other for-each-ref reads
 * (`check-stale-checkout-head.mjs`); the null-byte record separator keeps a
 * branch name containing whitespace from being misparsed.
 */
export function listLocalBranches(cwd) {
  const result = git(
    ['for-each-ref', '--format=%(refname:short)%00%(objectname)', 'refs/heads'],
    { cwd, allowFailure: true },
  );
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [name, sha] = line.split('\u0000');
      return { name, sha };
    });
}

/**
 * Whether this clone has ANY remote-tracking ref at all. `--not --remotes`
 * excludes nothing when this is empty, which would make every local commit
 * on every branch read "stranded" — a false positive from an unfetched or
 * remote-less clone, not a finding about unpushed work. This is the control
 * that keeps the instrument from firing on a tree it cannot actually
 * evaluate.
 */
export function evaluateRemoteRefPresence(remoteRefCount) {
  if (remoteRefCount > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'no refs/remotes/* found in this clone. `--not --remotes` would then ' +
      'exclude nothing, and every local commit would read as stranded — a ' +
      'false positive from an empty exclusion set, not a finding about ' +
      'unpushed work. Fetch at least one remote (`git fetch --all`) before ' +
      'running this check.',
  };
}

export function countRemoteRefs(cwd) {
  const result = git(['for-each-ref', 'refs/remotes'], {
    cwd,
    allowFailure: true,
  });
  if (result.code !== 0) {
    return 0;
  }
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

const ISSUE_REFERENCE_PATTERN = /#(\d+)/g;

/**
 * Issue numbers mentioned in a commit subject/body, e.g. "fixes #478". Used
 * only for the report — see the SCOPE note above for why this script does
 * not itself judge whether the referenced issue is still open.
 */
export function extractIssueReferences(message) {
  const found = new Set();
  for (const match of message.matchAll(ISSUE_REFERENCE_PATTERN)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The commits reachable from `branch` that are NOT reachable from any
 * refs/remotes/* ref — reachability per commit, not a branch-name
 * comparison. `git rev-list <branch> --not --remotes` is exactly `git
 * branch -r --contains <sha> == 0` restated as a single set-difference walk
 * instead of one query per candidate commit; both answer the same question
 * this issue insists on: is this commit reachable from any published ref.
 */
export function listStrandedCommits(branch, cwd) {
  const result = git(
    [
      'rev-list',
      branch,
      '--not',
      '--remotes',
      `--format=%H${RECORD_SEPARATOR}%s${UNIT_SEPARATOR}`,
    ],
    { cwd, allowFailure: true },
  );
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split(UNIT_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      // `--format` on rev-list still prefixes each record with `commit
      // <sha>\n` ahead of the custom format; strip that line before
      // splitting on the record separator.
      const withoutCommitLine = record.replace(/^commit [0-9a-f]+\n/, '');
      const [sha, subject] = withoutCommitLine.split(RECORD_SEPARATOR);
      return {
        sha: sha?.trim() ?? '',
        subject: subject?.trim() ?? '',
        issues: extractIssueReferences(subject ?? ''),
      };
    })
    .filter((commit) => /^[0-9a-f]{40}$/.test(commit.sha));
}

/**
 * The pure judgement: given every local branch and, for each, the stranded
 * commits found on it, produce the report and the exit code. Branches with
 * zero stranded commits are omitted from `stranded` but counted in
 * `branchesExamined`, matching the issue's own report shape ("worktree
 * branches examined -> 46").
 */
export function evaluateStrandedBranches(branchResults) {
  const stranded = branchResults
    .filter((entry) => entry.commits.length > 0)
    .map((entry) => ({
      branch: entry.name,
      headSha: entry.sha,
      ahead: entry.commits.length,
      commits: entry.commits,
    }));
  return {
    branchesExamined: branchResults.length,
    stranded,
    exitCode: stranded.length > 0 ? EXIT_STRANDED : EXIT_CLEAN,
  };
}

export function formatReport(result) {
  const lines = [];
  if (result.exitCode === EXIT_CLEAN) {
    lines.push(
      `[stranded-branches] CLEAN — ${result.branchesExamined} local branch(es) examined, ` +
        'every commit on every one is reachable from some refs/remotes/* ref.',
    );
    return lines.join('\n');
  }
  lines.push(
    `[stranded-branches] STRANDED — ${result.stranded.length} of ` +
      `${result.branchesExamined} local branch(es) carry commits reachable from no remote ref:`,
  );
  for (const entry of result.stranded) {
    const issueNumbers = [
      ...new Set(entry.commits.flatMap((commit) => commit.issues)),
    ].sort((a, b) => a - b);
    const issueNote =
      issueNumbers.length > 0
        ? ` (references ${issueNumbers.map((n) => `#${n}`).join(', ')} — open/closed state not checked by this script)`
        : '';
    lines.push(
      `  ${entry.branch}  ${entry.headSha.slice(0, 8)}  ahead=${entry.ahead}${issueNote}`,
    );
    for (const commit of entry.commits.slice(0, 5)) {
      lines.push(`      ${commit.sha.slice(0, 8)}  ${commit.subject}`);
    }
    if (entry.commits.length > 5) {
      lines.push(`      … and ${entry.commits.length - 5} more`);
    }
  }
  lines.push(
    '',
    'This is existence, not value: some of the above may already be superseded ' +
      'by work that landed via another route, or reference issues that are ' +
      'already closed. Do not push all of these unqualified — see #543.',
  );
  return lines.join('\n');
}

/**
 * @param {string} [cwd]
 * @returns {{ exitCode: number, report: string }}
 */
export function runCheck(cwd = process.cwd()) {
  const remoteRefCount = countRemoteRefs(cwd);
  const presence = evaluateRemoteRefPresence(remoteRefCount);
  if (!presence.ok) {
    return {
      exitCode: EXIT_UNDETERMINED,
      report: `[stranded-branches] UNDETERMINED — ${presence.reason}`,
    };
  }

  const branches = listLocalBranches(cwd);
  const branchResults = branches.map((branch) => ({
    ...branch,
    commits: listStrandedCommits(branch.name, cwd),
  }));
  const result = evaluateStrandedBranches(branchResults);
  return { exitCode: result.exitCode, report: formatReport(result) };
}

function main() {
  const cwd = process.cwd();
  let outcome;
  try {
    outcome = runCheck(cwd);
  } catch (error) {
    console.error(
      `[stranded-branches] failed: ${error instanceof Error ? error.message : String(error)}. ` +
        'Exit 2, not a pass and not a finding about any branch.',
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
