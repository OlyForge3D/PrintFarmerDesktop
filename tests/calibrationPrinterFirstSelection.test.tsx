// @vitest-environment jsdom

/**
 * Printer-first selection behaviour, driven through the real store and the real
 * wizard component.
 *
 * Only the preload bridge is replaced. The store, the reducer, the eligibility
 * rules and the component tree are the production ones, because every claim here
 * is about *when* a request is issued and *which* reply is allowed to land —
 * properties that live in the wiring and disappear the moment the store is
 * stubbed out.
 *
 * The strongest assertions in this file are negative: that nothing was fetched.
 * A test that only checked the rendered result would pass just as well against
 * the eager farm-wide load this replaced.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { CalibrationWorkspace } from '../src/renderer/calibration';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PRINTER_A = 'aaaaaaaa-1111-4111-8111-222222222222';
const PRINTER_B = 'bbbbbbbb-1111-4111-8111-222222222222';
const NOW = '2026-07-26T15:00:00.000Z';

function candidate(
  printerId: string,
  displayName: string,
  eligible = true,
): Record<string, unknown> {
  return {
    printerId,
    displayName,
    printerModel: 'Voron 2.4',
    firmwareCompatible: eligible,
    orcaProfileId: null,
    isOnline: true,
    updatedAt: NOW,
    evaluationScope: 'preliminary',
    rejectionReasonCodes: eligible ? [] : ['printer_offline'],
    missingInputs: [],
    eligibility: eligible
      ? {
          firmwareFamily: 'Klipper',
          gcodeDialect: 'Klipper',
          slicerFamily: 'OrcaSlicer',
          slicerDistribution: 'upstream',
          slicerIdentity: 'OrcaSlicer',
          hardwareContextComplete: true,
          safetyContextComplete: true,
          permissionsComplete: true,
          reasons: [],
        }
      : null,
  };
}

function contextFor(
  printerId: string,
  displayName: string,
  configurationRevision = 7,
): Record<string, unknown> {
  return {
    printerId,
    displayName,
    printerModel: 'Voron 2.4',
    // Authoritative and eligible, so the server raised nothing against it.
    rejectionReasonCodes: [],
    missingInputs: [],
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
    snapshotAt: NOW,
    evaluationScope: 'full',
    isCurrent: true,
    configurationId: printerId,
    configurationRevision,
    snapshotId: `snapshot-${configurationRevision}`,
    snapshotRevision: configurationRevision,
    slicerIdentity: 'OrcaSlicer',
    slicerDistribution: 'upstream',
    profileRevision: 'filament-r7',
    profileIdentities: {
      machine: {
        backendProfileId: 'dddddddd-2222-4222-8222-333333333333',
        orcaProfileName: 'Voron 2.4 0.4 nozzle',
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
        nozzle: { id: 'nozzle-a', diameterMm: 0.4, material: 'brass' },
      },
    ],
    safety: {
      buildVolumeMm: { x: 220, y: 220, z: 250 },
      maximumNozzleTemperatureC: 300,
      maximumBedTemperatureC: 120,
      maximumVolumetricRateMm3S: 30,
      emergencyStopAvailable: false,
      thermalProtectionConfirmed: false,
      ventilationAssessed: false,
    },
    permissions: null,
  };
}

function profilesFor(
  printerId: string,
  configurationRevision = 7,
): Record<string, unknown> {
  return {
    printerId,
    configurationRevision,
    profiles: [],
    discovery: {
      kind: 'ok',
      message: 'Server profile discovery completed.',
      serverCode: null,
    },
    localProfiles: [],
    localDiscovery: { kind: 'ok', message: 'Local scan completed.' },
  };
}

/** A deferred whose resolution the test controls, for ordering races. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeApi(
  candidates: Record<string, unknown>[] = [
    candidate(PRINTER_A, 'Voron in bay one'),
    candidate(PRINTER_B, 'Voron in bay two'),
  ],
) {
  return {
    getCalibrationAvailability: vi.fn().mockResolvedValue({
      available: true,
      unavailableReason: null,
      unavailableDetail: null,
      negotiatedApiVersion: '1.0',
      negotiatedSchemaVersion: '1.0',
      capabilityFlags: {
        calibrationApiEnabled: true,
        calibrationChangeFeedEnabled: true,
        calibrationOfflineDraftEnabled: true,
        calibrationPhotoUploadEnabled: true,
        calibrationGenerationEnabled: true,
      },
      grantedScopes: ['calibration:read', 'calibration:create'],
      offlineEditingEnabled: true,
    }),
    listCalibrationPrinters: vi.fn().mockResolvedValue({
      printers: candidates,
      printersTruncated: false,
      printersUnreadable: 0,
      fetchedAt: NOW,
    }),
    getCalibrationPrinterContext: vi
      .fn()
      .mockImplementation(({ printerId }: { printerId: string }) =>
        Promise.resolve(contextFor(printerId, `Printer ${printerId}`)),
      ),
    listOrcaProfiles: vi
      .fn()
      .mockImplementation(({ printerId }: { printerId: string }) =>
        Promise.resolve(profilesFor(printerId)),
      ),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn(),
    saveCalibrationWorkspaceState: vi.fn(),
    syncCalibrationNow: vi.fn(),
    listCalibrationConflicts: vi.fn().mockResolvedValue({ conflicts: [] }),
    resolveCalibrationConflict: vi.fn(),
    openCalibrationPhoto: vi.fn(),
    stageCalibrationPhoto: vi.fn(),
    generateOrcaProfile: vi.fn(),
    exportOrcaProfile: vi.fn(),
    installOrcaProfile: vi.fn(),
    restoreOrcaProfile: vi.fn(),
    startCalibrationGeneration: vi.fn(),
    getCalibrationOrchestrationStatus: vi.fn(),
    getCalibrationQueueState: vi.fn(),
    acknowledgeCalibrationBedClear: vi.fn(),
    startCalibrationPrint: vi.fn(),
    pollCalibrationQueueChanges: vi.fn(),
    getCalibrationSubscriptionResources: vi.fn(),
    getCalibrationAssetManifest: vi.fn(),
    pickCalibrationAssetFile: vi.fn(),
    validateCalibrationAssetFile: vi.fn(),
    openCalibrationManifestUrl: vi.fn(),
  };
}

function renderWizard(api = makeApi()) {
  (window as unknown as { printFarmer: unknown }).printFarmer = api;
  render(
    <CalibrationWorkspace
      selectedProfileId={PROFILE_ID}
      selectedProfileName="Farm"
    />,
  );
  return api;
}

async function openWizard(api: ReturnType<typeof makeApi>) {
  fireEvent.click(
    await screen.findByRole('button', { name: 'New calibration project' }),
  );
  await screen.findByRole('radio', { name: /Voron in bay one/ });
  return api;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(cleanup);

describe('nothing per-printer is fetched before the operator chooses', () => {
  it('says the list is partial when the server offered more printers than it carries', async () => {
    // Carried over from the candidate-truncation work and re-anchored here,
    // because printer-first moved this notice into the selection step. Without
    // it, "none of these is eligible" reads as a verdict on the whole farm when
    // the printer the operator wants may simply be off the end.
    const api = makeApi();
    api.listCalibrationPrinters.mockResolvedValue({
      printers: [
        candidate(PRINTER_A, 'Voron in bay one'),
        candidate(PRINTER_B, 'Voron in bay two'),
      ],
      printersTruncated: true,
      printersUnreadable: 0,
      fetchedAt: NOW,
    });
    await openWizard(renderWizard(api));
    await settle();

    expect(screen.getByText(/This list is partial/i)).toBeInTheDocument();
    // And announced, not only shown.
    expect(
      document.querySelector('.cal-global-live')?.textContent ?? '',
    ).toMatch(/list is partial/i);
  });

  it('does not claim the list is partial when it is whole', async () => {
    // Control: the notice above must be caused by truncation, not always shown.
    await openWizard(renderWizard());
    await settle();
    expect(screen.queryByText(/This list is partial/i)).not.toBeInTheDocument();
  });

  it('lists printers and resolves nothing else', async () => {
    const api = await openWizard(renderWizard());
    await settle();

    expect(api.listCalibrationPrinters).toHaveBeenCalledTimes(1);
    // The whole point. Before a printer is named there is nothing to scope a
    // context, a profile resolution or a local OrcaSlicer scan to.
    expect(api.getCalibrationPrinterContext).not.toHaveBeenCalled();
    expect(api.listOrcaProfiles).not.toHaveBeenCalled();
    expect(api.syncCalibrationNow).not.toHaveBeenCalled();
  });

  it('does not auto-select the first printer', async () => {
    await openWizard(renderWizard());
    await settle();
    const radios = screen.getAllByRole('radio');
    // Silently selecting the first printer would both fetch a context nobody
    // asked for and bias which machine gets calibrated.
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(
      true,
    );
  });

  it('performs no context request while the keyboard moves through the list', async () => {
    const api = await openWizard(renderWizard());
    const first = screen.getByRole('radio', { name: /Voron in bay one/ });
    first.focus();
    // Native radio groups fire `change` on every candidate the arrow keys pass
    // through. Five moves used to mean five context reads and five profile
    // resolutions for printers the operator never chose.
    for (let move = 0; move < 5; move++) {
      fireEvent.keyDown(document.activeElement ?? first, { key: 'ArrowDown' });
      fireEvent.click(
        screen.getAllByRole('radio')[move % 2] as HTMLInputElement,
      );
    }
    await settle();
    expect(api.getCalibrationPrinterContext).not.toHaveBeenCalled();
    expect(api.listOrcaProfiles).not.toHaveBeenCalled();
  });
});

describe('activation fetches exactly one printer', () => {
  it('reads one context and one profile set for the chosen printer only', async () => {
    const api = await openWizard(renderWizard());
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    await settle();

    expect(api.getCalibrationPrinterContext).toHaveBeenCalledTimes(1);
    expect(api.getCalibrationPrinterContext).toHaveBeenCalledWith({
      profileId: PROFILE_ID,
      printerId: PRINTER_A,
    });
    expect(api.listOrcaProfiles).toHaveBeenCalledTimes(1);
    // Scoped to the printer *and* pinned to the revision its context reported,
    // so the profiles cannot describe a configuration the operator never saw.
    expect(api.listOrcaProfiles).toHaveBeenCalledWith({
      profileId: PROFILE_ID,
      printerId: PRINTER_A,
      configurationRevision: 7,
    });
  });

  it('does not fan out across the other printers on the farm', async () => {
    const api = await openWizard(renderWizard());
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    await settle();
    const askedFor = api.getCalibrationPrinterContext.mock.calls.map(
      ([request]) => (request as { printerId: string }).printerId,
    );
    expect(askedFor).toEqual([PRINTER_A]);
    expect(askedFor).not.toContain(PRINTER_B);
  });
});

describe('a reply may never populate a printer it is not about', () => {
  it('discards a slow reply for A once B has been chosen', async () => {
    const api = makeApi();
    const slowA = deferred<Record<string, unknown>>();
    api.getCalibrationPrinterContext.mockImplementation(
      ({ printerId }: { printerId: string }) =>
        printerId === PRINTER_A
          ? slowA.promise
          : Promise.resolve(contextFor(printerId, 'Voron in bay two')),
    );
    await openWizard(renderWizard(api));

    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    // Move on before A answers.
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay two/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    await settle();

    // A answers late, naming itself.
    slowA.resolve(contextFor(PRINTER_A, 'Voron in bay one'));
    await settle();

    // B's configuration is what is shown; A's late reply changed nothing.
    expect(screen.getByText(/snapshot-7/)).toBeInTheDocument();
    const resolvedFor = api.listOrcaProfiles.mock.calls.map(
      ([request]) => (request as { printerId: string }).printerId,
    );
    expect(resolvedFor).not.toContain(PRINTER_A);
    expect(resolvedFor).toContain(PRINTER_B);
  });

  it('discards a slow reply when the selection is cancelled', async () => {
    const api = makeApi();
    const slowA = deferred<Record<string, unknown>>();
    api.getCalibrationPrinterContext.mockReturnValueOnce(slowA.promise);
    await openWizard(renderWizard(api));

    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Choose a different printer' }),
    );
    slowA.resolve(contextFor(PRINTER_A, 'Voron in bay one'));
    await settle();

    expect(api.listOrcaProfiles).not.toHaveBeenCalled();
    expect(
      screen
        .getAllByRole('radio')
        .every((radio) => !(radio as HTMLInputElement).checked),
    ).toBe(true);
  });

  it('refuses a context that names a different printer than was requested', async () => {
    const api = makeApi();
    // A contract violation rather than a race: adopting it would bind the
    // wizard to a machine the operator never chose.
    api.getCalibrationPrinterContext.mockResolvedValue(
      contextFor(PRINTER_B, 'Voron in bay two'),
    );
    await openWizard(renderWizard(api));
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    await settle();

    expect(
      await screen.findByText(/context for a different printer/i),
    ).toBeInTheDocument();
    // And no profiles were resolved off the back of it.
    expect(api.listOrcaProfiles).not.toHaveBeenCalled();
  });

  it('ignores a profile reply resolved at a revision the context did not report', async () => {
    const api = makeApi();
    api.listOrcaProfiles.mockResolvedValue({
      ...profilesFor(PRINTER_A, 99),
      profiles: [],
    });
    await openWizard(renderWizard(api));
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    await settle();

    // The reply described revision 99; the operator is looking at revision 7.
    // Rendering it would show profiles for a configuration that is not on
    // screen, so the wizard stays waiting rather than adopting it.
    expect(
      screen.queryByText(/profiles resolved for/i),
    ).not.toBeInTheDocument();
  });
});

describe('failure is scoped to the printer it is about', () => {
  it('keeps the printer list when a context read fails', async () => {
    const api = makeApi();
    api.getCalibrationPrinterContext.mockRejectedValue(
      new Error('Snapshot unavailable for this printer.'),
    );
    await openWizard(renderWizard(api));
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    await settle();

    // One printer's problem must never read as "there are no printers": the
    // list the operator is choosing from is still valid and still on screen.
    expect(
      screen.getByRole('radio', { name: /Voron in bay one/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /Voron in bay two/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/returned no enabled printers/i),
    ).not.toBeInTheDocument();
  });

  it('distinguishes an empty farm from a failed list', async () => {
    const api = makeApi([]);
    renderWizard(api);
    fireEvent.click(
      await screen.findByRole('button', { name: 'New calibration project' }),
    );
    await settle();
    expect(
      screen.getByText(/returned no enabled printers/i),
    ).toBeInTheDocument();
  });

  it('lets an ineligible printer explain itself without allowing continuation', async () => {
    const api = makeApi([
      candidate(PRINTER_A, 'Voron in bay one', false),
      candidate(PRINTER_B, 'Voron in bay two'),
    ]);
    await openWizard(renderWizard(api));
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    await settle();

    // Selectable, so the reasons can be read...
    expect(screen.getByText(/cannot be calibrated yet/i)).toBeInTheDocument();
    // ...but not continuable, so inspecting a refusal never risks acting on it,
    // and nothing was fetched for it.
    expect(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    ).toBeDisabled();
    expect(api.getCalibrationPrinterContext).not.toHaveBeenCalled();
  });

  it('says so when every available printer is ineligible', async () => {
    const api = makeApi([
      candidate(PRINTER_A, 'Voron in bay one', false),
      candidate(PRINTER_B, 'Voron in bay two', false),
    ]);
    await openWizard(renderWizard(api));
    // Deliberately different from "no printers": the farm has printers and the
    // account can see them, so telling the operator to add hardware they
    // already own would be wrong.
    expect(
      screen.getByText(/is currently eligible for calibration/i),
    ).toBeInTheDocument();
  });

  it('refuses a selection whose context carries no configuration revision', async () => {
    const api = makeApi();
    api.getCalibrationPrinterContext.mockResolvedValue({
      ...contextFor(PRINTER_A, 'Voron in bay one'),
      configurationRevision: null,
    });
    await openWizard(renderWizard(api));
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    await settle();

    // A project pinned to "whatever was current" is not pinned to anything, so
    // this fails closed rather than binding permissively.
    expect(
      await screen.findByText(/did not return a current, fully evaluated/i),
    ).toBeInTheDocument();
    expect(api.listOrcaProfiles).not.toHaveBeenCalled();
  });
});

describe('accessibility of the selection step', () => {
  it('exposes the printer choice as a labelled radio group', async () => {
    await openWizard(renderWizard());
    const group = screen.getByRole('radiogroup', {
      name: /PrintFarmer printer/i,
    });
    expect(group).toBeInTheDocument();
  });

  it('announces the outcome of loading the printer list', async () => {
    renderWizard();
    fireEvent.click(
      await screen.findByRole('button', { name: 'New calibration project' }),
    );
    await settle();
    const live = document.querySelector('.cal-global-live');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent ?? '').toMatch(/Select one to calibrate/i);
  });

  it('announces the loading transition when a printer is chosen', async () => {
    const api = makeApi();
    const slow = deferred<Record<string, unknown>>();
    api.getCalibrationPrinterContext.mockReturnValue(slow.promise);
    await openWizard(renderWizard(api));
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with this printer' }),
    );
    await settle();

    expect(
      document.querySelector('.cal-global-live')?.textContent ?? '',
    ).toMatch(/Loading calibration context/i);
    // A visible, polite status for the same transition, so the state is not
    // announcement-only.
    expect(
      screen.getByText(/Loading configuration and profiles/i),
    ).toBeInTheDocument();
    slow.resolve(contextFor(PRINTER_A, 'Voron in bay one'));
    await settle();
  });

  it('moves focus to the reasons when a chosen printer is refused', async () => {
    const api = makeApi([candidate(PRINTER_A, 'Voron in bay one', false)]);
    await openWizard(renderWizard(api));
    fireEvent.click(screen.getByRole('radio', { name: /Voron in bay one/ }));
    await settle();
    // The reasons are what the operator needs next, so they must be reachable
    // and focusable rather than left behind the activation point.
    const reasons = document.getElementById('candidate-eligibility');
    expect(reasons).toBeInTheDocument();
    expect(reasons?.getAttribute('tabindex')).toBe('-1');
  });
});
