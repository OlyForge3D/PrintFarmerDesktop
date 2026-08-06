import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface JsonResult {
  status: string;
  error?: {
    message?: string;
  };
}

interface JsonSpec {
  title: string;
  tests: Array<{
    results: JsonResult[];
  }>;
}

interface JsonSuite {
  specs: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonReport {
  suites: JsonSuite[];
}

describe('Playwright packaged startup isolation', () => {
  it('runs the later case after a named firstWindow setup failure', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pf-startup-isolation-'));
    try {
      const run = spawnSync(
        process.execPath,
        [
          path.resolve('node_modules', '@playwright', 'test', 'cli.js'),
          'test',
          '--config',
          path.resolve(
            'tests',
            'fixtures',
            'playwrightStartupIsolation.config.ts',
          ),
          '--reporter=json',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            FORCE_COLOR: '0',
            PW_STARTUP_ISOLATION_MARKER: path.join(root, 'failed-once.txt'),
            PW_STARTUP_ISOLATION_CLEANUP_MARKER: path.join(
              root,
              'cleanup-completed.txt',
            ),
            PW_STARTUP_ISOLATION_OUTPUT_DIR: path.join(root, 'results'),
          },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 15_000,
        },
      );

      expect(run.status, run.stderr).toBe(1);
      const results = resultsByTitle(JSON.parse(run.stdout) as JsonReport);
      const failed = requiredResult(
        results,
        'startup failure remains on the affected case',
      );
      expect(failed.status).toBe('failed');
      expect(failed.error?.message).toContain(
        'Controlled packaged startup failure while waiting for firstWindow.',
      );
      expect(
        requiredResult(results, 'later calibration case still executes').status,
      ).toBe('passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

function resultsByTitle(report: JsonReport): Map<string, JsonResult> {
  const results = new Map<string, JsonResult>();
  const visit = (suite: JsonSuite): void => {
    for (const spec of suite.specs) {
      const result = spec.tests[0]?.results[0];
      if (result) {
        results.set(spec.title, result);
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child);
    }
  };
  for (const suite of report.suites) {
    visit(suite);
  }
  return results;
}

function requiredResult(
  results: ReadonlyMap<string, JsonResult>,
  title: string,
): JsonResult {
  const result = results.get(title);
  if (!result) {
    throw new Error(`Playwright report omitted "${title}".`);
  }
  return result;
}
