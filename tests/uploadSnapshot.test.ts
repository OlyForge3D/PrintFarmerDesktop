import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PrivateSnapshotManager,
  SnapshotError,
} from '../src/main/uploadSnapshot.js';
import { MAX_UPLOAD_REQUEST_BYTES } from '../src/main/uploadTransport.js';

let fixtureRoot: string;
let userData: string;

beforeEach(async () => {
  fixtureRoot = path.resolve('tests', `.snapshot-${randomUUID()}`);
  userData = path.join(fixtureRoot, 'user-data');
  await fs.mkdir(fixtureRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe('immutable private upload snapshots', () => {
  it('hashes and uploads one opened file, then cleans the private snapshot', async () => {
    const source = path.join(fixtureRoot, 'part.stl');
    const bytes = Buffer.from('solid immutable bytes');
    await fs.writeFile(source, bytes);
    const manager = new PrivateSnapshotManager(userData);
    const snapshot = await manager.create(
      await approvedFile(source),
      sha256(bytes),
      '11111111-1111-4111-8111-111111111111',
      new AbortController().signal,
    );
    expect(await fs.readFile(snapshot.path)).toEqual(bytes);
    expect(snapshot.size).toBe(bytes.length);
    await snapshot.cleanup();
    await expect(fs.stat(snapshot.path)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps opened bytes when an equal-metadata pathname is replaced', async () => {
    const source = path.join(fixtureRoot, 'part.stl');
    const replacement = path.join(fixtureRoot, 'replacement.stl');
    const expected = Buffer.alloc(128 * 1024, 1);
    const changed = Buffer.alloc(expected.length, 2);
    await fs.writeFile(source, expected);
    await fs.writeFile(replacement, changed);
    const approved = await approvedFile(source);
    await fs.unlink(source);
    await fs.rename(replacement, source);
    const manager = new PrivateSnapshotManager(userData);
    const snapshot = await manager.create(
      approved,
      sha256(expected),
      '11111111-1111-4111-8111-111111111111',
      new AbortController().signal,
    );
    expect(sha256(await fs.readFile(snapshot.path))).toBe(sha256(expected));
    await snapshot.cleanup();
  });

  it.each(['growth', 'truncation'] as const)(
    'rejects source %s during copy and cleans partial data',
    async (change) => {
      const source = path.join(fixtureRoot, 'part.stl');
      const expected = Buffer.alloc(256 * 1024, 3);
      await fs.writeFile(source, expected);
      let changed = false;
      const manager = new PrivateSnapshotManager(userData, randomUUID, {
        afterChunk: async () => {
          if (changed) return;
          changed = true;
          if (change === 'growth')
            await fs.appendFile(source, Buffer.from('x'));
          else await fs.truncate(source, 1);
        },
      });
      await expect(
        manager.create(
          await approvedFile(source),
          sha256(expected),
          '11111111-1111-4111-8111-111111111111',
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(SnapshotError);
      const snapshots = path.join(
        userData,
        'upload-snapshots',
        '11111111-1111-4111-8111-111111111111',
      );
      await expect(fs.readdir(snapshots)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('cleans partial snapshots when cancelled', async () => {
    const source = path.join(fixtureRoot, 'part.stl');
    const expected = Buffer.alloc(256 * 1024, 4);
    await fs.writeFile(source, expected);
    const controller = new AbortController();
    const manager = new PrivateSnapshotManager(userData, randomUUID, {
      afterChunk: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    await expect(
      manager.create(
        await approvedFile(source),
        sha256(expected),
        '11111111-1111-4111-8111-111111111111',
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      fs.readdir(path.join(userData, 'upload-snapshots')),
    ).resolves.toEqual([]);
  });

  it('sweeps only safe stale per-job snapshot directories at startup', async () => {
    const snapshots = path.join(userData, 'upload-snapshots');
    const staleJob = path.join(
      snapshots,
      '11111111-1111-4111-8111-111111111111',
    );
    const unsafeDirectory = path.join(snapshots, 'not-a-job');
    await fs.mkdir(staleJob, { recursive: true });
    await fs.mkdir(unsafeDirectory, { recursive: true });
    await fs.writeFile(
      path.join(staleJob, '22222222-2222-4222-8222-222222222222.model'),
      'orphan',
    );
    await fs.writeFile(path.join(unsafeDirectory, 'keep.txt'), 'keep');
    const manager = new PrivateSnapshotManager(userData);
    await manager.initialize();
    await expect(fs.stat(staleJob)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.readFile(path.join(unsafeDirectory, 'keep.txt')),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('retries snapshot cleanup after a transient failure', async () => {
    const source = path.join(fixtureRoot, 'part.stl');
    const bytes = Buffer.from('cleanup retry');
    await fs.writeFile(source, bytes);
    let cleanupAttempts = 0;
    const manager = new PrivateSnapshotManager(userData, randomUUID, {
      beforeCleanup: () => {
        cleanupAttempts += 1;
        return cleanupAttempts === 1
          ? Promise.reject(new Error('transient cleanup error'))
          : Promise.resolve();
      },
    });
    const snapshot = await manager.create(
      await approvedFile(source),
      sha256(bytes),
      '11111111-1111-4111-8111-111111111111',
      new AbortController().signal,
    );
    await expect(snapshot.cleanup()).rejects.toThrow(/transient/);
    await expect(snapshot.cleanup()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
  });

  it('accepts the 500 MB upload boundary and starts copying before cancellation', async () => {
    const source = path.join(fixtureRoot, 'max-size.model');
    await fs.writeFile(source, '');
    await fs.truncate(source, MAX_UPLOAD_REQUEST_BYTES);
    const approved = await approvedFile(source);
    const controller = new AbortController();
    const manager = new PrivateSnapshotManager(userData, randomUUID, {
      afterChunk: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    await expect(
      manager.create(
        approved,
        'unused-for-abort',
        '11111111-1111-4111-8111-111111111111',
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects files larger than the 500 MB upload boundary', async () => {
    const source = path.join(fixtureRoot, 'over-limit.model');
    await fs.writeFile(source, '');
    await fs.truncate(source, MAX_UPLOAD_REQUEST_BYTES + 1);
    const manager = new PrivateSnapshotManager(userData);

    await expect(
      manager.create(
        await approvedFile(source),
        'not-used',
        '11111111-1111-4111-8111-111111111111',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'SOURCE_TOO_LARGE',
    });
  });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function approvedFile(filePath: string) {
  const handle = await fs.open(filePath, 'r');
  const stat = await handle.stat();
  return {
    handle,
    canonicalPath: await fs.realpath(filePath),
    size: stat.size,
  };
}
