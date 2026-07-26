import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  LoadSceneResponse,
  type LoadSceneResponse as Scene,
} from '@shared/ipc';
import type { RecipeBoundScene } from './sidecar.js';

const CACHE_FORMAT_VERSION = 1;
const MANIFEST_NAME = 'recipe.json';
const UNINITIALIZED = Symbol('uninitialized-scene-cache-recipe');

export const SCENE_CACHE_DIRECTORY = 'scene-cache.v1';
export const MAX_SCENE_ENTRY_BYTES = 64 * 1024 * 1024;

const SceneCacheManifest = z
  .object({
    version: z.literal(CACHE_FORMAT_VERSION),
    recipe: z.string().min(1),
  })
  .strict();

export interface SceneCacheSidecar {
  sceneCacheRecipe(): Promise<string | undefined>;
  loadSceneWithRecipe(filePath: string): Promise<RecipeBoundScene>;
}

export interface SceneCacheFileSystem {
  hashFile(filePath: string): Promise<string>;
  mkdir(directoryPath: string): Promise<void>;
  readText(filePath: string): Promise<string>;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  remove(targetPath: string): Promise<void>;
  size(filePath: string): Promise<number>;
  writeText(filePath: string, contents: string): Promise<void>;
}

export interface SceneCacheServiceOptions {
  userDataPath: string;
  sidecar: SceneCacheSidecar;
  fileSystem?: SceneCacheFileSystem;
  maxEntryBytes?: number;
  reportError?: (message: string, error: unknown) => void;
}

interface RecipeLease {
  recipe: string | null;
  storageReady: boolean;
}

const nodeFileSystem: SceneCacheFileSystem = {
  hashFile,
  mkdir: async (directoryPath) => {
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  },
  readText: (filePath) => readFile(filePath, 'utf8'),
  rename,
  remove: async (targetPath) => {
    await rm(targetPath, { recursive: true, force: true });
  },
  size: async (filePath) => (await stat(filePath)).size,
  writeText: (filePath, contents) =>
    writeFile(filePath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    }),
};

/**
 * Persists validated scene DTOs under the recipe advertised by the sidecar.
 * Unknown recipes deliberately disable caching; a recipe transition removes the
 * whole prior namespace before any entry under the new recipe can be used.
 */
export class SceneCacheService {
  private readonly cacheDirectory: string;
  private readonly manifestPath: string;
  private readonly sidecar: SceneCacheSidecar;
  private readonly fileSystem: SceneCacheFileSystem;
  private readonly maxEntryBytes: number;
  private readonly reportError: (message: string, error: unknown) => void;
  private activeRecipe: string | null | typeof UNINITIALIZED = UNINITIALIZED;
  private storageReady = false;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<Scene>>();

  constructor(options: SceneCacheServiceOptions) {
    this.cacheDirectory = path.join(
      options.userDataPath,
      SCENE_CACHE_DIRECTORY,
    );
    this.manifestPath = path.join(this.cacheDirectory, MANIFEST_NAME);
    this.sidecar = options.sidecar;
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.maxEntryBytes = options.maxEntryBytes ?? MAX_SCENE_ENTRY_BYTES;
    this.reportError =
      options.reportError ??
      ((message, error) => {
        console.error(message, error);
      });
  }

  async initialize(): Promise<void> {
    await this.adoptRecipe(await this.sidecar.sceneCacheRecipe());
  }

  async adoptRecipe(recipe: string | undefined): Promise<void> {
    await this.withMutationLock(() => this.adoptRecipeLocked(recipe ?? null));
  }

  async loadScene(filePath: string): Promise<Scene> {
    const advertisedRecipe = await this.sidecar.sceneCacheRecipe();
    const lease = await this.withMutationLock(async () => {
      await this.adoptRecipeLocked(advertisedRecipe ?? null);
      return this.currentLease();
    });

    if (!advertisedRecipe) {
      return this.deriveWithoutStore(filePath, lease);
    }

    const modelHash = await this.hashModel(filePath);
    if (!modelHash) return this.deriveWithoutStore(filePath, lease);
    const assumedKey = sceneCacheKey(modelHash, advertisedRecipe);
    const cached = lease.storageReady ? await this.readEntry(assumedKey) : null;
    if (cached && this.isCurrent(lease)) return cached;
    if (!this.isCurrent(lease)) return this.loadScene(filePath);

    const pending = this.inFlight.get(assumedKey);
    if (pending) return pending;

    const loading = this.deriveAndStore(
      filePath,
      modelHash,
      advertisedRecipe,
      lease,
    ).finally(() => {
      if (this.inFlight.get(assumedKey) === loading) {
        this.inFlight.delete(assumedKey);
      }
    });
    this.inFlight.set(assumedKey, loading);
    return loading;
  }

  private async deriveAndStore(
    filePath: string,
    modelHash: string,
    assumedRecipe: string,
    lease: RecipeLease,
  ): Promise<Scene> {
    const loaded = await this.sidecar.loadSceneWithRecipe(filePath);
    const scene = LoadSceneResponse.parse(loaded.scene);
    const actualRecipe = loaded.cacheRecipe;
    if (!actualRecipe) {
      await this.replaceRecipeIfCurrent(lease, null);
      return scene;
    }

    const actualLease =
      actualRecipe === assumedRecipe
        ? lease
        : await this.replaceRecipeIfCurrent(lease, actualRecipe);
    if (!actualLease) return this.loadScene(filePath);

    const hashAfterLoad = await this.hashModel(filePath);
    if (!hashAfterLoad || hashAfterLoad !== modelHash) return scene;

    const key = sceneCacheKey(modelHash, actualRecipe);
    await this.writeEntryIfCurrent(key, scene, actualLease);
    return scene;
  }

  private async deriveWithoutStore(
    filePath: string,
    lease: RecipeLease,
  ): Promise<Scene> {
    const loaded = await this.sidecar.loadSceneWithRecipe(filePath);
    const scene = LoadSceneResponse.parse(loaded.scene);
    await this.replaceRecipeIfCurrent(lease, loaded.cacheRecipe ?? null);
    return scene;
  }

  private async hashModel(filePath: string): Promise<string | null> {
    try {
      return await this.fileSystem.hashFile(filePath);
    } catch (error) {
      this.reportError(
        'Scene cache model hashing failed; loading without persistence.',
        error,
      );
      return null;
    }
  }

  private async replaceRecipeIfCurrent(
    lease: RecipeLease,
    recipe: string | null,
  ): Promise<RecipeLease | null> {
    return this.withMutationLock(async () => {
      if (!this.isCurrent(lease)) return null;
      await this.adoptRecipeLocked(recipe);
      return this.currentLease();
    });
  }

  private async adoptRecipeLocked(recipe: string | null): Promise<void> {
    if (
      this.activeRecipe !== UNINITIALIZED &&
      this.activeRecipe === recipe &&
      (recipe === null || this.storageReady)
    ) {
      return;
    }

    this.activeRecipe = recipe;
    this.storageReady = false;

    if (recipe === null) {
      await this.removeBestEffort(
        this.cacheDirectory,
        'Could not clear the unversioned scene cache.',
      );
      return;
    }

    try {
      const persistedRecipe = await this.readPersistedRecipe();
      if (persistedRecipe !== recipe) {
        await this.fileSystem.remove(this.cacheDirectory);
        await this.fileSystem.mkdir(this.cacheDirectory);
        await this.writeManifest(recipe);
      } else {
        await this.fileSystem.mkdir(this.cacheDirectory);
      }
      this.storageReady = true;
    } catch (error) {
      this.reportError(
        'Scene cache initialization failed; loading without persistence.',
        error,
      );
    }
  }

  private async readPersistedRecipe(): Promise<string | null> {
    try {
      const payload = await this.fileSystem.readText(this.manifestPath);
      const parsed = SceneCacheManifest.safeParse(JSON.parse(payload));
      return parsed.success ? parsed.data.recipe : null;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async writeManifest(recipe: string): Promise<void> {
    const temporaryPath = path.join(
      this.cacheDirectory,
      `.${MANIFEST_NAME}.${randomUUID()}.tmp`,
    );
    const payload = JSON.stringify({
      version: CACHE_FORMAT_VERSION,
      recipe,
    });
    try {
      await this.fileSystem.writeText(temporaryPath, payload);
      await this.fileSystem.rename(temporaryPath, this.manifestPath);
    } catch (error) {
      await this.removeBestEffort(
        temporaryPath,
        'Could not remove a temporary scene cache manifest.',
      );
      throw error;
    }
  }

  private async readEntry(key: string): Promise<Scene | null> {
    const entryPath = this.entryPath(key);
    try {
      if ((await this.fileSystem.size(entryPath)) > this.maxEntryBytes) {
        await this.removeBestEffort(
          entryPath,
          'Could not remove an oversized scene cache entry.',
        );
        return null;
      }
      const payload = await this.fileSystem.readText(entryPath);
      const parsed = LoadSceneResponse.safeParse(JSON.parse(payload));
      if (parsed.success) return parsed.data;
      await this.removeBestEffort(
        entryPath,
        'Could not remove an invalid scene cache entry.',
      );
      return null;
    } catch (error) {
      if (isMissing(error)) return null;
      this.reportError(
        'Scene cache read failed; deriving the scene again.',
        error,
      );
      await this.removeBestEffort(
        entryPath,
        'Could not remove an unreadable scene cache entry.',
      );
      return null;
    }
  }

  private async writeEntryIfCurrent(
    key: string,
    scene: Scene,
    lease: RecipeLease,
  ): Promise<void> {
    await this.withMutationLock(async () => {
      if (
        !this.isCurrent(lease) ||
        lease.recipe === null ||
        !this.storageReady
      ) {
        return;
      }
      const payload = JSON.stringify(scene);
      if (Buffer.byteLength(payload, 'utf8') > this.maxEntryBytes) return;
      const entryPath = this.entryPath(key);
      const temporaryPath = path.join(
        this.cacheDirectory,
        `.${key}.${randomUUID()}.tmp`,
      );
      try {
        await this.fileSystem.writeText(temporaryPath, payload);
        await this.fileSystem.rename(temporaryPath, entryPath);
      } catch (error) {
        this.storageReady = false;
        this.reportError(
          'Scene cache write failed; returning the uncached scene.',
          error,
        );
      } finally {
        await this.removeBestEffort(
          temporaryPath,
          'Could not remove a temporary scene cache entry.',
        );
      }
    });
  }

  private async removeBestEffort(
    targetPath: string,
    message: string,
  ): Promise<void> {
    try {
      await this.fileSystem.remove(targetPath);
    } catch (error) {
      this.reportError(message, error);
    }
  }

  private entryPath(key: string): string {
    return path.join(this.cacheDirectory, `${key}.scene.json`);
  }

  private currentLease(): RecipeLease {
    if (this.activeRecipe === UNINITIALIZED) {
      throw new Error('scene cache recipe has not been initialized');
    }
    return {
      recipe: this.activeRecipe,
      storageReady: this.storageReady,
    };
  }

  private isCurrent(lease: RecipeLease): boolean {
    return (
      this.activeRecipe !== UNINITIALIZED && this.activeRecipe === lease.recipe
    );
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: () => void = () => undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function sceneCacheKey(modelHash: string, recipe: string): string {
  const hash = createHash('sha256');
  for (const field of [recipe, modelHash]) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
