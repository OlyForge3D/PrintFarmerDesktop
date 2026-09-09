// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  parseArgs,
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

function lockHolder(
  pid: number,
  host: string,
  acquiredAt: number,
  token = '11111111-1111-4111-8111-111111111111',
) {
  return JSON.stringify({
    pid,
    host,
    acquiredAt: new Date(acquiredAt).toISOString(),
    token,
  });
}

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
  it.each([
    ['native dependencies', 'dependencies', [{ kind: 'issue', number: 1 }]],
    ['legacy blockers', 'blockers', ['issue:#1']],
  ])(
    'invalidates an unchanged dependent with %s when its persisted blocker closes',
    (_representation, field, references) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
      const file = path.join(directory, 'cache.json');
      const blocker = { ...item, number: 1 };
      const dependent = { ...item, number: 2, [field]: references };
      atomicWriteSnapshot(file, snapshot([blocker, dependent]));

      const plan = compactPlan(
        [{ ...blocker, state: 'CLOSED' }, dependent],
        readSnapshot(file),
      );

      expect(plan.plan).toEqual([
        expect.objectContaining({ number: 1, action: 'inspect' }),
        expect.objectContaining({ number: 2, action: 'inspect' }),
      ]);
    },
  );
  it.each([
    ['native dependencies', 'dependencies', [{ kind: 'issue', number: 1 }]],
    ['legacy blockers', 'blockers', ['issue:#1']],
  ])(
    'invalidates an unchanged dependent with %s when its blocker is absent from the current listing',
    (_representation, field, references) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
      const file = path.join(directory, 'cache.json');
      const blocker = { ...item, number: 1 };
      const dependent = { ...item, number: 2, [field]: references };
      atomicWriteSnapshot(file, snapshot([blocker, dependent]));

      const plan = compactPlan([dependent], readSnapshot(file));

      expect(plan.plan).toEqual([
        expect.objectContaining({ number: 2, action: 'inspect' }),
      ]);
    },
  );
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
  it('recovers bounded stale or dead-owner locks while rejecting live and malformed holders', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    writeFileSync(file, '{"schema":999}');
    expect(() => readSnapshot(file)).toThrow(/unusable/);
    const release = acquireLock(file, { now: 2_000, pid: 20, host: 'local' });
    expect(() =>
      acquireLock(file, {
        now: 2_001,
        pid: 21,
        host: 'local',
        isAlive: () => true,
      }),
    ).toThrow(/already held by PID 20/);
    expect(() =>
      acquireLock(file, {
        now: 2_000 + 30 * 60 * 1000,
        pid: 21,
        host: 'local',
        isAlive: () => true,
      }),
    ).toThrow(/already held by PID 20/);
    release();
    writeFileSync(`${file}.lock`, lockHolder(20, 'local', 2_000));
    const deadOwner = acquireLock(file, {
      now: 2_001,
      pid: 21,
      host: 'local',
      isAlive: () => false,
    });
    deadOwner();
    writeFileSync(`${file}.lock`, lockHolder(20, 'other-host', 2_000));
    const staleOwner = acquireLock(file, {
      now: 2_000 + 30 * 60 * 1000,
      pid: 21,
      host: 'local',
    });
    staleOwner();
    writeFileSync(`${file}.lock`, 'not JSON');
    expect(() => acquireLock(file)).toThrow(/malformed.*unsafe recovery/);
  });
  it('prevents interleaved stale recoveries from deleting a newly acquired lock', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    writeFileSync(`${file}.lock`, lockHolder(20, 'local', 2_000));

    let secondRecoveryAttempted = false;
    const release = acquireLock(file, {
      now: 2_001,
      pid: 21,
      host: 'local',
      isAlive: () => {
        secondRecoveryAttempted = true;
        expect(() =>
          acquireLock(file, {
            now: 2_001,
            pid: 22,
            host: 'local',
            isAlive: (pid) => pid === 21,
          }),
        ).toThrow(/transition is already in progress/);
        return false;
      },
    });

    expect(secondRecoveryAttempted).toBe(true);
    expect(() =>
      acquireLock(file, {
        now: 2_002,
        pid: 22,
        host: 'local',
        isAlive: () => true,
      }),
    ).toThrow(/already held by PID 21/);
    release();
  });
  it('recovers bounded orphaned transition markers while rejecting unsafe holders', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    const transition = `${file}.lock.transition`;

    writeFileSync(transition, lockHolder(20, 'local', 2_000));
    const deadOwner = acquireLock(file, {
      now: 2_001,
      pid: 21,
      host: 'local',
      isAlive: () => false,
    });
    deadOwner();

    writeFileSync(transition, lockHolder(20, 'other-host', 2_000));
    const staleUnknownOwner = acquireLock(file, {
      now: 2_000 + 30 * 60 * 1000,
      pid: 21,
      host: 'local',
    });
    staleUnknownOwner();

    writeFileSync(transition, lockHolder(20, 'local', 2_000));
    expect(() =>
      acquireLock(file, {
        now: 2_001,
        pid: 21,
        host: 'local',
        isAlive: () => true,
      }),
    ).toThrow(/transition is already in progress/);
    writeFileSync(transition, lockHolder(20, 'local', 2_000));
    expect(() =>
      acquireLock(file, {
        now: 2_001,
        pid: 21,
        host: 'local',
        isAlive: () => null,
      }),
    ).toThrow(/transition is already in progress/);
    writeFileSync(transition, lockHolder(20, 'other-host', 2_000));
    expect(() =>
      acquireLock(file, {
        now: 2_001,
        pid: 21,
        host: 'local',
      }),
    ).toThrow(/transition is already in progress/);
    writeFileSync(transition, '{"pid":20}');
    expect(() => acquireLock(file)).toThrow(
      /transition is malformed; refusing unsafe recovery/,
    );
  });
  it('does not remove a transition successor during orphan recovery', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    const transition = `${file}.lock.transition`;
    const successor = lockHolder(
      22,
      'local',
      2_001,
      '22222222-2222-4222-8222-222222222222',
    );
    writeFileSync(transition, lockHolder(20, 'local', 2_000));

    expect(() =>
      acquireLock(file, {
        now: 2_001,
        pid: 21,
        host: 'local',
        isAlive: () => {
          writeFileSync(transition, successor);
          return false;
        },
      }),
    ).toThrow(/transition changed during stale recovery/);
    expect(readFileSync(transition, 'utf8')).toBe(successor);
  });
  it('recovers an expired cross-host transition created after acquiring its lock', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    const transition = `${file}.lock.transition`;
    let releaseTime = 2_000;
    const release = acquireLock(file, {
      now: 2_000,
      releaseNow: () => releaseTime,
      pid: 20,
      host: 'local',
    });

    writeFileSync(transition, lockHolder(21, 'other-host', 2_001));
    releaseTime = 2_001 + 30 * 60 * 1000;
    release();

    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(transition)).toBe(false);
    acquireLock(file, {
      now: releaseTime + 1,
      pid: 22,
      host: 'local',
    })();
  });
  it('does not let a stale release remove a recovered successor lock', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    const staleRelease = acquireLock(file, {
      now: 2_000,
      pid: 20,
      host: 'local',
    });
    const successorRelease = acquireLock(file, {
      now: 2_001,
      pid: 21,
      host: 'local',
      isAlive: () => false,
    });

    staleRelease();

    expect(() =>
      acquireLock(file, {
        now: 2_002,
        pid: 22,
        host: 'local',
        isAlive: () => true,
      }),
    ).toThrow(/already held by PID 21/);
    successorRelease();
  });
  it('fails closed for malformed or truncated pages', async () => {
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
      main(['--repo', 'OlyForge3D/PrintFarmerDesktop', '--input', input], {
        RALPH_CACHE_DIR: directory,
      });
    } finally {
      stdout.write = write;
    }
    const parsed: unknown = JSON.parse(output.join(''));
    expect(parsed).toMatchObject({
      plan: [{ action: 'inspect', number: 1 }],
    });
    expect(() =>
      parseArgs([
        '--repo',
        'OlyForge3D/PrintFarmerDesktop',
        '--input',
        input,
        '--json',
      ]),
    ).toThrow(/unknown argument/);
  });
});
