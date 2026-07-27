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
  schemaVersion: 1;
  phase: UpdatePhase;
  highestVersion: string;
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
  if (state.schemaVersion !== 1) {
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
  if (typeof state.highestVersion !== 'string') {
    throw new Error('update state has no trusted version');
  }
  compareVersions(state.highestVersion, state.highestVersion);

  if (state.phase === 'idle') {
    return {
      schemaVersion: 1,
      phase: 'idle',
      highestVersion: state.highestVersion,
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
    schemaVersion: 1,
    phase: state.phase,
    highestVersion: state.highestVersion,
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

  async read(currentVersion: string): Promise<UpdateState> {
    if (!existsSync(this.statePath)) {
      return {
        schemaVersion: 1,
        phase: 'idle',
        highestVersion: currentVersion,
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
    const state = await this.read(currentVersion);
    const highestVersion =
      compareVersions(currentVersion, state.highestVersion) > 0
        ? currentVersion
        : state.highestVersion;

    if (state.phase === 'idle') {
      const recovered = { ...state, highestVersion };
      await this.write(recovered);
      return recovered;
    }

    const artifactPath = this.artifactPath(state.artifactFileName!);
    const partialPath = this.partialArtifactPath(state.artifactFileName!);
    if (state.phase === 'downloading') {
      await fs.rm(partialPath, { force: true });
      const recovered: UpdateState = {
        schemaVersion: 1,
        phase: 'idle',
        highestVersion,
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
        schemaVersion: 1,
        phase: 'idle',
        highestVersion,
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
        schemaVersion: 1,
        phase: 'idle',
        highestVersion,
      };
      await this.write(recovered);
      return recovered;
    }

    const recovered: UpdateState = {
      ...state,
      phase: 'downloaded',
      highestVersion,
    };
    await this.write(recovered);
    return recovered;
  }

  async trustVersion(
    currentState: UpdateState,
    version: string,
  ): Promise<UpdateState> {
    const state = {
      ...currentState,
      highestVersion:
        compareVersions(version, currentState.highestVersion) > 0
          ? version
          : currentState.highestVersion,
    };
    await this.write(state);
    return state;
  }

  async beginDownload(
    currentState: UpdateState,
    targetVersion: string,
    artifact: ArtifactIdentity,
  ): Promise<UpdateState> {
    assertPlainFileName(artifact.fileName);
    const state: UpdateState = {
      schemaVersion: 1,
      phase: 'downloading',
      highestVersion: currentState.highestVersion,
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
}
