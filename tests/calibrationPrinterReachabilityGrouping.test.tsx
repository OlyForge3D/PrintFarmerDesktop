/**
 * The filament wizard's printer picker groups printers by reachability.
 *
 * ## Why grouping rather than pruning
 *
 * An owner's farm listed ~17 printers, 12 of them offline, as a flat wall of
 * radio buttons. The obvious cleanup — drop the offline ones — would be wrong
 * here, and the reason is specific to this wizard rather than to taste:
 *
 * `candidateEligibilityBlockers` / `contextEligibilityBlockers`
 * (`src/renderer/calibration/projectEligibility.ts:24-33,63-65`) do treat
 * offline as a hard blocker, but those belong to the retired calibration-project
 * saga. `FilamentCalibrationWizard` never calls them — it reads `isOnline` for
 * display only. So an offline printer can legitimately be taken through profile
 * selection, clone, and slice; only send-to-printer needs the machine reachable.
 * Pruning would also make a printer that is merely rebooting vanish from the
 * farm mid-session.
 *
 * So: online first (they can finish the job in one sitting), offline still
 * present and still selectable.
 *
 * ## Matched predicate pair
 *
 * Both arms mount the same two-printer fixture and run the same predicates.
 * They differ only in which printer is being asserted about, so "offline is
 * reachable in the dropdown" is proven against "online is reachable in the
 * dropdown" rather than against nothing.
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

const profileId = '11111111-1111-4111-8111-111111111111';
const now = '2026-08-25T02:29:44.441Z';

const ONLINE_NAME = 'Voron in bay one';
const OFFLINE_NAME = 'Qidi in bay two';

function printer(
  printerId: string,
  displayName: string,
  isOnline: boolean,
): CalibrationPrinterCandidate {
  return {
    printerId,
    displayName,
    printerModel: 'Klipper machine',
    printerModelId: null,
    isOnline,
  };
}

/**
 * Deliberately lists the offline printer FIRST, so a passing assertion that
 * online comes first cannot be an accident of server ordering.
 */
function fixturePrinters(): CalibrationPrinterCandidate[] {
  return [
    printer('printer-offline', OFFLINE_NAME, false),
    printer('printer-online', ONLINE_NAME, true),
  ];
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
      message: `${name}: not implemented in printer-grouping test.`,
      retryable: false,
      retryAfterSeconds: null,
      reference: null,
    },
  };
}

function apiWithPrinters(
  printers: CalibrationPrinterCandidate[],
): CalibrationApi {
  const empty = {
    status: 'ok' as const,
    profiles: [],
    fetchedAt: now,
  };
  return {
    getCalibrationAvailability: vi.fn().mockResolvedValue(availability()),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockResolvedValue(null),
    saveCalibrationWorkspaceState: vi.fn(),
    listCalibrationPrinters: vi.fn().mockResolvedValue(
      CalibrationListPrintersResponse.parse({
        printers,
        printersTruncated: false,
        printersUnreadable: 0,
        fetchedAt: now,
      }),
    ),
    getCalibrationPrinterContext: vi
      .fn()
      .mockRejectedValue(
        new Error('getCalibrationPrinterContext must not be required here.'),
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
    listCalibrationExtendedProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      machineProfiles: [],
      processProfiles: [],
      filamentProfiles: [],
      fetchedAt: now,
    }),
    listCalibrationMachineProfilesForModel: vi
      .fn()
      .mockResolvedValue({ ...empty, noModelAlias: false }),
    listCalibrationProcessProfilesForMachines: vi.fn().mockResolvedValue(empty),
    listCalibrationFilamentProfilesForMachines: vi
      .fn()
      .mockResolvedValue(empty),
    listCalibrationCustomProfiles: vi.fn().mockResolvedValue(empty),
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

async function openPrinterSelect(): Promise<HTMLSelectElement> {
  Object.defineProperty(window, 'printFarmer', {
    configurable: true,
    value: apiWithPrinters(fixturePrinters()),
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
  return await screen.findByRole<HTMLSelectElement>('combobox', {
    name: /^printer$/i,
  });
}

/** The `<optgroup>` label an option sits under, or null if ungrouped. */
function groupLabelOf(option: HTMLOptionElement): string | null {
  const parent = option.parentElement;
  if (parent === null || parent.tagName.toLowerCase() !== 'optgroup') {
    return null;
  }
  return (parent as HTMLOptGroupElement).label;
}

function optionNamed(
  select: HTMLSelectElement,
  name: string,
): HTMLOptionElement {
  const option = Array.from(select.querySelectorAll('option')).find((entry) =>
    (entry.textContent ?? '').includes(name),
  );
  if (option === undefined) throw new Error(`no option for ${name}`);
  return option;
}

afterEach(cleanup);

describe('printer dropdown groups by reachability', () => {
  it('ARM A — the offline printer sits under an "Offline" group and is still selectable', async () => {
    const select = await openPrinterSelect();
    const option = optionNamed(select, OFFLINE_NAME);

    expect(groupLabelOf(option)).toMatch(/^Offline/);
    // Grouped, NOT pruned and NOT disabled: this wizard does not gate on
    // isOnline, so setup and slicing remain available for an offline machine.
    expect(option.disabled).toBe(false);
    fireEvent.change(select, { target: { value: option.value } });
    expect(select.value).toBe(option.value);
  });

  it('ARM B (control) — the online printer sits under "Online" and is equally selectable', async () => {
    const select = await openPrinterSelect();
    const option = optionNamed(select, ONLINE_NAME);

    // Same predicates as arm A, opposite group on the same fixture. Without
    // this, arm A would also pass if every option were dumped into one
    // permanently-"Offline" group.
    expect(groupLabelOf(option)).toBe('Online');
    expect(option.disabled).toBe(false);
    fireEvent.change(select, { target: { value: option.value } });
    expect(select.value).toBe(option.value);
  });

  it('offers online printers before offline ones, regardless of server order', async () => {
    const select = await openPrinterSelect();
    const rendered = Array.from(select.querySelectorAll('option'))
      .map((entry) => entry.textContent ?? '')
      .filter(
        (text) => text.includes(ONLINE_NAME) || text.includes(OFFLINE_NAME),
      );

    // The fixture lists the offline printer FIRST, so this ordering can only
    // come from the partition, not from the server's array order.
    expect(rendered[0]).toContain(ONLINE_NAME);
    expect(rendered[1]).toContain(OFFLINE_NAME);
  });

  it('does not stamp "(offline)" onto the option text now that the group says it', async () => {
    const select = await openPrinterSelect();

    // Belt-and-braces against the marker being reintroduced alongside the
    // group label, which would read as "Offline > Qidi in bay two (offline)".
    expect(optionNamed(select, OFFLINE_NAME).textContent ?? '').not.toMatch(
      /\(offline\)/i,
    );
    expect(groupLabelOf(optionNamed(select, OFFLINE_NAME)) ?? '').toMatch(
      /cannot print until reachable/i,
    );
  });
});
