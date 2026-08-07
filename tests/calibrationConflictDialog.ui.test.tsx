import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CalibrationConflict,
  CalibrationResolveConflictResponse,
  PrintFarmerApi,
} from '../src/shared/ipc.js';
import { CalibrationConflictDialog } from '../src/renderer/calibration/CalibrationConflictDialog.js';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CONFLICT_ID = '33333333-3333-4333-8333-333333333333';

function conflict(
  overrides: Partial<CalibrationConflict> = {},
): CalibrationConflict {
  return {
    conflictId: CONFLICT_ID,
    profileId: PROFILE_ID,
    projectId: PROJECT_ID,
    kind: 'projectMetadata',
    entityId: PROJECT_ID,
    localPayloadSummary: JSON.stringify({
      displayName: 'Local project',
      description: 'Local description',
      nested: { ignored: true },
    }),
    serverPayloadSummary: JSON.stringify({
      displayName: 'Server project',
      description: 'Server description',
    }),
    serverRevision: 7,
    availableResolutions: [
      'acceptServer',
      'keepLocalAsNewRevision',
      'manualFieldMerge',
    ],
    resolvedAt: null,
    resolution: null,
    createdAt: '2026-08-06T20:00:00.000Z',
    ...overrides,
  };
}

function resolved(
  source: CalibrationConflict,
  resolution: CalibrationConflict['availableResolutions'][number],
): CalibrationResolveConflictResponse {
  return {
    conflict: { ...source, resolution, resolvedAt: '2026-08-06T20:01:00.000Z' },
    supersededObservations: [],
  };
}

function installApi({
  rows = [conflict()],
  listError,
  resolveImpl,
}: {
  rows?: readonly CalibrationConflict[];
  listError?: Error;
  resolveImpl?: PrintFarmerApi['resolveCalibrationConflict'];
} = {}) {
  const listCalibrationConflicts = listError
    ? vi.fn().mockRejectedValue(listError)
    : vi.fn().mockResolvedValue({ conflicts: rows });
  const defaultResolve: PrintFarmerApi['resolveCalibrationConflict'] = (
    request,
  ) => {
    const source = rows.find((item) => item.conflictId === request.conflictId);
    if (!source) return Promise.reject(new Error('Missing fixture conflict'));
    return Promise.resolve(resolved(source, request.resolution));
  };
  const resolveCalibrationConflict = vi.fn(resolveImpl ?? defaultResolve);
  Object.defineProperty(window, 'printFarmer', {
    configurable: true,
    value: {
      listCalibrationConflicts,
      resolveCalibrationConflict,
    },
  });
  return { listCalibrationConflicts, resolveCalibrationConflict };
}

function renderDialog(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <CalibrationConflictDialog
        profileId={PROFILE_ID}
        profileName="Production farm"
        onClose={onClose}
      />,
    ),
  };
}

beforeEach(() => vi.restoreAllMocks());

describe('<CalibrationConflictDialog /> transport and accessibility', () => {
  it('loads the authoritative unresolved list and enters the real conflict branch', async () => {
    const api = installApi();
    renderDialog();
    expect(
      await screen.findByRole('option', { name: /Project metadata/ }),
    ).toBeVisible();
    expect(api.listCalibrationConflicts).toHaveBeenCalledWith({
      profileId: PROFILE_ID,
      includeResolved: false,
    });
    expect(
      screen.getByRole('heading', { name: 'Project metadata conflict' }),
    ).toBeVisible();
    expect(screen.getByText('Status: unresolved')).toBeVisible();
    // Mutation counterfactual: replacing this real fixture with [] enters the
    // empty branch below, so these conflict-specific assertions necessarily fail.
  });

  it('shows authoritative empty and text-only error states', async () => {
    installApi({ rows: [] });
    const first = renderDialog();
    expect(await screen.findByText('No calibration conflicts')).toBeVisible();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    first.unmount();

    installApi({ listError: new Error('<server unavailable>') });
    const second = renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Conflicts could not be loaded. <server unavailable>',
    );
    expect(second.container.querySelector('server')).toBeNull();
  });

  it('traps focus, closes with Escape, and restores focus', async () => {
    installApi();
    const onClose = vi.fn();
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Review conflicts
          </button>
          {open ? (
            <CalibrationConflictDialog
              profileId={PROFILE_ID}
              profileName="Production farm"
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            />
          ) : null}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Review conflicts' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', {
      name: 'Review calibration conflicts',
    });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(
      screen.getByRole('button', { name: 'Close calibration conflict dialog' }),
    ).toHaveFocus();
    await screen.findByRole('option');
    const submit = screen.getByRole('button', { name: 'Resolve conflict' });
    submit.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(
      screen.getByRole('button', { name: 'Close calibration conflict dialog' }),
    ).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('supports roving keyboard selection', async () => {
    const second = conflict({
      conflictId: '44444444-4444-4444-8444-444444444444',
      kind: 'stepOrdering',
      entityId: '55555555-5555-4555-8555-555555555555',
      availableResolutions: ['acceptServer'],
    });
    installApi({ rows: [conflict(), second] });
    renderDialog();
    const options = await screen.findAllByRole('option');
    options[0]!.focus();
    fireEvent.keyDown(options[0]!, { key: 'ArrowDown' });
    expect(options[1]).toHaveFocus();
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByRole('heading', { name: 'Step ordering conflict' }),
    ).toBeVisible();
  });
});

describe('<CalibrationConflictDialog /> resolution contract', () => {
  it('gates by availableResolutions and sends the exact request', async () => {
    const fixture = conflict({
      availableResolutions: ['keepLocalAsNewRevision'],
    });
    const api = installApi({ rows: [fixture] });
    renderDialog();
    expect(
      await screen.findByRole('radio', {
        name: 'Keep local as a new revision',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('radio', { name: 'Accept server version' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: 'Merge fields manually' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Resolve conflict' }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole('radio', { name: 'Keep local as a new revision' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));
    await waitFor(() =>
      expect(api.resolveCalibrationConflict).toHaveBeenCalledWith({
        profileId: PROFILE_ID,
        conflictId: CONFLICT_ID,
        resolution: 'keepLocalAsNewRevision',
      }),
    );
  });

  it('builds a bounded scalar manual merge and sends edited plain text', async () => {
    const api = installApi();
    renderDialog();
    fireEvent.click(
      await screen.findByRole('radio', { name: 'Merge fields manually' }),
    );
    const name = screen.getByRole('textbox', { name: 'displayName' });
    expect(name).toHaveAttribute('maxlength', '4096');
    expect(name).toHaveValue('Local project');
    expect(
      screen.queryByRole('textbox', { name: 'nested' }),
    ).not.toBeInTheDocument();
    fireEvent.change(name, { target: { value: '<b>Merged, not HTML</b>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));
    await waitFor(() =>
      expect(api.resolveCalibrationConflict).toHaveBeenCalledWith({
        profileId: PROFILE_ID,
        conflictId: CONFLICT_ID,
        resolution: 'manualFieldMerge',
        mergedFields: {
          displayName: '<b>Merged, not HTML</b>',
          description: 'Local description',
        },
      }),
    );
  });

  it('blocks unusable and over-20-field manual merges', async () => {
    installApi({
      rows: [
        conflict({
          localPayloadSummary: '[]',
          serverPayloadSummary: '{not json}',
          availableResolutions: ['manualFieldMerge'],
        }),
      ],
    });
    const first = renderDialog();
    fireEvent.click(
      await screen.findByRole('radio', { name: 'Merge fields manually' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Manual merge is blocked',
    );
    expect(
      screen.getByRole('button', { name: 'Resolve conflict' }),
    ).toBeDisabled();
    first.unmount();

    const tooMany = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`field${index}`, `${index}`]),
    );
    installApi({
      rows: [
        conflict({
          localPayloadSummary: JSON.stringify(tooMany),
          serverPayloadSummary: null,
          availableResolutions: ['manualFieldMerge'],
        }),
      ],
    });
    renderDialog();
    fireEvent.click(
      await screen.findByRole('radio', { name: 'Merge fields manually' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '21 fields exceed the 20-field IPC limit',
    );
    expect(
      screen.getByRole('button', { name: 'Resolve conflict' }),
    ).toBeDisabled();
  });

  it('prevents duplicate submission, consumes success, and announces removal', async () => {
    let settle!: (value: CalibrationResolveConflictResponse) => void;
    const promise = new Promise<CalibrationResolveConflictResponse>(
      (resolve) => {
        settle = resolve;
      },
    );
    const fixture = conflict({ availableResolutions: ['acceptServer'] });
    const api = installApi({ rows: [fixture], resolveImpl: () => promise });
    renderDialog();
    const submit = await screen.findByRole('button', {
      name: 'Resolve conflict',
    });
    fireEvent.click(
      screen.getByRole('radio', { name: 'Accept server version' }),
    );
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(api.resolveCalibrationConflict).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Resolving…' })).toBeDisabled();
    settle(resolved(fixture, 'acceptServer'));
    expect(await screen.findByText('No calibration conflicts')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Conflict resolved with Accept server version. No recorded observations were superseded. 0 unresolved calibration conflicts',
    );
  });

  it('keeps the authoritative supersession report visible after resolution', async () => {
    const fixture = conflict({ availableResolutions: ['acceptServer'] });
    installApi({
      rows: [fixture],
      resolveImpl: () =>
        Promise.resolve({
          ...resolved(fixture, 'acceptServer'),
          supersededObservations: [
            {
              observationId: 'observation-1',
              attemptId: 'attempt-1',
              stepId: 'step-1',
              parameterKey: 'flowRate',
              boundSnapshotRevision: 6,
            },
          ],
        }),
    });
    renderDialog();
    fireEvent.click(
      await screen.findByRole('radio', { name: 'Accept server version' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));

    const report = await screen.findByRole('region', {
      name: 'Resolution result',
    });
    expect(report).toHaveTextContent('1 recorded observation superseded');
    expect(report).toHaveTextContent('These observations were not invalidated');
    expect(report).toHaveTextContent('flowRate');
  });

  it('keeps the conflict available and reports resolution errors', async () => {
    installApi({
      resolveImpl: () => Promise.reject(new Error('Revision changed')),
    });
    renderDialog();
    fireEvent.click(
      await screen.findByRole('radio', { name: 'Accept server version' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve conflict' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Resolution failed. Revision changed',
    );
    expect(screen.getByRole('option')).toBeVisible();
  });
});
