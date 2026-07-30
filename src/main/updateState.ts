import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from './updateMetadata.js';

export type UpdatePhase = 'idle' | 'downloading' | 'downloaded' | 'installing';

interface IdleUpdateState {
  schemaVersion: 3;
  phase: 'idle';
}

export interface ActiveUpdateState {
  schemaVersion: 3;
  phase: Exclude<UpdatePhase, 'idle'>;
  targetVersion: string;
  artifactFileName: string;
  artifactSha256: string;
  artifactSize: number;
  metadataPayload: string;
  metadataSignature: string;
}

export type UpdateState = IdleUpdateState | ActiveUpdateState;

export interface SignedMetadataEnvelope {
  payload: string;
  signature: string;
}

export interface ArtifactIdentity {
  fileName: string;
  sha256: string;
  size: number;
}

function assertPlainFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    path.posix.basename(fileName) !== fileName ||
    path.win32.basename(fileName) !== fileName
  ) {
    throw new Error('update state contains an unsafe artifact file name');
  }
}

function parseState(value: unknown): UpdateState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('update state must be an object');
  }
  const state = value as Record<string, unknown>;
  if (state.schemaVersion !== 3) {
    throw new Error('unsupported update state schema');
  }
  if (
    state.phase !== 'idle' &&
    state.phase !== 'downloading' &&
    state.phase !== 'downloaded' &&
    state.phase !== 'installing'
  ) {
    throw new Error('update state has an invalid phase');
  }
  if (state.phase === 'idle') {
    return {
      schemaVersion: 3,
      phase: 'idle',
    };
  }
  if (
    typeof state.targetVersion !== 'string' ||
    typeof state.artifactFileName !== 'string' ||
    typeof state.artifactSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state.artifactSha256) ||
    typeof state.artifactSize !== 'number' ||
    !Number.isSafeInteger(state.artifactSize) ||
    state.artifactSize <= 0 ||
    typeof state.metadataPayload !== 'string' ||
    Buffer.byteLength(state.metadataPayload) === 0 ||
    Buffer.byteLength(state.metadataPayload) > 128 * 1024 ||
    typeof state.metadataSignature !== 'string' ||
    Buffer.byteLength(state.metadataSignature) === 0 ||
    Buffer.byteLength(state.metadataSignature) > 4 * 1024
  ) {
    throw new Error('active update state is incomplete');
  }
  compareVersions(state.targetVersion, state.targetVersion);
  assertPlainFileName(state.artifactFileName);
  return {
    schemaVersion: 3,
    phase: state.phase,
    targetVersion: state.targetVersion,
    artifactFileName: state.artifactFileName,
    artifactSha256: state.artifactSha256,
    artifactSize: state.artifactSize,
    metadataPayload: state.metadataPayload,
    metadataSignature: state.metadataSignature,
  };
}

async function hashOpenFile(file: FileHandle): Promise<{
  sha256: string;
  size: number;
}> {
  const stat = await file.stat();
  if (!stat.isFile()) {
    throw new Error('update artifact is not a regular file');
  }
  const digest = createHash('sha256');
  let size = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (size < stat.size) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, stat.size - size),
      size,
    );
    if (bytesRead === 0) {
      throw new Error('update artifact ended while hashing its open handle');
    }
    digest.update(buffer.subarray(0, bytesRead));
    size += bytesRead;
  }
  return { sha256: digest.digest('hex'), size };
}

export class UpdateStateStore {
  readonly directory: string;
  readonly statePath: string;

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, 'updates');
    this.statePath = path.join(this.directory, 'state.json');
  }

  artifactPath(fileName: string): string {
    assertPlainFileName(fileName);
    return path.join(this.directory, fileName);
  }

  partialArtifactPath(fileName: string): string {
    return `${this.artifactPath(fileName)}.part`;
  }

  async read(): Promise<UpdateState> {
    if (!existsSync(this.statePath)) {
      return {
        schemaVersion: 3,
        phase: 'idle',
      };
    }
    const raw = await fs.readFile(this.statePath, 'utf8');
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      throw new Error(`update state is corrupt at ${this.statePath}`, {
        cause: error,
      });
    }
    return parseState(decoded);
  }

  async write(state: UpdateState): Promise<void> {
    mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    );
    await fs.rename(temporaryPath, this.statePath);
  }

  async recover(currentVersion: string): Promise<UpdateState> {
    const state = await this.read();

    if (state.phase === 'idle') {
      return state;
    }

    const artifactPath = this.artifactPath(state.artifactFileName);
    const partialPath = this.partialArtifactPath(state.artifactFileName);
    if (state.phase === 'downloading') {
      await fs.rm(partialPath, { force: true });
      const recovered: UpdateState = {
        schemaVersion: 3,
        phase: 'idle',
      };
      await this.write(recovered);
      return recovered;
    }

    if (compareVersions(currentVersion, state.targetVersion) >= 0) {
      await Promise.all([
        fs.rm(artifactPath, { force: true }),
        fs.rm(partialPath, { force: true }),
      ]);
      const recovered: UpdateState = {
        schemaVersion: 3,
        phase: 'idle',
      };
      await this.write(recovered);
      return recovered;
    }

    if (
      !(await this.verifyArtifact({
        fileName: state.artifactFileName,
        sha256: state.artifactSha256,
        size: state.artifactSize,
      }))
    ) {
      await Promise.all([
        fs.rm(artifactPath, { force: true }),
        fs.rm(partialPath, { force: true }),
      ]);
      const recovered: UpdateState = {
        schemaVersion: 3,
        phase: 'idle',
      };
      await this.write(recovered);
      return recovered;
    }

    const recovered: ActiveUpdateState = {
      ...state,
      phase: 'downloaded',
    };
    await this.write(recovered);
    return recovered;
  }

  async beginDownload(
    targetVersion: string,
    artifact: ArtifactIdentity,
    metadata: SignedMetadataEnvelope,
  ): Promise<ActiveUpdateState> {
    assertPlainFileName(artifact.fileName);
    const state: ActiveUpdateState = {
      schemaVersion: 3,
      phase: 'downloading',
      targetVersion,
      artifactFileName: artifact.fileName,
      artifactSha256: artifact.sha256,
      artifactSize: artifact.size,
      metadataPayload: metadata.payload,
      metadataSignature: metadata.signature,
    };
    await this.write(state);
    return state;
  }

  async completeDownload(state: ActiveUpdateState): Promise<ActiveUpdateState> {
    if (state.phase !== 'downloading') {
      throw new Error('cannot complete an update that is not downloading');
    }
    const completed: ActiveUpdateState = { ...state, phase: 'downloaded' };
    await this.write(completed);
    return completed;
  }

  async markInstalling(state: UpdateState): Promise<ActiveUpdateState> {
    if (state.phase !== 'downloaded') {
      throw new Error('cannot install an update that is not downloaded');
    }
    const installing: ActiveUpdateState = { ...state, phase: 'installing' };
    await this.write(installing);
    return installing;
  }

  async markDownloaded(state: ActiveUpdateState): Promise<ActiveUpdateState> {
    const downloaded: ActiveUpdateState = { ...state, phase: 'downloaded' };
    await this.write(downloaded);
    return downloaded;
  }

  matches(
    state: UpdateState,
    targetVersion: string,
    artifact: ArtifactIdentity,
  ): boolean {
    return (
      state.phase === 'downloaded' &&
      state.targetVersion === targetVersion &&
      state.artifactFileName === artifact.fileName &&
      state.artifactSha256 === artifact.sha256 &&
      state.artifactSize === artifact.size
    );
  }

  async openVerifiedArtifact(
    artifact: ArtifactIdentity,
    openFile: (artifactPath: string) => Promise<FileHandle> = (artifactPath) =>
      fs.open(artifactPath, 'r'),
  ): Promise<FileHandle> {
    const artifactPath = this.artifactPath(artifact.fileName);
    const file = await openFile(artifactPath);
    try {
      const actual = await hashOpenFile(file);
      if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size) {
        throw new Error(
          `update artifact integrity mismatch: expected ${artifact.size} bytes / ${artifact.sha256}, received ${actual.size} bytes / ${actual.sha256}`,
        );
      }
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async verifyArtifact(artifact: ArtifactIdentity): Promise<boolean> {
    if (!existsSync(this.artifactPath(artifact.fileName))) return false;
    try {
      const file = await this.openVerifiedArtifact(artifact);
      await file.close();
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('integrity mismatch') ||
          error.message.includes('not a regular file') ||
          error.message.includes('ended while hashing'))
      ) {
        return false;
      }
      throw error;
    }
  }

  async discard(state: UpdateState): Promise<UpdateState> {
    if (state.phase !== 'idle') {
      await Promise.all([
        fs.rm(this.artifactPath(state.artifactFileName), { force: true }),
        fs.rm(this.partialArtifactPath(state.artifactFileName), {
          force: true,
        }),
      ]);
    }
    const idle: UpdateState = { schemaVersion: 3, phase: 'idle' };
    await this.write(idle);
    return idle;
  }
}
