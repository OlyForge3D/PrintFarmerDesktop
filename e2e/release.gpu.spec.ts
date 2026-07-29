import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupPackagedApp,
  createPackagedProcessLog,
  launchPackagedApp,
  packagedGpuModeFromEnvironment,
  type PackagedApp,
  type PackagedProcessLog,
  runWithPackagedTestCleanup,
} from './helpers/packagedApp';
import {
  importModelFixture,
  modelFixtureDirectory,
  modelFixtureName,
} from './helpers/modelLibrary';
import { findPackagedExecutable } from './helpers/retargetFixture';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const requestedGpuMode = process.env.PRINTFARMER_E2E_GPU_MODE ?? 'default';

test(`@gpu packaged WebGL2 renders and interacts in ${requestedGpuMode} mode`, async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(120_000);

  let root: string | null = null;
  let launched: PackagedApp | null = null;
  let processLog: PackagedProcessLog | null = null;

  await runWithPackagedTestCleanup(
    async () => {
      processLog = createPackagedProcessLog();
      const gpuMode = packagedGpuModeFromEnvironment();
      root = mkdtempSync(path.join(tmpdir(), `pf-gpu-${gpuMode}-`));
      const userDataPath = path.join(root, 'user-data');
      const catalogDb = path.join(root, 'catalog.sqlite3');
      mkdirSync(userDataPath, { recursive: true });
      launched = await launchPackagedApp({
        executablePath: findPackagedExecutable(repoRoot),
        userDataPath,
        catalogDb,
        gpuMode,
        processLog,
        environment: {
          PRINTFARMER_E2E: '1',
          PRINTFARMER_E2E_OPEN_DIALOGS: JSON.stringify([modelFixtureDirectory]),
        },
      });
      const onboarding = launched.page.getByRole('dialog', {
        name: 'Set up your model library',
      });
      await expect(onboarding).toBeVisible();
      await launched.page.getByRole('button', { name: 'Maybe later' }).click();
      await expect(onboarding).toHaveCount(0);
      await importModelFixture(
        launched.page,
        `packaged-gpu-${gpuMode}-fixtures`,
      );

      await launched.page
        .getByRole('button', { name: `Select ${modelFixtureName}` })
        .click();
      const previewButton = launched.page
        .getByLabel('Model properties')
        .getByRole('button', { name: 'Preview in 3D' });
      await previewButton.click();
      const viewer = launched.page.getByRole('application', {
        name: /3D model preview/i,
      });
      await expect(viewer).toBeVisible();
      const canvas = viewer.locator('canvas');
      await expect(canvas).toBeVisible();

      const capability = await canvas.evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement)) {
          throw new Error('3D viewer did not mount a canvas.');
        }
        const gl = element.getContext('webgl2');
        if (!gl) {
          return {
            webgl2: false,
            vendor: '',
            renderer: '',
            version: '',
            shadingLanguageVersion: '',
            antialias: false,
          };
        }
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          webgl2:
            typeof WebGL2RenderingContext !== 'undefined' &&
            gl instanceof WebGL2RenderingContext,
          vendor: String(
            gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
          ),
          renderer: String(
            gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
          ),
          version: String(gl.getParameter(gl.VERSION)),
          shadingLanguageVersion: String(
            gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          ),
          antialias: gl.getContextAttributes()?.antialias ?? false,
        };
      });
      expect(capability.webgl2).toBe(true);
      expect(capability.vendor).not.toBe('');
      expect(capability.renderer).not.toBe('');
      if (gpuMode === 'swiftshader') {
        expect(`${capability.vendor} ${capability.renderer}`).toMatch(
          /SwiftShader/i,
        );
      }
      const capabilitySummary = JSON.stringify({
        os: process.platform,
        requestedMode: gpuMode,
        ...capability,
      });
      testInfo.annotations.push({
        type: 'graphics-capability',
        description: capabilitySummary,
      });
      console.log(`Graphics capability: ${capabilitySummary}`);

      await launched.page.waitForTimeout(300);
      const baseline = await canvas.screenshot();
      await viewer.focus();
      await launched.page.keyboard.press('ArrowRight');
      await launched.page.waitForTimeout(300);
      const orbited = await canvas.screenshot();
      expect(orbited.equals(baseline)).toBe(false);

      await launched.page.getByRole('button', { name: 'Reset' }).click();
      await launched.page.waitForTimeout(300);
      const reset = await canvas.screenshot();
      expect(reset.equals(baseline)).toBe(true);
      await expect(viewer).toBeVisible();
    },
    async () => {
      await cleanupPackagedApp(launched, root === null ? [] : [root]);
    },
    async () => {
      await testInfo.attach('packaged-process.log', {
        body: Buffer.from(processLog?.read() ?? '', 'utf8'),
        contentType: 'text/plain',
      });
    },
  );
});
