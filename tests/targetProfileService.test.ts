// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TargetProfileService } from '../src/main/targetProfiles.js';

const temporaryDirectories: string[] = [];
const bundledId =
  'snapmaker-u1-orca-presets:profiles/Snapmaker/process/standard.json';

function ok(value: unknown): unknown {
  return { status: 'ok', value };
}

function bundledSummary() {
  return {
    profileId: bundledId,
    displayName: '0.20 Standard @Snapmaker U1',
    rootPath: 'profiles/Snapmaker/process/standard.json',
    layerHeight: 0.2,
    category: 'generic',
    bundleCommit: 'a'.repeat(40),
  };
}

function bundledDetails() {
  return {
    ...bundledSummary(),
    settingCount: 12,
    settingsSummary: { layer_height: 0.2 },
    machine: { name: 'Snapmaker U1' },
    compatibleFilaments: [{ name: 'Snapmaker PLA @U1' }],
    profileHashes: { 'profiles/process.json': 'b'.repeat(64) },
  };
}

function importedDetails(bytes: Buffer) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    profileId: `imported:${sha256}`,
    sha256,
    machineName: 'Snapmaker U1 (0.4 nozzle)',
    processName: 'Imported standard',
    filamentNames: ['Snapmaker PLA @U1'],
    layerHeight: 0.2,
    settingCount: 50,
    capabilities: {
      nozzleCount: 4,
      maxFilamentSlots: 4,
      objectExclusion: true,
      motionGuardrails: true,
    },
  };
}

async function createService(maxProfileBytes?: number) {
  const userDataPath = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), 'u1-profiles-')),
  );
  temporaryDirectories.push(userDataPath);
  const inspectImportedRetargetProfile = vi.fn(async (file: string) =>
    ok(importedDetails(await readFile(file))),
  );
  const service = new TargetProfileService({
    userDataPath,
    now: () => 1234,
    ...(maxProfileBytes === undefined ? {} : { maxProfileBytes }),
    sidecar: {
      listRetargetProfiles: vi.fn(() =>
        Promise.resolve(ok([bundledSummary()])),
      ),
      inspectRetargetProfile: vi.fn(() =>
        Promise.resolve(ok(bundledDetails())),
      ),
      inspectImportedRetargetProfile,
    },
  });
  return { service, userDataPath, inspectImportedRetargetProfile };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('TargetProfileService', () => {
  it('rejects imports at the copy boundary before inspecting them', async () => {
    const { service, userDataPath, inspectImportedRetargetProfile } =
      await createService(8);
    await service.initialize();
    const source = path.join(userDataPath, 'oversized.3mf');
    await writeFile(source, 'ninebytes');

    await expect(service.importFile(source)).rejects.toThrow(
      'profileImportFailed',
    );
    expect(inspectImportedRetargetProfile).not.toHaveBeenCalled();
  });

  it('preserves native bundle-integrity failures for IPC', async () => {
    const userDataPath = await import('node:fs/promises').then(({ mkdtemp }) =>
      mkdtemp(path.join(os.tmpdir(), 'u1-profiles-')),
    );
    temporaryDirectories.push(userDataPath);
    const service = new TargetProfileService({
      userDataPath,
      sidecar: {
        listRetargetProfiles: vi.fn(() =>
          Promise.resolve({
            status: 'error',
            error: {
              code: 'profileHashMismatch',
              message: 'The bundled profile hash does not match.',
              action: 'Restore the application profile bundle.',
            },
          }),
        ),
        inspectRetargetProfile: vi.fn(),
        inspectImportedRetargetProfile: vi.fn(),
      },
    });

    await expect(service.initialize()).rejects.toMatchObject({
      failure: {
        domain: 'native',
        code: 'profileHashMismatch',
        message: 'The bundled profile hash does not match.',
        action: 'Restore the application profile bundle.',
        part: null,
        setting: null,
      },
    });
  });

  it('serializes concurrent imports at the combined catalog limit', async () => {
    const { service, userDataPath } = await createService();
    await service.initialize();
    const root = path.join(userDataPath, 'retarget', 'profiles', 'v1');
    const entries = Array.from({ length: 198 }, (_, index) => {
      const sha256 = index.toString(16).padStart(64, '0');
      return { id: `imported:${sha256}`, sha256, importedAt: index };
    });
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, entries }),
    );
    const first = path.join(userDataPath, 'capacity-reference-a.3mf');
    const second = path.join(userDataPath, 'capacity-reference-b.3mf');
    await writeFile(first, 'editable-capacity-reference-a');
    await writeFile(second, 'editable-capacity-reference-b');

    const outcomes = await Promise.allSettled([
      service.importFile(first),
      service.importFile(second),
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(
      (
        JSON.parse(
          await readFile(path.join(root, 'manifest.json'), 'utf8'),
        ) as {
          entries: unknown[];
        }
      ).entries,
    ).toHaveLength(199);
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: new Error('profileCatalogFull'),
    });
    expect(service.catalog().profiles.length).toBeLessThanOrEqual(200);

    const overflowSha = createHash('sha256')
      .update(await readFile(second))
      .digest('hex');
    const manifestPath = path.join(root, 'manifest.json');
    const overflowManifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as {
      schemaVersion: 1;
      entries: Array<{ id: string; sha256: string; importedAt: number }>;
    };
    overflowManifest.entries.push({
      id: `imported:${overflowSha}`,
      sha256: overflowSha,
      importedAt: 999,
    });
    await writeFile(manifestPath, JSON.stringify(overflowManifest));
    await expect(service.importFile(second)).rejects.toThrow(
      'profileCatalogFull',
    );
  });

  it('imports amended native details once and exposes no renderer path', async () => {
    const { service, userDataPath } = await createService();
    await service.initialize();
    const source = path.join(userDataPath, 'reference.3mf');
    await writeFile(source, 'editable-u1-reference');

    const first = await service.importFile(source);
    const second = await service.importFile(source);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.profile.source).toBe('imported');
    expect(first.profile).not.toHaveProperty('path');
    expect(service.getPrivateReference(first.profile.id)).toMatchObject({
      kind: 'imported',
      expectedSha256: first.profile.fingerprint,
    });
  });

  it('keeps bundled targets usable and reports a corrupt referenced import', async () => {
    const { service, userDataPath } = await createService();
    const sha256 = 'c'.repeat(64);
    const root = path.join(userDataPath, 'retarget', 'profiles', 'v1');
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: [{ id: `imported:${sha256}`, sha256, importedAt: 1 }],
      }),
    );

    const catalog = await service.refresh();

    expect(catalog.profiles.map((profile) => profile.id)).toEqual([bundledId]);
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]?.message).toContain('was excluded');
  });

  it('isolates a corrupt imported manifest from the bundled catalog', async () => {
    const { service, userDataPath } = await createService();
    const root = path.join(userDataPath, 'retarget', 'profiles', 'v1');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'manifest.json'), '{not-json');

    const catalog = await service.refresh();

    expect(catalog.profiles.map((profile) => profile.id)).toEqual([bundledId]);
    expect(catalog.warnings[0]?.message).toContain('manifest is corrupt');
  });
});
