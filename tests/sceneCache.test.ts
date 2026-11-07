import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_SCENE_ENTRY_BYTES,
  SceneCacheService,
  sceneCacheKey,
  serializeSceneCache,
  thumbnailCacheKey,
  thumbnailCacheRecipe,
  type SceneCacheFileSystem,
  type SceneCacheSidecar,
} from '../src/main/sceneCache';
import type { LoadSceneResponse } from '@shared/ipc';
import type { RecipeBoundScene } from '../src/main/sidecar';

const temporaryDirectories: string[] = [];
const CACHE_DIRECTORY = 'scene-cache.v1';

describe('bounded scene cache serialization', () => {
  it('keeps the JSON format and exact UTF-8 budget for ordinary and typed arrays', () => {
    const original = scene(1);
    original.statusMessages = ['folder \u2603'];
    const typed = {
      ...original,
      positions: Float32Array.from(original.positions),
      indices: Uint32Array.from(original.indices),
      faceColors: new Uint8Array([1, 2, 3]),
    };
    const expected = JSON.stringify({ ...original, faceColors: [1, 2, 3] });
    const budget = Buffer.byteLength(expected, 'utf8');
    expect(serializeSceneCache(typed, budget)).toBe(expected);
    expect(serializeSceneCache(typed, budget - 1)).toBeNull();
    expect(serializeSceneCache(original, MAX_SCENE_ENTRY_BYTES)).toBe(
      JSON.stringify(original),
    );
  });

  it('never passes a giant number array to stringify and stops at the budget', () => {
    const loaded = {
      ...scene(1),
      positions: new Float32Array(100_000).fill(1.1234567),
    };
    const original = JSON.stringify;
    let largestArray = 0;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value) => {
      if (Array.isArray(value))
        largestArray = Math.max(largestArray, value.length);
      return original(value);
    });
    try {
      expect(serializeSceneCache(loaded, 250_000)).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(largestArray).toBe(8192);
  });
});

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
  hashModelSource: ReturnType<
    typeof vi.fn<(filePath: string) => Promise<string>>
  >;
  loadSceneWithRecipe: ReturnType<
    typeof vi.fn<(filePath: string) => Promise<RecipeBoundScene>>
  >;
}

function fakeSidecar(): FakeSidecar {
  const sidecar: FakeSidecar = {
    advertisedRecipe: undefined,
    returnedRecipe: undefined,
    sceneCacheRecipe: vi.fn(() => Promise.resolve(sidecar.advertisedRecipe)),
    hashModelSource: vi.fn((filePath) =>
      Promise.resolve(createHash('sha256').update(filePath).digest('hex')),
    ),
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

function memoryFileSystem(
  sourceFiles: Map<string, string>,
): SceneCacheFileSystem & {
  setModifiedAt(filePath: string, value: number): void;
  setReportedSize(filePath: string, size: number): void;
  seed(filePath: string, contents: string): void;
  has(filePath: string): boolean;
} {
  const entries = new Map<string, string>();
  const modifiedAt = new Map<string, number>();
  const reportedSizes = new Map<string, number>();
  const missing = (filePath: string): Error & { code: string } =>
    Object.assign(new Error(`Missing file: ${filePath}`), { code: 'ENOENT' });
  return {
    hashFile: (filePath) => {
      const contents = sourceFiles.get(filePath);
      if (contents === undefined) return Promise.reject(missing(filePath));
      return Promise.resolve(
        createHash('sha256').update(contents).digest('hex'),
      );
    },
    mkdir: () => Promise.resolve(),
    readText: (filePath) => {
      const contents = entries.get(filePath);
      if (contents === undefined) return Promise.reject(missing(filePath));
      return Promise.resolve(contents);
    },
    rename: (sourcePath, destinationPath) => {
      const contents = entries.get(sourcePath);
      if (contents === undefined) return Promise.reject(missing(sourcePath));
      entries.delete(sourcePath);
      entries.set(destinationPath, contents);
      modifiedAt.set(destinationPath, modifiedAt.get(sourcePath) ?? Date.now());
      const reportedSize = reportedSizes.get(sourcePath);
      if (reportedSize !== undefined) {
        reportedSizes.set(destinationPath, reportedSize);
      }
      modifiedAt.delete(sourcePath);
      reportedSizes.delete(sourcePath);
      return Promise.resolve();
    },
    remove: (targetPath) => {
      for (const filePath of entries.keys()) {
        if (filePath === targetPath || filePath.startsWith(`${targetPath}/`)) {
          entries.delete(filePath);
          modifiedAt.delete(filePath);
          reportedSizes.delete(filePath);
        }
      }
      return Promise.resolve();
    },
    size: (filePath) => {
      const contents = entries.get(filePath);
      if (contents === undefined) return Promise.reject(missing(filePath));
      return Promise.resolve(Buffer.byteLength(contents, 'utf8'));
    },
    writeText: (filePath, contents) => {
      if (entries.has(filePath)) {
        return Promise.reject(
          Object.assign(new Error(`Already exists: ${filePath}`), {
            code: 'EEXIST',
          }),
        );
      }
      entries.set(filePath, contents);
      modifiedAt.set(filePath, Date.now());
      return Promise.resolve();
    },
    listFiles: (directoryPath) =>
      Promise.resolve(
        [...entries.entries()]
          .filter(([filePath]) => path.dirname(filePath) === directoryPath)
          .map(([filePath, contents]) => ({
            name: path.basename(filePath),
            size:
              reportedSizes.get(filePath) ??
              Buffer.byteLength(contents, 'utf8'),
            modifiedAt: modifiedAt.get(filePath) ?? Date.now(),
          })),
      ),
    touch: (filePath) => {
      if (!entries.has(filePath)) return Promise.reject(missing(filePath));
      modifiedAt.set(filePath, Date.now());
      return Promise.resolve();
    },
    setModifiedAt: (filePath, value) => modifiedAt.set(filePath, value),
    setReportedSize: (filePath, size) => reportedSizes.set(filePath, size),
    seed: (filePath, contents) => {
      entries.set(filePath, contents);
      modifiedAt.set(filePath, Date.now());
    },
    has: (filePath) => entries.has(filePath),
  };
}

describe('SceneCacheService', () => {
  it('matches the native length-prefixed cache-key contract', () => {
    expect(sceneCacheKey('a'.repeat(64), 'scene/v2.2')).toBe(
      'f4ef1c31ccf37c2e0cf75281448694835e8fe0d30473f6be361e15369c8c9672',
    );
    expect(sceneCacheKey('c', 'ab')).not.toBe(sceneCacheKey('bc', 'a'));
  });

  it('reuses persisted thumbnails across service instances', async () => {
    const sourceFiles = new Map([['/models/part.stl', 'same model bytes']]);
    const fileSystem = memoryFileSystem(sourceFiles);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const firstCache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
    });
    const recipe = thumbnailCacheRecipe('scene/v2.2', 256);
    expect(thumbnailCacheKey('a'.repeat(64), recipe, 256)).not.toBe(
      thumbnailCacheKey('a'.repeat(64), recipe, 512),
    );
    const firstRender = vi.fn(() =>
      Promise.resolve({
        width: 256,
        height: 256,
        pngBase64: 'PERSISTED',
        cacheRecipe: recipe,
      }),
    );

    await firstCache.initialize();
    await expect(
      firstCache.renderThumbnail('/models/part.stl', 256, firstRender),
    ).resolves.toMatchObject({ pngBase64: 'PERSISTED' });

    const secondCache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
    });
    const secondRender = vi.fn(() =>
      Promise.resolve({
        width: 256,
        height: 256,
        pngBase64: 'SHOULD_NOT_RENDER',
        cacheRecipe: recipe,
      }),
    );
    await secondCache.initialize();

    await expect(
      secondCache.renderThumbnail('/models/part.stl', 256, secondRender),
    ).resolves.toMatchObject({ pngBase64: 'PERSISTED' });
    expect(firstRender).toHaveBeenCalledTimes(1);
    expect(secondRender).not.toHaveBeenCalled();
  });

  it('invalidates thumbnail entries when renderer recipe, size, or content changes', async () => {
    const sourceFiles = new Map([['/models/part.stl', 'original bytes']]);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    let rendererVersion = 1;
    const cache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem: memoryFileSystem(sourceFiles),
      thumbnailRecipe: (sceneRecipe, size) =>
        `${sceneRecipe}/thumb-v${rendererVersion}-${size}`,
    });
    await cache.initialize();

    let renderCount = 0;
    const render = (size: number) => {
      return vi.fn(() => {
        renderCount += 1;
        return Promise.resolve({
          width: size,
          height: size,
          pngBase64: `PNG-${renderCount}`,
          cacheRecipe: `scene/v2.2/thumb-v${rendererVersion}-${size}`,
        });
      });
    };

    await cache.renderThumbnail('/models/part.stl', 256, render(256));
    const sameRecipeHit = render(256);
    await cache.renderThumbnail('/models/part.stl', 256, sameRecipeHit);
    expect(sameRecipeHit).not.toHaveBeenCalled();

    const otherSize = render(512);
    await cache.renderThumbnail('/models/part.stl', 512, otherSize);
    expect(otherSize).toHaveBeenCalledTimes(1);

    rendererVersion = 2;
    const newRenderer = render(256);
    await cache.renderThumbnail('/models/part.stl', 256, newRenderer);
    expect(newRenderer).toHaveBeenCalledTimes(1);

    sourceFiles.set('/models/part.stl', 'changed bytes');
    const changedContent = render(256);
    await cache.renderThumbnail('/models/part.stl', 256, changedContent);
    expect(changedContent).toHaveBeenCalledTimes(1);

    const changedContentHit = render(256);
    await cache.renderThumbnail('/models/part.stl', 256, changedContentHit);
    expect(changedContentHit).not.toHaveBeenCalled();
    expect(renderCount).toBe(4);
  });

  it('coalesces concurrent thumbnail requests for identical source contents', async () => {
    const sourceFiles = new Map([
      ['/models/first.stl', 'same model bytes'],
      ['/models/copy.stl', 'same model bytes'],
    ]);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem: memoryFileSystem(sourceFiles),
    });
    await cache.initialize();

    const recipe = thumbnailCacheRecipe('scene/v2.2', 256);
    let finish!: (thumbnail: {
      width: number;
      height: number;
      pngBase64: string;
      cacheRecipe: string;
    }) => void;
    const render = vi.fn(
      () =>
        new Promise<{
          width: number;
          height: number;
          pngBase64: string;
          cacheRecipe: string;
        }>((resolve) => {
          finish = resolve;
        }),
    );
    const first = cache.renderThumbnail('/models/first.stl', 256, render);
    const copy = cache.renderThumbnail('/models/copy.stl', 256, render);

    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    finish({
      width: 256,
      height: 256,
      pngBase64: 'SHARED',
      cacheRecipe: recipe,
    });
    await expect(Promise.all([first, copy])).resolves.toEqual([
      expect.objectContaining({ pngBase64: 'SHARED' }),
      expect.objectContaining({ pngBase64: 'SHARED' }),
    ]);
  });

  it('does not use a content-cache hit to hide a missing source path', async () => {
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem: memoryFileSystem(
        new Map([['/models/available.stl', 'same model bytes']]),
      ),
    });
    await cache.initialize();

    await cache.renderThumbnail('/models/available.stl', 256, () =>
      Promise.resolve({
        width: 256,
        height: 256,
        pngBase64: 'VALID',
        cacheRecipe: thumbnailCacheRecipe('scene/v2.2', 256),
      }),
    );

    const missingSourceRender = vi.fn(() =>
      Promise.reject(new Error('Model source is missing.')),
    );
    await expect(
      cache.renderThumbnail('/models/missing.stl', 256, missingSourceRender),
    ).rejects.toThrow('Model source is missing.');
    expect(missingSourceRender).toHaveBeenCalledOnce();
  });

  it('uses the sidecar to hash ZIP members rather than treating virtual paths as files', async () => {
    const sourcePath = '/dir/a.zip/::zip::/0/nested/a.stl';
    const fileSystem = memoryFileSystem(new Map());
    const hashFile = vi.spyOn(fileSystem, 'hashFile');
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.hashModelSource.mockResolvedValue('a'.repeat(64));
    const cache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
    });
    await cache.initialize();
    const recipe = thumbnailCacheRecipe('scene/v2.2', 256);

    await cache.renderThumbnail(sourcePath, 256, () =>
      Promise.resolve({
        width: 256,
        height: 256,
        pngBase64: 'ZIP',
        cacheRecipe: recipe,
      }),
    );

    expect(hashFile).not.toHaveBeenCalled();
    expect(sidecar.hashModelSource).toHaveBeenCalledTimes(2);
    expect(sidecar.hashModelSource).toHaveBeenCalledWith(sourcePath);
  });

  it('persists cache controls and applies an LRU size cap', async () => {
    const sourceFiles = new Map([
      ['/models/first.stl', 'first model bytes'],
      ['/models/second.stl', 'second model bytes'],
    ]);
    const fileSystem = memoryFileSystem(sourceFiles);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
    });
    await cache.initialize();
    const recipe = thumbnailCacheRecipe('scene/v2.2', 256);
    const response = (pngBase64: string) => ({
      width: 256,
      height: 256,
      pngBase64,
      cacheRecipe: recipe,
    });
    await cache.renderThumbnail('/models/first.stl', 256, () =>
      Promise.resolve(response('FIRST')),
    );
    const firstHash = createHash('sha256')
      .update('first model bytes')
      .digest('hex');
    const firstEntry = path.join(
      '/user-data',
      CACHE_DIRECTORY,
      `${thumbnailCacheKey(firstHash, recipe, 256)}.thumbnail.json`,
    );
    fileSystem.setModifiedAt(firstEntry, Date.now() - 10_000);

    await cache.renderThumbnail('/models/second.stl', 256, () =>
      Promise.resolve(response('SECOND')),
    );
    const secondHash = createHash('sha256')
      .update('second model bytes')
      .digest('hex');
    const secondEntry = path.join(
      '/user-data',
      CACHE_DIRECTORY,
      `${thumbnailCacheKey(secondHash, recipe, 256)}.thumbnail.json`,
    );
    fileSystem.setReportedSize(firstEntry, 12 * 1024 * 1024);
    fileSystem.setReportedSize(secondEntry, 12 * 1024 * 1024);

    const limited = await cache.setThumbnailCacheSettings({
      location: null,
      maxBytes: 16 * 1024 * 1024,
      retentionDays: 30,
    });
    expect(limited.entryCount).toBe(1);
    expect(limited.usedBytes).toBe(12 * 1024 * 1024);
    expect(fileSystem.has(firstEntry)).toBe(false);
    expect(fileSystem.has(secondEntry)).toBe(true);

    const restartedCache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
    });
    await restartedCache.initialize();
    await expect(
      restartedCache.getThumbnailCacheStatus(),
    ).resolves.toMatchObject({
      maxBytes: 16 * 1024 * 1024,
      retentionDays: 30,
      entryCount: 1,
    });
  });

  it('expires thumbnails beyond the configured retention period', async () => {
    const sourceFiles = new Map([['/models/part.stl', 'same model bytes']]);
    const fileSystem = memoryFileSystem(sourceFiles);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const firstCache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
    });
    await firstCache.initialize();
    const recipe = thumbnailCacheRecipe('scene/v2.2', 256);
    await firstCache.renderThumbnail('/models/part.stl', 256, () =>
      Promise.resolve({
        width: 256,
        height: 256,
        pngBase64: 'EXPIRED',
        cacheRecipe: recipe,
      }),
    );
    const hash = createHash('sha256').update('same model bytes').digest('hex');
    const entry = path.join(
      '/user-data',
      CACHE_DIRECTORY,
      `${thumbnailCacheKey(hash, recipe, 256)}.thumbnail.json`,
    );
    fileSystem.setModifiedAt(entry, Date.now() - 31 * 24 * 60 * 60 * 1000);

    const restartedCache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
    });
    await restartedCache.initialize();
    await expect(
      restartedCache.getThumbnailCacheStatus(),
    ).resolves.toMatchObject({ entryCount: 0, usedBytes: 0 });
  });

  it('clears only cache-owned files in a custom location', async () => {
    const sourceFiles = new Map([['/models/part.stl', 'same model bytes']]);
    const fileSystem = memoryFileSystem(sourceFiles);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
    });
    await cache.initialize();
    await cache.setThumbnailCacheSettings({
      location: '/external/cache',
      maxBytes: 512 * 1024 * 1024,
      retentionDays: 30,
    });
    const restartedCache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
    });
    await restartedCache.initialize();
    await expect(
      restartedCache.getThumbnailCacheStatus(),
    ).resolves.toMatchObject({ location: '/external/cache' });
    const recipe = thumbnailCacheRecipe('scene/v2.2', 256);
    await restartedCache.renderThumbnail('/models/part.stl', 256, () =>
      Promise.resolve({
        width: 256,
        height: 256,
        pngBase64: 'CUSTOM',
        cacheRecipe: recipe,
      }),
    );
    const directory = path.join('/external/cache', 'printfarmer-thumbnails.v1');
    const userFile = path.join(directory, 'keep-this-note.txt');
    const unrelated = path.join(directory, `${'b'.repeat(64)}.scene.json`);
    fileSystem.seed(userFile, 'user-owned file');
    fileSystem.seed(unrelated, JSON.stringify(scene(1)));

    await expect(restartedCache.clearThumbnailCache()).resolves.toBe(1);
    expect(fileSystem.has(userFile)).toBe(true);
    expect(fileSystem.has(unrelated)).toBe(true);
    await expect(
      restartedCache.getThumbnailCacheStatus(),
    ).resolves.toMatchObject({ location: '/external/cache', entryCount: 0 });
  });

  it('falls back to rendering with an explicit warning when cache storage becomes unwritable', async () => {
    const sourceFiles = new Map([['/models/part.stl', 'same model bytes']]);
    const fileSystem = memoryFileSystem(sourceFiles);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const reportError = vi.fn();
    const cache = new SceneCacheService({
      userDataPath: '/user-data',
      sidecar,
      fileSystem,
      reportError,
    });
    await cache.initialize();
    await cache.setThumbnailCacheSettings({
      location: '/external/cache',
      maxBytes: 512 * 1024 * 1024,
      retentionDays: 30,
    });
    vi.spyOn(fileSystem, 'writeText').mockRejectedValue(
      new Error('disk is read-only'),
    );
    const render = vi.fn(() =>
      Promise.resolve({
        width: 256,
        height: 256,
        pngBase64: 'UNCACHED',
        cacheRecipe: thumbnailCacheRecipe('scene/v2.2', 256),
      }),
    );

    await expect(
      cache.renderThumbnail('/models/part.stl', 256, render),
    ).resolves.toMatchObject({ pngBase64: 'UNCACHED' });
    expect(render).toHaveBeenCalledOnce();
    const status = await cache.getThumbnailCacheStatus();
    expect(status.warning).toContain('not writable');
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining('not writable'),
      expect.any(Error),
    );
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
        hashModelSource: () =>
          Promise.resolve(createHash('sha256').update(filePath).digest('hex')),
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
        hashModelSource: () =>
          Promise.resolve(
            createHash('sha256').update(missingPath).digest('hex'),
          ),
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

  it('shares one derivation between concurrent loads of the same model', async () => {
    // The `inFlight` map's whole purpose, and nothing asserted it: removing the
    // map entirely left all 692 tests green. The neighbouring test above pins
    // only when dedup must *not* happen, which a cache that never dedupes also
    // satisfies. Two callers, one sidecar derivation, both served.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecarEntered = deferred();
    const releaseSidecar = deferred();
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    sidecar.loadSceneWithRecipe.mockImplementation(async () => {
      sidecarEntered.resolve();
      await releaseSidecar.promise;
      return { scene: scene(1), cacheRecipe: 'scene/v2.2' };
    });
    const cache = new SceneCacheService({ userDataPath, sidecar });

    const first = cache.loadScene(filePath);
    await sidecarEntered.promise;
    const second = cache.loadScene(filePath);
    releaseSidecar.resolve();

    await expect(first).resolves.toEqual(scene(1));
    await expect(second).resolves.toEqual(scene(1));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledOnce();
  });

  it('does not share a derivation between concurrent loads when hashing fails', async () => {
    // Characterization pin, flagged deliberately: `loadScene` returns to the
    // unstored path before the `inFlight` map is consulted, so while the
    // filesystem is failing each concurrent caller drives its own sidecar
    // derivation. #99 (N12) leaves open whether to share here instead. This
    // records what ships today so that changing it is a visible decision
    // rather than an unobserved one - if a later change makes this share, this
    // test is the thing that says so, and it should be rewritten, not deleted.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecarEntered = deferred();
    const releaseSidecar = deferred();
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    sidecar.loadSceneWithRecipe.mockImplementation(async () => {
      sidecarEntered.resolve();
      await releaseSidecar.promise;
      return { scene: scene(1), cacheRecipe: 'scene/v2.2' };
    });
    const fileSystem: SceneCacheFileSystem = {
      ...testFileSystem(),
      hashFile: () =>
        Promise.reject(Object.assign(new Error('io'), { code: 'EIO' })),
    };
    const cache = new SceneCacheService({
      userDataPath,
      sidecar,
      fileSystem,
      reportError: vi.fn(),
    });

    const first = cache.loadScene(filePath);
    await sidecarEntered.promise;
    const second = cache.loadScene(filePath);
    releaseSidecar.resolve();

    await expect(first).resolves.toEqual(scene(1));
    await expect(second).resolves.toEqual(scene(1));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('evicts persisted entries when hashing fails and the sidecar reports no recipe', async () => {
    // `deriveWithoutStore` was broadened from `if (loaded.cacheRecipe)` to
    // `loaded.cacheRecipe ?? null`, which only changes behaviour on the path
    // reached when hashing fails while a recipe is active: the sidecar
    // answering with no recipe now adopts `null`, and adopting `null` is what
    // evicts an unversioned cache. Restoring the old guard left the suite
    // green, so the one semantic change the #84 refactor made was untested.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const baseFileSystem = testFileSystem();
    let hashFails = false;
    const fileSystem: SceneCacheFileSystem = {
      ...baseFileSystem,
      hashFile: (targetPath) =>
        hashFails
          ? Promise.reject(Object.assign(new Error('io'), { code: 'EIO' }))
          : baseFileSystem.hashFile(targetPath),
    };
    const cache = new SceneCacheService({
      userDataPath,
      sidecar,
      fileSystem,
      reportError: vi.fn(),
    });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    expect(await cachedSceneFiles(userDataPath)).toHaveLength(1);

    hashFails = true;
    sidecar.returnedRecipe = undefined;
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));

    expect(await cachedSceneFiles(userDataPath)).toEqual([]);
    await expect(
      readFile(path.join(userDataPath, CACHE_DIRECTORY, 'recipe.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps persisted entries when hashing fails but the sidecar still reports its recipe', async () => {
    // The direction that keeps the test above honest. Eviction must key on the
    // sidecar dropping its recipe, not on the hash failure that routed the load
    // down this path - a cache that evicted on every hash failure would satisfy
    // the assertion above and destroy a valid cache every time a file was
    // briefly locked.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const baseFileSystem = testFileSystem();
    let hashFails = false;
    const fileSystem: SceneCacheFileSystem = {
      ...baseFileSystem,
      hashFile: (targetPath) =>
        hashFails
          ? Promise.reject(Object.assign(new Error('io'), { code: 'EIO' }))
          : baseFileSystem.hashFile(targetPath),
    };
    const cache = new SceneCacheService({
      userDataPath,
      sidecar,
      fileSystem,
      reportError: vi.fn(),
    });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    const [primed] = await cachedSceneFiles(userDataPath);
    expect(primed).toBeDefined();

    hashFails = true;
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));

    expect(await cachedSceneFiles(userDataPath)).toEqual([primed]);
    await expect(
      readFile(path.join(userDataPath, CACHE_DIRECTORY, 'recipe.json'), 'utf8'),
    ).resolves.toContain('scene/v2.2');
  });

  it('shreds every derived scene and the recipe manifest on purge', async () => {
    // #102 N2. Derived scenes are artifacts of a filesystem grant; when the
    // grant is revoked they must not survive it. Nothing asserted this before,
    // so a `purge` that did nothing at all would have been indistinguishable
    // from one that worked.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    expect(await cachedSceneFiles(userDataPath)).toHaveLength(1);
    await expect(
      readFile(path.join(userDataPath, CACHE_DIRECTORY, 'recipe.json'), 'utf8'),
    ).resolves.toContain('scene/v2.2');

    await cache.purge();

    expect(await cachedSceneFiles(userDataPath)).toEqual([]);
    await expect(
      readFile(path.join(userDataPath, CACHE_DIRECTORY, 'recipe.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('evicts entries that survived a purge whose directory removal failed', async () => {
    // The manifest lives inside the directory being shredded, so removing it
    // separately is redundant whenever the shred succeeds. It is not redundant
    // when the shred fails part-way, which on Windows is an ordinary outcome
    // for a file another process has open. Removing the manifest first makes a
    // partial failure degrade toward eviction: the next adoption finds no
    // persisted recipe and clears whatever survived, instead of recognising the
    // recipe and resuming on top of scenes derived under a revoked grant.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const cacheDirectoryPath = path.join(userDataPath, CACHE_DIRECTORY);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';

    let directoryRemovalFails = false;
    const realFileSystem = testFileSystem();
    const fileSystem: SceneCacheFileSystem = {
      ...realFileSystem,
      remove: async (targetPath) => {
        if (directoryRemovalFails && targetPath === cacheDirectoryPath) {
          throw Object.assign(new Error('directory in use'), { code: 'EPERM' });
        }
        await realFileSystem.remove(targetPath);
      },
    };
    const cache = new SceneCacheService({ userDataPath, sidecar, fileSystem });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    expect(await cachedSceneFiles(userDataPath)).toHaveLength(1);

    // Something takes hold of the directory, then lets go again.
    directoryRemovalFails = true;
    await expect(cache.purge()).rejects.toMatchObject({ code: 'EPERM' });
    expect(
      await cachedSceneFiles(userDataPath),
      'the derived scene should survive a failed directory removal',
    ).toHaveLength(1);

    directoryRemovalFails = false;
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('re-derives rather than serving a scene that was cached before a purge', async () => {
    // The shred has to be real on the read path too. Checking only that the
    // directory is empty cannot tell a shredded cache from one whose entries
    // moved; asking for the same model again and watching the sidecar be
    // called a second time can.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledOnce();

    await cache.purge();

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });

  it('caches again after a purge instead of disabling persistence', async () => {
    // The legitimate-maximum direction. A `purge` that permanently disabled
    // storage - or that ran on every load - would satisfy both tests above and
    // silently turn the cache off for the rest of the session. Revocation is
    // supposed to degrade caching momentarily, not end it.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await cache.loadScene(filePath);
    await cache.purge();

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));
    expect(await cachedSceneFiles(userDataPath)).toHaveLength(1);

    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
    await expect(
      readFile(path.join(userDataPath, CACHE_DIRECTORY, 'recipe.json'), 'utf8'),
    ).resolves.toContain('scene/v2.2');
  });

  it('does not let a derivation in flight during a purge write its entry afterwards', async () => {
    // Without a purge generation on the lease this passes for the wrong reason:
    // the write is blocked only until the next load re-adopts the same recipe,
    // after which the pre-purge lease looks current again and the entry lands
    // in the directory that was supposed to have been shredded.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const gate = deferred();
    const entered = deferred();
    sidecar.loadSceneWithRecipe.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return { scene: scene(1), cacheRecipe: 'scene/v2.2' };
    });
    const cache = new SceneCacheService({ userDataPath, sidecar });

    const inFlight = cache.loadScene(filePath);
    // Wait until the sidecar is actually running before revoking. Purging while
    // the load is still queued behind the mutation lock tests nothing: the load
    // would take its lease after the purge and be legitimately current.
    await entered.promise;
    await cache.purge();
    // Re-adopt the same recipe, which is what the next real load does. This is
    // the step that makes the stale lease look current again.
    await cache.adoptRecipe('scene/v2.2');
    gate.resolve();
    await expect(inFlight).resolves.toEqual(scene(1));

    expect(await cachedSceneFiles(userDataPath)).toEqual([]);
  });

  it('resolves a load whose recipe moved under it while it was the in-flight entry', async () => {
    // #118 NB2. `deriveAndStore` restarts when the recipe it assumed is no
    // longer current, and the restart used to be `return this.loadScene(...)`
    // issued from inside the promise already registered in `inFlight`. It
    // recomputed the same key, found that promise, and awaited itself. Measured
    // as a hang rather than a rejection, so the assertion has to be a bounded
    // wait: an unresolved promise is not a failed one, and
    // `await expect(...).resolves` would sit here until the runner gave up and
    // attributed the timeout to the file rather than to this test.
    //
    // Both conditions are required. The purge makes the lease stale, and the
    // sidecar returning a recipe other than the one it advertised is what sends
    // the load down the restart branch in the first place.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const gate = deferred();
    const entered = deferred();
    sidecar.loadSceneWithRecipe.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return { scene: scene(1), cacheRecipe: 'scene/v2.3' };
    });
    const cache = new SceneCacheService({ userDataPath, sidecar });

    const inFlight = cache.loadScene(filePath);
    await entered.promise;
    await cache.purge();
    gate.resolve();

    const timeout = Symbol('timed-out');
    const settled = await Promise.race([
      inFlight,
      new Promise((resolve) => setTimeout(() => resolve(timeout), 2000)),
    ]);
    expect(settled, 'the restarted load never resolved').not.toBe(timeout);
    // The restart re-derives rather than returning the scene from the
    // derivation whose recipe turned out to be stale.
    expect(settled).toEqual(scene(2));
  });

  it('resolves a second caller that attached to a derivation which then restarted', async () => {
    // The sharing branch has to handle the restart too. A caller that attaches
    // at `inFlight.get(key)` receives whatever that derivation produces, so if
    // the restart is signalled rather than performed, the attached caller has to
    // recognise the signal instead of returning it to the renderer as a scene.
    //
    // The second caller must be *past* the `inFlight` lookup before the purge.
    // The first version of this test simply called `loadScene` and purged, and
    // was GREEN against the mutation it exists to catch: the second load was
    // still inside its own hashing when the generation bumped, so it took the
    // stale-lease restart at the top of `loadScene` and never attached to
    // anything. `size` is the last await before the lookup — awaiting its
    // second call and then draining to a macrotask puts the caller where the
    // test says it is, and hangs the test rather than passing vacuously if it
    // never gets there.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    const gate = deferred();
    const entered = deferred();
    sidecar.loadSceneWithRecipe.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return { scene: scene(1), cacheRecipe: 'scene/v2.3' };
    });

    const fileSystem = testFileSystem();
    const secondLookedUp = deferred();
    let lookups = 0;
    const cache = new SceneCacheService({
      userDataPath,
      sidecar,
      fileSystem: {
        ...fileSystem,
        size: async (entryPath) => {
          lookups += 1;
          try {
            return await fileSystem.size(entryPath);
          } finally {
            if (lookups === 2) secondLookedUp.resolve();
          }
        },
      },
    });

    const first = cache.loadScene(filePath);
    await entered.promise;
    const second = cache.loadScene(filePath);
    await secondLookedUp.promise;
    await new Promise((resolve) => setImmediate(resolve));
    await cache.purge();
    gate.resolve();

    const timeout = Symbol('timed-out');
    const settled = await Promise.race([
      Promise.all([first, second]),
      new Promise((resolve) => setTimeout(() => resolve(timeout), 2000)),
    ]);
    expect(settled, 'a shared restarted load never resolved').not.toBe(timeout);
    for (const value of settled as LoadSceneResponse[]) {
      expect(
        typeof value,
        'a caller received the restart signal instead of a scene',
      ).toBe('object');
      expect(value.sceneVersion).toBe(2);
      expect(value.status).toBe('complete');
    }
  });

  it('still shares one derivation between concurrent loads that do not restart', async () => {
    // The legitimate-maximum direction for the restart signal. Turning the
    // shared promise into `Promise<Scene | RESTART>` is invisible to a test that
    // only checks a restart resolves; a change that made every attached caller
    // re-derive would satisfy the two tests above while quietly removing the
    // deduplication `inFlight` exists for.
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const gate = deferred();
    const entered = deferred();
    sidecar.loadSceneWithRecipe.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return { scene: scene(1), cacheRecipe: 'scene/v2.2' };
    });
    const cache = new SceneCacheService({ userDataPath, sidecar });

    const first = cache.loadScene(filePath);
    await entered.promise;
    const second = cache.loadScene(filePath);
    gate.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      scene(1),
      scene(1),
    ]);
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledOnce();
  });
});

describe('SceneCacheService: model identity (#91)', () => {
  // These tests use the shipped default filesystem rather than
  // `testFileSystem()`. Every test above injects its own `hashFile`, so the real
  // one at `sceneCache.ts` was reached by no test at all: it could have been
  // deleted outright with the suite green. Driving it through the public API
  // instead of exporting it keeps the assertion on observable behaviour — the
  // digest determines the cache entry's filename, so a wrong digest is visible
  // as a wrong name.

  const digestOf = async (filePath: string) =>
    createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex');

  const entryNameFor = async (userDataPath: string) => {
    const files = await cachedSceneFiles(userDataPath);
    expect(files).toHaveLength(1);
    return files[0]!.replace(/\.scene\.json$/, '');
  };

  // Sizes chosen around the 4 MiB read buffer, because the interesting failure
  // is the short final read. Below the buffer the read fills it exactly and the
  // partial branch never runs, so a test that only used small models would pass
  // against an implementation that hashed the whole buffer every time and
  // folded stale bytes into every large model's digest.
  for (const [label, size] of [
    ['empty', 0],
    ['smaller than one read', 100],
    ['exactly one read', 4 * 1024 * 1024],
    ['one read plus a short one', 4 * 1024 * 1024 + 1234],
  ] as const) {
    it(`hashes a model ${label} to its true SHA-256`, async () => {
      const userDataPath = await temporaryDirectory();
      const filePath = path.join(userDataPath, 'part.stl');
      // Position-dependent bytes: a constant fill hashes the same whether or
      // not a chunk boundary is handled correctly.
      const bytes = Buffer.allocUnsafe(size);
      for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
      await writeFile(filePath, bytes);

      const sidecar = fakeSidecar();
      sidecar.advertisedRecipe = 'scene/v2.2';
      sidecar.returnedRecipe = 'scene/v2.2';
      const cache = new SceneCacheService({ userDataPath, sidecar });

      await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
      expect(await entryNameFor(userDataPath)).toBe(
        sceneCacheKey(await digestOf(filePath), 'scene/v2.2'),
      );
    });
  }

  it('cannot be replaced by a (size, mtime) key, because metadata does not determine content', async () => {
    // #91 proposes keying on `(path, size, mtime)` to skip the read: a `stat`
    // costs 0.048 ms against 117.7 ms to hash 112 MiB. The reason that is not
    // taken is this, and it is committed as a test rather than written down so
    // that it fails if the premise ever stops holding, instead of being
    // inherited as a comment nobody re-measures.
    //
    // Restoring a timestamp across a rewrite is what `cp -p`, `rsync --times`
    // and `tar -x` all do. A second, independent route is timestamp
    // granularity: on win32 two back-to-back 4 KiB rewrites collided on
    // `(dev, ino, size, mtimeNs)` at the second attempt, because the clock
    // advances at ~64 Hz. That one is not asserted here — it would be a
    // clock-speed race in CI — but it means this is not a single exotic case.
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'part.stl');
    const pinned = new Date(Date.UTC(2020, 0, 1, 12, 0, 0));
    const metadata = async () => {
      const s = await stat(filePath, { bigint: true });
      return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
    };

    await writeFile(filePath, Buffer.alloc(65536, 0x41));
    await utimes(filePath, pinned, pinned);
    const before = { meta: await metadata(), digest: await digestOf(filePath) };

    await writeFile(filePath, Buffer.alloc(65536, 0x42));
    await utimes(filePath, pinned, pinned);
    const after = { meta: await metadata(), digest: await digestOf(filePath) };

    expect(after.meta).toBe(before.meta);
    expect(after.digest).not.toBe(before.digest);

    // The control. Without it the assertion above is satisfied by a `metadata`
    // that returns a constant, which is indistinguishable from a real
    // collision and would make the finding look stronger than it is.
    await writeFile(filePath, Buffer.alloc(4096, 0x43));
    expect(await metadata()).not.toBe(before.meta);
  });

  it('serves a rewritten model a scene derived from its own bytes', async () => {
    // The consequence the collision above would have if the key were metadata,
    // stated as behaviour: same path, same size, same mtime, different bytes
    // must not return the first model's scene. This is the legitimate-maximum
    // direction too — it fails equally for a cache that never hits, so it is
    // paired with a hit assertion.
    const userDataPath = await temporaryDirectory();
    const filePath = path.join(userDataPath, 'part.stl');
    const pinned = new Date(Date.UTC(2020, 0, 1, 12, 0, 0));
    const sidecar = fakeSidecar();
    sidecar.advertisedRecipe = 'scene/v2.2';
    sidecar.returnedRecipe = 'scene/v2.2';
    const cache = new SceneCacheService({ userDataPath, sidecar });

    await writeFile(filePath, Buffer.alloc(2048, 0x41));
    await utimes(filePath, pinned, pinned);
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    // The hit: unchanged bytes are served without a second derivation.
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(1));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledOnce();

    await writeFile(filePath, Buffer.alloc(2048, 0x42));
    await utimes(filePath, pinned, pinned);
    await expect(cache.loadScene(filePath)).resolves.toEqual(scene(2));
    expect(sidecar.loadSceneWithRecipe).toHaveBeenCalledTimes(2);
  });
});
