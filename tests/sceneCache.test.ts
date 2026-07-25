import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCENE_CACHE_DIRECTORY,
  SceneCacheService,
  sceneCacheKey,
  type SceneCacheSidecar,
} from '../src/main/sceneCache';
import type { LoadSceneResponse } from '@shared/ipc';
import type { RecipeBoundScene } from '../src/main/sidecar';

const temporaryDirectories: string[] = [];

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

async function modelFile(userDataPath: string): Promise<string> {
  const filePath = path.join(userDataPath, 'part.stl');
  await writeFile(filePath, 'same model bytes');
  return filePath;
}

async function cachedSceneFiles(userDataPath: string): Promise<string[]> {
  try {
    return (
      await readdir(path.join(userDataPath, SCENE_CACHE_DIRECTORY))
    ).filter((name) => name.endsWith('.scene.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

describe('SceneCacheService', () => {
  it('matches the native length-prefixed cache-key contract', () => {
    expect(sceneCacheKey('a'.repeat(64), 'scene/v2.2')).toBe(
      'f4ef1c31ccf37c2e0cf75281448694835e8fe0d30473f6be361e15369c8c9672',
    );
  });

  it('does not cache scenes when an older sidecar omits the recipe', async () => {
    const userDataPath = await temporaryDirectory();
    const filePath = await modelFile(userDataPath);
    const cacheDirectory = path.join(userDataPath, SCENE_CACHE_DIRECTORY);
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
    const cacheDirectory = path.join(userDataPath, SCENE_CACHE_DIRECTORY);
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
