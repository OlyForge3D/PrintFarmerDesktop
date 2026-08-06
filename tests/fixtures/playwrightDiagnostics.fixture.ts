import { expect, test } from '@playwright/test';
import {
  attachPackagedFailureDiagnostics,
  createPackagedStartupTrace,
  runWithPackagedTestCleanup,
} from '../../e2e/helpers/packagedApp.js';

test('body plus cleanup diagnostics', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const primaryError = new Error('body cleanup primary');
  const cleanupError = new Error('cleanup close failed');

  await runWithPackagedTestCleanup(
    () => Promise.reject(primaryError),
    () =>
      Promise.reject(
        new AggregateError([cleanupError], 'Packaged test cleanup failed.'),
      ),
    (diagnostics) =>
      attachPackagedFailureDiagnostics(
        testInfo,
        'body cleanup process log',
        diagnostics,
      ),
  );
});

test('body plus attachment diagnostics', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const primaryError = new Error('body attachment primary');

  await runWithPackagedTestCleanup(
    () => Promise.reject(primaryError),
    () => Promise.resolve(),
    async () => {
      try {
        await testInfo.attach('missing diagnostic', {
          path: testInfo.outputPath('missing-diagnostic.log'),
          contentType: 'text/plain',
        });
      } catch (error) {
        throw new Error('diagnostic attachment failed', { cause: error });
      }
    },
  );
});

test('cleanup-only diagnostics', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const cleanupError = new Error('root deletion failed with EPERM');

  await runWithPackagedTestCleanup(
    () => Promise.resolve(),
    () =>
      Promise.reject(
        new AggregateError([cleanupError], 'Packaged test cleanup failed.'),
      ),
    (diagnostics) =>
      attachPackagedFailureDiagnostics(
        testInfo,
        'cleanup-only process log',
        diagnostics,
      ),
  );
});

test('startup phase diagnostics', async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  const startupTrace = createPackagedStartupTrace(() =>
    Date.parse('2026-08-05T10:00:00.000Z'),
  );
  startupTrace.mark('spawn');
  startupTrace.waitFor('firstWindow');

  await runWithPackagedTestCleanup(
    () =>
      Promise.reject(
        new Error(
          'Packaged Electron startup failed while waiting for firstWindow.',
        ),
      ),
    () => Promise.resolve(),
    (diagnostics) =>
      attachPackagedFailureDiagnostics(
        testInfo,
        '[stderr] controlled startup failure',
        diagnostics,
        startupTrace.snapshot(),
      ),
  );
});
