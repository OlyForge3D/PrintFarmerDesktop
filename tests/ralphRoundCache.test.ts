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
} from '../scripts/ralph-round-cache.mjs';

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
    expect(readSnapshot(file)?.items[0].number).toBe(1);
    expect(file).toContain(directory);
  });
  it('reuses unchanged observations and invalidates every safety category', () => {
    const before = snapshot([item]);
    expect(compactPlan([item], before).plan[0].action).toBe('reuse');
    for (const field of [
      'dependencies',
      'blockers',
      'state',
      'updatedAt',
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
        compactPlan([{ ...item, [field]: 'changed' }], before).plan[0].action,
      ).toBe('inspect');
    }
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
      paginate(async () => ({
        items: [],
        hasNext: 'yes' as unknown as boolean,
      })),
    ).rejects.toThrow(/malformed/);
    await expect(
      paginate(async () => ({ items: [], hasNext: true })),
    ).rejects.toThrow(/truncated/);
  });
  it('writes complete schema-valid JSON atomically', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    atomicWriteSnapshot(file, snapshot([item]));
    expect(JSON.parse(readFileSync(file, 'utf8')).schema).toBe(CACHE_SCHEMA);
  });
  it('emits compact actionable JSON and never treats the cache as authorization', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const input = path.join(directory, 'listing.json');
    writeFileSync(input, JSON.stringify([item]));
    const output: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      output.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      main(
        ['--repo', 'OlyForge3D/PrintFarmerDesktop', '--input', input, '--json'],
        {
          RALPH_CACHE_DIR: directory,
        },
      );
    } finally {
      process.stdout.write = write;
    }
    expect(JSON.parse(output.join('')).plan[0]).toMatchObject({
      action: 'inspect',
      number: 1,
    });
  });
});
