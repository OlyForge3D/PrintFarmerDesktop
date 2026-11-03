import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GetAvailableReleaseResponse, PrintFarmerApi } from '@shared/ipc';
import { StatusBar } from '../src/renderer/shell/StatusBar.js';
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
  const { release, dismiss } = useAvailableRelease();
  return (
    <StatusBar
      activity="Ready"
      busy={false}
      error={null}
      serverProfile={null}
      uploadsInFlight={0}
      sourcesNeedingAttention={0}
      appInfo={null}
      availableRelease={release}
      onDismissRelease={dismiss}
    />
  );
}

function installApi(getAvailableRelease: () => Promise<unknown>): void {
  (window as unknown as { printFarmer: Partial<PrintFarmerApi> }).printFarmer =
    {
      getAvailableRelease:
        getAvailableRelease as PrintFarmerApi['getAvailableRelease'],
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

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss 0.1.0-beta.9 update notice',
      }),
    );
    expect(screen.queryByRole('link', { name: /available/ })).toBeNull();
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
});
