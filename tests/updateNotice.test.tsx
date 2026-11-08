import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GetAvailableReleaseResponse, PrintFarmerApi } from '@shared/ipc';
import {
  StatusBar,
  type StatusBarProps,
} from '../src/renderer/shell/StatusBar.js';
import { useAvailableRelease } from '../src/renderer/shell/useAvailableRelease.js';

const beta9: GetAvailableReleaseResponse = {
  currentVersion: '0.1.0-beta.8',
  available: {
    version: '0.1.0-beta.9',
    prerelease: true,
    url: 'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/tag/v0.1.0-beta.9',
    publishedAt: null,
  },
};

function Harness(): React.JSX.Element {
  const { release, dismiss, checkNow, checkState } = useAvailableRelease();
  return (
    <StatusBar
      activity="Ready"
      busy={false}
      error={null}
      serverProfile={null}
      uploadsRemaining={0}
      sourcesNeedingAttention={0}
      appInfo={null}
      availableRelease={release}
      onDismissRelease={dismiss}
      onCheckForUpdates={checkNow}
      updateCheck={checkState}
    />
  );
}

function installApi(
  getAvailableRelease: () => Promise<unknown>,
  checkForUpdates: () => Promise<unknown> = () =>
    Promise.reject(new Error('not stubbed')),
): void {
  (window as unknown as { printFarmer: Partial<PrintFarmerApi> }).printFarmer =
    {
      getAvailableRelease:
        getAvailableRelease as PrintFarmerApi['getAvailableRelease'],
      checkForUpdates: checkForUpdates as PrintFarmerApi['checkForUpdates'],
    };
}

afterEach(() => {
  localStorage.clear();
});

describe('update-available notice', () => {
  it('links to the release page and can be dismissed per version', async () => {
    const check = vi.fn().mockResolvedValue(beta9);
    installApi(check);
    const { unmount } = render(<Harness />);

    const link = await screen.findByRole('link', {
      name: 'Beta 0.1.0-beta.9 available',
    });
    expect(link.getAttribute('href')).toBe(beta9.available?.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(
      screen.queryByRole('button', { name: 'Check for Updates' }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss 0.1.0-beta.9 update notice',
      }),
    );
    expect(screen.queryByRole('link', { name: /available/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Check for Updates' }),
    ).toBeTruthy();
    unmount();

    render(<Harness />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('link', { name: /available/ })).toBeNull();
  });

  it('announces a newer release after an older one was dismissed', async () => {
    localStorage.setItem('printfarmer.dismissedReleaseVersion', '0.1.0-beta.9');
    installApi(
      vi.fn().mockResolvedValue({
        currentVersion: '0.1.0-beta.8',
        available: {
          version: '0.1.0',
          prerelease: false,
          url: 'https://github.com/OlyForge3D/PrintFarmerDesktop/releases/tag/v0.1.0',
          publishedAt: null,
        },
      }),
    );
    render(<Harness />);
    expect(
      await screen.findByRole('link', { name: 'Update 0.1.0 available' }),
    ).toBeTruthy();
  });

  it('stays silent when the check fails', async () => {
    const check = vi.fn().mockRejectedValue(new Error('offline'));
    installApi(check);
    render(<Harness />);
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /available/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('Check for Updates', () => {
    const none = vi.fn().mockResolvedValue({
      currentVersion: '0.1.0-beta.8',
      available: null,
    });

    it('announces an available release, even one dismissed earlier', async () => {
      localStorage.setItem(
        'printfarmer.dismissedReleaseVersion',
        '0.1.0-beta.9',
      );
      const check = vi.fn().mockResolvedValue({
        currentVersion: '0.1.0-beta.8',
        status: 'available',
        available: beta9.available,
      });
      installApi(none, check);
      render(<Harness />);

      fireEvent.click(
        screen.getByRole('button', { name: 'Check for Updates' }),
      );
      expect(
        await screen.findByRole('link', {
          name: 'Beta 0.1.0-beta.9 available',
        }),
      ).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Check for Updates' }),
      ).toBeNull();
      expect(screen.queryByText('Update available')).toBeNull();
      expect(check).toHaveBeenCalledOnce();

      fireEvent.click(
        screen.getByRole('button', {
          name: 'Dismiss 0.1.0-beta.9 update notice',
        }),
      );
      expect(screen.queryByRole('link', { name: /available/ })).toBeNull();
      expect(screen.queryByText('Update available')).toBeNull();
      fireEvent.click(
        screen.getByRole('button', { name: 'Check for Updates' }),
      );
      expect(
        await screen.findByRole('link', {
          name: 'Beta 0.1.0-beta.9 available',
        }),
      ).toBeTruthy();
      expect(check).toHaveBeenCalledTimes(2);
    });

    it('does not let an older background response overwrite a manual result', async () => {
      let resolveBackground: (
        value: GetAvailableReleaseResponse,
      ) => void = () => {};
      let resolveManual: (value: {
        currentVersion: string;
        status: 'available';
        available: NonNullable<GetAvailableReleaseResponse['available']>;
      }) => void = () => {};
      const background = vi.fn(
        () =>
          new Promise<GetAvailableReleaseResponse>((resolve) => {
            resolveBackground = resolve;
          }),
      );
      const manual = vi.fn(
        () =>
          new Promise<{
            currentVersion: string;
            status: 'available';
            available: NonNullable<GetAvailableReleaseResponse['available']>;
          }>((resolve) => {
            resolveManual = resolve;
          }),
      );
      installApi(background, manual);
      render(<Harness />);
      await waitFor(() => expect(background).toHaveBeenCalledOnce());
      fireEvent.click(
        screen.getByRole('button', { name: 'Check for Updates' }),
      );
      await waitFor(() => expect(manual).toHaveBeenCalledOnce());

      resolveManual({
        currentVersion: '0.1.0-beta.8',
        status: 'available',
        available: beta9.available!,
      });
      expect(
        await screen.findByRole('link', {
          name: 'Beta 0.1.0-beta.9 available',
        }),
      ).toBeTruthy();

      act(() => {
        resolveBackground({ currentVersion: '0.1.0-beta.8', available: null });
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        screen.getByRole('link', {
          name: 'Beta 0.1.0-beta.9 available',
        }),
      ).toBeTruthy();
    });

    it('says when the app is up to date', async () => {
      installApi(
        none,
        vi.fn().mockResolvedValue({
          currentVersion: '0.1.0-beta.8',
          status: 'upToDate',
          available: null,
        }),
      );
      render(<Harness />);
      fireEvent.click(
        screen.getByRole('button', { name: 'Check for Updates' }),
      );
      expect(await screen.findByText('Up to date')).toBeTruthy();
    });

    it.each([
      [
        'a failed response',
        vi.fn().mockResolvedValue({
          currentVersion: '0.1.0-beta.8',
          status: 'failed',
          available: null,
        }),
      ],
      ['a rejected call', vi.fn().mockRejectedValue(new Error('ipc'))],
    ])('reports a failure for %s', async (_label, check) => {
      installApi(none, check);
      render(<Harness />);
      fireEvent.click(
        screen.getByRole('button', { name: 'Check for Updates' }),
      );
      expect(await screen.findByText('Check failed')).toBeTruthy();
    });

    it('explains that development builds do not check', async () => {
      installApi(
        none,
        vi.fn().mockResolvedValue({
          currentVersion: '0.1.0-beta.8',
          status: 'unavailable',
          available: null,
        }),
      );
      render(<Harness />);
      fireEvent.click(
        screen.getByRole('button', { name: 'Check for Updates' }),
      );
      expect(await screen.findByText('Installed builds only')).toBeTruthy();
    });
  });

  describe('update status controls', () => {
    const props: StatusBarProps = {
      activity: 'Ready',
      busy: false,
      error: null,
      serverProfile: null,
      uploadsRemaining: 0,
      sourcesNeedingAttention: 0,
      appInfo: null,
      onCheckForUpdates: vi.fn(),
    };

    it('restores manual checking when a release is no longer available', () => {
      const { rerender } = render(
        <StatusBar
          {...props}
          availableRelease={beta9.available}
          updateCheck={{ kind: 'available', version: '0.1.0-beta.9' }}
        />,
      );
      expect(screen.getByRole('link', { name: /available/ })).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Check for Updates' }),
      ).toBeNull();
      rerender(
        <StatusBar
          {...props}
          availableRelease={null}
          updateCheck={{ kind: 'available', version: '0.1.0-beta.9' }}
        />,
      );
      expect(
        screen.getByRole('button', { name: 'Check for Updates' }),
      ).toBeTruthy();
      expect(screen.queryByText('Update available')).toBeNull();
    });

    it.each([
      [{ kind: 'checking' }, 'Checking…'],
      [{ kind: 'failed' }, 'Check failed'],
      [{ kind: 'unavailable' }, 'Installed builds only'],
      [{ kind: 'upToDate', version: '0.1.0-beta.8' }, 'Up to date'],
    ] as const)(
      'preserves %s feedback with and without an available release',
      (updateCheck, message) => {
        const { rerender } = render(
          <StatusBar {...props} updateCheck={updateCheck} />,
        );
        const button = screen.getByRole<HTMLButtonElement>('button', {
          name: 'Check for Updates',
        });
        expect(button.disabled).toBe(updateCheck.kind === 'checking');
        expect(screen.getByText(message)).toBeTruthy();

        rerender(
          <StatusBar
            {...props}
            updateCheck={updateCheck}
            availableRelease={beta9.available}
          />,
        );
        expect(screen.getByRole('link', { name: /available/ })).toBeTruthy();
        expect(
          screen.queryByRole('button', { name: 'Check for Updates' }),
        ).toBeNull();
        expect(screen.getByText(message)).toBeTruthy();
      },
    );
  });
});
