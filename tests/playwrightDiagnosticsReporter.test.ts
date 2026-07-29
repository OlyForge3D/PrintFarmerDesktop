import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface SerializedError {
  message?: string;
  stack?: string;
  cause?: SerializedError;
}

interface JsonAttachment {
  name: string;
  contentType: string;
  body?: string;
}

interface JsonResult {
  error?: SerializedError;
  errors: Array<{
    message: string;
  }>;
  attachments: JsonAttachment[];
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
  config: {
    version: string;
  };
  suites: JsonSuite[];
}

interface DiagnosticAttachment {
  schemaVersion: number;
  primary: {
    name: string;
    message: string;
    stack?: string;
  };
  secondary: Array<{
    name: string;
    message: string;
    stack?: string;
  }>;
}

describe('Playwright secondary diagnostics reporting', () => {
  it('survives the pinned worker serializer and JSON reporter', () => {
    const outputRoot = mkdtempSync(
      path.join(tmpdir(), 'pf-playwright-diagnostics-'),
    );
    try {
      const run = spawnSync(
        process.execPath,
        [
          path.resolve('node_modules', '@playwright', 'test', 'cli.js'),
          'test',
          '--config',
          path.resolve('tests', 'fixtures', 'playwrightDiagnostics.config.ts'),
          '--reporter=json',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            FORCE_COLOR: '0',
            PW_DIAGNOSTICS_OUTPUT_DIR: outputRoot,
          },
          maxBuffer: 4 * 1024 * 1024,
          timeout: 15_000,
        },
      );
      expect(run.status, run.stderr).toBe(1);
      const report = JSON.parse(run.stdout) as JsonReport;
      expect(report.config.version).toBe('1.61.1');
      const results = resultsByTitle(report);

      const bodyCleanup = requiredResult(
        results,
        'body plus cleanup diagnostics',
      );
      expect(serializedErrorText(bodyCleanup)).toContain(
        'body cleanup primary',
      );
      expect(serializedErrorText(bodyCleanup)).toContain(
        'cleanup close failed',
      );
      expect(reporterErrorText(bodyCleanup)).toContain('cleanup close failed');
      expect(attachmentText(bodyCleanup, 'packaged-process.log')).toBe(
        'body cleanup process log',
      );
      const bodyCleanupDiagnostics = diagnosticAttachment(bodyCleanup);
      expect(bodyCleanupDiagnostics.secondary).toHaveLength(1);
      expect(bodyCleanupDiagnostics.secondary[0]).toMatchObject({
        name: 'Error',
        message: 'cleanup close failed',
      });
      expect(bodyCleanupDiagnostics.secondary[0]?.stack).toContain(
        'cleanup close failed',
      );

      const bodyAttachment = requiredResult(
        results,
        'body plus attachment diagnostics',
      );
      expect(serializedErrorText(bodyAttachment)).toContain(
        'body attachment primary',
      );
      expect(serializedErrorText(bodyAttachment)).toContain(
        'diagnostic attachment failed',
      );
      expect(reporterErrorText(bodyAttachment)).toContain(
        'diagnostic attachment failed',
      );
      expect(serializedErrorText(bodyAttachment)).toContain('ENOENT');
      expect(reporterErrorText(bodyAttachment)).toContain('ENOENT');

      const cleanupOnly = requiredResult(results, 'cleanup-only diagnostics');
      expect(serializedErrorText(cleanupOnly)).toContain(
        'Packaged test cleanup failed.',
      );
      expect(serializedErrorText(cleanupOnly)).toContain(
        'root deletion failed with EPERM',
      );
      expect(reporterErrorText(cleanupOnly)).toContain(
        'root deletion failed with EPERM',
      );
      const cleanupOnlyDiagnostics = diagnosticAttachment(cleanupOnly);
      expect(cleanupOnlyDiagnostics.secondary).toHaveLength(1);
      expect(cleanupOnlyDiagnostics.secondary[0]).toMatchObject({
        name: 'Error',
        message: 'root deletion failed with EPERM',
      });
      expect(cleanupOnlyDiagnostics.secondary[0]?.stack).toContain(
        'root deletion failed with EPERM',
      );
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
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

function serializedErrorText(result: JsonResult): string {
  return JSON.stringify(result.error);
}

function reporterErrorText(result: JsonResult): string {
  return result.errors.map((error) => error.message).join('\n');
}

function attachmentText(result: JsonResult, name: string): string {
  const attachment = result.attachments.find(
    (candidate) => candidate.name === name,
  );
  if (!attachment?.body) {
    throw new Error(`Playwright report omitted attachment "${name}".`);
  }
  return Buffer.from(attachment.body, 'base64').toString('utf8');
}

function diagnosticAttachment(result: JsonResult): DiagnosticAttachment {
  return JSON.parse(
    attachmentText(result, 'packaged-secondary-errors.json'),
  ) as DiagnosticAttachment;
}
