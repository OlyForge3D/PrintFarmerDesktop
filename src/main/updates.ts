import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, promises as fs, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { autoUpdater, type App, type AutoUpdater } from 'electron';
import {
  assertUpdateIsNotRollback,
  compareVersions,
  selectUpdateArtifact,
  verifySignedUpdateMetadata,
  type UpdateArtifact,
  type UpdateMetadata,
} from './updateMetadata.js';
import { UpdateStateStore, type UpdateState } from './updateState.js';

const MAX_METADATA_BYTES = 128 * 1024;
const MAX_SIGNATURE_BYTES = 4 * 1024;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

type FetchImplementation = typeof fetch;

export interface UpdateManagerOptions {
  app: Pick<App, 'getVersion' | 'getPath' | 'quit'>;
  publicKeyPem: string;
  metadataUrl: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImplementation?: FetchImplementation;
  nativeAutoUpdater?: AutoUpdater;
  onError?: (error: unknown) => void;
}

async function fetchBoundedText(
  fetchImplementation: FetchImplementation,
  url: string,
  maximumBytes: number,
): Promise<string> {
  const response = await fetchImplementation(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json, text/plain' },
  });
  if (!response.ok) {
    throw new Error(
      `update request failed with HTTP ${response.status}: ${url}`,
    );
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`update response exceeds ${maximumBytes} bytes: ${url}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumBytes) {
    throw new Error(`update response exceeds ${maximumBytes} bytes: ${url}`);
  }
  return text;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export class UpdateManager {
  private readonly app: UpdateManagerOptions['app'];
  private readonly publicKeyPem: string;
  private readonly metadataUrl: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly nativeAutoUpdater: AutoUpdater;
  private readonly onError: (error: unknown) => void;
  private readonly stateStore: UpdateStateStore;
  private state: UpdateState | null = null;
  private macUpdateStaged = false;
  private checking = false;

  constructor(options: UpdateManagerOptions) {
    this.app = options.app;
    this.publicKeyPem = options.publicKeyPem;
    this.metadataUrl = options.metadataUrl;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.nativeAutoUpdater = options.nativeAutoUpdater ?? autoUpdater;
    this.onError =
      options.onError ??
      ((error) => console.error('[updates] update operation failed', error));
    this.stateStore = new UpdateStateStore(this.app.getPath('userData'));
  }

  async initialize(): Promise<void> {
    this.state = await this.stateStore.recover(this.app.getVersion());
    if (this.state.phase === 'downloaded') {
      if (this.platform === 'darwin') {
        await this.stageMacUpdate(this.state);
      }
      return;
    }
    void this.checkForUpdates().catch(this.onError);
  }

  async checkForUpdates(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const signatureUrl = `${this.metadataUrl}.sig`;
      const [payload, signature] = await Promise.all([
        fetchBoundedText(
          this.fetchImplementation,
          this.metadataUrl,
          MAX_METADATA_BYTES,
        ),
        fetchBoundedText(
          this.fetchImplementation,
          signatureUrl,
          MAX_SIGNATURE_BYTES,
        ),
      ]);
      const metadata = verifySignedUpdateMetadata(
        payload,
        signature,
        this.publicKeyPem,
      );
      await this.acceptMetadata(metadata);
    } finally {
      this.checking = false;
    }
  }

  private async acceptMetadata(metadata: UpdateMetadata): Promise<void> {
    const currentVersion = this.app.getVersion();
    const currentState =
      this.state ?? (await this.stateStore.recover(currentVersion));
    assertUpdateIsNotRollback(
      metadata.version,
      currentVersion,
      currentState.highestVersion,
    );
    this.state = await this.stateStore.trustVersion(
      currentState,
      metadata.version,
    );
    if (compareVersions(metadata.version, currentVersion) === 0) return;

    const artifact = selectUpdateArtifact(metadata, this.platform, this.arch);
    this.state = await this.stateStore.beginDownload(
      this.state,
      metadata.version,
      artifact,
    );
    await this.downloadArtifact(artifact);
    this.state = await this.stateStore.completeDownload(this.state);
    if (this.platform === 'darwin') {
      await this.stageMacUpdate(this.state, metadata.publishedAt);
    }
  }

  private async downloadArtifact(artifact: UpdateArtifact): Promise<void> {
    const destination = this.stateStore.artifactPath(artifact.fileName);
    const partial = this.stateStore.partialArtifactPath(artifact.fileName);
    await Promise.all([
      fs.rm(destination, { force: true }),
      fs.rm(partial, { force: true }),
    ]);

    const response = await this.fetchImplementation(artifact.url, {
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
      headers: { accept: 'application/octet-stream' },
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `update artifact request failed with HTTP ${response.status}`,
      );
    }
    if (new URL(response.url || artifact.url).protocol !== 'https:') {
      throw new Error('update artifact redirected to a non-HTTPS URL');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength > 0 &&
      contentLength !== artifact.size
    ) {
      throw new Error(
        `update artifact size header mismatch: expected ${artifact.size}, received ${contentLength}`,
      );
    }

    const digest = createHash('sha256');
    let received = 0;
    try {
      const file = await fs.open(partial, 'wx');
      try {
        const reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > artifact.size) {
            throw new Error(
              `update artifact exceeded signed size ${artifact.size}`,
            );
          }
          digest.update(chunk.value);
          await file.write(chunk.value);
        }
      } finally {
        await file.close();
      }
    } catch (error) {
      await fs.rm(partial, { force: true });
      throw error;
    }

    const actualDigest = digest.digest('hex');
    if (received !== artifact.size || actualDigest !== artifact.sha256) {
      await fs.rm(partial, { force: true });
      throw new Error(
        `update artifact integrity check failed: expected ${artifact.size} bytes / ${artifact.sha256}, received ${received} bytes / ${actualDigest}`,
      );
    }
    await fs.rename(partial, destination);
  }

  private async stageMacUpdate(
    state: UpdateState,
    publishedAt = new Date().toISOString(),
  ): Promise<void> {
    if (
      state.phase !== 'downloaded' ||
      !state.artifactFileName ||
      !state.targetVersion
    ) {
      throw new Error('macOS updater cannot stage an incomplete update');
    }

    const artifactPath = this.stateStore.artifactPath(state.artifactFileName);
    const token = randomBytes(24).toString('hex');
    const server = createServer((request, response) => {
      const remoteAddress = request.socket.remoteAddress;
      if (
        remoteAddress !== '127.0.0.1' &&
        remoteAddress !== '::1' &&
        remoteAddress !== '::ffff:127.0.0.1'
      ) {
        response.writeHead(403).end();
        return;
      }
      if (request.url === `/${token}/feed`) {
        const address = server.address() as AddressInfo;
        const artifactUrl = `http://127.0.0.1:${address.port}/${token}/artifact`;
        const feed = JSON.stringify({
          url: artifactUrl,
          name: state.targetVersion,
          notes: `PrintFarmer Desktop ${state.targetVersion}`,
          pub_date: publishedAt,
        });
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(feed),
          'cache-control': 'no-store',
        });
        response.end(feed);
        return;
      }
      if (request.url === `/${token}/artifact`) {
        const artifactStat = statSync(artifactPath);
        response.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': artifactStat.size,
          'cache-control': 'no-store',
        });
        createReadStream(artifactPath).pipe(response);
        return;
      }
      response.writeHead(404).end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      this.nativeAutoUpdater.setFeedURL({
        url: `http://127.0.0.1:${address.port}/${token}/feed`,
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('timed out while staging the macOS update'));
        }, UPDATE_TIMEOUT_MS);
        const downloaded = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          clearTimeout(timeout);
          this.nativeAutoUpdater.off('update-downloaded', downloaded);
          this.nativeAutoUpdater.off('error', failed);
        };
        this.nativeAutoUpdater.once('update-downloaded', downloaded);
        this.nativeAutoUpdater.once('error', failed);
        this.nativeAutoUpdater.checkForUpdates();
      });
      this.macUpdateStaged = true;
    } finally {
      await closeServer(server);
    }
  }

  async installReadyUpdate(): Promise<boolean> {
    if (!this.state || this.state.phase !== 'downloaded') return false;
    if (this.platform === 'darwin') {
      if (!this.macUpdateStaged) return false;
      this.state = await this.stateStore.markInstalling(this.state);
      this.nativeAutoUpdater.quitAndInstall();
      return true;
    }
    if (this.platform === 'win32' && this.state.artifactFileName) {
      const installerPath = this.stateStore.artifactPath(
        this.state.artifactFileName,
      );
      this.state = await this.stateStore.markInstalling(this.state);
      const child = spawn(installerPath, ['--silent'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', this.onError);
      child.unref();
    }
    return false;
  }
}
