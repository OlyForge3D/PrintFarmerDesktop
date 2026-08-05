// Resolve what a SHA quoted in a handoff actually is, at the moment of use.
//
// Why this exists. A SHA in a message is a claim with no expiry and no way to
// fail. It was true when written and the channel between sessions runs ~13-14
// hours behind (#293), so by the time it is read the object it names may have
// been superseded, squashed away, or replaced by a twin — and NONE of that
// changes the string. `.squad/decisions/inbox/vasquez-a-sha-is-a-perishable-claim.md`
// records the class; this is the instrument for it.
//
// The instruction that produced this file was "never carry a SHA across a
// message boundary; re-derive at the moment of use". That is a commitment, and
// `.squad/decisions.md` is explicit that a commitment is not a control: the only
// party able to breach it is the one making it. So the discipline is shipped as
// something runnable instead. It cannot stop anyone quoting a stale SHA. It
// removes the excuse that checking was laborious, and it makes the check
// producible in a PR body where it survives the channel.
//
// Four questions, four instruments, and the whole point is that they are
// DIFFERENT questions. Answering one and reporting another is the entire defect:
//
//   1. Does the object exist?          `git cat-file -e <sha>^{commit}`
//   2. Is it live on the trunk?        `git merge-base --is-ancestor <sha> <base>`
//                                      — after refreshing <base>, which is a
//                                      cache. See `fetchBase`: this script
//                                      shipped answering question 2 against
//                                      whatever the clone last fetched, which is
//                                      the same mistake `--force-with-lease`
//                                      makes and the one it exists to catch.
//   3. Was it ever this PR's head?     `--is-ancestor <sha> refs/pull/N/head`
//   4. Did its work ship anyway?       `git log --grep=<subject> <base>`
//
// Measured traps, each of which has cost this squad a round:
//
//   * `git rev-parse --verify <fabricated 40-hex>` EXITS 0. The flag named
//     `--verify` does not verify existence; it validates the syntax of a rev
//     expression. A handoff citing an invented SHA therefore passes the check
//     most people reach for.
//   * `cat-file -e` is the existence test, but the BARE form answers a
//     different question than the one a handoff asks. Measured:
//
//       cat-file -e <absent>            -> 1
//       cat-file -e <absent>^{commit}   -> 128
//       cat-file -e <a TREE sha>        -> 0     <- an object, not a commit
//       cat-file -e <a TREE sha>^{commit} -> 128
//
//     A SHA in a handoff is claimed to be a COMMIT, so the `^{commit}` peel is
//     load-bearing and not decoration. Note the peel also moves the absent case
//     from 1 to 128: anyone branching on `exit === 1` to mean "absent" reads a
//     peeled miss as something else entirely. This code tests `=== 0` and
//     treats every other code as "not a commit I can see".
//   * Base ancestry answers question 2 and nothing else. A squash merge lands
//     the CONTENT and discards the commit object, so `--is-ancestor <sha>
//     development` is FALSE for work that shipped an hour ago. Four sessions in
//     one day reported branches as unmerged on exactly this.
//   * `-S` on a distinguishing string is widely prescribed here as the check
//     that survives squash. It survives squash and does NOT survive rewording:
//     measured, `-S` returned empty for a change that had shipped, because one
//     word in the added line was edited between branch and merge. `--grep` on
//     the commit SUBJECT works, because GitHub concatenates branch subjects into
//     the squash body. `-S` is offered here as an OPTIONAL extra signal and is
//     never load-bearing for the verdict.
//   * A twin — a real object, on a real chain, that the merged PR does not
//     contain — defeats `cat-file`, `ls-remote` and `gh api commits/<sha>`
//     simultaneously. All three return success. Question 3 is the only
//     discriminator, and it requires the PR ref to have been fetched.
//   * `git ls-remote origin refs/heads/<branch>` is widely prescribed as the
//     authoritative currency check. On a DELETED branch it prints nothing and
//     EXITS 0 — measured. The remedy fails silently in the one case someone was
//     told to trust it, so a caller must test the OUTPUT, never the status.
//     This code never uses it; question 3 reads a pull ref by ancestry instead.
//   * The exit codes in this family have no convention to intuit. Measured:
//     `cat-file -e` misses with 1, the peeled form and `--is-ancestor` with
//     128, and `for-each-ref --contains` with 129 — while `ls-remote`,
//     `for-each-ref` and `log -g` all report ABSENCE BY SUCCEEDING with empty
//     output. Where the answer is the output, test the output; where it is the
//     status, branch by value and keep the third state.
//
// What this refuses to do: guess. Without `--pr`, `stale` and `twin` are not
// distinguishable, and the verdict says so rather than picking the flattering
// reading. Same doctrine as the push guard it sits beside — refuse, and claim
// less.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** A full-length object name. Prefixes are deliberately not accepted; see `parseArgs`. */
export const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

/**
 * Exit status of a git command, with the output discarded.
 *
 * Returns `null` when git failed for a reason that is not the question being
 * asked. `merge-base --is-ancestor` uses exit 0 for true and 1 for false, but
 * reaches 128 when a ref is missing — and 128 collapsed into `false` is how "I
 * could not look" gets reported as "I looked and it was not there".
 */
export function gitStatus(args) {
  try {
    git(args);
    return 0;
  } catch (error) {
    const code = /** @type {{status?: number}} */ (error).status;
    return typeof code === 'number' ? code : null;
  }
}

/** Question 1. `rev-parse --verify` is NOT this; see the header. */
export function objectExists(sha) {
  return gitStatus(['cat-file', '-e', `${sha}^{commit}`]) === 0;
}

/**
 * Questions 2 and 3. `true`/`false` only when git actually answered; `null`
 * when it could not, which is a third state and not a soft `false`.
 */
export function isAncestor(sha, ref) {
  const status = gitStatus(['merge-base', '--is-ancestor', sha, ref]);
  if (status === 0) return true;
  if (status === 1) return false;
  return null;
}

/**
 * Question 4, for an object that is not an ancestor of the base.
 *
 * Matches on the commit SUBJECT because a squash merge concatenates the branch's
 * subjects into the merge commit's body. `--fixed-strings` so a subject
 * containing regex metacharacters — `fix(git): refuse ... (#81)` has three —
 * is matched literally rather than compiled.
 */
export function contentShipped(sha, base) {
  let record;
  try {
    record = git(['log', '-1', '--format=%p\u0001%s', sha]);
  } catch {
    return null;
  }
  const [parents, subject] = record.split('\u0001');
  if (!subject) return null;

  // A merge commit's subject is auto-generated — "Merge branch 'development'
  // into <branch>" — and dozens of them exist verbatim across unrelated PRs.
  // Measured on PR #149, whose head IS such a merge: `--grep` on that subject
  // returns nothing, and if it had returned something it would have been a
  // different PR's merge. Both outcomes are worthless, so the question is
  // reported as unaskable rather than answered.
  if ((parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1) {
    return null;
  }

  try {
    const hits = git([
      'log',
      '--format=%H',
      '--fixed-strings',
      `--grep=${subject}`,
      base,
    ]);
    return hits.length > 0 ? hits.split('\n')[0] : '';
  } catch {
    return null;
  }
}

/**
 * Classify from facts already gathered. Pure, so every verdict is testable
 * without a repository — including the ones that need a git failure to reach.
 *
 * @param {{exists: boolean, baseFresh?: boolean, onBase: boolean|null, onPr: boolean|null, isBaseTip?: boolean|null, behind?: number|null, shipped: string|null}} facts
 */
export function classify(facts) {
  const { exists, baseFresh = true, onBase, onPr, isPrHead, shipped } = facts;
  const { isBaseTip = null, behind = null } = facts;

  // Whether the WORK landed is decisive regardless of which not-on-the-base
  // case this is, so it is reported by every arm that has it rather than only
  // by the one it was first needed for. A verdict that computes this and then
  // drops it under-reports in the direction that costs a round: "your branch is
  // not an ancestor" is heard as "your work is lost", and the answer to the
  // second question was already in hand.
  const alsoShipped = shipped
    ? ` Its subject is on the base under ${shipped.slice(0, 12)}, so the WORK landed even though this object did not.`
    : shipped === null
      ? ' Whether the work landed could not be tested from the subject — a merge commit\u2019s subject is auto-generated and shared across unrelated PRs, so both a hit and a miss would be uninformative.'
      : '';

  if (!exists) {
    return {
      verdict: 'absent',
      summary:
        'no such object here. Either it never existed, or it exists only in a repository this one has not fetched. `rev-parse --verify` would have exited 0 on it.',
    };
  }
  if (onBase === true) {
    // The ancestry answer is correct and stays. What it cannot do is tell a head
    // from its predecessors, because not telling them apart is what ancestry is
    // for: `--is-ancestor` is true of the tip and of all 40 commits behind it,
    // so all 41 used to print the same line and that line ended in "Current."
    // Two sessions read an interior commit as the live head within one hour.
    //
    // The repair is the one already made at the PR-head arm below and never
    // carried across: a named head is a claim of EQUALITY, so only equality
    // settles it. Distance is what makes the remaining case self-correcting -
    // "40 commits behind the tip" cannot be misread as "this is the head",
    // whereas the absence of a claim can.
    if (isBaseTip === true) {
      return {
        verdict: 'tip',
        summary: 'the tip of the base itself. This is the head.',
      };
    }
    // Reported as unmeasured rather than as zero. If equality could not be
    // resolved, substituting the distance would answer the question with a
    // second instrument and present it as the first; and a caller cannot act on
    // "0 commits behind" from an arm that has just declined to say it is the
    // tip. The verdict stays `live` - it is on the trunk, which is a real
    // question with real callers - and only the claim of identity is withdrawn.
    const measured =
      typeof behind === 'number' && behind > 0
        ? `${behind} commit${behind === 1 ? '' : 's'} behind the tip`
        : 'an unmeasured distance behind the tip';
    return {
      verdict: 'live',
      summary: `an ancestor of the base, ${measured}. On the trunk, and NOT the head — quoting it as the current one is the misreading this arm exists to prevent.`,
    };
  }
  if (onBase === null) {
    return {
      verdict: 'unresolved',
      summary:
        'the object is here but the base could not be resolved, so its ancestry is unknown. This is not the same as "not an ancestor".',
    };
  }

  // Reached only when the base is a remote-tracking ref that could not be
  // refreshed. The guard is deliberately one-sided, and the asymmetry is the
  // whole reason it is cheap:
  //
  //   onBase === true  against a stale base is still true against the live one,
  //                    because the live tip descends from the cached one. Safe,
  //                    and answered above without a fetch.
  //   onBase === false against a stale base says nothing about the live one.
  //                    The commit may have landed in exactly the commits this
  //                    clone has not downloaded.
  //
  // Every arm below this point is predicated on "not on the base", so if that
  // input is a cache read, all of them are unsound — including the ones that go
  // looking for the subject on the base, which would search the same stale ref
  // and report the work missing twice.
  //
  // `onBase === false` here is redundant with the `onBase === true` arm above,
  // which has already returned. It is kept because it states the precondition
  // this arm actually depends on rather than relying on the order of the ones
  // before it, and because moving this block up — the obvious refactor — would
  // otherwise silently start refusing sound answers. Reported honestly: a
  // mutation widening this to `baseFresh === false` alone SURVIVES the suite,
  // because it is behaviourally identical today. The test below pins the
  // observable behaviour, which a reordering would break; it cannot pin a
  // clause that currently changes nothing.
  if (onBase === false && baseFresh === false) {
    return {
      verdict: 'base-stale',
      summary:
        'not an ancestor of the base as this clone has it, but the base is a remote-tracking ref that could not be refreshed — so that answer is about when this clone last fetched, not about the branch. A commit that landed since would read exactly like this. Refusing to convict on a cache.',
    };
  }

  // Not on the base. On its own that is the single most misread result in this
  // repo: it is equally the signature of work that squashed cleanly an hour ago
  // and of work that never landed at all.
  if (isPrHead === true) {
    // Found by running this tool on a live PR rather than by reasoning about
    // it. `--is-ancestor <sha> refs/pull/N/head` is TRUE for the head itself —
    // a commit is its own ancestor — so the ancestry test alone reported a
    // PR's current head as a superseded one. The predicate answers "was this
    // ever on the chain", which is a neighbouring question to "has this been
    // replaced", and the tip is exactly where the two diverge.
    //
    // The verdict is deliberately NOT "open". Found the same way, one run
    // later: `refs/pull/N/head` survives the merge, so this exact state is
    // also what a merged PR looks like — measured on #149, MERGED, whose head
    // this tool called an open PR. The ref cannot answer merge state and this
    // tool does not call GitHub, so it reports what the ref says and names the
    // limit instead of inferring past it.
    return {
      verdict: 'pr-head',
      summary: `the last head recorded for that PR, and not on the base. The ref survives a merge, so this is NOT evidence the PR is open — check its state.${alsoShipped}`,
    };
  }
  if (onPr === true) {
    return {
      verdict: 'stale',
      summary: shipped
        ? `a superseded head of that PR. Not on the base because the merge squashed it.${alsoShipped}`
        : 'a superseded head of that PR, and no commit on the base carries its subject. The work may still be unmerged.',
    };
  }
  if (onPr === false) {
    return {
      verdict: 'twin',
      summary:
        'a real object on a chain the named PR does not contain. `cat-file`, `ls-remote` and `gh api commits/<sha>` all succeed on this; only the PR-ref ancestry separates it from a genuine head.' +
        alsoShipped,
    };
  }
  return {
    verdict: 'indeterminate',
    summary:
      'exists, is not on the base, and no PR was named — so stale and twin cannot be told apart. Re-run with --pr <n>. Refusing to guess.' +
      alsoShipped,
  };
}

/**
 * Fetch the PR head ref so question 3 can be asked at all.
 *
 * `refs/pull/N/head` is not fetched by a default clone, so without this step
 * `--is-ancestor` exits 128 and — if the caller folds that into `false` — every
 * SHA is reported as a twin. Kept separate from `isAncestor` so that failure to
 * fetch surfaces as `null` rather than as a verdict.
 */
export function fetchPrHead(pr, remote = 'origin') {
  const local = `refs/tmp/sha-status/pr${pr}`;
  const status = gitStatus([
    'fetch',
    '--quiet',
    remote,
    `refs/pull/${pr}/head:${local}`,
  ]);
  return status === 0 ? local : null;
}

/**
 * Split a base like `origin/development` into the remote and branch that would
 * refresh it, or return null when the base is not a remote-tracking ref.
 *
 * Only remote-tracking refs are caches. A local branch or a raw SHA names an
 * object this repository is authoritative for, and there is nothing to refresh.
 */
export function remoteTrackingParts(base, remote = 'origin') {
  const bare = base.startsWith('refs/remotes/')
    ? base.slice('refs/remotes/'.length)
    : base;
  const prefix = `${remote}/`;
  if (!bare.startsWith(prefix)) return null;
  const branch = bare.slice(prefix.length);
  return branch.length > 0 ? { remote, branch } : null;
}

/**
 * Refresh the base before its ancestry is trusted.
 *
 * This exists because the tool shipped with the defect it was written to catch.
 * `refs/remotes/<remote>/<branch>` is a local cache that only `fetch` writes,
 * so question 2 — "is it live on the trunk" — was being answered against
 * whatever this clone last downloaded. Measured in a clone thirty commits
 * behind: a commit that IS on the trunk was reported `INDETERMINATE — exists,
 * is not on the base`. That is the same mistake `--force-with-lease` makes, and
 * it is the mistake this whole script exists to stop someone acting on.
 *
 * Fetched into a private ref so that the value this tool reasons about is one it
 * placed there itself, rather than whatever a concurrent sibling fetch leaves in
 * `refs/remotes/*`. Note what this does NOT buy: git still opportunistically
 * updates the remote-tracking ref for a configured remote, measured here — the
 * cache moved forward on its own during a run. That is benign, because a fetch
 * only advances it, but the private ref is for determinism and not for leaving
 * ref state untouched, and an earlier draft of this comment claimed otherwise.
 */
export function fetchBase(base, remote = 'origin') {
  const parts = remoteTrackingParts(base, remote);
  if (!parts) return { ref: base, fresh: true, refreshable: false };
  const local = `refs/tmp/sha-status/base`;
  const status = gitStatus([
    'fetch',
    '--quiet',
    parts.remote,
    `refs/heads/${parts.branch}:${local}`,
  ]);
  return status === 0
    ? { ref: local, fresh: true, refreshable: true }
    : { ref: base, fresh: false, refreshable: true };
}

/**
 * Resolve to a full commit id, or null. Both sides of the tip comparison go
 * through this: the caller may pass an abbreviation, and an abbreviation never
 * equals a 40-hex string no matter which commit it names, so comparing the
 * inputs directly would report every abbreviated tip as a non-tip.
 */
export function resolveCommit(rev) {
  try {
    return git(['rev-parse', `${rev}^{commit}`]);
  } catch {
    return null;
  }
}

/**
 * How many commits the base has that this one does not. Measured rather than
 * inferred, and returned as null when it cannot be measured, so a caller can
 * tell "zero" from "unknown" — the distinction the verdict below depends on.
 */
export function distanceToTip(sha, base) {
  try {
    const count = git(['rev-list', '--count', `${sha}..${base}`]);
    const parsed = Number.parseInt(count, 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export function inspect(
  sha,
  { base = 'origin/development', prRef = null, baseFresh = true } = {},
) {
  const exists = objectExists(sha);
  let prHeadSha = null;
  if (prRef) {
    try {
      prHeadSha = git(['rev-parse', `${prRef}^{commit}`]);
    } catch {
      prHeadSha = null;
    }
  }
  const facts = {
    sha,
    exists,
    baseFresh,
    onBase: exists ? isAncestor(sha, base) : null,
    onPr: exists && prRef ? isAncestor(sha, prRef) : null,
    isPrHead: prHeadSha ? sha === prHeadSha : null,
    isBaseTip: null,
    behind: null,
    shipped: null,
  };
  if (facts.onBase === true) {
    // Only asked where it can change an answer. Everything below "on the base"
    // is already not the tip, so the two extra reads are confined to the arm
    // that was conflating them.
    const here = resolveCommit(sha);
    const tip = resolveCommit(base);
    facts.isBaseTip = here && tip ? here === tip : null;
    facts.behind = distanceToTip(sha, base);
  }
  if (exists && facts.onBase === false && baseFresh) {
    facts.shipped = contentShipped(sha, base);
  }
  return { ...facts, ...classify(facts) };
}

export function parseArgs(argv) {
  const options = {
    shas: [],
    base: 'origin/development',
    pr: null,
    remote: 'origin',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base' || arg === '--pr' || arg === '--remote') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--base') options.base = value;
      else if (arg === '--remote') options.remote = value;
      else {
        if (!/^\d+$/.test(value))
          throw new Error(`--pr requires a number, got ${value}`);
        options.pr = value;
      }
    } else if (arg.startsWith('-')) {
      // Silently ignoring an unknown flag is how a check gets believed to have
      // run under options it never received.
      throw new Error(`unknown option ${arg}`);
    } else if (SHA_PATTERN.test(arg)) {
      options.shas.push(arg.toLowerCase());
    } else {
      // A prefix is rejected rather than expanded. Abbreviations are what let a
      // SHA be extended by invention in the first place — the `squad-name-audit`
      // near-miss in `.squad/decisions.md` began exactly there.
      throw new Error(`not a full-length object name: ${arg}`);
    }
  }
  if (options.shas.length === 0) throw new Error('no object names given');
  return options;
}

export function main(argv = process.argv.slice(2), out = console) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out.error(`[sha-status] ${/** @type {Error} */ (error).message}`);
    out.error(
      '[sha-status] usage: node scripts/sha-status.mjs <40-hex sha...> [--pr N] [--base <ref>] [--remote <name>]',
    );
    return 2;
  }

  let prRef = null;
  if (options.pr) {
    prRef = fetchPrHead(options.pr, options.remote);
    if (!prRef) {
      out.error(
        `[sha-status] could not fetch refs/pull/${options.pr}/head from ${options.remote}; stale and twin cannot be separated without it`,
      );
    }
  }

  const baseState = fetchBase(options.base, options.remote);
  if (baseState.refreshable && !baseState.fresh) {
    out.error(
      `[sha-status] could not refresh ${options.base} from ${options.remote}; it is a cache and every "not on the base" answer below would be about this clone rather than about the branch`,
    );
  }

  let allLive = true;
  for (const sha of options.shas) {
    const result = inspect(sha, {
      base: baseState.ref,
      prRef,
      baseFresh: baseState.fresh,
    });
    // `pr-head` is the ref's own answer and not a failure of the check, but it
    // is also not a clean bill: the ref survives a merge. The exit code answers
    // "is every SHA here still worth quoting", not "is everything merged".
    //
    // `tip` is listed explicitly. It was carved out of `live`, so omitting it
    // here would have made the single most current object a caller can name -
    // the head itself - exit 1, while its own predecessors kept exiting 0. A
    // new verdict is not an additive change: every place that tests a verdict
    // by value has to be revisited, and this is the one that gates the process.
    if (
      result.verdict !== 'live' &&
      result.verdict !== 'tip' &&
      result.verdict !== 'pr-head'
    )
      allLive = false;
    out.log(
      `[sha-status] ${sha.slice(0, 12)}  ${result.verdict.toUpperCase()}`,
    );
    out.log(`             ${result.summary}`);
  }
  return allLive ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
