// @vitest-environment node

// The pre-push guard (issue #81).
//
// The control under test is not "a rule about which flag to type" — it is a
// hook that reads the remote itself at the moment of the push. So the suite has
// to prove two separate things:
//
//   1. Each branch of the decision fires for its own reason, with a diagnostic
//      unique to that branch. `push-guard.unacknowledged-discard` (you named
//      nothing) and `push-guard.ack-mismatch` (you named a SHA that is not the
//      remote tip) are the two halves of the fabricated-SHA incident and must
//      not be reachable from one another's inputs.
//   2. The guard is actually WIRED — a decision function nothing invokes is not
//      a control. The integration block drives a real git push through the real
//      hook against a real remote, and pins the counterfactual: the same push
//      with the guard removed SUCCEEDS and destroys the commits. Without that
//      half the suite could pass against a hook that refuses everything, or one
//      git never runs.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ACK_ENV,
  ACK_FOREIGN_ENV,
  PROTECTED_REFS,
  ZERO_SHA,
  authoredHere,
  evaluateRefUpdate,
  isAncestor,
  parseStdin,
  readAssociatedPullRequest,
} from '../scripts/push-guard.mjs';
import { originLabel } from '../scripts/safe-force-push.mjs';
import { HOOKS_PATH } from '../scripts/install-git-hooks.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

const OURS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const THEIRS = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LOCAL = 'cccccccccccccccccccccccccccccccccccccccc';

function update(overrides: Partial<Parameters<typeof evaluateRefUpdate>[0]>) {
  return {
    localRef: 'refs/heads/feature',
    localSha: LOCAL,
    remoteRef: 'refs/heads/feature',
    remoteSha: THEIRS,
    ...overrides,
  };
}

// Mirrors what `gatherFacts` always produces. `liveTipPresent` is supplied here
// rather than defaulted inside the guard, so no fixture below constructs a
// `facts` shape production cannot produce — a test passing against an
// impossible state is not evidence about the code.
function facts(
  overrides: Partial<Parameters<typeof evaluateRefUpdate>[1]>,
): Parameters<typeof evaluateRefUpdate>[1] {
  return {
    liveRemoteSha: THEIRS,
    liveTipPresent: true,
    liveQueryFailed: false,
    liveQueryError: '',
    provablyFastForward: null,
    // Defaults to `false` deliberately, matching `gatherFacts`: a fixture that
    // does not state the clone can attribute authorship gets the weaker claim.
    // The stronger one has to be asked for.
    ownershipEvidence: false,
    discarded: [],
    // `null` matches `gatherFacts`' default for "no PR resolved" — see
    // `readAssociatedPullRequest`. A fixture asserting the #184 refusal has to
    // ask for `MERGED` or `CLOSED` explicitly.
    prState: null,
    prNumber: null,
    ...overrides,
  };
}

describe('the guard resolves the remote tip live rather than trusting the lease', () => {
  it('refuses when the live tip differs from the value git computed the lease against', () => {
    // git normally hands the hook the tip the remote advertised, so this fires
    // only when the remote moves during the push — a narrow window, kept
    // because the alternative is deciding from a value already known to be
    // wrong. The #78 clobber is caught by the foreign-session block below.
    const result = evaluateRefUpdate(update({ remoteSha: OURS }), facts({}));

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.stale-lease');
    expect(result.message).toContain(THEIRS);
  });

  it('admits a push whose lease matches the live tip and discards nothing', () => {
    const result = evaluateRefUpdate(update({}), facts({}));

    expect(result.verdict).toBe('allow');
    expect(result.code).toBe('push-guard.fast-forward');
  });

  it('admits a branch that does not exist on the remote yet', () => {
    const result = evaluateRefUpdate(
      update({ remoteSha: ZERO_SHA }),
      facts({ liveRemoteSha: null }),
    );

    expect(result.verdict).toBe('allow');
    expect(result.code).toBe('push-guard.new-branch');
  });

  it('refuses a "new branch" push when the branch has appeared on the remote since the fetch', () => {
    // Distinct from the case above by one fact only — the live query.
    const result = evaluateRefUpdate(
      update({ remoteSha: ZERO_SHA }),
      facts({}),
    );

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.stale-lease');
  });
});

describe('the guard separates another session\u2019s commits from your own', () => {
  const foreign = facts({
    discarded: [
      {
        sha: THEIRS,
        subject: 'fix(3mf): guard the metadata reader',
        sessions: ['032c3f16'],
      },
    ],
    ownSessions: ['8dd289e7'],
    // The clone can answer the ownership question, so the absence of `032c3f16`
    // from what is being pushed is a finding rather than a blind spot. Stating
    // it here is the point of the field being required: a fixture that omits it
    // gets the weaker claim, not the stronger one.
    ownershipEvidence: true,
  });

  it('refuses a force-push over commits carrying a session id absent from what is being pushed', () => {
    const result = evaluateRefUpdate(update({}), foreign);

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.foreign-session');
    expect(result.message).toContain('032c3f16');
    // The refusal must show what would have been lost; the #78 clobber was
    // caught only because someone read a SHA in the push output.
    expect(result.message).toContain('guard the metadata reader');
  });

  it('does not treat a rewrite of your own commits as a second writer', () => {
    // Amending or rebasing your own work discards commits whose trailer matches
    // the one you are pushing. That is the ordinary case and must not be
    // shadowed by the foreign-session refusal, or the guard becomes noise.
    const result = evaluateRefUpdate(
      update({}),
      facts({
        discarded: [{ sha: THEIRS, subject: 'wip', sessions: ['8dd289e7'] }],
        ownSessions: ['8dd289e7'],
        ownCommits: [THEIRS],
        ack: THEIRS,
      }),
    );

    expect(result.verdict).toBe('allow');
    expect(result.code).toBe('push-guard.acknowledged-discard');
  });

  it('refuses a commit whose id is yours but whose object this worktree never created', () => {
    // #264, isolated to one fact. Identical to the case above except that the
    // discarded sha is absent from `ownCommits` — which is what a second writer
    // sharing your brief produces, and what the id check cannot see.
    const result = evaluateRefUpdate(
      update({}),
      facts({
        discarded: [{ sha: THEIRS, subject: 'wip', sessions: ['8dd289e7'] }],
        ownSessions: ['8dd289e7'],
        ownCommits: [],
        ownershipEvidence: true,
        ack: THEIRS,
      }),
    );

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.unowned-discard');
    // It must ask for the sha, not the id: the id is one the pusher already
    // holds, so requiring it would be a remedy satisfiable without reading.
    expect(result.message).toContain(THEIRS);
  });

  it('does not fire when the worktree cannot attribute authorship at all', () => {
    // A fresh clone has an empty `ownCommits` for work it did not do and for
    // work it did — the same observation. Claiming the strong reading of it
    // would refuse every push from a clone that has authored nothing, which is
    // the false-refusal shape whose remedy is disabling the guard.
    const result = evaluateRefUpdate(
      update({}),
      facts({
        discarded: [{ sha: THEIRS, subject: 'wip', sessions: ['8dd289e7'] }],
        ownSessions: ['8dd289e7'],
        ownCommits: [],
        ownershipEvidence: false,
        ack: THEIRS,
      }),
    );

    expect(result.code).not.toBe('push-guard.unowned-discard');
  });

  it('does not refuse twice for one commit when the foreign id has already been named', () => {
    // The strong arm printed `032c3f16` and the operator supplied it. Asking
    // for the sha as well would turn one refusal into two and teach that the
    // way through is to keep adding tokens until it stops complaining.
    const result = evaluateRefUpdate(update({}), {
      ...foreign,
      ack: THEIRS,
      ackForeign: '032c3f16',
    });

    expect(result.verdict).toBe('allow');
    expect(result.code).toBe('push-guard.acknowledged-discard');
  });

  it('requires the override to name the foreign session id, and still requires the tip acknowledgement', () => {
    const named = evaluateRefUpdate(update({}), {
      ...foreign,
      ackForeign: '032c3f16',
    });
    expect(named.code).toBe('push-guard.unacknowledged-discard');

    const wrongName = evaluateRefUpdate(update({}), {
      ...foreign,
      ackForeign: 'deadbeef',
      ack: THEIRS,
    });
    expect(wrongName.verdict).toBe('refuse');
    expect(wrongName.code).toBe('push-guard.foreign-session');

    const both = evaluateRefUpdate(update({}), {
      ...foreign,
      ackForeign: '032c3f16',
      ack: THEIRS,
    });
    expect(both.verdict).toBe('allow');
    expect(both.code).toBe('push-guard.acknowledged-discard');
  });

  it('will not accept a prefix of the foreign session id as the override', () => {
    // Substring matching would let an acknowledgement of `032c` satisfy a
    // refusal naming `032c3f16` — a value you can guess from the first line of
    // the diagnostic is not evidence of having read the work.
    const prefix = evaluateRefUpdate(update({}), {
      ...foreign,
      ackForeign: '032c',
      ack: THEIRS,
    });
    expect(prefix.verdict).toBe('refuse');
    expect(prefix.code).toBe('push-guard.foreign-session');
  });
});

describe('the guard checks the pusher\u2019s belief, not only git\u2019s cache of it', () => {
  const discarding = facts({
    discarded: [{ sha: THEIRS, subject: 'work nobody read', sessions: [] }],
    ownSessions: [],
  });

  it('refuses a destructive push that acknowledges nothing', () => {
    const result = evaluateRefUpdate(update({}), discarding);

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.unacknowledged-discard');
  });

  it('refuses an acknowledgement whose SHA shares a prefix with the tip but was never read', () => {
    // The `squad-name-audit` incident: a full-length hash invented from a
    // seven-character prefix. Bare `--force-with-lease` accepts this, because
    // the value it compares comes from git rather than from the author.
    const fabricated = `${THEIRS.slice(0, 7)}${'9'.repeat(33)}`;
    expect(fabricated).not.toBe(THEIRS);

    const result = evaluateRefUpdate(update({}), {
      ...discarding,
      ack: fabricated,
    });

    expect(result.verdict).toBe('refuse');
    // Distinct from the no-acknowledgement code above: the two refusals mean
    // different things and a test asserting either must not pass on the other.
    expect(result.code).toBe('push-guard.ack-mismatch');
  });

  it('admits the destructive push when the acknowledgement equals the live tip', () => {
    const result = evaluateRefUpdate(update({}), {
      ...discarding,
      ack: THEIRS,
    });

    expect(result.verdict).toBe('allow');
    expect(result.code).toBe('push-guard.acknowledged-discard');
  });
});

describe('a failed live query decides from the advertised tip instead of refusing everything', () => {
  // B1. `ls-remote` failing used to put the whole decision behind a catch, so
  // no allow was reachable — including a plain fast-forward that git was always
  // going to accept. Only exit 0 from `merge-base --is-ancestor` is evidence.
  const failed = { liveQueryFailed: true, liveQueryError: 'boom' };

  it('allows a push proven to discard nothing, and says the check was degraded', () => {
    const result = evaluateRefUpdate(
      update({}),
      facts({ ...failed, provablyFastForward: true }),
    );

    expect(result.verdict).toBe('allow');
    expect(result.code).toBe('push-guard.unverified-fast-forward');
    // Allowing quietly would hide that the guard ran degraded.
    expect(result.message).toContain('WARNING');
  });

  it('refuses when the advertised tip proves the push destroys commits', () => {
    const result = evaluateRefUpdate(
      update({}),
      facts({ ...failed, provablyFastForward: false }),
    );

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.unverifiable-remote');
    expect(result.message).toContain('not a fast-forward');
  });

  it('refuses when the question is unanswerable, and does not describe it as destructive', () => {
    // `null` is the third state: exit 128, the advertised object is absent.
    // Collapsing it into the `false` branch would be safe but would print a
    // claim we cannot support — the code that fires must be the code that
    // describes what happened.
    const result = evaluateRefUpdate(
      update({}),
      facts({ ...failed, provablyFastForward: null }),
    );

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.unverifiable-remote');
    expect(result.message).toContain('cannot be determined');
    expect(result.message).not.toContain('not a fast-forward');
  });

  it('still refuses a protected ref before considering any of this', () => {
    // Ordering: the degraded path must not become a way around the checks that
    // do not depend on the remote at all.
    const result = evaluateRefUpdate(
      update({ remoteRef: PROTECTED_REFS[0] as string }),
      facts({ ...failed, provablyFastForward: true }),
    );

    expect(result.code).toBe('push-guard.protected-ref');
  });
});

describe('the guard says so when it cannot see what the push would destroy', () => {
  it('refuses with its own code when the remote tip is not in the local object store', () => {
    // Reachable by bare `--force` when another session pushed commits we never
    // fetched. Before this had its own code the generic catch leaked
    // `fatal: bad object`, which is the worst diagnostic in the system on the
    // most dangerous path the guard has.
    const result = evaluateRefUpdate(
      update({}),
      facts({ liveTipPresent: false }),
    );

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.unfetched-remote-tip');
    expect(result.message).toContain('git fetch');
  });

  it('does not let an unreadable tip fall through to the fast-forward allow', () => {
    // `discarded: []` here means "could not be computed", not "nothing is
    // discarded". If the check were ordered after the fast-forward case, this
    // exact input would be ALLOWED — the emptiness is indistinguishable at
    // that point. Pins the ordering, not just the code.
    const unreadable = evaluateRefUpdate(
      update({}),
      facts({ liveTipPresent: false }),
    );
    const genuinelyEmpty = evaluateRefUpdate(
      update({}),
      facts({ liveTipPresent: true }),
    );

    expect(unreadable.verdict).toBe('refuse');
    expect(genuinelyEmpty.code).toBe('push-guard.fast-forward');
  });

  it('refuses rather than allows when the measurement is missing altogether', () => {
    // The field is required, so this cannot happen through the type — hence the
    // cast. It is asserted anyway because the failure it guards against is a
    // future call site that builds facts by hand and omits the probe. A
    // permissive default would make that omission silently skip the refusal:
    // fail-open by forgetfulness, inside a control whose whole point is fail-
    // closed. The refusal must be what you get for not measuring.
    const unmeasured = { liveRemoteSha: THEIRS, discarded: [] };
    const result = evaluateRefUpdate(
      update({}),
      unmeasured as unknown as Parameters<typeof evaluateRefUpdate>[1],
    );

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.unfetched-remote-tip');
  });
});

describe('the guard refuses direct writes to the branches that take pull requests only', () => {
  it.each(PROTECTED_REFS)('refuses a push to %s', (ref) => {
    const result = evaluateRefUpdate(update({ remoteRef: ref }), facts({}));

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.protected-ref');
  });

  it('refuses a branch deletion that names no tip, and admits one that names the live tip', () => {
    const everything = [{ sha: THEIRS, subject: 'everything', sessions: [] }];
    const anonymous = evaluateRefUpdate(
      update({ localSha: ZERO_SHA }),
      facts({ discarded: everything }),
    );
    expect(anonymous.code).toBe('push-guard.branch-delete');
    // The refusal that discards the most must not be the one that says the
    // least: a delete drops everything, so it names what it would drop.
    expect(anonymous.message).toContain('everything');

    const acknowledged = evaluateRefUpdate(
      update({ localSha: ZERO_SHA }),
      facts({ discarded: everything, ack: THEIRS }),
    );
    expect(acknowledged.verdict).toBe('allow');
    expect(acknowledged.code).toBe('push-guard.acknowledged-delete');
  });
});

describe('the guard refuses a push whose PR is already resolved (#184)', () => {
  // PR #171 merged, then a later push to the branch behind it landed on a live
  // ref with no PR attached, no CI run, and no reviewer. Every other check in
  // this file is unmoved by an ordinary fast-forward, which is exactly the
  // shape that push had — nothing was destroyed, so the guard has to ask a
  // question none of its other facts answer.
  it('refuses when the resolved PR is MERGED, naming the PR number', () => {
    const result = evaluateRefUpdate(
      update({}),
      facts({ prState: 'MERGED', prNumber: 171 }),
    );

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.pr-already-resolved');
    expect(result.message).toContain('#171');
    expect(result.message).toContain('MERGED');
    expect(result.message.toLowerCase()).toContain('development');
  });

  it('refuses when the resolved PR is CLOSED, naming the PR number', () => {
    const result = evaluateRefUpdate(
      update({}),
      facts({ prState: 'CLOSED', prNumber: 42 }),
    );

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.pr-already-resolved');
    expect(result.message).toContain('#42');
    expect(result.message).toContain('CLOSED');
  });

  it('allows a push whose PR is still OPEN', () => {
    const result = evaluateRefUpdate(
      update({}),
      facts({ prState: 'OPEN', prNumber: 171 }),
    );

    expect(result.verdict).toBe('allow');
    expect(result.code).toBe('push-guard.fast-forward');
  });

  it('allows a push when no PR could be resolved at all — absent and unknown are the same fact', () => {
    // `prState: null` covers BOTH "no PR exists for this branch" and "the `gh`
    // query could not be answered" (no binary, no credential, no network).
    // Neither is evidence of a merged/closed PR, so neither refuses.
    const result = evaluateRefUpdate(
      update({}),
      facts({ prState: null, prNumber: null }),
    );

    expect(result.verdict).toBe('allow');
  });

  it('does not refuse a branch deletion even when its PR is MERGED — deleting is the hardening this issue asks for, not the hazard', () => {
    const result = evaluateRefUpdate(
      update({ localSha: ZERO_SHA }),
      facts({ prState: 'MERGED', prNumber: 171, ack: THEIRS }),
    );

    expect(result.verdict).toBe('allow');
    expect(result.code).toBe('push-guard.acknowledged-delete');
  });

  it('refuses via the merged-PR check even for a push that would otherwise fast-forward cleanly', () => {
    // The defining property of the #184 incident: the push was NOT destructive.
    // A check keyed only on `discarded.length` would never see it.
    const result = evaluateRefUpdate(
      update({}),
      facts({ prState: 'MERGED', prNumber: 171, discarded: [] }),
    );

    expect(result.verdict).toBe('refuse');
    expect(result.code).toBe('push-guard.pr-already-resolved');
  });
});

describe('readAssociatedPullRequest', () => {
  it('resolves state and number from gh pr list', () => {
    const result = readAssociatedPullRequest(
      'feature',
      {},
      (command: string, args: string[]) => {
        if (args[0] === 'auth')
          return { status: 0, stdout: 'token\n', stderr: '' };
        if (args[0] === 'repo') {
          return { status: 0, stdout: 'o/r\n', stderr: '' };
        }
        if (args[0] === 'pr') {
          return {
            status: 0,
            stdout: JSON.stringify([{ number: 171, state: 'MERGED' }]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'unexpected' };
      },
    );

    expect(result).toEqual({ state: 'MERGED', number: 171 });
  });

  it('returns null/null when there is no PR for this branch', () => {
    const result = readAssociatedPullRequest(
      'feature',
      {},
      (command: string, args: string[]) => {
        if (args[0] === 'auth')
          return { status: 0, stdout: 'token\n', stderr: '' };
        if (args[0] === 'repo')
          return { status: 0, stdout: 'o/r\n', stderr: '' };
        if (args[0] === 'pr') return { status: 0, stdout: '[]', stderr: '' };
        return { status: 1, stdout: '', stderr: 'unexpected' };
      },
    );

    expect(result).toEqual({ state: null, number: null });
  });

  it('returns null/null rather than throwing when no credential can be found', () => {
    const result = readAssociatedPullRequest(
      'feature',
      { SKIP_CREDENTIAL_DISCOVERY: '1' },
      () => {
        throw new Error('should not be called once no credential is found');
      },
    );

    expect(result).toEqual({ state: null, number: null });
  });

  it('returns null/null rather than throwing when gh fails to run at all', () => {
    const result = readAssociatedPullRequest(
      'feature',
      {},
      (command: string, args: string[]) => {
        if (args[0] === 'auth')
          return { status: 0, stdout: 'token\n', stderr: '' };
        if (args[0] === 'repo')
          return { status: 0, stdout: 'o/r\n', stderr: '' };
        return { error: new Error('ENOENT') };
      },
    );

    expect(result).toEqual({ state: null, number: null });
  });

  it('returns null/null on a response it cannot parse, rather than throwing', () => {
    const result = readAssociatedPullRequest(
      'feature',
      {},
      (command: string, args: string[]) => {
        if (args[0] === 'auth')
          return { status: 0, stdout: 'token\n', stderr: '' };
        if (args[0] === 'repo')
          return { status: 0, stdout: 'o/r\n', stderr: '' };
        if (args[0] === 'pr')
          return { status: 0, stdout: 'not json', stderr: '' };
        return { status: 1, stdout: '', stderr: 'unexpected' };
      },
    );

    expect(result).toEqual({ state: null, number: null });
  });

  it('returns null/null for an empty branch name without spawning anything', () => {
    const result = readAssociatedPullRequest('', {}, () => {
      throw new Error('should not be called for an empty branch');
    });

    expect(result).toEqual({ state: null, number: null });
  });
});

describe('the guard reads the ref updates git actually writes', () => {
  it('parses one line per ref and tolerates the trailing newline', () => {
    const parsed = parseStdin(
      `refs/heads/feature ${LOCAL} refs/heads/feature ${THEIRS}\n` +
        `refs/heads/other ${OURS} refs/heads/other ${ZERO_SHA}\n`,
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      localRef: 'refs/heads/feature',
      localSha: LOCAL,
      remoteRef: 'refs/heads/feature',
      remoteSha: THEIRS,
    });
    expect(parsed[1]?.remoteSha).toBe(ZERO_SHA);
  });
});

describe('the guard is installed rather than merely available', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };

  it('ships a pre-push hook that invokes the guard', () => {
    const hook = readFileSync(
      path.join(repoRoot, HOOKS_PATH, 'pre-push'),
      'utf8',
    );

    expect(hook).toContain('scripts/push-guard.mjs');
    expect(hook).toMatch(/^#!\/bin\/sh/);
  });

  it('points git at the hook from a lifecycle script, not from a documented instruction', () => {
    expect(manifest.scripts?.prepare).toBe(
      'node scripts/install-git-hooks.mjs',
    );
    expect(manifest.scripts?.['push:force']).toBe(
      'node scripts/safe-force-push.mjs',
    );
  });
});

// --- integration -----------------------------------------------------------
//
// Everything above is a decision over supplied facts. This block proves the
// decision is reached by git, over a real remote, and that it changes the
// outcome — the same push without the hook destroys the commits.

const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function commit(cwd: string, message: string, session: string) {
  writeFileSync(path.join(cwd, `${session}-${Date.now()}.txt`), message);
  git(['add', '-A'], cwd);
  git(['commit', '-m', `${message}\n\nCopilot-Session: ${session}`], cwd);
}

/**
 * A push that is expected to SUCCEED, returning the hook's stderr. `git()`
 * discards stderr on success, which is exactly where the guard writes its
 * verdict — so asserting the allow fired needs its own reader. Fails loudly if
 * the push did not succeed, since a silent non-zero would make the assertion
 * below vacuous.
 */
function pushExpectingSuccess(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `expected the push to succeed, got ${result.status}:\n${result.stderr}`,
    );
  }
  return result.stderr;
}

function configure(cwd: string) {
  git(['config', 'user.email', 'guard@test.local'], cwd);
  git(['config', 'user.name', 'Guard Test'], cwd);
  git(['config', 'commit.gpgsign', 'false'], cwd);
}

describe('the passing side goes through the real hook', () => {
  // B3. Every integration test before this one was a force-push. Nothing drove
  // an ordinary push through `gatherFacts`, and B1 and B2 both lived there.
  let root: string;
  let remote: string;
  let work: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-pass-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, work], root);
    configure(work);
    git(['checkout', '-b', 'feature'], work);
    commit(work, 'base', 'session-one');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const tipOf = (ref = 'refs/heads/feature') =>
    git(['ls-remote', remote, ref], work).split('\t')[0];

  it('lets an ordinary fast-forward through and lands it', () => {
    commit(work, 'ordinary work', 'session-one');

    const stderr = pushExpectingSuccess(['push', 'origin', 'feature'], work);

    expect(stderr).toContain('push-guard.fast-forward');
    expect(tipOf()).toBe(git(['rev-parse', 'HEAD'], work));
  });

  it('lets a new branch through', () => {
    git(['checkout', '-b', 'second'], work);
    commit(work, 'on a new branch', 'session-one');

    git(['push', '-u', 'origin', 'second'], work);

    expect(tipOf('refs/heads/second')).toBe(git(['rev-parse', 'HEAD'], work));
  });

  it('lets a fast-forward through to every URL of a mirrored remote', () => {
    // `remote.<n>.pushurl` is multi-valued, and mirroring one remote to several
    // is what it is for. `git push` writes to all of them and runs the hook once
    // per URL; `git remote get-url --push` returns only the first.
    //
    // The passing side first, because the failing side is not licence to break
    // this: a working mirror configuration must keep working. Both mirrors are
    // in sync here, so both invocations must allow and both must land.
    const second = path.join(root, 'mirror.git');
    git(['init', '--bare', '--initial-branch=development', second], root);
    git(['config', '--add', 'remote.origin.pushurl', remote], work);
    git(['config', '--add', 'remote.origin.pushurl', second], work);
    git(['push', '--no-verify', 'origin', 'feature'], work);
    commit(work, 'work that must reach both mirrors', 'session-one');

    const stderr = pushExpectingSuccess(['push', 'origin', 'feature'], work);

    expect(stderr).toContain('push-guard.fast-forward');
    const head = git(['rev-parse', 'HEAD'], work);
    expect(tipOf()).toBe(head);
    expect(
      git(['--git-dir', second, 'rev-parse', 'refs/heads/feature'], root),
    ).toBe(head);
  });

  it('evaluates each mirror against its own tip, not against the first one', () => {
    // The failing side. A second writer lands on the SECOND mirror only, so the
    // two tips diverge. Resolving `get-url --push` gives the first mirror for
    // both invocations, which means the push to the second is judged against a
    // tip that is not its own.
    //
    // Measured before the fix, that did refuse — but by accident: the tip on
    // stdin is per-URL, so `stale-lease` caught the mismatch and reported a
    // background fetch that had never happened. A guard that is correct for a
    // reason unrelated to the problem is one refactor away from being silent.
    // git already resolves the URL for each invocation and passes it as the
    // hook's second argument, so the guard does not have to resolve one at all.
    const second = path.join(root, 'mirror.git');
    git(['init', '--bare', '--initial-branch=development', second], root);
    git(['config', '--add', 'remote.origin.pushurl', remote], work);
    git(['config', '--add', 'remote.origin.pushurl', second], work);
    git(['push', '--no-verify', 'origin', 'feature'], work);

    const theirs = path.join(root, 'theirs');
    git(['clone', '-b', 'feature', second, theirs], root);
    configure(theirs);
    commit(theirs, 'a second writer, on the second mirror only', 'session-two');
    git(['push', '--no-verify', 'origin', 'feature'], theirs);
    const endangered = git(['rev-parse', 'HEAD'], theirs);

    commit(work, 'mine, unaware of them', 'session-one');
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    // The property, not the wording: the second mirror still has the commit.
    expect(
      git(['--git-dir', second, 'rev-parse', 'refs/heads/feature'], root),
    ).toBe(endangered);
    // And the reason has to be about the mirror being pushed to. Without this,
    // the test passes either way — measured: resolving the first mirror also
    // refuses here, via `stale-lease`, reporting a background fetch that never
    // happened. Same outcome, different cause, and only one of them is the
    // guard doing its job. An assertion that cannot fail is not a control, so
    // the two refusals are pinned apart.
    expect(stderr).toContain('push-guard.unfetched-remote-tip');
    expect(stderr).not.toContain('push-guard.stale-lease');
  });

  it('lets a fast-forward through from a clone whose push URL differs from its fetch URL', () => {
    // The B1 lockout, end to end: `git push` resolves `remote.<n>.pushurl`,
    // the guard's `ls-remote` used to resolve `remote.<n>.url`. A clone that
    // fetches over HTTPS and pushes over SSH has these pointing at different
    // places by design, and the guard refused every push from such a clone —
    // permanently, including the push that would carry the fix.
    //
    // Note what is asserted: the ordinary `fast-forward` code, not a degraded
    // one. Resolving the push URL means there is nothing degraded about it.
    git(['remote', 'set-url', 'origin', path.join(root, 'nowhere.git')], work);
    git(['config', 'remote.origin.pushurl', remote], work);
    commit(work, 'ordinary work behind a divergent pushurl', 'session-one');

    const stderr = pushExpectingSuccess(['push', 'origin', 'feature'], work);

    expect(stderr).toContain('push-guard.fast-forward');
    expect(tipOf()).toBe(git(['rev-parse', 'HEAD'], work));
  });

  it('lets a fast-forward through from a clone that rewrites the push URL with pushInsteadOf', () => {
    // The other half of B1, and the reason it is a separate case rather than
    // the same one. `pushurl` is a per-remote override; `pushInsteadOf` is a
    // global URL rewrite. They are different mechanisms, and the previous test
    // varies only the first — naming the class from one sampled config is the
    // error this PR has now made three times.
    //
    // It also pins the trap. `git ls-remote --get-url <remote>` looks like the
    // obvious way to resolve a push destination and would pass a diff review;
    // git's own usage text gives it away — "take url.<base>.insteadOf into
    // account", never `pushInsteadOf` — and measured, it returns the FETCH url
    // under both configs. Substituting it here silently restores the bug.
    git(['remote', 'set-url', 'origin', path.join(root, 'nowhere.git')], work);
    try {
      // May or may not be set depending on whether the previous case ran; the
      // test must not depend on that.
      git(['config', '--unset', 'remote.origin.pushurl'], work);
    } catch {
      /* not set, which is the state we want */
    }
    git(
      [
        'config',
        `url.${remote.replace(/\\/g, '/')}.pushInsteadOf`,
        path.join(root, 'nowhere.git'),
      ],
      work,
    );
    commit(work, 'ordinary work behind a rewritten push URL', 'session-one');

    const stderr = pushExpectingSuccess(['push', 'origin', 'feature'], work);

    expect(stderr).toContain('push-guard.fast-forward');
    expect(tipOf()).toBe(git(['rev-parse', 'HEAD'], work));
  });

  it('lets a tag through', () => {
    git(['tag', 'v9.9.9'], work);

    git(['push', 'origin', 'v9.9.9'], work);

    expect(tipOf('refs/tags/v9.9.9')).toBe(git(['rev-parse', 'HEAD'], work));
  });
});

describe('the ancestry probe reports three outcomes, not two', () => {
  // `git merge-base --is-ancestor` exits 0, 1, or 128, and the guard collapses
  // 1 and 128 into one refusal. A comment saying that collapse is deliberate is
  // a commitment; this is the control. Both non-zero cases are separately
  // constructible, so a suite that exercises only one cannot tell you which
  // branch it took — and a refactor that merged them would stay green.
  let root: string;
  let cwd: string;
  let head: string;
  let parent: string;

  beforeAll(() => {
    cwd = process.cwd();
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-ancestry-'));
    git(['init', '--initial-branch=feature', root], os.tmpdir());
    configure(root);
    commit(root, 'base', 'session-one');
    commit(root, 'second', 'session-one');
    head = git(['rev-parse', 'HEAD'], root);
    parent = git(['rev-parse', 'HEAD~1'], root);
    // The guard runs git in its own working directory, which is what the hook
    // gives it. Nothing is stubbed.
    process.chdir(root);
  });

  afterAll(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  it('returns true for a real ancestor — exit 0, the only outcome that is evidence', () => {
    expect(isAncestor(parent, head)).toBe(true);
  });

  it('returns false when the answer is genuinely no — exit 1', () => {
    expect(isAncestor(head, parent)).toBe(false);
  });

  it('returns null when the object is absent — exit 128, which is not an answer', () => {
    // Distinct from `false`. "No" and "I cannot tell" are different facts even
    // though they take the same branch, and keeping them distinct at the source
    // is what lets the caller's two diagnostics stay honest.
    expect(isAncestor('b'.repeat(40), head)).toBe(null);
  });
});

describe('the guard decides from the advertised tip when its live query fails', () => {
  // Driving the hook directly rather than through `git push`, and saying so.
  // After the push-URL fix there is no longer a *configuration* that makes the
  // guard's query fail while the push succeeds — that was the whole bug. What
  // remains is transient (a flake between the advertisement and the hook), and
  // the honest way to exercise it is to hand the real hook a remote it cannot
  // read. Everything else here is real: real repo, real git, real guard.
  let root: string;
  let work: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-degraded-'));
    work = path.join(root, 'work');
    git(['init', '--initial-branch=feature', work], root);
    configure(work);
    commit(work, 'base', 'session-one');
    commit(work, 'second', 'session-one');
    git(['remote', 'add', 'origin', path.join(root, 'nowhere.git')], work);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const runHook = (localSha: string, remoteSha: string) =>
    spawnSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'push-guard.mjs'),
        'origin',
        path.join(root, 'nowhere.git'),
      ],
      {
        cwd: work,
        encoding: 'utf8',
        input: `refs/heads/feature ${localSha} refs/heads/feature ${remoteSha}\n`,
      },
    );

  it('allows an update the advertised tip proves destroys nothing', () => {
    const head = git(['rev-parse', 'HEAD'], work);
    const parent = git(['rev-parse', 'HEAD~1'], work);

    const result = runHook(head, parent);

    expect(result.stderr).toContain('push-guard.unverified-fast-forward');
    // Degraded but not silent: allowing without saying so would hide that the
    // guard never reached the remote.
    expect(result.stderr).toContain('WARNING');
    expect(result.status).toBe(0);
  });

  it('refuses the reverse update, which the same advertised tip proves is destructive', () => {
    // Identical failure of the live query; only the direction differs. Degrading
    // the check must not degrade the control.
    const head = git(['rev-parse', 'HEAD'], work);
    const parent = git(['rev-parse', 'HEAD~1'], work);

    const result = runHook(parent, head);

    expect(result.stderr).toContain('push-guard.unverifiable-remote');
    expect(result.stderr).toContain('not a fast-forward');
    expect(result.status).not.toBe(0);
  });

  it('refuses when the advertised tip is not an object it has', () => {
    const head = git(['rev-parse', 'HEAD'], work);

    const result = runHook(head, 'b'.repeat(40));

    expect(result.stderr).toContain('push-guard.unverifiable-remote');
    expect(result.stderr).toContain('cannot be determined');
    // The two refusals must stay distinguishable. Both come from a non-zero
    // exit, and if a refactor merged them the reader would be told "not a
    // fast-forward" about a question that was never answered.
    expect(result.stderr).not.toContain('not a fast-forward');
    expect(result.status).not.toBe(0);
  });

  it('allows a new branch, which reaches exit 128 for the opposite reason', () => {
    // Exit 128 has TWO meanings in this fallback and they are told apart only
    // by the explicit zero-sha case: a new ref advertises the zero sha, which
    // is not a valid commit name, so a fallback that refused on non-zero would
    // refuse the most common push there is. That case is therefore not a
    // nicety — it is what makes 128 decidable at all, and it is asserted
    // separately from the refusal above so a refactor cannot merge them.
    const head = git(['rev-parse', 'HEAD'], work);

    const result = runHook(head, ZERO_SHA);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('cannot be determined');
    expect(result.stderr).not.toContain('REFUSED');
  });
});

describe('a solo rollback of ALL of its own work is not reported as a second writer', () => {
  // The harder input, and the one that shows reachability is a proxy rather
  // than the property. Rolling back SOME of your commits leaves your session id
  // reachable from the local tip. Rolling back ALL of them does not — every
  // commit carrying it is exactly what is being removed — so a reachability
  // test classifies your own work as foreign again, on the single most likely
  // destructive push a solo session ever makes: "that branch was wrong, take it
  // all back".
  let root: string;
  let remote: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-fullroll-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, work], root);
    configure(work);
    git(['checkout', '-b', 'feature'], work);
    // The base carries a different session: it is somebody else's starting
    // point, which is what makes the rollback a genuine full retreat.
    commit(work, 'base', 'session-base');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], work);
    for (const name of ['mine one', 'mine two']) {
      commit(work, name, 'session-mine');
    }
    git(['push', '--no-verify', 'origin', 'feature'], work);
    git(['reset', '--hard', 'HEAD~2'], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses as an unacknowledged discard, not as another session', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.unacknowledged-discard');
    expect(stderr).not.toContain('push-guard.foreign-session');
    expect(stderr).not.toContain('Two sessions are writing');
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
  });
});

describe('work that arrived by pull is not work this session wrote', () => {
  // Most PRs here sit BEHIND under strict required checks, so pulling
  // `development` to stay mergeable is the most frequent git operation anyone
  // performs. That makes "the reflog contains commits that arrived by pull" the
  // NORMAL state of a clone, not an edge of it.
  //
  // A reflog is a record of where the ref WENT. `git log -g` yields one commit
  // per entry — the commit the ref moved to — so every foreign commit this clone
  // has ever fast-forwarded onto is named by an entry. "A fetched commit does not
  // enter the reflog" is true of `git fetch` alone, which moves only
  // `refs/remotes/*`, and is worthless as a safety property because the local
  // branch moves constantly.
  //
  // The subject (`%gs`) is what separates arrival from authorship, and this is
  // the case that pins it. Nothing else in this file does: widen the predicate to
  // accept `pull` entries and the #81 refusal — the entire point of the guard —
  // silently stops firing, because the pusher would "own" the very session whose
  // work they are destroying. The counterfactual at the end of this file would
  // not catch it either, since it tests that the hook does something rather than
  // that it does the right thing.
  let root: string;
  let remote: string;
  let mine: string;
  let theirs: string;
  let base: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-pulled-'));
    remote = path.join(root, 'remote.git');
    mine = path.join(root, 'mine');
    theirs = path.join(root, 'theirs');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, mine], root);
    configure(mine);
    git(['checkout', '-b', 'feature'], mine);
    commit(mine, 'base', 'session-mine');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], mine);
    base = git(['rev-parse', 'HEAD'], mine);

    // A genuinely separate clone, so their commits are authored somewhere this
    // worktree's reflog can never have recorded as creation.
    git(['clone', remote, theirs], root);
    configure(theirs);
    git(['checkout', 'feature'], theirs);
    commit(theirs, 'theirs one', 'session-theirs');
    commit(theirs, 'theirs two', 'session-theirs');
    git(['push', '--no-verify', 'origin', 'feature'], theirs);

    // I stay mergeable. This is the step that puts their session id into my
    // reflog, under a `pull` subject.
    git(['pull', '--no-rebase', 'origin', 'feature'], mine);
    git(['reset', '--hard', base], mine);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], mine);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('puts their session id in my reflog, which is the precondition', () => {
    // Asserted, because if the pull stopped landing their id here the case below
    // would pass for having nothing to launder rather than for filtering it.
    const reflog = git(
      [
        'log',
        '-g',
        '--format=%gs :: %(trailers:key=Copilot-Session,valueonly)',
        'HEAD',
      ],
      mine,
    );
    expect(reflog).toContain('session-theirs');
    // And the discriminator: their id arrives on an entry that is not a creation.
    expect(reflog).not.toMatch(/^commit.*session-theirs/m);
  });

  it('still refuses as a second writer, naming them', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], mine);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.foreign-session');
    expect(stderr).toContain('never authored here: session-theirs');
    expect(stderr).toContain(ACK_FOREIGN_ENV);
    // The verdict a laundered id produces: I would "own" their session, so the
    // two-writer claim and the second acknowledgement would both disappear.
    expect(stderr).not.toContain('push-guard.unacknowledged-discard');
  });
});

describe('a cherry-pick you had to resolve is still their commit', () => {
  // The predicate that separates authorship from arrival was `/^commit\b/`, and
  // `\b` matches four subjects git spells with a `commit` prefix, not one.
  // Measured with foreign work arriving ONLY by fetch, `commit (cherry-pick):`
  // and `commit (amend):` both put the other session's id into the owned set —
  // both are `git commit` invocations that re-apply a message somebody else
  // wrote, so the commit carries THEIR trailer while the reflog says this
  // worktree committed it.
  //
  // The split that makes this hard to find by enumerating operations: the SAME
  // cherry-pick writes `cherry-pick:` when it applies cleanly, which never
  // leaked, and `commit (cherry-pick):` only when you resolve a conflict. The
  // subject is the variable, not the command.
  //
  // Consequence, if unfixed: their id is owned, `foreign-session` goes quiet for
  // the REST of their work in the same push, and authorisation drops from two
  // acknowledgements to one — silently, in the permissive direction, on the
  // highest-severity check the guard has.
  let root: string;
  let remote: string;
  let mine: string;
  let theirs: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-cherry-'));
    remote = path.join(root, 'remote.git');
    mine = path.join(root, 'mine');
    theirs = path.join(root, 'theirs');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, mine], root);
    configure(mine);
    git(['checkout', '-b', 'feature'], mine);
    commit(mine, 'base', 'session-mine');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], mine);

    // Their work is authored in a separate clone and reaches me only by fetch,
    // so no plain `commit:` entry of mine can name it. Without that the case
    // proves nothing: a first version of this measurement created their commits
    // locally and every arm "leaked" for that reason alone.
    git(['clone', remote, theirs], root);
    configure(theirs);
    git(['checkout', 'feature'], theirs);
    writeFileSync(path.join(theirs, 'shared.txt'), 'their version\n');
    git(['add', '-A'], theirs);
    git(
      ['commit', '-m', 'their work A\n\nCopilot-Session: session-theirs'],
      theirs,
    );
    commit(theirs, 'their work B', 'session-theirs');
    git(['push', '--no-verify', 'origin', 'feature'], theirs);

    // I write the same file, so carrying their commit across conflicts.
    git(['fetch', 'origin'], mine);
    writeFileSync(path.join(mine, 'shared.txt'), 'my version\n');
    git(['add', '-A'], mine);
    git(['commit', '-m', 'my work\n\nCopilot-Session: session-mine'], mine);

    const theirFirst = git(['rev-parse', 'origin/feature~1'], mine);
    try {
      git(['cherry-pick', theirFirst], mine);
    } catch {
      // Expected: this is the conflicting path, which is the one under test.
    }
    writeFileSync(path.join(mine, 'shared.txt'), 'resolved\n');
    git(['add', '-A'], mine);
    git(['-c', 'core.editor=true', 'cherry-pick', '--continue'], mine);

    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], mine);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes their id under a commit-prefixed subject, which is the precondition', () => {
    // Asserted, because if the resolution stopped producing this subject the
    // case below would pass for having nothing to launder rather than for
    // refusing to launder it.
    const reflog = git(
      [
        'log',
        '-g',
        '--format=%gs :: %(trailers:key=Copilot-Session,valueonly)',
        'HEAD',
      ],
      mine,
    );
    expect(reflog).toMatch(/^commit \(cherry-pick\):.*::.*session-theirs/m);
  });

  it('still refuses as a second writer, naming them', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], mine);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.foreign-session');
    expect(stderr).toContain('session-theirs');
    expect(stderr).toContain(ACK_FOREIGN_ENV);
    // The verdict a laundered id produces instead.
    expect(stderr).not.toContain('push-guard.unacknowledged-discard');
  });
});

describe('amending a commit that arrived by pull does not make it yours', () => {
  // The second measured leak, and it is #81's own scenario reached from the
  // other side: check out the shared branch, amend what you take to be your own
  // tip, and it is in fact the commit that arrived in the last pull. The amend
  // keeps their message, so the rewritten commit carries THEIR trailer under a
  // `commit (amend):` subject.
  let root: string;
  let remote: string;
  let mine: string;
  let theirs: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-amend-'));
    remote = path.join(root, 'remote.git');
    mine = path.join(root, 'mine');
    theirs = path.join(root, 'theirs');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, mine], root);
    configure(mine);
    git(['checkout', '-b', 'feature'], mine);
    commit(mine, 'base', 'session-mine');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], mine);

    git(['clone', remote, theirs], root);
    configure(theirs);
    git(['checkout', 'feature'], theirs);
    commit(theirs, 'their work A', 'session-theirs');
    git(['push', '--no-verify', 'origin', 'feature'], theirs);

    // I stay mergeable, and my tip is now their commit.
    git(['pull', '--ff-only', 'origin', 'feature'], mine);
    writeFileSync(path.join(mine, 'extra.txt'), 'my tweak\n');
    git(['add', '-A'], mine);
    git(['commit', '--amend', '--no-edit'], mine);

    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], mine);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves their id on a commit-prefixed subject, which is the precondition', () => {
    const reflog = git(
      [
        'log',
        '-g',
        '--format=%gs :: %(trailers:key=Copilot-Session,valueonly)',
        'HEAD',
      ],
      mine,
    );
    expect(reflog).toMatch(/^commit \(amend\):.*::.*session-theirs/m);
    // And the entry it rewrote is an arrival, which is what makes it refusable.
    expect(reflog).toMatch(/^pull|^merge/m);
  });

  it('still refuses as a second writer, naming them', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], mine);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.foreign-session');
    expect(stderr).toContain('session-theirs');
    expect(stderr).toContain(ACK_FOREIGN_ENV);
    expect(stderr).not.toContain('push-guard.unacknowledged-discard');
  });
});

describe('amending your own commit to add your trailer keeps it yours', () => {
  // The control for the case above, differing in ONE variable: whether the
  // commit being amended was created here. It is also the reason the amend rule
  // is "accept when the entry it rewrote was created here" rather than the much
  // simpler "never accept an amend".
  //
  // Measured: `git commit -m wip` then `git commit --amend` with the trailered
  // message leaves your id in the AMEND entry ONLY, because the `commit: wip`
  // entry names the pre-amend commit and that one has no trailer. Dropping
  // amends outright would lose your own id here and print it back at you as
  // another session's — the one claim this guard is not allowed to make.
  let root: string;
  let remote: string;
  let work: string;
  let base: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-amendown-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, work], root);
    configure(work);
    // Deliberately UNTRAILERED, so the amend below is the only thing that can
    // put this session's id into the owned set. With a trailered base commit
    // this case passes whether the amend rule works or not — measured: the
    // "never accept an amend" mutation survived until this line was fixed.
    writeFileSync(path.join(work, 'base.txt'), 'base\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'base'], work);
    git(['push', '--no-verify', '-u', 'origin', 'development'], work);
    base = git(['rev-parse', 'HEAD'], work);

    git(['checkout', '-b', 'feature'], work);
    // Untrailered first, trailer added by the amend. This is what puts the id
    // nowhere but the amend entry.
    writeFileSync(path.join(work, 'wip.txt'), 'wip\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'wip'], work);
    writeFileSync(path.join(work, 'wip.txt'), 'done\n');
    git(['add', '-A'], work);
    git(
      ['commit', '--amend', '-m', 'my work\n\nCopilot-Session: session-mine'],
      work,
    );
    git(['push', '--no-verify', '-u', 'origin', 'feature'], work);
    git(['reset', '--hard', base], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('carries the id on the amend entry and nowhere else, which is the precondition', () => {
    const reflog = git(
      [
        'log',
        '-g',
        '--format=%gs :: %(trailers:key=Copilot-Session,valueonly)',
        'HEAD',
      ],
      work,
    );
    expect(reflog).toMatch(/^commit \(amend\):.*::.*session-mine/m);
    // If ANY plain `commit:` entry carried it, the case would pass without the
    // amend rule doing any work. That is not hypothetical: it is how this
    // fixture was first written, and the "never accept an amend" mutation
    // survived it.
    expect(reflog).not.toMatch(/^commit(?: \(initial\))?:.*session-mine/m);
  });

  it('refuses without inventing a second writer', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.unacknowledged-discard');
    expect(stderr).not.toContain('push-guard.foreign-session');
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
  });
});

describe('a sibling worktree of the same clone is not this session', () => {
  // F4. Ownership is read from a reflog, and WHICH FILE that is decides the
  // answer. Measured:
  //
  //     <git-dir>/logs/HEAD              PER-WORKTREE
  //     <common-dir>/logs/refs/heads/…   SHARED by every worktree
  //
  // This squad runs eight-plus worktrees off one clone, so the branch reflog is
  // a record of everybody. The guard used to read it alongside HEAD's, on the
  // reasoning that it "covers commits made on that branch" — which it does,
  // including commits made on it by somebody else.
  //
  // Two worktrees cannot hold one branch at once, so the way this is reached is
  // that a worktree is RETIRED, which happens here constantly. The worktree goes;
  // its branch reflog stays behind in the common dir. Measured at 94d25e2: the
  // next session picked the branch up, destroyed two of the departed session's
  // commits, and was told `unacknowledged-discard` — the LONE-WRITER verdict —
  // with the two-writer claim and the foreign override both withheld.
  // Authorisation dropped from two acknowledgements to one, silently, which is
  // the same severity shape as the carry-forward defect and reached by an
  // entirely different door.
  let root: string;
  let remote: string;
  let mine: string;
  let theirs: string;
  let base: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-worktree-'));
    remote = path.join(root, 'remote.git');
    mine = path.join(root, 'mine');
    theirs = path.join(root, 'theirs');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, mine], root);
    configure(mine);
    commit(mine, 'base', 'session-mine');
    git(['push', '--no-verify', '-u', 'origin', 'development'], mine);
    base = git(['rev-parse', 'HEAD'], mine);

    // The other session works in its own worktree OF THE SAME CLONE, which is
    // this squad's layout, not a separate clone.
    git(['worktree', 'add', '-b', 'feature', theirs], mine);
    configure(theirs);
    commit(theirs, 'theirs one', 'session-theirs');
    commit(theirs, 'theirs two', 'session-theirs');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], theirs);

    // Their worktree is retired. Their branch reflog is not: it is in the
    // common dir and it outlives them.
    git(['worktree', 'remove', '--force', theirs], mine);
    git(['checkout', 'feature'], mine);
    git(['reset', '--hard', base], mine);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], mine);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves the departed session’s commit entries in the shared branch reflog', () => {
    // The precondition, asserted rather than assumed: without it a later change
    // to git or to this fixture could make the case below pass for having
    // nothing to leak rather than for reading the right file.
    const branchReflog = git(
      ['log', '-g', '--format=%gs', 'refs/heads/feature'],
      mine,
    );
    expect(branchReflog).toContain('commit: theirs two');
    // And the thing that makes the fix work: their authorship is absent from
    // THIS worktree's HEAD, so scoping to HEAD is what separates the two.
    const headReflog = git(['log', '-g', '--format=%gs', 'HEAD'], mine);
    expect(headReflog).not.toContain('commit: theirs two');
  });

  it('still names them as a second writer, not as work of my own', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], mine);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.foreign-session');
    expect(stderr).toContain('Two sessions are writing');
    expect(stderr).toContain('never authored here: session-theirs');
    expect(stderr).toContain(ACK_FOREIGN_ENV);
    // The verdict this defect produced. Pinned by name, because the harm was
    // not that it allowed the push — it refused — but that it downgraded the
    // claim and halved the acknowledgement.
    expect(stderr).not.toContain('push-guard.unacknowledged-discard');
  });
});

describe('my own work in my own worktree is still mine', () => {
  // The control for the case above, differing in ONE variable: who authored the
  // commits being discarded. Everything else — one clone, a `feature` branch
  // built on top of `development`, a hard reset, a force-push — is identical.
  //
  // Without this, narrowing ownership to HEAD's reflog could be "passing" by
  // having stopped recognising anybody's authorship at all, and the case above
  // would read as a success while the guard had simply been broken toward
  // refusing.
  let root: string;
  let remote: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-ownwork-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, work], root);
    configure(work);
    commit(work, 'base', 'session-mine');
    git(['push', '--no-verify', '-u', 'origin', 'development'], work);
    const base = git(['rev-parse', 'HEAD'], work);

    git(['checkout', '-b', 'feature'], work);
    commit(work, 'mine one', 'session-mine');
    commit(work, 'mine two', 'session-mine');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], work);
    git(['reset', '--hard', base], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses without inventing a second writer', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.unacknowledged-discard');
    expect(stderr).not.toContain('push-guard.foreign-session');
    expect(stderr).not.toContain('push-guard.unattributed-discard');
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
  });
});

describe('a clone with no reflog does not get a finding it has not made', () => {
  // The reflog is what rescues the total-rollback case above, and it is not
  // always there: `core.logAllRefUpdates=false` turns it off, entries expire,
  // and a fresh clone has none for work it did not do.
  //
  // Measured with that config as the only variable, the total-rollback case
  // regressed exactly to the original defect: `foreign-session`, "written by
  // another session", naming the pusher's own id and printing the override for
  // it. The guard's own comment had claimed an empty reflog "fails toward MORE
  // refusals" and was therefore safe. More refusals is not safe when the extra
  // refusals are false and their remedy is the flag that disables the check.
  //
  // So absence is split by whether it is informative. The refusal stays; the
  // unsupported claim goes.
  //
  // How this fixture reaches "no reflog" matters, and it used to reach it by
  // accident. Setting `core.logAllRefUpdates false` was doing NOTHING here: the
  // remote is empty when it is cloned, so no `logs/` files were ever created,
  // and the absence came from the clone rather than from the config. Measured
  // both arms:
  //
  //     config false, logs/ never created (empty remote)  ->  0 entries
  //     config false, logs/ already exist  (seeded remote) ->  4 entries,
  //                                                            2 of them `commit`
  //
  // Git keeps appending to a reflog file that already exists regardless of the
  // setting. So the config alone cannot disable anything in a normal clone, and
  // a test that sets it and looks is measuring its own fixture ordering. See the
  // case below, which pins that git behaviour itself.
  //
  // The removal below is a no-op TODAY, since this fixture's remote is empty
  // when cloned and no logs were ever written. It is there so that seeding this
  // remote — an ordinary-looking edit, and what every other fixture in this file
  // does — cannot silently turn this case into a test of the attributed path.
  // The assertion that follows is what actually catches that, either way.
  let root: string;
  let remote: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-noreflog-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, work], root);
    configure(work);
    git(['config', 'core.logAllRefUpdates', 'false'], work);
    git(['checkout', '-b', 'feature'], work);
    commit(work, 'base', 'session-base');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], work);
    for (const name of ['mine one', 'mine two']) {
      commit(work, name, 'session-mine');
    }
    git(['push', '--no-verify', 'origin', 'feature'], work);
    git(['reset', '--hard', 'HEAD~2'], work);
    // The config is not enough on its own; remove anything that was written
    // before it took effect, so the state under test is the stated one.
    rmSync(path.join(work, '.git', 'logs'), { recursive: true, force: true });
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('has no reflog to read, which is the whole premise', () => {
    // Asserted, not assumed. If a future change to this fixture or to git
    // restores the reflog, the case below would start exercising the ordinary
    // attributed path while still passing under a name that promises otherwise.
    //
    // Emptiness rather than failure: `git log -g` on a ref with no reflog exits
    // 0 and prints nothing. Measured, after this was first written as `toThrow`
    // and failed. The guard's readers treat both the same, but a test asserting
    // the wrong one of the two would be pinning a fiction.
    expect(git(['log', '-g', '--format=%gs', 'HEAD'], work)).toBe('');
  });

  it('refuses without claiming the discarded work belongs to someone else', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    // Still refuses: the destructive push does not get through on a technicality
    // about evidence. What changes is the claim and the remedy.
    expect(stderr).toContain('push-guard.unattributed-discard');
    expect(stderr).toContain('cannot');
    // Pinned against the CLAIM, not against a literal sentence that a reword
    // would silently retire: `foreign-session` is the verdict that asserts a
    // second writer, and the override is what it demands.
    expect(stderr).not.toContain('push-guard.foreign-session');
    expect(stderr).not.toContain('Two sessions are writing');
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
    // Not asserted: that the session id is absent from the message. Naming
    // `session-mine` as the id it could not attribute is true and useful; the
    // defect was asserting whose it was, not mentioning it.
  });

  it('still destroys nothing, which is the property the refusal exists for', () => {
    const tip = git(
      ['--git-dir', remote, 'rev-parse', 'refs/heads/feature'],
      root,
    );
    expect(tip).not.toBe(git(['rev-parse', 'HEAD'], work));
  });
});

describe('a reflog that cannot prove it is complete is not read as a genuine negative (#315)', () => {
  // `authoredHere` used to be two-valued: an empty result from
  // `filterCreatedEntries` meant `false`, full stop. That conflates two
  // different facts that `git log -g` reports identically — "nothing was ever
  // created here" and "something was created here, but that entry has since
  // aged out under `gc.reflogExpireUnreachable` (30 days)". Both leave the
  // reflog non-empty (arrival entries survive) but with no surviving `commit:`
  // line, so the old two-valued reading collapsed the second, undecidable case
  // into the first, decidable one.
  //
  // The first tri-state fix bounded that decay by the AGE of the oldest entry
  // still visible: young window, no decay possible. Review for #315 found a
  // repro that heuristic gets backwards: `gc.reflogExpireUnreachable` prunes
  // each unreachable entry independently, so an OLD `commit:` entry can be
  // pruned while a NEWER, unrelated entry survives right after where it used
  // to sit — leaving every VISIBLE entry looking recent even though the
  // creation entry that would have proven authorship is already gone.
  //
  // This fixture reaches exactly that shape, deterministically: `work`
  // creates a commit (a genuine `commit:` reflog entry), that commit is made
  // unreachable, a recent operation adds a fresh non-creation entry right
  // after it, and then the `commit:` line is removed from the raw reflog
  // file — simulating the prune `git reflog expire` performs on a real clock,
  // without depending on real elapsed time or `gc.reflogExpireUnreachable`'s
  // actual timing in CI. What survives is a reflog whose newest entries are
  // all timestamped "now": an age-based check would call that young enough to
  // trust, and would be wrong, because the entry it needed is the one that
  // was removed.
  let root: string;
  let remote: string;
  let work: string;
  let createdSha: string;
  let survivingOldSha: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-decay-'));
    remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, seed], root);
    configure(seed);
    git(['checkout', '-b', 'feature'], seed);
    commit(seed, 'seeded base', 'session-other');
    commit(seed, 'seeded, to be discarded', 'session-other');
    git(['push', 'origin', 'feature'], seed);

    git(['clone', remote, work], root);
    configure(work);
    git(['checkout', 'feature'], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);

    // A genuine creation entry, here — this is the one the fixture will make
    // unreachable and then erase from the reflog, standing in for whatever
    // `commit:` entry `gc.reflogExpireUnreachable` would eventually prune.
    commit(work, 'created here, later orphaned', 'session-mine');
    createdSha = git(['rev-parse', 'HEAD'], work);

    // Orphan it and, in the same motion, write the RECENT non-creation entry
    // that survives the prune below and masks the gap: `reset:`'s own OLD
    // sha is `createdSha`, the very value the removed `commit:` line's NEW
    // sha would have supplied. Once that line is gone, nothing visible
    // supplies it any more. This also puts `work` back at the remote's
    // actual tip (`seeded, to be discarded`), so the final test below still
    // has a `session-other` commit left to discard.
    git(['reset', '--hard', 'HEAD~1'], work);
    survivingOldSha = createdSha;

    const reflogPath = path.join(work, '.git', 'logs', 'HEAD');
    const original = readFileSync(reflogPath, 'utf8');
    const lines = original.split('\n').filter((line) => line.length > 0);
    const withoutCreation = lines.filter(
      (line) => !line.includes(`\tcommit: created here, later orphaned`),
    );
    expect(withoutCreation.length).toBe(lines.length - 1);
    writeFileSync(reflogPath, withoutCreation.join('\n') + '\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('has a non-empty reflog, no creation entry, and every visible entry timestamped now', () => {
    // Pinned so a future change to this fixture cannot silently start
    // exercising a different one of the three cases while keeping this
    // describe block's name.
    const entries = git(
      ['log', '-g', '--date=iso-strict', '--format=%gs|%gd', 'HEAD'],
      work,
    );
    expect(entries).not.toBe('');
    for (const line of entries.split('\n')) {
      expect(line).not.toMatch(/^commit(?: \(initial\))?:/);
      const [, selector] = line.split('|');
      const writeTime = new Date(selector!.match(/@\{(.+)\}$/)![1]!).getTime();
      const ageDays = (Date.now() - writeTime) / (24 * 60 * 60 * 1000);
      // Every entry still visible is fresh — an age-based coverage check
      // would call this reflog trustworthy. It is not: the entry proving
      // completeness back to genesis was just removed above.
      expect(ageDays).toBeLessThan(1);
    }
  });

  it("the surviving entry's OLD sha is the removed creation entry's NEW sha, proving the gap", () => {
    const rawLog = readFileSync(
      path.join(work, '.git', 'logs', 'HEAD'),
      'utf8',
    );
    const lastLine = rawLog
      .split('\n')
      .filter((line) => line.length > 0)
      .at(-1)!;
    const [oldSha] = lastLine.split(' ');
    expect(oldSha).toBe(survivingOldSha);
    expect(oldSha).toBe(createdSha);
  });

  it('authoredHere() reports null, not false, once a creation entry could have decayed', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(work);
      expect(authoredHere()).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('a naive two-valued reading (`!== true`) cannot tell this apart from a genuine negative', () => {
    // The falsifier: the OLD, two-valued way of consuming this exact signal
    // — "anything that is not `true` is `false`" — erases the distinction
    // this fix exists to preserve. Demonstrated directly against the tri-state
    // value itself, not against a re-implementation, so this fails the moment
    // `authoredHere` stops returning `null` here for any reason.
    const originalCwd = process.cwd();
    let value: boolean | null;
    try {
      process.chdir(work);
      value = authoredHere();
    } finally {
      process.chdir(originalCwd);
    }
    const twoValuedReading = value === true;
    expect(twoValuedReading).toBe(false);
    // The naive reading and the correct one agree on ALLOW/REFUSE only by the
    // accident that both `false` and `null` currently refuse in
    // `evaluateRefUpdate`. What the naive reading loses is visible instead in
    // the census: `census-ownership-evidence.mjs` needs `=== null` to report
    // "cannot determine" rather than "authored nothing", and a two-valued
    // reading has already destroyed the information it would need to do that.
    expect(value).not.toBe(false);
    expect(value).toBeNull();
  });

  it('still refuses the push, because null is read exactly like false downstream', () => {
    // The whole point of the tri-state refinement is that it changes nothing
    // about the guard's own decision — only what it reports to observers like
    // the census. Proven here by driving a real discard through the real hook
    // against this exact fixture: `work`'s only visible reflog evidence of
    // authorship was just erased (`authoredHere()` is `null`, pinned above,
    // precisely because that is unprovable), and the commit it is about to
    // discard was created by `session-other`, never by this worktree.
    git(['reset', '--hard', 'HEAD~1'], work);

    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();
    expect(stderr).toContain('push-guard.unattributed-discard');
    expect(stderr).not.toContain('push-guard.foreign-session');
  });
});

describe('a self-cancelling create/discard pair pruned together is not read as a genuine negative (#315)', () => {
  // The chain-of-object-ids check above closes the hole in its own
  // predecessor — a non-genesis entry can never masquerade as the genesis,
  // because its OLD id is never the all-zero sha. Review for #315 found a
  // SECOND hole in it: a CONTIGUOUS, SELF-CANCELLING pair of entries (commit,
  // then `reset --hard` it away) starts and ends at the SAME sha. If
  // `gc.reflogExpireUnreachable` prunes both together once the commit they
  // made unreachable ages past it, the entries immediately before and after
  // the pair still connect to EACH OTHER — the chain heals with no visible
  // seam, and a real creation this worktree made is read as never having
  // happened.
  //
  // No inspection of the SURVIVING entries can close this: the missing
  // pair's shas are, by construction, exactly what a legitimate gap-free
  // history would show once they're gone. The only sound remedy is to ask
  // whether there was ever an OPPORTUNITY for such a pair to be pruned at
  // all — the genesis entry's own age against `gc.reflogExpireUnreachable`.
  //
  // This fixture reaches that shape directly: `work` creates a commit (a
  // genuine `commit:` entry) and immediately `reset --hard`s it away (a
  // `reset:` entry whose OLD id is that commit's NEW id and whose NEW id is
  // back to the pre-commit value). Both lines are then removed from the raw
  // reflog file — simulating exactly what `git reflog expire` does once the
  // orphaned commit's entries age past `gc.reflogExpireUnreachable` — and the
  // surviving genesis entry's own timestamp is rewritten to look 50 days
  // old, simulating a ref old enough for that pruning to have had a real
  // opportunity to occur. What survives is a single-entry, zero-rooted,
  // fully "continuous" chain: exactly the shape the prior chain-only check
  // read as a confident, provably-complete `false`.
  let root: string;
  let work: string;
  let genesisNewSha: string;
  let survivingLineCount: number;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-roundtrip-'));
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, seed], root);
    configure(seed);
    git(['checkout', '-b', 'feature'], seed);
    commit(seed, 'seeded base', 'session-other');
    commit(seed, 'seeded, to be discarded', 'session-other');
    git(['push', 'origin', 'feature'], seed);

    git(['clone', remote, work], root);
    configure(work);
    git(['checkout', 'feature'], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);

    // The self-cancelling pair: create a commit, then discard it in the same
    // motion a rollback would. `reset:`'s OLD sha is the commit's NEW sha and
    // its own NEW sha is back to `feature`'s actual remote tip, so once both
    // lines are erased below, nothing distinguishes this from a reflog that
    // never saw either operation.
    commit(work, 'created here, then self-cancelled', 'session-mine');
    git(['reset', '--hard', 'HEAD~1'], work);

    const reflogPath = path.join(work, '.git', 'logs', 'HEAD');
    const original = readFileSync(reflogPath, 'utf8');
    const lines = original.split('\n').filter((line) => line.length > 0);
    const survivors = lines.filter(
      (line) =>
        !line.includes('\tcommit: created here, then self-cancelled') &&
        !line.includes('\treset: moving to HEAD~1'),
    );
    expect(survivors.length).toBe(lines.length - 2);
    expect(survivors.length).toBe(1); // the genesis (checkout) entry alone

    // Backdate the surviving genesis entry's timestamp by 50 days — older
    // than `gc.reflogExpireUnreachable`'s 30-day default — so the fixture
    // actually exercises the case the age check exists for, rather than one
    // that would (correctly) read `false` because no time has really passed.
    const [genesisLine] = survivors;
    const tabIndex = genesisLine!.indexOf('\t');
    const header = genesisLine!.slice(0, tabIndex);
    const message = genesisLine!.slice(tabIndex);
    const tokens = header.split(/ +/).filter((t) => t.length > 0);
    const fiftyDaysAgo = Math.floor(Date.now() / 1000) - 50 * 24 * 60 * 60;
    tokens[tokens.length - 2] = String(fiftyDaysAgo);
    genesisNewSha = tokens[1]!;
    const backdated = tokens.join(' ') + message;
    survivingLineCount = survivors.length;

    writeFileSync(reflogPath, backdated + '\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('leaves a single-entry, zero-rooted, fully continuous chain', () => {
    // Pinned so a future change to this fixture cannot silently start
    // exercising a different shape while keeping this describe block's name:
    // the whole point is that the SURVIVING reflog looks perfectly complete.
    expect(survivingLineCount).toBe(1);
    const rawLog = readFileSync(
      path.join(work, '.git', 'logs', 'HEAD'),
      'utf8',
    );
    const lines = rawLog.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    const [oldSha, newSha] = lines[0]!.split(' ');
    expect(oldSha).toBe(ZERO_SHA);
    expect(newSha).toBe(genesisNewSha);
  });

  it('authoredHere() reports null, not false, once a create/discard pair could have been pruned', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(work);
      expect(authoredHere()).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('a naive two-valued reading (`!== true`) cannot tell this apart from a genuine negative', () => {
    const originalCwd = process.cwd();
    let value: boolean | null;
    try {
      process.chdir(work);
      value = authoredHere();
    } finally {
      process.chdir(originalCwd);
    }
    const twoValuedReading = value === true;
    expect(twoValuedReading).toBe(false);
    expect(value).not.toBe(false);
    expect(value).toBeNull();
  });

  it('still refuses the push, because null is read exactly like false downstream', () => {
    git(['reset', '--hard', 'HEAD~1'], work);

    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();
    expect(stderr).toContain('push-guard.unattributed-discard');
    expect(stderr).not.toContain('push-guard.foreign-session');
  });
});

describe('a non-default, space-separated gc.reflogExpireUnreachable is not silently misread as the 30-day default (#315)', () => {
  // Review for #315 found `reflogExpireUnreachableDays()` itself misparsing
  // real config values, twice, by hand-rolling only a fraction of the
  // spellings `gc.reflogExpireUnreachable` legally holds. The first pass
  // understood `N.days` (dotted) and raw seconds; it silently fell back to
  // the hard-coded 30-day default for git's own CANONICAL, space-separated
  // spelling ("10 days") and for approxidate forms with a trailing "ago"
  // ("7 days ago"). That default can be either more or less permissive than
  // whatever was actually configured, and being MORE permissive is the
  // dangerous direction here: it lets `reflogIsProvablyComplete()` treat a
  // genesis entry as young enough to trust when, under the REAL configured
  // threshold, it is old enough that a self-cancelling create/discard pair
  // (see the describe block above) could already have been pruned nearby.
  //
  // This fixture reaches exactly that shape: `gc.reflogExpireUnreachable`
  // is set to the plain, space-separated "15 days" (no dot, the form a
  // human or `git config` itself would normally write), and the surviving
  // genesis entry is backdated to 20 days old — younger than the hard-coded
  // 30-day default (so the old, misparsing code would wrongly call it
  // "provably complete"), but OLDER than the 15 days actually configured
  // (so the correct answer is "no longer provable", i.e. `null`).
  let root: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-expiryformat-'));
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, seed], root);
    configure(seed);
    git(['checkout', '-b', 'feature'], seed);
    commit(seed, 'seeded base', 'session-other');
    commit(seed, 'seeded, to be discarded', 'session-other');
    git(['push', 'origin', 'feature'], seed);

    git(['clone', remote, work], root);
    configure(work);
    git(['checkout', 'feature'], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);

    // The canonical, human-written spelling — no dot separator — that the
    // retired parser silently misread as "unset" and defaulted away.
    git(['config', 'gc.reflogExpireUnreachable', '15 days'], work);

    commit(work, 'created here, then self-cancelled', 'session-mine');
    git(['reset', '--hard', 'HEAD~1'], work);

    const reflogPath = path.join(work, '.git', 'logs', 'HEAD');
    const original = readFileSync(reflogPath, 'utf8');
    const lines = original.split('\n').filter((line) => line.length > 0);
    const survivors = lines.filter(
      (line) =>
        !line.includes('\tcommit: created here, then self-cancelled') &&
        !line.includes('\treset: moving to HEAD~1'),
    );
    expect(survivors.length).toBe(1); // the genesis (checkout) entry alone

    const [genesisLine] = survivors;
    const tabIndex = genesisLine!.indexOf('\t');
    const header = genesisLine!.slice(0, tabIndex);
    const message = genesisLine!.slice(tabIndex);
    const tokens = header.split(/ +/).filter((t) => t.length > 0);
    const twentyDaysAgo = Math.floor(Date.now() / 1000) - 20 * 24 * 60 * 60;
    tokens[tokens.length - 2] = String(twentyDaysAgo);
    const backdated = tokens.join(' ') + message;

    writeFileSync(reflogPath, backdated + '\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('authoredHere() reports null under a plain "N days" config, not the false a misparse-to-default would give', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(work);
      expect(authoredHere()).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('the same fixture reads true-complete only if the config is misparsed back to the 30-day default', () => {
    // Pins the mechanism, not just the outcome: this is the exact
    // computation a hand-rolled parser falling back to the default would
    // have performed, and it disagrees with the correct answer above.
    const genesisAgeDays = 20;
    const misparsedDefaultDays = 30;
    const actuallyConfiguredDays = 15;
    expect(genesisAgeDays < misparsedDefaultDays).toBe(true);
    expect(genesisAgeDays < actuallyConfiguredDays).toBe(false);
  });
});

describe('an approxidate "N days ago" gc.reflogExpireUnreachable is also not misread as the 30-day default (#315)', () => {
  // Same failure class as the block above, pinned against the OTHER
  // spelling review found it missing: an explicit "ago" suffix. Git accepts
  // this as an ordinary approxidate everywhere it accepts a date, including
  // in this config's value, and it is at least as natural a thing for
  // someone to write here as the dotted `N.days` spelling the retired
  // parser understood.
  let root: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-expiryformat2-'));
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, seed], root);
    configure(seed);
    git(['checkout', '-b', 'feature'], seed);
    commit(seed, 'seeded base', 'session-other');
    commit(seed, 'seeded, to be discarded', 'session-other');
    git(['push', 'origin', 'feature'], seed);

    git(['clone', remote, work], root);
    configure(work);
    git(['checkout', 'feature'], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);

    git(['config', 'gc.reflogExpireUnreachable', '7 days ago'], work);

    commit(work, 'created here, then self-cancelled', 'session-mine');
    git(['reset', '--hard', 'HEAD~1'], work);

    const reflogPath = path.join(work, '.git', 'logs', 'HEAD');
    const original = readFileSync(reflogPath, 'utf8');
    const lines = original.split('\n').filter((line) => line.length > 0);
    const survivors = lines.filter(
      (line) =>
        !line.includes('\tcommit: created here, then self-cancelled') &&
        !line.includes('\treset: moving to HEAD~1'),
    );
    expect(survivors.length).toBe(1); // the genesis (checkout) entry alone

    const [genesisLine] = survivors;
    const tabIndex = genesisLine!.indexOf('\t');
    const header = genesisLine!.slice(0, tabIndex);
    const message = genesisLine!.slice(tabIndex);
    const tokens = header.split(/ +/).filter((t) => t.length > 0);
    // Ten days old: younger than the misparsed-to-default 30 days (so the
    // retired parser would wrongly call this provably complete), but older
    // than the 7 days actually configured (so the correct answer is null).
    const tenDaysAgo = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
    tokens[tokens.length - 2] = String(tenDaysAgo);
    const backdated = tokens.join(' ') + message;

    writeFileSync(reflogPath, backdated + '\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('authoredHere() reports null under an "N days ago" config, not the false a misparse-to-default would give', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(work);
      expect(authoredHere()).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('core.logAllRefUpdates=false does not disable an existing reflog', () => {
  // Not a test of the guard. A test of the assumption the fixture above was
  // resting on, kept because that assumption is wrong in the direction that
  // makes tests pass for no reason.
  //
  // Anyone writing "reflogs are off" into a future case will reach for the
  // config, and in any clone of a non-empty remote it will do nothing at all
  // while the test goes green. That is the vacuous-assertion failure this whole
  // PR is about, so it gets pinned to git's actual behaviour rather than left
  // as a comment someone can disagree with.
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-reflogcfg-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps appending commit entries to logs/HEAD once the file exists', () => {
    const remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    const work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, seed], root);
    configure(seed);
    commit(seed, 'seed', 'session-seed');
    git(['push', '--no-verify', '-u', 'origin', 'development'], seed);

    // Cloning a NON-empty remote is what creates logs/HEAD. The config is set
    // immediately afterwards and is the only variable against the fixture above.
    git(['clone', remote, work], root);
    configure(work);
    git(['config', 'core.logAllRefUpdates', 'false'], work);
    git(['checkout', '-b', 'feature'], work);
    commit(work, 'mine', 'session-mine');

    expect(git(['log', '-g', '--format=%gs', 'HEAD'], work)).toContain(
      'commit: mine',
    );
    // The branch reflog is a new file, so the config does bite there. Both
    // halves matter: the setting governs CREATION, not appending, which is
    // precisely why "set it and look at one ref" decides nothing.
    expect(git(['log', '-g', '--format=%gs', 'refs/heads/feature'], work)).toBe(
      '',
    );
  });
});

describe('the decision function is pure, and that is enforced rather than promised', () => {
  // Check order is load-bearing: `protected-ref` and the delete refusal are
  // decided inside `evaluateRefUpdate`, so anything that decides upstream of it
  // — a fallback allow in `main()`, or a fact the function fetches for itself —
  // can bypass the highest-severity checks. All git I/O therefore belongs in
  // `gatherFacts`.
  //
  // That rule was previously protected by nothing but the author noticing. It
  // had already been broken once, and nothing would have caught it: the unit
  // tests supply `facts` directly, so a decision function that had quietly
  // started shelling out would have stayed green against the fixtures. A
  // commitment is not a control, including when the thing it constrains is us.
  //
  // So: run it in a process where `git` cannot be resolved at all — PATH is
  // emptied, which is an environment fact rather than a module patch. The first
  // attempt at this control patched `execFileSync` on the child_process
  // namespace before importing the guard, and it did not work: a named ESM
  // import is a snapshot, so the guard kept the original binding and the test
  // passed against a decision function that had been deliberately made to shell
  // out. An assertion that cannot fail is not a control either, which is why
  // this one is mutation-checked below in the same way everything else is.
  it('reaches every verdict in a process where git cannot be resolved', () => {
    const guard = pathToFileURL(
      path.join(repoRoot, 'scripts', 'push-guard.mjs'),
    ).href;
    const probe = `
      const { evaluateRefUpdate } = await import(${JSON.stringify(guard)});
      const base = {
        localRef: 'refs/heads/feature',
        localSha: ${JSON.stringify(LOCAL)},
        remoteRef: 'refs/heads/feature',
        remoteSha: ${JSON.stringify(THEIRS)},
      };
      const facts = (over) => ({
        liveRemoteSha: ${JSON.stringify(THEIRS)},
        liveQueryFailed: false,
        liveQueryError: '',
        liveTipPresent: true,
        provablyFastForward: null,
        discarded: [],
        ownSessions: [],
        ack: '',
        ackForeign: '',
        ...over,
      });
      const codes = [
        evaluateRefUpdate({ ...base, remoteRef: 'refs/heads/development' }, facts()),
        evaluateRefUpdate(base, facts({ liveQueryFailed: true, provablyFastForward: true })),
        evaluateRefUpdate(base, facts({ liveQueryFailed: true, provablyFastForward: false })),
        evaluateRefUpdate(base, facts({ liveQueryFailed: true, provablyFastForward: null })),
        evaluateRefUpdate(base, facts({ liveRemoteSha: ${JSON.stringify(OURS)} })),
        evaluateRefUpdate({ ...base, localSha: '0'.repeat(40) }, facts()),
        evaluateRefUpdate(base, facts({ liveTipPresent: false })),
        evaluateRefUpdate(base, facts()),
        evaluateRefUpdate(
          base,
          facts({ discarded: [{ sha: ${JSON.stringify(THEIRS)}, subject: 'x', sessions: ['other'] }] }),
        ),
      ].map((result) => result.code);
      console.log(JSON.stringify(codes));
    `;

    const blinded = { ...process.env };
    for (const key of Object.keys(blinded)) {
      if (key.toUpperCase() === 'PATH') blinded[key] = '';
    }

    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', probe],
      {
        encoding: 'utf8',
        env: blinded,
      },
    );

    expect(result.stderr).not.toContain('ENOENT');
    expect(result.status).toBe(0);

    const codes = JSON.parse(result.stdout.trim()) as string[];
    // Not merely "it did not crash": the branches actually ran, and the ones
    // that must be decided here rather than upstream are among them.
    expect(codes).toContain('push-guard.protected-ref');
    expect(codes).toContain('push-guard.unverified-fast-forward');
    expect(codes).toContain('push-guard.unverifiable-remote');
    expect(new Set(codes).size).toBeGreaterThan(4);
  });
});

describe('checking out another session\u2019s branch does not launder it into your own', () => {
  // N7, and the reason the reflog needed a filter rather than just a reflog.
  // "A fetched commit does not enter the reflog" was measured and is true — and
  // it was the wrong class. `git checkout` of a fetched branch DOES write an
  // entry naming the other session's tip, which put their id into the owned set
  // and silenced the foreign alarm on the exact scenario #81 is about: two
  // sessions on one branch. The first measurement sampled `fetch` and named the
  // class "arrives from another session"; the config that was never varied was
  // whether the branch had also been checked out.
  let root: string;
  let remote: string;
  let sessionA: string;
  let sessionB: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-launder-'));
    remote = path.join(root, 'remote.git');
    sessionA = path.join(root, 'session-a');
    sessionB = path.join(root, 'session-b');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, sessionA], root);
    configure(sessionA);
    git(['checkout', '-b', 'feature'], sessionA);
    commit(sessionA, 'base', 'session-base');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], sessionA);
    commit(sessionA, 'theirs one', 'session-theirs');
    commit(sessionA, 'theirs two', 'session-theirs');
    git(['push', '--no-verify', 'origin', 'feature'], sessionA);

    git(['clone', remote, sessionB], root);
    configure(sessionB);
    // The laundering step: B never wrote any of this, it only looked at it.
    git(['checkout', '-B', 'feature', 'origin/feature'], sessionB);
    git(['reset', '--hard', 'HEAD~2'], sessionB);
    // B is a second WRITER, which is what makes it the #81 scenario: it rewinds
    // their work and puts its own on top. Without this commit B has authored
    // nothing in this clone, and "are these commits yours?" is genuinely
    // undecidable rather than answerable — that case is pinned separately below,
    // because it is a real limit and it should fail visibly if it ever moves.
    commit(sessionB, 'mine', 'session-b');
    git(
      ['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)],
      sessionB,
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('still names the other session after their branch has been checked out here', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], sessionB);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.foreign-session');
    expect(stderr).toContain('Two sessions are writing');
    expect(stderr).toContain('session-theirs');
    expect(stderr).toContain(ACK_FOREIGN_ENV);
    // The checkout entry named their tip. If it were being read as authorship,
    // `session-theirs` would be in the owned set and this refusal would not
    // exist at all — so the assertion above is the whole point. This one pins
    // the other half: B's OWN id is not among what it is being asked to
    // acknowledge, because B did author that commit here.
    expect(stderr).toContain('never authored here: session-theirs');
  });
});

describe('carrying part of another session\u2019s work forward does not silence the rest', () => {
  // The defect this closes, measured at 37f1715 before the fix. Ownership was
  // reachability UNIONED with the reflog, and the reachability half is what
  // broke: keeping ONE of the other session's commits put their id into the
  // owned set, so every OTHER commit of theirs the same push destroyed was no
  // longer foreign. Verdict dropped from `foreign-session` to
  // `unacknowledged-discard` and authorisation from two env vars to one.
  //
  // It is reached by following the guard's own printed advice — "rebase onto it
  // rather than over it" — because rebasing onto PART of another session's work
  // is the ordinary outcome when some of it is kept and some is obsolete.
  //
  // The two cases below differ in exactly one variable: whether any of their
  // work is carried forward. The control is what makes the result mean
  // something, because `foreign-session` on its own could be produced by a
  // guard that never looked at ownership at all.
  let root: string;
  let remote: string;
  let theirs: string;
  let kept: string;
  let none: string;

  const rewind = (label: string, back: number) => {
    const dir = path.join(root, label);
    git(['clone', '--branch', 'feature', remote, dir], root);
    configure(dir);
    git(['reset', '--hard', `HEAD~${back}`], dir);
    // Authoring here is what gives this clone any ownership record at all; a
    // clone that has committed nothing lands in the degraded path instead,
    // which is pinned separately below.
    commit(dir, 'mine', 'session-mine');
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], dir);
    return dir;
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-carry-'));
    remote = path.join(root, 'remote.git');
    theirs = path.join(root, 'theirs');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, theirs], root);
    configure(theirs);
    git(['checkout', '-b', 'feature'], theirs);
    commit(theirs, 'base', 'session-base');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], theirs);
    // Authored in THEIR clone, so this clone's reflog can never claim them.
    // Authoring them locally would make them genuinely owned and the test
    // vacuous — that mistake was made once while measuring this.
    commit(theirs, 'their first', 'session-theirs');
    commit(theirs, 'their second, never read by me', 'session-theirs');
    git(['push', '--no-verify', 'origin', 'feature'], theirs);

    kept = rewind('kept-one', 1);
    none = rewind('kept-none', 2);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names the other session even when one of their commits is kept', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], kept);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.foreign-session');
    expect(stderr).toContain('session-theirs');
    expect(stderr).toContain(ACK_FOREIGN_ENV);
    expect(stderr).toContain('never read by me');
  });

  it('names the other session when none of their commits is kept', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], none);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.foreign-session');
    expect(stderr).toContain('session-theirs');
    expect(stderr).toContain(ACK_FOREIGN_ENV);
  });
});

describe('a clone that has authored nothing says so instead of guessing', () => {
  // The deliberate limit of reading ownership from local authorship, and the
  // reason the reachability term could not simply be made stricter instead.
  //
  // A fresh clone rewinding work it authored on another machine and a fresh
  // clone rewinding another session's work are the same observation: no local
  // authorship, discarded commits carrying some id. The guard cannot compare
  // against its own id — measured, COPILOT_AGENT_SESSION_ID does not match the
  // trailer the committing agent writes — so this is undecidable rather than
  // merely unimplemented, and the honest answer is the degraded one.
  //
  // It still refuses, and it still prints the commits with their session ids.
  // What it withholds is the claim of a second writer and the
  // PF_PUSH_ACK_FOREIGN instruction, because neither is established.
  let root: string;
  let remote: string;
  let author: string;
  let fresh: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-noauthor-'));
    remote = path.join(root, 'remote.git');
    author = path.join(root, 'author');
    fresh = path.join(root, 'fresh');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, author], root);
    configure(author);
    git(['checkout', '-b', 'feature'], author);
    commit(author, 'base', 'session-base');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], author);
    commit(author, 'work one', 'session-elsewhere');
    commit(author, 'work two', 'session-elsewhere');
    git(['push', '--no-verify', 'origin', 'feature'], author);

    git(['clone', '--branch', 'feature', remote, fresh], root);
    configure(fresh);
    git(['reset', '--hard', 'HEAD~2'], fresh);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], fresh);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses without claiming a second writer', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], fresh);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.unattributed-discard');
    expect(stderr).toContain('cannot');
    // The commits are still shown with their ids: naming what is at risk is
    // not the same as claiming who wrote it.
    expect(stderr).toContain('session-elsewhere');
    // Not asserted: that the verdict is `foreign-session`. Before this change
    // it was, and that is precisely the bug — a clone with no authorship record
    // of its own would tell a lone developer rolling back their own work to
    // acknowledge themselves as a second writer.
    expect(stderr).not.toContain('push-guard.foreign-session');
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
  });
});

describe('rebasing another session\u2019s work forward is not destroying it', () => {
  // Measured at 822c5ed and live: doing exactly what the guard's own refusal
  // tells you to do — "read that work and rebase onto it rather than over it" —
  // was REFUSED as `foreign-session`, naming the session whose every line the
  // push had just preserved. The rewritten copies carry new shas, so the
  // originals fall out of `rev-list live ^local` and were counted destroyed.
  //
  // A false refusal on the did-the-right-thing path is the worst place in the
  // system to put one, and removing the reachability proxy is what exposed it:
  // that proxy had been masking this case by accident, because the rebased
  // copies carried the other session's id back into the owned set. Right answer,
  // wrong reason — which is why it survived until the reason was removed.
  let root: string;
  let mine: string;
  let dropped: string;

  // Each case gets its OWN remote. Sharing one made the second push see a tip
  // the first had just rewritten, so it refused as `unfetched-remote-tip` and
  // the control silently stopped testing what it claimed to.
  const world = (label: string, take: number) => {
    const base = path.join(root, label);
    const remote = path.join(base, 'remote.git');
    const theirs = path.join(base, 'theirs');
    const dir = path.join(base, 'mine');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, theirs], root);
    configure(theirs);
    git(['checkout', '-b', 'feature'], theirs);
    commit(theirs, 'base', 'session-base');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], theirs);
    commit(theirs, 'their one', 'session-theirs');
    commit(theirs, 'their two', 'session-theirs');
    git(['push', '--no-verify', 'origin', 'feature'], theirs);

    git(['clone', '--branch', 'feature', remote, dir], root);
    configure(dir);
    const first = git(['rev-parse', 'HEAD~1'], dir).trim();
    const second = git(['rev-parse', 'HEAD'], dir).trim();
    git(['reset', '--hard', 'HEAD~2'], dir);
    commit(dir, 'mine one', 'session-mine');
    // Replay their work on top of mine. `take` is the one variable: 2 preserves
    // all of it, 1 drops their second commit while preserving the first.
    git(['cherry-pick', ...[first, second].slice(0, take)], dir);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], dir);
    return dir;
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-rebase-'));
    mine = world('preserve-all', 2);
    dropped = world('drop-one', 1);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('allows the push and says why it is not a fast-forward', () => {
    const stderr = pushExpectingSuccess(
      ['push', '--force', 'origin', 'feature'],
      mine,
    );

    expect(stderr).toContain('push-guard.rewrite-preserves-all');
    // Not `fast-forward`: it is not one, and saying so would be exactly the
    // kind of true-sounding false statement this guard exists to stop.
    expect(stderr).not.toContain('push-guard.fast-forward');
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
  });

  it('still refuses when one of their commits is genuinely dropped', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], dropped);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    // The control. Without it, the test above could be satisfied by a guard
    // that had simply stopped looking at the discarded set at all.
    expect(stderr).toContain('push-guard.foreign-session');
    expect(stderr).toContain('session-theirs');
    expect(stderr).toContain('their two');
    // The preserved one is not named, because it is not being destroyed.
    expect(stderr).not.toContain('their one');
  });
});

describe('a dropped merge commit is never counted as preserved', () => {
  // The hazard `.squad/decisions.md` records: two merges seconds apart orphaned
  // a merge commit and dropped ~6000 lines from `development` for hours while CI
  // stayed green. Patch-id equivalence is what lets the guard subtract commits
  // from the destroyed set, so it must not be able to subtract a merge.
  //
  // Measured before relying on it: over a three-commit range containing a merge,
  // `git cherry` printed two lines and omitted the merge entirely. A merge can
  // therefore never enter the preserved set. This test pins that, because it is
  // a property of another program that could change under us.
  let root: string;
  let remote: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-merge-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, work], root);
    configure(work);
    git(['checkout', '-b', 'feature'], work);
    commit(work, 'base', 'session-base');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], work);
    git(['checkout', '-b', 'side'], work);
    commit(work, 'side work', 'session-theirs');
    git(['checkout', 'feature'], work);
    commit(work, 'trunk work', 'session-theirs');
    git(['merge', '--no-ff', '-m', 'merge of side', 'side'], work);
    git(['push', '--no-verify', 'origin', 'feature'], work);

    // Rewrite that reproduces the CONTENT of both parents but loses the merge.
    git(['reset', '--hard', 'HEAD~2'], work);
    commit(work, 'trunk work', 'session-theirs');
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses, naming the merge that would be orphaned', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('merge of side');
    // Not asserted: which refusal code. The point is that the merge is in the
    // destroyed set at all — whether it is reported as foreign or merely
    // unacknowledged depends on authorship, which is a different question and
    // is covered elsewhere.
    expect(stderr).not.toContain('push-guard.rewrite-preserves-all');
  });
});

describe('rebasing your own work does not cost you ownership of it', () => {
  // The passing side of the creation filter, and the case that filter could
  // plausibly break: a rebase rewrites every commit through `rebase (pick)`
  // entries, not `commit` ones. Ownership survives because the rewritten copies
  // carry the same session id as the originals, whose `commit` entries are still
  // in the reflog. That is a prediction with a falsifiable output, so it is
  // tested rather than reasoned — a stricter filter that dropped it would refuse
  // a solo session's rollback of its own rebased branch.
  let root: string;
  let remote: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-rebase-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, work], root);
    configure(work);
    commit(work, 'base', 'session-base');
    git(['push', '--no-verify', '-u', 'origin', 'development'], work);

    git(['checkout', '-b', 'feature'], work);
    commit(work, 'mine one', 'session-mine');
    commit(work, 'mine two', 'session-mine');

    git(['checkout', 'development'], work);
    commit(work, 'upstream moved', 'session-base');
    git(['push', '--no-verify', 'origin', 'development'], work);

    git(['checkout', 'feature'], work);
    git(['rebase', 'development'], work);
    git(['push', '--no-verify', '-u', 'origin', 'feature'], work);

    git(['reset', '--hard', 'HEAD~2'], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses the full rollback as an unacknowledged discard, not as another session', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.unacknowledged-discard');
    expect(stderr).not.toContain('push-guard.foreign-session');
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
  });
});

describe('a solo rollback is not reported as a second writer', () => {
  // B2. The bug lived entirely in `gatherFacts`, which the unit tests bypass by
  // supplying `facts` directly — so this can only be caught through the real
  // hook. `ownSessions` came from `local ^live`, which is empty whenever the
  // local tip is an ancestor of the live tip, and every commit being discarded
  // was then classified as another session's work.
  let root: string;
  let remote: string;
  let work: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-solo-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, work], root);
    configure(work);
    git(['checkout', '-b', 'feature'], work);
    for (const name of ['first', 'second', 'third']) {
      commit(work, name, 'session-solo');
    }
    git(['push', '--no-verify', '-u', 'origin', 'feature'], work);
    git(['reset', '--hard', 'HEAD~1'], work);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], work);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('still refuses, but as an unacknowledged discard rather than a foreign session', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], work);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    // Fail-closed is preserved — the push is destructive and is refused. What
    // changes is that the refusal is true.
    expect(stderr).toContain('push-guard.unacknowledged-discard');
    expect(stderr).not.toContain('push-guard.foreign-session');
    expect(stderr).not.toContain('Two sessions are writing');
    // The specific harm: it must not instruct a lone pusher to acknowledge
    // themselves as a second writer. That is the habit that disarms the real
    // refusal, taught on a push where no second writer existed.
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
    // The commit list is annotated from the reflog, not from the trailer. In
    // this scenario the pusher really did author the discarded commit here, so
    // the honest label is `[created here]` — and it is asserted rather than
    // described, because the previous version of this block explained the
    // annotation in a comment and the annotation was wrong.
    expect(stderr).toContain('[created here]');
    expect(stderr).not.toContain('[session ');
  });

  it('accepts the rollback with the tip acknowledgement alone, no foreign override', () => {
    const live = git(['ls-remote', remote, 'refs/heads/feature'], work).split(
      '\t',
    )[0] as string;

    git(['push', '--force-with-lease', 'origin', 'feature'], work, {
      [ACK_ENV]: live,
    });

    const tip = git(['ls-remote', remote, 'refs/heads/feature'], work).split(
      '\t',
    )[0];
    expect(tip).toBe(git(['rev-parse', 'HEAD'], work));
  });
});

describe('a second session on one branch cannot be force-pushed over', () => {
  let root: string;
  let remote: string;
  let one: string;
  let two: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-'));
    remote = path.join(root, 'remote.git');
    one = path.join(root, 'one');
    two = path.join(root, 'two');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, one], root);
    configure(one);
    git(['checkout', '-b', 'feature'], one);
    commit(one, 'base', 'session-one');
    git(['push', '--no-verify', '-u', 'origin', 'feature'], one);

    git(['clone', remote, two], root);
    configure(two);
    git(['checkout', 'feature'], two);
    commit(two, 'work from the other session', 'session-two');
    git(['push', '--no-verify', 'origin', 'feature'], two);

    // The session-one worktree fetches (as anything running `git fetch` in the
    // background does) but never reads or merges what arrived. This is the step
    // that makes the default lease useless.
    git(['fetch', 'origin'], one);
    commit(one, 'divergent work', 'session-one');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is refused by the hook, naming the other session', () => {
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], one);

    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], one);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.foreign-session');
    expect(stderr).toContain('session-two');

    // Refused means refused: the other session's commit is still the tip.
    const tip = git(['ls-remote', remote, 'refs/heads/feature'], one).split(
      '\t',
    )[0];
    const theirs = git(['rev-parse', 'HEAD'], two);
    expect(tip).toBe(theirs);
  });

  it('succeeds and destroys that commit when the hook is not installed', () => {
    // The counterfactual. Without it, every assertion above is also satisfied
    // by a git that refuses this push on its own — which is precisely what the
    // #78 incident proves it does not do.
    git(['config', '--unset', 'core.hooksPath'], one);

    const theirs = git(['rev-parse', 'HEAD'], two);
    git(['push', '--force-with-lease', 'origin', 'feature'], one);

    const tip = git(['ls-remote', remote, 'refs/heads/feature'], one).split(
      '\t',
    )[0];
    expect(tip).toBe(git(['rev-parse', 'HEAD'], one));
    expect(tip).not.toBe(theirs);
  });

  it('admits the same push once the other session\u2019s tip is acknowledged by both env vars', () => {
    // Reset the remote to the two-writer state and re-run with the guard on.
    git(['push', '--no-verify', '--force', 'origin', 'feature'], two);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], one);
    git(['fetch', 'origin'], one);

    const theirs = git(['rev-parse', 'HEAD'], two);
    git(['push', '--force-with-lease', 'origin', 'feature'], one, {
      [ACK_ENV]: theirs,
      [ACK_FOREIGN_ENV]: 'session-two',
    });

    const tip = git(['ls-remote', remote, 'refs/heads/feature'], one).split(
      '\t',
    )[0];
    expect(tip).toBe(git(['rev-parse', 'HEAD'], one));
  });

  it('refuses a bare --force over commits it has never fetched, naming that specifically', () => {
    // Bare `--force` skips the lease, so git is willing; the remote tip is then
    // an object we do not have, and the destroyed set cannot be enumerated. The
    // guard must say that rather than leak `fatal: bad object` from the
    // enumeration it could not run — a refusal for the right reason and a
    // refusal with a useless message are different outcomes, and this is the
    // two-writer clobber, the most dangerous case the guard exists for.
    commit(two, 'work session one has never fetched', 'session-two');
    git(['push', '--no-verify', '--force', 'origin', 'feature'], two);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], one);

    const theirs = git(['rev-parse', 'HEAD'], two);
    expect(() => git(['cat-file', '-e', `${theirs}^{commit}`], one)).toThrow();

    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force', 'origin', 'feature'], one);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.unfetched-remote-tip');
    expect(stderr).toContain('git fetch');
    expect(stderr).not.toContain('bad object');

    const tip = git(['ls-remote', remote, 'refs/heads/feature'], one).split(
      '\t',
    )[0];
    expect(tip).toBe(theirs);
  });
});

// --- the remedy the guard prints -------------------------------------------

describe('two sessions sharing one brief share one session id', () => {
  // #264. Every foreign-session test above gives the two writers DIFFERENT
  // trailers, and that is the assumption under test rather than a fact about
  // the system. The `Copilot-Session` value reaches a commit through its
  // author's PROMPT, not from the runtime: measured in this repo,
  // COPILOT_AGENT_SESSION_ID is e5a64133-… while the commits that process
  // writes carry b459f162-…. So the id's uniqueness is a property of how many
  // distinct briefs were written, not of how many sessions ran, and two agents
  // handed the same brief emit the same literal with nothing reporting that
  // they have. Measured on development at ce4a7515: one value carries 74
  // commits spanning 37 hours, which no single session runs for.
  //
  // That lands in the fail-open direction, which is the opposite of every other
  // defect this file covers. A shared id makes a genuine second writer classify
  // as yourself: `foreign-session` never fires, and the strongest refusal the
  // guard has is unreachable in the squad's NORMAL case rather than an unusual
  // one. This is the whole scenario of #81 with one literal changed.
  let root: string;
  let remote: string;
  let one: string;
  let two: string;
  const SHARED = 'session-shared';

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-guard-shared-'));
    remote = path.join(root, 'remote.git');
    one = path.join(root, 'one');
    two = path.join(root, 'two');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, one], root);
    configure(one);
    git(['checkout', '-b', 'feature'], one);
    commit(one, 'base', SHARED);
    git(['push', '--no-verify', '-u', 'origin', 'feature'], one);

    // A genuinely separate writer, in a separate clone, that never talks to the
    // first — and carrying the same id, because it was given the same brief.
    git(['clone', remote, two], root);
    configure(two);
    git(['checkout', 'feature'], two);
    commit(two, 'work from the other session', SHARED);
    git(['push', '--no-verify', 'origin', 'feature'], two);

    git(['fetch', 'origin'], one);
    commit(one, 'divergent work', SHARED);
    git(['config', 'core.hooksPath', path.join(repoRoot, HOOKS_PATH)], one);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('still refuses, because ownership is decided by the object and not by what it says about itself', () => {
    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], one);
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.unowned-discard');
    // The refusal must not claim a second writer by NAME here. It cannot see
    // one: the id matches this worktree's own. Saying only what is known — this
    // object was not created here — is the difference between a finding and a
    // guess, and an expired reflog produces the same observation.
    expect(stderr).not.toContain('push-guard.foreign-session');

    const theirs = git(['rev-parse', 'HEAD'], two);
    expect(stderr).toContain(theirs.slice(0, 12));
    expect(stderr).toContain('work from the other session');

    // Refused means refused.
    const tip = git(['ls-remote', remote, 'refs/heads/feature'], one).split(
      '\t',
    )[0];
    expect(tip).toBe(theirs);
  });

  it('cannot be cleared by the tip acknowledgement, which is the pre-fix behaviour', () => {
    // The mutation. Before ownership was read per commit, this exact push was
    // ALLOWED with code `acknowledged-discard` — the tip sha is printed by git
    // itself on any failed push, so it is derivable without reading a line of
    // the other session's work. If a later change reverts ownership to the id
    // set, this assertion is what fails.
    const theirs = git(['rev-parse', 'HEAD'], two);

    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], one, {
          [ACK_ENV]: theirs,
        });
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.unowned-discard');
    expect(
      git(['ls-remote', remote, 'refs/heads/feature'], one).split('\t')[0],
    ).toBe(theirs);
  });

  it('cannot be cleared by naming the shared id, which the pusher holds already', () => {
    // The id is on this session's OWN commits, so supplying it is evidence of
    // nothing. Accepting it would rebuild the hole one layer up: the refusal
    // would be clearable by a token the operator can read off their own log.
    const theirs = git(['rev-parse', 'HEAD'], two);

    let stderr = '';
    expect(() => {
      try {
        git(['push', '--force-with-lease', 'origin', 'feature'], one, {
          [ACK_ENV]: theirs,
          [ACK_FOREIGN_ENV]: SHARED,
        });
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? '');
        throw error;
      }
    }).toThrow();

    expect(stderr).toContain('push-guard.unowned-discard');
    // The commit being destroyed was authored in the other worktree, so the
    // hook's own commit list must say so. Under the trailer label this line
    // printed `[session <SHARED>]` — the pusher's own id, against another
    // writer's work, in the list they are told to read before deciding it is
    // obsolete. Asserting the id is ABSENT is the load-bearing half: a
    // correct-looking label is what makes a wrong one dangerous.
    expect(stderr).toContain('[NOT created here]');
    expect(stderr).not.toContain(`[session ${SHARED}]`);
    expect(
      git(['ls-remote', remote, 'refs/heads/feature'], one).split('\t')[0],
    ).toBe(theirs);
  });

  it('admits the push once the destroyed commit is named by sha', () => {
    // The opposite horn, and the one that keeps this a control rather than a
    // wall. A sha cannot be transcribed from a brief and is not printed by the
    // failed push, so naming it requires having looked at the commit — which is
    // the property the shared id destroyed and the only thing being asked for.
    const theirs = git(['rev-parse', 'HEAD'], two);

    git(['push', '--force-with-lease', 'origin', 'feature'], one, {
      [ACK_ENV]: theirs,
      [ACK_FOREIGN_ENV]: theirs,
    });

    const tip = git(['ls-remote', remote, 'refs/heads/feature'], one).split(
      '\t',
    )[0];
    expect(tip).toBe(git(['rev-parse', 'HEAD'], one));
    expect(tip).not.toBe(theirs);
  });
});

// --- the remedy the guard prints -------------------------------------------
//
// `npm run push:force` is the command every refusal above tells the operator to
// run. It was the most-followed path in the system and had exactly one
// assertion against it: that package.json mentions its NAME. Nothing executed a
// line of it. Coverage was inversely correlated with stakes.
//
// Two defects were sitting in it, and the first hid the second.
//
//   D1  Its own `git()` pinned cwd to the directory above the script, while the
//       helpers it imports from push-guard.mjs set no cwd and so inherit
//       process.cwd(). Two halves of one script reading two different
//       repositories. Measured by running it with cwd set to a scratch repo: it
//       printed `jpapiez-squad-81-force-push-guard does not exist on origin` —
//       the branch name from THIS worktree, the remote lookup from the scratch
//       one. An answer about a pair that exists nowhere.
//
//   D2  It counted `rev-list live ^local` as destruction and subtracted no
//       patch-equivalent commits. So a rebase that carried every line forward
//       was announced as `DESTROYS 1 commit(s)` and refused, while the guard
//       behind it returned `rewrite-preserves-all` and allowed. The guard was
//       fixed for precisely this at 822c5ed; the remedy it prints was not.
//
// D2 is the serious one. The operator arrives here BECAUSE the guard refused,
// under time pressure, having been told this is the way through — and for doing
// exactly the right thing the script offered them only `--yes`. A remedy that
// refuses the correct action and teaches the override as routine is worse than
// no remedy, and it trains away the habit the guard is trying to build.
//
// D1 hid D2: pointed at a fixture the script answered about the wrong repo and
// never reached the counting. That ordering is why the coverage gap and the
// bugs are one finding rather than two.

describe('the label beside a destroyed commit answers who made it', () => {
  const sha = 'a'.repeat(40);
  const other = 'b'.repeat(40);

  it('claims a commit only when this worktree’s reflog shows it being created', () => {
    expect(originLabel(sha, new Set([sha]), true)).toBe('[created here]');
  });

  it('names a commit the reflog does not account for as another writer’s', () => {
    expect(originLabel(sha, new Set([other]), true)).toBe('[NOT created here]');
  });

  it('separates “not yours” from “I could not tell”', () => {
    // The whole reason the third state exists. Both calls below have an empty
    // owned set; only the evidence flag differs, and it must change the answer.
    expect(originLabel(sha, new Set(), true)).toBe('[NOT created here]');
    expect(originLabel(sha, new Set(), false)).toBe('[origin unverifiable]');
  });

  it('still claims the operator’s own work when the reflog was readable', () => {
    // Guards the direction that would make the degraded path noisy: absence of
    // evidence must not override present evidence.
    expect(originLabel(sha, new Set([sha]), false)).toBe('[created here]');
  });

  it('never prints a session trailer, which is a brief and not a writer', () => {
    for (const attributable of [true, false]) {
      for (const owned of [new Set([sha]), new Set<string>()]) {
        expect(originLabel(sha, owned, attributable)).not.toContain('session');
      }
    }
  });
});

describe('the remedy the guard prints is itself exercised', () => {
  const script = path.join(repoRoot, 'scripts', 'safe-force-push.mjs');
  let root: string;
  let remote: string;
  let work: string;
  let base: string;

  const runForce = (args: string[], cwd: string) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env },
    });

  const remoteTip = () =>
    git(['ls-remote', remote, 'refs/heads/feature'], work).split('\t')[0];

  /** Their work, published, then thrown away locally. Returns their sha. */
  function publishTheirWork() {
    commit(work, 'their feature', 'session-two');
    const theirs = git(['rev-parse', 'HEAD'], work);
    git(['push', '--no-verify', 'origin', 'feature'], work);
    git(['reset', '--hard', base], work);
    return theirs;
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'push-force-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');

    git(['init', '--bare', '--initial-branch=development', remote], root);
    git(['clone', remote, work], root);
    configure(work);
    git(['checkout', '-b', 'feature'], work);
    commit(work, 'base', 'session-one');
    base = git(['rev-parse', 'HEAD'], work);
    git(['push', '--no-verify', '-u', 'origin', 'feature'], work);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the branch from the repository it is invoked in, not the one it lives in', () => {
    // D1. The discriminator is the fixture's own remote tip: only a script
    // reading THIS repository can print that sha against that branch.
    //
    // The first version of this test asserted the ambient worktree's branch name
    // was absent from the output, and it passed locally and failed on both CI
    // platforms. CI checks out a detached HEAD, so `rev-parse --abbrev-ref HEAD`
    // there is the literal string `HEAD`, which legitimately appears in the
    // script's own `HEAD:refs/heads/feature` refspec. The precondition I had
    // written guarded against the ambient branch being called `feature` and not
    // against it failing to be a branch name at all — a degenerate value I did
    // not think of, waved through by a check that looked like it covered this.
    //
    // Pinning the sha removes the dependency on the ambient checkout entirely
    // rather than special-casing the detached state, and it is the stronger
    // assertion: a wrong-repository read cannot produce this value by accident.
    const tip = remoteTip();
    expect(tip).toMatch(/^[0-9a-f]{40}$/);

    const result = runForce([], work);

    expect(result.stdout).toContain(`origin/feature is at ${tip}`);
    expect(result.status).toBe(0);
  });

  it('does not report a rebase that carried every line forward as destruction', () => {
    // D2, and the case the guard's own refusal asks the operator to produce.
    const theirs = publishTheirWork();
    commit(work, 'my feature', 'session-one');
    git(['cherry-pick', theirs], work);
    const local = git(['rev-parse', 'HEAD'], work);

    // Precondition: the arm has to differ from the discard arm below. If the
    // cherry-pick stopped producing an equivalent this test would pass for
    // having nothing to preserve rather than for preserving it.
    expect(git(['cherry', local, theirs], work)).toMatch(/^- /);

    const result = runForce([], work);

    expect(result.stdout).toContain('carried forward, not destroyed');
    expect(result.stdout).toContain('nothing would be destroyed');
    // The discriminator: not merely "it proceeded", but that it did not reach
    // the destruction wording at all. A script that printed both would still be
    // teaching the operator that their correct rebase destroyed something.
    expect(result.stdout).not.toContain('DESTROYS');
    expect(result.stderr).not.toContain('refusing');
    expect(result.status).toBe(0);
    expect(remoteTip()).toBe(local);
  });

  it('still refuses a genuine discard, and leaves the remote where it was', () => {
    // The other horn. If the subtraction above were applied too widely this is
    // the test that fails, so the pair pins the boundary rather than one side.
    const theirs = publishTheirWork();
    commit(work, 'my replacement', 'session-one');
    const local = git(['rev-parse', 'HEAD'], work);

    // Precondition and discriminator against the arm above: no patch-equivalent
    // exists here, so this work is genuinely destroyed.
    expect(git(['cherry', local, theirs], work)).toMatch(/^\+ /);

    const result = runForce([], work);

    expect(result.stdout).toContain('DESTROYS 1 commit(s)');
    // This used to assert `session-two` — the destroyed commit's
    // `Copilot-Session` trailer, printed as `[session …]`. That label is gone:
    // the trailer names a brief, not a writer, so it can print the pusher's own
    // id against another writer's work. See `originLabel`.
    expect(result.stdout).not.toContain('[session ');
    // `publishTheirWork` commits in THIS worktree before resetting, so the
    // reflog correctly records it as created here. That is a property of the
    // harness, not of the scenario, and it is exactly the confounder
    // `push-guard.mjs` documents against its reflog table — which is why the
    // foreign case below authors in a separate clone instead of reusing this.
    expect(result.stdout).toContain('[created here]');
    expect(result.stdout).not.toContain('carried forward');
    expect(result.stderr).toContain('refusing');
    expect(result.status).toBe(1);
    expect(remoteTip()).toBe(theirs);
  });

  it('names another writer’s commit as NOT created here when it arrived only by fetch', () => {
    // The scenario the label exists for, and the one the trailer cannot serve.
    // Their work is authored in a SEPARATE clone and reaches this worktree only
    // by fetch, so no entry in this reflog can have produced that sha.
    const theirClone = path.join(root, 'theirs');
    git(['clone', '--branch', 'feature', remote, theirClone], root);
    configure(theirClone);
    // Deliberately the SAME trailer value this worktree commits under. That is
    // what a shared brief looks like, and it is the case the old `[session …]`
    // label got backwards: it would have printed the pusher's own id here.
    commit(theirClone, 'their feature', 'session-one');
    const theirs = git(['rev-parse', 'HEAD'], theirClone);
    git(['push', '--no-verify', 'origin', 'feature'], theirClone);

    git(['fetch', 'origin'], work);
    commit(work, 'my replacement', 'session-one');
    const local = git(['rev-parse', 'HEAD'], work);

    // Precondition, and the reason this test is not vacuous: the trailer is
    // identical on both sides, so any label derived from it must call their
    // commit ours. Only the reflog can separate them.
    expect(git(['log', '-1', '--format=%B', theirs], work)).toContain(
      'Copilot-Session: session-one',
    );
    expect(git(['log', '-1', '--format=%B', local], work)).toContain(
      'Copilot-Session: session-one',
    );

    const result = runForce([], work);

    expect(result.stdout).toContain('DESTROYS 1 commit(s)');
    expect(result.stdout).toContain('[NOT created here]');
    // `[created here]` is not a substring of `[NOT created here]`, so this is a
    // real discriminator and not a tautology.
    expect(result.stdout).not.toContain('[created here]');
    expect(result.status).toBe(1);
    expect(remoteTip()).toBe(theirs);
  });

  it('reports the origin as unverifiable, not as foreign, when there is no reflog', () => {
    const theirs = publishTheirWork();
    commit(work, 'my replacement', 'session-one');

    // Remove the evidence the label is drawn from. The tempting repair is to
    // let absence read as "NOT created here", and it is the original defect
    // with the sign flipped: an unreadable reflog would then accuse every
    // commit including the operator's own, and a warning that fires on
    // everything is how an override becomes routine.
    git(['config', 'core.logAllRefUpdates', 'false'], work);
    rmSync(path.join(work, '.git', 'logs'), { recursive: true, force: true });

    const result = runForce([], work);

    expect(result.stdout).toContain('DESTROYS 1 commit(s)');
    expect(result.stdout).toContain('[origin unverifiable]');
    expect(result.stdout).not.toContain('[NOT created here]');
    expect(result.stdout).not.toContain('[created here]');
    // Losing the evidence must not lose the refusal.
    expect(result.status).toBe(1);
    expect(remoteTip()).toBe(theirs);
  });

  it('proceeds with --yes, which is the only way past a genuine discard', () => {
    const theirs = publishTheirWork();
    commit(work, 'my replacement', 'session-one');
    const local = git(['rev-parse', 'HEAD'], work);

    const result = runForce(['--yes'], work);

    expect(result.stdout).toContain('DESTROYS 1 commit(s)');
    expect(result.status).toBe(0);
    expect(remoteTip()).toBe(local);
    expect(remoteTip()).not.toBe(theirs);
  });

  it('refuses a protected branch before it touches the remote at all', () => {
    git(['checkout', '-B', 'development'], work);

    const result = runForce([], work);

    expect(`${result.stdout}${result.stderr}`).toContain(
      'does not take direct pushes',
    );
    expect(result.status).toBe(1);
  });

  it('rejects an unknown flag rather than silently ignoring it', () => {
    // `--force` is the flag muscle memory reaches for, and silently ignoring it
    // would mean the operator believes they passed something they did not.
    const result = runForce(['--force'], work);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown argument: --force');
  });
});
