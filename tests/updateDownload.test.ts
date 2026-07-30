// @vitest-environment node

import { EventEmitter } from 'node:events';
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { App, AutoUpdater } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateStateStore } from '../src/main/updateState';
import type { UpdateManagerOptions } from '../src/main/updates';

vi.mock('electron', () => ({ autoUpdater: {} }));

const { UpdateManager, fetchBoundedText } = await import('../src/main/updates');
const temporaryDirectories: string[] = [];

function releaseFixture(
  artifact: string,
  version = '1.1.0',
  signingKeys: {
    privateKey: KeyObject;
    publicKey: KeyObject;
  } = generateKeyPairSync('ed25519'),
): {
  metadataUrl: string;
  publicKey: string;
  responses: Map<string, Response>;
  windowsArtifactUrl: string;
  macArtifactUrl: string;
  windowsFileName: string;
  macFileName: string;
  metadataPayload: string;
  metadataSignature: string;
  signingKeys: { privateKey: KeyObject; publicKey: KeyObject };
} {
  const metadataUrl =
    'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/latest/download/latest.json';
  const windowsFileName = `PrintFarmer-${version}.Setup.exe`;
  const macFileName = `PrintFarmer-darwin-universal-${version}.zip`;
  const windowsArtifactUrl = `https://github.com/OlyForge3D/PrintFarmerDesktop/releases/download/v${version}/${windowsFileName}`;
  const macArtifactUrl = `https://github.com/OlyForge3D/PrintFarmerDesktop/releases/download/v${version}/${macFileName}`;
  const { privateKey, publicKey } = signingKeys;
  const artifactIdentity = {
    sha256: createHash('sha256').update(artifact).digest('hex'),
    size: Buffer.byteLength(artifact),
  };
  const metadata = `${JSON.stringify(
    {
      schemaVersion: 1,
      version,
      publishedAt: '2026-07-27T18:00:00Z',
      artifacts: {
        'win32-x64': {
          fileName: windowsFileName,
          url: windowsArtifactUrl,
          ...artifactIdentity,
        },
        'darwin-universal': {
          fileName: macFileName,
          url: macArtifactUrl,
          ...artifactIdentity,
        },
      },
    },
    null,
    2,
  )}\n`;
  const signature = sign(null, Buffer.from(metadata), privateKey).toString(
    'base64',
  );
  const artifactResponse = () =>
    new Response(artifact, {
      headers: { 'content-length': String(Buffer.byteLength(artifact)) },
    });
  return {
    metadataUrl,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    responses: new Map([
      [metadataUrl, new Response(metadata)],
      [`${metadataUrl}.sig`, new Response(signature)],
      [windowsArtifactUrl, artifactResponse()],
      [macArtifactUrl, artifactResponse()],
    ]),
    windowsArtifactUrl,
    macArtifactUrl,
    windowsFileName,
    macFileName,
    metadataPayload: metadata,
    metadataSignature: signature,
    signingKeys,
  };
}

class StagingAutoUpdater extends EventEmitter {
  readonly quitAndInstall = vi.fn();
  readonly requestedUrls: string[] = [];
  feedUrl = '';
  beforeArtifactFetch?: () => Promise<void>;
  artifactBytes: Buffer | null = null;

  setFeedURL(options: { url: string }): void {
    this.feedUrl = options.url;
  }

  checkForUpdates(): void {
    void (async () => {
      try {
        const feedUrl = `${this.feedUrl}?version=1.0.0&channel=stable`;
        this.requestedUrls.push(feedUrl);
        const feedResponse = await fetch(feedUrl);
        if (!feedResponse.ok) {
          throw new Error(
            `feed request failed with HTTP ${feedResponse.status}`,
          );
        }
        const feed = (await feedResponse.json()) as { url: string };
        await this.beforeArtifactFetch?.();
        const artifactUrl = `${feed.url}?source=Squirrel.Mac`;
        this.requestedUrls.push(artifactUrl);
        const artifactResponse = await fetch(artifactUrl);
        if (!artifactResponse.ok) {
          throw new Error(
            `artifact request failed with HTTP ${artifactResponse.status}`,
          );
        }
        this.artifactBytes = Buffer.from(await artifactResponse.arrayBuffer());
        this.emit('update-downloaded');
      } catch (error) {
        this.emit('error', error);
      }
    })();
  }
}

function successfulLaunch(): NonNullable<
  UpdateManagerOptions['launchWindowsInstaller']
> {
  return vi.fn(() => Promise.resolve());
}

async function managerFixture(
  artifact: string,
  options: {
    platform?: NodeJS.Platform;
    nativeAutoUpdater?: AutoUpdater;
    launchWindowsInstaller?: UpdateManagerOptions['launchWindowsInstaller'];
    openArtifactFile?: UpdateManagerOptions['openArtifactFile'];
    createArtifactReadStream?: UpdateManagerOptions['createArtifactReadStream'];
    onError?: (error: unknown) => void;
    fetchImplementation?: typeof fetch;
    version?: string;
    directory?: string;
    signingKeys?: { privateKey: KeyObject; publicKey: KeyObject };
  } = {},
): Promise<{
  manager: InstanceType<typeof UpdateManager>;
  fixture: ReturnType<typeof releaseFixture>;
  store: UpdateStateStore;
  directory: string;
  app: Pick<App, 'getVersion' | 'getPath' | 'quit'>;
}> {
  const directory =
    options.directory ??
    (await mkdtemp(path.join(os.tmpdir(), 'update-download-')));
  if (!options.directory) temporaryDirectories.push(directory);
  const fixture = releaseFixture(
    artifact,
    options.version,
    options.signingKeys,
  );
  const fetchImplementation: typeof fetch =
    options.fetchImplementation ??
    ((input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const response = fixture.responses.get(url);
      if (!response) throw new Error(`unexpected fetch: ${url}`);
      return Promise.resolve(response.clone());
    });
  const app = {
    getVersion: () => '1.0.0',
    getPath: () => directory,
    quit: vi.fn(),
  } as unknown as Pick<App, 'getVersion' | 'getPath' | 'quit'>;
  const managerOptions: UpdateManagerOptions = {
    app,
    publicKeyPem: fixture.publicKey,
    metadataUrl: fixture.metadataUrl,
    platform: options.platform ?? 'win32',
    arch: options.platform === 'darwin' ? 'arm64' : 'x64',
    fetchImplementation,
    ...(options.nativeAutoUpdater
      ? { nativeAutoUpdater: options.nativeAutoUpdater }
      : {}),
    ...(options.launchWindowsInstaller
      ? { launchWindowsInstaller: options.launchWindowsInstaller }
      : {}),
    ...(options.openArtifactFile
      ? { openArtifactFile: options.openArtifactFile }
      : {}),
    ...(options.createArtifactReadStream
      ? { createArtifactReadStream: options.createArtifactReadStream }
      : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  };
  return {
    manager: new UpdateManager(managerOptions),
    fixture,
    store: new UpdateStateStore(directory),
    directory,
    app,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('bounded update metadata', () => {
  it('accepts a chunked response exactly at the byte limit', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(new Response('1234')),
    ) as unknown as typeof fetch;

    await expect(
      fetchBoundedText(fetchImplementation, 'https://example.test/data', 4),
    ).resolves.toBe('1234');
  });

  it('stops a chunked response one byte over the limit', async () => {
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(new Response('12345')),
    ) as unknown as typeof fetch;

    await expect(
      fetchBoundedText(fetchImplementation, 'https://example.test/data', 4),
    ).rejects.toThrow('exceeds 4 bytes');
  });
});

describe('verified update download', () => {
  it('stages an artifact only after its signed size and digest match', async () => {
    const { manager, store } = await managerFixture('signed installer');

    await manager.checkForUpdates();

    await expect(store.read()).resolves.toMatchObject({
      schemaVersion: 3,
      phase: 'downloaded',
      targetVersion: '1.1.0',
    });
  });

  it('rejects substituted artifact bytes and recovery removes the partial state', async () => {
    const { manager, fixture, store } =
      await managerFixture('signed installer');
    fixture.responses.set(
      fixture.windowsArtifactUrl,
      new Response('tampered payload'),
    );

    await expect(manager.checkForUpdates()).rejects.toThrow(
      'integrity check failed',
    );
    await expect(store.recover('1.0.0')).resolves.toMatchObject({
      phase: 'idle',
    });
  });

  it('never authorizes attacker-written state without fresh signed metadata', async () => {
    const launchWindowsInstaller = vi.fn();
    const fetchImplementation = vi.fn(() =>
      Promise.reject(new Error('release metadata unavailable')),
    ) as unknown as typeof fetch;
    const { manager, fixture, store } = await managerFixture(
      'signed installer',
      {
        fetchImplementation,
        launchWindowsInstaller:
          launchWindowsInstaller as unknown as UpdateManagerOptions['launchWindowsInstaller'],
      },
    );
    const malicious = 'attacker controlled installer';
    await mkdir(store.directory, { recursive: true });
    await writeFile(store.artifactPath(fixture.windowsFileName), malicious);
    await store.write({
      schemaVersion: 3,
      phase: 'downloaded',
      targetVersion: '1.1.0',
      artifactFileName: fixture.windowsFileName,
      artifactSha256: createHash('sha256').update(malicious).digest('hex'),
      artifactSize: Buffer.byteLength(malicious),
      metadataPayload: fixture.metadataPayload,
      metadataSignature: 'AAAA',
    });

    await expect(manager.initialize()).rejects.toThrow(
      'signature verification failed',
    );
    await expect(manager.installReadyUpdate()).resolves.toBe(false);
    expect(launchWindowsInstaller).not.toHaveBeenCalled();
  });

  it('checks for a newer release instead of being pinned by a recovered download', async () => {
    const { manager, fixture, store } = await managerFixture(
      'new signed installer',
      { version: '1.2.0' },
    );
    const oldFileName = 'PrintFarmer-1.1.0.Setup.exe';
    const oldArtifact = 'old signed installer';
    const oldFixture = releaseFixture(
      oldArtifact,
      '1.1.0',
      fixture.signingKeys,
    );
    await mkdir(store.directory, { recursive: true });
    await writeFile(store.artifactPath(oldFileName), oldArtifact);
    await store.write({
      schemaVersion: 3,
      phase: 'downloaded',
      targetVersion: '1.1.0',
      artifactFileName: oldFileName,
      artifactSha256: createHash('sha256').update(oldArtifact).digest('hex'),
      artifactSize: Buffer.byteLength(oldArtifact),
      metadataPayload: oldFixture.metadataPayload,
      metadataSignature: oldFixture.metadataSignature,
    });

    await manager.initialize();

    await expect(store.read()).resolves.toMatchObject({
      phase: 'downloaded',
      targetVersion: '1.2.0',
      artifactFileName: fixture.windowsFileName,
    });
  });

  it('preserves a higher same-key signed candidate across restart and replay', async () => {
    const signingKeys = generateKeyPairSync('ed25519');
    const first = await managerFixture('signed 1.2.0 installer', {
      version: '1.2.0',
      signingKeys,
    });
    await first.manager.initialize();

    const replay = await managerFixture('signed 1.1.0 installer', {
      version: '1.1.0',
      signingKeys,
      directory: first.directory,
    });
    await replay.manager.initialize();

    await expect(replay.store.read()).resolves.toMatchObject({
      phase: 'downloaded',
      targetVersion: '1.2.0',
      artifactFileName: first.fixture.windowsFileName,
      metadataPayload: first.fixture.metadataPayload,
      metadataSignature: first.fixture.metadataSignature,
    });
    await expect(
      readFile(
        replay.store.artifactPath(first.fixture.windowsFileName),
        'utf8',
      ),
    ).resolves.toBe('signed 1.2.0 installer');
  });
});

describe('Windows update installation', () => {
  it('restores downloaded state when the bound launch rejects a changed installer', async () => {
    const launchWindowsInstaller = vi.fn(() =>
      Promise.reject(new Error('installer digest mismatch')),
    );
    const { manager, fixture, store, app } = await managerFixture(
      'signed installer',
      { launchWindowsInstaller },
    );
    await manager.initialize();
    await writeFile(
      store.artifactPath(fixture.windowsFileName),
      'swapped installer',
    );

    await expect(manager.installReadyUpdate()).rejects.toThrow(
      'installer digest mismatch',
    );
    expect(launchWindowsInstaller).toHaveBeenCalledOnce();
    await expect(store.read()).resolves.toMatchObject({ phase: 'downloaded' });
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('quits cleanly only after the verified installer has spawned', async () => {
    const launchWindowsInstaller = successfulLaunch();
    const { manager, app } = await managerFixture('signed installer', {
      launchWindowsInstaller,
    });
    await manager.initialize();

    await expect(manager.installReadyUpdate()).resolves.toBe(true);

    expect(launchWindowsInstaller).toHaveBeenCalledOnce();
    const call = vi.mocked(launchWindowsInstaller).mock.calls[0];
    expect(call?.[0]).toMatch(/Setup\.exe$/);
    expect(call?.[1].fileName).toMatch(/Setup\.exe$/);
    expect(app.quit).toHaveBeenCalledOnce();
  });
});

describe('macOS update staging', () => {
  it('serves Squirrel query URLs and reaches quitAndInstall', async () => {
    const nativeAutoUpdater = new StagingAutoUpdater();
    const { manager } = await managerFixture('signed mac update', {
      platform: 'darwin',
      nativeAutoUpdater: nativeAutoUpdater as unknown as AutoUpdater,
    });

    await manager.initialize();
    await expect(manager.installReadyUpdate()).resolves.toBe(true);

    expect(nativeAutoUpdater.requestedUrls).toEqual([
      expect.stringContaining('/feed?version=1.0.0&channel=stable'),
      expect.stringContaining('/artifact?source=Squirrel.Mac'),
    ]);
    expect(nativeAutoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('contains an artifact disappearance without an uncaught exception', async () => {
    const nativeAutoUpdater = new StagingAutoUpdater();
    const onError = vi.fn<(error: unknown) => void>();
    const { manager, fixture, store } = await managerFixture(
      'signed mac update',
      {
        platform: 'darwin',
        nativeAutoUpdater: nativeAutoUpdater as unknown as AutoUpdater,
        onError,
      },
    );
    nativeAutoUpdater.beforeArtifactFetch = () =>
      unlink(store.artifactPath(fixture.macFileName));

    await expect(manager.initialize()).rejects.toThrow(
      /artifact request failed/,
    );
    const reportedError = onError.mock.calls[0]?.[0];
    expect(reportedError).toBeInstanceOf(Error);
    expect((reportedError as Error).message).toContain(
      'changed after signed metadata',
    );
  });

  it('contains artifact stream failures without terminating the main process', async () => {
    const nativeAutoUpdater = new StagingAutoUpdater();
    const onError = vi.fn<(error: unknown) => void>();
    const failingStream = () =>
      Readable.from(
        (function* () {
          yield Buffer.from('partial');
          throw new Error('simulated stream failure');
        })(),
      );
    const { manager } = await managerFixture('signed mac update', {
      platform: 'darwin',
      nativeAutoUpdater: nativeAutoUpdater as unknown as AutoUpdater,
      onError,
      createArtifactReadStream:
        failingStream as unknown as UpdateManagerOptions['createArtifactReadStream'],
    });

    await expect(manager.initialize()).rejects.toThrow();
    await vi.waitFor(() => {
      const reportedError = onError.mock.calls[0]?.[0];
      expect(reportedError).toBeInstanceOf(Error);
      expect((reportedError as Error).message).toBe('simulated stream failure');
    });
  });

  it('serves the exact verified artifact bytes', async () => {
    const nativeAutoUpdater = new StagingAutoUpdater();
    const { manager, fixture, store } = await managerFixture(
      'signed mac update',
      {
        platform: 'darwin',
        nativeAutoUpdater: nativeAutoUpdater as unknown as AutoUpdater,
      },
    );

    await manager.initialize();

    expect(nativeAutoUpdater.artifactBytes?.toString('utf8')).toBe(
      'signed mac update',
    );
    await expect(
      readFile(store.artifactPath(fixture.macFileName), 'utf8'),
    ).resolves.toBe('signed mac update');
  });

  it('serves signed descriptor bytes when the pathname is replaced after validation', async () => {
    const nativeAutoUpdater = new StagingAutoUpdater();
    let stagedArtifactPath: string | null = null;
    const replacement = 'evil mac update!!';
    const result = await managerFixture('signed mac update', {
      platform: 'darwin',
      nativeAutoUpdater: nativeAutoUpdater as unknown as AutoUpdater,
      createArtifactReadStream: (file) =>
        Readable.from(
          (async function* () {
            if (!stagedArtifactPath) {
              throw new Error('test artifact path was not initialized');
            }
            const artifactPath = stagedArtifactPath;
            await rename(artifactPath, `${artifactPath}.signed`);
            await writeFile(artifactPath, replacement);
            yield await file.readFile();
          })(),
        ),
    });
    stagedArtifactPath = result.store.artifactPath(result.fixture.macFileName);

    await result.manager.initialize();

    expect(nativeAutoUpdater.artifactBytes?.toString('utf8')).toBe(
      'signed mac update',
    );
    await expect(readFile(stagedArtifactPath, 'utf8')).resolves.toBe(
      replacement,
    );
  });
});
