import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isWithinRoot,
  RootApprovalError,
  RootApprovalStore,
  type RootApprovalFileSystem,
} from '../src/main/rootApprovals.js';

function fakeFileSystem(): RootApprovalFileSystem & {
  files: Map<string, Uint8Array>;
  realpaths: Map<string, string>;
} {
  const files = new Map<string, Uint8Array>();
  const realpaths = new Map<string, string>();
  return {
    files,
    realpaths,
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
  };
}

describe('main-owned root approvals', () => {
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
    await expect(store.authorizeFile(model)).resolves.toEqual({
      sourcePath: model,
      canonicalPath: model,
    });
  });

  it('rejects sibling-prefix paths and renderer-invented approvals', async () => {
    const root = path.resolve('models');
    expect(isWithinRoot(root, path.join(root, 'part.stl'))).toBe(true);
    expect(
      isWithinRoot(root, path.resolve('models-private', 'secret.stl')),
    ).toBe(false);

    const store = new RootApprovalStore({
      userDataPath: path.resolve('user-data'),
      fileSystem: fakeFileSystem(),
    });
    await expect(
      store.resolve('22222222-2222-4222-8222-222222222222'),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
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
});
