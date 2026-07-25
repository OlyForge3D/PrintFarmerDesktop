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

async function createService() {
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
