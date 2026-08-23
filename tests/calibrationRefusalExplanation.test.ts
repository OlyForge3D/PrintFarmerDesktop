/**
 * The refusal-explanation path: what an operator is told when PrintFarmer
 * refuses to calibrate a printer.
 *
 * PrintFarmer explains every refusal — a code per unmet precondition — and the
 * desktop app carries those codes to the renderer. The wizard used to read none
 * of them, showing one sentence about incomplete canonical eligibility that was
 * equally true of an offline printer, an unidentified firmware and an unset
 * slicer engine. It named no field, so it left nothing to fix and nothing to
 * report.
 *
 * The assertions here are therefore about *specificity*, not about the presence
 * of an error: a test that merely found some refusal text would have passed
 * against the sentence this change removes.
 */

import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_EXPLANATION_TRUNCATED_CODE,
  CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE,
  CALIBRATION_REJECTION_REASON_CODES,
  CALIBRATION_SERVER_CONTRADICTION_CODE,
  CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
  UNRECOGNIZED_CALIBRATION_INPUT,
  UNRECOGNIZED_CALIBRATION_REASON_CODE,
  type CalibrationPrinterCandidate,
  type CalibrationRejectionReasonCode,
} from '../src/shared/ipc';
import { candidateEligibilityBlockers } from '../src/renderer/calibration/projectEligibility';
import { contextEligibilityBlockers } from '../src/renderer/calibration/projectEligibility';
import type { CalibrationPrinterContext } from '../src/shared/ipc';

const CONTEXT_PRINTER_ID = 'aaaaaaaa-1111-4111-8111-222222222222';

/**
 * A context PrintFarmer refused, complete in every field this client checks
 * itself.
 *
 * Deliberately structurally complete: it isolates the property under test. A
 * context missing identities would produce blockers from the structural checks
 * whether or not the server's reasons were read, so the assertions could not
 * tell the two apart.
 */
function refusedContext(
  overrides: Partial<CalibrationPrinterContext> = {},
): CalibrationPrinterContext {
  return {
    printerId: CONTEXT_PRINTER_ID,
    displayName: 'x400',
    printerModel: null,
    firmware: {
      firmware: 'Klipper',
      gcodeDialect: 'Klipper',
      firmwareVersion: 'v0.12.0',
      klipperConfigHash: null,
    },
    orcaProfileId: 'cccccccc-1111-4111-8111-222222222222',
    orcaProfileDisplayName: 'Upstream PLA',
    bedWidthMm: 220,
    bedDepthMm: 220,
    nozzleDiameterMm: 0.4,
    snapshotAt: '2026-08-15T15:00:00.000Z',
    evaluationScope: 'full',
    isCurrent: true,
    configurationId: CONTEXT_PRINTER_ID,
    configurationRevision: 7,
    snapshotId: 'snapshot-7',
    snapshotRevision: 7,
    slicerIdentity: 'OrcaSlicer',
    slicerDistribution: 'upstream',
    profileRevision: 'filament-r7',
    profileIdentities: {
      machine: {
        backendProfileId: 'dddddddd-2222-4222-8222-333333333333',
        orcaProfileName: 'x400 0.4 nozzle',
        profileRevision: 'machine-r7',
        contentHash: 'b'.repeat(64),
      },
      process: {
        backendProfileId: 'dddddddd-3333-4333-8333-444444444444',
        orcaProfileName: '0.20 mm Standard',
        profileRevision: 'process-r7',
        contentHash: 'c'.repeat(64),
      },
      filament: {
        backendProfileId: 'cccccccc-1111-4111-8111-222222222222',
        orcaProfileName: 'Upstream PLA',
        profileRevision: 'filament-r7',
        contentHash: 'd'.repeat(64),
      },
    },
    contentHash: 'd'.repeat(64),
    toolheads: [
      {
        toolId: 'tool-a',
        toolheadId: 'head-a',
        extruderType: 'directDrive',
        nozzle: { id: 'nozzle-a', diameterMm: 0.4, material: 'hardened steel' },
      },
    ],
    safety: {
      buildVolumeMm: { x: 220, y: 220, z: 250 },
      maximumNozzleTemperatureC: 300,
      maximumBedTemperatureC: 120,
      maximumVolumetricRateMm3S: 25,
      emergencyStopAvailable: false,
      thermalProtectionConfirmed: false,
      ventilationAssessed: false,
    },
    permissions: null,
    rejectionReasonCodes: [],
    missingInputs: [],
    ...overrides,
  };
}
import {
  describeMissingInputs,
  describeRejectionReasonCode,
} from '../src/renderer/calibration/refusalMessages';

const EVERY_CODE: readonly CalibrationRejectionReasonCode[] = [
  ...CALIBRATION_REJECTION_REASON_CODES,
  UNRECOGNIZED_CALIBRATION_REASON_CODE,
  CALIBRATION_SERVER_CONTRADICTION_CODE,
  CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
  CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE,
  CALIBRATION_EXPLANATION_TRUNCATED_CODE,
];

function refusedCandidate(
  overrides: Partial<CalibrationPrinterCandidate> = {},
): CalibrationPrinterCandidate {
  return {
    printerId: 'aaaaaaaa-1111-4111-8111-222222222222',
    displayName: 'x400',
    printerModel: null,
    printerModelId: null,
    firmwareCompatible: false,
    orcaProfileId: null,
    isOnline: true,
    updatedAt: '2026-08-15T15:00:00.000Z',
    evaluationScope: 'preliminary',
    rejectionReasonCodes: ['slicer_engine_missing'],
    missingInputs: [],
    eligibility: null,
    ...overrides,
  };
}

describe('refusal wording', () => {
  it('has a distinct sentence for every code the renderer can receive', () => {
    const messages = EVERY_CODE.map(describeRejectionReasonCode);
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
    }
    // Distinctness is the property that matters. A map that compiled but
    // repeated one sentence would restore exactly the failure being removed:
    // every refusal reading the same, so none of them naming anything.
    expect(new Set(messages).size).toBe(EVERY_CODE.length);
  });

  it('says which fields PrintFarmer is still waiting on', () => {
    expect(describeMissingInputs([])).toBeNull();
    expect(describeMissingInputs(['slicer.engine', 'firmware.version'])).toBe(
      'PrintFarmer is still waiting on: slicer.engine, firmware.version.',
    );
  });

  it('admits when a field name could not be carried', () => {
    // The server named an input this client could not represent. Reporting
    // nothing would present a lossy list as the whole account.
    expect(
      describeMissingInputs(['slicer.engine', UNRECOGNIZED_CALIBRATION_INPUT]),
    ).toBe(
      'PrintFarmer is still waiting on: slicer.engine (and 1 further field this app could not name).',
    );
    expect(describeMissingInputs([UNRECOGNIZED_CALIBRATION_INPUT])).toMatch(
      /named 1 further required field/,
    );
  });
});

describe('candidate eligibility blockers', () => {
  it("reads out the server's reasons rather than a generic refusal", () => {
    const blockers = candidateEligibilityBlockers(
      refusedCandidate({
        rejectionReasonCodes: [
          'slicer_engine_missing',
          'firmware_identity_unverified',
        ],
        missingInputs: ['slicer.engine'],
      }),
    );
    expect(blockers).toEqual([
      describeRejectionReasonCode('slicer_engine_missing'),
      describeRejectionReasonCode('firmware_identity_unverified'),
      'PrintFarmer is still waiting on: slicer.engine.',
    ]);
    expect(blockers.join(' ')).not.toMatch(/canonical Klipper/);
  });

  it('still refuses, and still explains, when the reason list is empty', () => {
    // Unreachable through the IPC handler, which guarantees a code for every
    // refused printer. Asserted anyway: an empty blocker list reads as
    // "eligible", which is the one meaning it must never carry.
    const blockers = candidateEligibilityBlockers(
      refusedCandidate({ rejectionReasonCodes: [], missingInputs: [] }),
    );
    expect(blockers.length).toBeGreaterThan(0);
  });

  it('names offline separately from the refusal itself', () => {
    const blockers = candidateEligibilityBlockers(
      refusedCandidate({ isOnline: false }),
    );
    expect(blockers).toContain(
      describeRejectionReasonCode('slicer_engine_missing'),
    );
    expect(blockers).toContain(
      'The printer is offline, so current context cannot be verified.',
    );
  });

  it('blocks an eligible-but-offline printer without inventing a reason', () => {
    const blockers = candidateEligibilityBlockers(
      refusedCandidate({
        isOnline: false,
        firmwareCompatible: true,
        rejectionReasonCodes: [],
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
      }),
    );
    expect(blockers).toEqual([
      'The printer is offline, so current context cannot be verified.',
    ]);
  });

  it('reports a self-contradicting server as a server defect', () => {
    // The remedy differs from every hardware reason above it: nothing on the
    // printer will fix a server that grants and refuses eligibility at once, so
    // the wording must send the operator to a bug report instead of a setting.
    const blockers = candidateEligibilityBlockers(
      refusedCandidate({
        rejectionReasonCodes: [CALIBRATION_SERVER_CONTRADICTION_CODE],
      }),
    );
    expect(blockers[0]).toMatch(/server defect/);
  });
});

describe('context eligibility blockers', () => {
  it("reads out the server's profile-level reasons", () => {
    // The refusal reached only after a printer is selected. The structural
    // checks can say a profile identity is absent; only the server can say the
    // machine profile belongs to another printer, and that is the sentence an
    // operator can act on.
    const blockers = contextEligibilityBlockers(
      refusedContext({
        rejectionReasonCodes: ['profile_printer_mismatch'],
        missingInputs: ['profiles.machine.exactJson'],
      }),
      refusedCandidate({ printerId: CONTEXT_PRINTER_ID }),
    );
    expect(blockers).toContain(
      describeRejectionReasonCode('profile_printer_mismatch'),
    );
    expect(blockers).toContain(
      'PrintFarmer is still waiting on: profiles.machine.exactJson.',
    );
  });

  it('keeps its own structural checks alongside them', () => {
    // The two catch different refusals: a server that returns a coherent but
    // stale snapshot raises no reason at all, so dropping these in favour of
    // the server's list would lose the refusal entirely.
    const blockers = contextEligibilityBlockers(
      refusedContext({ rejectionReasonCodes: [], isCurrent: false }),
      refusedCandidate({ printerId: CONTEXT_PRINTER_ID }),
    );
    expect(blockers).toContain(
      'The printer context is stale. Refresh it before creation.',
    );
  });
});
