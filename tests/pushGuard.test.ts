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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACK_ENV,
  ACK_FOREIGN_ENV,
  PROTECTED_REFS,
  ZERO_SHA,
  evaluateRefUpdate,
  parseStdin,
} from '../scripts/push-guard.mjs';
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
    discarded: [],
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
    pushedSessions: ['8dd289e7'],
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
        pushedSessions: ['8dd289e7'],
        ack: THEIRS,
      }),
    );

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
});

describe('the guard checks the pusher\u2019s belief, not only git\u2019s cache of it', () => {
  const discarding = facts({
    discarded: [{ sha: THEIRS, subject: 'work nobody read', sessions: [] }],
    pushedSessions: [],
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

    const acknowledged = evaluateRefUpdate(
      update({ localSha: ZERO_SHA }),
      facts({ discarded: everything, ack: THEIRS }),
    );
    expect(acknowledged.verdict).toBe('allow');
    expect(acknowledged.code).toBe('push-guard.acknowledged-delete');
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

function configure(cwd: string) {
  git(['config', 'user.email', 'guard@test.local'], cwd);
  git(['config', 'user.name', 'Guard Test'], cwd);
  git(['config', 'commit.gpgsign', 'false'], cwd);
}

describe('a solo rollback is not reported as a second writer', () => {
  // B2. The bug lived entirely in `gatherFacts`, which the unit tests bypass by
  // supplying `facts` directly — so this can only be caught through the real
  // hook. `pushedSessions` came from `local ^live`, which is empty whenever the
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
    expect(stderr).not.toContain('another session');
    // The specific harm: it must not instruct a lone pusher to acknowledge
    // themselves as a second writer. That is the habit that disarms the real
    // refusal, taught on a push where no second writer existed.
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
    // Not asserted: that the session id is absent entirely. The refusal does
    // annotate the discarded commit with `[session session-solo]`, which is
    // true and useful. The defect was the *claim* that it belonged to someone
    // else, not the mention.
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
