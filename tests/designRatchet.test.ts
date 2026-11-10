// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { compareCounts } from '../scripts/design-ratchet.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fixture: string;
let base: string;

function command(program: string, args: string[], env = process.env) {
  return spawnSync(program, args, { cwd: fixture, encoding: 'utf8', env });
}
function git(...args: string[]) {
  const result = command('git', args);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function commit(message: string) {
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    message,
  );
  return git('rev-parse', 'HEAD');
}
function ratchet(head = git('rev-parse', 'HEAD'), baseRef = base) {
  return command(process.execPath, [
    'scripts/design-ratchet.mjs',
    fixture,
    baseRef,
    head,
    fixture,
  ]);
}

beforeEach(() => {
  fixture = realpathSync(
    mkdtempSync(path.join(tmpdir(), 'design-ratchet-test-')),
  );
  mkdirSync(path.join(fixture, 'src/renderer'), { recursive: true });
  mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  mkdirSync(path.join(fixture, '.impeccable'), { recursive: true });
  for (const file of [
    'design-baseline.mjs',
    'design-detector.mjs',
    'design-surface.mjs',
    'design-ratchet.mjs',
  ])
    cpSync(
      path.join(repo, 'scripts', file),
      path.join(fixture, 'scripts', file),
    );
  cpSync(
    path.join(repo, 'tools/impeccable-detector'),
    path.join(fixture, 'tools/impeccable-detector'),
    { recursive: true },
  );
  cpSync(
    path.join(repo, '.impeccable/config.json'),
    path.join(fixture, '.impeccable/config.json'),
  );
  writeFileSync(
    path.join(fixture, 'index.html'),
    '<!doctype html><title>Test</title>',
  );
  writeFileSync(path.join(fixture, 'DESIGN.md'), '# Prose\n');
  writeFileSync(
    path.join(fixture, 'src/renderer/Test.tsx'),
    'export const A = () => <h1>Test</h1>;\n',
  );
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  commit('sources');
  const result = command(process.execPath, ['scripts/design-baseline.mjs']);
  if (result.status !== 0) throw new Error(result.stderr);
  base = commit('trusted allowance');
}, 30_000);
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe('design count ratchet', () => {
  it('scans findings when the temporary directory uses a filesystem alias', () => {
    const temp = path.join(fixture, 'temp');
    const alias = path.join(fixture, 'temp-alias');
    mkdirSync(temp);
    symlinkSync(temp, alias, 'junction');
    writeFileSync(
      path.join(fixture, 'src/renderer/Test.tsx'),
      'export const A = () => <img alt="missing" />;\n',
    );
    const head = commit('finding');
    const result = command(
      process.execPath,
      ['scripts/design-ratchet.mjs', fixture, base, head, fixture],
      { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/total \([1-9]\d* blocking/);
    expect(result.stderr).not.toContain('Finding outside target scope');
  });

  it('uses a trusted event and fetches target objects without checking them out', () => {
    const workflow = readFileSync(
      path.join(repo, '.github/workflows/design-ratchet.yml'),
      'utf8',
    );
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('merge_group:');
    expect(workflow).toContain('git -C "$GITHUB_WORKSPACE/target" fetch');
    expect(workflow).toContain('rev-parse FETCH_HEAD');
    expect(workflow).not.toContain('allow-unsafe-pr-checkout: true');
    expect(workflow).not.toMatch(/npm (?:ci|install)/);
  });

  // Clone, sparse checkout and both real ratchet runs can exceed 5s on Windows CI.
  it('runs with exactly the trusted sparse-checkout paths from the workflow', () => {
    const workflow = readFileSync(
      path.join(repo, '.github/workflows/design-ratchet.yml'),
      'utf8',
    );
    const paths = /sparse-checkout: \|\n((?: {12}.+\n)+)/
      .exec(workflow)?.[1]
      ?.trim()
      .split('\n')
      .map((file) => file.trim());
    if (!paths?.length) throw new Error('Missing trusted sparse checkout');
    const trusted = path.join(fixture, 'trusted');
    git('clone', '-q', '--no-checkout', fixture, trusted);
    git('-C', trusted, 'config', 'core.autocrlf', 'false');
    git('-C', trusted, 'sparse-checkout', 'set', '--no-cone', ...paths);
    git('-C', trusted, 'checkout', '-q', base);
    const result = command(process.execPath, [
      path.join(trusted, 'scripts/design-ratchet.mjs'),
      fixture,
      base,
      base,
      trusted,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('0/0 total');
    rmSync(path.join(trusted, 'scripts/design-baseline.mjs'));
    const incomplete = command(process.execPath, [
      path.join(trusted, 'scripts/design-ratchet.mjs'),
      fixture,
      base,
      base,
      trusted,
    ]);
    expect(incomplete.status).toBe(1);
    expect(incomplete.stderr).toContain('design-baseline.mjs');
  }, 30_000);

  it('rejects a squash-stranded anchor and preserves enforcement after a landed-source refresh', () => {
    const mainBranch = git('branch', '--show-current');
    const source =
      'export const A = () => <h1 className="bg-gradient-to-r from-purple-500 to-indigo-500 bg-clip-text text-transparent">Test</h1>;\n';
    git('switch', '-qc', 'source-and-baseline');
    writeFileSync(path.join(fixture, 'src/renderer/Test.tsx'), source);
    const branchSource = commit('source with debt on feature branch');
    let report = command(process.execPath, ['scripts/design-baseline.mjs']);
    expect(report.status, report.stderr).toBe(0);
    commit('baseline anchored to feature branch source');
    git('switch', '-q', mainBranch);
    git('merge', '--squash', 'source-and-baseline');
    const squashed = commit('squashed source and baseline');
    expect(
      command('git', ['merge-base', '--is-ancestor', branchSource, squashed])
        .status,
    ).toBe(1);
    const stranded = ratchet(squashed, squashed);
    expect(stranded.status).toBe(1);
    expect(stranded.stderr).toContain(
      'Baseline inspected commit is not an ancestor of trusted base',
    );
    const reportPath = path.join(fixture, 'reports/design-baseline.json');
    const before = z
      .object({ findings: z.array(z.unknown()) })
      .parse(JSON.parse(readFileSync(reportPath, 'utf8')));

    // A report-only refresh inspects landed sources, not a new branch commit.
    git('switch', '-qc', 'baseline-refresh');
    report = command(process.execPath, ['scripts/design-baseline.mjs']);
    expect(report.status, report.stderr).toBe(0);
    const refreshed = z
      .object({
        inspectedCommit: z.string(),
        findings: z.array(z.unknown()),
      })
      .parse(JSON.parse(readFileSync(reportPath, 'utf8')));
    expect(refreshed.inspectedCommit).toBe(squashed);
    expect(refreshed.findings).toEqual(before.findings);
    const repair = commit('refresh report from landed source');
    // Broken trusted bases cannot be repaired by a PR-controlled fallback.
    expect(ratchet(repair, squashed).stderr).toContain(
      'Baseline inspected commit is not an ancestor of trusted base',
    );
    git('switch', '-q', mainBranch);
    git('merge', '--squash', 'baseline-refresh');
    const landed = commit('squashed report-only refresh');
    expect(
      command('git', ['merge-base', '--is-ancestor', squashed, landed]).status,
    ).toBe(0);
    const accepted = ratchet(landed, landed);
    expect(accepted.status, accepted.stderr).toBe(0);
    writeFileSync(path.join(fixture, 'src/renderer/Extra.tsx'), source);
    const increase = ratchet(commit('new debt'), landed);
    expect(increase.status, increase.stderr).toBe(1);
    const counts = /(\d+)\/(\d+) total/.exec(increase.stdout);
    if (!counts) throw new Error('Missing ratchet counts');
    expect(Number(counts[2])).toBeGreaterThan(0);
    expect(Number(counts[1])).toBeGreaterThan(Number(counts[2]));
  }, 30000);

  it('allows equal, lower, and same-total swaps while reporting severity', () => {
    const blocking = { antipattern: 'one' };
    const advisory = { antipattern: 'two', advisory: true };
    expect(compareCounts(2, [blocking, advisory])).toEqual({
      allowed: 2,
      total: 2,
      blocking: 1,
      advisory: 1,
      passed: true,
    });
    expect(compareCounts(2, [advisory]).passed).toBe(true);
    expect(compareCounts(1, [{ antipattern: 'different' }]).passed).toBe(true);
    expect(compareCounts(1, [blocking, advisory]).passed).toBe(false);
    expect(() => compareCounts(-1, [])).toThrow();
    expect(ratchet().status).toBe(0);
  });

  it('fails increases even if head tampers with allowance, config and inline suppressions', () => {
    writeFileSync(
      path.join(fixture, 'src/renderer/Test.tsx'),
      '// impeccable-disable\nexport const A = () => <h1 className="bg-gradient-to-r from-purple-500 to-indigo-500 bg-clip-text text-transparent">Test</h1>;\n',
    );
    writeFileSync(
      path.join(fixture, '.impeccable/config.json'),
      '{"detector":{"ignoreRules":["gradient-text","ai-color-palette"]}}',
    );
    writeFileSync(
      path.join(fixture, 'tools/impeccable-detector/detect.mjs'),
      'console.log("[]");',
    );
    const head = commit('tampering');
    // Restore only the trusted detector bytes for this local stand-in for a base checkout.
    cpSync(
      path.join(repo, 'tools/impeccable-detector/detect.mjs'),
      path.join(fixture, 'tools/impeccable-detector/detect.mjs'),
    );
    const result = ratchet(head);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/total \([1-9]\d* blocking/);
  });

  it('rejects a PR attempt to replace or inflate the trusted allowance', () => {
    writeFileSync(
      path.join(fixture, 'reports/design-baseline.json'),
      '{"counts":{"blocking":999}}',
    );
    const head = commit('fake allowance');
    const result = ratchet(head);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid candidate baseline');
  });

  it('accepts a genuine same-count swap and a subsequent decrease', () => {
    const source = path.join(fixture, 'src/renderer/Test.tsx');
    const bad =
      'export const A = () => <h1 className="bg-gradient-to-r from-purple-500 to-indigo-500 bg-clip-text text-transparent">Test</h1>;\n';
    writeFileSync(source, bad);
    commit('source with debt');
    const report = command(process.execPath, ['scripts/design-baseline.mjs']);
    expect(report.status, report.stderr).toBe(0);
    const ceilingBase = commit('reviewed allowance');
    writeFileSync(source, 'export const A = () => <h1>Clean</h1>;\n');
    writeFileSync(path.join(fixture, 'src/renderer/Other.tsx'), bad);
    const swap = commit('move findings');
    const swapped = ratchet(swap, ceilingBase);
    expect(swapped.status, swapped.stderr).toBe(0);
    expect(swapped.stdout).toMatch(/[1-9]\d*\/[1-9]\d* total/);
    writeFileSync(
      path.join(fixture, 'src/renderer/Other.tsx'),
      'export const B = () => <h1>Clean</h1>;\n',
    );
    const decrease = commit('remove findings');
    const decreased = ratchet(decrease, ceilingBase);
    expect(decreased.stdout).toContain('0/');
    expect(decreased.status).toBe(0);
    const lowered = command(process.execPath, ['scripts/design-baseline.mjs']);
    expect(lowered.status, lowered.stderr).toBe(0);
    const candidate = commit('propose lower allowance');
    const lowerCheck = ratchet(candidate, ceilingBase);
    expect(lowerCheck.status, lowerCheck.stderr).toBe(0);
  }, 30000);

  it('rejects fabricated findings in a changed baseline even when counts match', () => {
    writeFileSync(
      path.join(fixture, 'src/renderer/Test.tsx'),
      'export const A = () => <h1 className="bg-gradient-to-r from-purple-500 to-indigo-500 bg-clip-text text-transparent">Test</h1>;\n',
    );
    commit('source with debt');
    let report = command(process.execPath, ['scripts/design-baseline.mjs']);
    expect(report.status, report.stderr).toBe(0);
    const ceilingBase = commit('reviewed allowance');

    report = command(process.execPath, ['scripts/design-baseline.mjs']);
    expect(report.status, report.stderr).toBe(0);
    const genuine = commit('refresh truthful report');
    const accepted = ratchet(genuine, ceilingBase);
    expect(accepted.status, accepted.stderr).toBe(0);

    const reportPath = path.join(fixture, 'reports/design-baseline.json');
    const candidate = z
      .object({
        findings: z.array(
          z
            .object({
              antipattern: z.string(),
              line: z.number(),
              snippet: z.string(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .parse(JSON.parse(readFileSync(reportPath, 'utf8')));
    const first = candidate.findings[0];
    if (!first) throw new Error('Expected at least one baseline finding');
    first.antipattern = 'invented-rule';
    first.line = 999;
    first.snippet = 'fabricated finding';
    writeFileSync(reportPath, JSON.stringify(candidate, null, 2) + '\n');
    const fabricated = commit('fabricate finding');
    const rejected = ratchet(fabricated, ceilingBase);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      'Candidate baseline findings differ from current scan',
    );
  }, 30000);

  it('rejects malformed baseline and source/tool provenance mismatch', () => {
    const reportPath = path.join(fixture, 'reports/design-baseline.json');
    writeFileSync(reportPath, 'not json');
    const malformed = commit('bad baseline');
    expect(ratchet(malformed, malformed).stderr).toContain(
      'Invalid trusted baseline',
    );
    git('show', `${base}:reports/design-baseline.json`);
    const result = command('git', [
      'show',
      `${base}:reports/design-baseline.json`,
    ]);
    writeFileSync(
      reportPath,
      result.stdout.replace('"blocking": 0', '"blocking": 9'),
    );
    const invalid = commit('bad count');
    expect(ratchet(invalid, invalid).stderr).toContain(
      'Invalid baseline counts',
    );
    writeFileSync(
      reportPath,
      result.stdout.replace(
        /("index\.html": ")[0-9a-f]{64}"/,
        `$1${'0'.repeat(64)}"`,
      ),
    );
    const badProvenance = commit('bad provenance');
    expect(ratchet(badProvenance, badProvenance).stderr).toContain(
      'provenance',
    );
    writeFileSync(
      reportPath,
      result.stdout.replace(
        '"htmlEngine": "regex-fallback"',
        '"htmlEngine": "static-html"',
      ),
    );
    const badCapability = commit('bad capability');
    expect(ratchet(badCapability, badCapability).stderr).toContain(
      'capabilities are incompatible',
    );
    writeFileSync(reportPath, result.stdout);
    writeFileSync(path.join(fixture, 'scripts/design-detector.mjs'), 'broken');
    const mismatch = ratchet();
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/provenance mismatch|SyntaxError/);
  }, 30000);

  it('rejects scanner failure and unsafe target input', () => {
    writeFileSync(
      path.join(fixture, 'src/renderer/Test.tsx'),
      Buffer.from([0xff, 0xfe]),
    );
    const invalid = commit('invalid input');
    expect(ratchet(invalid).stderr).toContain('Invalid UTF-8');
    const runner = path.join(fixture, 'tools/impeccable-detector/detect.mjs');
    writeFileSync(runner, 'process.exit(1);');
    expect(ratchet().status).not.toBe(0);
    expect(readFileSync(runner, 'utf8')).toContain('process.exit');
  });
});
