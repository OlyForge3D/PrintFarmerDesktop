import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CDPSession, type Page, type TestInfo } from '@playwright/test';

import {
  getCoverageManifest,
  sha256,
  type VisualRenderingProfile,
} from '../coverageManifest.js';
import { archiveVisualCandidate } from '../visualCandidateArchive.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
interface PinnedRenderingProfile {
  id: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  locale: string;
  timezone: string;
  colorScheme: 'dark' | 'light';
  reducedMotion: 'reduce' | 'no-preference';
}

const pageSessions = new WeakMap<Page, Promise<CDPSession>>();

interface RenderEnvironment {
  platform: string;
  userAgent: string;
  navigatorPlatform: string;
  locale: string;
  timezone: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  colorScheme: string;
  reducedMotion: string;
  fontStack: string;
  renderedPlatformFonts: Array<{
    familyName: string;
    postScriptName: string;
    isCustomFont: boolean;
  }>;
}

function platformName(): 'windows' | 'macos' {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  throw new Error(
    `Visual candidates are only configured for Windows and macOS, not ${process.platform}.`,
  );
}

function resolveRenderingProfile(
  profile: VisualRenderingProfile,
): PinnedRenderingProfile {
  return {
    id: profile.id,
    width: profile.viewportCssPixels.width,
    height: profile.viewportCssPixels.height,
    deviceScaleFactor: profile.deviceScaleFactor,
    locale: profile.locale,
    timezone: profile.timezone,
    colorScheme: profile.colorSchemePreference,
    reducedMotion: profile.reducedMotion,
  };
}

export async function applyPinnedRenderingProfile(
  page: Page,
  profileId = getCoverageManifest().renderingProfile.id,
): Promise<void> {
  const manifest = getCoverageManifest();
  const profileDefinition = [
    manifest.renderingProfile,
    ...manifest.additionalRenderingProfiles,
  ].find((candidate) => candidate.id === profileId);
  if (!profileDefinition) {
    throw new Error(`Unknown visual rendering profile: ${profileId}`);
  }
  const profile = resolveRenderingProfile(profileDefinition);
  await page.setViewportSize({
    width: profile.width,
    height: profile.height,
  });
  const session = await getPageSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: profile.deviceScaleFactor,
    mobile: false,
  });
  await session.send('Emulation.setLocaleOverride', {
    locale: profile.locale,
  });
  await session.send('Emulation.setTimezoneOverride', {
    timezoneId: profile.timezone,
  });
  await page.emulateMedia({
    colorScheme: profile.colorScheme,
    reducedMotion: profile.reducedMotion,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

function getPageSession(page: Page): Promise<CDPSession> {
  let session = pageSessions.get(page);
  if (!session) {
    session = page.context().newCDPSession(page);
    pageSessions.set(page, session);
  }
  return session;
}

async function readRenderEnvironment(
  page: Page,
  profile: PinnedRenderingProfile,
): Promise<RenderEnvironment> {
  const browser = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    navigatorPlatform: navigator.platform,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    deviceScaleFactor: Number(window.devicePixelRatio.toFixed(3)),
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'reduce'
      : 'no-preference',
    fontStack: getComputedStyle(document.documentElement).fontFamily,
  }));
  const session = await getPageSession(page);
  await session.send('DOM.enable');
  await session.send('CSS.enable');
  const { root } = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'body',
  });
  if (!nodeId) throw new Error('Could not locate body for font inspection.');
  const { nodeId: headingNodeId } = await session.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'h1',
  });
  const fontResults = await Promise.all(
    [...new Set([nodeId, headingNodeId].filter((id) => id !== undefined))].map(
      (fontNodeId) =>
        session.send('CSS.getPlatformFontsForNode', { nodeId: fontNodeId }),
    ),
  );
  const renderedPlatformFonts = fontResults
    .flatMap((result) => result.fonts)
    .map(
      (font: {
        familyName: string;
        postScriptName: string;
        isCustomFont: boolean;
      }) => ({
        familyName: font.familyName,
        postScriptName: font.postScriptName,
        isCustomFont: font.isCustomFont,
      }),
    )
    .filter(
      (
        font: RenderEnvironment['renderedPlatformFonts'][number],
        index: number,
        all: RenderEnvironment['renderedPlatformFonts'],
      ) =>
        all.findIndex(
          (item) =>
            item.familyName === font.familyName &&
            item.postScriptName === font.postScriptName &&
            item.isCustomFont === font.isCustomFont,
        ) === index,
    )
    .sort((a: RenderEnvironment['renderedPlatformFonts'][number], b) => {
      const left = `${a.familyName}/${a.postScriptName}`;
      const right = `${b.familyName}/${b.postScriptName}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });

  if (
    browser.viewport.width !== profile.width ||
    browser.viewport.height !== profile.height ||
    browser.deviceScaleFactor !== profile.deviceScaleFactor ||
    browser.locale !== profile.locale ||
    browser.timezone !== profile.timezone ||
    browser.colorScheme !== profile.colorScheme ||
    browser.reducedMotion !== profile.reducedMotion
  ) {
    throw new Error(
      `Visual profile drift: ${JSON.stringify({ browser, expected: profile })}`,
    );
  }
  if (renderedPlatformFonts.length === 0) {
    throw new Error(
      `Chromium did not report rendered platform fonts; candidate cannot be environment-pinned (fontStack=${browser.fontStack}).`,
    );
  }
  return {
    platform: platformName(),
    ...browser,
    renderedPlatformFonts,
  };
}

function pngSize(image: Buffer): { width: number; height: number } {
  if (
    image.length < 24 ||
    image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  ) {
    throw new Error('Screenshot candidate is not a valid PNG.');
  }
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
  };
}

export async function captureVisualScenario(
  page: Page,
  scenarioId: string,
  testInfo: TestInfo,
): Promise<void> {
  const scenario = getCoverageManifest().scenarios.find(
    (item) => item.id === scenarioId,
  );
  if (!scenario)
    throw new Error(`Unknown visual coverage scenario: ${scenarioId}`);

  const manifest = getCoverageManifest();
  const profileId = scenario.renderingProfileId ?? manifest.renderingProfile.id;
  const profileDefinition = [
    manifest.renderingProfile,
    ...manifest.additionalRenderingProfiles,
  ].find((candidate) => candidate.id === profileId);
  if (!profileDefinition) {
    throw new Error(`Unknown visual rendering profile: ${profileId}`);
  }
  const profile = resolveRenderingProfile(profileDefinition);
  await applyPinnedRenderingProfile(page, profile.id);
  const screenshot = Buffer.from(
    await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      fullPage: true,
      scale: 'css',
      type: 'png',
    }),
  );
  const environment = await readRenderEnvironment(page, profile);
  const environmentSha256 = sha256(JSON.stringify(environment));
  const screenshotSize = pngSize(screenshot);
  if (
    screenshotSize.width !== profile.width ||
    screenshotSize.height !== profile.height
  ) {
    throw new Error(
      `Candidate ${scenarioId} has unexpected PNG dimensions ${screenshotSize.width}x${screenshotSize.height}; expected ${profile.width}x${profile.height}.`,
    );
  }

  const candidateDirectory = path.resolve(
    repoRoot,
    'test-results',
    'visual-candidates',
  );
  mkdirSync(candidateDirectory, { recursive: true });
  const candidateFileName = `${platformName()}-${scenarioId}`;
  const candidateImagePath = path.join(
    candidateDirectory,
    `${candidateFileName}.png`,
  );
  const candidateMetadataPath = path.join(
    candidateDirectory,
    `${candidateFileName}.json`,
  );
  const candidateMetadata: Record<string, unknown> = {
    schemaVersion: 1,
    scenarioId,
    renderingProfileId: profile.id,
    screenshotPolicy: 'temporary-review-evidence',
    candidateSha256: sha256(screenshot),
    environmentSha256,
    environment,
    candidateImagePath: path
      .relative(repoRoot, candidateImagePath)
      .replaceAll(path.sep, '/'),
    dimensionsExercised: scenario.dimensionsExercised,
    trigger: scenario.trigger,
    expectedState: scenario.expectedState,
    fixture: scenario.fixture,
    axe: scenario.axe,
  };
  const archiveRoot = path.resolve(repoRoot, 'artifacts', 'ui-coverage-review');
  const archive = archiveVisualCandidate(archiveRoot, {
    platform: platformName(),
    scenarioId,
    surfaceId: scenario.surfaceId,
    stateId: scenario.stateId,
    dimensionsExercised: scenario.dimensionsExercised,
    image: screenshot,
    metadata: candidateMetadata,
  });
  candidateMetadata.archivedImagePath = path
    .relative(repoRoot, archive.imagePath)
    .replaceAll(path.sep, '/');
  candidateMetadata.archivedMetadataPath = path
    .relative(repoRoot, archive.metadataPath)
    .replaceAll(path.sep, '/');
  candidateMetadata.reviewIndexPath = path
    .relative(repoRoot, archive.indexPath)
    .replaceAll(path.sep, '/');
  writeFileSync(candidateImagePath, screenshot);
  writeFileSync(
    candidateMetadataPath,
    JSON.stringify(candidateMetadata, null, 2),
  );
  await testInfo.attach(`candidate-${scenarioId}.png`, {
    path: candidateImagePath,
  });
  await testInfo.attach(`candidate-${scenarioId}.json`, {
    path: candidateMetadataPath,
  });
  testInfo.annotations.push({
    type: 'screenshot-evidence',
    description: `${scenarioId}: temporary review evidence; no pixel comparison or approval gate`,
  });
}
