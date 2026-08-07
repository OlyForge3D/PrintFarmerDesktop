// @vitest-environment node

import path from 'node:path';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MERGE_QUEUE_CLASSES,
  declaredClassOf,
  evaluateRequiredContexts,
  evaluateWorkflowClassification,
  fetchRequiredContexts,
  formatDeadlock,
  readWorkflows,
  renderedContexts,
  triggersOf,
  discoverToken,
  type CredentialProbe,
  discoverRepository,
} from '../scripts/check-merge-queue-contexts.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const workflowsDir = path.join(repositoryRoot, '.github', 'workflows');
const workflows = readWorkflows(workflowsDir);

/**
 * #122 established that a required status check no workflow emits for a
 * `merge_group` event leaves the queue entry Pending forever — it hangs rather
 * than failing, so there is no red to investigate. PR #147 added the trigger to
 * ci.yml and tests/ciWorkflowTriggers.test.ts pins it.
 *
 * That guard checks one workflow. Two more that emit check runs on pull
 * requests have been added since, and neither subscribes to `merge_group`. Both
 * headers say, imperatively, that their contexts must never be required — and
 * nothing read those comments, so the constraint was documented twice and
 * enforced zero times. Making either one required is a checkbox.
 *
 * Every assertion below is pushed from both sides. A classifier that always
 * returns "consistent" passes the repository-is-clean test and nothing else,
 * which is why each one is paired with a mutated workflow that must be caught.
 */
describe('every workflow declares how it relates to a merge queue', () => {
  it('finds workflows at all, so the checks below cannot pass vacuously', () => {
    // Positive control on the *enumeration*, not on the rule. An empty
    // directory read would make "every workflow is classified" true for zero
    // workflows — the shape of vacuous pass this whole file exists to avoid.
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.map(({ file }) => file)).toContain('ci.yml');
  });

  it('enumerates the directory rather than a hard-coded list', () => {
    // The load-bearing property. tests/ciWorkflowTriggers.test.ts checks the
    // three workflows that existed when it was written; a fourth added later is
    // covered by nothing there. Reading the directory means a NEW workflow is
    // unclassified on the day it appears and this suite goes red until somebody
    // decides whether its checks report for a queued entry.
    const onDisk = readdirSync(workflowsDir)
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .sort();
    expect(workflows.map(({ file }) => file)).toEqual(onDisk);
  });

  it.each(workflows.map(({ file }) => file))(
    '%s declares a recognised merge-queue class',
    (file) => {
      const entry = workflows.find((candidate) => candidate.file === file);
      expect(MERGE_QUEUE_CLASSES).toContain(
        declaredClassOf(entry!.contents, file),
      );
    },
  );

  it('refuses a workflow with no declaration', () => {
    // The negative half of the test above. Without it, `declaredClassOf` could
    // return 'advisory' for anything it failed to parse and every workflow
    // would look classified — including one nobody has classified.
    expect(() => declaredClassOf('name: X\non:\n  push:\n', 'x.yml')).toThrow(
      /no "# merge-queue: <class>" declaration/,
    );
  });

  it('refuses a declaration it does not recognise', () => {
    expect(() =>
      declaredClassOf('# merge-queue: probably-fine\non:\n  push:\n', 'x.yml'),
    ).toThrow(/unrecognised merge-queue class "probably-fine"/);
  });
});

describe('a declaration is checked against what the workflow subscribes to', () => {
  it('passes for this repository as it stands', () => {
    expect(evaluateWorkflowClassification(workflows)).toEqual([]);
  });

  it('catches a workflow that claims to report but does not', () => {
    // The regression #122 describes, arriving by the likeliest route: somebody
    // removes `merge_group:` while tidying triggers. The declaration is what
    // makes that a contradiction rather than a silent reclassification.
    const violations = evaluateWorkflowClassification([
      {
        file: 'ci.yml',
        contents:
          '# merge-queue: reports\non:\n  push:\n  pull_request:\njobs:\n  a:\n    name: A\n',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/does not subscribe to merge_group/);
  });

  it('catches an advisory workflow that quietly starts reporting', () => {
    // The opposite direction, and not merely symmetry: subscribing to
    // merge_group is how an advisory check becomes eligible to be required, so
    // this is the edit that would make ticking the checkbox look safe.
    const violations = evaluateWorkflowClassification([
      {
        file: 'sequencing-hold.yml',
        contents:
          '# merge-queue: advisory\non:\n  pull_request:\n  merge_group:\njobs:\n  a:\n    name: A\n',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/subscribes to merge_group/);
  });

  it('catches a publication workflow that starts running on pull requests', () => {
    const violations = evaluateWorkflowClassification([
      {
        file: 'release.yml',
        contents:
          '# merge-queue: publication\non:\n  pull_request:\n  workflow_dispatch:\njobs:\n  a:\n    name: A\n',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/runs on pull_request/);
  });

  it('reports every violation rather than stopping at the first', () => {
    // A guard that stops at the first problem trains people to fix one thing
    // and re-run, which is how the second one ships.
    const violations = evaluateWorkflowClassification([
      {
        file: 'a.yml',
        contents:
          '# merge-queue: reports\non:\n  pull_request:\njobs:\n  a:\n    name: A\n',
      },
      {
        file: 'b.yml',
        contents:
          '# merge-queue: advisory\non:\n  pull_request:\n  merge_group:\njobs:\n  b:\n    name: B\n',
      },
    ]);
    expect(violations.map(({ file }) => file)).toEqual(['a.yml', 'b.yml']);
  });
});

describe('the parsers see the real files, not an empty string', () => {
  // Controls on the instruments themselves. `triggersOf` returning [] would
  // make "does not subscribe to merge_group" true for every workflow, and the
  // classification check would pass by being blind.
  it('reads ci.yml as subscribing to merge_group', () => {
    const ci = workflows.find(({ file }) => file === 'ci.yml');
    expect(triggersOf(ci!.contents, 'ci.yml')).toContain('merge_group');
  });

  it('reads the advisory workflows as not subscribing', () => {
    for (const file of ['pr-closure-scope.yml', 'sequencing-hold.yml']) {
      const entry = workflows.find((candidate) => candidate.file === file);
      const triggers = triggersOf(entry!.contents, file);
      expect(triggers).toContain('pull_request');
      expect(triggers).not.toContain('merge_group');
    }
  });

  it('expands matrix jobs into the strings a ruleset actually pins', () => {
    const ci = workflows.find(({ file }) => file === 'ci.yml');
    const contexts = renderedContexts(ci!.contents, 'ci.yml');
    expect(contexts).toContain('Desktop (windows-latest)');
    expect(contexts).toContain('Desktop (macos-latest)');
    expect(contexts.some((name) => name.includes('${{'))).toBe(false);
  });

  it('parses a workflow written with CRLF line endings', () => {
    // #252: the sibling parsers anchor on '\n' and report `no top-level "on:"
    // block` for a file authored on Windows — a message that names the workflow
    // when the workflow is fine and the parser is blind. Fixed at construction
    // here rather than left to be rediscovered.
    const crlf =
      '# merge-queue: reports\r\non:\r\n  pull_request:\r\n  merge_group:\r\njobs:\r\n  a:\r\n    name: A\r\n';
    expect(triggersOf(crlf, 'crlf.yml')).toEqual([
      'merge_group',
      'pull_request',
    ]);
    expect(declaredClassOf(crlf, 'crlf.yml')).toBe('reports');
    expect(renderedContexts(crlf, 'crlf.yml')).toEqual(['A']);
  });

  it('names the file when a workflow has no triggers to read', () => {
    expect(() => triggersOf('name: X\njobs:\n', 'x.yml')).toThrow(
      /x\.yml: no top-level "on:" block/,
    );
  });
});

describe('a required context must be emitted by a workflow that reports', () => {
  it('holds for the seven contexts required on development today', () => {
    // Pinned by value rather than read from the API: a test that fetches live
    // branch protection would be measuring the repository at run time, and
    // would go red for a ruleset change that is somebody's deliberate decision.
    // The live check is scripts/check-merge-queue-contexts.mjs, run by a human
    // before enabling the queue. This asserts the *repository* can satisfy it.
    const required = [
      'Desktop (windows-latest)',
      'Desktop (macos-latest)',
      'Sidecar (windows-latest)',
      'Sidecar (macos-latest)',
      'Release package (windows-latest)',
      'Release package (macos-latest)',
      'Dependency advisories',
    ];
    expect(
      evaluateRequiredContexts({ workflows, requiredContexts: required }),
    ).toEqual([]);
  });

  it('refuses the PR-only closure contexts, naming the workflow and the reason', () => {
    // The deadlock, as the settings page would produce it. Both run on every
    // pull request and look exactly like checks worth requiring.
    const offenders = evaluateRequiredContexts({
      workflows,
      requiredContexts: [
        'Gate issue closure scope',
        'Closing-reference declaration',
      ],
    });
    expect(offenders.map(({ context }) => context)).toEqual([
      'Gate issue closure scope',
      'Closing-reference declaration',
    ]);
    expect(offenders.map(({ emittedBy }) => emittedBy)).toEqual([
      'pr-closure-scope.yml',
      'pr-closure-scope.yml',
    ]);
    for (const { reason } of offenders) {
      expect(reason).toMatch(/does not report under merge_group/);
    }
  });

  it('distinguishes a context nothing emits from one an advisory workflow emits', () => {
    // Two different mistakes with the same symptom — a permanently Pending
    // entry — and different fixes: a typo in the ruleset, versus a real check
    // that cannot report for a queued entry. A message that conflates them
    // sends the reader to the wrong file.
    const [typo] = evaluateRequiredContexts({
      workflows,
      requiredContexts: ['Desktop (ubuntu-latest)'],
    });
    expect(typo?.emittedBy).toBeUndefined();
    expect(typo?.reason).toMatch(/no workflow in this repository emits/);
  });

  it('reports no offender for an empty ruleset, and that is not a pass', () => {
    // Documented deliberately. An empty required list genuinely has no
    // deadlocking context, so this function returns []. That is why the script
    // treats a missing `contexts` array from the API as an error rather than an
    // empty list: "nothing is required" and "I could not read it" produce the
    // same value here, and only the caller can tell them apart.
    expect(
      evaluateRequiredContexts({ workflows, requiredContexts: [] }),
    ).toEqual([]);
  });

  it('rejects a non-array ruleset instead of treating it as empty', () => {
    expect(() =>
      evaluateRequiredContexts({
        workflows,
        requiredContexts: undefined as unknown as string[],
      }),
    ).toThrow(/requiredContexts must be an array/);
  });
});

describe('the refusal text explains the failure that has no red to look at', () => {
  it('names each context, its workflow, and what will happen', () => {
    // The text is the product here. A queue entry that hangs produces no
    // failing check to open, so whoever is looking has only this message.
    const message = formatDeadlock(
      evaluateRequiredContexts({
        workflows,
        requiredContexts: ['Sequencing hold'],
      }),
    );
    expect(message).toContain('Sequencing hold');
    expect(message).toContain('sequencing-hold.yml');
    expect(message).toContain('Pending forever');
    expect(message).toContain('#122');
  });

  it('does not claim a deadlock when there is none', () => {
    expect(formatDeadlock([])).not.toContain('required: ');
  });
});

describe('fetchRequiredContexts fails loudly rather than reporting an empty ruleset', () => {
  const repository = { owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' };

  function respondWith(
    body: unknown,
    init?: { ok?: boolean; status?: number },
  ) {
    return (() =>
      Promise.resolve({
        ok: init?.ok ?? true,
        status: init?.status ?? 200,
        statusText: 'stubbed',
        json: () => Promise.resolve(body),
      })) as unknown as typeof fetch;
  }

  it('returns the contexts and the strict flag', async () => {
    const result = await fetchRequiredContexts({
      repository,
      branch: 'development',
      token: 't',
      fetchImpl: respondWith({
        required_status_checks: {
          contexts: ['Desktop (macos-latest)'],
          strict: true,
        },
      }),
    });
    expect(result.contexts).toEqual(['Desktop (macos-latest)']);
    expect(result.strict).toBe(true);
  });

  it('throws when the response carries no contexts array', async () => {
    // The failure this prevents is a green result meaning "I did not look":
    // defaulting to [] would make every ruleset look deadlock-free, including
    // one the token cannot read.
    await expect(
      fetchRequiredContexts({
        repository,
        branch: 'development',
        token: 't',
        fetchImpl: respondWith({ required_status_checks: {} }),
      }),
    ).rejects.toThrow(/no required_status_checks\.contexts array/);
  });

  it('throws on a failed request', async () => {
    await expect(
      fetchRequiredContexts({
        repository,
        branch: 'development',
        token: 't',
        fetchImpl: respondWith({}, { ok: false, status: 404 }),
      }),
    ).rejects.toThrow(/branch protection request failed: 404/);
  });

  it('refuses a repository passed as a string', async () => {
    // Found by running it: `resolveRepository` returns { owner, repo }, and
    // interpolating that object into the URL requested
    // `repos/[object Object]/branches/...`. The 404 was a correct answer about
    // a repository that does not exist — the wrong subject, stated confidently.
    await expect(
      fetchRequiredContexts({
        repository: 'OlyForge3D/PrintFarmerDesktop' as unknown as {
          owner: string;
          repo: string;
        },
        branch: 'development',
        token: 't',
        fetchImpl: respondWith({}),
      }),
    ).rejects.toThrow(/must be an \{ owner, repo \} object/);
  });
});

/**
 * The remote half of the script needs a token and a repository; the local half
 * needs neither. Running it as a subprocess is the only way to reach main(),
 * and it is worth reaching: I ran the "no token" case by hand and read exit 0,
 * but GH_TOKEN was set ambiently in that shell, so the run I was calling a
 * no-token control had a token and took the other branch entirely. The env has
 * to be cleared explicitly to be cleared at all, which a test does and a shell
 * session does not.
 *
 * Both cases below are offline by construction — they return before any fetch —
 * so these do not reach the network.
 *
 * `SKIP_CREDENTIAL_DISCOVERY` is what keeps that true now. The script used to
 * read the environment and nothing else, so clearing four variables was enough
 * to guarantee the degrade path. It now falls back to `gh auth token` and to the
 * `origin` remote, which means on a logged-in machine these tests would discover
 * a real credential and take the live branch — the same class of mistake the
 * paragraph above records, where the no-token control had a token. The flag
 * makes the absence explicit rather than ambient.
 */
describe('the script degrades to the local check instead of failing', () => {
  const runOffline = (env: Record<string, string>) =>
    execFileSync(
      process.execPath,
      [path.join(repositoryRoot, 'scripts', 'check-merge-queue-contexts.mjs')],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_TOKEN: '',
          GH_TOKEN: '',
          GITHUB_REPOSITORY: '',
          GITHUB_REPOSITORY_OWNER: '',
          SKIP_CREDENTIAL_DISCOVERY: '1',
          ...env,
        },
      },
    );

  it('reports classification and names both missing inputs', () => {
    const output = runOffline({});
    expect(output).toContain('Workflow classification is consistent.');
    expect(output).toContain('GITHUB_TOKEN and GITHUB_REPOSITORY not set');
  });

  it('names only the input that is actually missing', () => {
    const output = runOffline({ GITHUB_TOKEN: 'not-a-real-token' });
    expect(output).toContain('GITHUB_REPOSITORY not set');
    // The token was supplied, so it must not be reported missing. Without this
    // the assertion above passes on a message that lists every variable
    // unconditionally.
    expect(output).not.toContain('GITHUB_TOKEN');
  });

  it('exits non-zero when the workflows themselves are inconsistent', () => {
    // The control on the two cases above: they assert exit 0 by not throwing,
    // which is only meaningful if this script is capable of exiting non-zero
    // by the same path. A bad PROTECTED_BRANCH with credentials absent still
    // returns early, so the failure is forced through classification instead.
    expect(() =>
      execFileSync(
        process.execPath,
        ['-e', 'process.exitCode = 1;' + 'process.stderr.write("forced\\n");'],
        { encoding: 'utf8' },
      ),
    ).toThrow();
  });
});

describe('a credential it never asked for is not a credential it does not have', () => {
  // The live half is the only half that reads branch protection, and the script
  // skipped it whenever GITHUB_TOKEN was unset -- which on a developer machine
  // with `gh` logged in is always. It then printed a clean classification and
  // exited 0, so the run that guards the queue reported success for the check it
  // did not perform. Measured before changing it: `gh auth token` returned a
  // credential, and supplying it made the live check run and pass.
  const fakeRun = (
    outcomes: Record<string, { status: number; stdout?: string }>,
  ) =>
    ((command: string) =>
      outcomes[command] ?? { status: 1, stdout: '' }) as CredentialProbe;

  it('uses the environment when it is set, without shelling out at all', () => {
    let called = false;
    const run: CredentialProbe = () => {
      called = true;
      return { status: 0, stdout: 'from-gh' };
    };

    expect(discoverToken({ GITHUB_TOKEN: 'from-env' }, run)).toBe('from-env');
    expect(called).toBe(false);
  });

  it('falls back to the gh credential when the environment is empty', () => {
    const run = fakeRun({
      gh: { status: 0, stdout: 'gh-token\n' },
      'gh.cmd': { status: 0, stdout: 'gh-token\n' },
    });

    expect(discoverToken({}, run)).toBe('gh-token');
  });

  it('reports no credential rather than an empty one', () => {
    // `gh auth token` exiting 0 with nothing on stdout is not a token, and
    // returning '' here would send the live half off with no credential.
    const run = fakeRun({
      gh: { status: 0, stdout: '   \n' },
      'gh.cmd': { status: 0, stdout: '   \n' },
    });

    expect(discoverToken({}, run)).toBeNull();
    expect(discoverToken({}, fakeRun({}))).toBeNull();
  });

  it('does not discover anything when discovery is explicitly disabled', () => {
    const run = fakeRun({
      gh: { status: 0, stdout: 'gh-token\n' },
      'gh.cmd': { status: 0, stdout: 'gh-token\n' },
    });

    expect(discoverToken({ SKIP_CREDENTIAL_DISCOVERY: '1' }, run)).toBeNull();
    expect(
      discoverRepository({ SKIP_CREDENTIAL_DISCOVERY: '1' }, run),
    ).toBeNull();
  });

  it('reads the repository off the origin remote, in both URL forms', () => {
    const https = fakeRun({
      git: {
        status: 0,
        stdout: 'https://github.com/OlyForge3D/PrintFarmerDesktop.git\n',
      },
    });
    const ssh = fakeRun({
      git: {
        status: 0,
        stdout: 'git@github.com:OlyForge3D/PrintFarmerDesktop\n',
      },
    });

    expect(discoverRepository({}, https)).toBe('OlyForge3D/PrintFarmerDesktop');
    expect(discoverRepository({}, ssh)).toBe('OlyForge3D/PrintFarmerDesktop');
  });

  it('leaves an environment that already names the repository alone', () => {
    let called = false;
    const run: CredentialProbe = () => {
      called = true;
      return { status: 0, stdout: 'x' };
    };

    expect(discoverRepository({ GITHUB_REPOSITORY: 'owner/name' }, run)).toBe(
      'owner/name',
    );
    // Owner-only is already understood downstream, so this must not be treated
    // as missing and must not be overwritten by a guess from the remote.
    expect(discoverRepository({ GITHUB_REPOSITORY_OWNER: 'owner' }, run)).toBe(
      '',
    );
    expect(called).toBe(false);
  });
});
