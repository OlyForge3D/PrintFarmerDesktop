import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PrivateSnapshotManager,
  SnapshotError,
} from '../src/main/uploadSnapshot.js';

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
      source,
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

  it('rejects a pathname swap between lstat and open', async () => {
    const source = path.join(fixtureRoot, 'part.stl');
    const replacement = path.join(fixtureRoot, 'replacement.stl');
    await fs.writeFile(source, 'expected');
    await fs.writeFile(replacement, 'different');
    const manager = new PrivateSnapshotManager(userData, randomUUID, {
      afterLstat: async () => {
        await fs.unlink(source);
        await fs.rename(replacement, source);
      },
    });
    await expect(
      manager.create(
        source,
        sha256(Buffer.from('expected')),
        '11111111-1111-4111-8111-111111111111',
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SnapshotError);
  });

  it('keeps opened bytes when an equal-metadata pathname is replaced', async () => {
    const source = path.join(fixtureRoot, 'part.stl');
    const replacement = path.join(fixtureRoot, 'replacement.stl');
    const expected = Buffer.alloc(128 * 1024, 1);
    const changed = Buffer.alloc(expected.length, 2);
    await fs.writeFile(source, expected);
    await fs.writeFile(replacement, changed);
    const manager = new PrivateSnapshotManager(userData, randomUUID, {
      afterOpen: async () => {
        await fs.unlink(source);
        await fs.rename(replacement, source);
      },
    });
    const snapshot = await manager.create(
      source,
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
          source,
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

  it('rejects symbolic-link sources', async () => {
    const target = path.join(fixtureRoot, 'target.stl');
    const source = path.join(fixtureRoot, 'link.stl');
    await fs.writeFile(target, 'target');
    try {
      await fs.symlink(target, source, 'file');
    } catch (error) {
      if ((error as { code?: unknown }).code === 'EPERM') return;
      throw error;
    }
    const manager = new PrivateSnapshotManager(userData);
    await expect(
      manager.create(
        source,
        sha256(Buffer.from('target')),
        '11111111-1111-4111-8111-111111111111',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_SYMLINK' });
  });

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
        source,
        sha256(expected),
        '11111111-1111-4111-8111-111111111111',
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      fs.readdir(path.join(userData, 'upload-snapshots')),
    ).resolves.toEqual([]);
  });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
