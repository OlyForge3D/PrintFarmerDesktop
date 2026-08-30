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
  within,
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
const projectGuid = '66666666-6666-4666-8666-666666666601';
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
    createCalibrationProject: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      project: {
        id: projectGuid,
        name: 'PLA — Prusament Galaxy Black (calibration project)',
        lifecycleStatus: 'Active',
        experienceMode: 'Coach',
        printerId: printerIdA,
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
      .mockResolvedValue(notImplemented('setCalibrationMethodDisposition')),
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
    submitCalibrationObservation: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      observationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }),
    completeCalibrationProject: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      lifecycleStatus: 'Completed',
      promotedProfileId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
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

describe('FilamentCalibrationWizard draft-profile write-back and completion (issue #795)', () => {
  it('dual-writes each measurement to submitCalibrationObservation using the projectId captured from project creation, alongside the existing clone write-back', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    // The clone write-back (kept for slicing continuity) still happened...
    expect(
      (
        api.updateCalibrationFilamentProfileMeasurement as ReturnType<
          typeof vi.fn
        >
      ).mock.calls,
    ).toHaveLength(1);
    // ...and the new draft-profile submission ALSO happened, addressed at
    // the project created for this wizard run.
    await waitFor(() => {
      expect(
        (api.submitCalibrationObservation as ReturnType<typeof vi.fn>).mock
          .calls,
      ).toHaveLength(1);
    });
    const [observationRequest] = (
      api.submitCalibrationObservation as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [
      {
        profileId: string;
        projectId: string;
        measurement: { method: string };
      },
    ];
    expect(observationRequest.profileId).toBe(profileId);
    expect(observationRequest.projectId).toBe(projectGuid);
    expect(observationRequest.measurement.method).toBe('flow_rate_pass_1');
  });

  it('a failed draft-profile submission does not interrupt the wizard — the clone write-back already landed', async () => {
    const api = wizardApi({
      submitCalibrationObservation: vi
        .fn()
        .mockRejectedValue(new Error('network blip')),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    // The method still completed — back at the method picker with the
    // method marked done — even though the background submission rejected.
    await screen.findByRole('button', {
      name: /Start Flow rate — pass 1 \(completed once\)/i,
    });
  });

  it('the "Finish calibration" action is disabled until at least one method has been completed', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const finishButton = await screen.findByRole('button', {
      name: /Finish calibration/i,
    });
    expect(finishButton).toBeDisabled();

    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Finish calibration/i }),
      ).not.toBeDisabled();
    });
  });

  it('control: finishing calibration calls completeCalibrationProject with the project id and reports the promoted profile', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    fireEvent.click(
      await screen.findByRole('button', { name: /Finish calibration/i }),
    );

    await waitFor(() => {
      expect(
        (api.completeCalibrationProject as ReturnType<typeof vi.fn>).mock.calls,
      ).toHaveLength(1);
    });
    const [completeRequest] = (
      api.completeCalibrationProject as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [{ profileId: string; projectId: string }];
    expect(completeRequest.profileId).toBe(profileId);
    expect(completeRequest.projectId).toBe(projectGuid);
    // The wizard resets to a fresh run once the project is complete — back
    // at step 1, ready to calibrate another spool.
    await screen.findByText(/1\. Pick the printer, machine profile/i);
  });

  it('abandon: leaving the wizard without finishing never calls completeCalibrationProject, so no SECOND (promoted) profile is created — the clone from step 1 remains a separate, disclosed limitation', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    // Operator walks away — no explicit "Finish calibration" click.
    expect(
      (api.completeCalibrationProject as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
    // The clone created at step 1 IS a real custom filament profile, and it
    // is NOT removed by abandoning — this test proves only that abandoning
    // does not ALSO trigger promotion of a second profile from the draft.
    // Eliminating the clone itself is out of scope for this issue until
    // OlyForge3D/PrintFarmer#2203 (non-admin clone cleanup) lands; see the
    // doc comment on `CalibrationCompleteCalibrationProjectResponse`.
    expect(
      (api.cloneCalibrationFilamentProfile as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toHaveLength(1);
  });

  it('a method whose draft-profile submission failed blocks "Finish calibration" until it is redone', async () => {
    const api = wizardApi({
      submitCalibrationObservation: vi.fn().mockResolvedValue({
        status: 'error' as const,
        error: {
          code: 'serverError' as const,
          message: 'draft profile temporarily unavailable',
          retryable: true,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    // The clone write-back succeeded, but the draft-profile submission
    // reported an error — Finish must stay disabled rather than silently
    // presenting an incomplete promoted profile as a success.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Finish calibration/i }),
      ).toBeDisabled();
    });
    await screen.findByText(/failed to sync to the draft profile/i);

    // Redoing the same method with a working API call clears the failure
    // and re-enables Finish.
    (
      api.submitCalibrationObservation as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      status: 'ok' as const,
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      observationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Finish calibration/i }),
      ).not.toBeDisabled();
    });
  });

  it('keeps the project id and lets the operator retry when completion reports an unconfirmed (null) promotion', async () => {
    const api = wizardApi({
      completeCalibrationProject: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        lifecycleStatus: 'Completed',
        promotedProfileId: null,
      }),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    fireEvent.click(
      await screen.findByRole('button', { name: /Finish calibration/i }),
    );

    await screen.findByText(/promotion could not be confirmed yet/i);
    // The wizard did NOT reset — the operator is still on the method
    // picker and can click "Finish calibration" again (idempotent retry),
    // rather than being stranded with a discarded project id.
    const finishButton = await screen.findByRole('button', {
      name: /Finish calibration/i,
    });
    expect(finishButton).not.toBeDisabled();
    fireEvent.click(finishButton);
    await waitFor(() => {
      expect(
        (api.completeCalibrationProject as ReturnType<typeof vi.fn>).mock.calls,
      ).toHaveLength(2);
    });
  });

  it('blocks "Finish calibration" while a draft-profile observation is still in flight, then re-enables it once the response arrives', async () => {
    // A deliberately unresolved promise: `completedMethods` flips to
    // include this method synchronously (from the clone write-back
    // resolving), but the observation dual-write is still pending. Finish
    // must stay disabled for the whole window the observation is
    // unsettled — not just after it eventually fails or succeeds.
    let resolveObservation!: (value: {
      status: 'ok';
      attemptId: string;
      observationId: string;
    }) => void;
    const pendingObservation = new Promise<{
      status: 'ok';
      attemptId: string;
      observationId: string;
    }>((resolve) => {
      resolveObservation = resolve;
    });
    const api = wizardApi({
      submitCalibrationObservation: vi.fn().mockReturnValue(pendingObservation),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    // The clone write-back landed and the method shows as completed, but
    // the draft-profile observation for it has not settled yet — Finish
    // must not be clickable in this window.
    await screen.findByRole('button', {
      name: /Start Flow rate — pass 1 \(completed once\)/i,
    });
    expect(
      screen.getByRole('button', { name: /Finish calibration/i }),
    ).toBeDisabled();
    await screen.findByText(/Still syncing/i);

    resolveObservation({
      status: 'ok',
      attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      observationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Finish calibration/i }),
      ).not.toBeDisabled();
    });
  });

  it('blocks redoing a method while its previous draft-profile observation is still syncing, then allows the redo once it settles', async () => {
    // Regression test for a reviewer-found server-ordering hazard: allowing
    // a SECOND, concurrent submitCalibrationObservation request for the
    // SAME method (by permitting a redo while the first request is still
    // in flight) means the server could receive them out of order — a
    // network re-order, not just a client one — and nothing on the client
    // can guarantee which one lands last in the draft profile. Rather than
    // reconciling that after the fact, the redo entry point itself must
    // refuse to start a second request until the first has settled. This
    // makes the earlier "two in-flight requests for one method" scenario
    // unreachable through the UI by construction, which is why the
    // generation-token bookkeeping this test used to exercise no longer has
    // a live path to it — this test instead proves the button that would
    // have created that scenario is disabled.
    let resolveObservation!: (value: {
      status: 'ok';
      attemptId: string;
      observationId: string;
    }) => void;
    const pendingObservation = new Promise<{
      status: 'ok';
      attemptId: string;
      observationId: string;
    }>((resolve) => {
      resolveObservation = resolve;
    });
    const api = wizardApi({
      submitCalibrationObservation: vi.fn().mockReturnValue(pendingObservation),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );
    await screen.findByText(/Still syncing/i);

    // The redo button for this method exists (it shows "completed once")
    // but must be disabled while the draft-profile observation from the
    // first run is still unsettled.
    const redoButton = await screen.findByRole('button', {
      name: /Start Flow rate — pass 1 \(completed once\)/i,
    });
    expect(redoButton).toBeDisabled();
    fireEvent.click(redoButton);
    // A click on a disabled button must not start a second slice/upload
    // flow — the method-picker step, not a slice progress bar, stays shown.
    expect(
      screen.queryByRole('progressbar', { name: /Slice progress/i }),
    ).not.toBeInTheDocument();

    resolveObservation({
      status: 'ok',
      attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      observationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    });

    // Once the first observation settles, the redo button re-enables and a
    // second run can actually be started.
    await waitFor(() => {
      expect(redoButton).not.toBeDisabled();
    });
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

  it('persists a still-unresolved draft-profile observation as a FAILURE, so a restart can never silently forget it', async () => {
    // If the app exits while `submitCalibrationObservation` is still in
    // flight, `draftObservationPending` (in-memory only, by design — an
    // unsettled promise cannot itself survive a restart) is lost. If the
    // persisted snapshot only ever reflected `draftObservationFailures`,
    // that loss would be silent: on restore, the method would show neither
    // pending nor failed, and "Finish calibration" would wrongly re-enable
    // over an unconfirmed draft. The persistence layer must fold any
    // still-pending method into `draftObservationFailures` at save time.
    let resolveObservation!: (value: {
      status: 'ok';
      attemptId: string;
      observationId: string;
    }) => void;
    const pendingObservation = new Promise<{
      status: 'ok';
      attemptId: string;
      observationId: string;
    }>((resolve) => {
      resolveObservation = resolve;
    });
    const api = wizardApi({
      submitCalibrationObservation: vi.fn().mockReturnValue(pendingObservation),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );
    await screen.findByText(/Still syncing/i);

    await waitFor(() => {
      const calls = (
        api.saveFilamentCalibrationWizardState as ReturnType<typeof vi.fn>
      ).mock.calls;
      const sawPendingPersistedAsFailure = calls.some((call) => {
        const state = (
          call[0] as {
            state: { draftObservationFailures: readonly string[] };
          }
        ).state;
        return state.draftObservationFailures.includes('flow_rate_pass_1');
      });
      if (!sawPendingPersistedAsFailure) {
        throw new Error(
          'expected a save call with the still-pending method folded into draftObservationFailures',
        );
      }
    });

    // Avoid an unhandled-rejection/leftover-timer warning from the still-open
    // promise once the test's assertions are done with it.
    resolveObservation({
      status: 'ok',
      attemptId: '99999999-9999-4999-8999-999999999999',
      observationId: '88888888-8888-4888-8888-888888888888',
    });
    await waitFor(() => {
      expect(screen.queryByText(/Still syncing/i)).not.toBeInTheDocument();
    });
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

describe('FilamentCalibrationWizard server-side CalibrationProject entry point (issue #798)', () => {
  it('creates the CalibrationProject before cloning the filament profile, with the resolved filament identity', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const createCalls = (
      api.createCalibrationProject as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(createCalls).toHaveLength(1);
    const cloneCalls = (
      api.cloneCalibrationFilamentProfile as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(cloneCalls).toHaveLength(1);

    // The project must exist before any profile clone or local wizard state
    // write — assert call ORDER via each mock's invocation index, not just
    // that both were called.
    const createOrder = (
      api.createCalibrationProject as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    const cloneOrder = (
      api.cloneCalibrationFilamentProfile as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    if (createOrder === undefined || cloneOrder === undefined) {
      throw new Error('expected both mocks to have recorded an invocation');
    }
    expect(createOrder).toBeLessThan(cloneOrder);

    const [request] = createCalls[0] as [
      {
        profileId: string;
        requestId: string;
        printerId: string;
        filamentProvider: string;
        filamentProductId: string;
        filamentProductName: string;
        filamentMaterial: string;
      },
    ];
    expect(request.profileId).toBe(profileId);
    expect(request.printerId).toBe(printerIdA);
    expect(request.filamentProvider).toBe('printfarmer');
    expect(request.filamentProductId).toBe(filamentGuid);
    expect(request.filamentProductName).toBe(SAMPLE_FILAMENT_NAME);
    expect(request.filamentMaterial.length).toBeGreaterThan(0);
    // Issue #798 follow-up: `requestId` is the server's idempotency key —
    // must be a real, non-empty id, distinct per attempt.
    expect(request.requestId.length).toBeGreaterThan(0);
  });

  it('reuses the same requestId across a retry after a project-creation failure, so a retry cannot mint a duplicate server-side project', async () => {
    const api = wizardApi({
      createCalibrationProject: vi
        .fn()
        .mockResolvedValueOnce(notImplemented('createCalibrationProject'))
        .mockResolvedValueOnce({
          status: 'ok' as const,
          project: {
            id: projectGuid,
            name: 'PLA — Prusament Galaxy Black (calibration project)',
            lifecycleStatus: 'Active',
            experienceMode: 'Coach',
            printerId: printerIdA,
            revision: 1,
          },
        }),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();

    const cloneButton = await screen.findByRole('button', {
      name: /Clone this filament profile/i,
    });
    fireEvent.click(cloneButton);
    await screen.findByText(
      /createCalibrationProject: not implemented in wizard test\./i,
    );

    // Retry — same attempt, same wizard-visible naming step.
    const retryButton = await screen.findByRole('button', {
      name: /Clone this filament profile/i,
    });
    fireEvent.click(retryButton);
    await screen.findByRole('button', {
      name: /Start Flow rate — pass 1/i,
    });

    const createCalls = (
      api.createCalibrationProject as ReturnType<typeof vi.fn>
    ).mock.calls as [{ requestId: string }][];
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]?.[0].requestId).toBe(createCalls[0]?.[0].requestId);
  });

  it('truncates an overlong clone name so the created-project request never exceeds the server-side cap', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();

    const nameInput = await screen.findByRole('textbox', {
      name: /Clone name/i,
    });
    fireEvent.change(nameInput, { target: { value: 'x'.repeat(512) } });
    await performCloneStep();

    const [request] = (api.createCalibrationProject as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [{ name: string }];
    expect(request.name.length).toBeLessThanOrEqual(200);
  });

  it('surfaces a project-creation failure without ever calling cloneCalibrationFilamentProfile', async () => {
    const api = wizardApi({
      createCalibrationProject: vi
        .fn()
        .mockResolvedValue(notImplemented('createCalibrationProject')),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    const cloneButton = await screen.findByRole('button', {
      name: /Clone this filament profile/i,
    });
    fireEvent.click(cloneButton);

    await screen.findByText(
      /createCalibrationProject: not implemented in wizard test\./i,
    );
    expect(
      (api.cloneCalibrationFilamentProfile as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toHaveLength(0);
  });
});

describe('FilamentCalibrationWizard capability refusal gate (issue #798)', () => {
  it("refuses to start, with the server's own reason text, when the deployment cannot slice", async () => {
    const api = wizardApi({
      getCalibrationAvailability: vi.fn().mockResolvedValue({
        ...availability(),
        capabilityFlags: {
          ...availability().capabilityFlags,
          calibrationGenerationEnabled: false,
        },
        serverUnavailableReasons: [
          {
            feature: 'slicing',
            code: 'sliceEngineUnreachable',
            message: 'The configured slicer engine could not be reached.',
          },
        ],
      }),
    });
    mount(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Calibrate a filament spool' }),
    );

    await screen.findByText(
      /The configured slicer engine could not be reached\./i,
    );
    expect(
      screen.queryByRole('combobox', { name: /machine profile/i }),
    ).toBeNull();
    expect(
      (api.createCalibrationProject as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
    expect(
      (api.cloneCalibrationFilamentProfile as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toHaveLength(0);
  });

  it("refuses to start, with the server's own reason text, when only a calibrationGeneration reason is reported", async () => {
    const api = wizardApi({
      getCalibrationAvailability: vi.fn().mockResolvedValue({
        ...availability(),
        capabilityFlags: {
          ...availability().capabilityFlags,
          calibrationGenerationEnabled: false,
        },
        serverUnavailableReasons: [
          {
            feature: 'calibrationGeneration',
            code: 'split_routing_unavailable',
            message:
              'Calibration generation requires the deterministic core, authorized model storage, the canonical slice path, an allow-listed attested worker, operational promotion, a durable orchestration store and a healthy recovery loop.',
          },
          {
            feature: 'calibrationArtifactPromotion',
            code: 'artifact_source_unroutable',
            message: 'Artifact promotion requires routable artifacts.',
          },
        ],
      }),
    });
    mount(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Calibrate a filament spool' }),
    );

    await screen.findByText(/Calibration generation requires the/i);
    // The unrelated artifact-promotion reason (out of scope, #795) must not
    // leak into this message.
    expect(screen.queryByText(/Artifact promotion requires/i)).toBeNull();
    expect(
      (api.createCalibrationProject as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });

  it('control: a slicing-enabled deployment proceeds normally into profile selection', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await screen.findByRole('combobox', { name: /machine profile/i });
    expect(screen.queryByText(/could not be reached/i)).toBeNull();
  });
});

describe('FilamentCalibrationWizard server-authoritative method disposition (issue #797)', () => {
  it('persists a skip via setCalibrationMethodDisposition (not local JSON) and marks the step Skipped without blocking completion', async () => {
    const api = wizardApi({
      setCalibrationMethodDisposition: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        progress: {
          id: '55555555-5555-4555-8555-555555555501',
          projectId: projectGuid,
          method: 'flow_rate_pass_1',
          disposition: 'Skipped',
          currentStepId: null,
          revision: 2,
          createdAtUtc: '2026-01-01T00:00:00.000Z',
          updatedAtUtc: '2026-01-01T00:00:00.000Z',
        },
      }),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const skipButton = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    fireEvent.click(skipButton);
    const startButtonForScope = await screen.findByRole('button', {
      name: /Start Flow rate — pass 1/i,
    });
    const methodItem = startButtonForScope.closest('li');
    if (methodItem === null) throw new Error('expected a method <li>');
    await within(methodItem).findByText('Skipped');

    const calls = (
      api.setCalibrationMethodDisposition as ReturnType<typeof vi.fn>
    ).mock.calls as [
      {
        profileId: string;
        projectId: string;
        method: string;
        disposition: string;
        baseRevision: number | null;
      },
    ][];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].profileId).toBe(profileId);
    expect(calls[0]?.[0].projectId).toBe(projectGuid);
    expect(calls[0]?.[0].method).toBe('flow_rate_pass_1');
    expect(calls[0]?.[0].disposition).toBe('Skipped');
    // No progress row existed yet for this method — server semantics require
    // a null baseRevision on the first disposition write for it.
    expect(calls[0]?.[0].baseRevision).toBeNull();

    // Skip never blocks completion — the operator can still run the step.
    const startButton = await screen.findByRole('button', {
      name: /Start Flow rate — pass 1/i,
    });
    expect(startButton).not.toBeDisabled();
  });

  it('control: un-skips a skipped step back to Pending, sending the existing revision as baseRevision', async () => {
    const api = wizardApi({
      getCalibrationMethodProgress: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        progress: [
          {
            id: '55555555-5555-4555-8555-555555555502',
            projectId: projectGuid,
            method: 'flow_rate_pass_1',
            disposition: 'Skipped',
            currentStepId: null,
            revision: 3,
            createdAtUtc: '2026-01-01T00:00:00.000Z',
            updatedAtUtc: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      setCalibrationMethodDisposition: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        progress: {
          id: '55555555-5555-4555-8555-555555555502',
          projectId: projectGuid,
          method: 'flow_rate_pass_1',
          disposition: 'Pending',
          currentStepId: null,
          revision: 4,
          createdAtUtc: '2026-01-01T00:00:00.000Z',
          updatedAtUtc: '2026-01-01T00:00:00.000Z',
        },
      }),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    await screen.findByText('Skipped');
    const unskipButton = await screen.findByRole('button', {
      name: /Un-skip Flow rate — pass 1/i,
    });
    fireEvent.click(unskipButton);
    const methodItem = unskipButton.closest('li');
    if (methodItem === null) throw new Error('expected a method <li>');
    await within(methodItem).findByText('Pending');

    const calls = (
      api.setCalibrationMethodDisposition as ReturnType<typeof vi.fn>
    ).mock.calls as [{ disposition: string; baseRevision: number | null }][];
    expect(calls[0]?.[0].disposition).toBe('Pending');
    expect(calls[0]?.[0].baseRevision).toBe(3);
  });

  it('consumes server method-guidance for title/purpose instead of the client-hardcoded stand-in text', async () => {
    const api = wizardApi({
      getCalibrationMethodGuidanceCatalog: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        catalog: [
          {
            method: 'flow_rate_pass_1',
            title: 'Server Flow Rate Title',
            purpose: 'Server-sourced purpose text.',
            wikiUrl: 'https://wiki.example/flow-rate',
            setupInputs: [],
            measureQuantity: null,
            steps: ['setup', 'print', 'measure'],
          },
        ],
      }),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();

    const cloneButton = await screen.findByRole('button', {
      name: /Clone this filament profile/i,
    });
    fireEvent.click(cloneButton);

    await screen.findByRole('button', {
      name: /Start Server Flow Rate Title/i,
    });
    await screen.findByText('Server-sourced purpose text.');
    expect(
      screen.queryByRole('button', { name: /Start Flow rate — pass 1$/i }),
    ).toBeNull();
  });

  it('falls back to FILAMENT_METHOD_META when the guidance catalog fetch fails', async () => {
    const api = wizardApi({
      getCalibrationMethodGuidanceCatalog: vi
        .fn()
        .mockRejectedValue(new Error('network unreachable')),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    // The wizard still renders and remains usable with the client stand-in
    // text — a guidance-catalog failure degrades gracefully rather than
    // blocking the step picker.
    await screen.findByRole('button', { name: /Start Flow rate — pass 1/i });
  });

  it('renders a server-Completed method as Completed, distinct from Pending, and disables its Skip toggle', async () => {
    const api = wizardApi({
      getCalibrationMethodProgress: vi.fn().mockResolvedValue({
        status: 'ok' as const,
        progress: [
          {
            id: '55555555-5555-4555-8555-555555555503',
            projectId: projectGuid,
            method: 'flow_rate_pass_1',
            disposition: 'Completed',
            currentStepId: null,
            revision: 5,
            createdAtUtc: '2026-01-01T00:00:00.000Z',
            updatedAtUtc: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const skipButton = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const methodItem = skipButton.closest('li');
    if (methodItem === null) throw new Error('expected a method <li>');
    await within(methodItem).findByText('Completed');
    // Completed must never be conflated with the default Pending label.
    expect(within(methodItem).queryByText('Pending')).toBeNull();
    expect(skipButton).toBeDisabled();
  });

  it('refetches server method progress after a successful draft-profile observation, updating a stale Pending badge to Completed and disabling Skip (issue #795/#797 integration)', async () => {
    // The initial mount-time fetch reports Pending (no observation submitted
    // yet). After `writeMeasurement` submits the observation successfully,
    // the server has transitioned this method's disposition to Completed —
    // but only a fresh `getCalibrationMethodProgress` read can tell the
    // client that. This proves `writeMeasurement` actually triggers that
    // refetch, rather than leaving the badge (and the Skip button) showing
    // stale Pending state for a method that was just measured.
    const getCalibrationMethodProgress = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'ok' as const,
        progress: [],
      })
      .mockResolvedValueOnce({
        status: 'ok' as const,
        progress: [
          {
            id: '55555555-5555-4555-8555-555555555504',
            projectId: projectGuid,
            method: 'flow_rate_pass_1',
            disposition: 'Completed',
            currentStepId: null,
            revision: 1,
            createdAtUtc: '2026-01-01T00:00:00.000Z',
            updatedAtUtc: '2026-01-01T00:00:00.000Z',
          },
        ],
      });
    const api = wizardApi({ getCalibrationMethodProgress });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const skipButton = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const methodItemBeforeWrite = skipButton.closest('li');
    if (methodItemBeforeWrite === null)
      throw new Error('expected a method <li>');
    await within(methodItemBeforeWrite).findByText('Pending');
    expect(skipButton).not.toBeDisabled();

    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    await waitFor(() => {
      expect(getCalibrationMethodProgress).toHaveBeenCalledTimes(2);
    });
    // The wizard swaps away from the method picker during the slice/upload
    // steps and re-renders it fresh back at the picker afterward, so the
    // `<li>` element captured above is now a detached, stale DOM node — it
    // must be re-queried rather than reused.
    const skipButtonAfterWrite = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const methodItemAfterWrite = skipButtonAfterWrite.closest('li');
    if (methodItemAfterWrite === null)
      throw new Error('expected a method <li>');
    await within(methodItemAfterWrite).findByText('Completed');
    expect(within(methodItemAfterWrite).queryByText('Pending')).toBeNull();
    expect(skipButtonAfterWrite).toBeDisabled();
  });

  it("disables Skip while a draft-profile observation is syncing, even though the method's disposition is still Pending (not yet Completed)", async () => {
    // Round-8's own integration test only proved the Skip-gate held for a
    // method whose disposition had ALREADY reached `Completed` by the time
    // of the assertion — but `canToggleSkip` already disables Skip once
    // `disposition === 'Completed'`, independent of `!syncingThisMethod`.
    // This isolates the `!syncingThisMethod` term itself (Bishop's
    // round-8 non-blocking finding): the method's disposition is still
    // `Pending` (the post-observation refetch has not landed yet), and
    // Skip must still be disabled for the whole window the observation
    // itself is unresolved — not just once a fresher Completed badge shows
    // up. Without this test, a future refactor could delete the
    // `!syncingThisMethod` term with every other test still green.
    let resolveObservation!: (value: {
      status: 'ok';
      attemptId: string;
      observationId: string;
    }) => void;
    const pendingObservation = new Promise<{
      status: 'ok';
      attemptId: string;
      observationId: string;
    }>((resolve) => {
      resolveObservation = resolve;
    });
    const api = wizardApi({
      submitCalibrationObservation: vi.fn().mockReturnValue(pendingObservation),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();
    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    const skipButton = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const methodItem = skipButton.closest('li');
    if (methodItem === null) throw new Error('expected a method <li>');
    // Still Pending — no completion refetch has happened, only the draft
    // observation is in flight.
    await within(methodItem).findByText('Pending');
    expect(skipButton).toBeDisabled();

    resolveObservation({
      status: 'ok',
      attemptId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef',
      observationId: 'ffffffff-ffff-4fff-8fff-fffffffffff0',
    });

    await waitFor(() => {
      expect(skipButton).not.toBeDisabled();
    });
  });

  it("does not let a stale, slower fetch clobber a newer fetch's already-surfaced sync error back to 'ready' (issue #795/#797 integration, round 9)", async () => {
    // Two overlapping `getCalibrationMethodProgress` reads: the initial
    // mount-time fetch (call 1) is held open here so it settles LAST. Call
    // 2 is the post-observation-success refetch `writeMeasurement` fires
    // (round 8) once `submitCalibrationObservation` succeeds — it fails
    // FIRST, correctly marking the sync status as errored. Call 1 then
    // finally resolves 'ok' with stale (pre-observation) data. A stale
    // success settling after a newer failure must never clobber that
    // failure back to 'ready' — that would silently re-enable Skip against
    // unconfirmed sync state and hide a genuine read failure from the
    // operator (Hicks' round-8 finding).
    interface ProgressReadResult {
      status: 'ok';
      progress: Array<{
        id: string;
        projectId: string;
        method: string;
        disposition: string;
        currentStepId: null;
        revision: number;
        createdAtUtc: string;
        updatedAtUtc: string;
      }>;
    }
    const initialFetch: {
      resolve: ((value: ProgressReadResult) => void) | null;
    } = { resolve: null };
    const postObservationFetch: {
      reject: ((reason: Error) => void) | null;
    } = { reject: null };
    const getCalibrationMethodProgress = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ProgressReadResult>((resolve) => {
            initialFetch.resolve = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ProgressReadResult>((_resolve, reject) => {
            postObservationFetch.reject = reject;
          }),
      );
    const api = wizardApi({ getCalibrationMethodProgress });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    await runOneMethodEndToEnd(
      /Start Flow rate — pass 1/i,
      /Flow ratio/i,
      '1.02',
    );

    await waitFor(() => {
      expect(getCalibrationMethodProgress).toHaveBeenCalledTimes(2);
    });
    expect(postObservationFetch.reject).not.toBeNull();

    // The NEWER (call 2, post-observation) fetch fails first.
    postObservationFetch.reject?.(new Error('network unreachable'));

    const skipButton = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const methodItem = skipButton.closest('li');
    if (methodItem === null) throw new Error('expected a method <li>');
    await within(methodItem).findByText('Sync failed');
    expect(skipButton).toBeDisabled();

    // The OLDER (call 1, mount-time) fetch now finally resolves 'ok', with
    // stale pre-observation data.
    expect(initialFetch.resolve).not.toBeNull();
    initialFetch.resolve?.({
      status: 'ok' as const,
      progress: [
        {
          id: '55555555-5555-4555-8555-55555555550b',
          projectId: projectGuid,
          method: 'flow_rate_pass_1',
          disposition: 'Pending',
          currentStepId: null,
          revision: 1,
          createdAtUtc: '2026-01-01T00:00:00.000Z',
          updatedAtUtc: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    // Flush the now-resolved (but superseded) promise's microtasks.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Still errored — the stale, superseded success must not have
    // clobbered the newer, already-surfaced failure back to 'ready'.
    await within(methodItem).findByText('Sync failed');
    expect(within(methodItem).queryByText('Pending')).toBeNull();
    expect(skipButton).toBeDisabled();
  });

  it('shows a distinct "Sync failed" disposition (never Pending) and disables Skip when getCalibrationMethodProgress fails', async () => {
    const api = wizardApi({
      getCalibrationMethodProgress: vi
        .fn()
        .mockRejectedValue(new Error('network unreachable')),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const skipButton = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const methodItem = skipButton.closest('li');
    if (methodItem === null) throw new Error('expected a method <li>');
    await within(methodItem).findByText('Sync failed');
    // A read failure must never be presented as the default Pending state —
    // that would make a step skipped on another device look Pending here.
    expect(within(methodItem).queryByText('Pending')).toBeNull();
    expect(skipButton).toBeDisabled();
  });

  it('recovers from a failed initial read via the "Retry sync" action, without requiring the wizard to be reopened', async () => {
    const getProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unreachable'))
      .mockImplementationOnce(() =>
        Promise.resolve({
          status: 'ok' as const,
          progress: [
            {
              id: '55555555-5555-4555-8555-555555555505',
              projectId: projectGuid,
              method: 'flow_rate_pass_1',
              disposition: 'Pending',
              currentStepId: null,
              revision: 1,
              createdAtUtc: '2026-01-01T00:00:00.000Z',
              updatedAtUtc: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      );
    const api = wizardApi({ getCalibrationMethodProgress: getProgress });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const retryButton = await screen.findByRole('button', {
      name: /Retry sync/i,
    });
    fireEvent.click(retryButton);

    const skipButton = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const methodItem = skipButton.closest('li');
    if (methodItem === null) throw new Error('expected a method <li>');
    await within(methodItem).findByText('Pending');
    expect(screen.queryByText('Sync failed')).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry sync/i })).toBeNull();
    expect(skipButton).not.toBeDisabled();
    expect(getProgress).toHaveBeenCalledTimes(2);
  });

  it('control: a successful read shows Pending normally (not "Sync failed") and Skip is enabled', async () => {
    const api = wizardApi();
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const skipButton = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const methodItem = skipButton.closest('li');
    if (methodItem === null) throw new Error('expected a method <li>');
    await within(methodItem).findByText('Pending');
    expect(within(methodItem).queryByText('Sync failed')).toBeNull();
    expect(skipButton).not.toBeDisabled();
  });

  it('refetches method-progress after a rejected disposition write (e.g. a stale-revision conflict), instead of leaving a retry stuck on the same revision', async () => {
    const getProgress = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({
          status: 'ok' as const,
          progress: [
            {
              id: '55555555-5555-4555-8555-555555555504',
              projectId: projectGuid,
              method: 'flow_rate_pass_1',
              disposition: 'Pending',
              currentStepId: null,
              revision: 1,
              createdAtUtc: '2026-01-01T00:00:00.000Z',
              updatedAtUtc: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          status: 'ok' as const,
          progress: [
            {
              id: '55555555-5555-4555-8555-555555555504',
              projectId: projectGuid,
              method: 'flow_rate_pass_1',
              // Someone else already skipped it — this is the fresher
              // revision the retry should now be based on.
              disposition: 'Skipped',
              currentStepId: null,
              revision: 2,
              createdAtUtc: '2026-01-01T00:00:00.000Z',
              updatedAtUtc: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      );
    const api = wizardApi({
      getCalibrationMethodProgress: getProgress,
      setCalibrationMethodDisposition: vi.fn().mockResolvedValue({
        status: 'error' as const,
        error: {
          code: 'revisionConflict',
          message: 'The method disposition changed since it was last read.',
          retryable: true,
          retryAfterSeconds: null,
          reference: null,
        },
      }),
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const skipButton = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    fireEvent.click(skipButton);

    // The rejected write triggers a refetch, which lands the fresher
    // Skipped/revision-2 row — a stuck stale-revision retry would instead
    // leave this method showing Pending forever.
    const methodItem = skipButton.closest('li');
    if (methodItem === null) throw new Error('expected a method <li>');
    await within(methodItem).findByText('Skipped');
    expect(getProgress).toHaveBeenCalledTimes(2);
  });

  it('reconciles a conflicted method from its refetch even when an unrelated method writes concurrently (not just re-enabling toggles)', async () => {
    // Method A (pass 1): its write is rejected as a stale-revision conflict,
    // which kicks off a refetch — held open here so we control exactly when
    // it resolves. Method B (pass 2): its write succeeds first, bumping the
    // shared sequence counter and updating `methodProgress` directly without
    // going through `fetchMethodProgress`. A's refetch is therefore "stale"
    // by sequence number, but it is still the only thing that can hand A's
    // retry the fresher revision it needs. Discarding it outright (an
    // earlier version of this fix did exactly that, restoring only the sync
    // status) would leave A silently disabled-then-re-enabled but still
    // holding its rejected, superseded revision — so a retry would
    // resubmit the same stale `baseRevision` and hit the same conflict
    // forever. This test asserts A's row is actually updated from the
    // refetch (someone else skipped it — the real-world cause of a
    // stale-revision conflict), not merely that the UI stops looking stuck.
    interface ProgressReadResult {
      status: 'ok';
      progress: Array<{
        id: string;
        projectId: string;
        method: string;
        disposition: string;
        currentStepId: null;
        revision: number;
        createdAtUtc: string;
        updatedAtUtc: string;
      }>;
    }
    const staleRefetch: {
      resolve: ((value: ProgressReadResult) => void) | null;
    } = { resolve: null };
    const getProgress = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({
          status: 'ok' as const,
          progress: [
            {
              id: '55555555-5555-4555-8555-555555555506',
              projectId: projectGuid,
              method: 'flow_rate_pass_1',
              disposition: 'Pending',
              currentStepId: null,
              revision: 1,
              createdAtUtc: '2026-01-01T00:00:00.000Z',
              updatedAtUtc: '2026-01-01T00:00:00.000Z',
            },
            {
              id: '55555555-5555-4555-8555-555555555507',
              projectId: projectGuid,
              method: 'flow_rate_pass_2',
              disposition: 'Pending',
              currentStepId: null,
              revision: 1,
              createdAtUtc: '2026-01-01T00:00:00.000Z',
              updatedAtUtc: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ProgressReadResult>((resolve) => {
            staleRefetch.resolve = resolve;
          }),
      );
    const setDisposition = vi.fn().mockImplementation(
      (request: {
        method: string;
      }): Promise<
        | {
            status: 'ok';
            progress: {
              id: string;
              projectId: string;
              method: string;
              disposition: string;
              currentStepId: null;
              revision: number;
              createdAtUtc: string;
              updatedAtUtc: string;
            };
          }
        | {
            status: 'error';
            error: {
              code: string;
              message: string;
              retryable: boolean;
              retryAfterSeconds: number | null;
              reference: string | null;
            };
          }
      > => {
        if (request.method === 'flow_rate_pass_1') {
          return Promise.resolve({
            status: 'error' as const,
            error: {
              code: 'revisionConflict',
              message: 'The method disposition changed since it was last read.',
              retryable: true,
              retryAfterSeconds: null,
              reference: null,
            },
          });
        }
        return Promise.resolve({
          status: 'ok' as const,
          progress: {
            id: '55555555-5555-4555-8555-555555555508',
            projectId: projectGuid,
            method: 'flow_rate_pass_2',
            disposition: 'Skipped',
            currentStepId: null,
            revision: 2,
            createdAtUtc: '2026-01-01T00:00:00.000Z',
            updatedAtUtc: '2026-01-01T00:00:00.000Z',
          },
        });
      },
    );
    const api = wizardApi({
      getCalibrationMethodProgress: getProgress,
      setCalibrationMethodDisposition: setDisposition,
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const skipButtonA = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const skipButtonB = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 2/i,
    });

    // A's write is rejected first, starting the (held-open) refetch. B's
    // write is fired immediately afterward, before either promise settles —
    // this mirrors the real race: both toggles are still enabled (status is
    // `'ready'`) until the first `await` inside either handler yields.
    fireEvent.click(skipButtonA);
    fireEvent.click(skipButtonB);

    const methodItemA = skipButtonA.closest('li');
    const methodItemB = skipButtonB.closest('li');
    if (methodItemA === null || methodItemB === null) {
      throw new Error('expected a method <li>');
    }
    await within(methodItemB).findByText('Skipped');
    await waitFor(() => expect(getProgress).toHaveBeenCalledTimes(2));

    // Now let A's refetch resolve, reporting that someone else skipped A
    // (the realistic cause of a stale-revision conflict) at a fresher
    // revision. Even though B's unrelated write advanced the shared
    // sequence counter in between, A's own row must still be applied —
    // proving the fix reconciles per-method rather than only clearing the
    // UI's busy/loading indicator.
    expect(staleRefetch.resolve).not.toBeNull();
    staleRefetch.resolve?.({
      status: 'ok' as const,
      progress: [
        {
          id: '55555555-5555-4555-8555-555555555506',
          projectId: projectGuid,
          method: 'flow_rate_pass_1',
          disposition: 'Skipped',
          currentStepId: null,
          revision: 2,
          createdAtUtc: '2026-01-01T00:00:00.000Z',
          updatedAtUtc: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    await waitFor(() => {
      expect(screen.queryByText('Sync failed')).toBeNull();
    });
    // A's row reflects the reconciled server state (a subsequent retry
    // would now send `baseRevision: 2`, not the original stale `1`), and
    // neither toggle is left permanently disabled.
    await within(methodItemA).findByText('Skipped');
    await waitFor(() => expect(skipButtonA).not.toBeDisabled());
    expect(skipButtonB).not.toBeDisabled();
  });

  it("does not strand the sync status at loading when a conflicted method's refetch fails while an unrelated method writes concurrently", async () => {
    // Mirror of the reconciliation test above, but A's held-open refetch
    // rejects instead of resolving. `methodProgressSeqRef` is a fetch-only
    // generation counter (writes no longer bump it), so B's concurrent
    // successful write must not suppress A's refetch failure from being
    // surfaced — otherwise `methodProgressStatus` would be stranded at
    // 'loading' forever with no "Retry sync" affordance and every
    // Skip/Un-skip button silently dead for the rest of the session.
    interface ProgressReadOk {
      status: 'ok';
      progress: Array<{
        id: string;
        projectId: string;
        method: string;
        disposition: string;
        currentStepId: null;
        revision: number;
        createdAtUtc: string;
        updatedAtUtc: string;
      }>;
    }
    const staleRefetch: { reject: ((reason: Error) => void) | null } = {
      reject: null,
    };
    const getProgress = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve({
          status: 'ok' as const,
          progress: [
            {
              id: '55555555-5555-4555-8555-555555555509',
              projectId: projectGuid,
              method: 'flow_rate_pass_1',
              disposition: 'Pending',
              currentStepId: null,
              revision: 1,
              createdAtUtc: '2026-01-01T00:00:00.000Z',
              updatedAtUtc: '2026-01-01T00:00:00.000Z',
            },
            {
              id: '55555555-5555-4555-8555-55555555550a',
              projectId: projectGuid,
              method: 'flow_rate_pass_2',
              disposition: 'Pending',
              currentStepId: null,
              revision: 1,
              createdAtUtc: '2026-01-01T00:00:00.000Z',
              updatedAtUtc: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ProgressReadOk>((_resolve, reject) => {
            staleRefetch.reject = reject;
          }),
      );
    const setDisposition = vi.fn().mockImplementation(
      (request: {
        method: string;
      }): Promise<
        | {
            status: 'ok';
            progress: {
              id: string;
              projectId: string;
              method: string;
              disposition: string;
              currentStepId: null;
              revision: number;
              createdAtUtc: string;
              updatedAtUtc: string;
            };
          }
        | {
            status: 'error';
            error: {
              code: string;
              message: string;
              retryable: boolean;
              retryAfterSeconds: number | null;
              reference: string | null;
            };
          }
      > => {
        if (request.method === 'flow_rate_pass_1') {
          return Promise.resolve({
            status: 'error' as const,
            error: {
              code: 'revisionConflict',
              message: 'The method disposition changed since it was last read.',
              retryable: true,
              retryAfterSeconds: null,
              reference: null,
            },
          });
        }
        return Promise.resolve({
          status: 'ok' as const,
          progress: {
            id: '55555555-5555-4555-8555-55555555550b',
            projectId: projectGuid,
            method: 'flow_rate_pass_2',
            disposition: 'Skipped',
            currentStepId: null,
            revision: 2,
            createdAtUtc: '2026-01-01T00:00:00.000Z',
            updatedAtUtc: '2026-01-01T00:00:00.000Z',
          },
        });
      },
    );
    const api = wizardApi({
      getCalibrationMethodProgress: getProgress,
      setCalibrationMethodDisposition: setDisposition,
    });
    mount(api);
    await openWizardAndPickPrinter();
    await pickAllProfilesAndProceedToClone();
    await performCloneStep();

    const skipButtonA = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 1/i,
    });
    const skipButtonB = await screen.findByRole('button', {
      name: /Skip Flow rate — pass 2/i,
    });

    // Same interleaving as the reconciliation test: A's write is rejected
    // first (starting the held-open refetch), then B's write is fired
    // before either promise settles.
    fireEvent.click(skipButtonA);
    fireEvent.click(skipButtonB);

    const methodItemB = skipButtonB.closest('li');
    if (methodItemB === null) {
      throw new Error('expected a method <li>');
    }
    await within(methodItemB).findByText('Skipped');
    await waitFor(() => expect(getProgress).toHaveBeenCalledTimes(2));

    // Now let A's refetch fail. B's unrelated write already advanced past
    // it in wall-clock time, but must not be able to suppress this failure
    // from being surfaced, since nothing else will ever set the sync
    // status again once this — the most recently issued — fetch resolves.
    expect(staleRefetch.reject).not.toBeNull();
    staleRefetch.reject?.(new Error('network unreachable'));

    // The failure must be surfaced (not silently swallowed), and it must
    // come with a recovery affordance rather than leaving every toggle
    // permanently disabled with no way out short of reopening the wizard.
    await waitFor(() =>
      expect(screen.getAllByText('Sync failed').length).toBeGreaterThan(0),
    );
    const retrySync = await screen.findByRole('button', {
      name: /Retry sync/i,
    });
    expect(retrySync).toBeInTheDocument();
    // The sync status is global (one fetch covers every method), so every
    // Skip/Un-skip toggle is correctly disabled while it is `'error'` —
    // the point of this test is that there IS a status, and a "Retry sync"
    // recovery affordance, rather than a silent permanent `'loading'` with
    // no path back short of reopening the wizard.
    expect(skipButtonB).toBeDisabled();

    // And recovery actually works: retrying re-fetches and restores 'ready'.
    getProgress.mockImplementationOnce(() =>
      Promise.resolve({
        status: 'ok' as const,
        progress: [
          {
            id: '55555555-5555-4555-8555-555555555509',
            projectId: projectGuid,
            method: 'flow_rate_pass_1',
            disposition: 'Skipped',
            currentStepId: null,
            revision: 2,
            createdAtUtc: '2026-01-01T00:00:00.000Z',
            updatedAtUtc: '2026-01-01T00:00:00.000Z',
          },
          {
            id: '55555555-5555-4555-8555-55555555550a',
            projectId: projectGuid,
            method: 'flow_rate_pass_2',
            disposition: 'Skipped',
            currentStepId: null,
            revision: 2,
            createdAtUtc: '2026-01-01T00:00:00.000Z',
            updatedAtUtc: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    fireEvent.click(retrySync);
    await waitFor(() => {
      expect(screen.queryByText('Sync failed')).toBeNull();
    });
    expect(skipButtonB).not.toBeDisabled();
  });
});
