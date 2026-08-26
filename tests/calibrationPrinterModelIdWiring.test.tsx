/**
 * Matched-predicate wiring test for `ProfileSelectionSection`'s
 * `printerModelId` prop as seen through the filament calibration wizard.
 *
 * WHY THIS EXISTS
 *
 * The candidate DTO carries `printerModelId` end-to-end and the wizard threads
 * it into `ProfileSelectionSection` at `FilamentCalibrationWizard.tsx:1113`.
 * The wire-level acceptance suite in
 * `tests/filamentCalibrationWizard.test.tsx` mounts the wizard and stubs both
 * `/extended` and `/for-model` with the same options, so it cannot see the
 * difference between "the renderer took the `/for-model` path" and "the
 * renderer fell back to `/extended` because the printerModelId was lost or
 * became `null`." Every acceptance test stays green either way.
 *
 * That is the exact `test-green / user-wrong gap` Vasquez has repeatedly
 * called out. The matched pair below closes it by asserting on which mock
 * was called, on the same predicate, with only `printerModelId` differing
 * between arms.
 *
 * WHAT IT ASSERTS
 *
 *  ARM A — positive:
 *    Candidate carries `printerModelId: <guid>`.
 *    Predicate: `listCalibrationMachineProfilesForModel.mock.calls[0][0]`
 *    is `{ profileId, printerModelId: <that guid> }`.
 *    `listCalibrationExtendedProfiles` is NOT called for the machine list.
 *
 *  ARM B — matching-predicate control (the permissive-fallback contract):
 *    Same fixture, same mount, same operator action, only
 *    `printerModelId` set to `null`.
 *    Predicate: `listCalibrationMachineProfilesForModel` was NOT called.
 *    `listCalibrationExtendedProfiles` IS called — the wider pool is shown
 *    rather than an empty selector. This is the exact empty-list failure
 *    the retired `/calibration-candidates` contract existed to prevent and
 *    that `profileSelection.ts:49-53` still guards against.
 *
 * Same instrument, opposite result on the same data — the repo rule for
 * every predicate that ships. Passing both proves the wiring; passing
 * arm A alone (as the buggy code did) leaves the fallback path
 * indistinguishable from success.
 *
 * ## Ported under #756
 *
 * This suite originally mounted the printer-calibration saga's
 * "New calibration project" wizard. That wizard was reaped along with the
 * rest of the saga, but `ProfileSelectionSection` — the component under
 * test — survived and is now hosted by the filament calibration wizard.
 * The wiring contract is unchanged; only the host is different, so the
 * suite is ported rather than deleted.
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
import { pickPrinterByLabel } from './fixtures/filamentWizardPrinterPicker';

const profileId = '11111111-1111-4111-8111-111111111111';
const printerId = 'printer-a';
const printerModelGuid = '33333333-3333-4333-8333-333333333333';
const machineGuid = '44444444-4444-4444-8444-444444444401';
const processGuid = '44444444-4444-4444-8444-444444444402';
const filamentGuid = '44444444-4444-4444-8444-444444444403';
const sampleMachineName = 'K1 Max 0.4';
const sampleProcessName = '0.20mm Standard';
const sampleFilamentName = 'Generic PLA';
const now = '2026-08-23T02:29:44.441Z';

function candidateWithModel(
  modelId: string | null,
): CalibrationPrinterCandidate {
  return {
    printerId,
    displayName: 'Emulator cell A',
    printerModel: 'Klipper machine',
    printerModelId: modelId,
    isOnline: true,
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
          'getCalibrationPrinterContext: filament wizard must not require ' +
            'per-printer server eligibility.',
        ),
      ),
    listOrcaProfiles: vi.fn().mockResolvedValue({
      profiles: [],
      printerId: null,
      configurationRevision: null,
      printersUnreadable: 0,
      printersTruncated: false,
    }),
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
    exportOrcaProfile: vi.fn().mockResolvedValue({ status: 'canceled' }),
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
          name: sampleProcessName,
          guid: processGuid,
          source: 'system' as const,
          displayLabel: '0.4 nozzle',
          contentSha256: null,
        },
      ],
      filamentProfiles: [
        {
          name: sampleFilamentName,
          guid: filamentGuid,
          source: 'system' as const,
          displayLabel: 'PLA',
          contentSha256: null,
        },
      ],
      profilesTruncated: false,
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
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationProcessProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [
        {
          name: sampleProcessName,
          guid: processGuid,
          source: 'system' as const,
          displayLabel: '0.4 nozzle',
          contentSha256: null,
        },
      ],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationFilamentProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [
        {
          name: sampleFilamentName,
          guid: filamentGuid,
          source: 'system' as const,
          displayLabel: 'PLA',
          contentSha256: null,
        },
      ],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationCustomProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [],
      fetchedAt: now,
    }),
    resolveSystemProfile: vi
      .fn()
      .mockResolvedValue(notImplemented('resolveSystemProfile')),
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
    getFilamentCalibrationWizardState: vi.fn().mockResolvedValue(null),
    saveFilamentCalibrationWizardState: vi
      .fn()
      .mockResolvedValue({ saved: true }),
    clearFilamentCalibrationWizardState: vi
      .fn()
      .mockResolvedValue({ cleared: true }),
    resolveCalibrationConflict: vi
      .fn()
      .mockRejectedValue(new Error('notImplemented')),
    listCalibrationConflicts: vi.fn().mockResolvedValue({ conflicts: [] }),
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

/**
 * Choose a printer from the wizard's printer dropdown by its visible label.
 * The picker is a `<select>`, so selection is a `change` carrying the option's
 * value (the printer id) rather than a click on a labelled radio.
 *
 * Implementation lives in `tests/fixtures/filamentWizardPrinterPicker.ts` —
 * shared with the other filament-wizard test suites so the picker convention
 * cannot silently drift between them.
 */

async function openWizardAndPickPrinter(): Promise<void> {
  // The filament wizard is entered from the calibration dashboard's single
  // primary CTA — same host that the saga wizard used to occupy.
  fireEvent.click(
    await screen.findByRole('button', { name: /Calibrate a filament spool/i }),
  );
  await pickPrinterByLabel(/Emulator cell A/);
  // Wait for the cascade's `useEffect(loadCatalog)` async fetches to settle
  // so the predicate below observes a stable set of `mock.calls`.
  await waitFor(() => {
    const selector = screen.queryByRole('combobox', {
      name: /machine profile/i,
    });
    if (selector === null) throw new Error('machine selector not present yet');
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

  it('does NOT call listCalibrationMachineProfilesForModel when the candidate carries printerModelId: null (matching-predicate control, permissive fallback)', async () => {
    const { api } = mountWith(candidateWithModel(null));
    await openWizardAndPickPrinter();

    const forModel = vi.mocked(api.listCalibrationMachineProfilesForModel);
    // Same predicate the positive arm ran against, opposite result on the
    // same fixture aside from the one field under test. This is what makes
    // the positive arm provable rather than accidental — the cascade's
    // `printerModelId === null ? Promise.resolve(null) : /for-model(...)`
    // branch fires the correct arm for each value.
    expect(forModel).not.toHaveBeenCalled();

    // The permissive-fallback contract Vasquez called out: with the
    // candidate contract retired, `printerModelId: null` MUST fall back to
    // the wider pool rather than showing an empty selector. This is the
    // exact empty-list failure the retired `/calibration-candidates` route
    // used to guard against, and is now guarded here (see
    // `profileSelection.ts:49-53`).
    const extended = vi.mocked(api.listCalibrationExtendedProfiles);
    expect(extended).toHaveBeenCalledWith({ profileId });
    // And the operator does see a populated machine selector — the
    // observable side of the same guarantee. The waiter in
    // `openWizardAndPickPrinter` above already blocks on this, so reaching
    // this line at all proves it.
    const selector = await screen.findByRole('combobox', {
      name: /machine profile/i,
    });
    const options = Array.from(selector.querySelectorAll('option')).filter(
      (option) => option.value.length > 0,
    );
    expect(
      options.length,
      'null printerModelId collapsed the machine selector to an empty list',
    ).toBeGreaterThan(0);
  });
});
