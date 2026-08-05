// @vitest-environment node

import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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

async function sha256(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

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
    proposedChanges: {
      objectExclusion: [
        {
          code: 'objectExclusionEnabled',
          message: 'Enabled object exclusion.',
        },
      ],
    },
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
            appliedChanges: {
              machine: [
                {
                  code: 'machineReplaced',
                  message: 'Replaced the machine profile.',
                },
              ],
            },
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
    validateRetargetOutput: vi.fn(
      async (_source: string, output: string): Promise<unknown> => {
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
      },
    ),
    loadRetargetScene: vi.fn(() => Promise.resolve({ sceneVersion: 2 })),
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

  it('normalizes optional native change fields for the strict IPC contract', async () => {
    const { service, sourceHash } = await fixture();
    await expect(
      service.preflight(1, {
        modelHash: sourceHash,
        rootId: 'root-1',
        profileId,
        objectExclusion: false,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      value: {
        report: {
          proposedChanges: {
            objectExclusion: [
              {
                setting: null,
                before: null,
                after: null,
              },
            ],
          },
        },
      },
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
      await realpath(source),
      expect.any(String),
      { kind: 'bundled', targetProfileId: profileId },
      false,
    );
  });

  it('preserves source bytes across save outcomes and cleans a successful artifact', async () => {
    const { service, showSaveDialog, source, sourceHash, root } =
      await fixture();
    const preflight = (await service.preflight(1, {
      modelHash: sourceHash,
      rootId: 'root-1',
      profileId,
      objectExclusion: false,
    })) as { status: 'ok'; value: { token: string } };
    expect(await sha256(source)).toBe(sourceHash);
    await expect(
      service.build(1, {
        token: preflight.value.token,
        profileId,
        objectExclusion: false,
      }),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(await sha256(source)).toBe(sourceHash);

    showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await expect(
      service.saveAs(1, preflight.value.token, {} as BrowserWindow),
    ).resolves.toEqual({ status: 'canceled' });
    expect(await sha256(source)).toBe(sourceHash);

    const collision = path.join(root, 'existing.3mf');
    await writeFile(collision, 'existing');
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: collision,
    });
    await expect(
      service.saveAs(1, preflight.value.token, {} as BrowserWindow),
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'saveDestinationExists' },
    });
    expect(await readFile(collision, 'utf8')).toBe('existing');
    expect(await sha256(source)).toBe(sourceHash);

    const destination = path.join(root, 'saved.3mf');
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: destination,
    });
    await expect(
      service.saveAs(1, preflight.value.token, {} as BrowserWindow),
    ).resolves.toMatchObject({ status: 'ok', fileName: 'saved.3mf' });
    expect(await readFile(destination, 'utf8')).toBe('retargeted');
    expect(await sha256(source)).toBe(sourceHash);
    await expect(
      service.loadScene(1, {
        token: preflight.value.token,
        source: 'output',
      }),
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'artifactNotFound' },
    });
  });

  it('preserves source bytes through sidecar failure, recovery, validation failure, and restart', async () => {
    const first = await fixture();
    const firstPreflight = (await first.service.preflight(1, {
      modelHash: first.sourceHash,
      rootId: 'root-1',
      profileId,
      objectExclusion: false,
    })) as { status: 'ok'; value: { token: string } };
    first.sidecar.buildRetarget.mockRejectedValueOnce(
      new Error('sidecar exited'),
    );
    await expect(
      first.service.build(1, {
        token: firstPreflight.value.token,
        profileId,
        objectExclusion: false,
      }),
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'internalError' },
    });
    expect(await sha256(first.source)).toBe(first.sourceHash);

    await expect(
      first.service.build(1, {
        token: firstPreflight.value.token,
        profileId,
        objectExclusion: false,
      }),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(await sha256(first.source)).toBe(first.sourceHash);
    await first.service.dispose(firstPreflight.value.token);

    const validationPreflight = (await first.service.preflight(1, {
      modelHash: first.sourceHash,
      rootId: 'root-1',
      profileId,
      objectExclusion: false,
    })) as { status: 'ok'; value: { token: string } };
    first.sidecar.validateRetargetOutput.mockResolvedValueOnce({
      status: 'error',
      error: {
        code: 'invalidArchive',
        message: 'invalid output',
        action: 'retry',
      },
    });
    await expect(
      first.service.build(1, {
        token: validationPreflight.value.token,
        profileId,
        objectExclusion: false,
      }),
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'invalidArchive' },
    });
    expect(await sha256(first.source)).toBe(first.sourceHash);

    await first.service.disposeAll();
    const restarted = await fixture({ tempPath: first.root });
    expect(restarted.sourceHash).toBe(first.sourceHash);
    await expect(
      restarted.service.preflight(2, {
        modelHash: restarted.sourceHash,
        rootId: 'root-1',
        profileId,
        objectExclusion: false,
      }),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(await sha256(restarted.source)).toBe(first.sourceHash);
    await restarted.service.disposeAll();
  });

  it('removes stale app-instance roots on startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'u1-cleanup-'));
    temporaryDirectories.push(root);
    const parent = path.join(root, 'PrintFarmer', 'retarget');
    const staleId = randomUUID();
    const stale = path.join(parent, staleId);
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, 'artifact.3mf'), 'stale');
    await writeFile(
      path.join(stale, '.printfarmer-retarget-owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: staleId,
        pid: 2147483647,
      }),
    );
    const unowned = path.join(parent, randomUUID());
    await mkdir(unowned);
    await writeFile(path.join(unowned, 'source.3mf'), 'must survive');
    const activeId = randomUUID();
    const active = path.join(parent, activeId);
    await mkdir(active);
    await writeFile(
      path.join(active, '.printfarmer-retarget-owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: activeId,
        pid: process.pid,
      }),
    );
    const { service } = await fixture({ tempPath: root });
    await service.disposeAll();
    await expect(access(stale)).rejects.toThrow();
    await expect(access(unowned)).resolves.toBeUndefined();
    await expect(access(active)).resolves.toBeUndefined();
  });

  /**
   * Sweep a temp root owned by a pid whose liveness probe raises `code`.
   *
   * `isProcessRunning` is module-local and never exported, so the branch can
   * only be reached through `initialize()`. The pid is identical in both arms
   * and the only difference is what `process.kill(pid, 0)` throws, which is
   * what makes the pair a control rather than two unrelated scenarios.
   *
   * Returns whether the probe was actually consulted, because a directory that
   * survives because it was never a sweep candidate is indistinguishable from
   * one the guard deliberately spared.
   */
  async function sweepForeignOwnedRoot(code: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'u1-foreign-'));
    temporaryDirectories.push(root);
    const parent = path.join(root, 'PrintFarmer', 'retarget');
    const foreignId = randomUUID();
    const foreign = path.join(parent, foreignId);
    const foreignPid = 424242;
    await mkdir(foreign, { recursive: true });
    await writeFile(path.join(foreign, 'artifact.3mf'), 'foreign instance');
    await writeFile(
      path.join(foreign, '.printfarmer-retarget-owner.json'),
      JSON.stringify({
        schemaVersion: 1,
        instanceId: foreignId,
        pid: foreignPid,
      }),
    );

    const realKill = process.kill.bind(process);
    const probed: number[] = [];
    const spy = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid: number, signal?: string | number) => {
        if (pid !== foreignPid) return realKill(pid, signal);
        probed.push(pid);
        const error: NodeJS.ErrnoException = new Error(`kill ${code}`);
        error.code = code;
        throw error;
      });

    try {
      const { service } = await fixture({ tempPath: root });
      await service.disposeAll();
    } finally {
      spy.mockRestore();
    }

    const survived = await access(foreign).then(
      () => true,
      () => false,
    );
    return { survived, consulted: probed.length };
  }

  it('spares a temp root whose owner is live but owned by another user', async () => {
    // `process.kill(pid, 0)` raising EPERM means the process EXISTS and belongs
    // to someone else. Treating that as dead reclaims a live instance's temp
    // root — the #229/#330/#349 hazard through the one branch those issues
    // never covered. Origin: #459.
    const result = await sweepForeignOwnedRoot('EPERM');

    expect(result.consulted).toBeGreaterThan(0);
    expect(result.survived).toBe(true);
  });

  it('reclaims the same root when the owner is genuinely gone — the control', async () => {
    // Identical layout and pid; only the raised code differs. Without this the
    // assertion above would also pass if the sweep never considered the
    // directory at all, and absence of deletion would prove nothing.
    const result = await sweepForeignOwnedRoot('ESRCH');

    expect(result.consulted).toBeGreaterThan(0);
    expect(result.survived).toBe(false);
  });
});
