import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDir = process.env.PW_DIAGNOSTICS_OUTPUT_DIR;
if (!outputDir) {
  throw new Error('PW_DIAGNOSTICS_OUTPUT_DIR is required.');
}

export default defineConfig({
  testDir: path.dirname(fileURLToPath(import.meta.url)),
  testMatch: 'playwrightDiagnostics.fixture.ts',
  outputDir,
  timeout: 10_000,
  workers: 1,
  retries: 0,
});
