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
 *   pushedSessions?: Iterable<string>,
 *   ack?: string,
 *   ackForeign?: string,
 * }} facts
 *   `liveRemoteSha` MUST come from `git ls-remote` (a live query), never from a
 *   `refs/remotes/**` read. `discarded` is `rev-list <live> ^<local>` — the
 *   commits this push would remove from the remote.
 * @returns {{verdict: 'allow' | 'refuse', code: string, message: string}}
 */
export function evaluateRefUpdate(update, facts) {
  const { localSha, remoteRef } = update;
  const { liveRemoteSha, discarded = [] } = facts;
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

  if (discarded.length === 0) {
    return {
      verdict: 'allow',
      code: 'push-guard.fast-forward',
      message: `${remoteRef} advances without discarding anything`,
    };
  }

  const pushedSessions = new Set(facts.pushedSessions ?? []);
  const foreign = [...sessionsOf(discarded)].filter(
    (session) => !pushedSessions.has(session),
  );
  if (foreign.length > 0) {
    const acknowledged = foreign.every((session) =>
      ackForeign.includes(session),
    );
    if (!acknowledged) {
      return {
        verdict: 'refuse',
        code: 'push-guard.foreign-session',
        message: [
          `This push destroys ${discarded.length} commit(s) written by another session.`,
          `Session id(s) not present in what you are pushing: ${foreign.join(', ')}`,
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

/** Live remote tip. `ls-remote` queries the remote; `refs/remotes/**` does not. */
export function readLiveRemoteSha(remote, ref) {
  const output = git(['ls-remote', remote, ref]).trim();
  if (!output) return null;
  const first = output.split('\n')[0] ?? '';
  const sha = first.split('\t')[0]?.trim();
  return sha && sha.length > 0 ? sha : null;
}

const RECORD = '\u001e';
const FIELD = '\u001f';

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

export function gatherFacts(update, remote, env = process.env) {
  const liveRemoteSha = readLiveRemoteSha(remote, update.remoteRef);
  const facts = {
    liveRemoteSha,
    discarded: [],
    pushedSessions: [],
    ack: env[ACK_ENV],
    ackForeign: env[ACK_FOREIGN_ENV],
  };
  // Only meaningful once the live tip agrees with the lease; when it does not,
  // the refusal happens before these are read.
  if (liveRemoteSha && liveRemoteSha === update.remoteSha) {
    if (!isAbsent(update.localSha)) {
      facts.discarded = readCommits([liveRemoteSha, `^${update.localSha}`]);
      facts.pushedSessions = [
        ...sessionsOf(readCommits([update.localSha, `^${liveRemoteSha}`])),
      ];
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
  const updates = parseStdin(stdinText);
  if (updates.length === 0) return 0;

  let refused = 0;
  for (const update of updates) {
    let result;
    try {
      result = evaluateRefUpdate(update, gatherFacts(update, remote));
    } catch (error) {
      // A guard that cannot check must not report success.
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
