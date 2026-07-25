import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isWithinRoot,
  RootApprovalError,
  RootApprovalStore,
  sameFileIdentity,
  type RootApprovalFileSystem,
} from '../src/main/rootApprovals.js';

function fakeFileSystem(): RootApprovalFileSystem & {
  files: Map<string, Uint8Array>;
  realpaths: Map<string, string>;
  identity: { dev: bigint; ino: bigint };
} {
  const files = new Map<string, Uint8Array>();
  const realpaths = new Map<string, string>();
  const identity = { dev: 1n, ino: 2n };
  return {
    files,
    realpaths,
    identity,
    readFile(filePath) {
      const value = files.get(filePath);
      return value
        ? Promise.resolve(value)
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          );
    },
    writeFile(filePath, data) {
      files.set(filePath, Buffer.from(data));
      return Promise.resolve();
    },
    rename(from, to) {
      const value = files.get(from);
      if (!value) {
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      }
      files.set(to, value);
      files.delete(from);
      return Promise.resolve();
    },
    mkdir() {
      return Promise.resolve();
    },
    unlink(filePath) {
      if (!files.delete(filePath)) {
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      }
      return Promise.resolve();
    },
    realpath(filePath) {
      const value = realpaths.get(filePath);
      return value
        ? Promise.resolve(value)
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          );
    },
    lstat(filePath) {
      const exists = realpaths.has(filePath);
      return exists
        ? Promise.resolve({
            dev: identity.dev,
            ino: identity.ino,
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => false,
          } as BigIntStats)
        : Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          );
    },
  };
}

describe('main-owned root approvals', () => {
  it('compares Windows-sized file IDs losslessly as bigint', () => {
    const first = 9_007_199_254_740_992n;
    const second = 9_007_199_254_740_993n;
    expect(Number(first)).toBe(Number(second));
    expect(
      sameFileIdentity({ dev: 1n, ino: first }, { dev: 1n, ino: second }),
    ).toBe(false);
  });
  it('only authorizes canonical roots recorded by the picker', async () => {
    const fileSystem = fakeFileSystem();
    const selected = path.resolve('approved');
    const model = path.join(selected, 'models', 'part.stl');
    fileSystem.realpaths.set(selected, selected);
    fileSystem.realpaths.set(model, model);
    const store = new RootApprovalStore({
      userDataPath: path.resolve('user-data'),
      fileSystem,
      createId: () => '11111111-1111-4111-8111-111111111111',
      now: () => 0,
    });

    await expect(
      store.resolve('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(RootApprovalError);
    const approval = await store.approveFromPicker(selected);
    expect(await store.resolve(approval.id)).toBe(selected);
    const persisted = [...fileSystem.files.values()]
      .map((value) => Buffer.from(value).toString('utf8'))
      .join('');
    expect(persisted).toContain('"deviceId":"1"');
    expect(persisted).toContain('"fileId":"2"');
    await expect(store.authorizeFile(model)).resolves.toEqual({
      sourcePath: model,
      canonicalPath: model,
    });
  });

  it('rejects a root whose filesystem identity changed while its path stayed identical', async () => {
    const fileSystem = fakeFileSystem();
    const selected = path.resolve('approved-identity');
    const model = path.join(selected, 'models', 'part.stl');
    fileSystem.realpaths.set(selected, selected);
    fileSystem.realpaths.set(model, model);
    const store = new RootApprovalStore({
      userDataPath: path.resolve('user-data-identity'),
      fileSystem,
      createId: () => '33333333-3333-4333-8333-333333333333',
      now: () => 0,
    });
    await store.approveFromPicker(selected);
    await expect(store.authorizeFile(model)).resolves.toEqual({
      sourcePath: model,
      canonicalPath: model,
    });

    // Swap the inode behind an unchanged path: the approved directory was
    // replaced with a different one at the same location. Every path-shaped
    // check still succeeds — `samePath` compares the same two strings and
    // `isWithinRoot` still contains the model — so only the stored-identity
    // comparison at rootApprovals.ts:209 can reject this. Varying the path
    // instead would measure containment and leave this control unproven.
    fileSystem.identity.ino = 99n;

    await expect(store.authorizeFile(model)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
  });

  it('rejects sibling-prefix paths and renderer-invented approvals', async () => {
    const root = path.resolve('models');
    expect(isWithinRoot(root, path.join(root, 'part.stl'))).toBe(true);
    expect(
      isWithinRoot(root, path.resolve('models-private', 'secret.stl')),
    ).toBe(false);
    expect(isWithinRoot('C:\\Models', 'C:\\models\\part.stl')).toBe(false);

    const store = new RootApprovalStore({
      userDataPath: path.resolve('user-data'),
      fileSystem: fakeFileSystem(),
    });
    await expect(
      store.resolve('22222222-2222-4222-8222-222222222222'),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('rejects an ancestor path swap around the approved open', async () => {
    const fixture = path.resolve('tests', `.approval-${randomUUID()}`);
    const root = path.join(fixture, 'root');
    const ancestor = path.join(root, 'models');
    const replacement = path.join(root, 'replacement');
    const source = path.join(ancestor, 'part.stl');
    try {
      await fs.mkdir(ancestor, { recursive: true });
      await fs.mkdir(replacement, { recursive: true });
      await fs.writeFile(source, 'approved bytes');
      await fs.writeFile(path.join(replacement, 'part.stl'), 'other bytes');
      const store = new RootApprovalStore({
        userDataPath: path.join(fixture, 'user-data'),
        beforeApprovedOpen: async () => {
          await fs.rename(ancestor, path.join(root, 'old-models'));
          await fs.rename(replacement, ancestor);
        },
      });
      await store.approveFromPicker(root);
      await expect(store.openApprovedFile(source)).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic-link source before opening it', async () => {
    const fixture = path.resolve('tests', `.approval-${randomUUID()}`);
    const root = path.join(fixture, 'root');
    const target = path.join(root, 'target.stl');
    const source = path.join(root, 'link.stl');
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(target, 'bytes');
      try {
        await fs.symlink(target, source, 'file');
      } catch (error) {
        if ((error as { code?: unknown }).code === 'EPERM') return;
        throw error;
      }
      const store = new RootApprovalStore({
        userDataPath: path.join(fixture, 'user-data'),
      });
      await store.approveFromPicker(root);
      await expect(store.openApprovedFile(source)).rejects.toMatchObject({
        code: 'APPROVAL_REQUIRED',
      });
    } finally {
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });

  it('surfaces corruption and only resets after an explicit call', async () => {
    const fileSystem = fakeFileSystem();
    const userData = path.resolve('corrupt-user-data');
    const storePath = path.join(userData, 'approved-roots.v1.json');
    fileSystem.files.set(storePath, Buffer.from('{broken'));
    const store = new RootApprovalStore({
      userDataPath: userData,
      fileSystem,
    });
    await expect(
      store.resolve('11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ code: 'CORRUPT_APPROVAL_STORE' });
    expect(fileSystem.files.has(storePath)).toBe(true);
    await store.reset();
    expect(fileSystem.files.has(storePath)).toBe(false);
  });

  it('requires explicit native-picker reauthorization for roots approved before BigInt identity tracking', async () => {
    const fileSystem = fakeFileSystem();
    const userData = path.resolve('legacy-user-data');
    const storePath = path.join(userData, 'approved-roots.v1.json');
    const legacyRootId = '55555555-5555-4555-8555-555555555555';
    const selected = path.resolve('legacy-approved');
    const model = path.join(selected, 'part.stl');
    fileSystem.realpaths.set(selected, selected);
    fileSystem.realpaths.set(model, model);
    // Pre-migration store contents: no deviceId/fileId fields at all,
    // as written by the version before BigInt identity tracking existed.
    fileSystem.files.set(
      storePath,
      Buffer.from(
        JSON.stringify({
          version: 1,
          roots: [
            {
              id: legacyRootId,
              canonicalPath: selected,
              approvedAt: new Date(0).toISOString(),
            },
          ],
        }),
      ),
    );
    const store = new RootApprovalStore({
      userDataPath: userData,
      fileSystem,
      createId: () => '66666666-6666-4666-8666-666666666666',
      now: () => 1000,
    });

    await expect(store.resolve(legacyRootId)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await expect(store.authorizeFile(model)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });

    // Reauthorizing the same folder through the native picker upgrades
    // the existing entry in place instead of minting a duplicate.
    const reauthorized = await store.approveFromPicker(selected);
    expect(reauthorized.id).toBe(legacyRootId);
    expect(await store.resolve(legacyRootId)).toBe(selected);
    await expect(store.authorizeFile(model)).resolves.toEqual({
      sourcePath: model,
      canonicalPath: model,
    });
    const persisted = [...fileSystem.files.values()]
      .map((value) => Buffer.from(value).toString('utf8'))
      .join('');
    expect(persisted).toContain('"deviceId":"1"');
    expect(persisted).toContain('"fileId":"2"');
  });
});
