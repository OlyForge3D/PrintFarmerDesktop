// pre-push guard: refuses a push that would destroy commits the pusher never read.
//
// Why this exists (issue #81). `git push --force-with-lease` with no argument
// compares the push against the LOCAL REMOTE-TRACKING REF, so it answers "has
// anything changed since I last fetched?" — not "since I last pushed?", and not
// "is the remote where I believe it is?". Two real incidents on this repo:
//
//   * PR #78 — a second session pushed `254fd9e` and `b9f1dea`; something
//     fetched in the background, `origin/<branch>` advanced to those commits,
//     and the lease then compared them against themselves. The push was
//     accepted and both commits were destroyed unread.
//   * `squad-name-audit` — an explicit lease was written from a SHA that had
//     never been read (a short prefix extended to a full-length hash by
//     invention). Bare `--force-with-lease` would have ACCEPTED that push,
//     because the default lease never consults the pusher's belief at all.
//
// So the guard does what git will not do for you: it treats "this push destroys
// commits on the remote" as the thing needing authorisation, and makes the
// authorisation a value that cannot be produced without reading it.
//
//   1. The destroyed set is computed against the tip resolved by a live
//      `git ls-remote` — never a `refs/remotes/**` read — so a tracking ref
//      advanced by a background fetch cannot hide anything. Verified behaviour:
//      git hands the hook the tip advertised by the remote, so the two normally
//      agree; when they do not, the remote moved during the push and the guard
//      refuses rather than deciding on either value.
//   2. A push that destroys commits requires the pusher to NAME the live tip
//      (`PF_PUSH_ACK`). A SHA that was never read cannot match, so the
//      fabricated-SHA case fails closed where the default lease accepts it.
//
// The #78 push is refused by (1): the lease was satisfied, git was willing, and
// the commits about to be destroyed carried a session id the pusher had never
// seen.
//
// Commits destroyed by a DIFFERENT session — identified by the
// `Copilot-Session` trailer, which `.squad/decisions.md` establishes as the only
// reliable discriminator between concurrent writers (committer and author
// identity are per-worktree config and prove nothing) — are refused separately,
// and the override has to name the foreign session id.
//
// Limits, stated plainly: `--no-verify` bypasses any hook, and a hook only binds
// clones where `npm install` has run. This raises a silent accident to a
// deliberate, legible act; it is not a server-side control. Branch protection on
// the remote is the only true enforcement and is not configurable from here.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ZERO_SHA = '0'.repeat(40);

/** Branches this repo never accepts a direct push to — everything lands by PR. */
export const PROTECTED_REFS = Object.freeze([
  'refs/heads/development',
  'refs/heads/main',
]);

export const ACK_ENV = 'PF_PUSH_ACK';
export const ACK_FOREIGN_ENV = 'PF_PUSH_ACK_FOREIGN';

const isAbsent = (sha) => !sha || sha === ZERO_SHA;
function sessionsOf(commits) {
  const seen = new Set();
  for (const commit of commits) {
    for (const session of commit.sessions ?? []) seen.add(session);
  }
  return seen;
}

function describe(commits) {
  return commits
    .map((commit) => {
      const sessions = (commit.sessions ?? []).join(', ');
      const suffix = sessions ? `   [session ${sessions}]` : '';
      return `    ${commit.sha.slice(0, 12)}  ${commit.subject ?? ''}${suffix}`;
    })
    .join('\n');
}

/**
 * Decide a single ref update. Pure: every value that required reading git or the
 * remote is passed in, so each branch of the decision is unit-testable.
 *
 * @param {{localRef: string, localSha: string, remoteRef: string, remoteSha: string}} update
 *   The four fields git writes on the pre-push hook's stdin. `remoteSha` is
 *   git's own view of the remote tip — that is, the tracking ref, which is
 *   exactly the value that cannot be trusted.
 * @param {{
 *   liveRemoteSha: string | null,
 *   discarded: Array<{sha: string, subject?: string, sessions?: string[]}>,
 *   ownSessions?: Iterable<string>,
 *   ownCommits?: Iterable<string>,
 *   ownershipEvidence: boolean,
 *   ack?: string,
 *   ackForeign?: string,
 * }} facts
 *   `liveRemoteSha` MUST come from `git ls-remote` (a live query), never from a
 *   `refs/remotes/**` read. `discarded` is `rev-list <live> ^<local>` — the
 *   commits this push would remove from the remote.
 *
 *   `ownershipEvidence` is required and says whether this worktree can answer
 *   the ownership question at all. It is NOT "are these commits mine"; it is "is
 *   the instrument working". Absence of a session id from `ownSessions` means
 *   something only when the instrument that would have recorded it was running.
 *
 *   `ownCommits` is the sha set this worktree actually created. It defaults to
 *   empty, which is the strict reading: nothing was created here, so nothing is
 *   exempt. `ownSessions` cannot substitute for it — see `readOwnedCommits`.
 * @returns {{verdict: 'allow' | 'refuse', code: string, message: string}}
 */
export function evaluateRefUpdate(update, facts) {
  const { localSha, remoteRef } = update;
  const { liveRemoteSha, discarded = [], preserved = [] } = facts;
  const ack = (facts.ack ?? '').trim();
  const ackForeign = facts.ackForeign ?? '';

  if (PROTECTED_REFS.includes(remoteRef)) {
    return {
      verdict: 'refuse',
      code: 'push-guard.protected-ref',
      message: [
        `${remoteRef} does not take direct pushes.`,
        'Open a pull request against development instead.',
      ].join('\n'),
    };
  }

  // The live query failed. Deciding from the advertised value is not a
  // fallback to a worse fact — for THIS question it is a sufficient one: if
  // the advertised tip is an ancestor of what we are pushing, the update adds
  // commits and removes none, and that is true regardless of what `ls-remote`
  // would have said. Fail open only where destruction is provably impossible.
  //
  // `provablyFastForward` is a tri-state and only `true` is evidence. `false`
  // (not an ancestor) and `null` (we do not have the object, so the question
  // is unanswerable) collapse into the same refusal. That collapse is
  // deliberate: treating "unanswerable" as "destructive" is safe, treating it
  // as "harmless" would be fail-open.
  if (facts.liveQueryFailed) {
    if (facts.provablyFastForward === true) {
      return {
        verdict: 'allow',
        code: 'push-guard.unverified-fast-forward',
        message: [
          `WARNING: could not read ${remoteRef} from the remote, so this push was`,
          'checked against the tip the remote advertised rather than a live query.',
          'It adds commits and discards none, so nothing can be lost. A destructive',
          'push in this state would have been refused.',
          `  (${facts.liveQueryError.split('\n')[0]})`,
        ].join('\n'),
      };
    }
    const why =
      facts.provablyFastForward === false
        ? 'this push is not a fast-forward — it would discard commits that are on the remote.'
        : 'the advertised tip is not in your object store, so what this push would discard cannot be determined.';
    return {
      verdict: 'refuse',
      code: 'push-guard.unverifiable-remote',
      message: [
        `Could not read ${remoteRef} from the remote, and ${why}`,
        `  (${facts.liveQueryError.split('\n')[0]})`,
        '',
        'Fetch, read what is there, and push again:',
        `  git fetch origin ${remoteRef}`,
      ].join('\n'),
    };
  }

  // git hands the hook the tip the remote advertised, which is normally the
  // truth. If our own live query disagrees, the remote moved mid-push and no
  // decision below can be trusted — refuse rather than pick a value. This is a
  // narrow window, not the #78 mechanism; #78 is caught by the discard check.
  const live = isAbsent(liveRemoteSha) ? ZERO_SHA : liveRemoteSha;
  const claimed = isAbsent(update.remoteSha) ? ZERO_SHA : update.remoteSha;
  if (live !== claimed) {
    return {
      verdict: 'refuse',
      code: 'push-guard.stale-lease',
      message: [
        `${remoteRef} is at ${live === ZERO_SHA ? '(absent)' : live} on the remote right now,`,
        `but your lease was computed against ${claimed === ZERO_SHA ? '(absent)' : claimed}.`,
        'Your remote-tracking ref moved without you reading it — most likely a',
        'background fetch picked up another session\u2019s commits.',
        '',
        `Read them first:  git log --oneline ${claimed === ZERO_SHA ? live : `${claimed}..${live}`}`,
      ].join('\n'),
    };
  }

  if (isAbsent(localSha)) {
    if (ack === live) {
      return {
        verdict: 'allow',
        code: 'push-guard.acknowledged-delete',
        message: `deleting ${remoteRef} at acknowledged tip ${live}`,
      };
    }
    return {
      verdict: 'refuse',
      code: 'push-guard.branch-delete',
      message: [
        `This deletes ${remoteRef}, discarding everything at ${live}.`,
        '',
        describe(discarded),
        '',
        `If that is intended:  ${ACK_ENV}=${live} git push ...`,
      ].join('\n'),
    };
  }

  if (live === ZERO_SHA) {
    return {
      verdict: 'allow',
      code: 'push-guard.new-branch',
      message: `${remoteRef} does not exist on the remote yet`,
    };
  }

  // The remote tip is not in this repository's object store, so the set of
  // commits this push would destroy CANNOT BE ENUMERATED — `git log <live>
  // ^<local>` dies with `fatal: bad object`.
  //
  // Read this before deciding the refusal is over-cautious: in this state
  // "the push is non-destructive" is not merely unproven, it is NOT
  // DETERMINABLE, so failing closed is the only honest option rather than the
  // conservative one of two workable choices. A fast-forward can never reach
  // here — a fast-forward's remote tip is by definition an ancestor of local
  // HEAD and therefore present — so nothing provably harmless is being
  // refused, and widening this to fail open would trade a determinate refusal
  // for a guess. It is also the single most dangerous case the guard exists
  // for: unfetched commits on a shared branch is precisely the PR #78 clobber.
  // Fail closed on anything that is not an explicit, measured `true`. This is
  // deliberately not `=== false`: an absent field would then be read as "tip
  // present" and skip this refusal, which is a fail-open default inside a
  // fail-closed control — a call site that forgets to measure would silently
  // get the permissive answer. `gatherFacts` always measures it, so there is no
  // legitimate way to arrive here without it. The vacuous case (no live tip at
  // all) never reaches this line; the new-branch allow above returns first.
  if (facts.liveTipPresent !== true) {
    return {
      verdict: 'refuse',
      code: 'push-guard.unfetched-remote-tip',
      message: [
        `${remoteRef} is at ${live} on the remote, and that commit is not in your`,
        'object store — you have never fetched what this push would overwrite, so',
        'the guard cannot show you what would be destroyed.',
        '',
        'Fetch it and look before deciding:',
        `  git fetch origin ${remoteRef}`,
        `  git log --oneline ${localSha}..${live}`,
      ].join('\n'),
    };
  }

  if (discarded.length === 0) {
    // Two different situations reach zero, and calling both a fast-forward
    // would be a false statement in the one place the guard is trying to make
    // true ones. The decision function cannot tell them apart from a count, so
    // `preserved` is measured and passed in rather than inferred here.
    if (preserved.length > 0) {
      return {
        verdict: 'allow',
        code: 'push-guard.rewrite-preserves-all',
        message: [
          `${remoteRef} is rewritten, and every commit it removes from the ref`,
          `survives locally under a new sha (${preserved.length} carried forward).`,
          'Nothing is destroyed, so this is the outcome the foreign-session',
          'refusal asks for rather than a case to be overridden.',
        ].join('\n'),
      };
    }
    return {
      verdict: 'allow',
      code: 'push-guard.fast-forward',
      message: `${remoteRef} advances without discarding anything`,
    };
  }

  const ownSessions = new Set(facts.ownSessions ?? []);
  const ownCommits = new Set(facts.ownCommits ?? []);
  // Ownership is a question about objects, not about what those objects say
  // about themselves. A discarded commit is this worktree's only if this
  // worktree created that exact commit — see `readOwnedCommits` for why the
  // session id cannot carry this and what it measured.
  const unowned = discarded.filter((commit) => !ownCommits.has(commit.sha));
  const foreign = [...sessionsOf(unowned)].filter(
    (session) => !ownSessions.has(session),
  );
  // A session id missing from `ownSessions` is only evidence of a second writer
  // if the thing that records authorship was running AND had something to
  // record. It is the reflog, and it is not always either: `logAllRefUpdates=
  // false` turns it off, entries expire, and a clone that has authored nothing
  // has no `commit` entry to put any id into the set.
  //
  // Measured, with that config as the only variable: a solo total rollback is
  // reported as `foreign-session`, "written by another session", naming the
  // pusher's own id and printing PF_PUSH_ACK_FOREIGN for it. One writer, told to
  // acknowledge themselves as a second. The comment on readReflogSessions used
  // to claim an empty set "fails toward MORE refusals" and is therefore safe;
  // more refusals is not safe when the extra refusals are false and their remedy
  // is the override that disables this very check. Teaching a solo developer
  // that PF_PUSH_ACK_FOREIGN is a routine step costs more than the check earns.
  //
  // So absence is split by whether it is informative, and the two cases get
  // different codes and different remedies.
  // Exact membership, not substring. `includes` on the raw string would let an
  // acknowledgement of `abc` satisfy a refusal naming `abc-def`, which is the
  // same defect the trailer matching had to avoid: a token is a token, and a
  // prefix of it is not evidence of having read anything. Shared by both arms
  // that consume it, so the two cannot drift apart.
  const acknowledgedTokens = new Set(
    ackForeign
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  if (foreign.length > 0 && facts.ownershipEvidence) {
    const acknowledged = foreign.every((session) =>
      acknowledgedTokens.has(session),
    );
    if (!acknowledged) {
      return {
        verdict: 'refuse',
        code: 'push-guard.foreign-session',
        message: [
          `This push destroys ${discarded.length} commit(s) carrying a session id`,
          'this worktree has never authored a commit under.',
          `Session id(s) never authored here: ${foreign.join(', ')}`,
          '',
          describe(discarded),
          '',
          'Two sessions are writing this branch. Read that work and rebase onto it',
          'rather than over it. If you have read it and it is genuinely obsolete:',
          `  ${ACK_FOREIGN_ENV}="${foreign.join(' ')}" ${ACK_ENV}=${live} git push ...`,
        ].join('\n'),
      };
    }
  }

  if (foreign.length > 0 && !facts.ownershipEvidence && ack.length === 0) {
    return {
      verdict: 'refuse',
      code: 'push-guard.unattributed-discard',
      message: [
        `This push destroys ${discarded.length} commit(s), and this worktree cannot`,
        'establish whether they are yours.',
        `Session id(s) never authored here: ${foreign.join(', ')}`,
        '',
        describe(discarded),
        '',
        'That is an absence, not a finding: this worktree has recorded no authorship',
        "of its own, so the same absence is produced by another session's work",
        'and by a rollback of all of your own. Read the commits.',
        '',
        'Acknowledge the tip you are overwriting:',
        `  npm run push:force`,
        '',
        'This worktree records no authorship either because reflogs are off:',
        '  git config core.logAllRefUpdates true',
        'or because everything here arrived by fetch and nothing was committed',
        'in it, which a fresh clone doing a pure rewind always looks like.',
      ].join('\n'),
    };
  }

  // Commits this worktree did not create, whose session ids it nonetheless has
  // authored under. `foreign` cannot see these — the id matches, so the strong
  // check is satisfied by a literal rather than by provenance, which is the #264
  // hole: two sessions handed the same brief emit the same trailer, and the one
  // refusal that cannot be cleared without reading the other writer's work
  // silently degrades into one that a reflex clears.
  //
  // This arm is deliberately NOT folded into `foreign-session`. That refusal
  // says "written by another session" and names the id; here the id is one of
  // ours, so that sentence would be a claim the evidence does not support. What
  // is known is narrower and is what the operator has to act on: these objects
  // were not created here. Expiry produces the same observation as a second
  // writer — `gc.reflogExpireUnreachable` is 30 days and a commit under
  // adjudication has just become unreachable — so the message states the
  // ambiguity rather than picking the alarming reading of it.
  //
  // The acknowledgement is per-sha and not per-id on purpose. A sha cannot be
  // derived from the refusal's own wording the way a shared id can; naming it
  // requires having looked at the commit, which is the property that made the
  // foreign refusal worth having.
  if (unowned.length > 0 && facts.ownershipEvidence) {
    const unacknowledged = unowned.filter((commit) => {
      if (acknowledgedTokens.has(commit.sha)) return false;
      // A commit whose FOREIGN id was named is already covered. The strong arm
      // above printed that id, the operator supplied it, and requiring the sha
      // as well would refuse a push whose remedy has just been performed —
      // turning one refusal into two and teaching that the way through is to
      // keep adding tokens until it stops complaining.
      //
      // Only ids absent from `ownSessions` count. Accepting an id this worktree
      // has authored under would restore the exact hole this arm exists to
      // close: the shared value is one the operator can supply from their own
      // commits without ever having looked at the other writer's.
      return !(commit.sessions ?? []).some(
        (session) =>
          !ownSessions.has(session) && acknowledgedTokens.has(session),
      );
    });
    if (unacknowledged.length > 0) {
      return {
        verdict: 'refuse',
        code: 'push-guard.unowned-discard',
        message: [
          `This push destroys ${unacknowledged.length} commit(s) that this worktree did not`,
          'create. Their session id is one this worktree has authored under, so the',
          'id alone cannot tell your work apart from a second writer handed the',
          'same brief.',
          '',
          describe(unacknowledged),
          '',
          'That is an absence, not a finding: no creation of these commits is',
          'recorded here, which is equally what a second writer and an expired',
          'reflog look like. Read them.',
          '',
          'If they are genuinely yours or genuinely obsolete, name them:',
          `  ${ACK_FOREIGN_ENV}="${unacknowledged.map((commit) => commit.sha).join(' ')}" ${ACK_ENV}=${live} git push ...`,
        ].join('\n'),
      };
    }
  }

  if (ack.length === 0) {
    return {
      verdict: 'refuse',
      code: 'push-guard.unacknowledged-discard',
      message: [
        `This push destroys ${discarded.length} commit(s) currently on the remote:`,
        '',
        describe(discarded),
        '',
        'Read them, then acknowledge the tip you are overwriting:',
        `  npm run push:force`,
        `or  ${ACK_ENV}=${live} git push --force-with-lease=${remoteRef.replace('refs/heads/', '')}:${live} --force-if-includes ...`,
      ].join('\n'),
    };
  }

  if (ack !== live) {
    return {
      verdict: 'refuse',
      code: 'push-guard.ack-mismatch',
      message: [
        `${ACK_ENV} is ${ack}, but ${remoteRef} is at ${live}.`,
        'You are overwriting a tip other than the one you named. A value you did',
        'not read cannot match this check — re-read it rather than retyping it:',
        `  git ls-remote origin ${remoteRef}`,
      ].join('\n'),
    };
  }

  return {
    verdict: 'allow',
    code: 'push-guard.acknowledged-discard',
    message: `discarding ${discarded.length} commit(s) at acknowledged tip ${live}`,
  };
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

/**
 * The URL `git push` will actually use. `git push` resolves
 * `remote.<name>.pushurl`; `git ls-remote <name>` resolves `remote.<name>.url`.
 * Those differ by design in any clone that fetches over HTTPS and pushes over
 * SSH (`pushurl`, `url.<base>.pushInsteadOf`), and querying the wrong one made
 * the guard refuse plain fast-forwards that git was always going to accept —
 * a permanent lockout, since the fix would have to be pushed through it.
 *
 * `git ls-remote --push` does not exist; this is the supported spelling. Falls
 * back to the argument itself, which is correct when a bare URL was passed to
 * `git push` rather than a remote name.
 *
 * Used only as a FALLBACK. `remote.<name>.pushurl` is multi-valued — the
 * standard way to mirror one remote to several — and this returns only the
 * first while `git push` writes to all of them. Preferring git's own per-push
 * location (see `readLiveRemoteSha`) avoids resolving a URL at all.
 */
export function readPushUrl(remote) {
  try {
    return git(['remote', 'get-url', '--push', remote]).trim() || remote;
  } catch {
    return remote;
  }
}

/**
 * Live remote tip. `ls-remote` queries the remote; `refs/remotes/**` does not.
 *
 * `location` is the second argument git gives the pre-push hook: the URL this
 * invocation is actually pushing to, already resolved. Preferring it is not a
 * tidier spelling of `readPushUrl` — it is the only correct one when a remote
 * has several push URLs.
 *
 * `remote.<name>.pushurl` is multi-valued and mirroring one remote to several
 * is its main use. `git push` writes to every one and runs this hook once per
 * URL, passing that URL here; `git remote get-url --push` returns only the
 * first. Measured, with two mirrors whose tips had diverged: resolving the
 * first meant the guard evaluated the second mirror's push against the FIRST
 * mirror's tip. It happened to refuse — the tip on stdin is per-URL, so the
 * stale-lease check caught the mismatch — but it refused with a message about
 * a background fetch that had not happened, and the check that saved it was
 * not the one aimed at the problem. A guard that is correct by accident is one
 * refactor away from being wrong silently.
 *
 * Falls back to resolving the remote name when `location` is absent, which is
 * how the function is called outside the hook.
 */
export function readLiveRemoteSha(remote, ref, location = '') {
  const target = location.trim() || readPushUrl(remote);
  const output = git(['ls-remote', target, ref]).trim();
  if (!output) return null;
  const first = output.split('\n')[0] ?? '';
  const sha = first.split('\t')[0]?.trim();
  return sha && sha.length > 0 ? sha : null;
}

/**
 * Tri-state, and the three states are NOT interchangeable:
 *   true  (exit 0)   — ancestor, so the update destroys nothing
 *   false (exit 1)   — not an ancestor, so it does
 *   null  (exit 128) — `fatal: Not a valid commit name`: we do not have the
 *                      object, so the question is unanswerable
 *
 * Callers collapse `false` and `null` into the same refusal. That collapse is
 * deliberate rather than incidental: only exit 0 is evidence of anything, and
 * treating 128 as 1 is safe while treating it as 0 would be fail-open.
 *
 * A comment saying so is a commitment, not a control, so all three outcomes are
 * separately constructed in the tests and the two refusals carry different
 * diagnostics — `not a fast-forward` for 1, `cannot be determined` for 128 —
 * each pinned. Collapse the tri-state here and a test fails.
 *
 * 128 has TWO meanings, which is the trap: a new ref advertises the zero sha,
 * which is not a valid commit name either. `gatherFacts` answers that case
 * before calling this, and that is not a nicety — it is what makes 128
 * decidable at all. Remove it and every new-branch push is refused, which is
 * also pinned.
 */
export function isAncestor(ancestor, descendant) {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    return error && error.status === 1 ? false : null;
  }
}

/**
 * Is the remote tip in our object store? Asked before enumerating the discarded
 * commits, because `git log <live> ^<local>` on an absent object dies with
 * `fatal: bad object` — a diagnostic that says nothing about what is actually
 * wrong, on the most dangerous path the guard has.
 */
export function hasCommit(sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

const RECORD = '\u001e';
const FIELD = '\u001f';

/**
 * Sessions this worktree can account for having held — read from the reflog, which
 * is a direct observation of local provenance rather than a proxy for it.
 *
 * "Is this commit mine?" was previously answered with "is some other commit of
 * the same session still reachable from my tip?", which is merely correlated
 * with it. It fails on the most likely destructive push a lone session makes:
 * rolling back ALL of its own work, where every commit carrying its id is
 * exactly what is being removed, so the guard called the pusher's own work
 * another session's.
 *
 * The reflog answers the real question, but only if the right entries are read.
 * A reflog is a record of WHERE THE REF WENT, not of what this worktree wrote,
 * and `git log -g <ref>` yields one commit per entry — the commit the ref moved
 * to. So every foreign commit this clone ever fast-forwarded onto is in there,
 * named by an entry. "A fetched commit does not enter the reflog" is true of
 * `git fetch` in isolation, which moves only `refs/remotes/*`, and it is
 * worthless as a safety property: the local branch moves constantly.
 *
 * Measured, one arm per operation, with a foreign session's commit upstream and
 * this clone doing nothing but the named operation. The subject (`%gs`) is what
 * separates them; the trailer on the entry's commit is the foreign id:
 *
 *     pull, fast-forward   `pull …: Fast-forward`            THEIRS
 *     pull, true merge     `pull …: Merge made by 'ort'`     (merge commit)
 *     cherry-pick          `cherry-pick: their work`         THEIRS
 *     rebase onto theirs   `rebase (start): checkout <sha>`  THEIRS
 *     my own commit        `commit: my work`                 MINE
 *
 * Every arrival names the foreign id; only creation names mine. That is why the
 * filter is on the subject and not on the trailer, and why it is `commit` and
 * not "any entry". Restricting to creation fails toward MORE refusals, never
 * fewer, and it survives a rebase of your own work: the rewritten copies carry
 * the same session id as the originals, whose `commit` entries are still there.
 *
 * This matters more here than the arithmetic suggests. Most PRs in this repo sit
 * BEHIND under a strict required-checks policy, so pulling `development` to stay
 * mergeable is the most frequent operation anyone performs — which makes
 * "arrived by pull" the normal state of the reflog rather than an edge of it. A
 * predicate that accepted arrivals would be carrying foreign ids almost always,
 * and the failure would be silent and in the permissive direction.
 *
 * `git checkout` of another session's fetched branch is the same class and was
 * the case that first falsified a looser predicate here: it writes an entry
 * naming their tip, which laundered their commits into "mine" and silenced the
 * foreign alarm on the exact scenario #81 is about. That was measured too, after
 * the first measurement had already been believed.
 *
 * Only HEAD's reflog is read, and which file that is decides the answer.
 * Measured, in the layout this squad actually runs — eight-plus worktrees off
 * one clone:
 *
 *     <git-dir>/logs/HEAD              PER-WORKTREE
 *     <common-dir>/logs/refs/heads/…   SHARED by every worktree
 *
 * The branch reflog used to be read too, on the reasoning that it "covers
 * commits made on that branch". It does — including commits made on it from
 * SOMEBODY ELSE'S worktree, which is this guard's entire subject matter. A
 * worktree is retired (routine here); its branch reflog stays behind in the
 * common dir; the next session to pick that branch up reads the departed
 * session's `commit` entries as its own and the foreign alarm is silenced for
 * exactly the work it was built to protect. Measured: session A destroyed two
 * of session B's commits and was told `unacknowledged-discard`, the LONE-WRITER
 * verdict, with the two-writer warning and the foreign override both withheld.
 * Authorisation dropped from two acknowledgements to one, silently.
 *
 * Dropping the branch reflog costs nothing, because HEAD's is a superset of it
 * for the only thing being asked. Every `git commit` moves the HEAD of the
 * worktree it runs in and writes a `commit` entry there, whatever branch is
 * checked out and even when none is. So the branch reflog contributed no
 * authorship of this worktree's that HEAD lacks — it contributed only other
 * worktrees'. The narrowing removes the leak and nothing else.
 *
 * If reflogs are disabled the set is empty — which is NOT safely "stricter". An
 * empty set makes every discarded commit look foreign, including the pusher's
 * own, and the remedy the guard then prints is the override that turns this
 * check off. See `authoredHere`, which is what keeps that absence from being
 * read as a finding.
 *
 * Expiry degrades the same way and faster than it looks: `gc.reflogExpire` is 90
 * days, but `gc.reflogExpireUnreachable` is 30, and a commit this guard
 * adjudicates is by construction one that has just become unreachable. So the
 * evidence for the ids that matter most decays on the shortest clock git offers.
 * That direction is toward `unattributed-discard` — refuse, and claim less —
 * which is the one direction it is safe to fail in.
 *
 * This is the ONLY source of ownership. A reachability term was unioned in
 * alongside it and has been removed: it let a session id be claimed as "held
 * here" merely because one commit carrying it was still reachable from the local
 * tip, which is true of anything fetched. That silenced the foreign claim for
 * the REST of that session's work in the same push. Measured, and reached by
 * following this guard's own advice to rebase onto another session's work
 * rather than over it.
 */
const CREATED_HERE = /^commit(?: \(initial\))?:/;

/**
 * `git commit --amend`. Not creation on its own: an amend rewrites whatever
 * commit HEAD already pointed at, and that commit may be another session's.
 * Accepted only when its predecessor was created here — see `creationEntries`.
 */
const AMENDED_HERE = /^commit \(amend\):/;

/**
 * The reflog entries that represent work THIS worktree created, as opposed to
 * work it merely moved onto or re-applied.
 *
 * The predicate used to be `/^commit\b/`, which is wrong in a way no operation
 * test could find, because the operations are not the variable — the reflog
 * SUBJECT is, and `\b` matches four different subjects that git spells with a
 * `commit` prefix. Measured on git 2.53.0, foreign work arriving ONLY by fetch
 * so that no plain `commit:` entry can name it (a first attempt at this table
 * created their commit locally and reported six leaks, all of them artefacts of
 * the harness — the confounder is asserted against in the tests now):
 *
 *     operation                          subject                     old  new
 *     ---------------------------------- --------------------------- ---- ----
 *     cherry-pick, CONFLICT, --continue  commit (cherry-pick): …     LEAK ok
 *     commit --amend on a fetched commit commit (amend): …           LEAK ok
 *     cherry-pick, clean                 cherry-pick: …              ok   ok
 *     merge, CONFLICT, resolved          commit (merge): …           ok*  ok
 *     rebase carrying their commit       rebase (pick): …            ok   ok
 *     revert of a fetched commit         revert: …                   ok   ok
 *     fast-forward pull                  merge …: Fast-forward       ok   ok
 *     my own commit                      commit: …                   ok   ok
 *
 * The two leaks are the point. Both are `git commit` invocations that re-apply
 * a message somebody else wrote, so the resulting commit carries THEIR trailer
 * while the reflog says this worktree committed it. Their id entered the owned
 * set, the `foreign-session` check went quiet for the rest of their work in the
 * same push, and authorisation dropped from two acknowledgements to one — the
 * silent, permissive direction, on the highest-severity check there is.
 *
 * Neither is exotic. A cherry-pick that conflicts is the ordinary outcome of
 * moving one commit across diverged branches, and `checkout <shared-branch>;
 * commit --amend` on a tip you assume is yours but which arrived in the last
 * pull is #81's own scenario reached from the other side.
 *
 * `commit (merge)` is marked `ok*` rather than `ok` deliberately. It PASSED the
 * old predicate and leaked nothing only because git generates the merge message
 * itself, so the merge commit carries no trailer to leak. That is an accidental
 * property with no owner: anything that ever teaches this squad's tooling to
 * trailer merge commits turns it into a third leak, silently, with no code
 * change here. It is excluded on the rule rather than left to luck.
 *
 * The clean/conflicting cherry-pick split is why the subject, not the
 * operation, is the variable. The SAME command yields `cherry-pick:` when it
 * applies cleanly and `commit (cherry-pick):` when you resolve it, and only the
 * second one leaked. A test suite enumerating operations would have had to pick
 * the conflicting variant by luck.
 *
 * Amend is not simply dropped, because dropping it has a measured cost:
 * `git commit -m wip` then `git commit --amend` with the full trailered message
 * leaves your id in the AMEND entry only — the `commit: wip` entry names the
 * pre-amend commit, which has no trailer. Losing it there would make your own
 * work look foreign and print your own session id back at you as another
 * session's, which is precisely the claim this guard is not allowed to make.
 *
 * So an amend is accepted when the commit it rewrote was created here, which
 * the reflog answers directly: an amend moves HEAD from the pre-amend commit,
 * so the pre-amend commit is exactly the next-older entry. Walking oldest-first
 * makes chains of amends resolve too. The leaking arm's predecessor is
 * `checkout: moving from main to origin/theirs` — an arrival, so the amend is
 * refused; the costly arm's is `commit: wip` — creation, so it is kept.
 *
 * When there is no older entry the amend is not accepted. That is the strict
 * direction for contamination and it is the only one available, since the
 * evidence that would settle it is the entry that is missing.
 */
function creationEntries(ref) {
  const entries = readReflogEntries(ref);
  // `git log -g` is newest-first, so walking down the index walks backwards in
  // time, which is what lets an amend consult the entry it rewrote.
  const created = new Array(entries.length).fill(false);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const subject = entries[i].reflogSubject;
    if (CREATED_HERE.test(subject)) created[i] = true;
    else if (AMENDED_HERE.test(subject))
      created[i] = i + 1 < entries.length && created[i + 1];
  }
  return entries.filter((_, index) => created[index]);
}

/**
 * Whether this worktree authored anything, and so whether the absence of a session
 * id from `readReflogSessions` carries information.
 *
 * This used to ask whether the reflog produced ANY entry, on the reasoning that
 * a working reflog showing you authored nothing here is a real finding that
 * supports calling the discarded work foreign. That reasoning was wrong, and the
 * case that falsifies it is a fresh clone: `git clone` writes reflog entries, so
 * the mechanism is plainly working, but every commit arrived by fetch and none
 * was created here. Roll back your own work in a clone you did not author it in
 * and the old test says "evidence present, your id is absent" — which is the
 * original defect, reached by a different road.
 *
 * So the question is narrowed to whether this worktree CREATED a commit, which is
 * the only thing that can put a session id into the authored set. No creation
 * means the set is empty for want of input rather than for want of a match, and
 * an empty set for that reason is not evidence of a second writer.
 *
 * Note this is satisfied by a single new commit of your own, which is why the
 * fresh-clone rollback that adds one behaves correctly rather than falling to
 * the degraded path: that commit carries your id, so your id is in the set.
 *
 * Scoped to this worktree's HEAD for the same reason as `readReflogSessions`:
 * a sibling worktree's authorship is not evidence that THIS session authored
 * anything, and treating it as such would license the strong two-writer claim
 * on somebody else's record.
 */
export function authoredHere() {
  try {
    return creationEntries('HEAD').length > 0;
  } catch {
    // No reflog at all; absence is handled by the caller, not read as a finding.
  }
  return false;
}

export function readReflogSessions() {
  const sessions = new Set();
  try {
    for (const entry of creationEntries('HEAD')) {
      for (const session of entry.sessions) sessions.add(session);
    }
  } catch {
    // An absent reflog is not evidence of anything. The empty set only makes
    // the guard stricter, and `authoredHere` is what stops that strictness
    // from being reported as a finding about somebody else.
  }
  return sessions;
}

/**
 * Reflog entries with the reflog's own subject (`%gs`) alongside the commit's
 * session trailers. The reflog subject is what distinguishes authorship from
 * arrival, and it is not available from `readCommits`.
 */
/**
 * Reflog subjects for operations that CREATE a commit object in this worktree,
 * as distinct from operations that merely move a ref onto one.
 *
 * `CREATED_HERE` is deliberately not reused. It answers "did this clone author
 * anything", where a single entry settles it; this answers "which objects exist
 * because of work done here", where every producing operation has to be
 * enumerated or its output is misread as someone else's.
 *
 * Measured, not assumed — a rebase of two commits writes:
 *
 *     ddd98128  rebase (finish): returning to refs/heads/feature
 *     ddd98128  rebase (pick): mine two
 *     891bb383  rebase (pick): mine one
 *     8e6b85a5  rebase (start): checkout master
 *
 * The picks carry the NEW shas, which is the whole reason this matters: after a
 * rebase the remote holds objects that no `commit:` entry ever named, so a
 * predicate built only from `commit:` would call a solo session's own rebased
 * work unowned. `tests/pushGuard.test.ts` predicted that failure in a comment
 * before this function existed, and produced it on the first run.
 *
 * `rebase (start)` and `rebase (finish)` are excluded on purpose. `start` is a
 * checkout — an arrival, and the one entry here that names a commit this
 * worktree did not write. `finish` repeats the last pick's sha and so adds
 * nothing except a second way to be wrong later.
 *
 * `merge` is excluded although it can create a commit, because it can also
 * fast-forward, and the reflog subject does not distinguish the two. Including
 * it would let an arrival be claimed as authorship; excluding it can only
 * withhold ownership from a real merge commit, which refuses rather than allows.
 */
const PRODUCED_HERE =
  /^(?:commit(?: \((?:initial|amend)\))?|rebase(?: -[ir])* \((?:pick|reword|squash|fixup|edit|continue)\)|cherry-pick|revert|am|applying):/;

/**
 * The exact commit objects this worktree created, by sha.
 *
 * `readReflogSessions` answers ownership at the granularity of a session id, and
 * that granularity is wrong for the question. Measured on `development` at
 * `ce4a7515`: one `Copilot-Session` value carries 74 commits spanning 2026-07-21
 * 21:06 to 2026-07-23 10:54 — 37 hours, which no single session runs for. The
 * trailer reaches a committer through its PROMPT, not its environment, so its
 * uniqueness is a property of how many distinct briefs were written rather than
 * of how many sessions ran. Two sessions given the same brief emit the same id
 * and nothing anywhere reports that they have.
 *
 * The consequence is specific and it is the fatal direction. With distinct ids
 * the strong refusal cannot be cleared by the ordinary remedy at all — the
 * operator must name the id in `PF_PUSH_ACK_FOREIGN`, which is underivable
 * without having read the other writer's work. Sharing the id deletes exactly
 * that property, and the refusal degrades to one a reflex clears. Measured
 * against `evaluateRefUpdate` with the other writer's trailer as the only
 * variable:
 *
 *     distinct trailer, no ack    REFUSE  foreign-session
 *     distinct trailer, ACK=live  REFUSE  foreign-session
 *     SHARED trailer,  no ack     REFUSE  unacknowledged-discard
 *     SHARED trailer,  ACK=live   ALLOW   acknowledged-discard
 *
 * So ownership is read per COMMIT rather than per id. A creation entry names the
 * object it created, and that object is either the one being destroyed or it is
 * not — a question no shared literal can launder, because it is answered by the
 * sha rather than by anything the commit says about itself.
 *
 * This does NOT replace `ownSessions`, and the difference is the reason both are
 * kept. A sha set cannot survive an operation that rewrites objects on a machine
 * other than this one; the id can, because the rewritten copies carry the
 * original's trailer. So the id remains the instrument for the strong
 * `foreign-session` claim and this set only ever adds refusals underneath it —
 * see the `unowned-discard` arm, which is reachable solely for commits an id
 * check has already let through.
 *
 * The env var is not an alternative source and was measured before being
 * rejected: `COPILOT_AGENT_SESSION_ID` is `e5a64133-…` in this process while the
 * commits it writes carry `b459f162-…`. Comparing against it would match no
 * trailer at all and classify 100% of the pusher's own work as foreign — the
 * failure mode that trains the override, which is worse than the leak it fixes.
 *
 * Same sources and same limits as `readReflogSessions`: this worktree's HEAD
 * only, so a sibling worktree's authorship is never claimed as this session's;
 * expiry and disabled reflogs shrink the set, and a smaller set here can only
 * refuse more, never less. `authoredHere` is what stops that absence from being
 * reported as a finding about somebody else.
 */
export function readOwnedCommits() {
  const owned = new Set();
  try {
    for (const entry of readReflogEntries('HEAD')) {
      if (entry.sha && PRODUCED_HERE.test(entry.reflogSubject)) {
        owned.add(entry.sha);
      }
    }
  } catch {
    // Absent reflog. The empty set is the strict answer; see `authoredHere`.
  }
  return owned;
}

export function readReflogEntries(ref) {
  const output = git([
    'log',
    '-g',
    '--max-count=1000',
    `--format=%H${FIELD}%gs${FIELD}%(trailers:key=Copilot-Session,valueonly,separator=%x2c)${RECORD}`,
    ref,
  ]);
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, reflogSubject, trailers] = record.split(FIELD);
      return {
        sha: sha ?? '',
        reflogSubject: reflogSubject ?? '',
        sessions: (trailers ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      };
    });
}

/**
 * Commits on the remote whose CONTENT already exists locally under a different
 * sha — the ones a rewrite carried forward rather than destroyed.
 *
 * `rev-list live ^local` answers "which commits does this push remove from the
 * ref", which is not the same as "which work does this push destroy". Rebase
 * another session's commits under your own — exactly what this guard's refusal
 * tells you to do — and their originals stop being reachable from the local tip
 * while every line of them survives under new shas. Measured at 822c5ed: that
 * push was REFUSED as `foreign-session`, naming the session whose work it had
 * just preserved. A false refusal on the did-the-right-thing path is the worst
 * place in the system to put one, and it is the path the guard advertises.
 *
 * `git cherry` compares patch-ids, so it answers the content question directly.
 *
 * Two properties make this safe to subtract from the destroyed set:
 *
 * 1. It can only ever SHRINK that set, so it is evidence of innocence and never
 *    of guilt. A failure returns the empty set, which is the strict answer, so
 *    every way this can go wrong goes wrong toward refusing.
 *
 * 2. `git cherry` ignores merge commits — measured, not assumed: on a three
 *    commit range containing a merge it printed two lines and omitted the merge.
 *    A merge therefore can never enter this set and is always counted destroyed.
 *    That is the behaviour this repository needs, because the incident in
 *    `.squad/decisions.md` is an orphaned merge commit that dropped ~6000 lines
 *    while every other signal stayed green.
 */
export function readEquivalentCommits(localSha, liveSha) {
  try {
    return new Set(
      git(['cherry', localSha, liveSha])
        .split(/\r?\n/)
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).trim())
        .filter((sha) => sha.length > 0),
    );
  } catch {
    return new Set();
  }
}

export function readCommits(range) {
  const output = git([
    'log',
    `--format=%H${FIELD}%s${FIELD}%(trailers:key=Copilot-Session,valueonly,separator=%x2c)${RECORD}`,
    ...range,
  ]);
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, subject, trailers] = record.split(FIELD);
      return {
        sha: sha ?? '',
        subject: subject ?? '',
        sessions: (trailers ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      };
    });
}

export function gatherFacts(update, remote, env = process.env, location = '') {
  // The live query is the one fact that depends on the network, so its failure
  // is recorded as a FACT rather than thrown. Letting it throw put the whole
  // decision behind a catch, so no branch of `evaluateRefUpdate` — including
  // every allow — was reachable once it failed.
  let liveRemoteSha = null;
  let liveQueryFailed = false;
  let liveQueryError = '';
  try {
    liveRemoteSha = readLiveRemoteSha(remote, update.remoteRef, location);
  } catch (error) {
    liveQueryFailed = true;
    liveQueryError = error instanceof Error ? error.message : String(error);
  }

  const facts = {
    liveRemoteSha,
    liveQueryFailed,
    liveQueryError,
    // Only consulted when the live query failed; measured only then, because
    // the advertised value is what it is measured against. `null` means the
    // question could not be answered, which is not the same as `false`.
    provablyFastForward: liveQueryFailed
      ? isAbsent(update.remoteSha)
        ? true
        : isAncestor(update.remoteSha, update.localSha)
      : null,
    // Measured on every path, so no caller can construct a `facts` shape this
    // function does not produce. Vacuously true when the remote has no tip:
    // there is then no object to be missing, and the new-branch allow returns
    // before anything tries to enumerate from it.
    liveTipPresent: isAbsent(liveRemoteSha) ? true : hasCommit(liveRemoteSha),
    discarded: [],
    // Commits the remote has that this push removes from the ref but does NOT
    // destroy, because an equivalent patch is already reachable locally. Empty
    // is the strict answer, so the default and every failure path are safe.
    preserved: [],
    ownSessions: [],
    // The commit objects this worktree created. Empty is the strict default:
    // nothing claimed as ours, so nothing exempt from the ownership arm.
    ownCommits: [],
    // Conservative default, and the conservative direction here is `false`: with
    // no evidence the guard declines to CLAIM foreignness rather than declining
    // to allow. It still refuses; it just refuses for the reason it can support.
    ownershipEvidence: false,
    ack: env[ACK_ENV],
    ackForeign: env[ACK_FOREIGN_ENV],
  };
  // Only meaningful once the live tip agrees with the lease; when it does not,
  // the refusal happens before these are read.
  if (liveRemoteSha && liveRemoteSha === update.remoteSha) {
    if (!facts.liveTipPresent) return facts;
    if (!isAbsent(update.localSha)) {
      const equivalent = readEquivalentCommits(update.localSha, liveRemoteSha);
      const removed = readCommits([liveRemoteSha, `^${update.localSha}`]);
      facts.discarded = removed.filter((entry) => !equivalent.has(entry.sha));
      facts.preserved = removed
        .filter((entry) => equivalent.has(entry.sha))
        .map((entry) => entry.sha);
      // Two sources, because reachability alone is a PROXY for ownership and
      // the proxy breaks on the case that matters most.
      //
      // It was `local ^live`, which is empty whenever the local tip is an
      // ancestor of the live tip — an ordinary solo rollback — so every
      // discarded commit was classified foreign INCLUDING THE PUSHER'S OWN.
      // Widening it to everything reachable from the local tip fixes a partial
      // rollback but NOT a full one: roll back all of your work and every
      // commit carrying your session id is exactly what you are removing, so it
      // is reachable from nothing and you are named as a second writer again —
      // on the most likely destructive push a lone session ever makes.
      //
      // Widening it also broke the check in the other direction, which is what
      // finally removed it — see below. Reachability is gone; the reflog is the
      // only source. A clone that recorded no authorship is covered by
      // `ownershipEvidence` rather than by a second guess.
      //
      // Cost was measured, not feared: each reflog read is ~30 ms, against the
      // 515 ms `ls-remote` the guard already pays unconditionally on every push.
      // Dropping the reachability walk removed a 32-56 ms full-history walk over
      // this repo's 176 commits, so the correct answer is also the cheaper one
      // and there was no trade to make. If the reflog read is ever suspected,
      // measure again rather than assuming this estimate held.
      //
      // A `--grep` prefilter was rejected twice over, and is recorded because
      // the fear outlives the reasoning. It matches substrings, so one session
      // id would match any id containing it. And it takes a POSIX regex rather
      // than a literal, so an id containing a metacharacter would fail to match
      // its own commits — a false NEGATIVE, which is the fatal direction for a
      // prefilter, because the exact check downstream only ever inspects what
      // the prefilter admitted. Fail-open by construction. The cheap option and
      // the exact option are the same option here; there was no trade to make.
      // Ownership is read from the reflog ALONE. Reachability used to be
      // unioned in here and it was the wrong signal: "this commit is reachable
      // from my tip" means "I have it", which is true of everything I fetched.
      //
      // Measured at 37f1715, with whether any of their work is carried forward
      // as the only variable:
      //
      //   rewind over all of their work  -> foreign-session, names them
      //   keep ONE of their commits      -> unacknowledged-discard, silent
      //
      // Keeping one of their commits put THEIR id into the reachable set and
      // silenced the foreign claim for every other commit of theirs the push
      // destroyed — including one titled "never read by me". That is reached by
      // following the guard's own printed advice, which says to rebase onto
      // their work rather than over it; rebasing onto PART of it is the ordinary
      // outcome when some is kept and some is obsolete. A control whose
      // documented remedy disables it is not a control.
      //
      // The same proxy failed in the opposite direction on a total rollback,
      // where nothing of mine survives to be reachable. One quantity, two
      // opposite failures, so no threshold fixes it — it is not a tuning
      // problem, it is the wrong question. Reachability answers "do I still
      // hold some commit of session X"; the question is "did session X's work
      // originate here".
      //
      // A `commit` reflog entry answers that directly, and it survives a rebase
      // of your own work because the rewritten copies carry the same session id
      // as the originals, whose entries are still there.
      //
      // The guard cannot simply compare against its own id, which would be
      // simpler still. Measured: COPILOT_AGENT_SESSION_ID is
      // e5a64133-826a-4d6e-8849-31b58386792f while the commits this very
      // session writes carry b459f162-b5f3-4fd4-bb46-408e4357d6ca. The trailer
      // value reaches the committer through its prompt, not its environment, so
      // there is no id here to compare with — and using the env var would call
      // every one of the pusher's own commits foreign.
      facts.ownSessions = [...readReflogSessions()];
      // The id set answers "written under a brief like mine"; this answers
      // "created here". #264 is the gap between those two sentences.
      facts.ownCommits = [...readOwnedCommits()];
      // Measured alongside the sessions, because the set alone cannot say
      // whether an absent id was never recorded or never existed.
      facts.ownershipEvidence = authoredHere();
    } else {
      facts.discarded = readCommits([liveRemoteSha, '--max-count=20']);
    }
  }
  return facts;
}

export function parseStdin(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return {
        localRef: localRef ?? '',
        localSha: localSha ?? '',
        remoteRef: remoteRef ?? '',
        remoteSha: remoteSha ?? '',
      };
    });
}

function readAllStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv, stdinText) {
  const remote = argv[0] ?? 'origin';
  // git's second argument is the URL THIS invocation is pushing to. With a
  // multi-valued `remote.<name>.pushurl` the hook runs once per URL and this is
  // the only thing that distinguishes them; re-resolving the remote name would
  // evaluate every invocation against the first mirror.
  const location = argv[1] ?? '';
  const updates = parseStdin(stdinText);
  if (updates.length === 0) return 0;

  let refused = 0;
  for (const update of updates) {
    let result;
    try {
      result = evaluateRefUpdate(
        update,
        gatherFacts(update, remote, process.env, location),
      );
    } catch (error) {
      // A guard that cannot check must not report success. This is the residual
      // path only — the two failures that are actually reachable have their own
      // codes (`stale-lease`, `unfetched-remote-tip`). Anything landing here is
      // a state the guard could not characterise at all, and by the same
      // argument recorded above, a push whose destroyed set cannot be
      // enumerated is not knowably safe. Do not soften this to a warning.
      console.error(
        `[push-guard] REFUSED ${update.remoteRef}: the guard could not verify the remote (${error.message}).`,
      );
      refused += 1;
      continue;
    }
    if (result.verdict === 'refuse') {
      console.error(`[push-guard] REFUSED (${result.code})\n${result.message}`);
      refused += 1;
    } else {
      console.error(`[push-guard] ok (${result.code}): ${result.message}`);
    }
  }
  return refused > 0 ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main(process.argv.slice(2), readAllStdin()));
}
