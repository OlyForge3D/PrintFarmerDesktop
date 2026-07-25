// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertExactCommitRef,
  assertSafeRelativePath,
  createManifest,
  downloadApprovedSnapshot,
  parsePreset,
  validateManifest,
  validatePresetClosure,
  verifyBundleDirectory,
  writeSnapshotBundle,
  type SnapshotEntry,
} from '../scripts/target-profile-tools.mjs';

const ref = '0123456789abcdef0123456789abcdef01234567';
const retrievedAt = '2026-07-24';
const targetPreset = 'Snapmaker U1 (0.4 nozzle)';

const localPresets = {
  'Snapmaker/filament/base.json': {
    type: 'filament',
    name: 'Local PLA base',
  },
  'Snapmaker/filament/u1.json': {
    type: 'filament',
    name: 'Local PLA @U1',
    inherits: 'Local PLA base',
    compatible_printers: [targetPreset],
  },
  'Snapmaker/machine/base.json': {
    type: 'machine',
    name: 'Local machine base',
  },
  'Snapmaker/machine/model.json': {
    type: 'machine_model',
    name: 'Snapmaker U1',
  },
  'Snapmaker/machine/u1.json': {
    type: 'machine',
    name: targetPreset,
    inherits: 'Local machine base',
    printer_model: 'Snapmaker U1',
    printer_variant: '0.4',
  },
  'Snapmaker/process/base.json': {
    type: 'process',
    name: 'Local process base',
  },
  'Snapmaker/process/u1.json': {
    type: 'process',
    name: 'Local quality @U1',
    inherits: 'Local process base',
    compatible_printers: [targetPreset],
  },
} as const;

const approvedPaths = Object.keys(localPresets).sort();
const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

function bytesFor(value: object): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function localEntries(): SnapshotEntry[] {
  return approvedPaths.map((upstreamPath) => {
    const bytes = bytesFor(
      localPresets[upstreamPath as keyof typeof localPresets],
    );
    return {
      upstreamPath,
      bytes,
      preset: parsePreset(bytes, upstreamPath),
    };
  });
}

function mockGitHubFetch(
  overrides: Partial<Record<string, object>> = {},
): typeof fetch {
  return vi.fn<typeof fetch>((input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.endsWith(`/commits/${ref}`)) {
      return Promise.resolve(Response.json({ sha: ref }));
    }
    if (url.includes('/contents?ref=')) {
      return Promise.resolve(
        Response.json([{ name: 'Snapmaker.json' }, { name: 'Snapmaker' }]),
      );
    }
    const marker = `/${ref}/`;
    const markerIndex = url.indexOf(marker);
    if (markerIndex === -1) {
      return Promise.resolve(new Response('unexpected URL', { status: 404 }));
    }
    const upstreamPath = decodeURIComponent(
      url.slice(markerIndex + marker.length),
    );
    const value =
      overrides[upstreamPath] ??
      localPresets[upstreamPath as keyof typeof localPresets];
    return Promise.resolve(
      value
        ? new Response(`${JSON.stringify(value, null, 2)}\n`, { status: 200 })
        : new Response('missing', { status: 404 }),
    );
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('target profile path and ref validation', () => {
  it('accepts only exact commits and normalized relative paths', () => {
    expect(assertExactCommitRef(ref)).toBe(ref);
    expect(() => assertExactCommitRef('development')).toThrow(
      'exact lowercase 40-character Git commit',
    );
    expect(assertSafeRelativePath('profiles/Snapmaker/u1.json')).toBe(
      'profiles/Snapmaker/u1.json',
    );
    expect(() => assertSafeRelativePath('../outside.json')).toThrow(
      'safe normalized relative path',
    );
    expect(() => assertSafeRelativePath('profiles\\outside.json')).toThrow(
      'safe normalized relative path',
    );
  });
});

describe('target profile updater helpers', () => {
  it('downloads only the reviewed paths with mocked GitHub responses', async () => {
    const fetchImpl = mockGitHubFetch();
    const snapshot = await downloadApprovedSnapshot({
      ref,
      retrievedAt,
      approvedPaths,
      fetchImpl,
    });

    expect(snapshot.entries.map((entry) => entry.upstreamPath)).toEqual(
      approvedPaths,
    );
    expect(snapshot.roots).toEqual([
      'Snapmaker/filament/u1.json',
      'Snapmaker/machine/model.json',
      'Snapmaker/machine/u1.json',
      'Snapmaker/process/u1.json',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(approvedPaths.length + 2);
  });

  it('rejects missing dependencies and unreachable extras', () => {
    const entries = localEntries();
    expect(() =>
      validatePresetClosure(
        entries.filter(
          (entry) => entry.upstreamPath !== 'Snapmaker/process/base.json',
        ),
      ),
    ).toThrow('inherits missing preset');

    const extraBytes = bytesFor({
      type: 'process',
      name: 'Unreviewed orphan',
    });
    expect(() =>
      validatePresetClosure([
        ...entries,
        {
          upstreamPath: 'Snapmaker/process/orphan.json',
          bytes: extraBytes,
          preset: parsePreset(extraBytes, 'Snapmaker/process/orphan.json'),
        },
      ]),
    ).toThrow('unreviewed or unreachable extras');
  });

  it('rejects an upstream top-level license status change', async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith(`/commits/${ref}`)) {
        return Promise.resolve(Response.json({ sha: ref }));
      }
      return Promise.resolve(
        Response.json([{ name: 'Snapmaker.json' }, { name: 'LICENSE' }]),
      );
    });

    await expect(
      downloadApprovedSnapshot({
        ref,
        retrievedAt,
        approvedPaths,
        fetchImpl,
      }),
    ).rejects.toThrow('requires explicit provenance review');
  });
});

describe('target profile manifest and offline verifier', () => {
  it('writes and verifies a complete local bundle without network access', async () => {
    const bundleDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'target-profile-test-'),
    );
    temporaryDirectories.push(bundleDirectory);
    const entries = localEntries();
    const roots = validatePresetClosure(entries);
    await writeSnapshotBundle(bundleDirectory, {
      ref,
      retrievedAt,
      entries,
      roots,
    });

    await expect(verifyBundleDirectory(bundleDirectory)).rejects.toThrow(
      'reviewed path allowlist',
    );
    const manifest = await verifyBundleDirectory(
      bundleDirectory,
      approvedPaths,
    );
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      bundleId: 'snapmaker-u1-orca-presets',
      upstream: { commit: ref, retrievedAt },
      updatePolicy: { runtimeNetworkFetch: false },
    });
  });

  it('rejects unsafe manifest paths and tampered profile bytes', async () => {
    const entries = localEntries();
    const roots = validatePresetClosure(entries);
    const manifest = createManifest({ ref, retrievedAt, entries, roots });
    const unsafeManifest = structuredClone(manifest);
    const unsafeFiles = unsafeManifest.files as Array<Record<string, unknown>>;
    const unsafeFile = unsafeFiles[0];
    if (!unsafeFile) {
      throw new Error('test manifest must contain a file');
    }
    unsafeFile.path = '../outside.json';
    expect(() => validateManifest(unsafeManifest)).toThrow(
      'safe normalized relative path',
    );

    const bundleDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'target-profile-test-'),
    );
    temporaryDirectories.push(bundleDirectory);
    await writeSnapshotBundle(bundleDirectory, {
      ref,
      retrievedAt,
      entries,
      roots,
    });
    const manifestValue = JSON.parse(
      await readFile(path.join(bundleDirectory, 'manifest.json'), 'utf8'),
    ) as { files: Array<{ path: string }> };
    const firstPath = manifestValue.files[0]?.path;
    expect(firstPath).toBeDefined();
    await writeFile(
      path.join(bundleDirectory, ...(firstPath ?? '').split('/')),
      '{}\n',
    );
    await expect(
      verifyBundleDirectory(bundleDirectory, approvedPaths),
    ).rejects.toThrow('SHA-256 mismatch');
  });
});
