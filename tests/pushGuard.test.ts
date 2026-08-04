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
  evaluateRefUpdate,
  isAncestor,
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
    liveQueryFailed: false,
    liveQueryError: '',
    provablyFastForward: null,
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
    ownSessions: ['8dd289e7'],
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
    expect(stderr).not.toContain('another session');
    expect(stderr).not.toContain(ACK_FOREIGN_ENV);
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
    expect(stderr).toContain('another session');
    expect(stderr).toContain('session-theirs');
    expect(stderr).toContain(ACK_FOREIGN_ENV);
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
