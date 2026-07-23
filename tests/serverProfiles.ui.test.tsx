import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServerProfilesDialog } from '../src/renderer/serverProfiles/ServerProfilesDialog.js';
import type { PrintFarmerApi, ServerProfile } from '@shared/ipc';

const connected: ServerProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Production farm',
  baseUrl: 'http://10.0.0.20',
  authMode: 'apiKey',
  version: {
    service: 'Farm.Web.Api',
    version: '0.2.2',
    commit: '63b0053f2',
    environment: 'Production',
    runtime: '.NET 9',
    timestamp: '2026-07-23T11:59:00.000Z',
  },
  capabilities: {
    architecture: 'Integrated',
    slicingEnabled: true,
    modelFilesEnabled: true,
    thumbnailGenerationEnabled: true,
    gcodeUploadEnabled: true,
    clientThumbnailUploadEnabled: true,
    idempotentModelUploadEnabled: true,
    modelThumbnailReplacementEnabled: true,
    platformNote: null,
  },
  availability: {
    modelUpload: { available: true, reason: null },
    librarySync: { available: true, reason: null },
    clientThumbnailUpload: { available: true, reason: null },
  },
  status: 'connected',
  lastCheckedAt: '2026-07-23T12:00:00.000Z',
  warnings: ['insecureHttp'],
};

function installApi(api: Partial<PrintFarmerApi>): void {
  Object.defineProperty(window, 'printFarmer', {
    value: api,
    configurable: true,
  });
}

describe('<ServerProfilesDialog />', () => {
  it('tests and saves a redacted API-key profile with accessible controls', async () => {
    const testServerProfile = vi
      .fn<PrintFarmerApi['testServerProfile']>()
      .mockResolvedValue(connected);
    const saveServerProfile = vi
      .fn<PrintFarmerApi['saveServerProfile']>()
      .mockResolvedValue(connected);
    const listServerProfiles = vi
      .fn<PrintFarmerApi['listServerProfiles']>()
      .mockResolvedValue({
        profiles: [connected],
        selectedProfileId: connected.id,
      });
    const onChange = vi.fn();
    installApi({
      testServerProfile,
      saveServerProfile,
      listServerProfiles,
    });

    render(
      <ServerProfilesDialog
        profiles={{ profiles: [], selectedProfileId: null }}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('dialog', { name: 'Server profiles' }),
    ).toHaveAttribute('aria-modal', 'true');
    fireEvent.change(screen.getByLabelText('Profile name'), {
      target: { value: 'Production farm' },
    });
    fireEvent.change(screen.getByLabelText('Desktop API key'), {
      target: { value: 'only-user-entered-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection successful')).toBeVisible();
    const request = testServerProfile.mock.calls[0]?.[0];
    expect(request?.source).toBe('draft');
    expect(
      request?.source === 'draft' ? request.draft.credentials : null,
    ).toEqual({
      authMode: 'apiKey',
      apiKey: 'only-user-entered-secret',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(saveServerProfile).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Production farm' }),
    );
  });

  it('requires an explicit checkbox before saving a legacy profile', async () => {
    const legacy: ServerProfile = {
      ...connected,
      status: 'legacy',
      version: null,
      capabilities: null,
      warnings: ['insecureHttp', 'legacy'],
      availability: {
        modelUpload: { available: false, reason: 'Legacy server' },
        librarySync: { available: false, reason: 'Legacy server' },
        clientThumbnailUpload: { available: false, reason: 'Legacy server' },
      },
    };
    installApi({ testServerProfile: vi.fn().mockResolvedValue(legacy) });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [], selectedProfileId: null }}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Profile name'), {
      target: { value: 'Legacy' },
    });
    fireEvent.change(screen.getByLabelText('Desktop API key'), {
      target: { value: 'key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    const save = await screen.findByRole('button', { name: 'Save profile' });
    expect(save).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(/Save in legacy mode/, { selector: 'input' }),
    );
    expect(save).toBeEnabled();
    expect(
      screen.getByText(/capability-gated actions are disabled/),
    ).toBeVisible();
  });
});
