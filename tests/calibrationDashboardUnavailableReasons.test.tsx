/**
 * Renderer test for `CalibrationDashboard` surfacing
 * `CalibrationAvailability.serverUnavailableReasons` (issue #788).
 *
 * `GET /api/calibration/capabilities` reports `serverUnavailableReasons` —
 * feature/code/message triples explaining exactly why a capability such as
 * slicing is unavailable — even when the overall `available` flag is true
 * (see `src/main/ipc.ts`, the comment above `serverUnavailableReasons` in the
 * capability-available branch: "Passed through even when calibration is
 * available so the renderer can still surface a disabled feature the
 * operator will hit later"). Before this fix the renderer read
 * `unavailableDetail` and `unavailableReason` but never touched
 * `serverUnavailableReasons`, so an operator whose server can open the
 * calibration workspace but cannot slice got zero warning before cloning a
 * profile toward a slice it could never run.
 *
 * This proves the reasons render (as operator-visible text) when present,
 * and — as a control — that nothing extra renders when the array is empty,
 * so a passing test can't be explained by the alert always rendering.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalibrationAvailability } from '@shared/ipc';
import { CalibrationWorkspace } from '../src/renderer/calibration';
import type { CalibrationApi } from '../src/renderer/calibration/api';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';

function availability(
  overrides: Partial<CalibrationAvailability> = {},
): CalibrationAvailability {
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
    serverUnavailableReasons: [],
    ...overrides,
  };
}

function apiWith(overrides: Partial<CalibrationApi> = {}): CalibrationApi {
  const notImplemented = () => new Error('unexpected call in this test');
  const base: CalibrationApi = {
    getCalibrationAvailability: vi.fn().mockResolvedValue(availability()),
    listCalibrationWorkspaceStates: vi
      .fn()
      .mockResolvedValue({ states: [], unhydratedProjects: [] }),
    getCalibrationWorkspaceState: vi.fn().mockRejectedValue(notImplemented()),
    saveCalibrationWorkspaceState: vi.fn(),
    listCalibrationPrinters: vi.fn().mockRejectedValue(notImplemented()),
    getCalibrationPrinterContext: vi.fn().mockRejectedValue(notImplemented()),
    listOrcaProfiles: vi.fn().mockRejectedValue(notImplemented()),
    syncCalibrationNow: vi.fn().mockRejectedValue(notImplemented()),
    exportOrcaProfile: vi.fn().mockRejectedValue(notImplemented()),
    pollCalibrationQueueChanges: vi.fn().mockRejectedValue(notImplemented()),
    getCalibrationSubscriptionResources: vi
      .fn()
      .mockRejectedValue(notImplemented()),
    listCalibrationExtendedProfiles: vi
      .fn()
      .mockRejectedValue(notImplemented()),
    listCalibrationMachineProfilesForModel: vi
      .fn()
      .mockRejectedValue(notImplemented()),
    listCalibrationProcessProfilesForMachines: vi
      .fn()
      .mockRejectedValue(notImplemented()),
    listCalibrationFilamentProfilesForMachines: vi
      .fn()
      .mockRejectedValue(notImplemented()),
    listCalibrationCustomProfiles: vi.fn().mockRejectedValue(notImplemented()),
    resolveSystemProfile: vi.fn().mockRejectedValue(notImplemented()),
    cloneCalibrationFilamentProfile: vi
      .fn()
      .mockRejectedValue(notImplemented()),
    submitCalibrationSlice: vi.fn().mockRejectedValue(notImplemented()),
    getCalibrationSliceJobStatus: vi.fn().mockRejectedValue(notImplemented()),
    sendCalibrationSliceToPrinter: vi.fn().mockRejectedValue(notImplemented()),
    updateCalibrationFilamentProfileMeasurement: vi
      .fn()
      .mockRejectedValue(notImplemented()),
    saveFilamentCalibrationWizardState: vi
      .fn()
      .mockRejectedValue(notImplemented()),
    getFilamentCalibrationWizardState: vi.fn().mockResolvedValue(null),
    clearFilamentCalibrationWizardState: vi
      .fn()
      .mockRejectedValue(notImplemented()),
    resolveCalibrationConflict: vi.fn().mockRejectedValue(notImplemented()),
    listCalibrationConflicts: vi.fn().mockResolvedValue({ conflicts: [] }),
  };
  return { ...base, ...overrides };
}

function mount(api: CalibrationApi) {
  Object.defineProperty(window, 'printFarmer', {
    configurable: true,
    value: api,
  });
  render(
    <CalibrationWorkspace
      selectedProfileId={PROFILE_ID}
      selectedProfileName="Farm server"
      onManageProfiles={vi.fn()}
      onFlushReady={() => undefined}
    />,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CalibrationDashboard serverUnavailableReasons', () => {
  it('surfaces the human-readable server-reported reasons before the operator can clone', async () => {
    const getCalibrationAvailability = vi.fn().mockResolvedValue(
      availability({
        serverUnavailableReasons: [
          {
            feature: 'slicing',
            code: 'slicer_registry_unavailable',
            message:
              'No OrcaSlicer worker is registered, so a clone cannot be sliced right now.',
          },
        ],
      }),
    );
    mount(apiWith({ getCalibrationAvailability }));

    expect(
      await screen.findByText(
        'No OrcaSlicer worker is registered, so a clone cannot be sliced right now.',
      ),
    ).toBeInTheDocument();
    // The primary clone action must still be reachable — the warning is
    // informational, not a hard gate, since the server reported `available`.
    expect(
      screen.getByRole('button', { name: 'Calibrate a filament spool' }),
    ).not.toBeDisabled();
  });

  it('renders nothing extra when serverUnavailableReasons is empty (control)', async () => {
    const getCalibrationAvailability = vi
      .fn()
      .mockResolvedValue(availability({ serverUnavailableReasons: [] }));
    mount(apiWith({ getCalibrationAvailability }));

    await screen.findByRole('button', { name: 'Calibrate a filament spool' });
    expect(
      screen.queryByText(/calibration capabilities are unavailable/i),
    ).not.toBeInTheDocument();
  });
});
