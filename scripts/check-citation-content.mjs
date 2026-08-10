// Checks that a cited commit still contains the content its citation claims it added.
//
// This is deliberately a SEPARATE instrument from check-citation-reachability.mjs, filed as
// #528 at the request of the reachability work itself (#162/#481). That harness answers exactly
// one question, and says so in its own transcript:
//
//   scope: refs/heads only. ORPHAN means "no route from these revisions", never "does not exist"
//
// Nothing answered the adjacent question: is the content this citation pins still what the
// citation says it is? A citation of the form `` `<sha>` — adds `FOO` `` can be perfectly
// reachable and completely false, and the reachability harness passes it, because reachability
// is all it claims.
//
// Folding a content predicate into that harness's exit code would give one exit status two
// meanings — "no reader can obtain this revision" and "every reader can obtain this revision and
// it does not say what the citation claims" — and those two failures have different remedies:
// declare a twin, or edit the prose. A single red that cannot distinguish them sends the author
// to the wrong repair, which is the same defect the reachability work exists to prevent. So this
// is its own file, its own corpus (.squad/fact-checker/content-assertions.md), and its own exit
// status, and it can disagree with check-citation-reachability.mjs's verdict on the very same SHA.
//
// Three hazards this file must not repeat, all named directly in #528:
//
//   1. `git patch-id --stable` hashes context lines, so a true twin on an append-only ledger gets
//      a different id (#413). Content comparison here is LINE CONTAINMENT: does the asserted text
//      appear, verbatim, as an added line in the cited commit's diff.
//   2. Resolution is not reachability. `git cat-file -e` and `git log --follow` both resolve any
//      object present in the local store, including a commit no ref of the reader's ever reached
//      -- several worktrees on this machine share one object database, so an orphan keeps
//      resolving forever for whoever created it. Reachability here is decided the same way
//      check-citation-reachability.mjs decides it: `git merge-base --is-ancestor <a>^{commit}
//      <b>^{commit}` against the reader's own revisions. Deliberately re-derived rather than
//      imported from that file: importing its verdict would make disagreeing with it impossible
//      by construction, and the ability to disagree is the entire point of a separate instrument.
//   3. `git merge-base --is-ancestor` exits 128 when either side does not resolve locally at all.
//      That is "no answer," never "no" -- and this check must not read it as a negative.
//
// The verdict this check must never produce: FAIL on a citation it could not reach. That would
// duplicate the reachability harness's answer wearing this file's exit code, and a reader could no
// longer tell "declare a twin" from "edit the prose" by looking at which check went red. So an
// unreachable or unresolved citation WITHHOLDS -- it is not counted as a pass or a fail, and the
// run can still exit 0 with withheld rows outstanding.
//
// Run:  node scripts/check-citation-content.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadCorpus,
  refuse,
  requireCorpusFloor,
  requireScanRoots,
} from './citation-corpus.mjs';

export const FILES = ['.squad/fact-checker/content-assertions.md'];

export const ASSERTION_HEADING = '## Citations with a pinned content assertion';

// This corpus exists to prove the instrument works, not to describe the scale of a population --
// unlike the reachability harness's CITATION_FLOOR, which tracks a growing ledger. A floor of 1
// still refuses the one failure mode both floors exist for: a corpus that reads as empty because
// a scan root was renamed or the heading was mistyped, which would otherwise report a vacuous
// "0 assertions, 0 broken" as though it were a clean run.
export const CONTENT_ASSERTION_FLOOR = 1;

const ASSERTION_ROW =
  /`([0-9a-f]{7,40})`\s*[-\u2014:]\s*asserts:\s*`([^`\n]+)`/g;

/**
 * Runs git and returns { status, stdout }. Unlike execFileSync, this never throws on a non-zero
 * exit -- the exit code itself is the signal for `merge-base --is-ancestor` (0 ancestor, 1 not,
 * 128 unknown revision), and swallowing that distinction behind a try/catch is exactly the
 * resolution-vs-reachability confusion #528 names.
 */
function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
}

const git = (args) => {
  const { status, stdout } = runGit(args);
  return status === 0 ? stdout.trim() : null;
};

/**
 * Ancestry, not resolution. See the file header: `cat-file -e` / `log --follow` resolve any
 * object in a shared local store, reached or not; `merge-base --is-ancestor` asks the narrower,
 * correct question. Returns:
 *
 *   'ANCESTOR'      - candidate resolves to a commit and is an ancestor of `of` (or equal to it)
 *   'NOT_ANCESTOR'  - both resolve to commits and candidate is provably not an ancestor
 *   'NO_ANSWER'     - either side does not resolve to a commit here (git's own exit 128) -- this
 *                     is never treated as NOT_ANCESTOR, per #528's "128 means no answer, never no"
 */
export function ancestorStatus(candidate, of) {
  const { status } = runGit([
    'merge-base',
    '--is-ancestor',
    `${candidate}^{commit}`,
    `${of}^{commit}`,
  ]);
  if (status === 0) return 'ANCESTOR';
  if (status === 1) return 'NOT_ANCESTOR';
  return 'NO_ANSWER';
}

/**
 * Reachable from ANY of the reader's revisions -- same reader model as
 * check-citation-reachability.mjs: the branch head, and the mainline where it was fetched. A
 * definite NOT_ANCESTOR from every reader revision is a real negative; anything else (including a
 * mix of NO_ANSWER and NOT_ANCESTOR, with no ANCESTOR) is NO_ANSWER, because "no reader revision
 * proved it" is not the same claim as "every reader revision disproved it."
 */
export function reachabilityOf(sha, readerRevs) {
  let sawNotAncestor = false;
  for (const rev of readerRevs) {
    const status = ancestorStatus(sha, rev);
    if (status === 'ANCESTOR') return 'ANCESTOR';
    if (status === 'NOT_ANCESTOR') sawNotAncestor = true;
  }
  if (readerRevs.length > 0 && sawNotAncestor) return 'NOT_ANCESTOR';
  return 'NO_ANSWER';
}

/**
 * Added lines of a commit's diff, verbatim, one string per line with the leading `+` stripped.
 * `null` for a merge -- `git show` renders a merge as a combined diff with one column per parent,
 * so every row reads doubly-prefixed and a single-column parser would silently return nonsense.
 * Same rule check-citation-reachability.mjs's addedLinesOf uses, and for the same reason: saying
 * "cannot read this one" is better than scoring a merge against an unrelated commit.
 */
export function addedLinesOf(commit) {
  const { status: parentStatus, stdout: parents } = runGit([
    'rev-list',
    '--parents',
    '-n',
    '1',
    commit,
  ]);
  if (parentStatus !== 0) return null;
  if (parents.trim().split(/\s+/).length > 2) return null;

  const { status, stdout: show } = runGit([
    'show',
    commit,
    '--format=',
    '--unified=0',
    '--no-color',
  ]);
  if (status !== 0) return null;

  const lines = [];
  let inHunks = false;
  for (const line of show.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunks = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunks = true;
      continue;
    }
    if (inHunks && line.startsWith('+') && !line.startsWith('+++')) {
      lines.push(line.slice(1));
    }
  }
  return lines;
}

/**
 * The verdict for one row. `readerRevs` are the revisions this reader is assumed to hold.
 *
 *   WITHHOLD - the citation does not resolve here, or is not reachable from the reader's
 *              revisions, or resolves to a merge this instrument cannot read. Never a fail: an
 *              unreachable object is check-citation-reachability.mjs's finding, not this one's.
 *   PASS     - reachable, and the asserted text is present verbatim in an added line.
 *   FAIL     - reachable, and the asserted text is absent from every added line. The citation
 *              resolves, a reader can obtain it, and it does not say what it is cited for.
 */
export function classify(sha, assertion, readerRevs) {
  const reach = reachabilityOf(sha, readerRevs);
  if (reach !== 'ANCESTOR') {
    return {
      verdict: 'WITHHOLD',
      detail:
        reach === 'NOT_ANCESTOR'
          ? 'not reachable from the reader\u2019s revisions -- a reachability finding, not a content one'
          : 'does not resolve to a commit here (no answer, never "no")',
    };
  }
  const lines = addedLinesOf(sha);
  if (lines === null) {
    return {
      verdict: 'WITHHOLD',
      detail:
        'is a merge commit; a combined diff cannot be read as added lines',
    };
  }
  if (lines.some((line) => line.includes(assertion))) {
    return { verdict: 'PASS', detail: 'asserted text found in an added line' };
  }
  return {
    verdict: 'FAIL',
    detail:
      'asserted text is absent from every added line -- reachable and wrong',
  };
}

/** Every `` `sha` — asserts: `text` `` row under the heading, across every scan root. */
export function parseAssertions(sources) {
  const rows = [];
  for (const [file, text] of sources) {
    const at = text.indexOf(ASSERTION_HEADING);
    if (at < 0) continue;
    const rest = text.slice(at + ASSERTION_HEADING.length);
    const end = rest.indexOf('\n## ');
    const block = end < 0 ? rest : rest.slice(0, end);
    for (const match of block.matchAll(ASSERTION_ROW)) {
      rows.push({ file, sha: match[1], assertion: match[2] });
    }
  }
  return rows;
}

/**
 * Revisions this reader is assumed to hold. Mirrors check-citation-reachability.mjs: `HEAD`
 * always, `origin/development` where it was fetched. `origin/development` may be absent in a
 * shallow or branch-only checkout; the branch head alone still gives a usable, stricter answer.
 */
export function readerRevisions() {
  return ['HEAD', 'origin/development'].filter(
    (rev) => git(['rev-parse', '--verify', `${rev}^{commit}`]) !== null,
  );
}

function main() {
  const readerRevs = readerRevisions();
  if (readerRevs.length === 0) {
    refuse(
      'no reader revision (HEAD) resolves here -- nothing to check ancestry against.',
    );
  }

  const sources = requireScanRoots(loadCorpus(FILES));
  const rows = parseAssertions(sources);

  // --- control arm -----------------------------------------------------------------------
  // A control built from a hardcoded SHA and a hardcoded string proves the classifier can be
  // driven to each outcome, and nothing more -- it is exactly the "self-supplied input" hazard
  // citation-corpus.mjs's own header describes. The positive controls here are instead built
  // from HEAD *at the moment the check runs*: if the diff-reading machinery this check depends on
  // breaks -- a git version that renders `--unified=0` differently, a repository with no
  // reachable non-merge commit, a checkout too shallow to hold HEAD's own parent -- the control
  // is what breaks, not just the verdict on somebody else's citation. Losing sight costs the
  // control.
  const failures = [];

  const headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (headCommit === null) {
    refuse('HEAD does not resolve to a commit -- cannot build a live control.');
  }
  const headLines = addedLinesOf(headCommit);
  const headSubstantiveLine = (headLines ?? []).find(
    (line) => line.trim().length > 0,
  );
  if (headSubstantiveLine === undefined) {
    // HEAD is a merge, or added nothing non-blank. Reported, not silently skipped: the run must
    // not read as though this control had passed.
    console.log(
      'control: HEAD is a merge or adds no non-blank line -- the live positive control could not be built from it',
    );
    failures.push(
      'no live positive control could be built from HEAD -- the diff-reading arm is unverified this run',
    );
  } else {
    const livePass = classify(
      headCommit,
      headSubstantiveLine.trim(),
      readerRevs,
    );
    console.log(
      `control: HEAD's own added line classifies ${livePass.verdict} (${livePass.detail})`,
    );
    if (livePass.verdict !== 'PASS') {
      failures.push(
        "a live assertion built from HEAD's own added line did not classify PASS -- the diff-reading arm is broken",
      );
    }

    // A sighted FAILING verdict, self-supplied but against the same live commit: proves the
    // instrument can return red on a citation it CAN see, not merely withhold on one it cannot.
    const fabricated = `NOT-PRESENT-${headSubstantiveLine.length}-${Date.now()}`;
    const liveFail = classify(headCommit, fabricated, readerRevs);
    console.log(
      `control: a fabricated assertion against the same reachable commit classifies ${liveFail.verdict}`,
    );
    if (liveFail.verdict !== 'FAIL') {
      failures.push(
        'a fabricated assertion against a reachable commit did not classify FAIL -- a sighted verdict cannot be produced',
      );
    }
  }

  const unresolvable = '0123456789abcdef0123456789abcdef01234567';
  const withheld = classify(unresolvable, 'anything', readerRevs);
  console.log(
    `control: an unresolvable SHA classifies ${withheld.verdict} (never FAIL, per #528's "128 means no answer, never no")`,
  );
  if (withheld.verdict !== 'WITHHOLD') {
    failures.push(
      'an unresolvable SHA did not classify WITHHOLD -- unreachable citations are being turned into a verdict this check must not make',
    );
  }

  if (failures.length) {
    for (const f of failures) console.error('CONTROL FAILED - ' + f);
    console.error('verdict withheld.');
    process.exit(2);
  }

  // --- corpus floor ------------------------------------------------------------------------
  requireCorpusFloor({
    count: rows.length,
    floor: CONTENT_ASSERTION_FLOOR,
    subject: 'pinned content assertions',
  });

  // --- the run -----------------------------------------------------------------------------
  console.log(`\nreader revisions: ${readerRevs.join(' ')}`);
  console.log(
    'scope: this check never fails an unreachable citation -- that is check-citation-reachability.mjs\u2019s',
  );
  console.log(
    '  finding. WITHHOLD means "cannot look", not "looked and it\u2019s fine" and not "looked and it\u2019s wrong".',
  );
  console.log(`pinned assertions: ${rows.length}\n`);

  const tally = { PASS: 0, FAIL: 0, WITHHOLD: 0 };
  const failed = [];
  for (const row of rows) {
    const result = classify(row.sha, row.assertion, readerRevs);
    tally[result.verdict] += 1;
    console.log(
      `  ${row.sha.slice(0, 10).padEnd(11)} ${result.verdict.padEnd(9)} ${result.detail}`,
    );
    if (result.verdict === 'FAIL') {
      failed.push(
        `${row.file}: \`${row.sha}\` asserts \`${row.assertion}\` -- ${result.detail}`,
      );
    }
  }

  console.log(
    `\nPASS ${tally.PASS}   FAIL ${tally.FAIL}   WITHHOLD ${tally.WITHHOLD}`,
  );

  if (failed.length) {
    console.error('\nFALSE CONTENT CITATIONS:');
    for (const f of failed) console.error(`  ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    '\nOK - every reachable cited commit still contains the content its assertion claims.',
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
