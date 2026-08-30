/**
 * Acceptance test for the calibration profile-selection flow.
 *
 * OWNER DIRECTIVE (2026-08-22T19:08:45-07:00, Vasquez relaying Jeff Papiez).
 * API CONTRACT (verified against `OlyForge3D/PrintFarmer` commit
 * `b0a021000639d5ef69c818c89877520793d9f9e8`, api-contract researcher,
 * 2026-08-22T19:29:44-07:00).
 *
 * The desktop must NOT gate calibration on PrintFarmer pre-populating the
 * `CalibrationMachineProfileId` / `CalibrationProcessProfileId` /
 * `CalibrationFilamentProfileId` columns on the printer row. Those columns
 * are populated only by the operator submitting
 * `PUT /api/printers/{id}/calibration-setup` (`PrintersController.cs:
 * 5439-5577`), and issue #1851's fix is emulator-only — real production
 * printers stay `eligible: false` until the operator has run that PUT
 * themselves. The whole flow is:
 *
 *   1. Operator selects a printer.
 *   2. PFD requests machine profiles from the API and presents a select
 *      list of system machine profiles + any user-created ones.
 *   3. Operator selects a process profile, filtered to those applicable
 *      to the chosen machine profile (system + user process profiles).
 *   4. Operator selects a filament profile, filtered the same way.
 *   5. All three profile GUIDs go up via
 *      `PUT /api/printers/{id}/calibration-setup`, fixing the NULL
 *      columns at the source. The existing calibration-projects saga
 *      (projects → attempts → generate-job) then runs unchanged.
 *
 * ASSERTIONS ARE ON OBSERVABLE OPERATOR OUTCOMES ONLY
 *
 * Vasquez's brief: internal-shape assertions are precisely what let the
 * last three PRs pass while broken. Every assertion below is on rendered
 * DOM (`getByRole`, `getByLabelText`) or on enabled/disabled state, never
 * on `vi.fn().mock.calls[...]`.
 *
 * SAFETY-TRAP GUARD
 *
 * `src/main/calibrationWire.ts:1113-1117` hardcodes
 * `emergencyStopAvailable`, `thermalProtectionConfirmed`, and
 * `ventilationAssessed` to `false` on every context, and `permissions`
 * to `null` at :1124. Downstream, `bindingDiagnostics` in
 * `src/renderer/calibration/domain/eligibility.ts:43` demands
 * `safety.emergencyStopAvailable && thermalProtectionConfirmed &&
 * ventilationAssessed`, and IS live via `reducer.ts:115` (create) and
 * `reducer.ts:726` (replay). Fact Checker confirmed this independently
 * via a second empirical test.
 *
 * So even if the profile-selection flow is built correctly and the
 * operator picks all three profiles, the "Create calibration project"
 * action stays blocked because the binding fails `bindingDiagnostics`.
 * The end-state test in this file asserts explicitly that the operator
 * can PROCEED after choosing all three profiles — that is the "fourth
 * green-but-broken PR" trap.
 *
 * SERVER-SIDE VS CLIENT-SIDE APPLICABILITY FILTERING — THE HIGHEST-VALUE
 * ASSERTION
 *
 * From the api-contract report:
 *
 *   - System process/filament profiles are filtered server-side by
 *     OrcaSlicer's `compatible_printers` / `compatible_printers_condition`
 *     semantics inside `POST /api/slicer/profiles/{process,filament}/
 *     for-machines`. The API just forwards `{machineNames}` to the
 *     worker; correct implementations pass `[selectedMachineName]` and
 *     render what comes back.
 *
 *   - **Custom (user-created) profiles are NOT returned by the
 *     `/for-machines` endpoints.** They come only from
 *     `GET /api/slicer/profiles/custom`, which returns ALL of the user's
 *     custom profiles regardless of applicability. Filtering is
 *     entirely client-side: match `printerModelId` for machine/process,
 *     or parse `rawJson.compatible_printers` and check membership for
 *     filament (`NewSliceJobPage.tsx:1024-1038`).
 *
 * That asymmetry is a bug-farm — the server-filtered path will look
 * correct in review while the client-side path silently passes every
 * custom profile through. This file's dedicated custom-profile
 * applicability test guards that gap.
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

// Deterministic Guids for the profile-selection fixture. Any UUID works here;
// they must be well-formed because `CalibrationSlicerProfileRef.guid` and
// `CalibrationCustomProfileRef.id` are declared as `.uuid()` on the wire.
const SYSTEM_MACHINE_GUID = '22222222-2222-4222-8222-222222222201';
const SYSTEM_PROCESS_GUID = '22222222-2222-4222-8222-222222222202';
const SYSTEM_FILAMENT_GUID = '22222222-2222-4222-8222-222222222203';
const APPLICABLE_CUSTOM_FILAMENT_GUID = '22222222-2222-4222-8222-222222222204';
const INAPPLICABLE_CUSTOM_FILAMENT_GUID =
  '22222222-2222-4222-8222-222222222205';
const CUSTOM_MACHINE_GUID = '22222222-2222-4222-8222-222222222206';
const CUSTOM_PROCESS_GUID = '22222222-2222-4222-8222-222222222207';
// The catalog model Guid the fixture printer references. Bishop's commit
// `9f62a958` added `printerModelId` to `CalibrationPrinterCandidate` via
// enrichment from `GET /api/printers/{id}/details`; the fixture in this
// file leaves it `null` deliberately so the custom machine/process filter
// falls back to "no model — include all", which is the permissive fallback
// the cascade uses when the server cannot supply a model. The matched-
// predicate pair proving the wiring is exercised lives in
// `tests/calibrationPrinterModelIdWiring.test.tsx`.
const CUSTOM_PRINTER_MODEL_GUID = '22222222-2222-4222-8222-2222222222aa';
// The canonical Name string for the sample system machine. `POST /api/slicer/
// profiles/filament/for-machines` takes `{ machineNames: [<this>] }`; the
// custom filament filter uses this same string to test `.includes()` on
// `compatiblePrinters`.
const SAMPLE_MACHINE_NAME = 'K1 Max 0.4';

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

function customMachine(
  id: string,
  name: string,
  printerModelId: string | null,
): CalibrationCustomProfileRef {
  return {
    id,
    name,
    profileType: 'machine' as const,
    printerModelId,
    compatiblePrinters: null,
    createdAt: null,
  };
}

function customProcess(
  id: string,
  name: string,
  printerModelId: string | null,
): CalibrationCustomProfileRef {
  return {
    id,
    name,
    profileType: 'process' as const,
    printerModelId,
    compatiblePrinters: null,
    createdAt: null,
  };
}

function customFilament(
  id: string,
  name: string,
  compatiblePrinters: readonly string[] | null,
): CalibrationCustomProfileRef {
  return {
    id,
    name,
    profileType: 'filament' as const,
    printerModelId: null,
    compatiblePrinters:
      compatiblePrinters === null ? null : [...compatiblePrinters],
    createdAt: null,
  };
}

const profileId = '11111111-1111-4111-8111-111111111111';
const now = '2026-08-23T02:29:44.441Z';

/**
 * A refused-but-online printer that mirrors PrintFarmer's live emitted
 * shape when the calibration columns are NULL on the Printer row.
 *
 * Every code below is verified against a real emit site in
 * `PrinterCalibrationContextService.cs`:
 *
 *   machine_profile_missing        :572
 *   process_profile_missing        :582
 *   filament_profile_missing       :592
 *   nozzle_diameter_missing        :1542
 *   nozzle_material_missing        :1554
 *
 * (api-contract report, 2026-08-22 — verified against
 * `OlyForge3D/PrintFarmer` @ `b0a021000639d5ef69c818c89877520793d9f9e8`.)
 *
 * This is NOT a self-authored fixture that agrees with our own mapping —
 * every value is a real server-emitted code. Do not remove the citations;
 * they are what makes the fixture a controlled contract rather than a
 * mirror of the desktop's expectations.
 */
function refusedButRealPrinter(
  printerId: string,
  displayName: string,
): CalibrationPrinterCandidate {
  return {
    printerId,
    displayName,
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
      message: `${name}: not implemented in profile-selection acceptance test.`,
      retryable: false,
      retryAfterSeconds: null,
      reference: null,
    },
  };
}

/**
 * A minimal `CalibrationApi` stub for the profile-selection acceptance
 * flow. Names, shapes, and applicability rules mirror the verified
 * contract:
 *
 *   - System machine profiles come from
 *     `GET /api/slicer/profiles/machine/for-model/{modelId}?slicerEngineVersion=`
 *     — identity is the canonical `Name` string; there is NO `Id` field.
 *   - System process/filament profiles come from
 *     `POST /api/slicer/profiles/{process,filament}/for-machines` with
 *     `{ machineNames: [M] }` — the worker has already filtered by
 *     `compatible_printers` server-side.
 *   - Custom profiles come from `GET /api/slicer/profiles/custom` —
 *     ALL of them, filtered CLIENT-SIDE by `printerModelId` (machine/
 *     process) or by parsing `rawJson.compatible_printers` (filament).
 *
 * NOTE ON THE MOCK SURFACE
 *
 * `CalibrationApi` is a `Pick<PrintFarmerApi, ...>` over renderer-visible
 * calibration channels. The new profile-selection channels
 * (`listCalibrationMachineProfiles` / `listCalibrationProcessProfiles`
 * / `listCalibrationFilamentProfiles` / `saveCalibrationSetup`) have not
 * yet been declared in `src/shared/ipc.ts` — Bishop owns landing them.
 * Until they exist, the current `CalibrationApi` type does not include
 * them, and the wizard has nothing to call. That is precisely why every
 * assertion below fails today: not because the mock is wrong, but
 * because the flow does not exist yet.
 *
 * When Bishop lands those channels, this stub should grow to return:
 *   - system machine list (`MachineProfileDto[]` — Name is identity)
 *   - custom list (`CustomProfile[]` — Guid Id, printerModelId,
 *     rawJson.compatible_printers)
 *   - process list (`ProcessProfileDto[]`) filtered server-side by M
 *   - filament list (`FilamentProfileDto[]`) filtered server-side by M
 *
 * The dedicated custom-profile applicability test below stubs the
 * relevant fetch surface directly on `window.printFarmer` under
 * a `TODO(hicks/bishop)` marker so it exercises the client-side
 * filtering path once it lands.
 */
function profileSelectionApi(): CalibrationApi {
  return {
    getCalibrationAvailability: vi.fn().mockResolvedValue(availability()),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockResolvedValue(null),
    saveCalibrationWorkspaceState: vi.fn(),
    listCalibrationPrinters: vi.fn().mockResolvedValue(
      CalibrationListPrintersResponse.parse({
        printers: [refusedButRealPrinter('printer-a', 'Emulator cell A')],
        printersTruncated: false,
        printersUnreadable: 0,
        fetchedAt: now,
      }),
    ),
    // The new profile-selection flow does not need per-printer server
    // eligibility. If the wizard still calls this, the assertions below
    // fail — which is the correct signal (old gating model still in
    // effect). Rejecting rather than resolving makes the misuse visible.
    getCalibrationPrinterContext: vi
      .fn()
      .mockRejectedValue(
        new Error(
          'getCalibrationPrinterContext: profile-selection flow must not ' +
            'require per-printer server eligibility (owner directive; ' +
            'api-contract report §F.4 — real printers are never auto-' +
            'populated, so gating on eligibility dead-ends the operator).',
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
    // --- Path C: profile-selection channels (Bishop's 6 IPC surface) ------
    //
    // The fixture below is the acceptance-test-side counterpart of the
    // renderer cascade. It:
    //   - Advertises ONE system machine profile (SYSTEM_MACHINE_GUID,
    //     SAMPLE_MACHINE_NAME) so `hasSystem` in the second assertion above
    //     evaluates to true.
    //   - Advertises TWO custom filaments — one applicable, one
    //     inapplicable — so the custom-profile applicability pair below
    //     runs a real client-side filter over real fixture data.
    //   - Wires `listCalibrationMachineProfilesForModel` to return the
    //     `noModelAlias: false` branch AT the same profile, so the machine
    //     dropdown has a working option regardless of whether the renderer
    //     falls back to `/extended` when the printer carries no
    //     `printerModelId`.
    listCalibrationExtendedProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      machineProfiles: [
        systemProfile(SAMPLE_MACHINE_NAME, SYSTEM_MACHINE_GUID, 'Bed 300×300'),
      ],
      processProfiles: [
        systemProfile('0.20mm Standard', SYSTEM_PROCESS_GUID, '0.4 nozzle'),
      ],
      filamentProfiles: [
        systemProfile('Generic PLA', SYSTEM_FILAMENT_GUID, 'PLA'),
      ],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationMachineProfilesForModel: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [
        systemProfile(SAMPLE_MACHINE_NAME, SYSTEM_MACHINE_GUID, 'Bed 300×300'),
      ],
      noModelAlias: false,
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationProcessProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [
        systemProfile('0.20mm Standard', SYSTEM_PROCESS_GUID, '0.4 nozzle'),
      ],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationFilamentProfilesForMachines: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [systemProfile('Generic PLA', SYSTEM_FILAMENT_GUID, 'PLA')],
      profilesTruncated: false,
      fetchedAt: now,
    }),
    listCalibrationCustomProfiles: vi.fn().mockResolvedValue({
      status: 'ok' as const,
      profiles: [
        customMachine(
          CUSTOM_MACHINE_GUID,
          'My custom K1 clone',
          CUSTOM_PRINTER_MODEL_GUID,
        ),
        customProcess(
          CUSTOM_PROCESS_GUID,
          'My tuned 0.20 process',
          CUSTOM_PRINTER_MODEL_GUID,
        ),
        customFilament(
          APPLICABLE_CUSTOM_FILAMENT_GUID,
          'Applicable custom filament',
          [SAMPLE_MACHINE_NAME],
        ),
        customFilament(
          INAPPLICABLE_CUSTOM_FILAMENT_GUID,
          'Inapplicable custom filament',
          ['Some OTHER machine'],
        ),
      ],
      fetchedAt: now,
    }),
    cloneCalibrationFilamentProfile: vi
      .fn()
      .mockResolvedValue(notImplemented('cloneCalibrationFilamentProfile')),
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
    submitCalibrationObservation: vi
      .fn()
      .mockRejectedValue(new Error('notImplemented')),
    completeCalibrationProject: vi
      .fn()
      .mockRejectedValue(new Error('notImplemented')),
    deleteWorkingCloneProfile: vi
      .fn()
      .mockRejectedValue(new Error('notImplemented')),
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
      return `bbbbbbbb-bbbb-4bbb-8bbb-${sequence.toString().padStart(12, '0')}`;
    },
    now: () => now,
  };
}

function mountWorkspace() {
  const api = profileSelectionApi();
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
  // Let the profile-selection cascade's `useEffect(loadCatalog)` run and its
  // three async fetches settle before we return. Without this, the very next
  // synchronous `queryByRole` in the test races the initial catalog load —
  // the machine selector renders but has no options yet, so every test past
  // "selector exists" fails on a timing artifact rather than the flow.
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

/**
 * `fireEvent.change` on the machine dropdown triggers a second async load
 * (`loadForMachine`) inside the cascade. Its `<select>` for process/filament
 * renders synchronously with no options, then the async setState populates
 * it. This helper picks the machine and then awaits the process selector to
 * become populated, so the caller's next assertion sees a settled UI. It
 * replaces the raw `fireEvent.change` pattern; the underlying assertion is
 * unchanged.
 */
async function pickMachineAndAwaitProcess(
  machineSelector: Element,
  value: string,
): Promise<void> {
  fireEvent.change(machineSelector, { target: { value } });
  await waitFor(() => {
    const processSelector = screen.queryByRole('combobox', {
      name: /process profile/i,
    });
    if (processSelector === null) return;
    const populated = Array.from(
      processSelector.querySelectorAll('option'),
    ).some((option) => option.value.length > 0);
    if (!populated)
      throw new Error('process selector not populated yet after machine pick');
  });
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.useRealTimers());

/**
 * Each `it` block asserts one operator-observable proposition. They are
 * stated separately so the failure output pinpoints which stage of the
 * cascade is missing. Every proposition is expected to FAIL today; when
 * each flips green, the corresponding part of the flow genuinely works.
 */
describe.skip('CalibrationWorkspace profile-selection flow (owner directive 2026-08-22)', () => {
  // Skipped under #756: exercises the saga's "New calibration project"
  // wizard's profile-selection step. That wizard was removed. The filament
  // wizard's profile-selection has dedicated coverage.
  it('picking a printer reveals a machine-profile selector to the operator', async () => {
    // The owner directive: after picking a printer, PFD requests machine
    // profiles from the API. Concretely (api-contract report §A.1):
    //   GET /api/slicer/profiles/machine/for-model/{modelId}?slicerEngineVersion=
    // returning `List<MachineProfileDto>` — system profiles keyed by
    // canonical Name string, NO `Id` field. The operator-observable
    // outcome is a labeled combobox they can find and interact with.
    // Today the wizard has only one flat "Base OrcaSlicer profile"
    // dropdown inside a fieldset disabled by `!printerReady`.
    mountWorkspace();
    await openWizardAndPickPrinter();

    const machineSelector = screen.queryByRole('combobox', {
      name: /machine profile/i,
    });
    expect(
      machineSelector,
      'After picking a printer, the operator must see a control labeled ' +
        '"machine profile" listing system + user machine profiles. The ' +
        'current wizard has no such control — profile selection lives ' +
        'in a fieldset gated on server eligibility that never fires for ' +
        'the refused printers this environment actually sends. See ' +
        'api-contract report §A.1 for the endpoint contract.',
    ).not.toBeNull();
    if (machineSelector !== null) {
      expect(machineSelector).not.toBeDisabled();
    }
  });

  it('the machine selector lists BOTH system and user machine profiles', async () => {
    // The owner directive: "system machine profiles + any user-created
    // profiles". The API distinguishes them structurally (api-contract
    // report §A.5 / §C):
    //   - System profiles come from `/for-machines` and `/for-model` —
    //     no `Id` field; identified by canonical `Name`.
    //   - Custom profiles come from `GET /api/slicer/profiles/custom` —
    //     each has `id: Guid` and `isSystem: false`.
    // React's reference (`NewSliceJobPage.tsx`) merges them client-side:
    // custom starred first, then system grouped by nozzle.
    //
    // Because there is no `isSystem` flag on the worker DTOs and the
    // wire-level distinction is by ORIGIN (which endpoint they came
    // from), this test looks for a UI-level cue in the option text /
    // grouping. It matches EITHER inline text OR an `<optgroup>` label
    // that flags "system" and "user"/"custom" — invariant to whether
    // Dallas groups with `<optgroup>` or a text suffix.
    //
    // TODO(hicks/dallas): if Dallas ships another way of expressing the
    // origin (icon-only, badge component, ARIA description), update
    // the matcher. The load-bearing claim — "both origins are visible
    // to the operator" — does not change.
    mountWorkspace();
    await openWizardAndPickPrinter();

    const machineSelector = screen.queryByRole('combobox', {
      name: /machine profile/i,
    });
    if (machineSelector === null) {
      expect.fail(
        'Machine-profile selector missing; the system + user assertion ' +
          'is vacuous. See the "machine-profile selector" test above.',
      );
    }
    // Sample every text node the operator can see: option text plus
    // any optgroup label. Both `<optgroup label="System">` and inline
    // "System" text in the option should count.
    const options = Array.from(machineSelector.querySelectorAll('option'));
    const optgroups = Array.from(machineSelector.querySelectorAll('optgroup'));
    const optionTexts = options.map(
      (option) => option.textContent?.toLowerCase() ?? '',
    );
    const groupLabels = optgroups.map((group) =>
      (group.getAttribute('label') ?? '').toLowerCase(),
    );
    const surfaceTexts = [...optionTexts, ...groupLabels];
    const hasSystem = surfaceTexts.some((text) =>
      /system|built-in|orca(slicer)?|stock/.test(text),
    );
    const hasUser = surfaceTexts.some((text) =>
      /user|mine|custom|my profile/.test(text),
    );
    expect(
      hasSystem && hasUser,
      `Expected the machine-profile dropdown to expose BOTH system and ` +
        `user profiles. Option texts: [${optionTexts.join(', ')}]. ` +
        `Optgroup labels: [${groupLabels.join(', ')}]. ` +
        `System origin visible: ${hasSystem ? 'yes' : 'NO'}. ` +
        `User origin visible: ${hasUser ? 'yes' : 'NO'}.`,
    ).toBe(true);
  });

  it('picking a machine profile reveals a process-profile selector filtered by machine applicability', async () => {
    // The owner directive: "filtered to those applicable to the chosen
    // machine profile." The API's `POST /api/slicer/profiles/process/
    // for-machines` (api-contract report §A.2) accepts
    // `{ machineNames: [M] }` and returns process profiles the worker
    // has already filtered by `compatible_printers` /
    // `compatible_printers_condition`. Concretely observable: the
    // process selector appears after machine chosen, and its option
    // set changes when a different machine is chosen. That is
    // shape-invariant.
    mountWorkspace();
    await openWizardAndPickPrinter();

    const machineSelector = screen.queryByRole('combobox', {
      name: /machine profile/i,
    });
    if (machineSelector === null) {
      expect.fail(
        'Machine-profile selector missing; the machine-picked → process ' +
          'assertion is vacuous.',
      );
    }
    const machineOptions = Array.from(
      machineSelector.querySelectorAll('option'),
    ).filter((option) => option.value.length > 0);
    if (machineOptions.length === 0) {
      expect.fail('Machine-profile selector has no selectable options.');
    }
    await pickMachineAndAwaitProcess(machineSelector, machineOptions[0]!.value);

    const processSelector = screen.queryByRole('combobox', {
      name: /process profile/i,
    });
    expect(
      processSelector,
      'After picking a machine profile, the operator must see a control ' +
        'labeled "process profile" whose options are filtered to those ' +
        'applicable to the chosen machine. Endpoint: POST /api/slicer/' +
        'profiles/process/for-machines with { machineNames: [M] }.',
    ).not.toBeNull();
    if (processSelector !== null) {
      expect(processSelector).not.toBeDisabled();
    }
  });

  it('picking a process profile reveals a filament-profile selector', async () => {
    // Same shape as process (api-contract report §A.3):
    //   POST /api/slicer/profiles/filament/for-machines
    //   Body: { machineNames: [M] }
    //   → List<FilamentProfileDto>
    mountWorkspace();
    await openWizardAndPickPrinter();

    const machineSelector = screen.queryByRole('combobox', {
      name: /machine profile/i,
    });
    if (machineSelector === null) {
      expect.fail(
        'Machine-profile selector missing; the process → filament ' +
          'assertion is vacuous.',
      );
    }
    const machineOptions = Array.from(
      machineSelector.querySelectorAll('option'),
    ).filter((option) => option.value.length > 0);
    if (machineOptions.length === 0) {
      expect.fail('Machine-profile selector has no selectable options.');
    }
    await pickMachineAndAwaitProcess(machineSelector, machineOptions[0]!.value);

    const processSelector = screen.queryByRole('combobox', {
      name: /process profile/i,
    });
    if (processSelector === null) {
      expect.fail('Process-profile selector missing; test is vacuous.');
    }
    const processOptions = Array.from(
      processSelector.querySelectorAll('option'),
    ).filter((option) => option.value.length > 0);
    if (processOptions.length === 0) {
      expect.fail('Process-profile selector has no selectable options.');
    }
    fireEvent.change(processSelector, {
      target: { value: processOptions[0]!.value },
    });

    const filamentSelector = screen.queryByRole('combobox', {
      name: /filament profile/i,
    });
    expect(
      filamentSelector,
      'After picking a process profile, the operator must see a control ' +
        'labeled "filament profile" whose options are filtered to those ' +
        'applicable to the chosen machine.',
    ).not.toBeNull();
    if (filamentSelector !== null) {
      expect(filamentSelector).not.toBeDisabled();
    }
  });

  // Retired 2026-08-23 after the owner reframed the feature from "printer
  // calibration" to "filament calibration" (see
  // `.squad/decisions/inbox/vasquez-filament-calibration-reframe.md`). The
  // "Save calibration setup" / setup-persistence button was removed with the
  // `PUT /api/printers/{id}/calibration-setup` pipeline; the profile-selection
  // cascade is now purely presentational. The remaining cascade-rendering
  // tests earlier in this file are the active guard.

  // Historic scaffolding: a control asserting the machine-profile selector
  // did NOT exist yet. Deleted per the owner directive once the profile-
  // selection flow lands — the acceptance tests above take over as the
  // active guard.
});

/**
 * The custom-profile applicability filter — the highest-value assertion
 * in this batch (Vasquez, 2026-08-22T19:29:44-07:00).
 *
 * The asymmetry (api-contract report §A.5, §B):
 *
 *   - System profiles arrive PRE-FILTERED from `/for-machines`. The
 *     desktop passes `machineNames: [selectedMachineName]` and the
 *     worker returns only applicable profiles. Nothing to test on the
 *     desktop side beyond "the request was made" — but we do not
 *     assert on `mock.calls` because that would be an internal-shape
 *     assertion.
 *
 *   - Custom profiles arrive UNFILTERED from `GET /api/slicer/profiles/
 *     custom`. The desktop is responsible for filtering client-side:
 *       - machine/process: match `printerModelId` (with legacy fuzzy
 *         fallback via `classifyCustomProfileScope`)
 *       - filament: parse `rawJson.compatible_printers` and check
 *         membership of the selected machine profile's exact Name
 *   - The React reference implementation is at
 *     `NewSliceJobPage.tsx:1024-1038`.
 *
 * The failure mode this test guards: server filtering is correct
 * server-side; the desktop looks like it's working end-to-end because
 * options appear and the operator can pick something. But if the
 * client-side custom-profile filter is missing or wrong, an
 * inapplicable custom filament profile silently gets offered — and
 * when the operator picks it, `POST /api/slice` fails at the worker
 * or the print fails mid-run. Server-visible failure, no client-side
 * warning.
 *
 * Assertion strategy: TWO fixtures on the same test.
 *   FAILING PROPOSITION — a custom filament whose
 *     `compatible_printers` does NOT contain M is ABSENT from the
 *     filament dropdown.
 *   MATCHING-PREDICATE CONTROL — a custom filament whose
 *     `compatible_printers` DOES contain M IS PRESENT.
 * If both hold, the client-side filter is doing its job.
 *
 * TODO(hicks/bishop): the exact `window.printFarmer` channel for
 * `listCalibrationCustomProfiles` is not yet declared in
 * `src/shared/ipc.ts`. When Bishop lands it, wire the fixture below
 * to the real channel. Today the test still fails at the primary
 * check — the filament selector does not exist — so the client-side
 * filter code path has nothing to run yet. That is the correct
 * signal.
 */
describe.skip('custom-profile applicability filter (server vs client asymmetry)', () => {
  it('a custom filament whose compatible_printers does NOT include the chosen machine is excluded from the filament dropdown', async () => {
    mountWorkspace();
    await openWizardAndPickPrinter();

    // If the machine selector does not exist, the whole cascade is
    // unreachable; the applicability-filter test is vacuous. Fail with
    // a clear message so the reader knows the failure is not "the
    // filter is broken" but "the flow does not exist yet".
    const machineSelector = screen.queryByRole('combobox', {
      name: /machine profile/i,
    });
    if (machineSelector === null) {
      expect.fail(
        'Machine-profile selector missing; the custom-profile filter ' +
          'assertion is vacuous. This test flips green only after the ' +
          'profile-selection flow lands (see the acceptance tests above).',
      );
    }
    const machineOptions = Array.from(
      machineSelector.querySelectorAll('option'),
    ).filter((option) => option.value.length > 0);
    if (machineOptions.length === 0) {
      expect.fail('Machine-profile selector has no selectable options.');
    }
    // Pick the FIRST machine. The custom filament fixture (which will
    // be plumbed in when Bishop lands the channel) is authored so that
    // a custom filament tagged `compatible_printers: ["Some OTHER
    // machine"]` is offered by `/custom` but should be filtered OUT
    // by the client for THIS machine. If the filament dropdown
    // includes that custom filament's name, the client-side filter
    // failed.
    await pickMachineAndAwaitProcess(machineSelector, machineOptions[0]!.value);

    // Traverse to the filament dropdown via the process step.
    const processSelector = screen.queryByRole('combobox', {
      name: /process profile/i,
    });
    if (processSelector === null) {
      expect.fail(
        'Process-profile selector missing after machine chosen; the ' +
          'filament-filter assertion is vacuous.',
      );
    }
    const processOptions = Array.from(
      processSelector.querySelectorAll('option'),
    ).filter((option) => option.value.length > 0);
    if (processOptions.length === 0) {
      expect.fail('Process-profile selector has no selectable options.');
    }
    fireEvent.change(processSelector, {
      target: { value: processOptions[0]!.value },
    });

    const filamentSelector = screen.queryByRole('combobox', {
      name: /filament profile/i,
    });
    if (filamentSelector === null) {
      expect.fail(
        'Filament-profile selector missing after process chosen; the ' +
          'filament-filter assertion is vacuous.',
      );
    }
    // The filter's failure mode is *false positive* — a custom
    // filament tagged for a different machine appearing in the list.
    // We use a well-known sentinel name: any custom filament option
    // matching `/inapplicable custom filament/i` means the filter did
    // not fire.
    //
    // The fixture that seeds this sentinel is stubbed at the
    // `window.printFarmer.listCalibrationCustomProfiles` channel once
    // Bishop lands it. Until then, the check is vacuous by design —
    // the filament selector does not exist. That is why the whole
    // block is guarded by `expect.fail` earlier.
    const filamentOptions = Array.from(
      filamentSelector.querySelectorAll('option'),
    );
    const inapplicable = filamentOptions.some((option) =>
      /inapplicable custom filament/i.test(option.textContent ?? ''),
    );
    expect(
      inapplicable,
      'A custom filament whose compatible_printers does NOT contain the ' +
        'chosen machine profile appeared in the filament dropdown. That ' +
        'means the client-side applicability filter (equivalent to ' +
        "NewSliceJobPage.tsx:1024-1038's " +
        '`compatible.some(c => c === selectedMachineProfileId)`) did not ' +
        'fire. The server-side /for-machines endpoints filter system ' +
        'profiles server-side; custom profiles come from /custom ' +
        'UNFILTERED and MUST be filtered client-side.',
    ).toBe(false);
  });

  it('control: a custom filament whose compatible_printers DOES include the chosen machine IS present in the filament dropdown', async () => {
    // Strict inversion of the assertion above, on the same fixture
    // (once Bishop lands the channel). If BOTH pass, the client-side
    // filter is working correctly.
    //
    // TODO(hicks/bishop): once the custom-profile channel is landed,
    // wire the fixture so that at least one custom filament has
    // `compatible_printers` containing the selected machine name. Its
    // display text should match `/applicable custom filament/i`.
    mountWorkspace();
    await openWizardAndPickPrinter();

    const machineSelector = screen.queryByRole('combobox', {
      name: /machine profile/i,
    });
    if (machineSelector === null) {
      expect.fail(
        'Machine-profile selector missing; the applicable-inclusion ' +
          'control is vacuous.',
      );
    }
    const machineOptions = Array.from(
      machineSelector.querySelectorAll('option'),
    ).filter((option) => option.value.length > 0);
    if (machineOptions.length === 0) {
      expect.fail('Machine-profile selector has no selectable options.');
    }
    await pickMachineAndAwaitProcess(machineSelector, machineOptions[0]!.value);

    const processSelector = screen.queryByRole('combobox', {
      name: /process profile/i,
    });
    if (processSelector === null) {
      expect.fail('Process-profile selector missing; control vacuous.');
    }
    const processOptions = Array.from(
      processSelector.querySelectorAll('option'),
    ).filter((option) => option.value.length > 0);
    if (processOptions.length === 0) {
      expect.fail('Process-profile selector has no selectable options.');
    }
    fireEvent.change(processSelector, {
      target: { value: processOptions[0]!.value },
    });

    const filamentSelector = screen.queryByRole('combobox', {
      name: /filament profile/i,
    });
    if (filamentSelector === null) {
      expect.fail('Filament-profile selector missing; control vacuous.');
    }
    const filamentOptions = Array.from(
      filamentSelector.querySelectorAll('option'),
    );
    const applicable = filamentOptions.some((option) =>
      /applicable custom filament/i.test(option.textContent ?? ''),
    );
    expect(
      applicable,
      'A custom filament tagged as applicable to the chosen machine did ' +
        'NOT appear in the filament dropdown. Either the /custom fetch ' +
        'was not made, or the client-side filter over-filtered (rejected ' +
        'an applicable profile). Either failure is worse than the ' +
        'false-positive: the operator cannot pick a profile they own.',
    ).toBe(true);
  });
});

/**
 * Eligibility ordering — the regression trap Vasquez called out.
 *
 * The current bug is that the desktop gates on
 * `GET /api/printers/{id}/calibration-context.eligible == true` BEFORE
 * offering the operator any way to configure the printer. Because real
 * printers ship with the calibration columns NULL, that gate never
 * opens (api-contract report §F.4).
 *
 * The correct ordering: profile-selection is offered UNGATED, and
 * eligibility is re-checked AFTER
 * `PUT /api/printers/{id}/calibration-setup` succeeds. If this ordering
 * regresses (someone re-adds an up-front eligibility check), the fix
 * lands green in CI but the feature is dead again.
 *
 * This test's assertion: no `getCalibrationPrinterContext` call happens
 * BEFORE the machine selector is presented. That is technically an
 * assertion on `mock.calls`, which the previous notes flagged as an
 * anti-pattern. It is used here because the alternative — asserting
 * "no error banner mentions eligibility" — is too fragile and could
 * false-pass by wording changes. `getCalibrationPrinterContext` is
 * mocked to REJECT (see the API stub above) precisely so that an
 * up-front call surfaces as a test failure via a rejected promise
 * bubbling up. That is a hybrid strategy: the internal-call assertion
 * is a belt over the observable-outcome suspenders.
 */
describe.skip('eligibility ordering: the machine selector is offered BEFORE server eligibility is checked', () => {
  it('picking a refused printer does NOT trigger an up-front getCalibrationPrinterContext call', async () => {
    // The API stub above rejects `getCalibrationPrinterContext` with a
    // pointed message about the flow. If the wizard calls it before
    // the machine selector is presented, the rejection bubbles up as
    // an unhandled rejection or renders as an error banner — either
    // way, the test fails on an observable outcome (either the
    // rejection or a visible error).
    //
    // The test is currently EXPECTED to fail on the primary
    // assertion below because the machine selector does not exist
    // yet. That failure is orthogonal to the ordering issue. Once
    // the machine selector lands, this test tightens the loop.
    const { api } = mountWorkspace();
    await openWizardAndPickPrinter();

    // OBSERVABLE OUTCOME: the machine selector is present. If it is,
    // eligibility ordering is correct — the flow reached step 2 of
    // the owner directive without first waiting on server
    // eligibility.
    const machineSelector = screen.queryByRole('combobox', {
      name: /machine profile/i,
    });
    expect(
      machineSelector,
      'The machine-profile selector is not present after picking a ' +
        'refused printer. Either the flow is not implemented (see the ' +
        'acceptance tests above), or an up-front eligibility check ' +
        'blocked it. Both are symptoms of the same class: gating ' +
        'profile selection on server eligibility.',
    ).not.toBeNull();

    // BELT (internal): getCalibrationPrinterContext was NOT called
    // during the up-front phase. If the wizard does need to call it
    // AFTER the operator has saved calibration-setup (the correct
    // ordering), that call happens later in the flow and this
    // assertion still holds at THIS moment.
    const contextCalls = vi.mocked(api.getCalibrationPrinterContext).mock.calls
      .length;
    expect(
      contextCalls,
      'getCalibrationPrinterContext was called BEFORE the machine ' +
        'selector was presented. The owner directive requires ' +
        'profile-selection to be offered UNGATED; eligibility is ' +
        're-checked AFTER PUT /calibration-setup succeeds, not before.',
    ).toBe(0);
  });
});
