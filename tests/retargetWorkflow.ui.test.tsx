import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RetargetWorkflow } from '../src/renderer/retarget/RetargetWorkflow';

const profile = {
  id: 'imported:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  source: 'imported' as const,
  displayName: 'Imported U1',
  processName: 'Imported U1',
  machineName: 'Snapmaker U1',
  compatibleFilaments: ['PLA'],
  layerHeight: 0.2,
  category: null,
  bundleCommit: null,
  settingCount: 1,
  settingsSummary: {},
  importedAt: 1,
  fingerprint:
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

describe('RetargetWorkflow', () => {
  it('requires an explicit imported target selection', async () => {
    const api = {
      listRetargetProfiles: vi.fn().mockResolvedValue({
        status: 'ok',
        value: { profiles: [profile], warnings: [] },
      }),
      preflightRetarget: vi.fn().mockResolvedValue({
        status: 'error',
        error: {
          domain: 'electron',
          code: 'sourceChanged',
          message: 'changed',
          action: 'retry',
          part: null,
          setting: null,
        },
      }),
      disposeRetarget: vi.fn().mockResolvedValue({ disposed: true }),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    render(
      <RetargetWorkflow
        target={{ modelHash: 'a'.repeat(64), rootId: 'root', name: 'Project' }}
        onClose={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Prepare for Snapmaker U1' }),
    ).toBeInTheDocument();
    const build = screen.getByRole('button', { name: 'Build review copy' });
    expect(build).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Imported U1/ }));
    await waitFor(() => expect(api.preflightRetarget).toHaveBeenCalledTimes(1));
    expect(api.disposeRetarget).toHaveBeenCalledTimes(0);
  });

  it('contains focus and suppresses Escape while a build is active', async () => {
    const onClose = vi.fn();
    const build = new Promise<never>(() => {});
    const api = {
      listRetargetProfiles: vi.fn().mockResolvedValue({
        status: 'ok',
        value: { profiles: [profile], warnings: [] },
      }),
      preflightRetarget: vi.fn().mockResolvedValue({
        status: 'ok',
        value: {
          token: 't'.repeat(43),
          report: {
            accepted: true,
            source: {
              fileName: 'project.3mf',
              byteSize: 1,
              sha256: 'a'.repeat(64),
              producer: 'OrcaSlicer',
              machineId: null,
              processId: null,
              layerHeight: 0.2,
              objectCount: 1,
              buildItemCount: 1,
              plateCount: 1,
              materials: ['PLA'],
              colors: ['#fff'],
            },
            recommendation: null,
            blockers: [],
            warnings: [],
            proposedChanges: {},
          },
        },
      }),
      buildRetarget: vi.fn(() => build),
      disposeRetarget: vi.fn().mockResolvedValue({ disposed: true }),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: api,
    });
    render(
      <>
        <button type="button">Background action</button>
        <RetargetWorkflow
          target={{
            modelHash: 'a'.repeat(64),
            rootId: 'root',
            name: 'Project',
          }}
          onClose={onClose}
        />
      </>,
    );

    const close = await screen.findByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    screen.getByRole('button', { name: 'Background action' }).focus();
    expect(close).toHaveFocus();

    fireEvent.click(screen.getByRole('radio', { name: /Imported U1/ }));
    const buildButton = await screen.findByRole('button', {
      name: 'Build review copy',
    });
    await waitFor(() => expect(buildButton).toBeEnabled());
    fireEvent.click(buildButton);
    await screen.findByText('Working…');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(close).toBeDisabled();
  });
});
