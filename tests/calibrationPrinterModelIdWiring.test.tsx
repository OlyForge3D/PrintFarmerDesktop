/**
 * Matched-predicate wiring test for `NewCalibrationProject`'s
 * `printerModelId` prop into `ProfileSelectionSection`.
 *
 * WHY THIS EXISTS
 *
 * Between Bishop's commit `9f62a958` and Dallas's fix on top of it, the
 * candidate DTO carries `printerModelId` end-to-end but the JSX prop was
 * hardcoded `printerModelId={null}` for one iteration cycle. The
 * acceptance-flow test suite in `calibrationProfileSelectionFlow.test.tsx`
 * mounts the workspace, mocks the six Path C channels, and asserts the
 * cascade is functional — but because it stubs both `/extended` and
 * `/for-model` at the API boundary with the same options, it cannot see the
 * difference between "the renderer took the `/for-model` path" and "the
 * renderer took the `/extended` fallback because the printerModelId was
 * lost." Every acceptance test stays green either way.
 *
 * That is exactly the failure mode Vasquez called out (`test-green /
 * user-wrong gap`) which let three earlier PRs merge on a dead feature. The
 * matched pair below closes it by asserting on which mock was called,
 * on the same predicate, with only `printerModelId` differing between arms.
 *
 * WHAT IT ASSERTS
 *
 *  ARM A — positive:
 *    Candidate carries `printerModelId: <guid>`.
 *    Predicate: `listCalibrationMachineProfilesForModel.mock.calls[0][0]`
 *    is `{ profileId, printerModelId: <that guid> }`.
 *
 *  ARM B — matching-predicate control:
 *    Same fixture, same mount, same operator action, only
 *    `printerModelId` set to `null`.
 *    Predicate: `listCalibrationMachineProfilesForModel` was NOT called.
 *
 * Same instrument, opposite result on the same data — the repo rule for
 * every predicate that ships. Passing both proves the wiring; passing
 * arm A alone (as the buggy code did) leaves the fallback path
 * indistinguishable from success.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CalibrationListPrintersResponse,
  type CalibrationPrinterCandidate,
} from '@shared/ipc';
import { CalibrationWorkspace } from '../src/renderer/calibration';
import type {
  CalibrationApi,
  CalibrationEnvironment,
} from '../src/renderer/calibration/api';

const profileId = '11111111-1111-4111-8111-111111111111';
const printerId = 'printer-a';
const printerModelGuid = '33333333-3333-4333-8333-333333333333';
const machineGuid = '44444444-4444-4444-8444-444444444401';
const processGuid = '44444444-4444-4444-8444-444444444402';
const filamentGuid = '44444444-4444-4444-8444-444444444403';
const sampleMachineName = 'K1 Max 0.4';
const now = '2026-08-23T02:29:44.441Z';

function candidateWithModel(
  modelId: string | null,
): CalibrationPrinterCandidate {
  return {
    printerId,
    displayName: 'Emulator cell A',
    printerModel: 'Klipper machine',
    printerModelId: modelId,
    firmwareCompatible: false,
    orcaProfileId: null,
    isOnline: true,
    updatedAt: now,
    evaluationScope: 'preliminary' as const,
    rejectionReasonCodes: [
      'machine_profile_missing',
      'process_profile_missing',
      'filament_profile_missing',
    ],
    missingInputs: [],
    eligibility: null,
  };
}

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
      message: `${name}: not implemented in printerModelId wiring test.`,
      retryable: false,
      retryAfterSeconds: null,
      reference: null,
    },
  };
}

function apiFor(candidate: CalibrationPrinterCandidate): CalibrationApi {
  return {
    getCalibrationAvailability: vi.fn().mockResolvedValue(availability()),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockResolvedValue(null),
    saveCalibrationWorkspaceState: vi.fn(),
    listCalibrationPrinters: vi.fn().mockResolvedValue(
      CalibrationListPrintersResponse.parse({
        printers: [candidate],
        printersTruncated: false,
        printersUnreadable: 0,
        fetchedAt: now,
      }),
    ),
    getCalibrationPrinterContext: vi
      .fn()
      .mockRejectedValue(
        new Error(
          'getCalibrationPrinterContext: profile-selection flow must not ' +
            'require per-printer server eligibility.',
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
    // The two calls this test actually reads. Both return the same option
    // set so operator-visible outcome is identical between arms; the
    // difference is only which call fires, which is what the predicate
    // inspects.
    listCalibrationExtendedProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      machineProfiles: [
        {
          name: sampleMachineName,
          guid: machineGuid,
          source: 'system' as const,
          displayLabel: 'Bed 300×300',
          contentSha256: null,
        },
      ],
      processProfiles: [
        {
          name: '0.20mm Standard',
          guid: processGuid,
          source: 'system' as const,
          displayLabel: '0.4 nozzle',
          contentSha256: null,
        },
      ],
      filamentProfiles: [
        {
          name: 'Generic PLA',
          guid: filamentGuid,
          source: 'system' as const,
          displayLabel: 'PLA',
          contentSha256: null,
        },
      ],
      fetchedAt: now,
    }),
    listCalibrationMachineProfilesForModel: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [
        {
          name: sampleMachineName,
          guid: machineGuid,
          source: 'system' as const,
          displayLabel: 'Bed 300×300',
          contentSha256: null,
        },
      ],
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
    cloneCalibrationFilamentProfile: vi
      .fn()
      .mockResolvedValue(notImplemented('cloneCalibrationFilamentProfile')),
    submitCalibrationSlice: vi
      .fn()
      .mockResolvedValue(notImplemented('submitCalibrationSlice')),
    getCalibrationSliceJobStatus: vi
      .fn()
      .mockResolvedValue(notImplemented('getCalibrationSliceJobStatus')),
    sendCalibrationSliceToPrinter: vi
      .fn()
      .mockResolvedValue(notImplemented('sendCalibrationSliceToPrinter')),
    updateCalibrationFilamentProfileMeasurement: vi
      .fn()
      .mockResolvedValue(
        notImplemented('updateCalibrationFilamentProfileMeasurement'),
      ),
  } satisfies CalibrationApi;
}

function deterministicEnvironment(): CalibrationEnvironment {
  let sequence = 0;
  return {
    createId: () => {
      sequence += 1;
      return `55555555-5555-4555-8555-${sequence.toString().padStart(12, '0')}`;
    },
    now: () => now,
  };
}

function mountWith(candidate: CalibrationPrinterCandidate) {
  const api = apiFor(candidate);
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
  return { api };
}

async function openWizardAndPickPrinter(): Promise<void> {
  fireEvent.click(
    await screen.findByRole('button', { name: 'New calibration project' }),
  );
  fireEvent.click(
    await screen.findByRole('radio', { name: /Emulator cell A/ }),
  );
  // Wait for the cascade's `useEffect(loadCatalog)` async fetches to settle
  // so the predicate below observes a stable set of `mock.calls`.
  await waitFor(() => {
    const selector = screen.queryByRole('combobox', {
      name: /machine profile/i,
    });
    if (selector === null) return;
    const populated = Array.from(selector.querySelectorAll('option')).some(
      (option) => option.value.length > 0,
    );
    if (!populated) throw new Error('machine selector not populated yet');
  });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());

describe('printerModelId is threaded from candidate into ProfileSelectionSection', () => {
  it('calls listCalibrationMachineProfilesForModel with the candidate Guid when it is present (positive)', async () => {
    const { api } = mountWith(candidateWithModel(printerModelGuid));
    await openWizardAndPickPrinter();

    const forModel = vi.mocked(api.listCalibrationMachineProfilesForModel);
    expect(forModel).toHaveBeenCalledTimes(1);
    // The exact predicate: profileId + the Guid the fixture printer carries.
    // If the JSX prop is `printerModelId={null}` again, or the value is
    // coerced away (e.g. `?? ''`), this fails with a diff on the argument
    // rather than a green pass with a wrong catalog.
    expect(forModel).toHaveBeenCalledWith({
      profileId,
      printerModelId: printerModelGuid,
    });
  });

  it('does NOT call listCalibrationMachineProfilesForModel when the candidate carries printerModelId: null (matching-predicate control)', async () => {
    const { api } = mountWith(candidateWithModel(null));
    await openWizardAndPickPrinter();

    const forModel = vi.mocked(api.listCalibrationMachineProfilesForModel);
    // Same predicate the positive arm ran against, opposite result on the
    // same fixture aside from the one field under test. This is what makes
    // the positive arm provable rather than accidental — the cascade's
    // `printerModelId === null ? Promise.resolve(null) : /for-model(...)`
    // branch fires the correct arm for each value.
    expect(forModel).not.toHaveBeenCalled();

    // Sanity: the `/extended` fallback IS the source of machine options
    // when we're on the null branch, so the operator still gets a working
    // selector — same user-visible outcome, different source of truth.
    const extended = vi.mocked(api.listCalibrationExtendedProfiles);
    expect(extended).toHaveBeenCalledWith({ profileId });
  });
});
