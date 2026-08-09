// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ClosingIssuesIndeterminateError,
  EXPECTED_PROTECTED_GATE_ISSUE_COUNT,
  PROTECTED_GATE_ISSUES,
  PROTECTED_LABELS,
  collectArmedCommitReferences,
  evaluateClosureScope,
  extractArmedIssueNumbers,
  fetchClosingIssues,
  fetchIssuesByNumber,
  fetchPullRequestCommits,
  formatCommitViolations,
  formatViolations,
  resolveClosingIssuesConfidently,
  resolvePullRequestNumber,
  resolveRepository,
} from '../scripts/check-pr-closure-scope.mjs';
import type { ClosingIssue } from '../scripts/check-pr-closure-scope.mjs';
import { invokedScripts } from '../scripts/check-body-edit-triggers.mjs';

const CHILD_ISSUE: ClosingIssue = {
  number: 161,
  title: 'Pin the calibration capability rollout order in a runbook',
  labels: ['documentation', 'desktop', 'squad', 'squad:ripley'],
};

// #57 is deliberately modelled without the `epic` label, because that is the
// state it is actually in. See the counterfactual test below.
const GATE_57: ClosingIssue = {
  number: 57,
  title: 'Harden the Printer Calibration release',
  labels: ['documentation', 'enhancement', 'desktop', 'squad', 'squad:ripley'],
};

const EPIC_42: ClosingIssue = {
  number: 42,
  title: 'Epic: First-class Printer Calibration in PrintFarmer',
  labels: ['enhancement', 'epic', 'desktop', 'squad', 'squad:ripley'],
};

describe('protected gate list', () => {
  it('is pinned, so adding or dropping a gate is a deliberate edit', () => {
    expect(PROTECTED_GATE_ISSUES).toHaveLength(
      EXPECTED_PROTECTED_GATE_ISSUE_COUNT,
    );
  });

  it('covers both calibration gates and states a reason for each', () => {
    const numbers = PROTECTED_GATE_ISSUES.map((gate) => gate.number);
    expect(numbers).toContain(42);
    expect(numbers).toContain(57);
    for (const gate of PROTECTED_GATE_ISSUES) {
      expect(gate.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('evaluateClosureScope', () => {
  it('permits a pull request that closes only a child issue', () => {
    const result = evaluateClosureScope([CHILD_ISSUE]);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('permits a pull request that closes nothing', () => {
    expect(evaluateClosureScope([]).ok).toBe(true);
  });

  it('rejects a pull request armed to close the release gate', () => {
    const result = evaluateClosureScope([CHILD_ISSUE, GATE_57]);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.number).toBe(57);
    expect(result.violations[0]?.rules).toContain('named-gate');
  });

  it('rejects a pull request armed to close the epic', () => {
    const result = evaluateClosureScope([EPIC_42]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.rules).toEqual(
      expect.arrayContaining(['named-gate', 'label:epic']),
    );
  });

  it('rejects an unlisted issue purely for carrying the epic label', () => {
    const futureEpic: ClosingIssue = {
      number: 999,
      title: 'Epic: something filed after this guard was written',
      labels: ['epic'],
    };
    const result = evaluateClosureScope([futureEpic]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.rules).toEqual(['label:epic']);
  });

  // The load-bearing case. #57 is a gate that tracks children but is not
  // labelled `epic`, so a label-only rule would miss the exact issue that was
  // armed in practice. This is the paired control for the test above: same
  // input, label rule alone, opposite outcome.
  it('would miss #57 on the label rule alone, which is why the named list exists', () => {
    const labelRuleOnly = evaluateClosureScope([GATE_57], {
      protectedIssues: [],
      protectedLabels: PROTECTED_LABELS,
    });
    expect(labelRuleOnly.ok).toBe(true);

    const namedListOnly = evaluateClosureScope([GATE_57], {
      protectedIssues: PROTECTED_GATE_ISSUES,
      protectedLabels: [],
    });
    expect(namedListOnly.ok).toBe(false);
  });

  it('refuses to decide from a value that cannot hold closing references', () => {
    expect(() =>
      evaluateClosureScope(null as unknown as readonly ClosingIssue[]),
    ).toThrow(/must be an array/);
  });

  it('refuses to decide from an entry with no issue number', () => {
    expect(() =>
      evaluateClosureScope([{ title: 'no number' } as unknown as ClosingIssue]),
    ).toThrow(/integer number/);
  });
});

describe('formatViolations', () => {
  it('names the issue and the rewrite that fixes it', () => {
    const { violations } = evaluateClosureScope([GATE_57]);
    const message = formatViolations(violations);
    expect(message).toContain('#57');
    expect(message).toContain('does not read negation');
    expect(message).toContain('closingIssuesReferences');
  });
});

describe('resolveRepository', () => {
  it('splits owner and repository', () => {
    expect(
      resolveRepository({ GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop' }),
    ).toEqual({ owner: 'OlyForge3D', repo: 'PrintFarmerDesktop' });
  });

  it('fails when the slug is absent or malformed', () => {
    expect(() => resolveRepository({})).toThrow(/GITHUB_REPOSITORY/);
    expect(() => resolveRepository({ GITHUB_REPOSITORY: 'nope' })).toThrow(
      /owner\/repo/,
    );
  });
});

describe('resolvePullRequestNumber', () => {
  const temporaryDirectories: string[] = [];

  // Vitest runs suites in parallel workers, so a test that leaves directories
  // behind competes for the same temp tree as everything else in the run.
  afterAll(() => {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function writeEvent(payload: unknown): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'closure-scope-'));
    temporaryDirectories.push(directory);
    const eventPath = path.join(directory, 'event.json');
    writeFileSync(eventPath, JSON.stringify(payload));
    return eventPath;
  }

  it('prefers an explicit PR_NUMBER', () => {
    expect(resolvePullRequestNumber({ PR_NUMBER: '209' })).toBe(209);
  });

  it('reads the pull request number from the event payload', () => {
    const eventPath = writeEvent({ pull_request: { number: 57 } });
    expect(resolvePullRequestNumber({ GITHUB_EVENT_PATH: eventPath })).toBe(57);
  });

  it('reads the pull request number from a merge-queue head ref', () => {
    const eventPath = writeEvent({
      merge_group: {
        head_ref:
          'refs/heads/gh-readonly-queue/development/pr-398-4a38021c3ffa',
      },
    });
    expect(resolvePullRequestNumber({ GITHUB_EVENT_PATH: eventPath })).toBe(
      398,
    );
  });

  it.each([
    'garbage/pr-398-x',
    'refs/heads/gh-readonly-queue/development/pr-0-x',
    'refs/heads/gh-readonly-queue/development/pr-398',
  ])('refuses a nonstandard merge-queue head ref: %s', (headRef) => {
    const eventPath = writeEvent({
      merge_group: { head_ref: headRef },
    });
    expect(() =>
      resolvePullRequestNumber({ GITHUB_EVENT_PATH: eventPath }),
    ).toThrow(/neither pull_request\.number nor a merge-queue PR head ref/);
  });

  it('fails rather than guessing when no number is available', () => {
    expect(() => resolvePullRequestNumber({})).toThrow(/no pull request/);
  });

  it('fails when the event identifies neither a PR nor its queue entry', () => {
    const eventPath = writeEvent({ push: {} });
    expect(() =>
      resolvePullRequestNumber({ GITHUB_EVENT_PATH: eventPath }),
    ).toThrow(/neither pull_request\.number nor a merge-queue PR head ref/);
  });
});

describe('fetchClosingIssues', () => {
  const request = {
    owner: 'OlyForge3D',
    repo: 'PrintFarmerDesktop',
    prNumber: 209,
    token: 'test-token',
  };

  const respondWith = (payload: unknown, ok = true, status = 200) =>
    (() =>
      Promise.resolve({
        ok,
        status,
        statusText: 'Test',
        json: () => Promise.resolve(payload),
      } as unknown as Response)) as unknown as typeof fetch;

  it('flattens issue labels', async () => {
    const issues = await fetchClosingIssues({
      ...request,
      fetchImpl: respondWith({
        data: {
          repository: {
            pullRequest: {
              closingIssuesReferences: {
                nodes: [
                  {
                    number: 161,
                    title: 'child',
                    labels: { nodes: [{ name: 'documentation' }] },
                  },
                ],
              },
            },
          },
        },
      }),
    });

    expect(issues).toEqual([
      { number: 161, title: 'child', labels: ['documentation'] },
    ]);
  });

  // An unreadable response must not produce the same result as a readable one
  // that found nothing armed. Both would otherwise be an empty array.
  it('refuses to read a malformed response as "nothing is armed"', async () => {
    await expect(
      fetchClosingIssues({
        ...request,
        fetchImpl: respondWith({ data: { repository: null } }),
      }),
    ).rejects.toThrow(/refusing to treat an unreadable response/);
  });

  it('fails on a GraphQL error payload', async () => {
    await expect(
      fetchClosingIssues({
        ...request,
        fetchImpl: respondWith({ errors: [{ message: 'bad credentials' }] }),
      }),
    ).rejects.toThrow(/reported errors/);
  });

  it('fails on a non-OK HTTP response', async () => {
    await expect(
      fetchClosingIssues({
        ...request,
        fetchImpl: respondWith({}, false, 502),
      }),
    ).rejects.toThrow(/502/);
  });
});

describe('resolveClosingIssuesConfidently', () => {
  // A synthetic clock and sleep so the tests run instantly and deterministically
  // instead of waiting out a real 45-second floor.
  function fakeClock() {
    let elapsed = 0;
    return {
      now: () => elapsed,
      sleep: (ms: number) => {
        elapsed += ms;
        return Promise.resolve();
      },
    };
  }

  const CHILD_ISSUES: ClosingIssue[] = [
    { number: 161, title: 'child', labels: ['documentation'] },
  ];

  // "I read the field and it is empty" — a genuinely unarmed pull request
  // must pass without waiting out the full budget once the floor is cleared.
  it('confirms empty once the elapsed floor is cleared, without more polling than necessary', async () => {
    const clock = fakeClock();
    let reads = 0;
    const read = () => {
      reads += 1;
      return Promise.resolve([]);
    };

    const result = await resolveClosingIssuesConfidently(read, {
      minEmptyFloorMs: 45000,
      delayMs: 5000,
      maxReads: 11,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.confirmedEmpty).toBe(true);
    expect(result.value).toEqual([]);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(45000);
    // 10 delays of 5000ms land exactly on the floor: reads at t=0..45000.
    expect(reads).toBe(10);
  });

  // "I read the field and it has no value yet" — the exact #319 shape: the
  // very first read is empty, but a later read (still inside the budget)
  // reveals the pull request is armed. The early empty read must not be
  // trusted, and the eventual non-empty read must be returned immediately
  // rather than waited out further.
  it('does not trust an early empty read and reports arming once it appears', async () => {
    const clock = fakeClock();
    const responses = [[], [], [], CHILD_ISSUES];
    let reads = 0;
    const read = () => {
      const value = responses[reads] ?? CHILD_ISSUES;
      reads += 1;
      return Promise.resolve(value);
    };

    const result = await resolveClosingIssuesConfidently(read, {
      minEmptyFloorMs: 45000,
      delayMs: 5000,
      maxReads: 11,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.confirmedEmpty).toBe(false);
    expect(result.value).toEqual(CHILD_ISSUES);
    expect(reads).toBe(4);
    // Returned well before the empty-floor budget would have elapsed: an
    // armed pull request must never be masked by waiting for more reads.
    expect(result.elapsedMs).toBeLessThan(45000);
  });

  // The distinction the issue names directly: an indeterminate read (never
  // reaches the floor while empty, never sees a non-empty value either) must
  // fail closed with a distinguishable error, not silently report a pass.
  it('fails closed with a distinct error when the budget is exhausted before the floor', async () => {
    const clock = fakeClock();
    const read = () => Promise.resolve([]);

    await expect(
      resolveClosingIssuesConfidently(read, {
        minEmptyFloorMs: 45000,
        delayMs: 5000,
        maxReads: 3, // 3 reads spans only 10s, short of the 45s floor.
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(ClosingIssuesIndeterminateError);
  });

  it('never resolves an indeterminate timeout to an empty, passing result', async () => {
    const clock = fakeClock();
    const read = () => Promise.resolve([]);

    let caught: unknown;
    try {
      await resolveClosingIssuesConfidently(read, {
        minEmptyFloorMs: 45000,
        delayMs: 5000,
        maxReads: 3,
        now: clock.now,
        sleep: clock.sleep,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClosingIssuesIndeterminateError);
    const error = caught as InstanceType<
      typeof ClosingIssuesIndeterminateError
    >;
    expect(error.reads).toBe(3);
    expect(error.elapsedMs).toBeLessThan(45000);
    expect(error.message).toMatch(/not necessarily finished computing/);
  });

  it('trusts a non-empty first read immediately, with no polling at all', async () => {
    const clock = fakeClock();
    let reads = 0;
    const read = () => {
      reads += 1;
      return Promise.resolve(CHILD_ISSUES);
    };

    const result = await resolveClosingIssuesConfidently(read, {
      minEmptyFloorMs: 45000,
      delayMs: 5000,
      maxReads: 11,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result.confirmedEmpty).toBe(false);
    expect(result.reads).toBe(1);
    expect(result.elapsedMs).toBe(0);
    expect(reads).toBe(1);
  });
});

describe('the two closure checks publish independent contexts', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const workflow = readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'pr-closure-scope.yml'),
    'utf8',
  );
  const generalWorkflow = readFileSync(
    path.join(
      repositoryRoot,
      '.github',
      'workflows',
      'closing-reference-declaration.yml',
    ),
    'utf8',
  );
  const ciWorkflow = readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  function jobBlock(contents: string, job: string): string {
    const lines = contents.split(/\r?\n/);
    const start = lines.findIndex((line) => line === `  ${job}:`);
    if (start < 0) throw new Error(`workflow has no ${job} job`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}\S[^:]*:\s*$/.test(line));
    return [lines[start], ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
  }

  /**
   * Event names the workflow subscribes to, sorted. Textual for the same
   * reason as tests/ciWorkflowTriggers.test.ts: the repository ships no YAML
   * parser and this change does not add one.
   */
  function triggersOf(contents: string): string[] {
    const lines = contents.split(/\r?\n/);
    const start = lines.indexOf('on:');
    if (start < 0) throw new Error('workflow has no top-level "on:" block');
    const body = lines.slice(start + 1);
    const end = body.findIndex((line) => /^\S/.test(line));
    return (end < 0 ? body : body.slice(0, end))
      .flatMap((line) => {
        const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
        return match?.[1] === undefined ? [] : [match[1]];
      })
      .sort();
  }

  it('finds the triggers at all, so the assertions below are not vacuous', () => {
    // Positive control on the extractor. Without it, "does not contain
    // merge_group" would pass just as well against a parser that can never
    // return anything.
    expect(triggersOf(workflow).length).toBeGreaterThan(0);
  });

  it('keeps the single-read gate check advisory and PR-only', () => {
    expect(triggersOf(workflow)).toEqual(['pull_request']);
    expect(workflow).toContain('# merge-queue: advisory');
  });

  it('runs the settled general check for both event classes a required context must cover', () => {
    expect(triggersOf(generalWorkflow)).toEqual([
      'merge_group',
      'pull_request',
    ]);
    expect(generalWorkflow).toContain('# merge-queue: reports');
  });

  /**
   * Activity types the `pull_request:` trigger subscribes to, sorted.
   */
  function typesOf(contents: string): string[] {
    const match = /^ {4}types: \[(.+)\]$/m.exec(contents);
    if (match?.[1] === undefined)
      throw new Error('workflow declares no pull_request types');
    return match[1]
      .split(',')
      .map((entry) => entry.trim())
      .sort();
  }

  it('finds the activity types at all, so the assertions below are not vacuous', () => {
    expect(typesOf(workflow).length).toBeGreaterThan(0);
  });

  it('re-runs when a pull request is edited, because the field it reads comes from the body', () => {
    // Found on the pull request that introduced this workflow. The default type
    // set is commit-shaped (opened, synchronize, reopened), but
    // closingIssuesReferences is derived from the pull request BODY, which is
    // editable with no commit and no push. Without `edited`, a pull request
    // could pass this check and then have a closing keyword typed into its
    // description, and nothing would run again before it merged.
    expect(typesOf(workflow)).toContain('edited');
  });

  it('still covers the three default activity types, because listing any type replaces them', () => {
    // `types:` overrides the default set rather than adding to it. A well-meaning
    // `types: [edited]` would stop this workflow running on new pull requests
    // entirely — the guard disabled by the same class of mistake it guards
    // against. This assertion is what makes that unshippable.
    expect(typesOf(workflow)).toEqual([
      'edited',
      'opened',
      'reopened',
      'synchronize',
    ]);
    expect(typesOf(generalWorkflow)).toEqual(typesOf(workflow));
  });

  it('runs the npm script rather than a divergent inline command', () => {
    // Without this the workflow could drift to a different entry point than
    // the one every test above exercises.
    expect(workflow).toContain('npm run check:closure-scope');
    expect(manifest.scripts['check:closure-scope']).toBe(
      'node scripts/check-pr-closure-scope.mjs',
    );
  });

  it('publishes the general and gate-only checks as accurately named independent contexts', () => {
    // PR #456 produced opposite conclusions for these checks on one head. Keeping
    // them as sibling jobs makes that disagreement visible without lending the
    // narrower green to the general contract.
    const gateOnly = jobBlock(workflow, 'closure-scope');
    expect(gateOnly).toContain('name: Gate issue closure scope');
    expect(gateOnly).toContain('npm run check:closure-scope');
    expect(gateOnly).not.toContain('check:closing-references');

    const general = jobBlock(generalWorkflow, 'closing-references');
    expect(general).toContain('name: Closing-reference declaration');
    expect(general).toContain('npm run check:closing-references');
    expect(general).not.toContain('check:closure-scope');
  });

  it('does not attribute the general PR-body contract to either Desktop platform', () => {
    expect(invokedScripts(ciWorkflow, manifest.scripts)).not.toContain(
      'check-closing-references.mjs',
    );
    expect(invokedScripts(generalWorkflow, manifest.scripts)).toContain(
      'check-closing-references.mjs',
    );
  });

  it('stays off the scarce macos runner pool', () => {
    // Measured on this repository: with only two concurrent ci.yml runs, every
    // non-macOS context finished while three macOS contexts queued 27-29
    // minutes. A guard that reports in seconds should not join that queue.
    //
    // Reads the `runs-on:` values rather than the file text. The first version
    // of this assertion was `expect(workflow).not.toContain('macos-latest')`
    // and it failed on the comment above, which names the pool it avoids —
    // a substring search cannot tell a declaration from a mention.
    const runsOn = workflow.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*runs-on:\s*(.+)$/.exec(line);
      return match?.[1] === undefined ? [] : [match[1].trim()];
    });
    expect(runsOn).toEqual(['ubuntu-latest']);
  });
});

// The second closure channel.
//
// #241 is the regression this whole block exists for: its body-derived
// `closingIssuesReferences` was empty, this suite passed, and #57 closed anyway
// because a commit message on the branch carried a closing keyword in front of
// the gate number. The sentence that did it was written to warn about the
// hazard. Quotation arms exactly like assertion.
const GATE_ISSUE_57: ClosingIssue = {
  number: 57,
  title: 'Calibration release gate',
  labels: ['squad', 'squad:ripley'],
};

describe('extractArmedIssueNumbers', () => {
  it('finds a plain closing keyword', () => {
    expect(extractArmedIssueNumbers('closes #57')).toEqual([
      { number: 57, keyword: 'closes', text: 'closes #57' },
    ]);
  });

  it('is case-insensitive and tolerates a colon', () => {
    expect(extractArmedIssueNumbers('Fixed: #42').map((r) => r.number)).toEqual(
      [42],
    );
  });

  it('honours the GH- reference form GitHub also accepts', () => {
    expect(
      extractArmedIssueNumbers('resolve GH-42').map((r) => r.number),
    ).toEqual([42]);
  });

  it('reproduces the exact sentence that closed the gate, and counts both refs', () => {
    const message =
      '"this does not close #57" still contains a closing keyword in front of #57';
    expect(extractArmedIssueNumbers(message).map((r) => r.number)).toEqual([
      57,
    ]);
  });

  it('does not fire on a bare reference with no keyword', () => {
    expect(extractArmedIssueNumbers('Parent: #57')).toEqual([]);
    expect(extractArmedIssueNumbers('see #57 for context')).toEqual([]);
  });

  it('does not fire on a noun that merely starts like a keyword', () => {
    expect(extractArmedIssueNumbers('this is not a closure of #57')).toEqual(
      [],
    );
    expect(extractArmedIssueNumbers('a fixture for #57')).toEqual([]);
  });

  it('refuses to scan a value that cannot hold a reference', () => {
    expect(() => extractArmedIssueNumbers(undefined as never)).toThrow(
      /refusing to report/i,
    );
  });
});

describe('collectArmedCommitReferences', () => {
  it('attributes each armed issue to the commit that armed it', () => {
    const armed = collectArmedCommitReferences([
      { sha: 'b136caa6aaaa', message: 'ci: add the guard\n\ncloses #57' },
      { sha: 'ffffffffffff', message: 'docs: unrelated' },
    ]);
    expect([...armed.keys()]).toEqual([57]);
    expect(armed.get(57)?.[0]?.sha).toBe('b136caa6aaaa');
  });

  it('reports nothing for commits that arm nothing', () => {
    const armed = collectArmedCommitReferences([
      { sha: 'aaaa', message: 'Parent: #57' },
    ]);
    expect([...armed.keys()]).toEqual([]);
  });

  it('refuses to treat an unreadable commit as "nothing armed"', () => {
    expect(() =>
      collectArmedCommitReferences([{ sha: 'aaaa' } as never]),
    ).toThrow(/refusing to treat an unreadable commit/i);
    expect(() => collectArmedCommitReferences(undefined as never)).toThrow(
      /must be an array/i,
    );
  });
});

describe('the two channels are independent', () => {
  it('fails a pull request whose body is clean but whose commits arm the gate', () => {
    // This is #241 exactly: the body channel passes honestly.
    expect(evaluateClosureScope([]).ok).toBe(true);

    const armed = collectArmedCommitReferences([
      {
        sha: 'b136caa6',
        message:
          '"this does not close #57" still contains a closing keyword in front of #57',
      },
    ]);
    expect([...armed.keys()]).toEqual([57]);
    expect(evaluateClosureScope([GATE_ISSUE_57]).ok).toBe(false);
  });

  it('permits a commit that names a number which is not a gate', () => {
    const armed = collectArmedCommitReferences([
      { sha: 'aaaa', message: 'closes #4200' },
    ]);
    expect([...armed.keys()]).toEqual([4200]);
    expect(
      evaluateClosureScope([{ number: 4200, title: 'ordinary child' }]).ok,
    ).toBe(true);
  });

  it('applies the derived label rule to the commit channel too', () => {
    // No entry in PROTECTED_GATE_ISSUES; protected purely by carrying `epic`.
    expect(
      evaluateClosureScope([
        { number: 9001, title: 'a future epic', labels: ['epic'] },
      ]).ok,
    ).toBe(false);
  });
});

describe('formatCommitViolations', () => {
  it('names the commit, and says that editing the body will not clear it', () => {
    const { violations } = evaluateClosureScope([GATE_ISSUE_57]);
    const armed = collectArmedCommitReferences([
      { sha: 'b136caa6aaaa', message: 'closes #57' },
    ]);
    const report = formatCommitViolations(violations, armed);
    expect(report).toContain('#57');
    expect(report).toContain('b136caa6');
    expect(report).toContain('COMMIT_MESSAGES');
    expect(report).toMatch(
      /editing the pull request body does not clear this/i,
    );
  });
});

describe('fetchPullRequestCommits', () => {
  const respondJson = (payload: unknown, ok = true, status = 200) =>
    (() =>
      Promise.resolve({
        ok,
        status,
        statusText: 'Test',
        json: () => Promise.resolve(payload),
      } as unknown as Response)) as unknown as typeof fetch;

  const respondInSequence = (payloads: readonly unknown[]) => {
    let call = 0;
    return (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'Test',
        json: () => Promise.resolve(payloads[call++]),
      } as unknown as Response)) as unknown as typeof fetch;
  };

  it('paginates rather than under-reporting, because short reads look clean', async () => {
    const commits = await fetchPullRequestCommits({
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      token: 't',
      fetchImpl: respondInSequence([
        Array.from({ length: 100 }, (_, index) => ({
          sha: `a${index}`,
          commit: { message: 'noop' },
        })),
        [{ sha: 'last', commit: { message: 'closes #57' } }],
      ]),
    });
    expect(commits).toHaveLength(101);
    expect(collectArmedCommitReferences(commits).has(57)).toBe(true);
  });

  it('refuses to read a malformed response as "nothing is armed"', async () => {
    await expect(
      fetchPullRequestCommits({
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        token: 't',
        fetchImpl: respondJson({ message: 'Not Found' }),
      }),
    ).rejects.toThrow(/refusing to treat an unreadable response/i);
  });

  it('fails on a non-OK response', async () => {
    await expect(
      fetchPullRequestCommits({
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        token: 't',
        fetchImpl: respondJson(null, false, 500),
      }),
    ).rejects.toThrow(/500/);
  });
});

describe('fetchIssuesByNumber', () => {
  const respondJson = (payload: unknown, ok = true, status = 200) =>
    (() =>
      Promise.resolve({
        ok,
        status,
        statusText: 'Test',
        json: () => Promise.resolve(payload),
      } as unknown as Response)) as unknown as typeof fetch;

  it('flattens labels so the derived rule can run on the commit channel', async () => {
    const issues = await fetchIssuesByNumber({
      owner: 'o',
      repo: 'r',
      numbers: [42],
      token: 't',
      fetchImpl: respondJson({
        number: 42,
        title: 'Epic',
        labels: [{ name: 'epic' }, 'squad'],
      }),
    });
    expect(issues).toEqual([
      { number: 42, title: 'Epic', labels: ['epic', 'squad'] },
    ]);
  });

  it('treats 404 as a real answer, not as a failure to read', async () => {
    const issues = await fetchIssuesByNumber({
      owner: 'o',
      repo: 'r',
      numbers: [4200],
      token: 't',
      fetchImpl: respondJson(null, false, 404),
    });
    expect(issues).toEqual([]);
  });

  it('refuses to read a malformed issue as "not a gate"', async () => {
    await expect(
      fetchIssuesByNumber({
        owner: 'o',
        repo: 'r',
        numbers: [57],
        token: 't',
        fetchImpl: respondJson({}),
      }),
    ).rejects.toThrow(/refusing to treat an unreadable response/i);
  });
});
