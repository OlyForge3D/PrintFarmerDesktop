import { existsSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const failureMarker = process.env.PW_STARTUP_ISOLATION_MARKER;
if (!failureMarker) {
  throw new Error('PW_STARTUP_ISOLATION_MARKER is required.');
}
const cleanupMarker = process.env.PW_STARTUP_ISOLATION_CLEANUP_MARKER;
if (!cleanupMarker) {
  throw new Error('PW_STARTUP_ISOLATION_CLEANUP_MARKER is required.');
}

test.beforeEach(() => {
  if (!existsSync(failureMarker)) {
    writeFileSync(failureMarker, 'firstWindow failure injected', 'utf8');
    throw new Error(
      'Controlled packaged startup failure while waiting for firstWindow.',
    );
  }
});

test.afterEach(() => {
  writeFileSync(cleanupMarker, 'afterEach completed', 'utf8');
});

test('startup failure remains on the affected case', () => {
  throw new Error('The controlled beforeEach failure did not run.');
});

test('later calibration case still executes', () => {
  expect(existsSync(failureMarker)).toBe(true);
  expect(existsSync(cleanupMarker)).toBe(true);
});
