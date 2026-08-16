/**
 * Traversal-scale regression for local OrcaSlicer profile discovery.
 *
 * The shipped 0.1.0-beta.3 build capped discovery at 500 files using one
 * counter shared across the whole recursive walk. On a stock Windows install
 * (~12,000 profile JSON files under the OrcaSlicer resources directory) the
 * walk was exhausted inside the first few vendor directories — Afinia, Anker,
 * Anycubic and part of Artillery — and never reached BBL, Voron,
 * OrcaFilamentLibrary or anything else later in the alphabet. Any profile past
 * that point was invisible no matter what the caller asked for.
 *
 * These tests seed a realistic vendor tree with more than 500 decoys and place
 * the requested profile deliberately late in traversal order, which is exactly
 * the shape that failed in production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverLocalOrcaFilamentProfilesEntries } from '../src/main/orcaProfileDiscovery.js';
import { RemoteCalibrationPrinterContext } from '../src/main/calibrationWire.js';

// Runs in 842ms standalone but has timed out under full-suite parallel
// scheduling contention (issue #734) -- the slow path there is contention
// for a worker, not the traversal itself. 15000ms is >17x the standalone
// runtime, ample headroom for scheduling variance without masking a real
// regression (option 2 from #734: a targeted per-file override, not a
// blanket global increase).
vi.setConfig({ testTimeout: 15000 });

const TARGET_PROFILE_NAME = 'Voron Generic PLA @0.4 nozzle';

/** Vendor directory sizes mirroring a real OrcaSlicer resources tree. */
const DECOY_VENDORS: ReadonlyArray<readonly [string, number]> = [
  ['Afinia', 40],
  ['Anker', 95],
  ['Anycubic', 308],
  ['Artillery', 120],
  ['BBL', 60],
];

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'pfd-orca-scale-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function filamentProfile(name: string): string {
  return JSON.stringify({
    type: 'filament',
    name,
    filament_type: ['PLA'],
    nozzle_temperature: ['210'],
  });
}

/**
 * Seed a vendor tree with `DECOY_VENDORS` decoys, then place the target in a
 * vendor directory that sorts after every decoy.
 */
async function seedLargeSystemRoot(): Promise<string> {
  const root = path.join(
    sandbox,
    'programfiles',
    'OrcaSlicer',
    'resources',
    'profiles',
  );
  let total = 0;
  for (const [vendor, count] of DECOY_VENDORS) {
    const dir = path.join(root, vendor, 'filament');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < count; i += 1) {
      const name = `${vendor} Decoy ${String(i).padStart(4, '0')} @0.4 nozzle`;
      await writeFile(path.join(dir, `${name}.json`), filamentProfile(name));
      total += 1;
    }
  }
  expect(
    total,
    'the decoy set must exceed the old 500-file cap or this proves nothing',
  ).toBeGreaterThan(500);

  // 'Voron' sorts after every decoy vendor, so the target is only reachable if
  // traversal is not truncated by position.
  const targetDir = path.join(root, 'Voron', 'filament');
  await mkdir(targetDir, { recursive: true });
  await writeFile(
    path.join(targetDir, `${TARGET_PROFILE_NAME}.json`),
    filamentProfile(TARGET_PROFILE_NAME),
  );
  return root;
}

function contextForTarget(profileName: string) {
  return RemoteCalibrationPrinterContext.parse({
    id: 'aaaaaaaa-5ca1-4111-8111-222222222222',
    name: 'Voron 2.4',
    enabled: true,
    configurationRevision: 3,
    reachability: 'online',
    operationalState: 'idle',
    observedAtUtc: '2026-08-11T12:00:00.000Z',
    isStale: false,
    firmware: {
      family: 'Klipper',
      gcodeDialect: 'Klipper',
      detectionSource: 'moonraker',
      version: null,
      verified: true,
    },
    slicer: {
      engine: 'OrcaSlicer',
      distribution: 'upstream',
      version: '2.4.2',
      profileFormat: 'orca-json',
    },
    eligible: true,
    missingInputs: [],
    rejectionReasons: [],
    schemaVersion: '1.0',
    snapshotSha256: 'd'.repeat(64),
    capturedAtUtc: '2026-08-11T12:00:00.000Z',
    capturedBySubject: 'scale-subject',
    snapshot: {
      schemaVersion: '1.0',
      printerId: 'aaaaaaaa-5ca1-4111-8111-222222222222',
      configurationRevision: 3,
      capturedAtUtc: '2026-08-11T12:00:00.000Z',
      buildVolume: { x: 350, y: 350, z: 340 },
      toolheads: [
        {
          id: 'dddddddd-5ca1-4111-8111-222222222222',
          index: 0,
          isPrimary: true,
          nozzleDiameter: 0.4,
          nozzleMaterial: 'brass',
          isDirectDrive: true,
        },
      ],
      profiles: {
        machine: null,
        process: null,
        filament: {
          id: 'cccccccc-5ca1-4111-8111-222222222222',
          kind: 'filament',
          name: profileName,
          slicerType: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerVersion: '2.4.2',
          profileFormat: 'orca-json',
          profileRevision: 'scale-r1',
          sha256: null,
        },
      },
      baselineSettings: { activeNozzleDiameter: 0.4 },
      snapshotSha256: 'd'.repeat(64),
    },
  });
}

describe('local Orca discovery at real install scale', () => {
  it('finds a profile that sorts after more than 500 decoy files', async () => {
    const systemRoot = await seedLargeSystemRoot();

    const entries = await discoverLocalOrcaFilamentProfilesEntries(
      contextForTarget(TARGET_PROFILE_NAME),
      { roots: { userRoots: [], systemRoots: [systemRoot] } },
    );

    // Under the old shared-counter cap this was empty: traversal never left
    // the Anycubic/Artillery range.
    expect(entries.map((entry) => entry.orcaProfileId)).toEqual([
      TARGET_PROFILE_NAME,
    ]);
    expect(entries[0]!.source).toBe('systemInstall');
  });

  it('still returns nothing when the requested profile is genuinely absent', async () => {
    const systemRoot = await seedLargeSystemRoot();

    const entries = await discoverLocalOrcaFilamentProfilesEntries(
      contextForTarget('Profile That Was Never Installed'),
      { roots: { userRoots: [], systemRoots: [systemRoot] } },
    );

    // Scale must not turn into false positives: a miss is still a miss.
    expect(entries).toEqual([]);
  });

  it('reports no profiles when the OrcaSlicer roots do not exist', async () => {
    const entries = await discoverLocalOrcaFilamentProfilesEntries(
      contextForTarget(TARGET_PROFILE_NAME),
      {
        roots: {
          userRoots: [path.join(sandbox, 'absent-user')],
          systemRoots: [path.join(sandbox, 'absent-system')],
        },
      },
    );

    expect(entries).toEqual([]);
  });
});
