import path from 'node:path';
import os from 'node:os';
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

  it('canonicalizes a picked file without authorizing it, and reports a missing one as INVALID_ROOT', async () => {
    const fileSystem = fakeFileSystem();
    const picked = path.resolve('nowhere', 'picked.3mf');
    const resolved = path.resolve('nowhere', 'picked-resolved.3mf');
    const absent = path.resolve('nowhere', 'absent.3mf');
    fileSystem.realpaths.set(picked, resolved);
    const store = new RootApprovalStore({
      userDataPath: path.resolve('user-data'),
      fileSystem,
      createId: () => '11111111-1111-4111-8111-111111111111',
      now: () => 0,
    });

    // The legitimate maximum: no root has ever been approved and this still
    // resolves. `canonicalizePickerFile` is a `realpath` wrapper that performs
    // no authorization — the property `tests/ipc.authz.test.ts` depends on when
    // it requires every refusal to originate at `authorizeFile`. Pinned here,
    // against the real implementation, so the fake over there cannot drift from
    // it unnoticed in both places at once.
    await expect(store.canonicalizePickerFile(picked)).resolves.toBe(resolved);

    // And it is emphatically not an approval: the same path is still refused by
    // the step that does authorize. Without this, a `canonicalizePickerFile`
    // that started admitting paths would look identical to one that does not.
    await expect(store.authorizeFile(picked)).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });

    // The one input it does refuse. Untested repo-wide until now, which is what
    // made "the fake never throws where the real one does" impossible to check
    // against anything.
    await expect(store.canonicalizePickerFile(absent)).rejects.toMatchObject({
      code: 'INVALID_ROOT',
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

  it('rejects a source classified as a symbolic link before opening it', async () => {
    const fixture = path.resolve('tests', `.approval-${randomUUID()}`);
    const root = path.join(fixture, 'root');
    const target = path.join(root, 'target.stl');
    let reportTargetAsSymlink = false;
    try {
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(target, 'bytes');
      const fileSystem: RootApprovalFileSystem = {
        readFile: (filePath) => fs.readFile(filePath),
        writeFile: (filePath, data) => fs.writeFile(filePath, data),
        rename: (from, to) => fs.rename(from, to),
        mkdir: (directory) =>
          fs.mkdir(directory, { recursive: true }).then(() => undefined),
        unlink: (filePath) => fs.unlink(filePath),
        realpath: (filePath) => fs.realpath(filePath),
        open: (filePath, flags) => fs.open(filePath, flags),
        lstat: async (filePath) => {
          const stats = await fs.lstat(filePath, { bigint: true });
          if (filePath !== target || !reportTargetAsSymlink) return stats;
          Object.defineProperty(stats, 'isSymbolicLink', {
            value: () => true,
          });
          return stats;
        },
      };
      const store = new RootApprovalStore({
        userDataPath: path.join(fixture, 'user-data'),
        fileSystem,
      });
      await store.approveFromPicker(root);

      const direct = await store.openApprovedFile(target);
      expect(direct.size).toBe(5);
      await direct.handle.close();

      reportTargetAsSymlink = true;
      await expect(store.openApprovedFile(target)).rejects.toMatchObject({
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

describe('picker-allowlist re-binding premise (#102 N3)', () => {
  // This does not test our code, and it is not a behaviour pin. It records, as
  // something that can fail, the platform measurement behind a decision *not*
  // to re-bind the picker allowlist to filesystem identity.
  //
  // `ipc.ts` admits a picked file by canonical-string membership. Binding the
  // entry to device+inode at admission instead would refuse the file whenever
  // its identity changed. The question is whether that discriminates a hostile
  // post-pick swap from a benign save, and it does not: it gets the two
  // backwards. A save that writes a sibling and renames over the original - the
  // atomic-save pattern - changes identity, so the user would be forced back to
  // the picker after an ordinary edit. A rewrite in place does not change
  // identity, so the swap that needs no elevated access at all goes straight
  // through.
  //
  // This holds on both shipped platforms, and the evidence is this test rather
  // than a claim about it: it carries no platform guard, so CI runs it on
  // `Desktop (windows-latest)` and `Desktop (macos-latest)` alike, and it
  // passed on APFS in the #114 verification run. The earlier write-up tagged
  // the result `win32` because it came from a throwaway probe script; that tag
  // was narrower than the evidence and is not repeated here.
  //
  // If this ever stops holding, the recorded rationale is no longer true and
  // the decision should be revisited rather than inherited.
  it('cannot tell an atomic save from a swap, and misses an in-place rewrite', async () => {
    const directory = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), 'pf-n3-'),
    );
    try {
      const file = path.join(directory, 'model.3mf');
      const identity = async () => {
        const stats = await fs.stat(file, { bigint: true });
        return `${stats.dev}:${stats.ino}`;
      };

      await fs.writeFile(file, 'original model bytes');
      const atPick = await identity();
      expect(atPick.endsWith(':0')).toBe(false);

      await fs.truncate(file, 0);
      await fs.writeFile(file, 'different bytes, rewritten in place');
      expect(
        await identity(),
        'an in-place rewrite would slip past an identity check',
      ).toBe(atPick);

      const sibling = `${file}.tmp`;
      await fs.writeFile(sibling, 'different bytes, written alongside');
      await fs.rename(sibling, file);
      expect(
        await identity(),
        'an ordinary atomic save would be refused by an identity check',
      ).not.toBe(atPick);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
