// @vitest-environment node

/**
 * Calibration diagnostics collector (issue #159).
 *
 * The acceptance criterion is that capability health, outbox depth, conflict
 * count and the last sync outcome are queryable without a secret in the output.
 * The redaction claims here are paired with controls in
 * `tests/calibrationRedaction.test.ts`, which drives the real HTTP path; this
 * file covers the collector's own behaviour.
 */

import { describe, expect, it } from 'vitest';
import {
  CalibrationDiagnosticsStore,
  formatCalibrationDiagnostics,
} from '../src/main/calibrationDiagnostics.js';
import { RemoteCalibrationCapabilities } from '../src/main/calibrationWire.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

/** Parsed through the real wire schema, so the shape is the production one. */
function capabilities(): ReturnType<
  typeof RemoteCalibrationCapabilities.parse
> {
  return RemoteCalibrationCapabilities.parse({
    apiContractVersion: '1.4',
    calibrationApiVersion: '2026-07-01',
    calibrationSchemaVersion: '7',
    calibrationPersistenceEnabled: true,
    calibrationSyncEnabled: true,
    calibrationPhotosEnabled: true,
    calibrationGenerationEnabled: true,
    supportedFirmwareFamilies: ['Klipper'],
    supportedGcodeDialects: ['Klipper'],
    supportedSlicerEngines: [],
    effectivePermissions: ['calibration:read', 'calibration:write'],
  });
}

function store(): CalibrationDiagnosticsStore {
  let tick = 0;
  return new CalibrationDiagnosticsStore(() => {
    tick += 1;
    return new Date(Date.UTC(2026, 7, 3, 22, 0, tick));
  });
}

const outbox = {
  countCalibrationPendingOperations: () => Promise.resolve(4),
  listCalibrationConflicts: () => Promise.resolve([{}, {}]),
};

describe('CalibrationDiagnosticsStore', () => {
  it('reports nothing observed before calibration has negotiated or synced', async () => {
    const diagnostics = await store().collect({ profileId: PROFILE_ID });
    expect(diagnostics.capability).toBeNull();
    expect(diagnostics.lastSync).toBeNull();
    expect(diagnostics.report).toContain('not observed since app start');
  });

  it('reports negotiated versions, flags and granted scopes after negotiation', async () => {
    const subject = store();
    subject.recordCapabilities(capabilities());
    const diagnostics = await subject.collect({ profileId: PROFILE_ID });
    expect(diagnostics.capability).not.toBeNull();
    expect(diagnostics.capability?.negotiatedApiVersion).toBe('2026-07-01');
    expect(diagnostics.capability?.negotiatedSchemaVersion).toBe('7');
    expect(diagnostics.capability?.apiContractVersion).toBe('1.4');
    expect(diagnostics.capability?.grantedScopes).toEqual([
      'calibration:read',
      'calibration:write',
    ]);
    expect(diagnostics.capability?.flags.calibrationGenerationEnabled).toBe(
      true,
    );
  });

  it('reports pending outbox depth and unresolved conflict count', async () => {
    const diagnostics = await store().collect({
      profileId: PROFILE_ID,
      outbox,
    });
    expect(diagnostics.outbox).toEqual({
      pendingOperationCount: 4,
      unresolvedConflictCount: 2,
    });
  });

  it('reports the last sync outcome, time, typed code and correlation ID', async () => {
    const subject = store();
    subject.recordSyncOutcome({
      outcome: 'failed',
      errorCode: 'revisionConflict',
      correlationId: 'corr-42',
    });
    const diagnostics = await subject.collect({ profileId: PROFILE_ID });
    expect(diagnostics.lastSync?.outcome).toBe('failed');
    expect(diagnostics.lastSync?.errorCode).toBe('revisionConflict');
    expect(diagnostics.lastSync?.correlationId).toBe('corr-42');
    expect(Date.parse(diagnostics.lastSync?.at ?? '')).not.toBeNaN();
  });

  it('keeps only the most recent sync outcome', async () => {
    const subject = store();
    subject.recordSyncOutcome({ outcome: 'failed', errorCode: 'server' });
    subject.recordSyncOutcome({ outcome: 'ok', correlationId: 'corr-2' });
    const diagnostics = await subject.collect({ profileId: PROFILE_ID });
    expect(diagnostics.lastSync?.outcome).toBe('ok');
    expect(diagnostics.lastSync?.errorCode).toBeNull();
  });

  it('still answers when the outbox read throws, because a broken system is when it is needed', async () => {
    const diagnostics = await store().collect({
      profileId: PROFILE_ID,
      outbox: {
        countCalibrationPendingOperations: () =>
          Promise.reject(new Error('sidecar down')),
        listCalibrationConflicts: () => Promise.resolve([]),
      },
    });
    expect(diagnostics.outbox).toBeNull();
    expect(diagnostics.report).toContain('unavailable');
  });

  it('answers with a null profile rather than throwing when none is selected', async () => {
    const diagnostics = await store().collect({ profileId: null, outbox });
    expect(diagnostics.profileId).toBeNull();
    expect(diagnostics.outbox).toBeNull();
    expect(diagnostics.report).toContain('none selected');
  });
});

describe('diagnostics report text', () => {
  it('names every field a runbook will tell an operator to read', async () => {
    const subject = store();
    subject.recordCapabilities(capabilities());
    subject.recordSyncOutcome({
      outcome: 'failed',
      errorCode: 'workerUnavailable',
      correlationId: 'corr-7',
    });
    const { report } = await subject.collect({ profileId: PROFILE_ID, outbox });
    for (const field of [
      'negotiatedApiVersion',
      'negotiatedSchemaVersion',
      'apiContractVersion',
      'grantedScopes',
      'pendingOperationCount',
      'unresolvedConflictCount',
      'outcome',
      'errorCode',
      'correlationId',
    ]) {
      expect(report).toContain(field);
    }
  });

  it('states the restart caveat in the output itself', async () => {
    const { report } = await store().collect({ profileId: PROFILE_ID });
    expect(report).toContain('reset when the app restarts');
  });

  it('renders a report even from an entirely empty snapshot', () => {
    const report = formatCalibrationDiagnostics({
      generatedAt: '2026-08-03T22:00:00.000Z',
      profileId: null,
      capability: null,
      outbox: null,
      lastSync: null,
      observedSinceAppStart: true,
    });
    expect(report.length).toBeGreaterThan(0);
    expect(report).toContain('PrintFarmer calibration diagnostics');
  });
});
