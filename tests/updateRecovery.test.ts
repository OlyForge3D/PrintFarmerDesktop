// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdateStateStore, type UpdateState } from '../src/main/updateState';

const temporaryDirectories: string[] = [];

async function temporaryStore(): Promise<UpdateStateStore> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'printfarmer-update-'),
  );
  temporaryDirectories.push(directory);
  const store = new UpdateStateStore(directory);
  await mkdir(store.directory, { recursive: true });
  return store;
}

function digest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('interrupted update recovery', () => {
  it('removes an interrupted partial download and returns to idle', async () => {
    const store = await temporaryStore();
    const state: UpdateState = {
      schemaVersion: 1,
      phase: 'downloading',
      highestVersion: '1.1.0',
      targetVersion: '1.1.0',
      artifactFileName: 'update.exe',
      artifactSha256: digest('complete'),
      artifactSize: 8,
    };
    await store.write(state);
    await writeFile(store.partialArtifactPath('update.exe'), 'partial');

    await expect(store.recover('1.0.0')).resolves.toMatchObject({
      phase: 'idle',
      highestVersion: '1.1.0',
    });
    await expect(
      writeFile(store.partialArtifactPath('update.exe'), 'new', { flag: 'wx' }),
    ).resolves.toBeUndefined();
  });

  it('rolls an interrupted install back to a verified downloaded update', async () => {
    const store = await temporaryStore();
    const contents = 'verified update';
    await writeFile(store.artifactPath('update.exe'), contents);
    await store.write({
      schemaVersion: 1,
      phase: 'installing',
      highestVersion: '1.1.0',
      targetVersion: '1.1.0',
      artifactFileName: 'update.exe',
      artifactSha256: digest(contents),
      artifactSize: Buffer.byteLength(contents),
    });

    await expect(store.recover('1.0.0')).resolves.toMatchObject({
      phase: 'downloaded',
      targetVersion: '1.1.0',
    });
  });

  it('clears install state after the updated app starts successfully', async () => {
    const store = await temporaryStore();
    const contents = 'verified update';
    await writeFile(store.artifactPath('update.exe'), contents);
    await store.write({
      schemaVersion: 1,
      phase: 'installing',
      highestVersion: '1.1.0',
      targetVersion: '1.1.0',
      artifactFileName: 'update.exe',
      artifactSha256: digest(contents),
      artifactSize: Buffer.byteLength(contents),
    });

    await expect(store.recover('1.1.0')).resolves.toEqual({
      schemaVersion: 1,
      phase: 'idle',
      highestVersion: '1.1.0',
    });
    await expect(
      writeFile(store.artifactPath('update.exe'), 'new', { flag: 'wx' }),
    ).resolves.toBeUndefined();
  });

  it('does not retry an interrupted install from a corrupted artifact', async () => {
    const store = await temporaryStore();
    await writeFile(store.artifactPath('update.exe'), 'tampered');
    await store.write({
      schemaVersion: 1,
      phase: 'installing',
      highestVersion: '1.1.0',
      targetVersion: '1.1.0',
      artifactFileName: 'update.exe',
      artifactSha256: digest('expected'),
      artifactSize: Buffer.byteLength('expected'),
    });

    await expect(store.recover('1.0.0')).resolves.toMatchObject({
      phase: 'idle',
      highestVersion: '1.1.0',
    });
  });

  it('rejects state file names that could delete files outside the update cache', async () => {
    const store = await temporaryStore();
    await store.write({
      schemaVersion: 1,
      phase: 'downloading',
      highestVersion: '1.1.0',
      targetVersion: '1.1.0',
      artifactFileName: '..\\outside.exe',
      artifactSha256: digest('expected'),
      artifactSize: Buffer.byteLength('expected'),
    });

    await expect(store.recover('1.0.0')).rejects.toThrow(
      'unsafe artifact file name',
    );
  });
});
