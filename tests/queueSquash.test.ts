// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findGitHelpers,
  main as dryRun,
  verifySquashGroup,
  type SquashInput,
} from '../scripts/verify-queue-squash.mjs';
import {
  checkDevelopmentQueue,
  main as eventMain,
  verifyQueueEvent,
  type QueueApi,
  type QueueRunner,
} from '../scripts/check-development-queue.mjs';
import {
  QUEUE_PARAMETERS,
  REQUIRED_CONTEXT_NAMES,
} from '../scripts/merge-queue-policy.mjs';
import failed from './fixtures/failedSquashGroup.json';

// Real Git processes on Windows CI need an integration-test budget.
vi.setConfig({ testTimeout: 30_000 });

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('trusted Git helper discovery', () => {
  function layout() {
    const root = mkdtempSync(path.join(tmpdir(), 'git-layout-'));
    directories.push(root);
    const bin = path.join(root, 'ucrt64', 'bin');
    const intrinsic = path.join(root, 'ucrt64', 'libexec', 'git-core');
    mkdirSync(bin, { recursive: true });
    mkdirSync(intrinsic, { recursive: true });
    const helper =
      process.platform === 'win32'
        ? 'git-remote-https.exe'
        : 'git-remote-https';
    return { root, bin, intrinsic, helper };
  }

  it('prefers helpers in the executable-reported exec path', () => {
    const { root, bin, intrinsic, helper } = layout();
    writeFileSync(path.join(intrinsic, helper), '');
    writeFileSync(path.join(bin, helper), '');
    expect(findGitHelpers(path.join(root, 'cmd', 'git.exe'), intrinsic)).toBe(
      intrinsic,
    );
  });

  it('finds bundled Windows helpers in the sibling bin directory', () => {
    const { root, bin, intrinsic, helper } = layout();
    writeFileSync(path.join(bin, helper), '');
    expect(findGitHelpers(path.join(root, 'cmd', 'git.exe'), intrinsic)).toBe(
      bin,
    );
  });

  it('finds relocatable helpers beside the selected executable', () => {
    const { root, bin, helper } = layout();
    writeFileSync(path.join(bin, helper), '');
    expect(
      findGitHelpers(path.join(bin, 'git'), path.join(root, 'stale-prefix')),
    ).toBe(bin);
  });

  it('rejects missing helpers rather than using an inherited override', () => {
    const { root, bin, intrinsic, helper } = layout();
    writeFileSync(path.join(bin, helper), '');
    vi.stubEnv('GIT_EXEC_PATH', bin);
    try {
      expect(() =>
        findGitHelpers(
          path.join(root, 'unrelated', 'git'),
          path.join(root, 'missing'),
        ),
      ).toThrow(/cannot locate trusted Git HTTPS helpers/);
      expect(findGitHelpers(path.join(bin, 'git'), intrinsic)).toBe(bin);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function repository(conflict = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'squash-test-'));
  directories.push(directory);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q', '--initial-branch=development');
  git('config', 'user.name', 'Queue test');
  git('config', 'user.email', 'queue@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const save = (file: string, value: string) =>
    writeFileSync(path.join(directory, file), value);
  save('shared.txt', 'first\nmiddle\nlast\n');
  git('add', '.');
  git('commit', '-qm', 'common ancestor');
  const mergeBase = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'source');
  save('shared.txt', 'source\nmiddle\nlast\n');
  git('commit', '-qam', 'source one');
  save('source.txt', 'source-only\n');
  git('add', '.');
  git('commit', '-qm', 'source two');
  const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/pull/10/head', head);
  git('checkout', '-q', 'development');
  save(
    'shared.txt',
    conflict ? 'base\nmiddle\nlast\n' : 'first\nmiddle\nbase\n',
  );
  git('commit', '-qam', 'base advanced in same file');
  const base = git('rev-parse', 'HEAD');
  // Real squash, independently from the production merge-tree implementation.
  let group: string;
  if (conflict)
    group = git(
      'commit-tree',
      `${base}^{tree}`,
      '-p',
      base,
      '-m',
      'invalid conflict group',
    );
  else {
    git('merge', '--squash', 'source');
    git('commit', '-qm', 'squash group');
    group = git('rev-parse', 'HEAD');
  }
  const input = { base, head, group, repository: directory };
  return { directory, git, save, input, mergeBase };
}

function liveFixture(repo: ReturnType<typeof repository>) {
  const { base, head, group } = repo.input;
  const state = {
    source: head,
    restSource: head,
    number: 10,
    extra: false,
    truncated: false,
    unknown: false,
    reads: 0,
  };
  const entry = () => ({
    id: 'MQ_test',
    position: 1,
    state: 'AWAITING_CHECKS',
    baseCommit: { oid: base },
    headCommit: { oid: group },
  });
  const pull = () => ({
    id: 'PR_test',
    state: 'OPEN',
    isDraft: false,
    mergeable: state.unknown ? 'UNKNOWN' : 'MERGEABLE',
    headRefOid: state.source,
    baseRefName: 'development',
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    mergeQueueEntry: entry(),
  });
  const checks = REQUIRED_CONTEXT_NAMES.map((context) => ({
    context,
    app_id: 15368,
  }));
  const api: QueueApi = (endpoint) => {
    if (endpoint === 'graphql') {
      state.reads++;
      const node = {
        id: 'MQ_test',
        headCommit: { oid: group },
        pullRequest: { number: state.number, headRefOid: state.source },
      };
      return {
        data: {
          repository: {
            pullRequest: pull(),
            mergeQueue: {
              entries: {
                nodes: state.extra
                  ? [node, { ...node, id: 'MQ_other' }]
                  : [node],
                pageInfo: { hasNextPage: state.truncated },
              },
            },
          },
        },
      };
    }
    if (endpoint.includes('/pulls/'))
      return {
        state: 'open',
        head: { sha: state.restSource },
        base: { ref: 'development' },
        labels: [],
      };
    if (endpoint.includes('/git/ref/')) return { object: { sha: base } };
    if (endpoint.includes('/rules/branches'))
      return [
        { type: 'merge_queue', ruleset_id: 1, parameters: QUEUE_PARAMETERS },
      ];
    if (endpoint.includes('/rulesets/'))
      return {
        id: 1,
        target: 'branch',
        enforcement: 'active',
        bypass_actors: [],
        conditions: {
          ref_name: { include: ['refs/heads/development'], exclude: [] },
        },
        rules: [{ type: 'merge_queue', parameters: QUEUE_PARAMETERS }],
      };
    if (endpoint.includes('/protection'))
      return {
        required_status_checks: {
          strict: false,
          contexts: [...REQUIRED_CONTEXT_NAMES],
          checks,
        },
      };
    if (endpoint.includes('/check-runs')) {
      const sha = endpoint.includes(`/commits/${group}/`) ? group : head;
      return {
        check_runs: checks.map(({ context }) => ({
          id: 1,
          name: context,
          app: { id: 15368 },
          head_sha: sha,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-11-10T00:00:00Z',
          completed_at: '2026-11-10T00:01:00Z',
          details_url:
            'https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/99/job/1',
        })),
      };
    }
    if (endpoint.includes('/actions/runs/'))
      return {
        event: 'merge_group',
        head_sha: group,
        status: 'completed',
        conclusion: 'success',
      };
    throw new Error(`Unexpected request: ${endpoint}`);
  };
  const event = {
    merge_group: {
      base_ref: 'refs/heads/development',
      base_sha: base,
      head_sha: group,
      head_ref: `refs/heads/gh-readonly-queue/development/pr-10-${base}`,
    },
  };
  const proof = (input: SquashInput) =>
    verifySquashGroup({ ...input, repository: repo.directory });
  return { api, event, proof, state };
}

describe('squash-compatible combined-result proof', () => {
  it('proves a behind source, same-file base advance and real squash through production paths', () => {
    const repo = repository();
    const live = liveFixture(repo);
    expect(repo.git('merge-base', repo.input.head, repo.input.group)).not.toBe(
      repo.input.head,
    );
    expect(verifySquashGroup(repo.input)).toEqual({
      base: repo.input.base,
      head: repo.input.head,
      group: repo.input.group,
      mergeBase: repo.mergeBase,
      tree: repo.git('rev-parse', `${repo.input.group}^{tree}`),
    });
    const review = vi.fn();
    expect(
      verifyQueueEvent(live.event, live.api, review, live.proof),
    ).toContain('squash tree');
    expect(review).toHaveBeenCalledWith(10, repo.input.head);
    expect(
      checkDevelopmentQueue(
        { number: 10, head: repo.input.head },
        live.api,
        review,
        live.proof,
      ),
    ).toContain('group checks passed');
    const eventPath = path.join(repo.directory, 'event.json');
    writeFileSync(eventPath, JSON.stringify(live.event));
    const runner: QueueRunner = (command, args) => ({
      status: 0,
      stderr: '',
      stdout: JSON.stringify(
        command === process.execPath
          ? { classification: 'REVIEWED', reviewedHeadSha: repo.input.head }
          : live.api(args[1] ?? ''),
      ),
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(
      eventMain(
        ['--event'],
        {
          GH_TOKEN: 'read-only',
          GITHUB_EVENT_NAME: 'merge_group',
          GITHUB_EVENT_PATH: eventPath,
        },
        runner,
        live.proof,
      ),
    ).toBe(0);
    expect(
      dryRun([
        '--base',
        repo.input.base,
        '--head',
        repo.input.head,
        '--group',
        repo.input.group,
        '--repository',
        repo.directory,
      ]),
    ).toBe(0);
  });
  it.each([
    'tampered tree',
    'wrong parent',
    'two commits',
    'merge parents',
    'missing object',
    'noncommit',
  ] as const)('refuses %s', (shape) => {
    const repo = repository();
    const { git, input, mergeBase } = repo;
    const tree = git('rev-parse', `${input.group}^{tree}`);
    let group = input.group;
    if (shape === 'tampered tree')
      group = git(
        'commit-tree',
        `${input.base}^{tree}`,
        '-p',
        input.base,
        '-m',
        'tampered',
      );
    if (shape === 'wrong parent')
      group = git('commit-tree', tree, '-p', mergeBase, '-m', 'wrong');
    if (shape === 'two commits')
      group = git('commit-tree', tree, '-p', input.group, '-m', 'second');
    if (shape === 'merge parents')
      group = git(
        'commit-tree',
        tree,
        '-p',
        input.base,
        '-p',
        input.head,
        '-m',
        'merge',
      );
    if (shape === 'missing object') group = 'd'.repeat(40);
    if (shape === 'noncommit') group = tree;
    expect(() => verifySquashGroup({ ...input, group })).toThrow(/Squash/);
  });
  it('fails closed on a real conflicting three-way merge', () => {
    const repo = repository(true);
    expect(() => verifySquashGroup(repo.input)).toThrow(/merge-tree failed/);
  });
  it('refuses missing source objects, malformed identities and an unknown PR ref', () => {
    const repo = repository();
    expect(() =>
      verifySquashGroup({ ...repo.input, head: 'f'.repeat(40) }),
    ).toThrow();
    expect(() => verifySquashGroup({ ...repo.input, head: 'HEAD' })).toThrow(
      /full commit/,
    );
    expect(() => verifySquashGroup({ ...repo.input, number: 11 })).toThrow(
      /Squash proof git/,
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      dryRun([
        '--base',
        repo.input.base,
        '--head',
        'HEAD',
        '--group',
        repo.input.group,
      ]),
    ).toBe(2);
  });
  it('refuses ambiguous criss-cross merge bases instead of choosing one', () => {
    const repo = repository();
    const tree = repo.git('rev-parse', `${repo.input.group}^{tree}`);
    const left = repo.git(
      'commit-tree',
      tree,
      '-p',
      repo.input.base,
      '-p',
      repo.input.head,
      '-m',
      'left',
    );
    const right = repo.git(
      'commit-tree',
      tree,
      '-p',
      repo.input.head,
      '-p',
      repo.input.base,
      '-m',
      'right',
    );
    const group = repo.git('commit-tree', tree, '-p', left, '-m', 'group');
    expect(() =>
      verifySquashGroup({ ...repo.input, base: left, head: right, group }),
    ).toThrow(/unambiguous true merge base/);
  });
  it('ignores inherited Git replacement overrides and local merge-driver configuration', () => {
    const repo = repository();
    vi.stubEnv('GIT_EXEC_PATH', path.join(repo.directory, 'hostile-helpers'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'merge.renormalize');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    repo.git('config', 'merge.custom.driver', 'false');
    try {
      expect(verifySquashGroup(repo.input).mergeBase).toBe(repo.mergeBase);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    'different PR',
    'different REST head',
    'unknown',
    'multiple PRs',
    'truncated queue',
    'wrong ref',
    'source ref moved',
  ] as const)('refuses live %s without granting review', (shape) => {
    const repo = repository();
    const live = liveFixture(repo);
    if (shape === 'different PR') live.state.number = 11;
    if (shape === 'different REST head')
      live.state.restSource = repo.input.base;
    if (shape === 'unknown') live.state.unknown = true;
    if (shape === 'multiple PRs') live.state.extra = true;
    if (shape === 'truncated queue') live.state.truncated = true;
    if (shape === 'wrong ref')
      live.event.merge_group.head_ref += '-pr-11-extra';
    if (shape === 'source ref moved')
      repo.git('update-ref', 'refs/pull/10/head', repo.input.base);
    const review = vi.fn();
    expect(() =>
      verifyQueueEvent(live.event, live.api, review, live.proof),
    ).toThrow();
    expect(review).not.toHaveBeenCalled();
  });
  it('refuses a source push during independent proof', () => {
    const repo = repository();
    const live = liveFixture(repo);
    expect(() =>
      verifyQueueEvent(live.event, live.api, vi.fn(), (input) => {
        live.proof(input);
        live.state.source = repo.input.base;
        live.state.restSource = repo.input.base;
      }),
    ).toThrow(/Source head changed/);
  });
  it('records the real failed group without depending on its objects or network', () => {
    expect(failed.parents).toEqual([failed.base]);
    expect(failed.headRef).toBe(
      `refs/heads/gh-readonly-queue/development/pr-${failed.number}-${failed.base}`,
    );
    expect(failed.oldComparison.status).toBe('diverged');
    expect(failed.mergeBase).not.toBe(failed.head);
  });
});
