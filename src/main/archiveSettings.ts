import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { ArchiveSettings, DEFAULT_MAX_ARCHIVE_BYTES } from '@shared/ipc';
import { zipMemberSource } from '../shared/modelSource';

const StoredSettings = z
  .object({
    version: z.literal(1),
    settings: ArchiveSettings,
  })
  .strict();

export class ArchiveSettingsStore {
  private readonly storePath: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly userDataPath: string) {
    this.storePath = path.join(userDataPath, 'archive-settings.v1.json');
  }

  async get(): Promise<ArchiveSettings> {
    await this.mutationTail;
    try {
      const metadata = await fs.stat(this.storePath);
      if (metadata.size > 4096)
        throw new Error('ZIP settings file exceeds the size limit.');
      return StoredSettings.parse(
        JSON.parse(await fs.readFile(this.storePath, 'utf8')),
      ).settings;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES };
      }
      throw new Error('Could not read ZIP settings.', { cause: error });
    }
  }

  async set(request: ArchiveSettings): Promise<ArchiveSettings> {
    const settings = ArchiveSettings.parse(request);
    const result = this.mutationTail.then(async () => {
      await fs.mkdir(this.userDataPath, { recursive: true });
      const temporaryPath = `${this.storePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(
          temporaryPath,
          JSON.stringify({ version: 1, settings }),
          { flag: 'wx' },
        );
        await fs.rename(temporaryPath, this.storePath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        throw error;
      }
      return settings;
    });
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async assertSourceAllowed(approvedPath: string): Promise<void> {
    const source = zipMemberSource(approvedPath);
    if (!source) return;
    const { maxArchiveBytes } = await this.get();
    const { size } = await fs.stat(source.archivePath);
    if (size > maxArchiveBytes) {
      throw new Error(
        `ZIP ${source.archivePath}: on-disk size ${size} bytes exceeds the ${maxArchiveBytes / (1024 * 1024)} MiB limit (${maxArchiveBytes} bytes). Change Maximum ZIP size in Settings or rescan an eligible source.`,
      );
    }
  }
}
