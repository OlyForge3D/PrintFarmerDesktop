import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

export interface SceneCacheServiceOptions {
  userDataPath: string;
  sidecar: SceneCacheSidecar;
}

interface RecipeLease {
  recipe: string | null;
  generation: number;
}

/**
 * Persists validated scene DTOs under the recipe advertised by the sidecar.
 * Unknown recipes deliberately disable caching; a recipe transition removes the
 * whole prior namespace before any entry under the new recipe can be used.
 */
export class SceneCacheService {
  private readonly cacheDirectory: string;
  private readonly manifestPath: string;
  private readonly sidecar: SceneCacheSidecar;
  private activeRecipe: string | null | typeof UNINITIALIZED = UNINITIALIZED;
  private generation = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<Scene>>();

  constructor(options: SceneCacheServiceOptions) {
    this.cacheDirectory = path.join(
      options.userDataPath,
      SCENE_CACHE_DIRECTORY,
    );
    this.manifestPath = path.join(this.cacheDirectory, MANIFEST_NAME);
    this.sidecar = options.sidecar;
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
      const loaded = await this.sidecar.loadSceneWithRecipe(filePath);
      const scene = LoadSceneResponse.parse(loaded.scene);
      if (loaded.cacheRecipe) {
        await this.replaceRecipeIfCurrent(lease, loaded.cacheRecipe);
      }
      return scene;
    }

    const modelHash = await hashFile(filePath);
    const assumedKey = sceneCacheKey(modelHash, advertisedRecipe);
    const cached = await this.readEntry(assumedKey);
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

    const hashAfterLoad = await hashFile(filePath);
    if (hashAfterLoad !== modelHash) return scene;

    const key = sceneCacheKey(modelHash, actualRecipe);
    await this.writeEntryIfCurrent(key, scene, actualLease);
    return scene;
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
    if (this.activeRecipe !== UNINITIALIZED && this.activeRecipe === recipe) {
      return;
    }

    if (recipe === null) {
      await rm(this.cacheDirectory, { recursive: true, force: true });
      this.activeRecipe = null;
      this.generation += 1;
      return;
    }

    const persistedRecipe =
      this.activeRecipe === UNINITIALIZED
        ? await this.readPersistedRecipe()
        : this.activeRecipe;
    if (persistedRecipe !== recipe) {
      await rm(this.cacheDirectory, { recursive: true, force: true });
      await mkdir(this.cacheDirectory, { recursive: true, mode: 0o700 });
      await this.writeManifest(recipe);
    }
    this.activeRecipe = recipe;
    this.generation += 1;
  }

  private async readPersistedRecipe(): Promise<string | null> {
    try {
      const payload = await readFile(this.manifestPath, 'utf8');
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
      await writeFile(temporaryPath, payload, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, this.manifestPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readEntry(key: string): Promise<Scene | null> {
    const entryPath = this.entryPath(key);
    try {
      const payload = await readFile(entryPath, 'utf8');
      const parsed = LoadSceneResponse.safeParse(JSON.parse(payload));
      if (parsed.success) return parsed.data;
      await rm(entryPath, { force: true });
      return null;
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof SyntaxError) {
        await rm(entryPath, { force: true });
        return null;
      }
      throw error;
    }
  }

  private async writeEntryIfCurrent(
    key: string,
    scene: Scene,
    lease: RecipeLease,
  ): Promise<void> {
    await this.withMutationLock(async () => {
      if (!this.isCurrent(lease) || lease.recipe === null) return;
      const entryPath = this.entryPath(key);
      const temporaryPath = path.join(
        this.cacheDirectory,
        `.${key}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporaryPath, JSON.stringify(scene), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporaryPath, entryPath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  private entryPath(key: string): string {
    return path.join(this.cacheDirectory, `${key}.scene.json`);
  }

  private currentLease(): RecipeLease {
    if (this.activeRecipe === UNINITIALIZED) {
      throw new Error('scene cache recipe has not been initialized');
    }
    return { recipe: this.activeRecipe, generation: this.generation };
  }

  private isCurrent(lease: RecipeLease): boolean {
    return (
      this.activeRecipe !== UNINITIALIZED &&
      this.activeRecipe === lease.recipe &&
      this.generation === lease.generation
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
