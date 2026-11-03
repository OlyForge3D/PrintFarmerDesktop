// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
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

  it('fetches GitHub releases and caches the result between checks', async () => {
    let now = 0;
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse([release('0.1.0-beta.9')])),
    );
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
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(RELEASES_API_URL);

    now = 1000;
    await notifier.getAvailableRelease();
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
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
});
