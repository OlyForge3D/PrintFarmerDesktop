// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  EXPECTED_PROTECTED_GATE_ISSUE_COUNT,
  PROTECTED_GATE_ISSUES,
  PROTECTED_LABELS,
  evaluateClosureScope,
  fetchClosingIssues,
  formatViolations,
  resolvePullRequestNumber,
  resolveRepository,
} from '../scripts/check-pr-closure-scope.mjs';
import type { ClosingIssue } from '../scripts/check-pr-closure-scope.mjs';

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

  it('fails rather than guessing when no number is available', () => {
    expect(() => resolvePullRequestNumber({})).toThrow(/no pull request/);
  });

  it('fails when the event is not a pull request', () => {
    const eventPath = writeEvent({ push: {} });
    expect(() =>
      resolvePullRequestNumber({ GITHUB_EVENT_PATH: eventPath }),
    ).toThrow(/pull_request\.number/);
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

describe('the closure-scope workflow stays outside the merge queue', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const workflow = readFileSync(
    path.join(repositoryRoot, '.github', 'workflows', 'pr-closure-scope.yml'),
    'utf8',
  );

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

  it('subscribes to pull_request only, because no other event carries a PR number', () => {
    expect(triggersOf(workflow)).toEqual(['pull_request']);
  });

  it('does not subscribe to merge_group, so it must never be a required context', () => {
    // A required context that no workflow emits stays Pending forever and
    // blocks the entry rather than failing it. If this workflow ever learns to
    // report under merge_group, this assertion is the place that says so.
    expect(triggersOf(workflow)).not.toContain('merge_group');
  });

  it('runs the npm script rather than a divergent inline command', () => {
    // Without this the workflow could drift to a different entry point than
    // the one every test above exercises.
    expect(workflow).toContain('npm run check:closure-scope');
    const manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts['check:closure-scope']).toBe(
      'node scripts/check-pr-closure-scope.mjs',
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
