import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ThumbnailCacheSettings } from '@shared/ipc';
import { LibraryOnboarding } from '../src/renderer/library/LibraryOnboarding';
import { ThumbnailCacheDialog } from '../src/renderer/library/ThumbnailCacheDialog';

function settings(
  overrides: Partial<ThumbnailCacheSettings> = {},
): ThumbnailCacheSettings {
  return {
    location: null,
    effectiveLocation: '/profile/PrintFarmer/scene-cache.v1',
    maxBytes: 512 * 1024 * 1024,
    retentionDays: 30,
    usedBytes: 2048,
    entryCount: 3,
    warning: null,
    ...overrides,
  };
}

describe('ThumbnailCacheDialog', () => {
  it('offers cache settings before the first model folder is added', () => {
    const onManageThumbnailCache = vi.fn();
    render(
      <LibraryOnboarding
        busy={false}
        onAddFolder={vi.fn()}
        onManageThumbnailCache={onManageThumbnailCache}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Thumbnail cache settings' }),
    );
    expect(onManageThumbnailCache).toHaveBeenCalledOnce();
  });

  it('chooses a native folder and saves cache size and retention controls', async () => {
    const api = {
      getThumbnailCacheSettings: vi.fn(() => Promise.resolve(settings())),
      chooseThumbnailCacheLocation: vi.fn(() =>
        Promise.resolve({ canceled: false, path: '/Volumes/cache' }),
      ),
      setThumbnailCacheSettings: vi.fn(() =>
        Promise.resolve(
          settings({
            location: '/Volumes/cache',
            effectiveLocation: '/Volumes/cache/printfarmer-thumbnails.v1',
            maxBytes: 1024 * 1024 * 1024,
            retentionDays: 14,
          }),
        ),
      ),
      clearThumbnailCache: vi.fn(),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: { ...window.printFarmer, ...api },
    });
    render(<ThumbnailCacheDialog onClose={vi.fn()} />);

    await screen.findByText('/profile/PrintFarmer/scene-cache.v1');
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await waitFor(() =>
      expect(api.chooseThumbnailCacheLocation).toHaveBeenCalledOnce(),
    );
    fireEvent.change(screen.getByLabelText('Maximum size (MiB)'), {
      target: { value: '1024' },
    });
    fireEvent.change(
      screen.getByLabelText('Remove unused thumbnails after (days)'),
      { target: { value: '14' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(api.setThumbnailCacheSettings).toHaveBeenCalledWith({
        location: '/Volumes/cache',
        maxBytes: 1024 * 1024 * 1024,
        retentionDays: 14,
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Thumbnail cache settings saved.',
    );
  });

  it('requires explicit confirmation before clearing and warns when caching falls back', async () => {
    const api = {
      getThumbnailCacheSettings: vi.fn(() =>
        Promise.resolve(
          settings({
            warning: 'Thumbnail cache location is unavailable or not writable.',
          }),
        ),
      ),
      chooseThumbnailCacheLocation: vi.fn(),
      setThumbnailCacheSettings: vi.fn(),
      clearThumbnailCache: vi.fn(() =>
        Promise.resolve({
          clearedEntries: 3,
          settings: settings({ entryCount: 0, usedBytes: 0 }),
        }),
      ),
    };
    Object.defineProperty(window, 'printFarmer', {
      configurable: true,
      value: { ...window.printFarmer, ...api },
    });
    render(<ThumbnailCacheDialog onClose={vi.fn()} />);

    expect(
      await screen.findByText(
        /Thumbnails will still render, but may not be cached/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear cached thumbnails…' }),
    );
    expect(
      screen.getByRole('alertdialog', { name: 'Confirm clearing thumbnails' }),
    ).toBeInTheDocument();
    expect(api.clearThumbnailCache).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep cache' }));
    expect(api.clearThumbnailCache).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear cached thumbnails…' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear thumbnails' }));
    await waitFor(() => expect(api.clearThumbnailCache).toHaveBeenCalledOnce());
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Cleared 3 cached thumbnails.',
    );
  });
});
