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
    value: withModelPaging(api),
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
      screen.getByRole('dialog', { name: 'Connect to PrintFarmer' }),
    ).toHaveAttribute('aria-modal', 'true');
    fireEvent.change(screen.getByLabelText('Profile name'), {
      target: { value: 'Production farm' },
    });
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: connected.baseUrl },
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
    expect(screen.getByLabelText('Server URL')).toHaveValue('');
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
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: connected.baseUrl },
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
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: connected.baseUrl },
    });
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

  it('starts blank and warns only for an entered HTTP scheme without connecting', () => {
    const testServerProfile = vi.fn();
    installApi({ testServerProfile });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [], selectedProfileId: null }}
        onMutationSettled={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const url = screen.getByLabelText('Server URL');
    expect(url).toHaveValue('');
    expect(url).not.toHaveAttribute('placeholder');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/prefilled|HTTPS certificates/),
    ).not.toBeInTheDocument();
    for (const value of ['http:', 'http://farm.local', ' HTTP:']) {
      fireEvent.change(url, { target: { value } });
      expect(url).toHaveAccessibleDescription(
        'HTTP is not encrypted. Use only on a trusted LAN.',
      );
    }
    for (const value of ['https:', 'https://farm.local', '']) {
      fireEvent.change(url, { target: { value } });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(url).not.toHaveAttribute('aria-describedby');
    }
    expect(testServerProfile).not.toHaveBeenCalled();
    expect(url).toBeInvalid();
  });

  it.each([
    ['apiKey', true],
    ['apiKey', false],
    ['password', true],
    ['password', false],
  ] as const)(
    'edits a %s profile (selected=%s) with explicit saved credentials and its original ID',
    async (authMode, selected) => {
      const profile: ServerProfile = {
        ...connected,
        authMode,
        ...(authMode === 'password' ? { username: 'operator' } : {}),
      };
      const testServerProfile = vi
        .fn<PrintFarmerApi['testServerProfile']>()
        .mockResolvedValue(profile);
      const saveServerProfile = vi.fn().mockResolvedValue(profile);
      const onMutationSettled = vi.fn();
      const onConnectionChanged = vi.fn();
      installApi({ testServerProfile, saveServerProfile });
      render(
        <ServerProfilesDialog
          profiles={{
            profiles: [profile],
            selectedProfileId: selected ? profile.id : null,
          }}
          onMutationSettled={onMutationSettled}
          onConnectionChanged={onConnectionChanged}
          onClose={vi.fn()}
        />,
      );

      fireEvent.click(
        screen.getByRole('button', { name: 'Edit Production farm' }),
      );
      expect(
        screen.getByRole('heading', { name: 'Edit server' }),
      ).toBeVisible();
      expect(screen.getByLabelText('Profile name')).toHaveFocus();
      expect(screen.getByLabelText('Server URL')).toHaveValue(profile.baseUrl);
      expect(screen.getByLabelText('Authentication')).toHaveValue(authMode);
      const secret = screen.getByLabelText(
        authMode === 'apiKey' ? 'Desktop API key' : 'Password',
      );
      expect(secret).toHaveValue('');
      expect(secret).not.toBeRequired();
      if (authMode === 'password') {
        expect(screen.getByLabelText('Username or email')).toHaveValue(
          'operator',
        );
      }
      fireEvent.change(screen.getByLabelText('Profile name'), {
        target: { value: 'Renamed farm' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await screen.findByText('Connection successful');
      expect(testServerProfile).toHaveBeenCalledWith({
        source: 'draft',
        draft: {
          id: profile.id,
          displayName: 'Renamed farm',
          baseUrl: profile.baseUrl,
          credentials: { authMode: 'saved' },
          allowLegacy: false,
        },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(onMutationSettled).toHaveBeenCalledOnce());
      const request = testServerProfile.mock.calls[0]?.[0];
      expect(saveServerProfile).toHaveBeenCalledWith(
        request?.source === 'draft' ? request.draft : null,
      );
      expect(
        screen.getByRole('heading', { name: 'Add a server' }),
      ).toBeVisible();
      expect(screen.getByLabelText('Server URL')).toHaveValue('');
      expect(screen.getByLabelText('Desktop API key')).toHaveValue('');
      expect(onConnectionChanged).not.toHaveBeenCalled();
      expect(
        screen.getByRole('button', { name: 'Edit Production farm' }),
      ).toHaveFocus();
    },
  );

  it('cancels without a mutation, clears secrets and restores Edit focus', () => {
    const saveServerProfile = vi.fn();
    const selectServerProfile = vi.fn();
    installApi({ saveServerProfile, selectServerProfile });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [connected], selectedProfileId: connected.id }}
        onMutationSettled={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const edit = screen.getByRole('button', { name: 'Edit Production farm' });
    fireEvent.click(edit);
    fireEvent.change(screen.getByLabelText('Desktop API key'), {
      target: { value: 'replacement' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }));
    expect(edit).toHaveFocus();
    expect(screen.getByLabelText('Server URL')).toHaveValue('');
    expect(screen.getByLabelText('Desktop API key')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Selected' })).toBeDisabled();
    expect(saveServerProfile).not.toHaveBeenCalled();
    expect(selectServerProfile).not.toHaveBeenCalled();
  });

  it('invalidates tested edits and requires credentials for a changed target or auth identity', async () => {
    const testServerProfile = vi.fn().mockResolvedValue(connected);
    installApi({ testServerProfile });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [connected], selectedProfileId: connected.id }}
        onMutationSettled={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Production farm' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByRole('button', { name: 'Save changes' });
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://different.example' },
    });
    expect(screen.queryByText('Connection successful')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Desktop API key')).toBeRequired();
    expect(screen.getByLabelText('Desktop API key')).toBeInvalid();
    fireEvent.change(screen.getByLabelText('Desktop API key'), {
      target: { value: 'deliberate-new-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    expect(testServerProfile).toHaveBeenLastCalledWith({
      source: 'draft',
      draft: {
        id: connected.id,
        displayName: connected.displayName,
        baseUrl: 'https://different.example',
        credentials: { authMode: 'apiKey', apiKey: 'deliberate-new-key' },
        allowLegacy: false,
      },
    });
    fireEvent.change(screen.getByLabelText('Authentication'), {
      target: { value: 'password' },
    });
    expect(
      screen.queryByRole('button', { name: 'Save changes' }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeRequired();
  });

  it('requires a new password for a changed username and supports explicit replacement', async () => {
    const profile: ServerProfile = {
      ...connected,
      authMode: 'password',
      username: 'operator',
    };
    const testServerProfile = vi.fn().mockResolvedValue(profile);
    const saveServerProfile = vi.fn().mockResolvedValue(profile);
    const onConnectionChanged = vi.fn();
    installApi({ testServerProfile, saveServerProfile });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [profile], selectedProfileId: profile.id }}
        onMutationSettled={vi.fn()}
        onConnectionChanged={onConnectionChanged}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Production farm' }),
    );
    fireEvent.change(screen.getByLabelText('Username or email'), {
      target: { value: 'new-operator' },
    });
    expect(screen.getByLabelText('Password')).toBeRequired();
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'replacement-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    expect(testServerProfile).toHaveBeenLastCalledWith({
      source: 'draft',
      draft: {
        id: profile.id,
        displayName: profile.displayName,
        baseUrl: profile.baseUrl,
        credentials: {
          authMode: 'password',
          username: 'new-operator',
          password: 'replacement-password',
          rememberMe: true,
        },
        allowLegacy: false,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(onConnectionChanged).toHaveBeenCalledWith(profile.id),
    );
  });

  it('keeps an edit and displays test/save failures without mutating selection', async () => {
    const testServerProfile = vi
      .fn()
      .mockRejectedValueOnce(new Error('Cannot reach server'))
      .mockResolvedValue(connected);
    const saveServerProfile = vi
      .fn()
      .mockRejectedValue(new Error('Save failed'));
    const onMutationSettled = vi.fn();
    installApi({ testServerProfile, saveServerProfile });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [connected], selectedProfileId: connected.id }}
        onMutationSettled={onMutationSettled}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Production farm' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot reach server',
    );
    expect(saveServerProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Save changes' }),
    );
    await waitFor(() => expect(onMutationSettled).toHaveBeenCalledOnce());
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
    expect(screen.getByRole('heading', { name: 'Edit server' })).toBeVisible();
    expect(screen.getByLabelText('Profile name')).toHaveValue(
      connected.displayName,
    );
    expect(screen.getByRole('button', { name: 'Selected' })).toBeDisabled();
  });

  it('blocks competing operations during a draft test and discards stale draft results', async () => {
    const pending = deferred<ServerProfile>();
    installApi({ testServerProfile: vi.fn(() => pending.promise) });
    render(
      <ServerProfilesDialog
        profiles={{ profiles: [connected], selectedProfileId: connected.id }}
        onMutationSettled={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit Production farm' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    for (const label of [
      'Profile name',
      'Server URL',
      'Desktop API key',
      'Authentication',
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(
      screen.getByRole('button', { name: 'Edit Production farm' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Cancel editing' }),
    ).toBeDisabled();
    // A programmatic change still must not let an old test authorize a new draft.
    fireEvent.change(screen.getByLabelText('Profile name'), {
      target: { value: 'New draft' },
    });
    await act(async () => {
      pending.resolve(connected);
      await pending.promise;
    });
    expect(
      screen.queryByRole('button', { name: 'Save changes' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Test connection' }),
    ).toBeEnabled();
  });
});
import { withModelPaging } from './helpers/libraryPage';
