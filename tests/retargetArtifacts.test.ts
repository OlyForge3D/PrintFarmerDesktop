// @vitest-environment node

import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetargetArtifactService } from '../src/main/retargetArtifacts.js';

const temporaryDirectories: string[] = [];
const profileId =
  'snapmaker-u1-orca-presets:profiles/Snapmaker/process/standard.json';

function report(sourceHash: string) {
  return {
    accepted: true,
    source: {
      fileName: 'source.3mf',
      byteSize: 8,
      sha256: sourceHash,
      producer: 'OrcaSlicer',
      objectCount: 1,
      buildItemCount: 1,
      plateCount: 1,
      materials: ['PLA'],
      colors: ['#ffffff'],
    },
    recommendation: null,
    blockers: [],
    warnings: [],
    proposedChanges: {},
  };
}

async function fixture(options?: {
  now?: () => number;
  preflight?: () => unknown;
  savePath?: string;
  tempPath?: string;
}) {
  const root =
    options?.tempPath ??
    (await mkdtemp(path.join(os.tmpdir(), 'u1-artifacts-')));
  if (!options?.tempPath) temporaryDirectories.push(root);
  const source = path.join(root, 'source.3mf');
  const bytes = Buffer.from('editable');
  await writeFile(source, bytes);
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const sidecar = {
    listModels: vi.fn(() =>
      Promise.resolve([
        {
          hash: 'd'.repeat(64),
          format: 'stl',
          locations: [],
        },
        {
          hash: sourceHash,
          format: 'threeMf',
          locations: [
            {
              rootId: 'root-1',
              path: source,
              rootRelative: 'source.3mf',
              available: true,
            },
          ],
        },
      ]),
    ),
    preflightRetarget: vi.fn(() =>
      Promise.resolve(
        options?.preflight
          ? options.preflight()
          : { status: 'ok', value: report(sourceHash) },
      ),
    ),
    buildRetarget: vi.fn(
      async (
        _source: string,
        output: string,
        _target: unknown,
        _objectExclusion: boolean,
      ) => {
        void _target;
        void _objectExclusion;
        const outputBytes = Buffer.from('retargeted');
        await writeFile(output, outputBytes);
        const outputHash = createHash('sha256')
          .update(outputBytes)
          .digest('hex');
        return {
          status: 'ok',
          value: {
            sourceSha256: sourceHash,
            outputSha256: outputHash,
            outputFileName: 'output.3mf',
            targetProfileId: profileId,
            removedPartCount: 0,
            preservedPartCount: 1,
            appliedChanges: {},
            warnings: [],
            validation: {
              valid: true,
              sourceSha256: sourceHash,
              outputSha256: outputHash,
              sourcePreserved: true,
              sceneCompatibility: { compatible: true, differences: [] },
              invariants: {},
              warnings: [],
              errors: [],
            },
          },
        };
      },
    ),
    validateRetargetOutput: vi.fn(async (_source: string, output: string) => {
      const outputHash = createHash('sha256')
        .update(await readFile(output))
        .digest('hex');
      return {
        status: 'ok',
        value: {
          valid: true,
          sourceSha256: sourceHash,
          outputSha256: outputHash,
          sourcePreserved: true,
        },
      };
    }),
    loadScene: vi.fn(() => Promise.resolve({ sceneVersion: 2 })),
    scanRoot: vi.fn(() => Promise.resolve({})),
  };
  const showSaveDialog = vi.fn(() =>
    Promise.resolve(
      options?.savePath
        ? { canceled: false, filePath: options.savePath }
        : { canceled: true },
    ),
  );
  const service = new RetargetArtifactService({
    sidecar,
    profiles: {
      getPrivateReference: () => ({
        kind: 'bundled',
        targetProfileId: profileId,
      }),
      getFingerprint: () => 'e'.repeat(64),
    },
    dialogs: {
      showSaveDialog,
      showOpenDialog: vi.fn(),
    },
    tempPath: root,
    ...(options?.now ? { now: options.now } : {}),
  });
  await service.initialize();
  return { service, sidecar, showSaveDialog, source, sourceHash, root };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('RetargetArtifactService', () => {
  it('handles a blocked preflight without a report and accepts mixed catalogs', async () => {
    const { service, sourceHash } = await fixture({
      preflight: () => ({
        status: 'blocked',
        blockers: [],
        warnings: [],
        value: null,
      }),
    });

    await expect(
      service.preflight(1, {
        modelHash: sourceHash,
        rootId: 'root-1',
        profileId,
        objectExclusion: false,
      }),
    ).resolves.toEqual({
      status: 'blocked',
      blockers: [],
      warnings: [],
      value: null,
    });
  });

  it('binds tokens to owners and expires them', async () => {
    let now = 0;
    const { service, sourceHash } = await fixture({ now: () => now });
    const preflight = (await service.preflight(1, {
      modelHash: sourceHash,
      rootId: 'root-1',
      profileId,
      objectExclusion: false,
    })) as { status: 'ok'; value: { token: string } };

    await expect(
      service.loadScene(2, { token: preflight.value.token, source: 'source' }),
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'artifactForbidden' },
    });
    now = 31 * 60 * 1000;
    await expect(
      service.loadScene(1, { token: preflight.value.token, source: 'source' }),
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'artifactExpired' },
    });
  });

  it('builds through the amended target reference and refuses saving over source', async () => {
    const { service, sidecar, showSaveDialog, source, sourceHash } =
      await fixture({
        savePath: '',
      });
    const preflight = (await service.preflight(1, {
      modelHash: sourceHash,
      rootId: 'root-1',
      profileId,
      objectExclusion: false,
    })) as { status: 'ok'; value: { token: string } };
    await expect(
      service.build(1, {
        token: preflight.value.token,
        profileId,
        objectExclusion: false,
      }),
    ).resolves.toMatchObject({ status: 'ok' });
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: source });

    await expect(
      service.saveAs(1, preflight.value.token, {} as BrowserWindow),
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'saveSourceConflict' },
    });
    expect(sidecar.buildRetarget).toHaveBeenCalledWith(
      source,
      expect.any(String),
      { kind: 'bundled', targetProfileId: profileId },
      false,
    );
  });

  it('removes stale app-instance roots on startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'u1-cleanup-'));
    temporaryDirectories.push(root);
    const stale = path.join(root, 'PrintFarmer', 'retarget', 'stale-instance');
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, 'artifact.3mf'), 'stale');
    const { service } = await fixture({ tempPath: root });
    await service.disposeAll();
    await expect(access(stale)).rejects.toThrow();
  });
});
