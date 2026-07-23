import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
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
    modelUpload: { available: true, mode: 'modern', reason: null },
    librarySync: { available: true, reason: null },
    clientThumbnailUpload: { available: true, reason: null },
    serverThumbnailFallback: {
      available: false,
      reason: 'Modern server',
    },
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
    const onMutationSettled = vi.fn();
    installApi({
      testServerProfile,
      saveServerProfile,
      listServerProfiles,
    });

    render(
      <ServerProfilesDialog
        profiles={{ profiles: [], selectedProfileId: null }}
        onMutationSettled={onMutationSettled}
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
    await waitFor(() => expect(onMutationSettled).toHaveBeenCalled());
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
        modelUpload: {
          available: true,
          mode: 'legacyModelOnly',
          reason: 'Legacy model-only fallback',
        },
        librarySync: { available: false, reason: 'Legacy server' },
        clientThumbnailUpload: { available: false, reason: 'Legacy server' },
        serverThumbnailFallback: {
          available: true,
          reason: 'Server thumbnails',
        },
      },
    };
    installApi({ testServerProfile: vi.fn().mockResolvedValue(legacy) });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [], selectedProfileId: null }}
        onMutationSettled={vi.fn()}
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
      screen.getByText(
        /Modern idempotent upload, client thumbnails, and sync are disabled/,
      ),
    ).toBeVisible();
  });

  it('does not refocus Close while busy and ignores completion after close', async () => {
    const onClose = vi.fn();
    const pending = deferred<ServerProfile>();
    const testServerProfile = vi.fn<PrintFarmerApi['testServerProfile']>(
      () => pending.promise,
    );
    installApi({ testServerProfile });
    render(
      <>
        <button type="button">Outside</button>
        <ServerProfilesDialog
          profiles={{ profiles: [], selectedProfileId: null }}
          onMutationSettled={vi.fn()}
          onClose={onClose}
        />
      </>,
    );
    const close = screen.getByRole('button', {
      name: 'Close server profiles',
    });
    expect(close).toHaveFocus();
    const name = screen.getByLabelText('Profile name');
    fireEvent.change(name, { target: { value: 'Stalled farm' } });
    fireEvent.change(screen.getByLabelText('Desktop API key'), {
      target: { value: 'key' },
    });
    name.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(name).toHaveFocus();
    expect(close).toBeEnabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve(connected);
      await pending.promise;
    });
    expect(screen.queryByText('Connection successful')).not.toBeInTheDocument();

    screen.getByRole('button', { name: 'Outside' }).focus();
    expect(close).toHaveFocus();
  });

  it('notifies the parent after a saved retest rejects', async () => {
    const testServerProfile = vi
      .fn<PrintFarmerApi['testServerProfile']>()
      .mockRejectedValue(new Error('Server unavailable'));
    const onMutationSettled = vi.fn();
    installApi({ testServerProfile });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [connected], selectedProfileId: connected.id }}
        onMutationSettled={onMutationSettled}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));

    await waitFor(() => expect(onMutationSettled).toHaveBeenCalledOnce());
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
  });

  it('reconciles a mutation after close without applying dialog-local state', async () => {
    const pending = deferred<{
      profiles: ServerProfile[];
      selectedProfileId: string | null;
    }>();
    const deleteServerProfile = vi.fn<PrintFarmerApi['deleteServerProfile']>(
      () => pending.promise,
    );
    const onMutationSettled = vi.fn();
    installApi({ deleteServerProfile });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [connected], selectedProfileId: connected.id }}
        onMutationSettled={onMutationSettled}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Production farm' }),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {
      pending.resolve({ profiles: [], selectedProfileId: null });
      await pending.promise;
    });

    expect(onMutationSettled).toHaveBeenCalledOnce();
  });
});
