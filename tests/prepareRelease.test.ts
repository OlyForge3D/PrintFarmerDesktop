// @vitest-environment node

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareReleaseVersions,
  expectedReleaseAssets,
  gitAuthenticationEnvironment,
  main,
  readVersionDocuments,
  releaseContext,
  validateReleaseVersion,
  verifyPublishedRelease,
} from '../scripts/prepare-release.mjs';
import type { CommandRunner } from '../scripts/prepare-release.mjs';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release version validation before writes', () => {
  it.each(['0.1.0-beta.10', '1.2.3', '1.2.3-rc.2', '1.2.3-beta.long-name'])(
    'accepts %s',
    (version) => expect(validateReleaseVersion(version)).toBe(version),
  );
  it.each([
    '',
    'v1.2.3',
    ' 1.2.3',
    '1.2.3\n',
    '01.2.3',
    '1.2',
    '1.2.3+build',
    '1.2.3-beta.01',
    '1.2.3-01',
    '65536.0.0',
    '1.2.3;exit',
    '1.2.3/branch',
    '1.2.3-${SECRET}',
    undefined,
    123,
  ])('rejects %s', (version) => {
    expect(() => validateReleaseVersion(version)).toThrow(/canonical/);
  });
  it.each([
    ['0.1.0-beta.10', '0.1.0-beta.9', 1],
    ['0.1.0', '0.1.0-beta.999', 1],
    ['1.2.3-beta', '1.2.3-beta.1', -1],
    ['1.2.3-1', '1.2.3-alpha', -1],
    ['1.2.3', '1.2.3', 0],
    ['1.2.3-rc.1', '1.2.3-beta.99', 1],
  ] as const)('compares %s with %s', (left, right, order) => {
    expect(compareReleaseVersions(left, right)).toBe(order);
    expect(compareReleaseVersions(right, left)).toBe(-order || 0);
  });
  it('refuses mismatched lockfile roots', () => {
    expect(() =>
      readVersionDocuments((file) =>
        JSON.stringify(
          file === 'package.json'
            ? { version: '1.2.3' }
            : { version: '1.2.3', packages: { '': { version: '1.2.2' } } },
        ),
      ),
    ).toThrow(/disagree/);
  });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pfd-release-'));
  temporary.push(root);
  const work = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  mkdirSync(work);
  const gitAt = (directory: string, args: string[]) =>
    execFileSync(
      'git',
      directory === remote ? ['--git-dir', remote, ...args] : args,
      {
        cwd: directory,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    ).trim();
  const git = (args: string[]) => gitAt(work, args);
  git(['init', '--initial-branch=development']);
  git(['config', 'user.name', 'Release test']);
  git(['config', 'user.email', 'release@example.invalid']);
  writeFileSync(
    path.join(work, 'package.json'),
    `${JSON.stringify(
      {
        name: 'release-fixture',
        version: '0.1.0-beta.9',
        private: true,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(work, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'release-fixture',
        version: '0.1.0-beta.9',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'release-fixture', version: '0.1.0-beta.9' } },
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(path.join(work, 'native'));
  writeFileSync(
    path.join(work, 'native', 'Cargo.toml'),
    '[workspace.package]\nversion = "0.1.0"\n',
  );
  writeFileSync(
    path.join(work, 'native', 'Cargo.lock'),
    'independent sidecar lock\n',
  );
  git(['add', '.']);
  git(['commit', '-m', 'Initial source']);
  gitAt(root, ['init', '--bare', remote]);
  git(['remote', 'add', 'origin', remote]);
  git(['push', 'origin', 'development']);
  const base = git(['rev-parse', 'HEAD']);
  const output = path.join(root, 'outputs');
  writeFileSync(output, '');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/development',
    GITHUB_SHA: base,
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '123',
    GITHUB_OUTPUT: output,
    RELEASE_VERSION: '0.1.0-beta.10',
    RELEASE_DRY_RUN: 'false',
    GH_TOKEN: 'test-read-credential',
    RELEASE_PUSH_TOKEN: 'test-write-credential',
  };
  const invoke: CommandRunner = (command, args, options) => {
    if (command === 'gh') return '[]';
    return execFileSync(command, args, options);
  };
  return { root, work, remote, git, gitAt, base, output, environment, invoke };
}

describe('persisted version commit and atomic branch/tag transaction', () => {
  it('commits every application version surface and tags/builds that exact SHA', () => {
    const f = fixture();
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] =
      [];
    const result = main(f.environment, f.work, (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return f.invoke(command, args, options);
    });
    expect(result).toMatchObject({
      tag: 'v0.1.0-beta.10',
      publish: 'true',
      beta: 'true',
      stable: 'false',
      build: 'true',
    });
    expect(result.sha).not.toBe(f.base);
    expect(f.gitAt(f.remote, ['rev-parse', 'development'])).toBe(result.sha);
    expect(f.gitAt(f.remote, ['rev-parse', `${result.tag}^{}`])).toBe(
      result.sha,
    );
    expect(f.git(['rev-parse', 'HEAD^'])).toBe(f.base);
    expect(f.git(['diff', '--name-only', 'HEAD^', 'HEAD']).split('\n')).toEqual(
      ['package-lock.json', 'package.json'],
    );
    expect(f.git(['show', 'HEAD:native/Cargo.toml'])).toContain(
      'version = "0.1.0"',
    );
    const lock = JSON.parse(
      readFileSync(path.join(f.work, 'package-lock.json'), 'utf8'),
    ) as { version: string; packages: Record<string, { version: string }> };
    expect(lock.version).toBe(result.version);
    expect(lock.packages['']?.version).toBe(result.version);
    expect(readFileSync(f.output, 'utf8')).toContain(`sha=${result.sha}\n`);
    const push = calls.find(
      (call) => call.command === 'git' && call.args[0] === 'push',
    );
    expect(push?.args).toContain('--atomic');
    expect(push?.args).not.toContain('--force');
    expect(push?.env.GIT_CONFIG_VALUE_1).toContain(
      Buffer.from('x-access-token:test-write-credential').toString('base64'),
    );
    for (const call of calls) {
      expect(call.env.RELEASE_PUSH_TOKEN, call.command).toBeUndefined();
      expect(call.env.GITHUB_TOKEN, call.command).toBeUndefined();
      if (call.command === 'npm') {
        expect(call.env.GH_TOKEN).toBeUndefined();
        expect(call.args).toContain('--ignore-scripts');
      }
    }
  });

  it('suppresses the automatic tag-push build generated by the owning dispatch', () => {
    const f = fixture();
    const original = main(f.environment, f.work, f.invoke);
    const result = main(
      {
        ...f.environment,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: original.tag,
        GITHUB_SHA: original.sha,
        RELEASE_PUSH_TOKEN: undefined,
      },
      f.work,
      f.invoke,
    );
    expect(result).toMatchObject({
      sha: original.sha,
      publish: 'false',
      build: 'false',
    });
  });

  it('reuses an immutable unpublished tag only when rerunning its original dispatch', () => {
    const f = fixture();
    const original = main(f.environment, f.work, f.invoke);
    f.git(['checkout', '--detach', f.base]);
    expect(main(f.environment, f.work, f.invoke)).toEqual(original);
    expect(f.gitAt(f.remote, ['rev-parse', 'development'])).toBe(original.sha);
    expect(() =>
      main({ ...f.environment, GITHUB_RUN_ID: '124' }, f.work, f.invoke),
    ).toThrow(/does not belong/);
  });

  it('rejects a run-marked tag whose commit changes unrelated source files', () => {
    const f = fixture();
    execFileSync(
      'npm',
      ['version', '0.1.0-beta.10', '--no-git-tag-version', '--ignore-scripts'],
      { cwd: f.work, stdio: 'pipe' },
    );
    writeFileSync(path.join(f.work, 'unrelated.txt'), 'unexpected source edit');
    f.git(['add', '.']);
    f.git(['commit', '-m', 'Release-Workflow-Run: owner/repo/123']);
    f.git([
      'tag',
      '-a',
      'v0.1.0-beta.10',
      '-m',
      'Release-Workflow-Run: owner/repo/123',
    ]);
    f.git([
      'push',
      '--atomic',
      'origin',
      'development',
      'refs/tags/v0.1.0-beta.10',
    ]);
    f.git(['checkout', '--detach', f.base]);
    expect(() => main(f.environment, f.work, f.invoke)).toThrow(/only the two/);
  });

  it('preserves publication for ordinary unmarked matching tags', () => {
    const f = fixture();
    f.git(['tag', 'v0.1.0-beta.9']);
    f.git(['push', 'origin', 'refs/tags/v0.1.0-beta.9']);
    const context = main(
      {
        ...f.environment,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_NAME: 'v0.1.0-beta.9',
        RELEASE_PUSH_TOKEN: undefined,
      },
      f.work,
      f.invoke,
    );
    expect(context).toMatchObject({
      sha: f.base,
      publish: 'true',
      build: 'true',
      beta: 'true',
    });
  });

  it.each(['branch', 'tag'] as const)(
    'rejects a concurrent %s update atomically',
    (race) => {
      const f = fixture();
      const peer = path.join(f.root, 'peer');
      f.gitAt(f.root, ['clone', '--branch', 'development', f.remote, peer]);
      expect(() =>
        main(f.environment, f.work, (command, args, options) => {
          if (command === 'git' && args[0] === 'push') {
            if (race === 'branch') {
              f.gitAt(peer, [
                '-c',
                'user.name=Peer',
                '-c',
                'user.email=peer@example.invalid',
                'commit',
                '--allow-empty',
                '-m',
                'Concurrent change',
              ]);
              f.gitAt(peer, ['push', 'origin', 'development']);
            } else {
              f.gitAt(peer, ['tag', 'v0.1.0-beta.10']);
              f.gitAt(peer, ['push', 'origin', 'refs/tags/v0.1.0-beta.10']);
            }
          }
          return f.invoke(command, args, options);
        }),
      ).toThrow();
      const remoteHead = f.gitAt(f.remote, ['rev-parse', 'development']);
      if (race === 'branch') {
        expect(remoteHead).not.toBe(f.base);
        expect(
          f.git(['ls-remote', '--tags', 'origin', 'refs/tags/v0.1.0-beta.10']),
        ).toBe('');
      } else {
        expect(remoteHead).toBe(f.base);
        expect(f.gitAt(f.remote, ['rev-parse', 'v0.1.0-beta.10'])).toBe(f.base);
      }
      expect(readFileSync(f.output, 'utf8')).toBe('');
    },
  );

  it.each([
    { RELEASE_VERSION: '0.1.0-beta.8' },
    { RELEASE_VERSION: '0.1.0-beta.9' },
    { RELEASE_VERSION: 'not-a-version' },
    { RELEASE_PUSH_TOKEN: '' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: 'a'.repeat(40) },
    { GITHUB_OUTPUT: '' },
  ])(
    'rejects invalid publication before any version writes: %j',
    (override) => {
      const f = fixture();
      const before = readFileSync(path.join(f.work, 'package.json'), 'utf8');
      expect(() =>
        main({ ...f.environment, ...override }, f.work, f.invoke),
      ).toThrow();
      expect(readFileSync(path.join(f.work, 'package.json'), 'utf8')).toBe(
        before,
      );
      expect(f.gitAt(f.remote, ['rev-parse', 'development'])).toBe(f.base);
      expect(readFileSync(f.output, 'utf8')).toBe('');
    },
  );

  it('refuses a published release instead of updating assets', () => {
    const f = fixture();
    expect(() =>
      main(f.environment, f.work, (command, args, options) =>
        command === 'gh'
          ? JSON.stringify([[{ tag_name: 'v0.1.0-beta.10' }]])
          : f.invoke(command, args, options),
      ),
    ).toThrow(/already exists/);
    expect(f.git(['status', '--porcelain'])).toBe('');
    expect(readFileSync(f.output, 'utf8')).toBe('');
  });

  it('refuses a downgrade relative to published releases even when the checkout is older', () => {
    const f = fixture();
    expect(() =>
      main(f.environment, f.work, (command, args, options) =>
        command === 'gh'
          ? JSON.stringify([[{ tag_name: 'v0.1.0-beta.11' }]])
          : f.invoke(command, args, options),
      ),
    ).toThrow(/newer than every published/);
    expect(f.git(['status', '--porcelain'])).toBe('');
  });

  it('keeps dry runs unsigned and non-mutating without an administrator token', () => {
    const f = fixture();
    const result = main(
      {
        ...f.environment,
        RELEASE_DRY_RUN: 'true',
        RELEASE_VERSION: '',
        RELEASE_PUSH_TOKEN: undefined,
      },
      f.work,
      f.invoke,
    );
    expect(result).toMatchObject({
      sha: f.base,
      publish: 'false',
      stable: 'false',
      beta: 'false',
    });
    expect(f.git(['status', '--porcelain'])).toBe('');
    expect(f.gitAt(f.remote, ['rev-parse', 'development'])).toBe(f.base);
  });

  it('rejects a different dry-run version instead of stamping an uncommitted build', () => {
    const f = fixture();
    expect(() =>
      main({ ...f.environment, RELEASE_DRY_RUN: 'true' }, f.work, f.invoke),
    ).toThrow(/Dry runs use the tracked version/);
    expect(f.git(['status', '--porcelain'])).toBe('');
  });

  it.each(['invalid JSON', '{}', '[{}]', '[[{}]]'])(
    'refuses unreadable release inventory %s before writing versions',
    (response) => {
      const f = fixture();
      expect(() =>
        main(f.environment, f.work, (command, args, options) =>
          command === 'gh' ? response : f.invoke(command, args, options),
        ),
      ).toThrow();
      expect(f.git(['status', '--porcelain'])).toBe('');
      expect(f.gitAt(f.remote, ['rev-parse', 'development'])).toBe(f.base);
    },
  );

  it('reports a push permission failure without changing the remote branch or creating success outputs', () => {
    const f = fixture();
    expect(() =>
      main(f.environment, f.work, (command, args, options) => {
        if (command === 'git' && args[0] === 'push') {
          throw new Error(
            'GH006: protected branch update failed; administrator exemption unavailable',
          );
        }
        return f.invoke(command, args, options);
      }),
    ).toThrow(/GH006.*administrator exemption/);
    expect(f.gitAt(f.remote, ['rev-parse', 'development'])).toBe(f.base);
    expect(f.git(['ls-remote', '--tags', 'origin'])).toBe('');
    expect(readFileSync(f.output, 'utf8')).toBe('');
  });
  it('verifies the prepared checkout and tag rather than the dispatch SHA', () => {
    const f = fixture();
    const prepared = main(f.environment, f.work, f.invoke);
    const verify = {
      ...f.environment,
      RELEASE_VERIFY: 'true',
      RELEASE_PUBLISH: 'true',
      RELEASE_SHA: prepared.sha,
      RELEASE_VERSION: prepared.version,
    };
    expect(main(verify, f.work, f.invoke).sha).toBe(prepared.sha);
    f.git(['checkout', '--detach', f.base]);
    expect(() => main(verify, f.work, f.invoke)).toThrow();
  });

  it('rejects tag movement during tree verification', () => {
    const f = fixture();
    const prepared = main(f.environment, f.work, f.invoke);
    expect(() =>
      main(
        {
          ...f.environment,
          RELEASE_VERIFY: 'true',
          RELEASE_PUBLISH: 'true',
          RELEASE_SHA: prepared.sha,
          RELEASE_VERSION: prepared.version,
        },
        f.work,
        (command, args, options) =>
          command === 'git' && args[0] === 'ls-remote'
            ? `${f.base}\trefs/tags/${prepared.tag}`
            : f.invoke(command, args, options),
      ),
    ).toThrow(/Remote release tag moved/);
  });

  it('requires complete artifacts before creating a release', () => {
    const f = fixture();
    const prepared = main(f.environment, f.work, f.invoke);
    const verify = {
      ...f.environment,
      RELEASE_VERIFY_ARTIFACTS: 'true',
      RELEASE_PUBLISH: 'true',
      RELEASE_SHA: prepared.sha,
      RELEASE_VERSION: prepared.version,
    };
    mkdirSync(path.join(f.work, 'dist'));
    expect(() => main(verify, f.work, f.invoke)).toThrow();
    for (const asset of expectedReleaseAssets(prepared.version)) {
      writeFileSync(path.join(f.work, 'dist', asset), 'test artifact');
    }
    expect(main(verify, f.work, f.invoke).sha).toBe(prepared.sha);
    writeFileSync(path.join(f.work, 'dist', 'unexpected.zip'), 'unexpected');
    expect(() => main(verify, f.work, f.invoke)).toThrow();
  });
});

describe('published asset contract', () => {
  it.each(['1.2.3', '1.2.3-beta.1'])(
    'requires the exact assets for %s',
    (version) => {
      const context = releaseContext('a'.repeat(40), version, true);
      const release = {
        tag_name: context.tag,
        draft: false,
        prerelease: version.includes('-'),
        assets: expectedReleaseAssets(version).map((name) => ({ name })),
      };
      expect(() => verifyPublishedRelease(release, context)).not.toThrow();
      expect(() =>
        verifyPublishedRelease(
          { ...release, assets: release.assets.slice(1) },
          context,
        ),
      ).toThrow();
      expect(() =>
        verifyPublishedRelease(
          {
            ...release,
            assets: [...release.assets, { name: 'unexpected.zip' }],
          },
          context,
        ),
      ).toThrow();
    },
  );

  it('does not persist credentials or expose the push credential as a child variable', () => {
    const env = gitAuthenticationEnvironment('not-a-real-credential', {
      RELEASE_PUSH_TOKEN: 'not-a-real-credential',
      GH_TOKEN: 'read-only',
    });
    expect(env.RELEASE_PUSH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraheader');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});
