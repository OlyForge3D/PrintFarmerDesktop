import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { compareVersions } from './updateMetadata.js';
import { fetchBoundedText, UpdateHttpError } from './updates.js';

/**
 * Notification-only release check: tells the user a newer build exists on
 * their release train. It never downloads or installs anything; the signed
 * {@link UpdateManager} remains the only install path.
 */

export const RELEASES_API_URL =
  'https://api.github.com/repos/OlyForge3D/PrintFarmerDesktop/releases?per_page=100';
/**
 * The newest stable release, fetched alongside the list so a stable release
 * cannot fall off the first page behind a long run of prereleases. GitHub
 * answers 404 while no stable release exists.
 */
export const LATEST_RELEASE_API_URL =
  'https://api.github.com/repos/OlyForge3D/PrintFarmerDesktop/releases/latest';
const RELEASE_PAGE_BASE =
  'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/tag/';
const MAX_RELEASES_BYTES = 4 * 1024 * 1024;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AvailableRelease {
  version: string;
  prerelease: boolean;
  url: string;
  publishedAt: string | null;
}

const GitHubRelease = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable().optional(),
  assets: z.array(z.object({ name: z.string() })).default([]),
});
export type GitHubRelease = z.infer<typeof GitHubRelease>;

/**
 * The release train a version belongs to: `null` for stable, otherwise the
 * first prerelease identifier (`0.1.0-beta.8` → `beta`). Throws on a version
 * that is not valid semver.
 */
export function releaseTrain(version: string): string | null {
  compareVersions(version, version);
  const prerelease = /^[^-+]+-([^+]+)/.exec(version)?.[1];
  if (!prerelease) return null;
  return prerelease.split('.')[0] ?? null;
}

/**
 * Whether `candidate` should be offered to a user running `current`. Stable
 * users see only newer stable releases; prerelease users see newer releases on
 * their own train plus newer stable releases.
 */
export function isEligibleRelease(current: string, candidate: string): boolean {
  if (compareVersions(candidate, current) <= 0) return false;
  const candidateTrain = releaseTrain(candidate);
  if (candidateTrain === null) return true;
  return candidateTrain === releaseTrain(current);
}

/** True when the release carries an installer for the running platform. */
export function hasInstallerForPlatform(
  assetNames: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  const lowered = assetNames.map((name) => name.toLowerCase());
  if (platform === 'win32') {
    // Squirrel names it `<product>-<version> Setup.exe`; GitHub stores
    // uploaded asset names with the space replaced by a dot.
    return lowered.some((name) => name.endsWith('setup.exe'));
  }
  if (platform === 'darwin') {
    return lowered.some((name) => name.endsWith('.dmg'));
  }
  return false;
}

function tagToVersion(tag: string): string | null {
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  try {
    compareVersions(version, version);
    return version;
  } catch {
    return null;
  }
}

/**
 * Pick the highest release the user should be told about, or `null`. Drafts,
 * unparseable tags, releases whose GitHub prerelease flag contradicts their
 * version, and releases without an installer for this platform are ignored.
 */
export function selectAvailableRelease(
  currentVersion: string,
  releases: readonly GitHubRelease[],
  platform: NodeJS.Platform,
): AvailableRelease | null {
  let best: AvailableRelease | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    const version = tagToVersion(release.tag_name);
    if (version === null) continue;
    const isPrerelease = releaseTrain(version) !== null;
    if (release.prerelease !== isPrerelease) continue;
    if (!isEligibleRelease(currentVersion, version)) continue;
    if (
      !hasInstallerForPlatform(
        release.assets.map((asset) => asset.name),
        platform,
      )
    ) {
      continue;
    }
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = {
      version,
      prerelease: isPrerelease,
      url: RELEASE_PAGE_BASE + encodeURIComponent(release.tag_name),
      publishedAt: release.published_at ?? null,
    };
  }
  return best;
}

export function parseGitHubReleases(payload: string): GitHubRelease[] {
  const decoded: unknown = JSON.parse(payload);
  if (!Array.isArray(decoded)) {
    throw new Error('GitHub releases response is not an array');
  }
  const releases: GitHubRelease[] = [];
  for (const entry of decoded) {
    const parsed = GitHubRelease.safeParse(entry);
    if (parsed.success) releases.push(parsed.data);
  }
  return releases;
}

const PersistedCheck = z.object({
  currentVersion: z.string(),
  checkedAt: z.number(),
  result: z
    .object({
      version: z.string(),
      prerelease: z.boolean(),
      url: z.string(),
      publishedAt: z.string().nullable(),
    })
    .nullable(),
});

export interface ManualCheckResult {
  /** True when the release list or latest stable release could not be checked. */
  failed: boolean;
  /** The newer release on this train, or the last known result on failure. */
  release: AvailableRelease | null;
}

export interface ReleaseNotifierOptions {
  currentVersion: string;
  platform?: NodeJS.Platform;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  checkIntervalMs?: number;
  /**
   * Where the last check is remembered across restarts, so relaunching the app
   * does not re-query the unauthenticated (60 requests/hour/IP) GitHub API.
   */
  cacheFilePath?: string;
  onError?: (error: unknown) => void;
}

/**
 * Caches the last check so the renderer can ask freely without exceeding the
 * unauthenticated GitHub API rate limit. Failures are logged without refreshing
 * the cache; manual checks report failure, while background checks retain the
 * last known result without surfacing an app error.
 */
export class ReleaseNotifier {
  private readonly currentVersion: string;
  private readonly platform: NodeJS.Platform;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly checkIntervalMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly cacheFilePath: string | null;
  private cacheLoaded = false;
  private cacheLoadPromise: Promise<void> | null = null;
  private lastCheckedAt: number | null = null;
  private lastResult: AvailableRelease | null = null;
  private inFlight: Promise<AvailableRelease | null> | null = null;
  private manualCheckGeneration = 0;
  private manualChecksInFlight = 0;

  constructor(options: ReleaseNotifierOptions) {
    this.currentVersion = options.currentVersion;
    this.platform = options.platform ?? process.platform;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.onError =
      options.onError ??
      ((error) => console.error('[releases] release check failed', error));
    this.cacheFilePath = options.cacheFilePath ?? null;
  }

  async getAvailableRelease(): Promise<AvailableRelease | null> {
    await this.loadPersistedCheck();
    if (
      this.lastCheckedAt !== null &&
      this.now() - this.lastCheckedAt < this.checkIntervalMs
    ) {
      return this.lastResult;
    }
    this.inFlight ??= this.check().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private loadPersistedCheck(): Promise<void> {
    if (this.cacheLoaded) return Promise.resolve();
    if (!this.cacheLoadPromise) {
      this.cacheLoadPromise = this.readPersistedCheck().finally(() => {
        this.cacheLoaded = true;
      });
    }
    return this.cacheLoadPromise;
  }

  private async readPersistedCheck(): Promise<void> {
    if (this.cacheFilePath === null) return;
    try {
      const parsed = PersistedCheck.safeParse(
        JSON.parse(await fs.readFile(this.cacheFilePath, 'utf8')),
      );
      if (
        !parsed.success ||
        parsed.data.currentVersion !== this.currentVersion ||
        parsed.data.checkedAt > this.now()
      ) {
        return;
      }
      const cached = parsed.data.result;
      // Re-derive rather than trust the file: only a release this build would
      // still be offered survives.
      this.lastResult =
        cached &&
        cached.url.startsWith(RELEASE_PAGE_BASE) &&
        isEligibleRelease(this.currentVersion, cached.version)
          ? cached
          : null;
      this.lastCheckedAt = parsed.data.checkedAt;
    } catch {
      // Missing or unreadable cache: check the network instead.
    }
  }

  /**
   * User-initiated check: always queries the network, ignoring and then
   * refreshing the cache. Unlike the background path it reports failure, so the
   * caller can tell "up to date" from "could not check". A failed manual check
   * leaves the cache untouched.
   */
  async checkNow(): Promise<ManualCheckResult> {
    await this.loadPersistedCheck();
    const generation = ++this.manualCheckGeneration;
    this.manualChecksInFlight += 1;
    try {
      const release = await this.fetchAvailableRelease();
      if (generation === this.manualCheckGeneration) {
        this.lastResult = release;
        this.lastCheckedAt = this.now();
        await this.persistCheck();
      }
      return { failed: false, release };
    } catch (error) {
      this.onError(error);
      return { failed: true, release: this.lastResult };
    } finally {
      this.manualChecksInFlight -= 1;
    }
  }

  private async fetchAvailableRelease(): Promise<AvailableRelease | null> {
    const [list, latest] = await Promise.allSettled([
      fetchBoundedText(
        this.fetchImplementation,
        RELEASES_API_URL,
        MAX_RELEASES_BYTES,
      ),
      fetchBoundedText(
        this.fetchImplementation,
        LATEST_RELEASE_API_URL,
        MAX_RELEASES_BYTES,
      ),
    ]);
    if (list.status === 'rejected') throw list.reason;
    const releases = parseGitHubReleases(list.value);
    if (latest.status === 'fulfilled') {
      releases.push(...parseGitHubReleases(`[${latest.value}]`));
    } else if (!(
      latest.reason instanceof UpdateHttpError && latest.reason.status === 404
    )) {
      throw latest.reason;
    }
    return selectAvailableRelease(this.currentVersion, releases, this.platform);
  }

  private async check(): Promise<AvailableRelease | null> {
    const generation = this.manualCheckGeneration;
    const startedDuringManualCheck = this.manualChecksInFlight > 0;
    let result = this.lastResult;
    try {
      result = await this.fetchAvailableRelease();
    } catch (error) {
      this.onError(error);
      return this.lastResult;
    }
    if (
      startedDuringManualCheck ||
      generation !== this.manualCheckGeneration ||
      this.manualChecksInFlight > 0
    ) {
      return this.lastResult;
    }
    this.lastResult = result;
    this.lastCheckedAt = this.now();
    await this.persistCheck();
    return this.lastResult;
  }

  private async persistCheck(): Promise<void> {
    if (this.cacheFilePath === null || this.lastCheckedAt === null) return;
    try {
      await fs.writeFile(
        this.cacheFilePath,
        JSON.stringify({
          currentVersion: this.currentVersion,
          checkedAt: this.lastCheckedAt,
          result: this.lastResult,
        }),
      );
    } catch (error) {
      this.onError(error);
    }
  }
}
