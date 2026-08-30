/**
 * Renderer test for `CalibrationConflictsDialog` (issue #762).
 *
 * Exercises the restored renderer-facing calibration conflict resolution
 * surface directly, independent of `CalibrationDashboard`: loading the
 * conflict list, selecting a conflict, resolving it (including the
 * manual-field-merge path), and surfacing load/resolve errors. Every
 * assertion is on operator-observable outcomes (rendered DOM, the exact IPC
 * arguments sent) rather than on internal component state.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalibrationConflict } from '@shared/ipc';
import { CalibrationConflictsDialog } from '../src/renderer/calibration/CalibrationConflictsDialog';
import type { CalibrationApi } from '../src/renderer/calibration/api';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-08-24T02:29:44.441Z';

function conflict(
  overrides: Partial<CalibrationConflict> = {},
): CalibrationConflict {
  return {
    conflictId: '33333333-3333-4333-8333-333333333333',
    profileId: PROFILE_ID,
    projectId: PROJECT_ID,
    kind: 'stepDraft',
    entityId: '44444444-4444-4444-8444-444444444444',
    localPayloadSummary: JSON.stringify({ displayName: 'Local value' }),
    serverPayloadSummary: JSON.stringify({ displayName: 'Server value' }),
    serverRevision: 5,
    availableResolutions: ['acceptServer', 'keepLocalAsNewRevision'],
    resolvedAt: null,
    resolution: null,
    createdAt: NOW,
    ...overrides,
  };
}

function apiWith(overrides: Partial<CalibrationApi> = {}): CalibrationApi {
  const base: CalibrationApi = {
    getCalibrationAvailability: vi.fn(),
    listCalibrationPrinters: vi.fn(),
    getCalibrationPrinterContext: vi.fn(),
    listCalibrationWorkspaceStates: vi.fn(),
    getCalibrationWorkspaceState: vi.fn(),
    saveCalibrationWorkspaceState: vi.fn(),
    syncCalibrationNow: vi.fn(),
    listOrcaProfiles: vi.fn(),
    exportOrcaProfile: vi.fn(),
    pollCalibrationQueueChanges: vi.fn(),
    getCalibrationSubscriptionResources: vi.fn(),
    listCalibrationExtendedProfiles: vi.fn(),
    listCalibrationMachineProfilesForModel: vi.fn(),
    listCalibrationProcessProfilesForMachines: vi.fn(),
    listCalibrationFilamentProfilesForMachines: vi.fn(),
    listCalibrationCustomProfiles: vi.fn(),
    resolveSystemProfile: vi.fn(),
    createCalibrationProject: vi.fn(),
    getCalibrationMethodGuidanceCatalog: vi.fn(),
    getCalibrationMethodProgress: vi.fn(),
    setCalibrationMethodDisposition: vi.fn(),
    cloneCalibrationFilamentProfile: vi.fn(),
    submitCalibrationSlice: vi.fn(),
    getCalibrationSliceJobStatus: vi.fn(),
    sendCalibrationSliceToPrinter: vi.fn(),
    updateCalibrationFilamentProfileMeasurement: vi.fn(),
    saveFilamentCalibrationWizardState: vi.fn(),
    getFilamentCalibrationWizardState: vi.fn(),
    clearFilamentCalibrationWizardState: vi.fn(),
    resolveCalibrationConflict: vi
      .fn()
      .mockRejectedValue(new Error('unexpected call in this test')),
    listCalibrationConflicts: vi.fn().mockResolvedValue({ conflicts: [] }),
    listCalibrationSpoolmanSpools: vi.fn().mockResolvedValue({
      status: 'ok',
      spools: [],
      fetchedAt: '2026-08-24T02:29:44.441Z',
    }),
  };
  return { ...base, ...overrides };
}

function mount(
  api: CalibrationApi,
  props: Partial<
    Omit<React.ComponentProps<typeof CalibrationConflictsDialog>, 'profileId'>
  > = {},
) {
  Object.defineProperty(window, 'printFarmer', {
    configurable: true,
    value: api,
  });
  const onClose = props.onClose ?? vi.fn();
  const onResolved = props.onResolved ?? vi.fn();
  render(
    <CalibrationConflictsDialog
      profileId={PROFILE_ID}
      profileName="Farm server"
      onClose={onClose}
      onResolved={onResolved}
    />,
  );
  return { onClose, onResolved };
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CalibrationConflictsDialog', () => {
  it('loads and lists unresolved conflicts scoped to the given profile', async () => {
    const listCalibrationConflicts = vi
      .fn()
      .mockResolvedValue({ conflicts: [conflict()] });
    mount(apiWith({ listCalibrationConflicts }));

    await screen.findByText('Step draft');
    expect(listCalibrationConflicts).toHaveBeenCalledWith({
      profileId: PROFILE_ID,
    });
    expect(screen.getByText('1 unresolved')).toBeInTheDocument();
  });

  it('shows an empty state when the server reports no conflicts', async () => {
    mount(apiWith());
    expect(
      await screen.findByText('No calibration conflicts'),
    ).toBeInTheDocument();
  });

  it('shows a load error with a retry action', async () => {
    const listCalibrationConflicts = vi
      .fn()
      .mockRejectedValue(new Error('Server unreachable.'));
    mount(apiWith({ listCalibrationConflicts }));

    await screen.findByText(/Server unreachable\./);
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });

  it('resolves a conflict with acceptServer and reports superseded observations', async () => {
    const targetConflict = conflict();
    const listCalibrationConflicts = vi
      .fn()
      .mockResolvedValue({ conflicts: [targetConflict] });
    const resolveCalibrationConflict = vi.fn().mockResolvedValue({
      conflict: { ...targetConflict, resolution: 'acceptServer' },
      supersededObservations: [
        {
          observationId: 'obs-1',
          attemptId: 'attempt-1',
          stepId: 'step-1',
          parameterKey: 'flowRate',
          boundSnapshotRevision: 2,
        },
      ],
    });
    const { onResolved } = mount(
      apiWith({ listCalibrationConflicts, resolveCalibrationConflict }),
    );

    await screen.findByText('Step draft');
    fireEvent.click(
      screen.getByRole('radio', { name: 'Accept server version' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));

    await waitFor(() => {
      expect(resolveCalibrationConflict).toHaveBeenCalledWith({
        profileId: PROFILE_ID,
        conflictId: targetConflict.conflictId,
        resolution: 'acceptServer',
      });
    });
    expect(
      await screen.findByText(/1 recorded observation superseded/),
    ).toBeInTheDocument();
    expect(onResolved).toHaveBeenCalledTimes(1);
    // The resolved conflict drops out of the unresolved list.
    expect(screen.getByText('0 unresolved')).toBeInTheDocument();
  });

  it('sends mergedFields for a manualFieldMerge resolution', async () => {
    const mergeConflict = conflict({
      availableResolutions: ['manualFieldMerge'],
    });
    const listCalibrationConflicts = vi
      .fn()
      .mockResolvedValue({ conflicts: [mergeConflict] });
    const resolveCalibrationConflict = vi.fn().mockResolvedValue({
      conflict: { ...mergeConflict, resolution: 'manualFieldMerge' },
      supersededObservations: [],
    });
    mount(apiWith({ listCalibrationConflicts, resolveCalibrationConflict }));

    await screen.findByText('Step draft');
    fireEvent.click(
      screen.getByRole('radio', { name: 'Merge fields manually' }),
    );
    const field = await screen.findByLabelText('displayName');
    fireEvent.change(field, { target: { value: 'Merged value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));

    await waitFor(() => {
      expect(resolveCalibrationConflict).toHaveBeenCalledWith({
        profileId: PROFILE_ID,
        conflictId: mergeConflict.conflictId,
        resolution: 'manualFieldMerge',
        mergedFields: { displayName: 'Merged value' },
      });
    });
  });

  it('blocks manual merge when only one payload summary parses, instead of seeding from the other side alone', async () => {
    const mergeConflict = conflict({
      availableResolutions: ['manualFieldMerge'],
      localPayloadSummary: 'not valid json',
      serverPayloadSummary: JSON.stringify({ displayName: 'Server value' }),
    });
    const listCalibrationConflicts = vi
      .fn()
      .mockResolvedValue({ conflicts: [mergeConflict] });
    mount(apiWith({ listCalibrationConflicts }));

    await screen.findByText('Step draft');
    fireEvent.click(
      screen.getByRole('radio', { name: 'Merge fields manually' }),
    );

    expect(
      await screen.findByText(
        /Manual merge is blocked because one or both payload summaries are missing/,
      ),
    ).toBeInTheDocument();
    // The one side that did parse must not be offered as a silently-partial
    // field set.
    expect(screen.queryByLabelText('displayName')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Resolve conflict' }),
    ).toBeDisabled();
  });

  it('blocks manual merge when one side has a nested (non-scalar) top-level field, not just when it fails to parse', async () => {
    const mergeConflict = conflict({
      availableResolutions: ['manualFieldMerge'],
      localPayloadSummary: JSON.stringify({ nested: { x: 1 } }),
      serverPayloadSummary: JSON.stringify({ displayName: 'Server value' }),
    });
    const listCalibrationConflicts = vi
      .fn()
      .mockResolvedValue({ conflicts: [mergeConflict] });
    mount(apiWith({ listCalibrationConflicts }));

    await screen.findByText('Step draft');
    fireEvent.click(
      screen.getByRole('radio', { name: 'Merge fields manually' }),
    );

    expect(
      await screen.findByText(
        /Manual merge is blocked because one or both payload summaries are missing/,
      ),
    ).toBeInTheDocument();
    // Previously this field was still offered from the fully-scalar server
    // side alone, silently dropping the local side's unmergeable content.
    expect(screen.queryByLabelText('displayName')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Resolve conflict' }),
    ).toBeDisabled();
  });

  it('shows a resolve error without dropping the conflict from the list', async () => {
    const targetConflict = conflict();
    const listCalibrationConflicts = vi
      .fn()
      .mockResolvedValue({ conflicts: [targetConflict] });
    const resolveCalibrationConflict = vi
      .fn()
      .mockRejectedValue(new Error('Revision conflict.'));
    mount(apiWith({ listCalibrationConflicts, resolveCalibrationConflict }));

    await screen.findByText('Step draft');
    fireEvent.click(
      screen.getByRole('radio', { name: 'Accept server version' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));

    expect(
      await screen.findByText(/Resolution failed\. Revision conflict\./),
    ).toBeInTheDocument();
    expect(screen.getByText('1 unresolved')).toBeInTheDocument();
  });

  it('calls onClose when the close button is activated', async () => {
    const { onClose } = mount(apiWith());
    await screen.findByText('No calibration conflicts');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Close calibration conflicts dialog',
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
