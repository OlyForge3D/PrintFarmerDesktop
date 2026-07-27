import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
/**
 * Returned by `deriveAndStore` when the recipe moved under it and the load has
 * to start again.
 *
 * #118 NB2: this used to be `return this.loadScene(filePath)` *inside* the
 * promise already registered in {@link SceneCacheService.inFlight}. The restart
 * recomputed the same key, found that promise, and awaited the very promise it
 * was running inside, so the load never resolved — measured at a 5000 ms
 * timeout, and reachable both by a purge landing mid-load and, before any purge
 * existed, by an out-of-band recipe adoption.
 *
 * Clearing `inFlight` on purge is the fix that suggests itself and it is worse:
 * it lets a derivation that outlived the purge write its entry into the
 * directory the purge just shredded. Handing the restart back to the caller
 * keeps the map honest — the entry is removed by the same `finally` that
 * removes it on success, so the restart cannot re-attach to itself.
 */
const RESTART = Symbol('scene-cache-restart');

export const SCENE_CACHE_DIRECTORY = 'scene-cache.v1';
export const MAX_SCENE_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * How much of the model to read per `read` call while hashing.
 *
 * #91 asked whether the whole-file hash on a cache hit could be replaced by a
 * `(path, size, mtime)` key. It cannot — see {@link hashFile} — so the hash
 * stays and the read around it was made cheaper instead. The shipped
 * implementation streamed with the 64 KiB default, which costs one chunk
 * callback, one buffer allocation and one `update` call per 64 KiB: 1792 of
 * each for a 112 MiB model. Measured on that model, median of five warm runs:
 *
 * | read size                    | median   | throughput |
 * | ---------------------------- | -------- | ---------- |
 * | 64 KiB (shipped)             | 117.7 ms | 952 MB/s   |
 * | 1 MiB                        |  72.6 ms | 1544 MB/s  |
 * | 4 MiB into a reused buffer   |  64.1 ms | 1747 MB/s  |
 *
 * The digest is unchanged — SHA-256 is defined over the byte sequence, not the
 * chunking — which `tests/sceneCache.test.ts` pins against a single-shot digest
 * rather than against a transcribed constant.
 */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

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
  /**
   * Which purge era the lease was issued in. A purge bumps the counter, so a
   * derivation already in flight when the user revoked their grants cannot
   * write its entry into the shredded directory afterwards — comparing only
   * the recipe would let it back in as soon as the next load re-adopted the
   * same recipe.
   */
  generation: number;
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
  private generation = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  /**
   * Derivations a later caller for the same key can attach to instead of
   * starting a second one.
   *
   * Sharing a derivation across callers is safe because of two invariants, not
   * one. The generation guard in {@link RecipeLease} covers the *disk*: a
   * derivation that outlived a purge cannot write its entry afterwards. What
   * covers the *sharing* is that every load re-authorizes before reaching this
   * class at all (`ipc.ts:113-114`), so a caller that arrives after a
   * revocation can only attach to a pre-revocation derivation if it just
   * passed a fresh authorization pass of its own.
   *
   * Deliberately not cleared by {@link purge}; see {@link RESTART}.
   */
  private readonly inFlight = new Map<
    string,
    Promise<Scene | typeof RESTART>
  >();

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

  /**
   * Removes every derived scene from disk.
   *
   * Called when the user revokes filesystem grants. `ResetApprovedRoots` clears
   * both grant sources at once — the stored root approvals and the picker
   * allowlist — and scenes derived under those grants are artifacts of them, so
   * they must not outlive them. The entries are owner-only and are never served
   * without a fresh authorization pass, so this is symmetry rather than a
   * containment fix.
   *
   * The manifest is removed before the directory so a partial failure degrades
   * toward eviction: the next adoption finds no persisted recipe, and evicts
   * whatever survived instead of resuming on top of it. A failure is allowed to
   * propagate, because a reset that could not shred is not a reset.
   *
   * {@link inFlight} is deliberately left alone. Clearing it was measured and is
   * strictly worse: it releases a derivation that is mid-flight to register its
   * entry after the shred, putting a derived scene back into the directory the
   * reset just emptied. The generation bump above is what stops that, and it
   * stops it without depending on the map. The self-attachment hang that
   * clearing the map appears to fix is fixed at its cause instead; see
   * {@link RESTART}.
   */
  async purge(): Promise<void> {
    await this.withMutationLock(async () => {
      this.generation += 1;
      this.activeRecipe = UNINITIALIZED;
      this.storageReady = false;
      await this.fileSystem.remove(this.manifestPath);
      await this.fileSystem.remove(this.cacheDirectory);
    });
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
    if (pending) {
      const shared = await pending;
      return shared === RESTART ? this.loadScene(filePath) : shared;
    }

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
    const derived = await loading;
    // The restart runs here rather than inside `deriveAndStore` so that the
    // `finally` above has already removed this key. Restarting from inside the
    // registered promise re-attached it to itself; see RESTART.
    return derived === RESTART ? this.loadScene(filePath) : derived;
  }

  private async deriveAndStore(
    filePath: string,
    modelHash: string,
    assumedRecipe: string,
    lease: RecipeLease,
  ): Promise<Scene | typeof RESTART> {
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
    if (!actualLease) return RESTART;

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

  /**
   * Hashes the model by path.
   *
   * This is deliberate, and the reasoning has previously lived only in review
   * threads, which is how it nearly got optimised away twice.
   *
   * Opening by path rather than sharing a descriptor with the sidecar widens
   * the inherent TOCTOU window (#102 N1). It cannot be narrowed by passing a
   * descriptor, and that is a measurement rather than a belief: requests are
   * built as `JSON.stringify({ id, method, params })` at `sidecar.ts:897` and
   * written with `child.stdin.write` at `:1212`. JSON has no descriptor type,
   * and a `write` on a stdio pipe cannot carry one - descriptor passing needs
   * `sendmsg`/`SCM_RIGHTS` on a unix socket, which is also absent on win32,
   * where the equivalent would be an explicit `DuplicateHandle`.
   * `native/model-core/src/threemf_lib3mf.rs` does build `/proc/self/fd/{fd}`
   * and `/dev/fd/{fd}`, and a reader grepping for `AsRawFd` will find it - but
   * that bridge holds an already-verified descriptor open across the `dlopen`
   * of lib3mf itself. It refers to the sidecar's own library, never to a model,
   * and is not reachable from this side of the boundary.
   *
   * Sharing a descriptor would also be actively harmful even if it were
   * available. The gate in `deriveAndStore` compares two hashes *both taken by
   * path*, and that is the only reason the comparison means anything: the
   * sidecar also opens by path, so a file swapped between the two reads is
   * detected. Hash from one pinned descriptor and both reads see the same
   * bytes, the comparison is vacuously true, and a live control silently
   * becomes a no-op - see `M5-memoise-model-hash` in the #91/#118 matrix, where
   * caching this value alone is enough to disarm it.
   */
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
      generation: this.generation,
    };
  }

  private isCurrent(lease: RecipeLease): boolean {
    return (
      this.generation === lease.generation &&
      this.activeRecipe !== UNINITIALIZED &&
      this.activeRecipe === lease.recipe
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

/**
 * Content hash of a model, used as its cache identity.
 *
 * #91 proposed replacing this with a `(path, size, mtime)` key, which would cost
 * one `stat` (0.048 ms) instead of a full read. It is not safe to do so on a
 * cache hit, and that is a measurement rather than a preference —
 * `tests/sceneCache.test.ts` builds the collisions against a real filesystem:
 *
 * - Two writes landing within one system-clock tick produce byte-different
 *   content under an identical `(dev, ino, size, mtimeNs)`. On win32 this
 *   reproduced on the *second* attempt of a back-to-back rewrite loop; the
 *   clock advances at ~64 Hz while a 4 KiB write takes microseconds.
 * - Restoring a timestamp across a rewrite — `cp -p`, `rsync --times`, `tar -x`
 *   — collides at `mtimeMs` resolution.
 * - Same size, same mtime, different bytes is constructible directly.
 *
 * So metadata does not determine content, and a metadata key would serve a
 * scene derived from different bytes: exactly the property #91 lists first
 * among the ones it must preserve. The read stays; only its chunking changed.
 *
 * The two calls that bracket the sidecar load are likewise not redundant.
 * `deriveAndStore` hashes before and after and stores only when the two agree,
 * which is what establishes that the bytes the sidecar read are the bytes the
 * entry is keyed under. Dropping either one leaves a half-open bracket.
 */
async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(filePath, 'r');
  try {
    // A model smaller than the chunk does not need a chunk-sized buffer, but a
    // file that grows after the stat still must be hashed whole, so the loop
    // ends on a short read rather than on the size read here.
    const { size } = await handle.stat();
    const buffer = Buffer.allocUnsafe(
      Math.max(1, Math.min(HASH_CHUNK_BYTES, size)),
    );
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      // The final read is short. Hashing the whole buffer would fold in bytes
      // left over from the previous chunk, so every model whose size is not a
      // multiple of the buffer would get a digest unrelated to its contents.
      hash.update(
        bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
      );
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
