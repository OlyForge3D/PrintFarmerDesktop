/**
 * Issue #766 — the "not imported into PrintFarmer" dead end is removed.
 *
 * BACKGROUND
 *
 * PrintFarmer#2004 reported that a catalog system profile a printer's
 * machine matched — but which no admin had ever imported into
 * PrintFarmer's database — listed with `guid: null` from the `/extended`
 * and `/for-model` endpoints, and the desktop used to `disabled` that
 * `<option>` outright with an "identity unresolved; cannot be selected"
 * suffix. A printer like a never-onboarded Qidi X-Plus 4 could not be
 * filament-calibrated at all without an admin pre-importing its profiles
 * first — a dead end for the operator.
 *
 * PrintFarmer PR #2008 (closing #2004) shipped the fix as
 * "resolve-or-import at setup": `POST /api/slicer/profiles/resolve-for-
 * model/{modelId}`, gated only by `Calibration.Update` (a scope the
 * desktop already holds — no admin action required), looks the profile up
 * by name and auto-imports it from the OrcaSlicer worker catalog if it was
 * never imported, then returns its real Guid. The list endpoints
 * themselves are UNCHANGED — a never-imported profile still lists with
 * `guid: null` — so the desktop's fix is not "the null case no longer
 * exists"; it is "the null case is no longer a dead end because the
 * desktop can resolve the real identity itself, on demand, at the one
 * point it is actually needed" (the filament clone step).
 *
 * THIS SUITE (inverted from the pre-#766 shape; not a deletion)
 *
 *   1. A never-imported system profile's `<option>` is enabled/selectable
 *      in every one of the three cascade dropdowns (machine, process,
 *      filament) — the previously-disabled fixture now asserts
 *      selectable, and it carries no "identity unresolved" text.
 *   2. Matched control: an already-imported system profile remains
 *      selectable too — no regression for printers whose profiles were
 *      already onboarded.
 *   3. End to end: picking a never-imported filament profile and cloning
 *      it calls `resolveSystemProfile` with the exact
 *      `{ profileId, printerModelId, profileType: 'filament',
 *      profileName }` the resolve-or-import endpoint needs, BEFORE
 *      `cloneCalibrationFilamentProfile` fires — and the clone uses the
 *      newly-resolved Guid as `sourceProfileId`, not the null it started
 *      with. The wizard reaches the same post-clone phase a normal clone
 *      reaches, proving the operator is not stuck.
 *   4. Matched control: an already-imported filament profile's clone does
 *      NOT call `resolveSystemProfile` at all — the on-demand resolution
 *      path is additive, not a detour every clone now takes.
 *
 * Every assertion is on operator-observable outcomes (rendered DOM,
 * enabled/disabled state, visible text) or on the exact IPC call made —
 * never on internal component shape.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CalibrationListPrintersResponse,
  type CalibrationCustomProfileRef,
  type CalibrationPrinterCandidate,
  type CalibrationSlicerProfileRef,
} from '@shared/ipc';
import { CalibrationWorkspace } from '../src/renderer/calibration';
import type {
  CalibrationApi,
  CalibrationEnvironment,
} from '../src/renderer/calibration/api';
import { pickPrinterByLabel } from './fixtures/filamentWizardPrinterPicker';

const profileId = '11111111-1111-4111-8111-111111111111';
const printerId = '33333333-3333-4333-8333-333333333301';
const printerModelId = '66666666-6666-4666-8666-666666666601';
const now = '2026-08-24T02:29:44.441Z';

// The Qidi X-Plus 4 shaped repro from PrintFarmer#2004 — a real catalog
// machine model whose profiles this fixture treats as never imported.
const NEVER_IMPORTED_MACHINE_NAME = 'Qidi X-Plus 4 0.4';
const IMPORTED_MACHINE_NAME = 'Prusa MK4 0.4';
const NEVER_IMPORTED_PROCESS_NAME = '0.20mm Standard @Qidi X-Plus 4';
const NEVER_IMPORTED_FILAMENT_NAME = 'Qidi Rapid PLA';
const IMPORTED_FILAMENT_NAME = 'Generic PLA';

const importedMachineGuid = '22222222-2222-4222-8222-222222222201';
const importedProcessGuid = '22222222-2222-4222-8222-222222222202';
const importedFilamentGuid = '22222222-2222-4222-8222-222222222203';
const resolvedFilamentGuid = '44444444-4444-4444-8444-444444444444';
const cloneGuid = '55555555-5555-4555-8555-555555555501';

function systemProfile(
  name: string,
  guid: string | null,
  displayLabel: string | null = null,
): CalibrationSlicerProfileRef {
  return {
    name,
    guid,
    source: 'system' as const,
    displayLabel,
    contentSha256: null,
  };
}

function noCustomProfiles(): {
  profiles: readonly CalibrationCustomProfileRef[];
} {
  return { profiles: [] };
}

function printerCandidate(
  overrides: Partial<CalibrationPrinterCandidate> = {},
): CalibrationPrinterCandidate {
  return {
    printerId,
    displayName: 'Emulator cell A',
    printerModel: 'Klipper machine',
    printerModelId,
    isOnline: true,
    ...overrides,
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
      message: `${name}: not implemented in this test.`,
      retryable: false,
      retryAfterSeconds: null,
      reference: null,
    },
  };
}

/**
 * Fixture builder. `machine`/`process`/`filament` are the three system
 * profiles the cascade offers, deliberately parameterised so each test can
 * pick whether its profile is never-imported (`guid: null`) or already
 * imported (`guid: <real guid>`) independent of the others.
 */
function apiFor(options: {
  machine: CalibrationSlicerProfileRef;
  process: CalibrationSlicerProfileRef;
  filament: CalibrationSlicerProfileRef;
  resolveSystemProfile?: CalibrationApi['resolveSystemProfile'];
  printer?: CalibrationPrinterCandidate;
  saveFilamentCalibrationWizardState?: CalibrationApi['saveFilamentCalibrationWizardState'];
}): CalibrationApi {
  const { machine, process, filament } = options;
  return {
    getCalibrationAvailability: vi.fn().mockResolvedValue(availability()),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockResolvedValue(null),
    saveCalibrationWorkspaceState: vi.fn(),
    listCalibrationPrinters: vi.fn().mockResolvedValue(
      CalibrationListPrintersResponse.parse({
        printers: [options.printer ?? printerCandidate()],
        printersTruncated: false,
        printersUnreadable: 0,
        fetchedAt: now,
      }),
    ),
    getCalibrationPrinterContext: vi
      .fn()
      .mockRejectedValue(
        new Error(
          'getCalibrationPrinterContext must not be called by the wizard.',
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
    listCalibrationExtendedProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      machineProfiles: [machine],
      processProfiles: [process],
      filamentProfiles: [filament],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationMachineProfilesForModel: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [machine],
      noModelAlias: false,
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationProcessProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [process],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationFilamentProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [filament],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationCustomProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      ...noCustomProfiles(),
      fetchedAt: now,
    }),
    resolveSystemProfile:
      options.resolveSystemProfile ??
      vi
        .fn()
        .mockRejectedValue(
          new Error('resolveSystemProfile must not be called in this test.'),
        ),
    createCalibrationProject: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      project: {
        id: '66666666-6666-4666-8666-666666666601',
        name: `${filament.name} (calibration project)`,
        lifecycleStatus: 'Active',
        experienceMode: 'Coach',
        printerId: (options.printer ?? printerCandidate()).printerId,
        revision: 1,
      },
    }),
    getCalibrationMethodGuidanceCatalog: vi
      .fn()
      .mockResolvedValue({ status: 'ok' as const, catalog: [] }),
    getCalibrationMethodProgress: vi
      .fn()
      .mockResolvedValue({ status: 'ok' as const, progress: [] }),
    setCalibrationMethodDisposition: vi
      .fn()
      .mockRejectedValue(
        new Error(
          'setCalibrationMethodDisposition must not be called in this test.',
        ),
      ),
    cloneCalibrationFilamentProfile: vi.fn().mockResolvedValue({
      status: 'ok',
      clone: {
        id: cloneGuid,
        name: `${filament.name} (calibration)`,
        profileType: 'filament' as const,
        isSystem: false as const,
      },
    }),
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
    saveFilamentCalibrationWizardState:
      options.saveFilamentCalibrationWizardState ??
      vi.fn().mockResolvedValue({ saved: true }),
    clearFilamentCalibrationWizardState: vi
      .fn()
      .mockResolvedValue({ cleared: true }),
    resolveCalibrationConflict: vi
      .fn()
      .mockRejectedValue(new Error('notImplemented')),
    listCalibrationConflicts: vi.fn().mockResolvedValue({ conflicts: [] }),
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
      return `77777777-7777-4777-8777-${sequence.toString().padStart(12, '0')}`;
    },
    now: () => now,
  };
}

function mount(api: CalibrationApi) {
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
  fireEvent.click(
    await screen.findByRole('button', { name: 'Calibrate a filament spool' }),
  );
  await pickPrinterByLabel(/Emulator cell A/);
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

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.localStorage?.clear();
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.localStorage?.clear();
});

describe('never-imported system profiles are selectable, not a dead end (issue #766)', () => {
  it('ARM A — a never-imported machine profile (guid: null) is enabled and selectable', async () => {
    const api = apiFor({
      machine: systemProfile(NEVER_IMPORTED_MACHINE_NAME, null, 'Bed 320×320'),
      process: systemProfile(NEVER_IMPORTED_PROCESS_NAME, null, '0.4 nozzle'),
      filament: systemProfile(NEVER_IMPORTED_FILAMENT_NAME, null, 'PLA'),
    });
    mount(api);
    await openWizardAndPickPrinter();

    const machineSelector = await screen.findByRole('combobox', {
      name: /machine profile/i,
    });
    const option = Array.from(machineSelector.querySelectorAll('option')).find(
      (candidate) => candidate.value.includes(NEVER_IMPORTED_MACHINE_NAME),
    );
    expect(option, 'never-imported machine option must render').toBeDefined();
    // The dead end this issue removes: a `disabled` attribute on the
    // option, plus an "identity unresolved" suffix telling the operator
    // it cannot be picked. Neither may be present any more.
    expect(option?.disabled).toBe(false);
    expect(option?.textContent).not.toMatch(/identity unresolved/i);
    expect(option?.textContent).not.toMatch(/cannot be selected/i);

    // It must be genuinely selectable, not merely "not disabled" in markup:
    // picking it must drive the cascade forward to the process/filament
    // lists exactly as an already-imported pick would.
    fireEvent.change(machineSelector, {
      target: { value: option?.value },
    });
    const processSelector = await screen.findByRole('combobox', {
      name: /process profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        processSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('process selector not populated');
    });
    const processOption = Array.from(
      processSelector.querySelectorAll('option'),
    ).find((candidate) =>
      candidate.value.includes(NEVER_IMPORTED_PROCESS_NAME),
    );
    expect(processOption?.disabled).toBe(false);
    expect(processOption?.textContent).not.toMatch(/identity unresolved/i);

    // Prove the process pick is genuinely selectable too — not merely
    // "not disabled" in markup — by driving the cascade all the way to the
    // never-imported filament option, exercising the full three-tier
    // never-imported printer (machine + process + filament all `guid:
    // null`), matching the "never-onboarded Qidi X-Plus 4" repro exactly.
    fireEvent.change(processSelector, {
      target: { value: processOption?.value },
    });
    const filamentSelector = await screen.findByRole('combobox', {
      name: /filament profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        filamentSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('filament selector not populated');
    });
    const filamentOption = Array.from(
      filamentSelector.querySelectorAll('option'),
    ).find((candidate) =>
      candidate.value.includes(NEVER_IMPORTED_FILAMENT_NAME),
    );
    expect(
      filamentOption,
      'never-imported filament option must render',
    ).toBeDefined();
    expect(filamentOption?.disabled).toBe(false);
    expect(filamentOption?.textContent).not.toMatch(/identity unresolved/i);
  });

  it('ARM B (control) — an already-imported machine profile remains enabled and selectable (no regression)', async () => {
    const api = apiFor({
      machine: systemProfile(
        IMPORTED_MACHINE_NAME,
        importedMachineGuid,
        'Bed 250×220',
      ),
      process: systemProfile(
        NEVER_IMPORTED_PROCESS_NAME,
        importedProcessGuid,
        '0.4 nozzle',
      ),
      filament: systemProfile(
        IMPORTED_FILAMENT_NAME,
        importedFilamentGuid,
        'PLA',
      ),
    });
    mount(api);
    await openWizardAndPickPrinter();

    const machineSelector = await screen.findByRole('combobox', {
      name: /machine profile/i,
    });
    const option = Array.from(machineSelector.querySelectorAll('option')).find(
      (candidate) => candidate.value.includes(IMPORTED_MACHINE_NAME),
    );
    expect(option, 'already-imported machine option must render').toBeDefined();
    expect(option?.disabled).toBe(false);
    expect(option?.textContent).not.toMatch(/identity unresolved/i);

    fireEvent.change(machineSelector, {
      target: { value: option?.value },
    });
    const processSelector = await screen.findByRole('combobox', {
      name: /process profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        processSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('process selector not populated');
    });
  });
});

describe('filament clone resolves identity on demand when previously unimported (issue #766)', () => {
  it('resolves the filament Guid via resolveSystemProfile before cloning, then clones with the resolved Guid', async () => {
    const resolveSystemProfile = vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profileId: resolvedFilamentGuid,
      imported: true,
    });
    const api = apiFor({
      machine: systemProfile(
        IMPORTED_MACHINE_NAME,
        importedMachineGuid,
        'Bed 250×220',
      ),
      process: systemProfile(
        NEVER_IMPORTED_PROCESS_NAME,
        importedProcessGuid,
        '0.4 nozzle',
      ),
      filament: systemProfile(NEVER_IMPORTED_FILAMENT_NAME, null, 'PLA'),
      resolveSystemProfile,
    });
    mount(api);
    await openWizardAndPickPrinter();

    const machineSelector = await screen.findByRole('combobox', {
      name: /machine profile/i,
    });
    fireEvent.change(machineSelector, {
      target: { value: `system:${IMPORTED_MACHINE_NAME}` },
    });
    const processSelector = await screen.findByRole('combobox', {
      name: /process profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        processSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('process selector not populated');
    });
    fireEvent.change(processSelector, {
      target: { value: `system:${NEVER_IMPORTED_PROCESS_NAME}` },
    });
    const filamentSelector = await screen.findByRole('combobox', {
      name: /filament profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        filamentSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('filament selector not populated');
    });
    fireEvent.change(filamentSelector, {
      target: { value: `system:${NEVER_IMPORTED_FILAMENT_NAME}` },
    });

    const nextButton = await screen.findByRole('button', {
      name: /Next — name the clone/i,
    });
    await waitFor(() => {
      if (nextButton.hasAttribute('disabled')) {
        throw new Error('Next button not enabled yet');
      }
    });
    fireEvent.click(nextButton);

    const cloneButton = await screen.findByRole('button', {
      name: /Clone this filament profile/i,
    });
    fireEvent.click(cloneButton);

    // The wizard must reach the same post-clone phase a normal clone
    // reaches — proving the operator is not stuck even though the
    // filament had never been imported.
    await screen.findByRole('button', { name: /Start Flow rate — pass 1/i });

    expect(resolveSystemProfile).toHaveBeenCalledTimes(1);
    expect(resolveSystemProfile).toHaveBeenCalledWith({
      profileId,
      printerModelId,
      profileType: 'filament',
      profileName: NEVER_IMPORTED_FILAMENT_NAME,
    });

    const clone = vi.mocked(api.cloneCalibrationFilamentProfile);
    expect(clone).toHaveBeenCalledTimes(1);
    expect(clone.mock.calls[0]?.[0]).toMatchObject({
      sourceProfileId: resolvedFilamentGuid,
    });

    // The resolve call must happen before the clone call — not merely
    // both happen, but in the right order — or the clone would race the
    // resolution and send the stale `null`.
    const resolveOrder = resolveSystemProfile.mock.invocationCallOrder[0];
    const cloneOrder = clone.mock.invocationCallOrder[0];
    expect(resolveOrder).toBeLessThan(cloneOrder as number);
  });

  it('control — an already-imported filament profile clones directly, without calling resolveSystemProfile', async () => {
    const resolveSystemProfile = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'resolveSystemProfile must not be called for an already-imported profile.',
        ),
      );
    const api = apiFor({
      machine: systemProfile(
        IMPORTED_MACHINE_NAME,
        importedMachineGuid,
        'Bed 250×220',
      ),
      process: systemProfile(
        NEVER_IMPORTED_PROCESS_NAME,
        importedProcessGuid,
        '0.4 nozzle',
      ),
      filament: systemProfile(
        IMPORTED_FILAMENT_NAME,
        importedFilamentGuid,
        'PLA',
      ),
      resolveSystemProfile,
    });
    mount(api);
    await openWizardAndPickPrinter();

    const machineSelector = await screen.findByRole('combobox', {
      name: /machine profile/i,
    });
    fireEvent.change(machineSelector, {
      target: { value: `system:${IMPORTED_MACHINE_NAME}` },
    });
    const processSelector = await screen.findByRole('combobox', {
      name: /process profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        processSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('process selector not populated');
    });
    fireEvent.change(processSelector, {
      target: { value: `system:${NEVER_IMPORTED_PROCESS_NAME}` },
    });
    const filamentSelector = await screen.findByRole('combobox', {
      name: /filament profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        filamentSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('filament selector not populated');
    });
    fireEvent.change(filamentSelector, {
      target: { value: `system:${IMPORTED_FILAMENT_NAME}` },
    });

    const nextButton = await screen.findByRole('button', {
      name: /Next — name the clone/i,
    });
    await waitFor(() => {
      if (nextButton.hasAttribute('disabled')) {
        throw new Error('Next button not enabled yet');
      }
    });
    fireEvent.click(nextButton);

    const cloneButton = await screen.findByRole('button', {
      name: /Clone this filament profile/i,
    });
    fireEvent.click(cloneButton);
    await screen.findByRole('button', { name: /Start Flow rate — pass 1/i });

    expect(resolveSystemProfile).not.toHaveBeenCalled();
    const clone = vi.mocked(api.cloneCalibrationFilamentProfile);
    expect(clone.mock.calls[0]?.[0]).toMatchObject({
      sourceProfileId: importedFilamentGuid,
    });
  });

  it('refuses (with a banner, not a silent stall) when the printer has no catalog model to resolve a never-imported filament against', async () => {
    const resolveSystemProfile = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'resolveSystemProfile must not be called without a printerModelId.',
        ),
      );
    const api = apiFor({
      machine: systemProfile(
        IMPORTED_MACHINE_NAME,
        importedMachineGuid,
        'Bed 250×220',
      ),
      process: systemProfile(
        NEVER_IMPORTED_PROCESS_NAME,
        importedProcessGuid,
        '0.4 nozzle',
      ),
      filament: systemProfile(NEVER_IMPORTED_FILAMENT_NAME, null, 'PLA'),
      resolveSystemProfile,
      printer: printerCandidate({ printerModelId: null }),
    });
    mount(api);
    await openWizardAndPickPrinter();

    const machineSelector = await screen.findByRole('combobox', {
      name: /machine profile/i,
    });
    fireEvent.change(machineSelector, {
      target: { value: `system:${IMPORTED_MACHINE_NAME}` },
    });
    const processSelector = await screen.findByRole('combobox', {
      name: /process profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        processSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('process selector not populated');
    });
    fireEvent.change(processSelector, {
      target: { value: `system:${NEVER_IMPORTED_PROCESS_NAME}` },
    });
    const filamentSelector = await screen.findByRole('combobox', {
      name: /filament profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        filamentSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('filament selector not populated');
    });
    fireEvent.change(filamentSelector, {
      target: { value: `system:${NEVER_IMPORTED_FILAMENT_NAME}` },
    });

    const nextButton = await screen.findByRole('button', {
      name: /Next — name the clone/i,
    });
    await waitFor(() => {
      if (nextButton.hasAttribute('disabled')) {
        throw new Error('Next button not enabled yet');
      }
    });
    fireEvent.click(nextButton);

    const cloneButton = await screen.findByRole('button', {
      name: /Clone this filament profile/i,
    });
    fireEvent.click(cloneButton);

    // This narrow edge case (no catalog model association at all) is
    // unchanged by #766 — it was never resolvable before either. The
    // requirement is that it fails loudly with an actionable banner, not
    // that it becomes resolvable.
    await screen.findByText(/could not be resolved/i);
    expect(resolveSystemProfile).not.toHaveBeenCalled();
    expect(api.cloneCalibrationFilamentProfile).not.toHaveBeenCalled();
  });

  it('persists a resumable wizard record after cloning a never-imported filament (the resolved Guid is folded back, not lost)', async () => {
    const resolveSystemProfile = vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profileId: resolvedFilamentGuid,
      imported: true,
    });
    const saveFilamentCalibrationWizardState: CalibrationApi['saveFilamentCalibrationWizardState'] =
      vi.fn().mockResolvedValue({ saved: true });
    const api = apiFor({
      machine: systemProfile(
        IMPORTED_MACHINE_NAME,
        importedMachineGuid,
        'Bed 250×220',
      ),
      process: systemProfile(
        NEVER_IMPORTED_PROCESS_NAME,
        importedProcessGuid,
        '0.4 nozzle',
      ),
      filament: systemProfile(NEVER_IMPORTED_FILAMENT_NAME, null, 'PLA'),
      resolveSystemProfile,
      saveFilamentCalibrationWizardState,
    });
    mount(api);
    await openWizardAndPickPrinter();

    const machineSelector = await screen.findByRole('combobox', {
      name: /machine profile/i,
    });
    fireEvent.change(machineSelector, {
      target: { value: `system:${IMPORTED_MACHINE_NAME}` },
    });
    const processSelector = await screen.findByRole('combobox', {
      name: /process profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        processSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('process selector not populated');
    });
    fireEvent.change(processSelector, {
      target: { value: `system:${NEVER_IMPORTED_PROCESS_NAME}` },
    });
    const filamentSelector = await screen.findByRole('combobox', {
      name: /filament profile/i,
    });
    await waitFor(() => {
      const populated = Array.from(
        filamentSelector.querySelectorAll('option'),
      ).some((candidate) => candidate.value.length > 0);
      if (!populated) throw new Error('filament selector not populated');
    });
    fireEvent.change(filamentSelector, {
      target: { value: `system:${NEVER_IMPORTED_FILAMENT_NAME}` },
    });

    const nextButton = await screen.findByRole('button', {
      name: /Next — name the clone/i,
    });
    await waitFor(() => {
      if (nextButton.hasAttribute('disabled')) {
        throw new Error('Next button not enabled yet');
      }
    });
    fireEvent.click(nextButton);

    const cloneButton = await screen.findByRole('button', {
      name: /Clone this filament profile/i,
    });
    fireEvent.click(cloneButton);
    await screen.findByRole('button', { name: /Start Flow rate — pass 1/i });

    // If the resolved Guid were only kept in a local variable at clone
    // time and never folded back onto `picks.filamentGuid`, the
    // persistence effect (which reads `picks.filamentGuid`) would see a
    // permanently-null base filament Guid and never save a resumable
    // record — silently losing restart/resume for every never-imported
    // filament even though the clone itself succeeded.
    await waitFor(() => {
      expect(saveFilamentCalibrationWizardState).toHaveBeenCalled();
    });
    const calls = vi.mocked(saveFilamentCalibrationWizardState).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0].state.baseFilamentGuid).toBe(resolvedFilamentGuid);
  });
});
