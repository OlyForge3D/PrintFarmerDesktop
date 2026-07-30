import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
import { launchVerifiedWindowsInstaller } from './windowsInstaller.js';

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
  launchWindowsInstaller?: typeof launchVerifiedWindowsInstaller;
  openArtifactFile?: (artifactPath: string) => Promise<FileHandle>;
  createArtifactReadStream?: (file: FileHandle) => Readable;
  onError?: (error: unknown) => void;
}

interface TrustedUpdate {
  metadata: UpdateMetadata;
  artifact: UpdateArtifact;
  payload: string;
  signature: string;
}

export async function fetchBoundedText(
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
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength =
    contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (
    contentLength !== null &&
    Number.isFinite(contentLength) &&
    contentLength > maximumBytes
  ) {
    throw new Error(`update response exceeds ${maximumBytes} bytes: ${url}`);
  }
  if (!response.body) {
    throw new Error(`update response has no body: ${url}`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new Error(`update response exceeds ${maximumBytes} bytes: ${url}`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, received).toString('utf8');
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
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
  private readonly launchWindowsInstaller: typeof launchVerifiedWindowsInstaller;
  private readonly openArtifactFile: (
    artifactPath: string,
  ) => Promise<FileHandle>;
  private readonly createArtifactReadStream: (file: FileHandle) => Readable;
  private readonly onError: (error: unknown) => void;
  private readonly stateStore: UpdateStateStore;
  private state: UpdateState | null = null;
  private trustedUpdate: TrustedUpdate | null = null;
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
    this.launchWindowsInstaller =
      options.launchWindowsInstaller ?? launchVerifiedWindowsInstaller;
    this.openArtifactFile =
      options.openArtifactFile ??
      ((artifactPath) => fs.open(artifactPath, 'r'));
    this.createArtifactReadStream =
      options.createArtifactReadStream ??
      ((file) => file.createReadStream({ autoClose: false, start: 0 }));
    this.onError =
      options.onError ??
      ((error) => console.error('[updates] update operation failed', error));
    this.stateStore = new UpdateStateStore(this.app.getPath('userData'));
  }

  async initialize(): Promise<void> {
    this.state = await this.stateStore.recover(this.app.getVersion());
    this.trustedUpdate = await this.authenticateRecoveredCandidate(this.state);
    await this.checkForUpdates();
  }

  private async authenticateRecoveredCandidate(
    state: UpdateState,
  ): Promise<TrustedUpdate | null> {
    if (state.phase === 'idle') return null;
    const metadata = verifySignedUpdateMetadata(
      state.metadataPayload,
      state.metadataSignature,
      this.publicKeyPem,
    );
    assertUpdateIsNotRollback(metadata.version, this.app.getVersion());
    const artifact = selectUpdateArtifact(metadata, this.platform, this.arch);
    if (
      !this.stateStore.matches(state, metadata.version, artifact) ||
      !(await this.stateStore.verifyArtifact(artifact))
    ) {
      throw new Error(
        'recovered update is not bound to its retained signed metadata',
      );
    }
    return {
      metadata,
      artifact,
      payload: state.metadataPayload,
      signature: state.metadataSignature,
    };
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
      const artifact = selectUpdateArtifact(metadata, this.platform, this.arch);
      await this.acceptMetadata({ metadata, artifact, payload, signature });
    } finally {
      this.checking = false;
    }
  }

  private async acceptMetadata(update: TrustedUpdate): Promise<void> {
    const { metadata, artifact, payload, signature } = update;
    const currentVersion = this.app.getVersion();
    const currentState =
      this.state ?? (await this.stateStore.recover(currentVersion));
    assertUpdateIsNotRollback(metadata.version, currentVersion);
    if (
      this.trustedUpdate &&
      currentState.phase === 'downloaded' &&
      compareVersions(metadata.version, this.trustedUpdate.metadata.version) <=
        0
    ) {
      if (this.platform === 'darwin' && !this.macUpdateStaged) {
        await this.stageMacUpdate(this.trustedUpdate);
      }
      return;
    }
    if (compareVersions(metadata.version, currentVersion) === 0) {
      this.trustedUpdate = null;
      this.state =
        currentState.phase === 'idle'
          ? currentState
          : await this.stateStore.discard(currentState);
      return;
    }

    if (
      this.stateStore.matches(currentState, metadata.version, artifact) &&
      (await this.stateStore.verifyArtifact(artifact))
    ) {
      this.state = currentState;
    } else {
      if (currentState.phase !== 'idle') {
        this.state = await this.stateStore.discard(currentState);
      }
      this.state = await this.stateStore.beginDownload(
        metadata.version,
        artifact,
        { payload, signature },
      );
      await this.downloadArtifact(artifact);
      this.state = await this.stateStore.completeDownload(this.state);
    }
    this.trustedUpdate = update;
    if (this.platform === 'darwin') {
      await this.stageMacUpdate(this.trustedUpdate);
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

  private async stageMacUpdate(trustedUpdate: TrustedUpdate): Promise<void> {
    const { metadata, artifact } = trustedUpdate;
    const state = this.state;
    if (
      !state ||
      !this.stateStore.matches(state, metadata.version, artifact) ||
      !(await this.stateStore.verifyArtifact(artifact))
    ) {
      throw new Error(
        'macOS updater cannot stage an artifact not bound to signed metadata',
      );
    }

    const token = randomBytes(24).toString('hex');
    const server = createServer((request, response) => {
      void (async () => {
        const remoteAddress = request.socket.remoteAddress;
        if (
          remoteAddress !== '127.0.0.1' &&
          remoteAddress !== '::1' &&
          remoteAddress !== '::ffff:127.0.0.1'
        ) {
          response.writeHead(403).end();
          return;
        }
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' }).end();
          return;
        }
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1')
          .pathname;
        if (pathname === `/${token}/feed`) {
          const address = server.address() as AddressInfo;
          const artifactUrl = `http://127.0.0.1:${address.port}/${token}/artifact`;
          const feed = JSON.stringify({
            url: artifactUrl,
            name: metadata.version,
            notes: `PrintFarmer Desktop ${metadata.version}`,
            pub_date: metadata.publishedAt,
          });
          response.writeHead(200, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(feed),
            'cache-control': 'no-store',
          });
          response.end(feed);
          return;
        }
        if (pathname === `/${token}/artifact`) {
          let artifactFile: FileHandle;
          try {
            artifactFile = await this.stateStore.openVerifiedArtifact(
              artifact,
              this.openArtifactFile,
            );
          } catch (error) {
            throw new Error(
              'macOS update artifact changed after signed metadata verification',
              { cause: error },
            );
          }
          try {
            const artifactStream = this.createArtifactReadStream(artifactFile);
            response.writeHead(200, {
              'content-type': 'application/zip',
              'content-length': artifact.size,
              'cache-control': 'no-store',
            });
            await pipeline(artifactStream, response);
          } finally {
            await artifactFile.close();
          }
          return;
        }
        response.writeHead(404).end();
      })().catch((error: unknown) => {
        this.onError(error);
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : undefined);
        } else {
          response.writeHead(500, { 'cache-control': 'no-store' }).end();
        }
      });
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
    if (!this.state || !this.trustedUpdate) return false;
    const { metadata, artifact } = this.trustedUpdate;
    if (!this.stateStore.matches(this.state, metadata.version, artifact)) {
      return false;
    }
    if (this.platform === 'darwin') {
      if (!this.macUpdateStaged) return false;
      this.state = await this.stateStore.markInstalling(this.state);
      this.nativeAutoUpdater.quitAndInstall();
      return true;
    }
    if (this.platform === 'win32') {
      const installerPath = this.stateStore.artifactPath(artifact.fileName);
      const installing = await this.stateStore.markInstalling(this.state);
      this.state = installing;
      try {
        await this.launchWindowsInstaller(installerPath, artifact);
      } catch (error) {
        this.state = await this.stateStore.markDownloaded(installing);
        throw error;
      }
      this.app.quit();
      return true;
    }
    return false;
  }
}
