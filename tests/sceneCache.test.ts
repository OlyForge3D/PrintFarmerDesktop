import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SCENE_ENTRY_BYTES,
  SceneCacheService,
  sceneCacheKey,
  type SceneCacheFileSystem,
  type SceneCacheSidecar,
} from '../src/main/sceneCache';
import type { LoadSceneResponse } from '@shared/ipc';
import type { RecipeBoundScene } from '../src/main/sidecar';

const temporaryDirectories: string[] = [];
const CACHE_DIRECTORY = 'scene-cache.v1';

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'printfarmer-scene-cache-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function scene(marker: number): LoadSceneResponse {
  return {
    sceneVersion: 2,
    positions: [marker, 0, 0, marker + 1, 0, 0, marker, 1, 0],
    indices: [0, 1, 2],
    bounds: { min: [marker, 0, 0], max: [marker + 1, 1, 0] },
    sourceFormat: 'stl',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [],
    objects: [],
    rootObjectIds: [],
    plates: [],
  };
}

interface FakeSidecar extends SceneCacheSidecar {
  advertisedRecipe: string | undefined;
  returnedRecipe: string | undefined;
  sceneCacheRecipe: ReturnType<typeof vi.fn<() => Promise<string | undefined>>>;
  loadSceneWithRecipe: ReturnType<
    typeof vi.fn<(filePath: string) => Promise<RecipeBoundScene>>
  >;
}

function fakeSidecar(): FakeSidecar {
  const sidecar: FakeSidecar = {
    advertisedRecipe: undefined,
    returnedRecipe: undefined,
    sceneCacheRecipe: vi.fn(() => Promise.resolve(sidecar.advertisedRecipe)),
    loadSceneWithRecipe: vi.fn(() => {
      const loaded = {
        scene: scene(sidecar.loadSceneWithRecipe.mock.calls.length),
      };
      return Promise.resolve(
        sidecar.returnedRecipe
          ? { ...loaded, cacheRecipe: sidecar.returnedRecipe }
          : loaded,
      );
    }),
  };
  return sidecar;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function modelFile(userDataPath: string): Promise<string> {
  const filePath = path.join(userDataPath, 'part.stl');
  await writeFile(filePath, 'same model bytes');
  return filePath;
}

async function cachedSceneFiles(userDataPath: string): Promise<string[]> {
  try {
    return (await readdir(path.join(userDataPath, CACHE_DIRECTORY))).filter(
      (name) => name.endsWith('.scene.json'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function testFileSystem(): SceneCacheFileSystem {
  return {
    hashFile: async (filePath) =>
      createHash('sha256')
        .update(await readFile(filePath))
        .digest('hex'),
    mkdir: async (directoryPath) => {
      await mkdir(directoryPath, { recursive: true });
    },
    readText: (filePath) => readFile(filePath, 'utf8'),
    rename,
    remove: async (targetPath) => {
      await rm(targetPath, { force: true, recursive: true });
    },
    size: async (filePath) => (await stat(filePath)).size,
    writeText: (filePath, contents) =>
      writeFile(filePath, contents, {
        encoding: 'utf8',
        flag: 'wx',
      }),
  };
}

describe('SceneCacheService', () => {
  it('matches the native length-prefixed cache-key contract', () => {
    expect(sceneCacheKey('a'.repeat(64), 'scene/v2.2')).toBe(
      'f4ef1c31ccf37c2e0cf75281448694835e8fe0d30473f6be361e15369c8c9672',
    );
    expect(sceneCacheKey('c', 'ab')).not.toBe(sceneCacheKey('bc', 'a'));
  });

  it('does not cache scenes when an older sidecar omits the recipe', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const cacheDirectory = path.join(userDataPath, CACHE_DIRECTORY);
    await mkdir(cacheDirectory);
    await writeFile(
      path.join(cacheDirectory, 'pre-hardening.scene.json'),
      '{}',
    );
    const sidecar = fakeSidecar();
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
    expect(await cachedSceneFiles(userDataPath)).toEqual([]);
  });

  it('eagerly evicts an unversioned cache before adopting a known recipe', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const cacheDirectory = path.join(userDataPath, CACHE_DIRECTORY);
    await mkdir(cacheDirectory);
    const legacyPath = path.join(
      cacheDirectory,
      'legacy-pre-hardening.scene.json',
    );
    await writeFile(legacyPath, JSON.stringify(scene(99)));
    const sidecar = fakeSidecar();
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await cache.adoptRecipe(undefined);
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    await cache.adoptRecipe(sidecar.advertisedRecipe);

    expect(await cachedSceneFiles(userDataPath)).toEqual([]);
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledOnce();
  });

  it('re-derives and eagerly removes cached scenes after a recipe bump', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.1';
    sidecar.returnedRecipe = 'scene/v2.1';
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    const [supersededEntry] = await cachedSceneFiles(userDataPath);
    expect(supersededEntry).toBeDefined();

    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
    const currentEntries = await cachedSceneFiles(userDataPath);
    expect(currentEntries).toHaveLength(1);
    expect(currentEntries).not.toContain(supersededEntry);
  });

  it('stores under the recipe returned by the sidecar rather than the recipe assumed before loading', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.1';
    sidecar.returnedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    sidecar.advertisedRecipe = 'scene/v2.2';
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledOnce();
  });

  it('reuses a persisted scene after the process-local cache is recreated', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';

    await new SceneCacheService({ userDataPath, sidecar }).loadScene(filePath);
    await expect(
      new SceneCacheService({ userDataPath, sidecar }).loadScene(filePath),
    ).resolves.toEqual(scene(1));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledOnce();
  });

  it('eagerly adopts the sidecar recipe during initialization', async () => {
    const userDataPath = await temporaryDirectory();
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await cache.initialize();

    expect(sidecar.sceneCacheRecipe.mock.calls).toHaveLength(1);
    expect(sidecar.loadSceneWithRecipe).not.toHaveBeenCalled();
    await expect(
      readFile(path.join(userDataPath, CACHE_DIRECTORY, 'recipe.json'), 'utf8'),
    ).resolves.toContain('scene/v2.2');
  });

  it('re-derives and repairs an unreadable cache entry', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    await new SceneCacheService({ userDataPath, sidecar }).loadScene(filePath);
    const [entryName] = await cachedSceneFiles(userDataPath);
    expect(entryName).toBeDefined();
    const entryPath = path.join(userDataPath, CACHE_DIRECTORY, entryName!);
    await rm(entryPath);
    await mkdir(entryPath);

    await expect(
      new SceneCacheService({
        userDataPath,
        sidecar,
        reportError: vi.fn(),
      }).loadScene(filePath),
    ).resolves.toEqual(scene(2));
    await expect(
      new SceneCacheService({ userDataPath, sidecar }).loadScene(filePath),
    ).resolves.toEqual(scene(2));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('returns derived scenes when cache writes fail', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const baseFileSystem = testFileSystem();
    const fileSystem: SceneCacheFileSystem = {
      ...baseFileSystem,
      writeText: async (targetPath, contents) => {
        if (
          path.basename(targetPath).endsWith('.tmp') &&
          !path.basename(targetPath).includes('recipe.json')
        ) {
          throw Object.assign(new Error('locked'), { code: 'EPERM' });
        }
        await baseFileSystem.writeText(targetPath, contents);
      },
    };
    const reportError = vi.fn();
    const cache = new SceneCacheService({
      userDataPath,
      sidecar,
      fileSystem,
      reportError,
    });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      'Scene cache write failed; returning the uncached scene.',
      expect.objectContaining({ code: 'EPERM' }),
    );
  });

  it('does not discard an in-flight scene when another cache write fails', async () => {
    const userDataPath = await temporaryDirectory();
    const firstFile = path.join(userDataPath, 'first.stl');
    const secondFile = path.join(userDataPath, 'second.stl');
    await writeFile(firstFile, 'first model');
    await writeFile(secondFile, 'second model');
    let releaseFirst: ((loaded: RecipeBoundScene) => void) | undefined;
    const firstResult = new Promise<RecipeBoundScene>((resolve) => {
      releaseFirst = resolve;
    });
    let firstFileCalls = 0;
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.1';
    sidecar.returnedRecipe = 'scene/v2.1';
    sidecar.loadSceneWithRecipe.mockImplementation((filePath) => {
      if (filePath === firstFile) {
        firstFileCalls += 1;
        return firstFileCalls === 1
          ? firstResult
          : Promise.reject(new Error('successful scene was retried'));
      }
      return Promise.resolve({
        scene: scene(2),
        cacheRecipe: 'scene/v2.1',
      });
    });
    const baseFileSystem = testFileSystem();
    const fileSystem: SceneCacheFileSystem = {
      ...baseFileSystem,
      writeText: async (targetPath, contents) => {
        if (
          path.basename(targetPath).endsWith('.tmp') &&
          !path.basename(targetPath).includes('recipe.json')
        ) {
          throw Object.assign(new Error('locked'), { code: 'EPERM' });
        }
        await baseFileSystem.writeText(targetPath, contents);
      },
    };
    const cache = new SceneCacheService({
      userDataPath,
      sidecar,
      fileSystem,
      reportError: vi.fn(),
    });

    const first = cache.loadScene(firstFile);
    await vi.waitFor(() =>
      expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledOnce(),
    );
    await expect(cache.loadScene(secondFile)).resolves.toEqual(scene(2));
    releaseFirst?.({
      scene: scene(10),
      cacheRecipe: 'scene/v2.2',
    });

    await expect(first).resolves.toEqual(scene(10));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('loads without persistence when recipe adoption fails', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const baseFileSystem = testFileSystem();
    const fileSystem: SceneCacheFileSystem = {
      ...baseFileSystem,
      remove: async (targetPath) => {
        if (path.basename(targetPath) === CACHE_DIRECTORY) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        await baseFileSystem.remove(targetPath);
      },
    };
    const reportError = vi.fn();
    const cache = new SceneCacheService({
      userDataPath,
      sidecar,
      fileSystem,
      reportError,
    });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(
      'Scene cache initialization failed; loading without persistence.',
      expect.objectContaining({ code: 'EACCES' }),
    );
  });

  it('enforces the serialized entry-size limit at the exact boundary', async () => {
    const payloadBytes = Buffer.byteLength(JSON.stringify(scene(1)), 'utf8');
    const exactDirectory = await temporaryDirectory();
    const exactFile = await modelFile(exactDirectory);
    const exactSidecar = fakeSidecar();
    exactSidecar.advertisedRecipe = 'scene/v2.2';
    exactSidecar.returnedRecipe = 'scene/v2.2';
    const exactCache = new SceneCacheService({
      userDataPath: exactDirectory,
      sidecar: exactSidecar,
      maxEntryBytes: payloadBytes,
    });

    await exactCache.loadScene(exactFile);
    await expect(exactCache.loadScene(exactFile)).resolves.toEqual(scene(1));
    expect(exactSidecar.loadSceneWithRecipe).toHaveBeenCalledOnce();

    const undersizedDirectory = await temporaryDirectory();
    const undersizedFile = await modelFile(undersizedDirectory);
    const undersizedSidecar = fakeSidecar();
    undersizedSidecar.advertisedRecipe = 'scene/v2.2';
    undersizedSidecar.returnedRecipe = 'scene/v2.2';
    const undersizedCache = new SceneCacheService({
      userDataPath: undersizedDirectory,
      sidecar: undersizedSidecar,
      maxEntryBytes: payloadBytes - 1,
    });

    await undersizedCache.loadScene(undersizedFile);
    await expect(undersizedCache.loadScene(undersizedFile)).resolves.toEqual(
      scene(2),
    );
    expect(undersizedSidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
    expect(await cachedSceneFiles(undersizedDirectory)).toEqual([]);
  });

  it('uses the shipped 64 MiB entry limit by default', async () => {
    expect(MAX_SCENE_ENTRY_BYTES).toBe(67_108_864);
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    await new SceneCacheService({ userDataPath, sidecar }).loadScene(filePath);
    const baseFileSystem = testFileSystem();
    const fileSystem: SceneCacheFileSystem = {
      ...baseFileSystem,
      size: (targetPath) =>
        targetPath.endsWith('.scene.json')
          ? Promise.resolve(67_108_865)
          : baseFileSystem.size(targetPath),
    };

    await expect(
      new SceneCacheService({
        userDataPath,
        sidecar,
        fileSystem,
      }).loadScene(filePath),
    ).resolves.toEqual(scene(2));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized entries before reading their payload', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    await new SceneCacheService({ userDataPath, sidecar }).loadScene(filePath);
    const [entryName] = await cachedSceneFiles(userDataPath);
    expect(entryName).toBeDefined();
    const entryPath = path.join(userDataPath, CACHE_DIRECTORY, entryName!);
    const payload = await readFile(entryPath, 'utf8');
    await writeFile(entryPath, `${payload} `);

    await expect(
      new SceneCacheService({
        userDataPath,
        sidecar,
        maxEntryBytes: Buffer.byteLength(payload, 'utf8'),
      }).loadScene(filePath),
    ).resolves.toEqual(scene(2));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('re-derives disk entries that fail the scene DTO contract', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    await new SceneCacheService({ userDataPath, sidecar }).loadScene(filePath);
    const [entryName] = await cachedSceneFiles(userDataPath);
    expect(entryName).toBeDefined();
    const invalidScene = { ...scene(99), indices: [-1] };
    await writeFile(
      path.join(userDataPath, CACHE_DIRECTORY, entryName!),
      JSON.stringify(invalidScene),
    );

    await expect(
      new SceneCacheService({ userDataPath, sidecar }).loadScene(filePath),
    ).resolves.toEqual(scene(2));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('does not persist a scene under a hash for bytes the sidecar did not read', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const originalBytes = await readFile(filePath, 'utf8');
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    sidecar.loadSceneWithRecipe
      .mockImplementationOnce(async () => {
        await writeFile(filePath, 'rewritten model bytes');
        return { scene: scene(1), cacheRecipe: 'scene/v2.2' };
      })
      .mockResolvedValueOnce({
        scene: scene(2),
        cacheRecipe: 'scene/v2.2',
      });
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    await writeFile(filePath, originalBytes);
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));

    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('returns the derived scene when the model vanishes during derivation', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const expected = scene(7);
    const cache = new SceneCacheService({
      userDataPath,
      sidecar: {
        sceneCacheRecipe: () => Promise.resolve('scene/v2.2'),
        loadSceneWithRecipe: async () => {
          await rm(filePath, { force: true });
          return { scene: expected, cacheRecipe: 'scene/v2.2' };
        },
      },
      reportError: vi.fn(),
    });

    await expect(cache.loadScene(filePath)).resolves.toEqual(expected);
  });

  it('loads uncached when the initial model hash cannot be read', async () => {
    const userDataPath = await temporaryDirectory();
    const missingPath = path.join(userDataPath, 'moved.stl');
    const expected = scene(8);
    const loadSceneWithRecipe = vi.fn(() =>
      Promise.resolve({
        scene: expected,
        cacheRecipe: 'scene/v2.2',
      }),
    );
    const cache = new SceneCacheService({
      userDataPath,
      sidecar: {
        sceneCacheRecipe: () => Promise.resolve('scene/v2.2'),
        loadSceneWithRecipe,
      },
      reportError: vi.fn(),
    });

    await expect(cache.loadScene(missingPath)).resolves.toEqual(expected);
    expect(loadSceneWithRecipe).toHaveBeenCalledOnce();
  });

  it('invalidates outstanding reads before recipe eviction performs I/O', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.1';
    sidecar.returnedRecipe = 'scene/v2.1';
    await new SceneCacheService({ userDataPath, sidecar }).loadScene(filePath);

    const readStarted = deferred();
    const releaseRead = deferred();
    const evictionStarted = deferred();
    const releaseEviction = deferred();
    const baseFileSystem = testFileSystem();
    let blockEntryRead = true;
    const fileSystem: SceneCacheFileSystem = {
      ...baseFileSystem,
      readText: async (targetPath) => {
        if (blockEntryRead && targetPath.endsWith('.scene.json')) {
          blockEntryRead = false;
          readStarted.resolve();
          await releaseRead.promise;
        }
        return baseFileSystem.readText(targetPath);
      },
      remove: async (targetPath) => {
        if (path.basename(targetPath) === CACHE_DIRECTORY) {
          evictionStarted.resolve();
          await releaseEviction.promise;
        }
        await baseFileSystem.remove(targetPath);
      },
    };
    const cache = new SceneCacheService({
      userDataPath,
      sidecar,
      fileSystem,
    });

    const loading = cache.loadScene(filePath);
    await readStarted.promise;
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const transitioning = cache.adoptRecipe('scene/v2.2');
    await evictionStarted.promise;
    releaseRead.resolve();
    releaseEviction.resolve();

    await transitioning;
    await expect(loading).resolves.toEqual(scene(2));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('does not deduplicate concurrent loads across different recipes', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    let releaseFirst: ((value: RecipeBoundScene) => void) | undefined;
    const firstResult = new Promise<RecipeBoundScene>((resolve) => {
      releaseFirst = resolve;
    });
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.1';
    sidecar.returnedRecipe = 'scene/v2.1';
    sidecar.loadSceneWithRecipe
      .mockImplementationOnce(() => firstResult)
      .mockResolvedValueOnce({
        scene: scene(2),
        cacheRecipe: 'scene/v2.2',
      });
    const cache = new SceneCacheService({ userDataPath, sidecar });

    const first = cache.loadScene(filePath);
    await vi.waitFor(() =>
      expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledOnce(),
    );
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const second = cache.loadScene(filePath);
    await expect(second).resolves.toEqual(scene(2));
    releaseFirst?.({ scene: scene(1), cacheRecipe: 'scene/v2.1' });
    await expect(first).resolves.toEqual(scene(1));

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });
});
