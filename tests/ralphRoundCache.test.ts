// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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
    ['newly appears', 'dependencies', [{ kind: 'issue', number: 1 }]],
    ['reopens', 'blockers', ['issue:#1']],
  ])(
    'invalidates an unchanged dependent when its blocker %s',
    (change, field, references) => {
      const blocker = {
        ...item,
        number: 1,
        ...(change === 'reopens' ? { state: 'CLOSED' } : {}),
      };
      const dependent = { ...item, number: 2, [field]: references };
      const before =
        change === 'newly appears'
          ? snapshot([dependent])
          : snapshot([blocker, dependent]);
      const current =
        change === 'newly appears'
          ? [blocker, dependent]
          : [{ ...blocker, state: 'OPEN' }, dependent];

      expect(compactPlan(current, before).plan).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ number: 2, action: 'inspect' }),
        ]),
      );
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
        ).toThrow(/transition recovery is already in progress/);
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
  it('uses no legacy recovery directory and recovers a crashed stale handoff', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    const legacyRecovery = `${file}.lock.transition.recovery`;
    const handoff = `${file}.lock.transition.handoff`;

    writeFileSync(handoff, lockHolder(20, 'local', 2_000));
    const release = acquireLock(file, {
      now: 2_000 + 30 * 60 * 1000,
      pid: 21,
      host: 'local',
      isAlive: () => false,
    });

    expect(existsSync(legacyRecovery)).toBe(false);
    expect(existsSync(handoff)).toBe(false);
    release();
    expect(existsSync(legacyRecovery)).toBe(false);
    expect(existsSync(handoff)).toBe(false);
  });
  it('does not let a stale handoff claimant remove a fresh claimant and proceed', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    const handoff = `${file}.lock.transition.handoff`;
    const transition = `${file}.lock.transition`;
    const winnerLock = `${file}.lock`;
    writeFileSync(handoff, lockHolder(20, 'local', 2_000));
    const successorHandoffPayload = lockHolder(
      21,
      'local',
      2_000 + 30 * 60 * 1000,
      '22222222-2222-4222-8222-222222222222',
    );

    expect(() =>
      acquireLock(file, {
        now: 2_000 + 30 * 60 * 1000,
        pid: 22,
        host: 'local',
        isAlive: () => false,
        onStaleHandoffRecoveryValidated: () => {
          // Simulate a successor that observed the same stale handoff, won
          // the race, and has already replaced it with its own fresh claim
          // -- plus the transition and lock it is entitled to hold as a
          // result -- before this claimant's own rename-and-verify runs.
          writeFileSync(handoff, successorHandoffPayload);
          writeFileSync(transition, successorHandoffPayload);
          writeFileSync(winnerLock, successorHandoffPayload);
        },
      }),
    ).toThrow(/changed during stale recovery/);

    // The successor's handoff marker is the terminal ownership record for
    // the recovery gate itself. It must survive this failed claimant's
    // rename-to-displaced-and-verify byte-for-byte, not merely have "some"
    // content restored -- an unconditional cleanup that deleted it would
    // reopen the gate to a third claimant even though the successor is
    // still active.
    expect(existsSync(handoff)).toBe(true);
    expect(readFileSync(handoff, 'utf8')).toBe(successorHandoffPayload);
    const winner = JSON.parse(readFileSync(winnerLock, 'utf8')) as {
      pid: number;
    };
    const activeTransition = JSON.parse(readFileSync(transition, 'utf8')) as {
      pid: number;
    };
    expect(winner.pid).toBe(21);
    expect(activeTransition.pid).toBe(21);

    // The failed claimant must not leave its displaced working copy behind
    // either; a restored-and-cleaned-up recovery leaves no stray artifacts.
    const leftoverArtifacts = readdirSync(directory).filter((name) =>
      name.endsWith('.stale'),
    );
    expect(leftoverArtifacts).toEqual([]);

    // The gate must not have been reopened: a third claimant racing in right
    // after the failed stale-recovery attempt is still correctly blocked by
    // the surviving successor ownership, not free to claim it as if the
    // handoff had never existed.
    expect(() =>
      acquireLock(file, {
        now: 2_000 + 30 * 60 * 1000,
        pid: 23,
        host: 'local',
        isAlive: (pid) => pid === 21,
      }),
    ).toThrow(/transition recovery is already in progress/);
  });
  it('fails closed for fresh, live, or malformed interrupted handoffs', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    const handoff = `${file}.lock.transition.handoff`;

    writeFileSync(handoff, lockHolder(20, 'local', 2_000));
    expect(() =>
      acquireLock(file, {
        now: 2_001,
        pid: 21,
        host: 'local',
        isAlive: () => false,
      }),
    ).toThrow(/transition recovery is already in progress/);
    writeFileSync(handoff, lockHolder(20, 'local', 2_000), 'utf8');
    expect(() =>
      acquireLock(file, {
        now: 2_000 + 30 * 60 * 1000,
        pid: 21,
        host: 'local',
        isAlive: () => true,
      }),
    ).toThrow(/transition recovery is already in progress/);
    writeFileSync(handoff, '{"pid":20}');
    expect(() => acquireLock(file)).toThrow(
      /transition recovery is malformed; refusing unsafe recovery/,
    );
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
  it('serializes recovery after transition validation before stale deletion', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const file = path.join(directory, 'cache.json');
    const transition = `${file}.lock.transition`;
    writeFileSync(transition, lockHolder(20, 'local', 2_000));

    const release = acquireLock(file, {
      now: 2_001,
      pid: 21,
      host: 'local',
      isAlive: () => false,
      onStaleTransitionRecoveryValidated: () => {
        expect(() =>
          acquireLock(file, {
            now: 2_001,
            pid: 22,
            host: 'local',
            isAlive: () => false,
          }),
        ).toThrow(/transition recovery is already in progress/);
      },
    });

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
  it('requires an exact commit before an emitted snapshot can be reused', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ralph-cache-'));
    const input = path.join(directory, 'listing.json');
    writeFileSync(input, JSON.stringify([item]));
    const outputs: unknown[] = [];
    const stdout = process.stdout;
    const write = stdout.write.bind(stdout);
    stdout.write = (chunk: string) => {
      outputs.push(JSON.parse(chunk));
      return true;
    };
    try {
      main(['--repo', 'OlyForge3D/PrintFarmerDesktop', '--input', input], {
        RALPH_CACHE_DIR: directory,
      });
      main(['--repo', 'OlyForge3D/PrintFarmerDesktop', '--input', input], {
        RALPH_CACHE_DIR: directory,
      });
      const interruptedRetry = outputs[1] as {
        roundId: string;
        plan: Array<{ action: string; reason: string }>;
      };
      expect(interruptedRetry.plan).toEqual([
        expect.objectContaining({
          action: 'inspect',
          reason: 'previous round incomplete',
        }),
      ]);

      expect(() =>
        main(
          [
            '--repo',
            'OlyForge3D/PrintFarmerDesktop',
            '--commit',
            '11111111-1111-4111-8111-111111111111',
          ],
          { RALPH_CACHE_DIR: directory },
        ),
      ).toThrow(/does not match/);
      main(
        [
          '--repo',
          'OlyForge3D/PrintFarmerDesktop',
          '--commit',
          interruptedRetry.roundId,
        ],
        { RALPH_CACHE_DIR: directory },
      );
      main(['--repo', 'OlyForge3D/PrintFarmerDesktop', '--input', input], {
        RALPH_CACHE_DIR: directory,
      });
    } finally {
      stdout.write = write;
    }
    expect(outputs[3]).toMatchObject({
      plan: [{ action: 'reuse', number: 1 }],
    });
  });
});
