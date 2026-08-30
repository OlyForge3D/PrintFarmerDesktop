// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilamentWizardStateStore } from '../src/main/calibrationFilamentWizardState';
import type { FilamentWizardStateRecord } from '../src/shared/ipc';

const temporaryDirectories: string[] = [];

async function temporaryStore(): Promise<FilamentWizardStateStore> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'printfarmer-filament-wizard-'),
  );
  temporaryDirectories.push(directory);
  return new FilamentWizardStateStore(directory);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function sampleRecord(): FilamentWizardStateRecord {
  return {
    schemaVersion: 1,
    printerId: 'printer-1',
    printerModelId: null,
    machineName: 'Voron 2.4 350',
    processName: '0.20mm Standard @Voron 2.4',
    baseFilamentName: 'PolyLite PLA Blue',
    baseFilamentGuid: '22222222-2222-4222-8222-222222222222',
    cloneId: '33333333-3333-4333-8333-333333333333',
    cloneName: 'PolyLite PLA Blue (calibration)',
    projectId: '44444444-4444-4444-8444-444444444444',
    completedMethods: ['flow_rate_pass_1'],
    currentMethod: 'temperature_tower',
    inFlightJob: {
      jobId: 'job-1',
      method: 'temperature_tower',
      submittedAt: '2026-01-01T00:00:00.000Z',
      pollAttempt: 3,
      lastStatus: 'Processing',
    },
    draftObservationFailures: [],
    phase: 'pollingSlice',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('filament calibration wizard restart-resilience store (issue #754)', () => {
  it('returns null for a profile with no persisted state', async () => {
    const store = await temporaryStore();
    await expect(store.read(PROFILE_ID)).resolves.toBeNull();
  });

  it('round-trips a written record', async () => {
    const store = await temporaryStore();
    const record = sampleRecord();
    await store.write(PROFILE_ID, record);

    await expect(store.read(PROFILE_ID)).resolves.toEqual(record);
  });

  it('overwrites the previous record for the same profile', async () => {
    const store = await temporaryStore();
    await store.write(PROFILE_ID, sampleRecord());
    const updated: FilamentWizardStateRecord = {
      ...sampleRecord(),
      phase: 'sliceReady',
      currentMethod: 'flow_rate_pass_1',
      completedMethods: ['flow_rate_pass_1', 'temperature_tower'],
    };
    await store.write(PROFILE_ID, updated);

    await expect(store.read(PROFILE_ID)).resolves.toEqual(updated);
  });

  it('keeps separate profiles independent', async () => {
    const store = await temporaryStore();
    const otherProfileId = '44444444-4444-4444-8444-444444444444';
    await store.write(PROFILE_ID, sampleRecord());

    await expect(store.read(otherProfileId)).resolves.toBeNull();
    await expect(store.read(PROFILE_ID)).resolves.toEqual(sampleRecord());
  });

  it('clears a persisted record and reports whether one existed', async () => {
    const store = await temporaryStore();
    await store.write(PROFILE_ID, sampleRecord());

    await expect(store.clear(PROFILE_ID)).resolves.toBe(true);
    await expect(store.read(PROFILE_ID)).resolves.toBeNull();
    await expect(store.clear(PROFILE_ID)).resolves.toBe(false);
  });

  it('self-heals a corrupt file by treating it as absent and removing it', async () => {
    const store = await temporaryStore();
    await store.write(PROFILE_ID, sampleRecord());
    const filePath = path.join(store.directory, `${PROFILE_ID}.json`);
    await writeFile(filePath, '{ not json', 'utf8');

    await expect(store.read(PROFILE_ID)).resolves.toBeNull();
    await expect(readFile(filePath, 'utf8')).rejects.toThrow();
  });

  it('self-heals a file that no longer matches the schema', async () => {
    const store = await temporaryStore();
    await store.write(PROFILE_ID, sampleRecord());
    const filePath = path.join(store.directory, `${PROFILE_ID}.json`);
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 1, phase: 'not-a-real-phase' }),
      'utf8',
    );

    await expect(store.read(PROFILE_ID)).resolves.toBeNull();
    await expect(readFile(filePath, 'utf8')).rejects.toThrow();
  });

  it('rejects a non-UUID profile id rather than writing an arbitrary file name', async () => {
    const store = await temporaryStore();
    await expect(store.write('../outside', sampleRecord())).rejects.toThrow(
      'UUID',
    );
    await expect(store.read('../outside')).rejects.toThrow('UUID');
    await expect(store.clear('../outside')).rejects.toThrow('UUID');
  });

  it('rejects a record that violates the schema (extra unknown key)', async () => {
    const store = await temporaryStore();
    const invalid = { ...sampleRecord(), extra: 'field' };
    await expect(
      store.write(PROFILE_ID, invalid as unknown as FilamentWizardStateRecord),
    ).rejects.toThrow();
  });

  it('serializes overlapping writes for the same profile instead of racing on a shared temp file', async () => {
    // Regression coverage for a review finding on issue #754: the renderer
    // fires saves fire-and-forget on every meaningful state change, so two
    // writes for the same profile can be in flight at once. Before the fix,
    // both writes shared one `${filePath}.${pid}.tmp` name and could race on
    // rename (ENOENT, or a dropped bookmark). Firing many overlapping writes
    // concurrently must neither throw nor leave a torn/missing file — and
    // the last write to be *issued* must be what ends up persisted, since
    // writes for one profile are serialized in call order.
    const store = await temporaryStore();
    const attempts = Array.from({ length: 8 }, (_, index) => ({
      ...sampleRecord(),
      currentMethod: 'flow_rate_pass_1' as const,
      inFlightJob: {
        jobId: `job-${index}`,
        method: 'flow_rate_pass_1' as const,
        submittedAt: '2026-01-01T00:00:00.000Z',
        pollAttempt: index,
        lastStatus: 'Processing' as const,
      },
    }));

    await Promise.all(
      attempts.map((record) => store.write(PROFILE_ID, record)),
    );

    const finalRecord = await store.read(PROFILE_ID);
    expect(finalRecord).not.toBeNull();
    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt === undefined) throw new Error('unreachable');
    // Whichever write was issued last (Promise.all preserves call order for
    // .then chaining through the queue) is the one left on disk.
    expect(finalRecord?.inFlightJob?.jobId).toBe(
      lastAttempt.inFlightJob?.jobId,
    );
  });
});
