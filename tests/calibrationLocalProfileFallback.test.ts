/**
 * Regression coverage for the two ways calibration discovery could still leave
 * the operator with an unexplained empty screen.
 *
 * Both were found in review of the discovery-contract fix and are asserted here
 * against the production modules, not against restated intentions:
 *
 * 1. Local OrcaSlicer scanning must not be gated behind the server call. Bound
 *    discovery needs a server-supplied printer context and returns nothing
 *    without one, so when PrintFarmer refuses, an unbound scan is the only
 *    thing that can distinguish "the server is down" from "this machine has no
 *    OrcaSlicer profiles".
 * 2. An ineligible printer must be able to carry the server's reason codes
 *    across the IPC boundary, or it can be listed but never explained.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listLocalOrcaFilamentProfiles } from '../src/main/orcaProfileDiscovery.js';
import { CalibrationPrinterCandidate } from '@shared/ipc';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'pfd-orca-unbound-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function filamentProfile(name: string, material = 'PLA'): string {
  return JSON.stringify({
    type: 'filament',
    name,
    filament_type: [material],
    nozzle_temperature: ['210'],
  });
}

async function seedRoot(
  relative: string,
  names: readonly string[],
): Promise<string> {
  const root = path.join(sandbox, relative);
  const dir = path.join(root, 'Voron', 'filament');
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    await writeFile(path.join(dir, `${name}.json`), filamentProfile(name));
  }
  return root;
}

describe('unbound local OrcaSlicer profile listing', () => {
  it('lists installed profiles without any server printer context', async () => {
    // The whole point: no context, no candidate, no server involved at all.
    const systemRoot = await seedRoot('programfiles', [
      'Generic PLA @0.4 nozzle',
      'Generic PETG @0.4 nozzle',
    ]);

    const result = await listLocalOrcaFilamentProfiles({
      roots: { userRoots: [], systemRoots: [systemRoot] },
    });

    expect(result.installFound).toBe(true);
    expect(result.profiles.map((profile) => profile.name)).toEqual([
      'Generic PETG @0.4 nozzle',
      'Generic PLA @0.4 nozzle',
    ]);
    expect(result.profiles[0]!.source).toBe('systemInstall');
    expect(result.profiles[0]!.material).toBe('PLA');
  });

  it('separates a missing OrcaSlicer install from an install with no profiles', async () => {
    // These two states need different remedies — install OrcaSlicer, versus
    // work out why its profile directory is empty — so they must not collapse
    // into the same empty list.
    const absent = await listLocalOrcaFilamentProfiles({
      roots: {
        userRoots: [path.join(sandbox, 'nope-user')],
        systemRoots: [path.join(sandbox, 'nope-system')],
      },
    });
    expect(absent.installFound).toBe(false);
    expect(absent.profiles).toEqual([]);

    const emptyRoot = await seedRoot('empty-install', []);
    const empty = await listLocalOrcaFilamentProfiles({
      roots: { userRoots: [], systemRoots: [emptyRoot] },
    });
    expect(empty.installFound).toBe(true);
    expect(empty.profiles).toEqual([]);
  });

  it('discloses no filesystem paths in its results', async () => {
    const systemRoot = await seedRoot('programfiles', [
      'Generic PLA @0.4 nozzle',
    ]);

    const result = await listLocalOrcaFilamentProfiles({
      roots: { userRoots: [], systemRoots: [systemRoot] },
    });

    // The renderer needs to know a profile exists, not where it lives.
    const serialised = JSON.stringify(result.profiles);
    expect(serialised).not.toContain(sandbox);
    expect(serialised).not.toContain(path.sep === '\\' ? '\\\\' : '/');
    for (const profile of result.profiles) {
      expect(Object.keys(profile).sort()).toEqual([
        'material',
        'name',
        'source',
      ]);
    }
  });

  it('deduplicates a profile present in both the user and system roots', async () => {
    const userRoot = await seedRoot('appdata', ['Generic PLA @0.4 nozzle']);
    const systemRoot = await seedRoot('programfiles', [
      'Generic PLA @0.4 nozzle',
    ]);

    const result = await listLocalOrcaFilamentProfiles({
      roots: { userRoots: [userRoot], systemRoots: [systemRoot] },
    });

    expect(result.profiles).toHaveLength(1);
  });
});

describe('ineligible printers carry their reasons across IPC', () => {
  const base = {
    printerId: 'aaaaaaaa-1111-4111-8111-222222222222',
    displayName: 'Rack A cell 3',
    printerModel: null,
    orcaProfileId: null,
    isOnline: true,
    updatedAt: '2026-08-11T12:00:00.000Z',
  };

  it('accepts an ineligible printer with server reason codes', () => {
    const parsed = CalibrationPrinterCandidate.parse({
      ...base,
      firmwareCompatible: false,
      eligibility: null,
      rejectionReasonCodes: ['firmware_family_not_klipper'],
      missingInputs: ['slicer_engine'],
    });

    // Without these fields the printer could be listed but never explained.
    expect(parsed.rejectionReasonCodes).toEqual([
      'firmware_family_not_klipper',
    ]);
    expect(parsed.missingInputs).toEqual(['slicer_engine']);
  });

  it('refuses a printer that is both eligible and rejected', () => {
    // Contradictory input must not reach the renderer, which would otherwise
    // render the same printer as ready and as refused at once.
    expect(() =>
      CalibrationPrinterCandidate.parse({
        ...base,
        firmwareCompatible: true,
        eligibility: {
          firmwareFamily: 'Klipper',
          gcodeDialect: 'Klipper',
          slicerFamily: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerIdentity: 'OrcaSlicer',
          hardwareContextComplete: true,
          safetyContextComplete: true,
          permissionsComplete: true,
          reasons: [],
        },
        rejectionReasonCodes: ['firmware_family_not_klipper'],
        missingInputs: [],
      }),
    ).toThrow();
  });

  it('defaults both lists to empty so older callers stay valid', () => {
    const parsed = CalibrationPrinterCandidate.parse({
      ...base,
      firmwareCompatible: false,
      eligibility: null,
    });
    expect(parsed.rejectionReasonCodes).toEqual([]);
    expect(parsed.missingInputs).toEqual([]);
  });
});
