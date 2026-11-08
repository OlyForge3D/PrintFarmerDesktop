// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDetector } from '../scripts/design-detector.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fixture: string;

interface BaselineReport {
  inspectedCommit: string;
  scope: { selected: string[]; ignoredByConfig: string[]; excluded: string[] };
  counts: { scanned: number; blocking: number };
  findings: { file: string }[];
  policy: { parsed: boolean; allowlists: { colors: boolean } }[];
  provenance: { htmlEngine: string };
}

function readReport(): BaselineReport {
  return JSON.parse(
    readFileSync(path.join(fixture, 'reports/design-baseline.json'), 'utf8'),
  ) as BaselineReport;
}

function command(program: string, args: string[]) {
  return spawnSync(program, args, { cwd: fixture, encoding: 'utf8' });
}

function git(args: string[]) {
  const result = command('git', args);
  if (result.status !== 0) throw new Error(result.stderr);
}

function baseline(...args: string[]) {
  return command(process.execPath, ['scripts/design-baseline.mjs', ...args]);
}

beforeEach(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'design-baseline-'));
  mkdirSync(path.join(fixture, 'src/renderer'), { recursive: true });
  mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  symlinkSync(
    path.join(repo, 'node_modules'),
    path.join(fixture, 'node_modules'),
    'junction',
  );
  writeFileSync(path.join(fixture, '.gitignore'), 'node_modules\n');
  for (const file of [
    'design-baseline.mjs',
    'design-detector.mjs',
    'design-surface.mjs',
  ]) {
    cpSync(
      path.join(repo, 'scripts', file),
      path.join(fixture, 'scripts', file),
    );
  }
  cpSync(
    path.join(repo, 'tools/impeccable-detector'),
    path.join(fixture, 'tools/impeccable-detector'),
    { recursive: true },
  );
  writeFileSync(
    path.join(fixture, 'index.html'),
    '<!doctype html><title>Test</title>',
  );
  writeFileSync(
    path.join(fixture, 'src/renderer/Bad.tsx'),
    'export const B = () => <h1 className="bg-gradient-to-r from-purple-500 to-indigo-500 bg-clip-text text-transparent">Hi</h1>;\n',
  );
  writeFileSync(
    path.join(fixture, 'src/renderer/Ignored.ts'),
    'export const color = "#ffffff";',
  );
  writeFileSync(path.join(fixture, 'DESIGN.md'), '# Prose only\n');
  git(['init', '-q']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe('full-source design baseline', () => {
  it('enumerates tracked eligible sources, reports real findings, and is stable', () => {
    writeFileSync(path.join(fixture, 'src/renderer/Untracked.tsx'), '<div />');
    const first = baseline();
    expect(first.status, first.stderr).toBe(0);
    const output = path.join(fixture, 'reports/design-baseline.json');
    const bytes = readFileSync(output, 'utf8');
    const report = readReport();
    expect(report.scope.selected).toEqual([
      'index.html',
      'src/renderer/Bad.tsx',
    ]);
    expect(report.counts.scanned).toBe(2);
    expect(report.counts.blocking).toBeGreaterThan(0);
    expect(report.findings.some((f) => f.file === 'src/renderer/Bad.tsx')).toBe(
      true,
    );
    expect(report.policy.every((p) => !p.parsed)).toBe(true);
    expect(report.inspectedCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(baseline().status).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(bytes);
  });

  it('reports ignored files and applies parsed design policy', () => {
    mkdirSync(path.join(fixture, '.impeccable'));
    writeFileSync(
      path.join(fixture, '.impeccable/config.json'),
      JSON.stringify({ detector: { ignoreFiles: ['src/renderer/Bad.tsx'] } }),
    );
    writeFileSync(
      path.join(fixture, 'DESIGN.md'),
      '---\ncolors:\n  primary: "#112233"\n---\n',
    );
    const result = baseline();
    expect(result.status, result.stderr).toBe(0);
    const report = readReport();
    expect(report.scope.ignoredByConfig).toEqual(['src/renderer/Bad.tsx']);
    expect(report.policy[0]?.parsed).toBe(true);
    expect(report.policy[0]?.allowlists.colors).toBe(true);
  });

  it('fails without writing a report for malformed config, missing input, or malformed policy', () => {
    mkdirSync(path.join(fixture, '.impeccable'));
    const config = path.join(fixture, '.impeccable/config.json');
    writeFileSync(config, '{"detector":');
    expect(baseline().status).not.toBe(0);
    writeFileSync(config, '{"detector":{"ignoreFiles":"oops"}}');
    expect(baseline().status).not.toBe(0);
    unlinkSync(config);
    writeFileSync(path.join(fixture, 'DESIGN.md'), '---\ncolors:\n');
    expect(baseline().status).not.toBe(0);
    writeFileSync(
      path.join(fixture, 'DESIGN.md'),
      '---\ncolors: [broken\n---\n',
    );
    expect(baseline().stderr).toContain('Invalid design frontmatter');
    writeFileSync(path.join(fixture, 'DESIGN.md'), '# Prose\n');
    unlinkSync(path.join(fixture, 'src/renderer/Bad.tsx'));
    expect(baseline().status).not.toBe(0);
    expect(() =>
      readFileSync(path.join(fixture, 'reports/design-baseline.json')),
    ).toThrow();
  });

  it('rejects local overrides and invalid arguments', () => {
    mkdirSync(path.join(fixture, '.impeccable'));
    writeFileSync(path.join(fixture, '.impeccable/config.local.json'), '{}');
    expect(baseline().stderr).toContain('config.local.json');
    expect(baseline('--output').status).not.toBe(0);
  });

  it('reports the detector HTML fallback when optional parsers are unavailable', () => {
    writeFileSync(
      path.join(fixture, 'index.html'),
      '<link rel="stylesheet" href="missing.css">',
    );
    unlinkSync(path.join(fixture, 'node_modules'));
    const result = baseline();
    expect(result.status, result.stderr).toBe(0);
    const report = readReport();
    expect(report.provenance.htmlEngine).toBe('regex-fallback');
    expect(report.scope.excluded.join(' ')).toContain(
      'linked-stylesheet analysis',
    );
  });

  it('strict scanner rejects empty output and inconsistent status', () => {
    const tool = path.join(fixture, 'fake', 'tools/impeccable-detector');
    mkdirSync(tool, { recursive: true });
    const detector = path.join(tool, 'detect.mjs');
    writeFileSync(detector, '');
    expect(() =>
      runDetector(fixture, ['index.html'], path.join(fixture, 'fake'), {
        strict: true,
      }),
    ).toThrow(/empty stdout/);
    writeFileSync(detector, 'console.log("[]"); process.exitCode = 2;');
    expect(() =>
      runDetector(fixture, ['index.html'], path.join(fixture, 'fake'), {
        strict: true,
      }),
    ).toThrow(/disagrees/);
    writeFileSync(detector, 'console.error("error"); process.exitCode = 1;');
    expect(() =>
      runDetector(fixture, ['index.html'], path.join(fixture, 'fake'), {
        strict: true,
      }),
    ).toThrow(/detector exited/);
  });
});
