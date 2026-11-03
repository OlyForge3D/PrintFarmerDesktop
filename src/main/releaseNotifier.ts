import { z } from 'zod';
import { compareVersions } from './updateMetadata.js';
import { fetchBoundedText } from './updates.js';

/**
 * Notification-only release check: tells the user a newer build exists on
 * their release train. It never downloads or installs anything; the signed
 * {@link UpdateManager} remains the only install path.
 */

export const RELEASES_API_URL =
  'https://api.github.com/repos/OlyForge3D/PrintFarmerDesktop/releases?per_page=30';
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
    return lowered.some((name) => name.endsWith('.setup.exe'));
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

export interface ReleaseNotifierOptions {
  currentVersion: string;
  platform?: NodeJS.Platform;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  checkIntervalMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Caches the last check so the renderer can ask freely without exceeding the
 * unauthenticated GitHub API rate limit. Failures are logged and reported as
 * "nothing available" — a release check must never surface as an app error.
 */
export class ReleaseNotifier {
  private readonly currentVersion: string;
  private readonly platform: NodeJS.Platform;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly checkIntervalMs: number;
  private readonly onError: (error: unknown) => void;
  private lastCheckedAt: number | null = null;
  private lastResult: AvailableRelease | null = null;
  private inFlight: Promise<AvailableRelease | null> | null = null;

  constructor(options: ReleaseNotifierOptions) {
    this.currentVersion = options.currentVersion;
    this.platform = options.platform ?? process.platform;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.onError =
      options.onError ??
      ((error) => console.error('[releases] release check failed', error));
  }

  async getAvailableRelease(): Promise<AvailableRelease | null> {
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

  private async check(): Promise<AvailableRelease | null> {
    try {
      const payload = await fetchBoundedText(
        this.fetchImplementation,
        RELEASES_API_URL,
        MAX_RELEASES_BYTES,
      );
      this.lastResult = selectAvailableRelease(
        this.currentVersion,
        parseGitHubReleases(payload),
        this.platform,
      );
    } catch (error) {
      this.onError(error);
    }
    this.lastCheckedAt = this.now();
    return this.lastResult;
  }
}
