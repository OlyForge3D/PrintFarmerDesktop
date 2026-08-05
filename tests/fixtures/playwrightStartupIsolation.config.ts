import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDir = process.env.PW_STARTUP_ISOLATION_OUTPUT_DIR;
if (!outputDir) {
  throw new Error('PW_STARTUP_ISOLATION_OUTPUT_DIR is required.');
}

export default defineConfig({
  testDir: path.dirname(fileURLToPath(import.meta.url)),
  testMatch: 'playwrightStartupIsolation.fixture.ts',
  outputDir,
  timeout: 10_000,
  workers: 1,
  retries: 0,
});
