// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LATEST_RELEASE_API_URL,
  RELEASES_API_URL,
  ReleaseNotifier,
  hasInstallerForPlatform,
  isEligibleRelease,
  parseGitHubReleases,
  releaseTrain,
  selectAvailableRelease,
  type GitHubRelease,
} from '../src/main/releaseNotifier.js';

function assetsFor(version: string): { name: string }[] {
  return [
    { name: `PrintFarmer.Desktop-${version}-universal.dmg` },
    { name: `PrintFarmer.Desktop-${version}.Setup.exe` },
    { name: `PrintFarmer.Desktop-darwin-universal-${version}.zip` },
    { name: `PrintFarmer.Desktop-win32-x64-${version}.zip` },
  ];
}

function release(
  version: string,
  overrides: Partial<GitHubRelease> = {},
): GitHubRelease {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes('-'),
    published_at: '2026-11-03T18:14:21Z',
    assets: assetsFor(version),
    ...overrides,
  };
}

describe('releaseTrain', () => {
  it('derives the train from the running version', () => {
    expect(releaseTrain('0.1.0-beta.8')).toBe('beta');
    expect(releaseTrain('0.1.0-rc.1')).toBe('rc');
    expect(releaseTrain('0.1.0')).toBeNull();
    expect(releaseTrain('1.2.3+build.5')).toBeNull();
  });

  it('rejects versions that are not semver', () => {
    expect(() => releaseTrain('beta')).toThrow();
  });
});

describe('isEligibleRelease', () => {
  it.each([
    ['0.1.0-beta.8', '0.1.0-beta.9', true],
    ['0.1.0-beta.9', '0.1.0-beta.10', true],
    ['0.1.0-beta.8', '0.1.0', true],
    ['0.1.0-beta.8', '0.2.0', true],
    ['0.1.0-beta.8', '0.2.0-beta.1', true],
    ['0.1.0-beta.8', '0.1.0-beta.7', false],
    ['0.1.0-beta.10', '0.1.0-beta.9', false],
    ['0.1.0-beta.8', '0.1.0-beta.8', false],
    ['0.1.0-beta.8', '0.1.0-rc.1', false],
    ['0.1.0-rc.1', '0.1.0-rc.2', true],
    ['0.1.0', '0.1.1-beta.1', false],
    ['0.1.0', '0.1.1', true],
    ['0.1.0', '0.1.0', false],
    ['0.1.1', '0.1.0', false],
    ['0.1.0', '0.1.0-beta.10', false],
  ])('%s → %s notifies: %s', (current, candidate, expected) => {
    expect(isEligibleRelease(current, candidate)).toBe(expected);
  });
});

describe('hasInstallerForPlatform', () => {
  const names = assetsFor('0.1.0').map((asset) => asset.name);

  it('matches the platform installer', () => {
    expect(hasInstallerForPlatform(names, 'win32')).toBe(true);
    expect(hasInstallerForPlatform(names, 'darwin')).toBe(true);
    expect(
      hasInstallerForPlatform(
        ['PrintFarmer.Desktop-0.1.0.Setup.exe'],
        'darwin',
      ),
    ).toBe(false);
    expect(hasInstallerForPlatform(names, 'linux')).toBe(false);
  });

  it('matches the signed Windows installer name, which contains a space', () => {
    expect(
      hasInstallerForPlatform(['PrintFarmer Desktop-0.1.0 Setup.exe'], 'win32'),
    ).toBe(true);
  });
});

describe('selectAvailableRelease', () => {
  it('picks the highest eligible release by semver, not list order', () => {
    const selected = selectAvailableRelease(
      '0.1.0-beta.8',
      [
        release('0.1.0-beta.9'),
        release('0.1.0-beta.10'),
        release('0.1.0-beta.7'),
      ],
      'darwin',
    );
    expect(selected).toEqual({
      version: '0.1.0-beta.10',
      prerelease: true,
      url: 'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/tag/v0.1.0-beta.10',
      publishedAt: '2026-11-03T18:14:21Z',
    });
  });

  it('prefers a stable release over the betas that precede it', () => {
    expect(
      selectAvailableRelease(
        '0.1.0-beta.8',
        [release('0.1.0-beta.10'), release('0.1.0')],
        'win32',
      )?.version,
    ).toBe('0.1.0');
  });

  it('never offers prereleases to stable users', () => {
    expect(
      selectAvailableRelease(
        '0.1.0',
        [release('0.1.1-beta.1'), release('0.2.0-beta.1')],
        'win32',
      ),
    ).toBeNull();
  });

  it('ignores drafts, equal or older versions, and bad tags', () => {
    expect(
      selectAvailableRelease(
        '0.1.0-beta.8',
        [
          release('0.1.0-beta.9', { draft: true }),
          release('0.1.0-beta.8'),
          release('0.1.0-beta.7'),
          release('0.1.0-beta.9', { tag_name: 'nightly' }),
        ],
        'win32',
      ),
    ).toBeNull();
  });

  it('ignores releases whose prerelease flag contradicts the version', () => {
    expect(
      selectAvailableRelease(
        '0.1.0',
        [release('0.1.1', { prerelease: true })],
        'win32',
      ),
    ).toBeNull();
  });

  it('ignores releases without an installer for this platform', () => {
    expect(
      selectAvailableRelease(
        '0.1.0-beta.8',
        [
          release('0.1.0-beta.9', {
            assets: [{ name: 'PrintFarmer.Desktop-0.1.0-beta.9.Setup.exe' }],
          }),
        ],
        'darwin',
      ),
    ).toBeNull();
  });
});

describe('parseGitHubReleases', () => {
  it('drops malformed entries instead of failing the whole check', () => {
    const parsed = parseGitHubReleases(
      JSON.stringify([release('0.1.0-beta.9'), { tag_name: 5 }]),
    );
    expect(parsed).toHaveLength(1);
  });

  it('rejects a non-array payload', () => {
    expect(() => parseGitHubReleases('{"message":"rate limited"}')).toThrow();
  });
});

describe('ReleaseNotifier', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function githubFake(
    list: GitHubRelease[],
    latest: GitHubRelease | null = null,
  ): ReturnType<typeof vi.fn<typeof fetch>> {
    return vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        input === LATEST_RELEASE_API_URL
          ? latest
            ? jsonResponse(latest)
            : jsonResponse({ message: 'Not Found' }, 404)
          : jsonResponse(list),
      ),
    );
  }

  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'pf-release-check-'));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('fetches GitHub releases and caches the result between checks', async () => {
    let now = 0;
    const fetchImplementation = githubFake([release('0.1.0-beta.9')]);
    const notifier = new ReleaseNotifier({
      currentVersion: '0.1.0-beta.8',
      platform: 'darwin',
      fetchImplementation,
      now: () => now,
      checkIntervalMs: 1000,
    });

    expect((await notifier.getAvailableRelease())?.version).toBe(
      '0.1.0-beta.9',
    );
    expect(await notifier.getAvailableRelease()).not.toBeNull();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(
      fetchImplementation.mock.calls.map((call) => call[0]).sort(),
    ).toEqual([LATEST_RELEASE_API_URL, RELEASES_API_URL].sort());

    now = 1000;
    await notifier.getAvailableRelease();
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });

  it('finds a stable release that fell off the first page of prereleases', async () => {
    const notifier = new ReleaseNotifier({
      currentVersion: '0.1.0',
      platform: 'win32',
      fetchImplementation: githubFake(
        [release('0.2.0-beta.40'), release('0.2.0-beta.39')],
        release('0.1.1'),
      ),
    });
    expect((await notifier.getAvailableRelease())?.version).toBe('0.1.1');
  });

  it('treats a missing latest stable release as nothing extra', async () => {
    const onError = vi.fn();
    const notifier = new ReleaseNotifier({
      currentVersion: '0.1.0-beta.8',
      platform: 'win32',
      fetchImplementation: githubFake([release('0.1.0-beta.9')]),
      onError,
    });
    expect((await notifier.getAvailableRelease())?.version).toBe(
      '0.1.0-beta.9',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('remembers the last check across restarts', async () => {
    const cacheFilePath = path.join(cacheDir, 'release-check.json');
    const first = githubFake([release('0.1.0-beta.9')]);
    await new ReleaseNotifier({
      currentVersion: '0.1.0-beta.8',
      platform: 'darwin',
      fetchImplementation: first,
      now: () => 100,
      cacheFilePath,
    }).getAvailableRelease();

    const second = githubFake([]);
    const restarted = new ReleaseNotifier({
      currentVersion: '0.1.0-beta.8',
      platform: 'darwin',
      fetchImplementation: second,
      now: () => 200,
      cacheFilePath,
    });
    expect((await restarted.getAvailableRelease())?.version).toBe(
      '0.1.0-beta.9',
    );
    expect(second).not.toHaveBeenCalled();
  });

  it('ignores a remembered check from a different installed version', async () => {
    const cacheFilePath = path.join(cacheDir, 'release-check.json');
    await writeFile(
      cacheFilePath,
      JSON.stringify({
        currentVersion: '0.1.0-beta.7',
        checkedAt: 100,
        result: null,
      }),
    );
    const fetchImplementation = githubFake([release('0.1.0-beta.9')]);
    const notifier = new ReleaseNotifier({
      currentVersion: '0.1.0-beta.9',
      platform: 'darwin',
      fetchImplementation,
      now: () => 200,
      cacheFilePath,
    });
    expect(await notifier.getAvailableRelease()).toBeNull();
    expect(fetchImplementation).toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(cacheFilePath, 'utf8')) as unknown,
    ).toMatchObject({ currentVersion: '0.1.0-beta.9', checkedAt: 200 });
  });

  it('stays silent on network failure', async () => {
    const onError = vi.fn();
    const notifier = new ReleaseNotifier({
      currentVersion: '0.1.0-beta.8',
      platform: 'win32',
      fetchImplementation: vi.fn<typeof fetch>(() =>
        Promise.resolve(jsonResponse({ message: 'rate limited' }, 403)),
      ),
      onError,
    });

    await expect(notifier.getAvailableRelease()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  describe('checkNow', () => {
    it('waits for the persisted cache load before starting a manual check', async () => {
      const cacheFilePath = path.join(cacheDir, 'release-check.json');
      await writeFile(
        cacheFilePath,
        JSON.stringify({
          currentVersion: '0.1.0-beta.8',
          checkedAt: 150,
          result: null,
        }),
      );
      let finishRead: (value: string) => void = () => {};
      const delayedRead = new Promise<string>((resolve) => {
        finishRead = resolve;
      });
      const readSpy = vi
        .spyOn(fs, 'readFile')
        .mockImplementationOnce(() => delayedRead);
      const fetchImplementation = githubFake([release('0.1.0-beta.10')]);
      const notifier = new ReleaseNotifier({
        currentVersion: '0.1.0-beta.8',
        platform: 'darwin',
        fetchImplementation,
        now: () => 200,
        checkIntervalMs: 1000,
        cacheFilePath,
      });

      try {
        const passiveCheck = notifier.getAvailableRelease();
        await vi.waitFor(() => expect(readSpy).toHaveBeenCalledOnce());
        const manualCheck = notifier.checkNow();
        await Promise.resolve();
        expect(fetchImplementation).not.toHaveBeenCalled();

        finishRead(
          JSON.stringify({
            currentVersion: '0.1.0-beta.8',
            checkedAt: 150,
            result: null,
          }),
        );
        await expect(manualCheck).resolves.toMatchObject({
          failed: false,
          release: { version: '0.1.0-beta.10' },
        });
        await expect(passiveCheck).resolves.toBeNull();
        await expect(notifier.getAvailableRelease()).resolves.toMatchObject({
          version: '0.1.0-beta.10',
        });
      } finally {
        readSpy.mockRestore();
      }
    });

    it('does not let an older background response replace a manual result', async () => {
      const pendingResponses: ((response: Response) => void)[] = [];
      const fetchImplementation = vi.fn<typeof fetch>(
        () =>
          new Promise((resolve) => {
            pendingResponses.push(resolve);
          }),
      );
      const notifier = new ReleaseNotifier({
        currentVersion: '0.1.0-beta.8',
        platform: 'darwin',
        fetchImplementation,
      });

      const backgroundCheck = notifier.getAvailableRelease();
      await vi.waitFor(() =>
        expect(fetchImplementation).toHaveBeenCalledTimes(2),
      );
      const manualCheck = notifier.checkNow();
      await vi.waitFor(() =>
        expect(fetchImplementation).toHaveBeenCalledTimes(4),
      );

      pendingResponses[2]?.(jsonResponse([release('0.1.0-beta.10')]));
      pendingResponses[3]?.(jsonResponse({ message: 'Not Found' }, 404));
      await expect(manualCheck).resolves.toMatchObject({
        failed: false,
        release: { version: '0.1.0-beta.10' },
      });

      pendingResponses[0]?.(jsonResponse([release('0.1.0-beta.9')]));
      pendingResponses[1]?.(jsonResponse({ message: 'Not Found' }, 404));
      await expect(backgroundCheck).resolves.toMatchObject({
        version: '0.1.0-beta.10',
      });
      await expect(notifier.getAvailableRelease()).resolves.toMatchObject({
        version: '0.1.0-beta.10',
      });
    });
    it('prevents an older background check from replacing the manual result', async () => {
      const pendingResponses: ((response: Response) => void)[] = [];
      const fetchImplementation = vi.fn<typeof fetch>(
        () =>
          new Promise((resolve) => {
            pendingResponses.push(resolve);
          }),
      );
      const notifier = new ReleaseNotifier({
        currentVersion: '0.1.0-beta.8',
        platform: 'darwin',
        fetchImplementation,
      });

      const backgroundCheck = notifier.getAvailableRelease();
      await vi.waitFor(() =>
        expect(fetchImplementation).toHaveBeenCalledTimes(2),
      );
      const manualCheck = notifier.checkNow();
      await vi.waitFor(() =>
        expect(fetchImplementation).toHaveBeenCalledTimes(4),
      );

      pendingResponses[2]?.(jsonResponse([release('0.1.0-beta.10')]));
      pendingResponses[3]?.(jsonResponse({ message: 'Not Found' }, 404));
      await expect(manualCheck).resolves.toMatchObject({
        failed: false,
        release: { version: '0.1.0-beta.10' },
      });

      pendingResponses[0]?.(jsonResponse([release('0.1.0-beta.9')]));
      pendingResponses[1]?.(jsonResponse({ message: 'Not Found' }, 404));
      await expect(backgroundCheck).resolves.toMatchObject({
        version: '0.1.0-beta.10',
      });
      await expect(notifier.getAvailableRelease()).resolves.toMatchObject({
        version: '0.1.0-beta.10',
      });
    });

    it('bypasses a fresh cache, refreshes it, and reports a newer release', async () => {
      const now = 0;
      const fetchImplementation = githubFake([]);
      const notifier = new ReleaseNotifier({
        currentVersion: '0.1.0-beta.8',
        platform: 'darwin',
        fetchImplementation,
        now: () => now,
        checkIntervalMs: 6 * 60 * 60 * 1000,
      });
      expect(await notifier.getAvailableRelease()).toBeNull();
      expect(fetchImplementation).toHaveBeenCalledTimes(2);

      // A release lands inside the cache window.
      fetchImplementation.mockImplementation(
        githubFake([release('0.1.0-beta.9')]),
      );
      expect(
        (await notifier.getAvailableRelease())?.version ?? null,
      ).toBeNull();
      expect(fetchImplementation).toHaveBeenCalledTimes(2);

      const result = await notifier.checkNow();
      expect(result.failed).toBe(false);
      expect(result.release?.version).toBe('0.1.0-beta.9');
      expect(fetchImplementation).toHaveBeenCalledTimes(4);
      // The refreshed result now serves the cached path.
      expect((await notifier.getAvailableRelease())?.version).toBe(
        '0.1.0-beta.9',
      );
      expect(fetchImplementation).toHaveBeenCalledTimes(4);
    });

    it('reports up to date as a successful check with no release', async () => {
      const notifier = new ReleaseNotifier({
        currentVersion: '0.1.0-beta.9',
        platform: 'darwin',
        fetchImplementation: githubFake([release('0.1.0-beta.9')]),
      });
      await expect(notifier.checkNow()).resolves.toEqual({
        failed: false,
        release: null,
      });
    });

    it('reports failure and keeps the previous cached result', async () => {
      const onError = vi.fn();
      const good = githubFake([release('0.1.0-beta.9')]);
      const fetchImplementation = vi.fn<typeof fetch>(good);
      const notifier = new ReleaseNotifier({
        currentVersion: '0.1.0-beta.8',
        platform: 'darwin',
        fetchImplementation,
        onError,
      });
      expect((await notifier.getAvailableRelease())?.version).toBe(
        '0.1.0-beta.9',
      );

      fetchImplementation.mockImplementation(() =>
        Promise.resolve(jsonResponse({ message: 'rate limited' }, 403)),
      );
      const result = await notifier.checkNow();
      expect(result.failed).toBe(true);
      expect(onError).toHaveBeenCalledOnce();
      expect(result.release?.version).toBe('0.1.0-beta.9');
    });
  });
});
