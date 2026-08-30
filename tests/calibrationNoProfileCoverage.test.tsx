/**
 * Guidance when a printer has no profile coverage.
 *
 * ## The state this covers
 *
 * A printer whose catalog model has no OrcaSlicer profile coverage cannot be
 * onboarded from the catalog at all — the server-side story is
 * OlyForge3D/PrintFarmer#2055, resolved there by profile family cloning. On
 * the desktop the operator previously saw an empty "Select a machine profile"
 * dropdown and nothing else: indistinguishable from a slow load, with no
 * indication that the remedy exists in a different application.
 *
 * The desktop deliberately does not offer the remedy as an action.
 * `POST /api/slicer/profiles/clone-family` is gated on
 * `slicer_engines:admin`, which the desktop never holds by design, so a
 * button here could only ever produce a 403. Naming the destination is the
 * honest affordance.
 *
 * ## Matched predicate pairs
 *
 * Every arm below runs the same predicate — "is the no-coverage guidance
 * present?" — against fixtures that differ in exactly one respect. The
 * negative arms are the point: a notice that renders unconditionally, or one
 * that renders while the catalog is still loading, would satisfy the positive
 * arms while being actively wrong.
 *
 * The loading arm matters most. An empty list mid-fetch means "not yet", not
 * "never"; telling an operator to go ask an administrator for a profile
 * family because a request had not landed yet is a worse failure than saying
 * nothing at all.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
const printerModelGuid = '33333333-3333-4333-8333-333333333333';
const machineGuid = '44444444-4444-4444-8444-444444444401';
const processGuid = '44444444-4444-4444-8444-444444444402';
const filamentGuid = '44444444-4444-4444-8444-444444444403';
const machineName = 'Voron 2.4 350';
const now = '2026-08-27T02:29:44.441Z';

/** The predicate every arm runs. */
const GUIDANCE = /No machine profiles are available/i;

function candidate(): CalibrationPrinterCandidate {
  return {
    printerId: 'printer-a',
    displayName: 'Uncovered cell 3',
    printerModel: 'Unknown Klipper',
    printerModelId: printerModelGuid,
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
      calibrationArtifactPromotionEnabled: true,
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
      message: `${name}: not implemented in no-coverage test.`,
      retryable: false,
      retryAfterSeconds: null,
      reference: null,
    },
  };
}

interface Coverage {
  /** Machine profiles the model-scoped endpoint returns. */
  readonly machines: readonly { name: string; guid: string | null }[];
  /** When set, `listCalibrationMachineProfilesForModel` never settles. */
  readonly hangMachineFetch?: boolean;
}

function apiWith(coverage: Coverage): CalibrationApi {
  const machineProfiles = coverage.machines.map((m) => ({
    name: m.name,
    guid: m.guid,
    source: 'system' as const,
    displayLabel: 'Bed 350',
    contentSha256: null,
  }));
  return {
    getCalibrationAvailability: vi.fn().mockResolvedValue(availability()),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockResolvedValue(null),
    saveCalibrationWorkspaceState: vi.fn(),
    listCalibrationPrinters: vi.fn().mockResolvedValue(
      CalibrationListPrintersResponse.parse({
        printers: [candidate()],
        printersTruncated: false,
        printersUnreadable: 0,
        fetchedAt: now,
      }),
    ),
    getCalibrationPrinterContext: vi
      .fn()
      .mockRejectedValue(new Error('context must not be required here')),
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
    listCalibrationExtendedProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      machineProfiles: [],
      processProfiles: [],
      filamentProfiles: [],
      fetchedAt: now,
    }),
    listCalibrationMachineProfilesForModel: vi.fn().mockImplementation(() =>
      coverage.hangMachineFetch === true
        ? new Promise(() => {
            /* deliberately never settles — keeps the catalog in `loading` */
          })
        : Promise.resolve({
            status: 'ok' as const,
            profiles: machineProfiles,
            noModelAlias: false,
            fetchedAt: now,
          }),
    ),
    listCalibrationProcessProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [
        {
          name: '0.20mm Standard',
          guid: processGuid,
          source: 'system' as const,
          displayLabel: 'standard',
          contentSha256: null,
        },
      ],
      fetchedAt: now,
    }),
    listCalibrationFilamentProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [
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
    listCalibrationCustomProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [],
      fetchedAt: now,
    }),
    resolveSystemProfile: vi
      .fn()
      .mockResolvedValue(notImplemented('resolveSystemProfile')),
    createCalibrationProject: vi
      .fn()
      .mockResolvedValue(notImplemented('createCalibrationProject')),
    getCalibrationMethodGuidanceCatalog: vi
      .fn()
      .mockResolvedValue(notImplemented('getCalibrationMethodGuidanceCatalog')),
    getCalibrationMethodProgress: vi
      .fn()
      .mockResolvedValue(notImplemented('getCalibrationMethodProgress')),
    setCalibrationMethodDisposition: vi
      .fn()
      .mockResolvedValue(notImplemented('setCalibrationMethodDisposition')),
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
    getCalibrationInFlightState: vi.fn(),
    discardCalibrationDeviceDraft: vi.fn(),
    resolveCalibrationConflict: vi
      .fn()
      .mockResolvedValue(notImplemented('resolveCalibrationConflict')),
    listCalibrationConflicts: vi
      .fn()
      .mockResolvedValue(notImplemented('listCalibrationConflicts')),
    submitCalibrationObservation: vi
      .fn()
      .mockResolvedValue(notImplemented('submitCalibrationObservation')),
    completeCalibrationProject: vi
      .fn()
      .mockResolvedValue(notImplemented('completeCalibrationProject')),
    deleteWorkingCloneProfile: vi
      .fn()
      .mockResolvedValue(notImplemented('deleteWorkingCloneProfile')),
    listCalibrationSpoolmanSpools: vi.fn().mockResolvedValue({
      status: 'ok',
      spools: [],
      fetchedAt: '2026-08-24T02:29:44.441Z',
    }),
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

async function openWizardWith(coverage: Coverage): Promise<CalibrationApi> {
  const api = apiWith(coverage);
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
  fireEvent.click(
    await screen.findByRole('button', { name: /Calibrate a filament spool/i }),
  );
  await pickPrinterByLabel(/Uncovered cell 3/);
  return api;
}

afterEach(cleanup);

describe('no profile coverage for the chosen printer', () => {
  it('ARM A — with zero machine profiles, explains the state and names the remedy', async () => {
    await openWizardWith({ machines: [] });

    const notice = await screen.findByText(GUIDANCE);
    expect(notice).toBeInTheDocument();

    // The three things the operator needs: that calibration cannot start,
    // where the remedy lives, and why it is not offered here. Asserted on the
    // containing element so editing the copy's line breaks does not break it.
    const block = notice.closest('.cal-notice');
    const text = block?.textContent ?? '';
    expect(text).toMatch(/profile family/i);
    expect(text).toMatch(/web interface/i);
    expect(text).toMatch(/permission/i);
  });

  it('ARM A — offers a reload so the operator can retry after an admin acts', async () => {
    const api = await openWizardWith({ machines: [] });
    const before = vi.mocked(api.listCalibrationMachineProfilesForModel).mock
      .calls.length;

    fireEvent.click(
      await screen.findByRole('button', { name: 'Reload profiles' }),
    );

    // Without this the operator would have to restart the wizard to pick up a
    // profile family that was created while this screen was open.
    expect(
      vi.mocked(api.listCalibrationMachineProfilesForModel).mock.calls.length,
    ).toBeGreaterThan(before);
  });

  it('ARM B (control) — with coverage present, no guidance and a usable dropdown', async () => {
    await openWizardWith({
      machines: [{ name: machineName, guid: machineGuid }],
    });

    // Same predicate, opposite result on the one field that differs. Without
    // this arm, a permanently-mounted notice would satisfy ARM A.
    const select = await screen.findByRole('combobox', {
      name: /machine profile/i,
    });
    expect(
      Array.from(select.querySelectorAll('option')).some(
        (o) => o.value.length > 0,
      ),
    ).toBe(true);
    expect(screen.queryByText(GUIDANCE)).toBeNull();
  });

  it('ARM C (control) — says nothing while the catalog is still loading', async () => {
    // The failure mode that would make this feature harmful: an empty list
    // mid-fetch means "not yet", not "never". A notice here would send the
    // operator to an administrator because a request had not landed.
    await openWizardWith({ machines: [], hangMachineFetch: true });

    expect(screen.queryByText(GUIDANCE)).toBeNull();
    // And the operator is told what IS happening instead.
    expect(
      await screen.findByText(/Loading calibration profile catalog/i),
    ).toBeInTheDocument();
  });
});
