import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  promises as fs,
} from 'node:fs';
import path from 'node:path';
import { compareVersions } from './updateMetadata.js';

export type UpdatePhase = 'idle' | 'downloading' | 'downloaded' | 'installing';

export interface UpdateState {
  schemaVersion: 2;
  phase: UpdatePhase;
  targetVersion?: string;
  artifactFileName?: string;
  artifactSha256?: string;
  artifactSize?: number;
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
  if (state.schemaVersion !== 2) {
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
      schemaVersion: 2,
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
    state.artifactSize <= 0
  ) {
    throw new Error('active update state is incomplete');
  }
  compareVersions(state.targetVersion, state.targetVersion);
  assertPlainFileName(state.artifactFileName);
  return {
    schemaVersion: 2,
    phase: state.phase,
    targetVersion: state.targetVersion,
    artifactFileName: state.artifactFileName,
    artifactSha256: state.artifactSha256,
    artifactSize: state.artifactSize,
  };
}

async function hashFile(filePath: string): Promise<{
  sha256: string;
  size: number;
}> {
  const digest = createHash('sha256');
  let size = 0;
  const chunks = createReadStream(filePath) as AsyncIterable<Buffer>;
  for await (const chunk of chunks) {
    digest.update(chunk);
    size += chunk.length;
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
        schemaVersion: 2,
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

    const artifactPath = this.artifactPath(state.artifactFileName!);
    const partialPath = this.partialArtifactPath(state.artifactFileName!);
    if (state.phase === 'downloading') {
      await fs.rm(partialPath, { force: true });
      const recovered: UpdateState = {
        schemaVersion: 2,
        phase: 'idle',
      };
      await this.write(recovered);
      return recovered;
    }

    if (compareVersions(currentVersion, state.targetVersion!) >= 0) {
      await Promise.all([
        fs.rm(artifactPath, { force: true }),
        fs.rm(partialPath, { force: true }),
      ]);
      const recovered: UpdateState = {
        schemaVersion: 2,
        phase: 'idle',
      };
      await this.write(recovered);
      return recovered;
    }

    const validArtifact = existsSync(artifactPath)
      ? await hashFile(artifactPath)
      : null;
    if (
      !validArtifact ||
      validArtifact.sha256 !== state.artifactSha256 ||
      validArtifact.size !== state.artifactSize
    ) {
      await Promise.all([
        fs.rm(artifactPath, { force: true }),
        fs.rm(partialPath, { force: true }),
      ]);
      const recovered: UpdateState = {
        schemaVersion: 2,
        phase: 'idle',
      };
      await this.write(recovered);
      return recovered;
    }

    const recovered: UpdateState = {
      ...state,
      phase: 'downloaded',
    };
    await this.write(recovered);
    return recovered;
  }

  async beginDownload(
    targetVersion: string,
    artifact: ArtifactIdentity,
  ): Promise<UpdateState> {
    assertPlainFileName(artifact.fileName);
    const state: UpdateState = {
      schemaVersion: 2,
      phase: 'downloading',
      targetVersion,
      artifactFileName: artifact.fileName,
      artifactSha256: artifact.sha256,
      artifactSize: artifact.size,
    };
    await this.write(state);
    return state;
  }

  async completeDownload(state: UpdateState): Promise<UpdateState> {
    if (state.phase !== 'downloading') {
      throw new Error('cannot complete an update that is not downloading');
    }
    const completed: UpdateState = { ...state, phase: 'downloaded' };
    await this.write(completed);
    return completed;
  }

  async markInstalling(state: UpdateState): Promise<UpdateState> {
    if (state.phase !== 'downloaded') {
      throw new Error('cannot install an update that is not downloaded');
    }
    const installing: UpdateState = { ...state, phase: 'installing' };
    await this.write(installing);
    return installing;
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

  async verifyArtifact(artifact: ArtifactIdentity): Promise<boolean> {
    const artifactPath = this.artifactPath(artifact.fileName);
    if (!existsSync(artifactPath)) return false;
    const actual = await hashFile(artifactPath);
    return actual.sha256 === artifact.sha256 && actual.size === artifact.size;
  }

  async discard(state: UpdateState): Promise<UpdateState> {
    if (state.artifactFileName) {
      await Promise.all([
        fs.rm(this.artifactPath(state.artifactFileName), { force: true }),
        fs.rm(this.partialArtifactPath(state.artifactFileName), {
          force: true,
        }),
      ]);
    }
    const idle: UpdateState = { schemaVersion: 2, phase: 'idle' };
    await this.write(idle);
    return idle;
  }
}
