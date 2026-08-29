/**
 * Renderer test for the filament calibration wizard.
 *
 * The step-sequencing test at the top is the acceptance-suite equivalent of
 * `tests/filamentCalibration.acceptance.test.ts:884` — that test proves the
 * wire mapper reads the updated `filament_flow_ratio` after a step 1
 * write-back; this test proves the wizard does not undermine that guarantee
 * by re-cloning the filament between steps. If the wizard buggy-re-cloned,
 * `updateCalibrationFilamentProfileMeasurement` would end up called with a
 * NEW `customProfileId` on step 2, and the wire mapper would then read the
 * source's stale flow ratio. The control assertion is the negative:
 * `cloneCalibrationFilamentProfile` is called exactly ONCE across two steps.
 *
 * Every assertion is on operator-observable outcomes (rendered DOM,
 * enabled/disabled state) OR on the exact IPC argument sent — never on
 * internal component shape.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CalibrationListPrintersResponse,
  type CalibrationCustomProfileRef,
  type CalibrationPrinterCandidate,
  type CalibrationSliceJobSnapshot,
  type CalibrationSlicerProfileRef,
} from '@shared/ipc';
import { CalibrationWorkspace } from '../src/renderer/calibration';
import type {
  CalibrationApi,
  CalibrationEnvironment,
} from '../src/renderer/calibration/api';
import { pickPrinterByLabel } from './fixtures/filamentWizardPrinterPicker';

const profileId = '11111111-1111-4111-8111-111111111111';
const printerIdA = '33333333-3333-4333-8333-333333333301';
const machineGuid = '22222222-2222-4222-8222-222222222201';
const processGuid = '22222222-2222-4222-8222-222222222202';
const filamentGuid = '22222222-2222-4222-8222-222222222203';
const cloneGuid = '44444444-4444-4444-8444-444444444444';
const jobIdOne = '55555555-5555-4555-8555-555555555501';
const jobIdTwo = '55555555-5555-4555-8555-555555555502';
const now = '2026-08-24T02:29:44.441Z';
const SAMPLE_MACHINE_NAME = 'K1 Max 0.4';
const SAMPLE_PROCESS_NAME = '0.20mm Standard';
const SAMPLE_FILAMENT_NAME = 'Generic PLA';

function systemProfile(
  name: string,
  guid: string,
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

function printerCandidate(): CalibrationPrinterCandidate {
  return {
    printerId: printerIdA,
    displayName: 'Emulator cell A',
    printerModel: 'Klipper machine',
    printerModelId: null,
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
      message: `${name}: not implemented in wizard test.`,
      retryable: false,
      retryAfterSeconds: null,
      reference: null,
    },
  };
}

function completedSnapshot(id: string): CalibrationSliceJobSnapshot {
  return {
    id,
    status: 'Completed',
    progressPercent: 100,
    progressMessage: 'Slicing complete',
    queuedAt: now,
    startedAt: now,
    completedAt: now,
    errorMessage: null,
    errorDetail: null,
    layoutDegradation: null,
    failureReason: null,
    failureHint: null,
    estimatedPrintTimeSeconds: 900,
    filamentUsedGrams: 12.5,
    workerId: 'worker-01',
    modelFileName: 'flow_rate_pass_1.3mf',
    slicerEngine: 'OrcaSlicer',
    artifactsRoute: null,
  };
}

/**
 * A fresh API stub that resolves every wire the wizard reads through.
 * Non-wizard channels use `notImplemented` sentinel so an unexpected touch
 * is loud in the assertion output rather than a silent `undefined`.
 */
function wizardApi(overrides: Partial<CalibrationApi> = {}): CalibrationApi {
  const base: CalibrationApi = {
    getCalibrationAvailability: vi.fn().mockResolvedValue(availability()),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockResolvedValue(null),
    saveCalibrationWorkspaceState: vi.fn(),
    listCalibrationPrinters: vi.fn().mockResolvedValue(
      CalibrationListPrintersResponse.parse({
        printers: [printerCandidate()],
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
      machineProfiles: [
        systemProfile(SAMPLE_MACHINE_NAME, machineGuid, 'Bed 300×300'),
      ],
      processProfiles: [
        systemProfile(SAMPLE_PROCESS_NAME, processGuid, '0.4 nozzle'),
      ],
      filamentProfiles: [
        systemProfile(SAMPLE_FILAMENT_NAME, filamentGuid, 'PLA'),
      ],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationMachineProfilesForModel: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [
        systemProfile(SAMPLE_MACHINE_NAME, machineGuid, 'Bed 300×300'),
      ],
      noModelAlias: false,
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationProcessProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [systemProfile(SAMPLE_PROCESS_NAME, processGuid, '0.4 nozzle')],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationFilamentProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [systemProfile(SAMPLE_FILAMENT_NAME, filamentGuid, 'PLA')],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationCustomProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      ...noCustomProfiles(),
      fetchedAt: now,
    }),
    resolveSystemProfile: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profileId: filamentGuid,
      imported: false,
    }),
    cloneCalibrationFilamentProfile: vi.fn().mockResolvedValue({
      status: 'ok',
      clone: {
        id: cloneGuid,
        name: 'PLA — Prusament Galaxy Black',
        profileType: 'filament' as const,
        isSystem: false as const,
      },
    }),
    submitCalibrationSlice: vi
      .fn()
      .mockResolvedValueOnce({
        status: 'ok',
        job: {
          jobId: jobIdOne,
          status: 'Queued' as const,
          queuedAt: now,
          queuePosition: 1,
        },
      })
      .mockResolvedValueOnce({
        status: 'ok',
        job: {
          jobId: jobIdTwo,
          status: 'Queued' as const,
          queuedAt: now,
          queuePosition: 1,
        },
      }),
    getCalibrationSliceJobStatus: vi
      .fn()
      .mockImplementation((request: { jobId: string }) =>
        Promise.resolve({
          status: 'ok' as const,
          snapshot: completedSnapshot(request.jobId),
          terminal: 'completed' as const,
          nextPollDelayMs: null,
          cappedOut: false,
        }),
      ),
    sendCalibrationSliceToPrinter: vi.fn().mockResolvedValue({
      status: 'ok',
      result: {
        jobId: jobIdOne,
        printerId: printerIdA,
        fileName: 'flow_rate_pass_1.gcode',
        printStarted: false,
        message: 'Uploaded to printer queue.',
      },
    }),
    updateCalibrationFilamentProfileMeasurement: vi.fn().mockResolvedValue({
      status: 'ok',
      updated: {
        id: cloneGuid,
        name: 'PLA — Prusament Galaxy Black',
        profileType: 'filament' as const,
        isSystem: false as const,
      },
    }),
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
  };
  return { ...base, ...overrides };
}

function deterministicEnvironment(): CalibrationEnvironment {
  let sequence = 0;
  return {
    createId: () => {
      sequence += 1;
      return `bbbbbbbb-bbbb-4bbb-8bbb-${sequence.toString().padStart(12, '0')}`;
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

async function pickAllProfilesAndProceedToClone(): Promise<void> {
  const machineSelector = await screen.findByRole('combobox', {
    name: /machine profile/i,
  });
  fireEvent.change(machineSelector, {
    target: { value: `system:${SAMPLE_MACHINE_NAME}` },
  });
  const processSelector = await screen.findByRole('combobox', {
    name: /process profile/i,
  });
  await waitFor(() => {
    const populated = Array.from(
      processSelector.querySelectorAll('option'),
    ).some((option) => option.value.length > 0);
    if (!populated) throw new Error('process selector not populated');
  });
  fireEvent.change(processSelector, {
    target: { value: `system:${SAMPLE_PROCESS_NAME}` },
  });
  const filamentSelector = await screen.findByRole('combobox', {
    name: /filament profile/i,
  });
  await waitFor(() => {
    const populated = Array.from(
      filamentSelector.querySelectorAll('option'),
    ).some((option) => option.value.length > 0);
    if (!populated) throw new Error('filament selector not populated');
  });
  fireEvent.change(filamentSelector, {
    target: { value: `system:${SAMPLE_FILAMENT_NAME}` },
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
}

async function performCloneStep(): Promise<void> {
  const cloneButton = await screen.findByRole('button', {
    name: /Clone this filament profile/i,
  });
  fireEvent.click(cloneButton);
  await screen.findByRole('button', {
    name: /Start Flow rate — pass 1/i,
  });
}

async function runOneMethodEndToEnd(
  methodButtonName: RegExp,
  measurementFieldLabel: RegExp,
  measurementValue: string,
  extra?: { readonly secondFieldLabel: RegExp; readonly secondValue: string },
): Promise<void> {
  fireEvent.click(
    await screen.findByRole('button', { name: methodButtonName }),
  );
  await screen.findByRole('progressbar', { name: /Slice progress/i });
  const uploadOnly = await screen.findByRole('button', {
    name: /Upload gcode only/i,
  });
  fireEvent.click(uploadOnly);
  const input = await screen.findByLabelText(measurementFieldLabel);
  fireEvent.change(input, { target: { value: measurementValue } });
  if (extra !== undefined) {
    const second = await screen.findByLabelText(extra.secondFieldLabel);
    fireEvent.change(second, { target: { value: extra.secondValue } });
  }
  fireEvent.click(
    await screen.findByRole('button', {
      name: /Save measurement and continue/i,
    }),
  );
  // The step advances back to the method picker.
  await waitFor(() => {
    if (screen.queryByLabelText(measurementFieldLabel) !== null) {
      throw new Error('measurement form still present after save');
    }
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

describe('FilamentCalibrationWizard step sequencing', () => {
  it('never re-clones between calibration steps — step 2 writes back on the same clone id as step 1', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    // Step 1 — flow rate pass 1
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    // Step 2 — temperature tower
    await runOneMethodEndToEnd(
      /Start Temperature tower/i,
      /^Nozzle temperature$/i,
      '215',
      {
        secondFieldLabel: /Initial layer nozzle temperature/i,
        secondValue: '220',
      },
    );

    // --- Assertions --------------------------------------------------------
    // 1. The clone was created exactly once. If the wizard buggy-re-cloned,
    //    step 2 would consume the second `cloneCalibrationFilamentProfile`
    //    call, and every subsequent measurement would land on a fresh
    //    profile — which is the failure the acceptance-suite control at
    //    `tests/filamentCalibration.acceptance.test.ts:884` proves.
    expect(
      (api.cloneCalibrationFilamentProfile as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toHaveLength(1);

    // 2. Both write-backs targeted the SAME `customProfileId`. This is the
    //    positive form of the step-sequencing invariant.
    const measurementCalls = (
      api.updateCalibrationFilamentProfileMeasurement as ReturnType<
        typeof vi.fn
      >
    ).mock.calls;
    expect(measurementCalls).toHaveLength(2);
    const firstCall = measurementCalls[0] as [
      { customProfileId: string; measurement: { method: string } },
    ];
    const secondCall = measurementCalls[1] as [
      { customProfileId: string; measurement: { method: string } },
    ];
    expect(firstCall[0].customProfileId).toBe(cloneGuid);
    expect(secondCall[0].customProfileId).toBe(cloneGuid);
    expect(firstCall[0].measurement.method).toBe('flow_rate_pass_1');
    expect(secondCall[0].measurement.method).toBe('temperature_tower');
  });
});

describe('FilamentCalibrationWizard method-picker capability boundary', () => {
  // Step 3 renders a `<p className="cal-notice">` stating the scope boundary
  // and pointing operators at OrcaSlicer for what falls outside it. Without an
  // assertion here, silently deleting the paragraph would ship green — the
  // copy is a capability boundary, not decorative hint text. Assert one stable
  // substring rather than the whole paragraph so operator-facing wording can
  // still be edited without breaking this test.
  //
  // The boundary moved once the wizard adopted every slice-able method (#775
  // -#779): it is no longer "these are not implemented yet" but "machine
  // calibrations have nothing to write to a filament profile". The paragraph
  // must state a boundary that is actually true — naming a method as
  // not-yet-supported after it ships is worse than saying nothing.
  it('names the machine-calibration scope boundary', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const notice = await screen.findByText(/input shaping and VFA/i);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent ?? '').toMatch(/firmware motion settings/i);
  });

  it('does not describe an adopted method as unavailable', async () => {
    // Control on the assertion above. The notice previously listed max
    // volumetric speed, pressure advance and retraction as things PrintFarmer
    // "cannot slice yet"; all three are now offered, so that copy would be
    // actively misleading rather than merely stale.
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const notice = await screen.findByText(/input shaping and VFA/i);
    const text = notice.textContent ?? '';
    expect(text).not.toMatch(/cannot slice/i);
    expect(text).not.toMatch(/does not offer/i);
  });
});

describe('FilamentCalibrationWizard startPrint safety gate', () => {
  it('the "Start print now" button stays disabled until the operator types START to confirm', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Start Flow rate — pass 1/i,
      }),
    );
    // Wait through submit → poll → sliceReady.
    const startPrintButton = await screen.findByRole('button', {
      name: /Start the calibration print now/i,
    });
    expect(startPrintButton).toBeDisabled();

    // Also verify the upload-only path IS enabled from the start — that is the
    // safe default we WANT the operator to have available.
    const uploadOnly = await screen.findByRole('button', {
      name: /Upload gcode only/i,
    });
    expect(uploadOnly).not.toBeDisabled();

    // Typing START enables the machine-moving action.
    fireEvent.change(await screen.findByLabelText(/Confirm start/i), {
      target: { value: 'START' },
    });
    expect(startPrintButton).not.toBeDisabled();
  });
});

describe('FilamentCalibrationWizard restart resilience', () => {
  // Once the clone exists, the wizard persists phase/method/in-flight job
  // through the additive `saveFilamentCalibrationWizardState` channel and
  // restores it via `getFilamentCalibrationWizardState` on mount — closing
  // the gap the previous build declared rather than closed. These tests
  // exercise the persist/restore round trip end-to-end, per the issue's
  // acceptance criterion.
  it('boots fresh into step 1 when nothing has been persisted for this profile', async () => {
    const api = wizardApi();
    mount(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Calibrate a filament spool' }),
    );
    expect(
      await screen.findByRole('group', {
        name: /Step 1 — machine, process, and base filament/i,
      }),
    ).toBeInTheDocument();
    expect(
      (api.cloneCalibrationFilamentProfile as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toHaveLength(0);
    expect(
      (api.getFilamentCalibrationWizardState as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toHaveLength(1);
    expect(
      (api.getFilamentCalibrationWizardState as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0],
    ).toEqual({ profileId });
  });

  it('persists an in-flight slice job while polling, saving through the new IPC channel', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Start Flow rate — pass 1/i,
      }),
    );
    await screen.findByRole('progressbar', { name: /Slice progress/i });

    await waitFor(() => {
      const calls = (
        api.saveFilamentCalibrationWizardState as ReturnType<typeof vi.fn>
      ).mock.calls;
      const sawInFlightJob = calls.some(
        (call) =>
          (call[0] as { state: { inFlightJob: unknown } }).state.inFlightJob !==
          null,
      );
      if (!sawInFlightJob) {
        throw new Error(
          'expected a save call with a non-null inFlightJob while polling',
        );
      }
    });
    const savedStates = (
      api.saveFilamentCalibrationWizardState as ReturnType<typeof vi.fn>
    ).mock.calls.map(
      (call) =>
        (call[0] as { state: { cloneId: string; phase: string } }).state,
    );
    expect(savedStates.every((state) => state.cloneId === cloneGuid)).toBe(
      true,
    );
    // pollingSlice is one of the four resumable phases; submittingSlice
    // (the transient phase the click briefly passed through) is never
    // saved, since `mapPhaseForPersistence` folds it to `methodPicker` and
    // clears `inFlightJob` before the network call has a jobId to report.
    expect(savedStates.map((state) => state.phase)).not.toContain(
      'submittingSlice',
    );
  });

  it('resumes an in-progress calibration on mount from a persisted record, and lets the operator continue with the next method', async () => {
    const persisted = {
      schemaVersion: 1 as const,
      printerId: printerIdA,
      printerModelId: null,
      machineName: SAMPLE_MACHINE_NAME,
      processName: SAMPLE_PROCESS_NAME,
      baseFilamentName: SAMPLE_FILAMENT_NAME,
      baseFilamentGuid: filamentGuid,
      cloneId: cloneGuid,
      cloneName: 'PLA — Prusament Galaxy Black',
      completedMethods: ['flow_rate_pass_1'] as const,
      currentMethod: null,
      inFlightJob: null,
      phase: 'methodPicker' as const,
      updatedAt: now,
    };
    const api = wizardApi({
      getFilamentCalibrationWizardState: vi.fn().mockResolvedValue(persisted),
    });
    mount(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Calibrate a filament spool' }),
    );

    // The wizard resumed straight into the method picker — it never
    // re-rendered step 1's profile-selection fieldset or re-cloned.
    expect(
      await screen.findByRole('button', {
        name: /Start Temperature tower/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('group', {
        name: /Step 1 — machine, process, and base filament/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      (api.cloneCalibrationFilamentProfile as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toHaveLength(0);
    expect(
      await screen.findByText(/Resumed filament calibration/i),
    ).toBeInTheDocument();

    // Continuing into the next method submits against the SAME resumed
    // clone and profile-selection names — the whole point of resuming
    // rather than starting over.
    fireEvent.click(
      await screen.findByRole('button', { name: /Start Temperature tower/i }),
    );
    await waitFor(() => {
      expect(
        (api.submitCalibrationSlice as ReturnType<typeof vi.fn>).mock.calls,
      ).toHaveLength(1);
    });
    const submitCall = (api.submitCalibrationSlice as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0] as {
      machineProfileName: string;
      processProfileName: string;
      filamentProfileName: string;
      method: string;
    };
    expect(submitCall.machineProfileName).toBe(SAMPLE_MACHINE_NAME);
    expect(submitCall.processProfileName).toBe(SAMPLE_PROCESS_NAME);
    expect(submitCall.filamentProfileName).toBe(persisted.cloneName);
    expect(submitCall.method).toBe('temperature_tower');
  });

  it('resumes polling an in-flight slice job on mount, without resubmitting it', async () => {
    // Distinct from the methodPicker-resume test above: this is the case
    // the acceptance criteria calls out explicitly — restart happens while
    // a slice job is in flight, and the wizard must pick the poll loop back
    // up against the SAME jobId rather than re-submitting or losing track
    // of it.
    const resumedJobId = 'job-resumed-after-restart';
    const persisted = {
      schemaVersion: 1 as const,
      printerId: printerIdA,
      printerModelId: null,
      machineName: SAMPLE_MACHINE_NAME,
      processName: SAMPLE_PROCESS_NAME,
      baseFilamentName: SAMPLE_FILAMENT_NAME,
      baseFilamentGuid: filamentGuid,
      cloneId: cloneGuid,
      cloneName: 'PLA — Prusament Galaxy Black',
      completedMethods: [],
      currentMethod: 'flow_rate_pass_1' as const,
      inFlightJob: {
        jobId: resumedJobId,
        method: 'flow_rate_pass_1' as const,
        submittedAt: now,
        pollAttempt: 2,
        lastStatus: 'Processing' as const,
      },
      phase: 'pollingSlice' as const,
      updatedAt: now,
    };
    const api = wizardApi({
      getFilamentCalibrationWizardState: vi.fn().mockResolvedValue(persisted),
    });
    mount(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Calibrate a filament spool' }),
    );

    // The wizard resumed straight into polling — never re-submitted a slice
    // (submitCalibrationSlice is never called) and instead asked the server
    // about the SAME job id the persisted record carried.
    await waitFor(() => {
      expect(
        (api.getCalibrationSliceJobStatus as ReturnType<typeof vi.fn>).mock
          .calls.length,
      ).toBeGreaterThan(0);
    });
    const statusCall = (
      api.getCalibrationSliceJobStatus as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as { profileId: string; jobId: string };
    expect(statusCall.profileId).toBe(profileId);
    expect(statusCall.jobId).toBe(resumedJobId);
    expect(
      (api.submitCalibrationSlice as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it('clears the persisted record when the operator explicitly starts over', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    fireEvent.click(await screen.findByRole('button', { name: 'Start over' }));

    await waitFor(() => {
      expect(
        (api.clearFilamentCalibrationWizardState as ReturnType<typeof vi.fn>)
          .mock.calls,
      ).toHaveLength(1);
    });
    expect(
      (api.clearFilamentCalibrationWizardState as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0],
    ).toEqual({ profileId });
  });
});

describe('FilamentCalibrationWizard error surfacing', () => {
  it('surfaces `unsupportedCalibrationMethod` as actionable operator text rather than a raw code', async () => {
    const api = wizardApi({
      submitCalibrationSlice: vi.fn().mockResolvedValue({
        status: 'error',
        error: {
          code: 'unsupportedCalibrationMethod',
          message:
            'PrintFarmer does not recognise this calibration method on this build.',
          retryable: false,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    // The wizard is now at the method picker. Clicking pass 1 triggers
    // `submitCalibrationSlice`, which the stub answers with an
    // `unsupportedCalibrationMethod` error — the banner should surface
    // the actionable copy, never the raw code.
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Start Flow rate — pass 1/i,
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/not supported by the server/i);
    // Control: the error banner must NEVER surface the raw wire code — that
    // was the anti-pattern the reframe called out.
    expect(alert.textContent ?? '').not.toMatch(/unsupportedCalibrationMethod/);
  });
});

// ---------------------------------------------------------------------------
// Polling loop — rate limit, not effect-restart loop
// ---------------------------------------------------------------------------
//
// PR #753 shipped a polling `useEffect` whose dep array included the
// `working.inFlightJob` object itself. On every non-terminal poll, the
// effect body constructed a new `inFlightJob` object to increment
// `pollAttempt` — which changed the dep identity, tore the effect down
// (cancelling the `setTimeout` that was just scheduled to honour
// `response.nextPollDelayMs`), re-ran the effect, and fired `void runPoll()`
// again immediately. The advertised delay became dead code and the wizard
// polled at IPC round-trip speed. Bishop measured 4 polls in 500 ms against
// a mock advertising 2000 ms. The driver caps at 240 attempts, so a slice
// job that legitimately takes minutes exhausted the cap in ~2 seconds and
// surfaced a spurious `sliceJobTimeout` on every real print.
//
// Four wizard tests, two approving reviewers, and Hicks's 23-test acceptance
// suite all passed over this defect because none of them asserted the
// poll rate. This test does. It uses fake timers to isolate the schedule,
// asserts strict call-count-at-time invariants, and threads a positive
// control (`pollAttempt` increments correctly across a ref boundary) so the
// counter reset semantic is not silently regressed either.

describe('FilamentCalibrationWizard polling loop', () => {
  it('honours `nextPollDelayMs` between polls — the effect does not restart on every poll-counter update', async () => {
    const nextPollDelayMs = 2000;
    let pollCount = 0;
    const pollMock = vi.fn().mockImplementation(() => {
      pollCount += 1;
      if (pollCount >= 4) {
        return Promise.resolve({
          status: 'ok' as const,
          snapshot: completedSnapshot(jobIdOne),
          terminal: 'completed' as const,
          nextPollDelayMs: null,
          cappedOut: false,
        });
      }
      return Promise.resolve({
        status: 'ok' as const,
        snapshot: {
          ...completedSnapshot(jobIdOne),
          status: 'Working' as const,
          completedAt: null,
          progressPercent: 25 * pollCount,
        },
        terminal: null,
        nextPollDelayMs,
        cappedOut: false,
      });
    });
    const api = wizardApi({ getCalibrationSliceJobStatus: pollMock });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    // Grab the Start button while real timers are still active — waitFor
    // uses setTimeout internally, so faked timers block findByRole.
    const startPass1 = await screen.findByRole('button', {
      name: /Start Flow rate — pass 1/i,
    });

    // Fake timers from here on so the polling schedule is observable. Only
    // fake setTimeout/clearTimeout — leaving `queueMicrotask` and everything
    // else real avoids stalling React's internal scheduling.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(startPass1);
    // Drain microtasks: submit resolves → phase transitions → effect fires
    // → first `runPoll()` awaits the mock → resolves. Each `await` yield
    // advances the promise chain by one step; the loop caps at a small
    // constant so a regression that stalls the initial poll fails fast
    // rather than hanging on the drain.
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
      if (pollMock.mock.calls.length > 0) break;
    }

    // Exactly one poll has fired. Under the buggy code, this assertion fails:
    // the effect re-mount fires `runPoll` back-to-back as fast as the mock
    // resolves, entirely inside the microtask queue we just drained — no
    // `advanceTimersByTime` needed. Discrimination confirmed on this exact
    // test against the pre-fix wizard: expected 1, received 4 (all four
    // mock responses consumed inside the same microtask drain, terminating
    // the loop on the terminal response). Same predicate, same data,
    // opposite result — that's the control this test needs to be
    // self-defending against a future regression.
    expect(pollMock).toHaveBeenCalledTimes(1);
    const pollArgs = (call: number): { pollAttempt: number } =>
      pollMock.mock.calls[call]?.[0] as { pollAttempt: number };
    expect(pollMock.mock.calls[0]?.[0]).toMatchObject({
      profileId,
      jobId: jobIdOne,
      pollAttempt: 0,
    });

    // Below the advertised delay, no additional poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(nextPollDelayMs - 1);
      await Promise.resolve();
    });
    expect(pollMock).toHaveBeenCalledTimes(1);

    // Crossing the threshold, the second poll fires — with `pollAttempt: 1`.
    // The positive control on the counter: the ref-hoisted counter must
    // still increment monotonically across polls, or the main-side
    // `computeSlicePollHint` would misclassify the backoff schedule.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pollMock).toHaveBeenCalledTimes(2);
    expect(pollArgs(1).pollAttempt).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(nextPollDelayMs);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pollMock).toHaveBeenCalledTimes(3);
    expect(pollArgs(2).pollAttempt).toBe(2);

    // Fourth poll is terminal; wizard advances to `sliceReady`.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(nextPollDelayMs);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pollMock).toHaveBeenCalledTimes(4);
    expect(pollArgs(3).pollAttempt).toBe(3);

    vi.useRealTimers();
    await screen.findByRole('button', {
      name: /Start the calibration print now/i,
    });
  });

  it('surfaces a terminal slice failure to the operator and returns to a recoverable phase', async () => {
    const pollMock = vi.fn().mockResolvedValue({
      status: 'ok' as const,
      snapshot: {
        ...completedSnapshot(jobIdOne),
        status: 'Failed' as const,
        completedAt: null,
        errorMessage:
          'The worker could not slice the calibration model bundle.',
      },
      terminal: 'failed' as const,
      nextPollDelayMs: null,
      cappedOut: false,
    });
    const api = wizardApi({ getCalibrationSliceJobStatus: pollMock });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Start Flow rate — pass 1/i,
      }),
    );

    // The banner surfaces the server's failure reason verbatim — the
    // operator needs to see what went wrong, not "poll returned failed".
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/slice job failed on the server/i);
    expect(alert.textContent ?? '').toMatch(
      /could not slice the calibration model bundle/i,
    );

    // Recoverable: the wizard is back at the method picker, and clicking
    // the same method dispatches a fresh submit. If the wizard stranded in
    // `pollingSlice` on failure, the operator would have no exit.
    const restartButton = await screen.findByRole('button', {
      name: /Start Flow rate — pass 1/i,
    });
    expect(restartButton).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// sendToPrinter — physical-action idempotency and audit-trail attribution
// ---------------------------------------------------------------------------

describe('FilamentCalibrationWizard sendToPrinter wire shape', () => {
  it('sends `startPrint: true` with a non-null operatorAcknowledgement only after the operator typed START', async () => {
    const sendMock = vi.fn().mockResolvedValue({
      status: 'ok' as const,
      result: {
        jobId: jobIdOne,
        printerId: printerIdA,
        fileName: 'flow_rate_pass_1.gcode',
        printStarted: true,
        message: 'Print started.',
      },
    });
    const api = wizardApi({ sendCalibrationSliceToPrinter: sendMock });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Start Flow rate — pass 1/i,
      }),
    );
    const startButton = await screen.findByRole('button', {
      name: /Start the calibration print now/i,
    });
    expect(startButton).toBeDisabled();

    fireEvent.change(await screen.findByLabelText(/Confirm start/i), {
      target: { value: 'START' },
    });
    await waitFor(() => {
      if (startButton.hasAttribute('disabled')) {
        throw new Error('Start button still disabled');
      }
    });
    fireEvent.click(startButton);

    await waitFor(() => {
      if (sendMock.mock.calls.length < 1) {
        throw new Error('send not yet called');
      }
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0]?.[0] as {
      startPrint: boolean;
      operatorAcknowledgement: string | null;
    };
    expect(call.startPrint).toBe(true);
    // The acknowledgement is `filament-cal:{id}:{iso}` — an identity +
    // timestamp attributable to this session. Its presence is what lets
    // the audit trail tie the physical action to a real operator; a null
    // here would mean an unattributed machine motion, which is what the
    // upload-only path deliberately produces.
    expect(call.operatorAcknowledgement).not.toBeNull();
    expect(call.operatorAcknowledgement).toMatch(
      /^filament-cal:[0-9a-f-]+:[0-9T:.Z-]+$/,
    );
  });

  it('sends `startPrint: false` with a null operatorAcknowledgement on Upload-only', async () => {
    const sendMock = vi.fn().mockResolvedValue({
      status: 'ok' as const,
      result: {
        jobId: jobIdOne,
        printerId: printerIdA,
        fileName: 'flow_rate_pass_1.gcode',
        printStarted: false,
        message: 'Uploaded to printer queue.',
      },
    });
    const api = wizardApi({ sendCalibrationSliceToPrinter: sendMock });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Start Flow rate — pass 1/i,
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Upload gcode only/i }),
    );

    await waitFor(() => {
      if (sendMock.mock.calls.length < 1) {
        throw new Error('send not yet called');
      }
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const call = sendMock.mock.calls[0]?.[0] as {
      startPrint: boolean;
      operatorAcknowledgement: string | null;
    };
    expect(call.startPrint).toBe(false);
    // The null here is load-bearing — this is the "no physical action was
    // confirmed" branch, and attributing a non-null acknowledgement to it
    // would misrepresent the audit trail. The negation is exactly what
    // Hicks's wire-level suite covers on the main side; this test proves
    // the UI that drives it does not smuggle an acknowledgement through.
    expect(call.operatorAcknowledgement).toBeNull();
  });

  it('a synchronous double-click on Upload gcode only dispatches sendCalibrationSliceToPrinter exactly once', async () => {
    // Physical safety: sending calibration gcode with `startPrint: true`
    // moves a machine that heats to 300 °C. `startPrint: false` is safer
    // (the printer waits for a manual start) but still uploads gcode. Even
    // for the safer branch, a double-dispatch would race two idempotency
    // keys against the wire and depend on the server to notice — an
    // upstream guarantee for an action that touches a physical device.
    // The `inFlightRef` guard is the load-bearing local defence; the wire
    // idempotency key is the last line.
    let resolveSend: ((value: unknown) => void) | null = null;
    const sendMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    const api = wizardApi({ sendCalibrationSliceToPrinter: sendMock });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Start Flow rate — pass 1/i,
      }),
    );
    const uploadButton = await screen.findByRole('button', {
      name: /Upload gcode only/i,
    });
    // Two clicks within a single synchronous batch. The first click's
    // `setBusy(true)` has not committed yet, so the button is still
    // enabled and its handler still runs on the second click. Without the
    // ref guard, both handlers dispatch. With it, the second short-circuits.
    // `act` here batches the two dispatches; the `async` wrapper is not
    // strictly required (no await inside) but keeps the callback shape
    // consistent with the follow-up `act` and would tolerate an eventual
    // internal `await` from React's future concurrent scheduling.
    act(() => {
      fireEvent.click(uploadButton);
      fireEvent.click(uploadButton);
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    // Unblock the pending promise so React can settle for cleanup — wrap in
    // act so the phase transition it triggers is not surfaced as an
    // "update outside act" warning.
    if (resolveSend !== null) {
      const resolver = resolveSend as (value: unknown) => void;
      await act(async () => {
        resolver({
          status: 'ok' as const,
          result: {
            jobId: jobIdOne,
            printerId: printerIdA,
            fileName: 'flow_rate_pass_1.gcode',
            printStarted: false,
            message: 'Uploaded.',
          },
        });
        await Promise.resolve();
      });
    }
  });
});
