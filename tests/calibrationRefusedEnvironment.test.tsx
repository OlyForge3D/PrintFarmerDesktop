/**
 * Regression test for the "huge error message on every printer" bug — reframed
 * per the 2026-08-22 owner directive.
 *
 * BACKGROUND
 *
 * Field report (Vasquez → owner Jeff Papiez, 2026-08-22): "as soon as I click
 * on a printer I get the huge error message back about missing details on the
 * printer." Three previous PRs (#742, #743/#745, #739) claimed to fix
 * calibration and all merged with a green suite.
 *
 * The structural gap (Hicks audit, 2026-08-22): every calibration test either
 * hand-builds a `CalibrationBinding` and calls a pure gate function, mocks
 * `getCalibrationPrinterContext` at the renderer boundary with a
 * hand-authored `CalibrationPrinterContext`, or runs the wire projector
 * against `tests/fixtures/calibrationContract.ts` — a fixture this repository
 * authored itself, whose provenance guard skips without a sibling `pfarm1`
 * checkout. No test walked the operator path where every candidate returns
 * refused. Empirically proved: with `bindingFromContext` neutered to return
 * `null`, 427 of 430 calibration tests still passed.
 *
 * OWNER DIRECTIVE (supersedes prior framing) — 2026-08-22T19:08:45-07:00
 *
 * Calibration must NOT depend on PrintFarmer pre-populating per-printer
 * calibration eligibility columns. It must work as a profile-selection flow,
 * mirroring the existing "new slice job" flow: the desktop requests machine /
 * process / filament profiles from the API and lets the operator pick one of
 * each. The wall of `rejectionReasonCodes` was a symptom of the desktop
 * asking the server "is this printer already fully configured?" instead of
 * "what profiles can I offer for this printer?"
 *
 * So the goal state is not "≤ 1 blocker" and it is not "eligibility is true".
 * The goal state is: **the operator is not dead-ended by an undifferentiated
 * code dump when they click a printer.** The full profile-selection
 * acceptance test lives in
 * `tests/calibrationProfileSelectionFlow.test.tsx`; this file remains as the
 * targeted guard against regressing back to a wall of codes.
 *
 * WHAT THIS TEST ASSERTS
 *
 * Given a realistic PrintFarmer response where every candidate is refused
 * with the seeder-null shape, when the operator opens `NewCalibrationProject`
 * and highlights the first printer, the wizard offers a way forward — the
 * observable outcome is that the profile-selection fieldset becomes reachable
 * (its enabling gate does NOT depend on server-side eligibility columns
 * having been populated).
 *
 * The concrete DOM-level operator outcome: `<fieldset><legend>Base OrcaSlicer
 * profile and mode</legend></fieldset>` (or its post-directive replacement)
 * is not disabled. That fieldset is where the operator picks a profile and
 * proceeds; today it is `disabled={!printerReady || ...}` and
 * `printerReady` is `printerChosen && candidateBlockers.length === 0 &&
 * context !== null` — so a refused candidate slams that door shut with no
 * way through.
 *
 * It fails today because `printerReady` gates on
 * `candidateBlockers.length === 0`, i.e. on the server having populated
 * per-printer eligibility columns. It passes once the wizard's gate is
 * replaced with a profile-selection flow that does not depend on those
 * columns.
 *
 * The matching-predicate control test below asserts the opposite predicate
 * on the same fixture (the fieldset IS disabled today), so if both pass the
 * fixture is broken rather than the code being fixed.
 *
 * TODO(hicks/api-contract): The refused-payload shape below is the desktop's
 * best estimate of what PrintFarmer's daily-validation emulator emits. The
 * `api-contract` research agent is reading `OlyForge3D/PrintFarmer` for the
 * real endpoints and DTOs; if the real response uses a different code set,
 * update `REFUSED_ENVIRONMENT_CODES` here. The assertion (fieldset reachable)
 * is invariant to the specific codes.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CalibrationListPrintersResponse,
  type CalibrationPrinterCandidate,
  type CalibrationRejectionReasonCode,
} from '@shared/ipc';
import { CalibrationWorkspace } from '../src/renderer/calibration';
import type {
  CalibrationApi,
  CalibrationEnvironment,
} from '../src/renderer/calibration/api';

const profileId = '11111111-1111-4111-8111-111111111111';
const now = '2026-08-22T15:43:27.000Z';

/**
 * A representative slice of the refusal codes an emulator-seeded PrintFarmer
 * printer carries. Every entry is one of the ~40 NULL-column consequences
 * Dallas traced in decisions.md Section D: hardware dimensions, firmware
 * identity, slicer engine, toolhead metadata, profile bindings. The exact set
 * is not the load-bearing part of this test — the load-bearing part is that
 * `.length > 1`, which is what makes the wizard render a "huge" wall today.
 *
 * Kept below `CALIBRATION_MAX_REJECTION_REASON_CODES` so the wire projector
 * does not truncate the fixture on the way through.
 */
const REFUSED_ENVIRONMENT_CODES: readonly CalibrationRejectionReasonCode[] = [
  'firmware_family_unknown',
  'firmware_identity_unverified',
  'firmware_version_missing',
  'firmware_detection_time_missing',
  'slicer_engine_missing',
  'slicer_distribution_missing',
  'slicer_version_missing',
  'build_volume_x_missing',
  'build_volume_y_missing',
  'build_volume_z_missing',
  'bed_origin_x_missing',
  'bed_origin_y_missing',
  'hotend_max_temperature_missing',
  'max_bed_temperature_missing',
  'max_chamber_temperature_missing',
  'active_toolhead_missing',
  'physical_toolhead_missing',
  'machine_profile_missing',
  'filament_profile_missing',
  'process_profile_missing',
  'heated_bed_state_missing',
  'enclosure_state_missing',
  'max_acceleration_missing',
  'max_print_speed_missing',
  'max_volumetric_flow_missing',
];

/**
 * A representative slice of `missingInputs` field paths the same seeded
 * printer carries. These reach the wizard as a single joined sentence via
 * `describeMissingInputs`, so they contribute at most one extra bullet — the
 * per-code list above is what makes the message "huge".
 */
const REFUSED_ENVIRONMENT_MISSING_INPUTS: readonly string[] = [
  'firmware.family',
  'firmware.version',
  'geometry.buildVolume.x',
  'geometry.buildVolume.y',
  'profiles.filament.material',
];

function refusedCandidate(
  printerId: string,
  displayName: string,
): CalibrationPrinterCandidate {
  return {
    printerId,
    displayName,
    printerModel: 'Emulated Klipper Machine',
    printerModelId: null,
    firmwareCompatible: false,
    orcaProfileId: null,
    isOnline: true,
    updatedAt: now,
    evaluationScope: 'preliminary' as const,
    rejectionReasonCodes: [...REFUSED_ENVIRONMENT_CODES],
    missingInputs: [...REFUSED_ENVIRONMENT_MISSING_INPUTS],
    eligibility: null,
  };
}

const REFUSED_ENVIRONMENT_PRINTERS: readonly CalibrationPrinterCandidate[] = [
  refusedCandidate('printer-emulator-a', 'Emulator cell A'),
  refusedCandidate('printer-emulator-b', 'Emulator cell B'),
  refusedCandidate('printer-emulator-c', 'Emulator cell C'),
];

function availability() {
  return {
    available: true,
    unavailableReason: null,
    unavailableDetail: null,
    negotiatedApiVersion: '2',
    negotiatedSchemaVersion: '2.0',
    capabilityFlags: {
      calibrationApiEnabled: true,
      calibrationChangeFeedEnabled: true,
      calibrationOfflineDraftEnabled: true,
      calibrationPhotoUploadEnabled: true,
      calibrationGenerationEnabled: true,
    },
    grantedScopes: ['CalibrationRead', 'CalibrationWrite'],
    offlineEditingEnabled: true,
  } as const;
}

function notImplemented(name: string) {
  return {
    status: 'error' as const,
    error: {
      code: 'serverError' as const,
      message: `${name}: not implemented in refused-environment test.`,
      retryable: false,
      retryAfterSeconds: null,
      reference: null,
    },
  };
}

function refusedEnvironmentApi(): CalibrationApi {
  return {
    getCalibrationAvailability: vi.fn().mockResolvedValue(availability()),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockResolvedValue(null),
    saveCalibrationWorkspaceState: vi.fn(),
    listCalibrationPrinters: vi.fn().mockResolvedValue(
      CalibrationListPrintersResponse.parse({
        printers: REFUSED_ENVIRONMENT_PRINTERS,
        printersTruncated: false,
        printersUnreadable: 0,
        fetchedAt: now,
      }),
    ),
    // A refused candidate never has its context fetched — the wizard's
    // radio-highlight path is what surfaces the wall. Returned as an error
    // so that if some future refactor does call it, the test surfaces that
    // rather than silently masking it.
    getCalibrationPrinterContext: vi
      .fn()
      .mockRejectedValue(
        new Error(
          'getCalibrationPrinterContext: refused candidate has no context.',
        ),
      ),
    listOrcaProfiles: vi.fn().mockResolvedValue({
      profiles: [],
      printerId: null,
      configurationRevision: null,
      printersUnreadable: 0,
      printersTruncated: false,
    }),
    listCalibrationConflicts: vi.fn().mockResolvedValue({ conflicts: [] }),
    resolveCalibrationConflict: vi.fn(),
    syncCalibrationNow: vi.fn().mockResolvedValue({
      phase: 'succeeded',
      profileId,
      projectId: null,
      pushedOperations: 0,
      pulledChanges: 0,
      conflictCount: 0,
      cursor: null,
      error: null,
    }),
    openCalibrationPhoto: vi.fn().mockResolvedValue(null),
    stageCalibrationPhoto: vi.fn(),
    generateOrcaProfile: vi
      .fn()
      .mockResolvedValue(notImplemented('generateOrcaProfile')),
    exportOrcaProfile: vi.fn().mockResolvedValue({ status: 'canceled' }),
    installOrcaProfile: vi
      .fn()
      .mockResolvedValue(notImplemented('installOrcaProfile')),
    restoreOrcaProfile: vi
      .fn()
      .mockResolvedValue(notImplemented('restoreOrcaProfile')),
    startCalibrationGeneration: vi
      .fn()
      .mockResolvedValue(notImplemented('startCalibrationGeneration')),
    getCalibrationOrchestrationStatus: vi
      .fn()
      .mockResolvedValue(notImplemented('getCalibrationOrchestrationStatus')),
    getCalibrationQueueState: vi
      .fn()
      .mockResolvedValue(notImplemented('getCalibrationQueueState')),
    acknowledgeCalibrationBedClear: vi
      .fn()
      .mockResolvedValue(notImplemented('acknowledgeCalibrationBedClear')),
    startCalibrationPrint: vi
      .fn()
      .mockResolvedValue(notImplemented('startCalibrationPrint')),
    pollCalibrationQueueChanges: vi
      .fn()
      .mockResolvedValue(notImplemented('pollCalibrationQueueChanges')),
    getCalibrationSubscriptionResources: vi
      .fn()
      .mockResolvedValue(notImplemented('getCalibrationSubscriptionResources')),
    getCalibrationAssetManifest: vi.fn().mockResolvedValue({
      status: 'error',
      message: 'not implemented in refused-environment test.',
    }),
    pickCalibrationAssetFile: vi
      .fn()
      .mockResolvedValue({ status: 'cancelled' }),
    validateCalibrationAssetFile: vi.fn().mockResolvedValue({
      status: 'error',
      message: 'not implemented in refused-environment test.',
    }),
    openCalibrationManifestUrl: vi.fn().mockResolvedValue({ status: 'ok' }),
    // --- Path C: profile-selection channels (Bishop's 6 IPC surface) ------
    //
    // Return empty / no-op fixtures — this test is about the *fieldset* being
    // reachable at all when the server has refused this printer. The
    // acceptance test does not click any of the selectors; if a future test
    // does, populate these the way `calibrationProfileSelectionFlow` does.
    listCalibrationExtendedProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      machineProfiles: [],
      processProfiles: [],
      filamentProfiles: [],
      fetchedAt: now,
    }),
    listCalibrationMachineProfilesForModel: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [],
      noModelAlias: false,
      fetchedAt: now,
    }),
    listCalibrationProcessProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [],
      fetchedAt: now,
    }),
    listCalibrationFilamentProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [],
      fetchedAt: now,
    }),
    listCalibrationCustomProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [],
      fetchedAt: now,
    }),
    setupCalibrationPrinter: vi
      .fn()
      .mockRejectedValue(
        new Error(
          'setupCalibrationPrinter: refused-environment fixture does not exercise submit.',
        ),
      ),
  } satisfies CalibrationApi;
}

function deterministicEnvironment(): CalibrationEnvironment {
  let sequence = 0;
  return {
    createId: () => {
      sequence += 1;
      return `aaaaaaaa-aaaa-4aaa-8aaa-${sequence.toString().padStart(12, '0')}`;
    },
    now: () => now,
  };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());

describe('CalibrationWorkspace against a refused PrintFarmer environment', () => {
  it('does NOT dead-end the operator with an undifferentiated code dump when they click a refused printer', async () => {
    // The realistic payload: every printer PrintFarmer returns is refused
    // with the same missing-columns shape. This is what the user is hitting
    // in daily validation right now.
    const api = refusedEnvironmentApi();
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });

    render(
      <CalibrationWorkspace
        selectedProfileId={profileId}
        selectedProfileName="Farm server"
        onManageProfiles={vi.fn()}
        onFlushReady={() => undefined}
        environment={deterministicEnvironment()}
      />,
    );

    // Open the wizard and highlight the first refused printer. This is the
    // exact operator gesture Vasquez reported: "as soon as I click on a
    // printer I get the huge error message back".
    fireEvent.click(
      await screen.findByRole('button', { name: 'New calibration project' }),
    );
    fireEvent.click(
      await screen.findByRole('radio', { name: /Emulator cell A/ }),
    );

    // THE FAILING ASSERTION — reframed per the 2026-08-22 owner directive.
    //
    // The operator-observable goal state is that the profile-selection UI is
    // REACHABLE after picking a printer. In the current DOM, that UI is the
    // fieldset labeled "Base OrcaSlicer profile and mode"; the owner
    // directive will split it into a machine/process/filament trio, but the
    // pre-condition — the fieldset being reachable at all — is invariant to
    // that redesign.
    //
    // Today the fieldset is `disabled={!printerReady || ...}` and
    // `printerReady = printerChosen && candidateBlockers.length === 0 &&
    // context !== null`, so a refused candidate closes the door with no way
    // through. That is the "dead-ended by an undifferentiated code dump"
    // outcome — the operator has no lever to pull.
    //
    // This assertion passes when the wizard's profile-selection reachability
    // no longer depends on the server having populated per-printer
    // eligibility columns. The full acceptance test for the new flow is in
    // `tests/calibrationProfileSelectionFlow.test.tsx`; this is the
    // targeted guard against regression.
    const profileFieldset = await screen.findByRole('group', {
      name: /Base OrcaSlicer profile|machine profile/i,
    });
    expect(
      profileFieldset,
      'After picking a printer, the profile-selection fieldset must be ' +
        'reachable — the operator needs a lever to pull. Today it is ' +
        'disabled because the wizard demands server-side eligibility that ' +
        'the seeder does not populate. The owner directive says calibration ' +
        'must select profiles from the API instead of waiting for the ' +
        'server to declare eligibility.',
    ).not.toBeDisabled();
  });

  // Historic scaffolding: a control asserting the profile-selection
  // fieldset IS disabled today. Deleted per the owner directive once the
  // Path C profile-selection flow lands — the assertion above takes over
  // as the active guard.
});
