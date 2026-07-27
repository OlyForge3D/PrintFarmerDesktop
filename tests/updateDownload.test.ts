// @vitest-environment node

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { App } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateStateStore } from '../src/main/updateState';

vi.mock('electron', () => ({ autoUpdater: {} }));

const { UpdateManager } = await import('../src/main/updates');
const temporaryDirectories: string[] = [];

function releaseFixture(artifact: string): {
  metadataUrl: string;
  publicKey: string;
  responses: Map<string, Response>;
} {
  const metadataUrl =
    'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/latest/download/latest.json';
  const artifactUrl =
    'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/download/v1.1.0/PrintFarmer-1.1.0.Setup.exe';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const metadata = `${JSON.stringify(
    {
      schemaVersion: 1,
      version: '1.1.0',
      publishedAt: '2026-07-27T18:00:00Z',
      artifacts: {
        'win32-x64': {
          fileName: 'PrintFarmer-1.1.0.Setup.exe',
          url: artifactUrl,
          sha256: createHash('sha256').update(artifact).digest('hex'),
          size: Buffer.byteLength(artifact),
        },
        'darwin-universal': {
          fileName: 'PrintFarmer-darwin-universal-1.1.0.zip',
          url: 'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/download/v1.1.0/PrintFarmer-darwin-universal-1.1.0.zip',
          sha256: 'a'.repeat(64),
          size: 1,
        },
      },
    },
    null,
    2,
  )}\n`;
  const signature = sign(null, Buffer.from(metadata), privateKey).toString(
    'base64',
  );
  return {
    metadataUrl,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    responses: new Map([
      [metadataUrl, new Response(metadata)],
      [`${metadataUrl}.sig`, new Response(signature)],
      [
        artifactUrl,
        new Response(artifact, {
          headers: { 'content-length': String(Buffer.byteLength(artifact)) },
        }),
      ],
    ]),
  };
}

async function managerFixture(artifact: string): Promise<{
  manager: InstanceType<typeof UpdateManager>;
  fixture: ReturnType<typeof releaseFixture>;
  store: UpdateStateStore;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'update-download-'));
  temporaryDirectories.push(directory);
  const fixture = releaseFixture(artifact);
  const fetchImplementation: typeof fetch = (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const response = fixture.responses.get(url);
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve(response.clone());
  };
  const app = {
    getVersion: () => '1.0.0',
    getPath: () => directory,
    quit: vi.fn(),
  } as unknown as Pick<App, 'getVersion' | 'getPath' | 'quit'>;
  return {
    manager: new UpdateManager({
      app,
      publicKeyPem: fixture.publicKey,
      metadataUrl: fixture.metadataUrl,
      platform: 'win32',
      arch: 'x64',
      fetchImplementation,
    }),
    fixture,
    store: new UpdateStateStore(directory),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('verified update download', () => {
  it('stages an artifact only after its signed size and digest match', async () => {
    const { manager, store } = await managerFixture('signed installer');

    await manager.checkForUpdates();

    await expect(store.read('1.0.0')).resolves.toMatchObject({
      phase: 'downloaded',
      targetVersion: '1.1.0',
    });
  });

  it('rejects substituted artifact bytes and recovery removes the partial state', async () => {
    const { manager, fixture, store } =
      await managerFixture('signed installer');
    const artifactUrl = [...fixture.responses.keys()].find((url) =>
      url.endsWith('.Setup.exe'),
    )!;
    fixture.responses.set(artifactUrl, new Response('tampered payload'));

    await expect(manager.checkForUpdates()).rejects.toThrow(
      'integrity check failed',
    );
    await expect(store.recover('1.0.0')).resolves.toMatchObject({
      phase: 'idle',
      highestVersion: '1.1.0',
    });
  });
});
