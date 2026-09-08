// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CACHE_SCHEMA,
  acquireLock,
  atomicWriteSnapshot,
  cachePath,
  compactPlan,
  main,
  paginate,
  readSnapshot,
  snapshot,
  validateSnapshot,
} from '../scripts/ralph-round-cache.mjs';
import type { RalphSnapshot } from '../scripts/ralph-round-cache.mjs';

const item = {
  kind: 'issue',
  number: 1,
  state: 'OPEN',
  updatedAt: '2026-09-08T00:00:00Z',
};

describe('Ralph round cache', () => {
  it('persists across worktrees when configured outside them', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = cachePath(
      'OlyForge3D/PrintFarmerDesktop',
      { RALPH_CACHE_DIR: directory },
      'win32',
    );
    atomicWriteSnapshot(file, snapshot([item]));
    expect(readSnapshot(file)?.items[0]?.number).toBe(1);
    expect(file).toContain(directory);
  });
  it('reuses unchanged observations and invalidates every safety category', () => {
    const before = snapshot([item]);
    expect(compactPlan([item], before).plan[0]?.action).toBe('reuse');
    for (const field of [
      'dependencies',
      'blockers',
      'state',
      'updatedAt',
      'headRefOid',
      'isDraft',
      'session',
      'claim',
      'linkedPr',
      'baseRef',
      'verdictComment',
      'checks',
      'policy',
      'holds',
    ]) {
      expect(
        compactPlan([{ ...item, [field]: 'changed' }], before).plan[0]?.action,
      ).toBe('inspect');
    }
  });
  it('invalidates head-only and draft-only PR updates', () => {
    const before = snapshot([
      { ...item, kind: 'pr', headRefOid: 'before', isDraft: false },
    ]);
    expect(
      compactPlan(
        [{ ...item, kind: 'pr', headRefOid: 'after', isDraft: false }],
        before,
      ).plan[0]?.action,
    ).toBe('inspect');
    expect(
      compactPlan(
        [{ ...item, kind: 'pr', headRefOid: 'before', isDraft: true }],
        before,
      ).plan[0]?.action,
    ).toBe('inspect');
  });
  it('invalidates an unchanged dependent when its persisted blocker closes', () => {
    const blocker = { ...item, number: 1 };
    const dependent = {
      ...item,
      number: 2,
      blockers: [{ kind: 'issue', number: 1 }],
    };
    const before = snapshot([blocker, dependent]);
    const plan = compactPlan(
      [{ ...blocker, state: 'CLOSED' }, dependent],
      before,
    );
    expect(plan.plan).toEqual([
      expect.objectContaining({ number: 1, action: 'inspect' }),
      expect.objectContaining({ number: 2, action: 'inspect' }),
    ]);
  });
  it('reuses equal structured fields after a JSON round trip', () => {
    const observed = {
      ...item,
      dependencies: [{ number: 4, kind: 'issue' }],
      checks: { required: ['ci', 'lint'], summary: { passed: true } },
    };
    const parsed: unknown = JSON.parse(JSON.stringify(snapshot([observed])));
    const before = validateSnapshot(parsed as RalphSnapshot);
    const reordered = {
      ...observed,
      dependencies: [{ kind: 'issue', number: 4 }],
      checks: { summary: { passed: true }, required: ['ci', 'lint'] },
    };
    expect(compactPlan([reordered], before).plan[0]?.action).toBe('reuse');
  });
  it('fails closed for corrupt state, overlapping locks, and malformed or truncated pages', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    writeFileSync(file, '{"schema":999}');
    expect(() => readSnapshot(file)).toThrow(/unusable/);
    const release = acquireLock(file);
    expect(() => acquireLock(file)).toThrow(/already held/);
    release();
    await expect(
      paginate(() =>
        Promise.resolve({
          items: [],
          hasNext: 'yes' as unknown as boolean,
        }),
      ),
    ).rejects.toThrow(/malformed/);
    await expect(
      paginate(() => Promise.resolve({ items: [], hasNext: true })),
    ).rejects.toThrow(/truncated/);
  });
  it('writes complete schema-valid JSON atomically', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    atomicWriteSnapshot(file, snapshot([item]));
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    expect(validateSnapshot(parsed as RalphSnapshot).schema).toBe(CACHE_SCHEMA);
  });
  it('emits compact actionable JSON and never treats the cache as authorization', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const input = path.join(directory, 'listing.json');
    writeFileSync(input, JSON.stringify([item]));
    const output: string[] = [];
    const stdout = process.stdout;
    const write = stdout.write.bind(stdout);
    stdout.write = (chunk: string) => {
      output.push(chunk);
      return true;
    };
    try {
      main(
        ['--repo', 'OlyForge3D/PrintFarmerDesktop', '--input', input, '--json'],
        {
          RALPH_CACHE_DIR: directory,
        },
      );
    } finally {
      stdout.write = write;
    }
    const parsed: unknown = JSON.parse(output.join(''));
    expect(parsed).toMatchObject({
      plan: [{ action: 'inspect', number: 1 }],
    });
  });
});
